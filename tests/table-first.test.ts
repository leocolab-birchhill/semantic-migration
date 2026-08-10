import { describe, it } from "node:test";
import assert from "node:assert";
import {
  extractDerivedTableSql,
  extractQualifiedTableRefsFromSql,
  extractSqlTableNames,
  normalizeTableRef,
  referencesTable,
  splitQualifiedName,
} from "../lib/migration/table-names";
import {
  DEFAULT_DEV_SCHEMA,
  DEFAULT_PROD_SCHEMA,
  validateMigrationSchemas,
} from "../lib/migration/schema-guard";
import { evaluateApprovalGate } from "../lib/migration/approval";
import {
  buildMetricViewSelect,
  lookerFilterToSql,
  parseLookerFilterExpression,
} from "../lib/migration/query-builder";
import { buildTestCases } from "../lib/migration/test-cases";
import { scoreLookmlAgainstTable } from "../lib/migration/discover";
import { compareRowSets } from "../lib/migration/comparator";
import { confidenceFromEvidence } from "../lib/migration/discovery-confidence";
import type { IntermediateRepresentation, TestCase } from "../lib/migration/types";

describe("table name normalization", () => {
  it("splits quoted three-part names", () => {
    assert.deepStrictEqual(
      splitQualifiedName("`databricks_prd`.`dbt_production`.`fct_tam_buildings`"),
      ["databricks_prd", "dbt_production", "fct_tam_buildings"]
    );
    assert.deepStrictEqual(
      splitQualifiedName('"catalog"."schema"."table"'),
      ["catalog", "schema", "table"]
    );
  });

  it("normalizes match keys for three-part refs", () => {
    const ref = normalizeTableRef(
      "`databricks_prd`.`dbt_production`.`fct_tam_buildings`"
    );
    assert.ok(ref);
    assert.strictEqual(
      ref!.canonical,
      "databricks_prd.dbt_production.fct_tam_buildings"
    );
    assert.ok(ref!.matchKeys.includes("fct_tam_buildings"));
    assert.ok(ref!.matchKeys.includes("dbt_production.fct_tam_buildings"));
  });

  it("matches sql_table_name variants against source table", () => {
    const catalog = "databricks_prd";
    const schema = "dbt_production";
    const table = "fct_tam_buildings";

    assert.ok(
      referencesTable(
        "databricks_prd.dbt_production.fct_tam_buildings",
        catalog,
        schema,
        table
      )
    );
    assert.ok(
      referencesTable(
        "`dbt_production`.`fct_tam_buildings`",
        catalog,
        schema,
        table
      )
    );
    assert.ok(referencesTable("fct_tam_buildings", catalog, schema, table));
    assert.ok(
      !referencesTable("dbt_production.other_table", catalog, schema, table)
    );
  });

  it("strips SQL aliases from table refs", () => {
    const ref = normalizeTableRef(
      "dbt_production.fct_building_monthly_cost_summary AS buildings"
    );
    assert.ok(ref);
    assert.strictEqual(ref!.schema, "dbt_production");
    assert.strictEqual(ref!.table, "fct_building_monthly_cost_summary");
    assert.strictEqual(ref!.catalog, null);
  });

  it("extracts sql_table_name and derived SQL from LookML", () => {
    const lookml = `
view: fct_tam_buildings {
  sql_table_name: \`databricks_prd\`.\`dbt_production\`.\`fct_tam_buildings\` ;;

  derived_table: {
    sql:
      SELECT * FROM databricks_prd.dbt_production.fct_tam_buildings
      WHERE active ;;
  }
}
`;
    const names = extractSqlTableNames(lookml);
    assert.ok(names.some((n) => n.includes("fct_tam_buildings")));
    const derived = extractDerivedTableSql(lookml);
    assert.ok(derived.length >= 1);
    assert.ok(derived[0].includes("fct_tam_buildings"));
    const fromSql = extractQualifiedTableRefsFromSql(derived[0]);
    assert.ok(
      fromSql.some((n) => n.toLowerCase().includes("fct_tam_buildings")),
      `expected qualified FROM ref, got ${JSON.stringify(fromSql)}`
    );
  });

  it("scores LookML hits for fct_tam_buildings discovery", () => {
    const lookml = `
view: fct_tam_buildings {
  sql_table_name: databricks_prd.dbt_production.fct_tam_buildings ;;
}
`;
    const evidence = scoreLookmlAgainstTable(
      lookml,
      "views/fct_tam_buildings.view.lkml",
      "databricks_prd",
      "dbt_production",
      "fct_tam_buildings"
    );
    assert.ok(evidence.some((e) => e.kind === "sql_table_name"));
    assert.strictEqual(confidenceFromEvidence(evidence), "high");
  });
});

describe("schema guard", () => {
  it("defaults are semantic_migration_dev / business_semantics", () => {
    assert.strictEqual(DEFAULT_DEV_SCHEMA, "semantic_migration_dev");
    assert.strictEqual(DEFAULT_PROD_SCHEMA, "business_semantics");
  });

  it("hard-blocks unsafe dev schemas", () => {
    assert.ok(
      !validateMigrationSchemas({
        sourceSchema: "dbt_production",
        devSchema: "dbt_production",
        prodSchema: "business_semantics",
      }).ok
    );
    assert.ok(
      !validateMigrationSchemas({
        sourceSchema: "dbt_production",
        devSchema: "business_semantics",
        prodSchema: "business_semantics",
      }).ok
    );
    assert.ok(
      !validateMigrationSchemas({
        sourceSchema: "dbt_production",
        devSchema: "semantic_migration_dev",
        prodSchema: "dbt_production",
      }).ok
    );
    assert.ok(
      validateMigrationSchemas({
        sourceSchema: "dbt_production",
        devSchema: "semantic_migration_dev",
        prodSchema: "business_semantics",
      }).ok
    );
  });
});

describe("approval gate", () => {
  it("allows explore-only approval when smoke evidence passes and nothing failed", () => {
    const gate = evaluateApprovalGate({
      mandatoryTests: [],
      mandatoryPassed: 0,
      mandatoryFailed: 0,
      evidencePasses: 1,
      failed: 0,
    });
    assert.strictEqual(gate.canApprove, true);
  });

  it("blocks explore-only approval when smoke evidence has not passed", () => {
    const gate = evaluateApprovalGate({
      mandatoryTests: [],
      mandatoryPassed: 0,
      mandatoryFailed: 0,
      evidencePasses: 0,
      failed: 0,
    });
    assert.strictEqual(gate.canApprove, false);
    assert.ok(gate.blockedReason?.includes("no dashboard/Look"));
  });

  it("requires every mandatory benchmark to pass", () => {
    const mandatory: TestCase[] = [
      {
        id: "tile_1",
        name: "TAM tile",
        type: "tile",
        lookerQuery: {},
        expectedColumns: ["count"],
        mandatory: true,
      },
    ];
    assert.strictEqual(
      evaluateApprovalGate({
        mandatoryTests: mandatory,
        mandatoryPassed: 1,
        mandatoryFailed: 0,
        evidencePasses: 1,
        failed: 0,
      }).canApprove,
      true
    );
    assert.strictEqual(
      evaluateApprovalGate({
        mandatoryTests: mandatory,
        mandatoryPassed: 0,
        mandatoryFailed: 1,
        evidencePasses: 1,
        failed: 1,
      }).canApprove,
      false
    );
  });
});

describe("filter-aware Databricks validation", () => {
  it("emits WHERE clauses from Looker filters", () => {
    assert.strictEqual(
      lookerFilterToSql("tam.status", "active"),
      "`status` = 'active'"
    );
    assert.strictEqual(
      lookerFilterToSql("tam.id", "1,2,3"),
      "`id` IN (1, 2, 3)"
    );

    const sql = buildMetricViewSelect({
      catalog: "databricks_prd",
      schema: "semantic_migration_dev",
      viewName: "tam_explore",
      fields: ["building_count"],
      measureNames: new Set(["building_count"]),
      filters: { "fct_tam_buildings.is_current": "Yes" },
      limit: 500,
    });
    assert.ok(sql.includes("WHERE"));
    assert.ok(sql.includes("`is_current` = 'Yes'"));
  });

  it("compiles NULL + comparison list filters as OR predicates, never string IN", () => {
    // Looker "NULL,>=20000" on a numeric dim (tam building_rba dashboard filter)
    const rba = lookerFilterToSql("fct_tam_buildings.building_rba", "NULL,>=20000");
    assert.strictEqual(
      rba,
      "(`building_rba` >= 20000 OR `building_rba` IS NULL)"
    );

    // Mixed exact + comparison + NULL
    const mixed = lookerFilterToSql("t.size", "small,>=100,NULL");
    assert.ok(mixed?.includes("`size` IN ('small')"));
    assert.ok(mixed?.includes("`size` >= 100"));
    assert.ok(mixed?.includes("`size` IS NULL"));
    assert.ok(mixed?.startsWith("("));

    // Mixed positives + a negation combine with AND
    const withNeg = lookerFilterToSql("t.sector", "Office,Retail,-Unknown");
    assert.ok(withNeg?.includes("`sector` IN ('Office', 'Retail')"));
    assert.ok(withNeg?.includes("`sector` <> 'Unknown'"));
  });

  it("translates matches_filter wildcards and comparison filter_expressions", () => {
    const wildcard = lookerFilterToSql(
      "building_monthly_financials.year",
      "-NULL,-%2013%,-%2012%,-0"
    );
    assert.ok(wildcard?.includes("NOT IN"));
    assert.ok(wildcard?.includes("NOT LIKE '%2013%'"));
    assert.ok(wildcard?.includes("IS NOT NULL"));

    const parsed = parseLookerFilterExpression(
      `concat(\${building_monthly_financials.year},"") <= concat(extract_years(now()),"")
AND \${building_monthly_financials.year} >= "2020"
AND \${building_monthly_financials.month_date} <= \${building_monthly_financials.anchor_month}`
    );
    assert.ok(
      parsed.predicates.some((p) =>
        p.includes("YEAR(CURRENT_TIMESTAMP())")
      )
    );
    assert.ok(
      parsed.predicates.some((p) => p.includes("`year` >= 2020"))
    );
    assert.ok(
      parsed.predicates.some(
        (p) => p === "`month_date` <= `anchor_month`"
      )
    );

    const mf = parseLookerFilterExpression(
      "matches_filter(${building_monthly_financials.year}, `-0,-2012,-2013`) AND matches_filter(${building_monthly_financials.year}, `-NULL`)"
    );
    assert.strictEqual(mf.filters["building_monthly_financials.year"], "-0,-2012,-2013,-NULL");

    const sql = buildMetricViewSelect({
      catalog: "databricks_prd",
      schema: "semantic_migration_dev",
      viewName: "building_monthly_financials",
      fields: ["year", "total_overhead"],
      measureNames: new Set(["total_overhead"]),
      filters: { year: "-NULL,-%2013%,-0" },
      predicates: [
        "`year` >= 2020",
        "`month_date` <= `anchor_month`",
      ],
      limit: 500,
    });
    assert.ok(sql.includes("`year` >= 2020"));
    assert.ok(sql.includes("`month_date` <= `anchor_month`"));
    assert.ok(sql.includes("NOT LIKE"));
  });

  it("fails parity when Databricks count misses Looker filters (720273 vs 358001)", () => {
    // Acceptance: unfiltered Databricks grain must not pass against filtered Looker
    const looker = {
      columns: ["building_count"],
      rows: [[358001]],
    };
    const databricksMissingFilters = {
      columns: ["building_count"],
      rows: [[720273]],
    };
    const result = compareRowSets(
      looker,
      databricksMissingFilters,
      { building_count: "number" },
      { decimalScale: 2, timezone: "UTC", requireNonEmpty: true }
    );
    assert.strictEqual(result.match, false);
    assert.ok(
      result.summary.includes("mismatch") ||
        result.columnDiffs.some((d) => !d.match) ||
        looker.rows[0][0] !== databricksMissingFilters.rows[0][0]
    );
  });
});

describe("mandatory tile tests", () => {
  const inventory: IntermediateRepresentation = {
    version: "1",
    source: {
      type: "table_scope",
      model: "tam",
      explore: "tam_buildings",
      sourceTable: {
        catalog: "databricks_prd",
        schema: "dbt_production",
        table: "fct_tam_buildings",
      },
    },
    grain: { dimensions: ["building_id"] },
    joins: [],
    dimensions: [{ name: "building_id", type: "string" }],
    measures: [{ name: "building_count", type: "number" }],
    filters: [],
    parameters: [],
    derivedTables: [],
    liquidLogic: [],
    userAttributes: [],
    formatting: {},
    tileQueries: [
      {
        id: "dash:1:tile1",
        title: "TAM Buildings",
        model: "tam",
        explore: "tam_buildings",
        fields: ["building_count"],
        filters: { "tam_buildings.is_current": "Yes" },
        sourceKind: "dashboard_tile",
      },
    ],
    unsupportedFeatures: [],
    lookmlFiles: [],
  };

  it("marks dashboard tiles mandatory and smoke non-mandatory", () => {
    const tests = buildTestCases(inventory);
    const tile = tests.find((t) => t.id === "tile_dash:1:tile1");
    const smoke = tests.find((t) => t.type === "smoke");
    assert.ok(tile?.mandatory);
    assert.strictEqual(smoke?.mandatory, false);
  });

  it("recovers bare-name field aliases against explore inventory", () => {
    const tests = buildTestCases({
      ...inventory,
      measures: [
        {
          name: "fct_tam_buildings.buildings_count",
          type: "number",
          label: "Buildings Count",
        },
      ],
      tileQueries: [
        {
          id: "dash:1:tile2",
          title: "Buildings",
          model: "tam",
          explore: "tam_buildings",
          fields: ["buildings_count"],
          sourceKind: "dashboard_tile",
        },
      ],
    });
    const tile = tests.find((t) => t.id === "tile_dash:1:tile2");
    assert.ok(tile);
    assert.strictEqual(tile?.skipStatus, undefined);
    assert.ok(
      tile?.expectedColumns?.includes("fct_tam_buildings.buildings_count")
    );
  });

  it("treats dashboard dynamic fields as defined (not inventory gaps)", () => {
    const tests = buildTestCases({
      ...inventory,
      tileQueries: [
        {
          id: "dash:1:tile3",
          title: "Revenue vs Budget",
          model: "tam",
          explore: "tam_buildings",
          fields: ["revenue", "building_count"],
          sourceKind: "dashboard_tile",
          dynamicFields: [
            {
              kind: "measure",
              name: "revenue",
              basedOn: "tam_buildings.actual",
              type: "sum",
              filters: { "tam_buildings.acct_group": "Revenue" },
              raw: {
                measure: "revenue",
                based_on: "tam_buildings.actual",
                type: "sum",
                filters: { "tam_buildings.acct_group": "Revenue" },
              },
            },
          ],
        },
      ],
      dynamicFields: [
        {
          kind: "measure",
          name: "revenue",
          basedOn: "tam_buildings.actual",
          type: "sum",
          filters: { "tam_buildings.acct_group": "Revenue" },
          raw: {
            measure: "revenue",
            based_on: "tam_buildings.actual",
            type: "sum",
          },
        },
      ],
    });
    const tile = tests.find((t) => t.id === "tile_dash:1:tile3");
    assert.ok(tile);
    assert.strictEqual(tile?.skipStatus, undefined);
    assert.ok(tile?.expectedColumns?.includes("building_count"));
    assert.ok(tile?.expectedColumns?.includes("revenue"));
  });

  it("drops tiles whose fields are entirely outside explore inventory", () => {
    const tests = buildTestCases({
      ...inventory,
      tileQueries: [
        {
          id: "dash:1:tile4",
          title: "Mystery",
          model: "tam",
          explore: "tam_buildings",
          fields: ["not_a_real_field"],
          sourceKind: "dashboard_tile",
        },
      ],
    });
    const tile = tests.find(
      (t) =>
        t.id === "tile_dash:1:tile4" ||
        t.id === "tile_dash:1:tile4_missing_fields" ||
        t.name.includes("Mystery")
    );
    assert.strictEqual(tile, undefined);
  });

  it("tests only inventory-resolvable fields when a tile has extras", () => {
    const tests = buildTestCases({
      ...inventory,
      tileQueries: [
        {
          id: "dash:1:tile5",
          title: "Partial",
          model: "tam",
          explore: "tam_buildings",
          fields: ["building_count", "not_a_real_field"],
          sourceKind: "dashboard_tile",
        },
      ],
    });
    const tile = tests.find((t) => t.id === "tile_dash:1:tile5");
    assert.ok(tile);
    assert.strictEqual(tile?.skipStatus, undefined);
    assert.deepStrictEqual(tile?.expectedColumns, ["building_count"]);
    assert.deepStrictEqual(
      (tile?.lookerQuery as { fields?: string[] }).fields,
      ["building_count"]
    );
  });
});

describe("looker dynamic fields parsing", () => {
  it("parses custom measures and table calculations", async () => {
    const { parseLookerDynamicFields } = await import(
      "../lib/migration/dynamic-fields"
    );
    const fields = parseLookerDynamicFields([
      {
        measure: "revenue",
        based_on: "building_monthly_financials.actual",
        type: "sum",
        filters: { "building_monthly_financials.acct_group": "Revenue" },
      },
      {
        table_calculation: "margin",
        expression: "${revenue} / ${cost}",
        label: "Margin",
      },
    ]);
    assert.strictEqual(fields.length, 2);
    assert.strictEqual(fields[0].kind, "measure");
    assert.strictEqual(fields[0].name, "revenue");
    assert.strictEqual(fields[0].basedOn, "building_monthly_financials.actual");
    assert.strictEqual(fields[1].kind, "table_calculation");
    assert.strictEqual(fields[1].expression, "${revenue} / ${cost}");
  });
});

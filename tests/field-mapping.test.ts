import { describe, it } from "node:test";
import assert from "node:assert";
import {
  acceptMappingSuggestion,
  coerceMetricViewName,
  compileBenchmarkFromMapping,
  currenciesCompatible,
  detectCurrency,
  loadMetricViewInventories,
  mergeFieldMappings,
  normalizeCurrencyToken,
  parseMetricViewInventory,
  reconcileMappingMetricViewNames,
  repairAmbiguousCurrencyMappings,
} from "../lib/migration/field-mapping";
import { buildMetricViewSelect } from "../lib/migration/query-builder";
import type {
  FieldMappingEntry,
  FieldMappingTable,
  ProposedAsset,
} from "../lib/migration/types";

const cadYaml = `
version: "1.1"
source: cat.dev.base
dimensions:
  - name: region
    expr: region
measures:
  - name: revenue_cad
    expr: SUM(amount_cad)
  - name: revenue_usd
    expr: SUM(amount_usd)
`;

const renamedYaml = `
version: "1.1"
source: cat.dev.base
dimensions:
  - name: building_id
    expr: building_id
measures:
  - name: active_building_count
    expr: COUNT(DISTINCT building_id)
`;

function mappingTable(entries: FieldMappingEntry[]): FieldMappingTable {
  return {
    version: "1.0",
    entries,
    updatedAt: new Date().toISOString(),
  };
}

describe("currency detection and CAD vs USD mapping", () => {
  it("detects CAD and USD from field names", () => {
    assert.strictEqual(detectCurrency("revenue_cad"), "CAD");
    assert.strictEqual(detectCurrency("tam.total_revenue_usd"), "USD");
    assert.ok(!currenciesCompatible("CAD", "USD"));
    assert.ok(currenciesCompatible("CAD", "CAD"));
  });

  it("rejects CAD→USD mapping that relies on name similarity alone", () => {
    const verdict = acceptMappingSuggestion({
      lookerField: "tam.revenue_cad",
      suggestedDatabricksField: "revenue_usd",
      lookerMeasure: {
        name: "revenue_cad",
        type: "sum",
        sql: "SUM(${TABLE}.amount_cad)",
        valueFormat: '"$"#,##0',
      },
      databricksExpr: "SUM(amount_usd)",
      evidence: {
        rationale: "Names both contain revenue so they match",
        currency: "USD",
        aggregation: "sum",
      },
    });
    assert.strictEqual(verdict.accept, false);
    assert.ok(verdict.reason.toLowerCase().includes("currency"));
  });

  it("accepts CAD→revenue_cad with matching currency evidence", () => {
    const verdict = acceptMappingSuggestion({
      lookerField: "tam.revenue_cad",
      suggestedDatabricksField: "revenue_cad",
      lookerMeasure: {
        name: "revenue_cad",
        type: "sum",
        sql: "SUM(${TABLE}.amount_cad)",
      },
      databricksExpr: "SUM(amount_cad)",
      evidence: {
        rationale:
          "Same SUM aggregation over CAD amount column; population is current buildings",
        currency: "CAD",
        aggregation: "sum",
        populationGrain: "building",
        lookmlSql: "SUM(${TABLE}.amount_cad)",
        databricksExpr: "SUM(amount_cad)",
      },
    });
    assert.strictEqual(verdict.accept, true);
  });

  it("fails compile when Looker CAD field is mapped to USD measure", () => {
    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "tam_mv",
        schema: "dev",
        description: "",
        yaml: cadYaml,
      },
    ];
    const inventories = loadMetricViewInventories(assets);
    const mapping = mappingTable([
      {
        lookerField: "tam.revenue_cad",
        metricViewName: "tam_mv",
        databricksField: "revenue_usd",
        kind: "measure",
        currency: "CAD",
        evidence: {
          rationale: "wrong",
          currency: "CAD",
          aggregation: "sum",
        },
      },
    ]);

    const result = compileBenchmarkFromMapping({
      mapping,
      inventories,
      lookerFields: ["tam.revenue_cad"],
      preferredMetricView: "tam_mv",
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, "query_compilation_error");
    assert.ok(result.issues.some((i) => i.code === "ambiguous_currency"));
  });
});

describe("Looker renamed measure mapping", () => {
  it("maps renamed Looker measure to differently named Databricks measure with evidence", () => {
    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "buildings_mv",
        schema: "dev",
        description: "",
        yaml: renamedYaml,
      },
    ];
    const inventories = loadMetricViewInventories(assets);
    const mapping = mappingTable([
      {
        lookerField: "tam.building_count",
        metricViewName: "buildings_mv",
        databricksField: "active_building_count",
        kind: "measure",
        unit: "count",
        populationGrain: "active buildings",
        evidence: {
          rationale:
            "Looker count_distinct building_id with is_current filter equals active_building_count",
          aggregation: "count",
          filters: ["is_current: Yes"],
          populationGrain: "active buildings",
          lookmlSql: "COUNT(DISTINCT ${TABLE}.building_id)",
          databricksExpr: "COUNT(DISTINCT building_id)",
        },
      },
    ]);

    const result = compileBenchmarkFromMapping({
      mapping,
      inventories,
      lookerFields: ["tam.building_count"],
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.databricksFields, ["active_building_count"]);
    assert.ok(result.measureNames.has("active_building_count"));

    const sql = buildMetricViewSelect({
      catalog: "c",
      schema: "dev",
      viewName: result.metricViewName,
      fields: result.databricksFields,
      measureNames: result.measureNames,
    });
    assert.ok(sql.includes("MEASURE(`active_building_count`)"));
    assert.ok(!sql.includes("MEASURE(`building_count`)"));
    assert.ok(!sql.includes("`tam.building_count`"));
  });
});

describe("wrong metric view routing", () => {
  it("fails compilation when benchmark prefers wrong metric view", () => {
    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "tam_mv",
        schema: "dev",
        description: "",
        yaml: cadYaml,
      },
      {
        type: "metric_view",
        name: "other_mv",
        schema: "dev",
        description: "",
        yaml: renamedYaml,
      },
    ];
    const inventories = loadMetricViewInventories(assets);
    const mapping = mappingTable([
      {
        lookerField: "tam.revenue_cad",
        metricViewName: "tam_mv",
        databricksField: "revenue_cad",
        kind: "measure",
        currency: "CAD",
      },
    ]);

    const result = compileBenchmarkFromMapping({
      mapping,
      inventories,
      lookerFields: ["tam.revenue_cad"],
      preferredMetricView: "other_mv",
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, "query_compilation_error");
    assert.ok(result.issues.some((i) => i.code === "wrong_metric_view"));
  });
});

describe("missing measure caught before SQL execution", () => {
  it("returns query_compilation_error when mapped Databricks measure is absent", () => {
    const inventory = parseMetricViewInventory("tam_mv", cadYaml);
    const inventories = new Map([["tam_mv", inventory]]);
    const mapping = mappingTable([
      {
        lookerField: "tam.ghost_measure",
        metricViewName: "tam_mv",
        databricksField: "does_not_exist",
        kind: "measure",
      },
    ]);

    const result = compileBenchmarkFromMapping({
      mapping,
      inventories,
      lookerFields: ["tam.ghost_measure"],
      preferredMetricView: "tam_mv",
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, "query_compilation_error");
    assert.ok(result.issues.some((i) => i.code === "missing_databricks_field"));
    // Caller must not invoke Databricks when !ok — verified by status contract
  });

  it("returns query_compilation_error for unmapped Looker fields", () => {
    const inventories = loadMetricViewInventories([
      {
        type: "metric_view",
        name: "tam_mv",
        schema: "dev",
        description: "",
        yaml: cadYaml,
      },
    ]);
    const result = compileBenchmarkFromMapping({
      mapping: mappingTable([]),
      inventories,
      lookerFields: ["tam.revenue_cad"],
      preferredMetricView: "tam_mv",
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "unmapped_looker_field"));
  });
});

describe("mapping retained across repair iterations", () => {
  it("keeps prior entries and applies explicit patches only", () => {
    const prior = mappingTable([
      {
        lookerField: "tam.revenue_cad",
        metricViewName: "tam_mv",
        databricksField: "revenue_cad",
        kind: "measure",
        currency: "CAD",
      },
      {
        lookerField: "tam.region",
        metricViewName: "tam_mv",
        databricksField: "region",
        kind: "dimension",
      },
    ]);

    const patch: FieldMappingEntry = {
      lookerField: "tam.building_count",
      metricViewName: "buildings_mv",
      databricksField: "active_building_count",
      kind: "measure",
      unit: "count",
      evidence: {
        rationale: "count distinct with is_current filter",
        aggregation: "count",
      },
    };

    const merged = mergeFieldMappings(prior, null, [patch]);
    assert.strictEqual(merged.entries.length, 3);
    assert.ok(
      merged.entries.some(
        (e) => e.lookerField === "tam.revenue_cad" && e.currency === "CAD"
      )
    );
    assert.ok(
      merged.entries.some((e) => e.databricksField === "active_building_count")
    );

    // Repair that corrects a mapping updates in place without dropping others
    const corrected = mergeFieldMappings(merged, null, [
      {
        lookerField: "tam.revenue_cad",
        metricViewName: "tam_mv",
        databricksField: "revenue_cad",
        kind: "measure",
        currency: "CAD",
        populationGrain: "current portfolio",
      },
    ]);
    assert.strictEqual(corrected.entries.length, 3);
    const cad = corrected.entries.find((e) => e.lookerField === "tam.revenue_cad");
    assert.strictEqual(cad?.populationGrain, "current portfolio");
    assert.ok(
      corrected.entries.some((e) => e.lookerField === "tam.building_count")
    );
  });
});

describe("metric view name reconciliation", () => {
  it("rewrites orphan mapping names onto the sole deployed metric view", () => {
    const assets: ProposedAsset[] = [
      {
        name: "tam_buildings_metrics",
        type: "metric_view",
        description: "mv",
        schema: "dev",
        yaml: `
version: "1.1"
source: cat.dev.base
dimensions:
  - name: sector
    expr: sector
measures:
  - name: revenue_estimate_sum_customer_adjusted
    expr: SUM(revenue_estimate_cad)
`,
      },
    ];

    const prior = mappingTable([
      {
        lookerField: "fct_tam_buildings.revenue_estimate_sum_customer_adjusted",
        metricViewName: "tam_buildings_cad_default",
        databricksField: "revenue_estimate_sum_customer_adjusted",
        kind: "measure",
        currency: "CAD",
        evidence: {
          rationale: "CAD default branch of revenue_estimate_selected",
          aggregation: "sum",
        },
      },
      {
        lookerField: "fct_tam_buildings.sector",
        metricViewName: "tam_buildings_cad_default",
        databricksField: "sector",
        kind: "dimension",
      },
    ]);

    const reconciled = reconcileMappingMetricViewNames(prior, assets);
    assert.ok(
      reconciled.entries.every(
        (e) => e.metricViewName === "tam_buildings_metrics"
      )
    );

    const inventories = loadMetricViewInventories(assets);
    assert.strictEqual(
      coerceMetricViewName("tam_buildings", inventories),
      "tam_buildings_metrics"
    );

    const compiled = compileBenchmarkFromMapping({
      mapping: prior,
      inventories,
      lookerFields: [
        "fct_tam_buildings.sector",
        "fct_tam_buildings.revenue_estimate_sum_customer_adjusted",
      ],
      preferredMetricView: "tam_buildings",
    });
    assert.strictEqual(compiled.ok, true);
    assert.strictEqual(compiled.metricViewName, "tam_buildings_metrics");
    assert.deepStrictEqual(compiled.databricksFields, [
      "sector",
      "revenue_estimate_sum_customer_adjusted",
    ]);
  });
});

const ratioYaml = `
version: "1.1"
source: cat.dev.base
dimensions:
  - name: facility_type
    expr: facility_type
measures:
  - name: revenue_share_customer_adjusted
    expr: |
      SUM(CASE WHEN currency = 'CAD' THEN acv ELSE acv * fx END)
      / NULLIF(SUM(CASE WHEN currency = 'CAD' THEN tam ELSE tam * fx END), 0)
  - name: customer_gross_margin_customer_adjusted
    expr: |
      SUM(CASE WHEN currency = 'CAD' THEN margin ELSE margin * fx END)
      / NULLIF(SUM(CASE WHEN currency = 'CAD' THEN revenue ELSE revenue * fx END), 0)
`;

describe("ratio measures vs CAD-in-expr", () => {
  it("normalizes none/percent currency tokens", () => {
    assert.strictEqual(normalizeCurrencyToken("none"), undefined);
    assert.strictEqual(normalizeCurrencyToken("percent"), undefined);
    assert.strictEqual(normalizeCurrencyToken("CAD"), "CAD");
    assert.strictEqual(currenciesCompatible("none", "CAD"), true);
  });

  it("compiles share/margin mappings when expr contains CAD CASE but Looker has no currency", () => {
    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "tam_buildings",
        schema: "dev",
        description: "",
        yaml: ratioYaml,
      },
    ];
    const inventories = loadMetricViewInventories(assets);
    const mapping = mappingTable([
      {
        lookerField: "fct_tam_buildings.revenue_share_customer_adjusted",
        metricViewName: "tam_buildings",
        databricksField: "revenue_share_customer_adjusted",
        kind: "measure",
        currency: "none",
        evidence: {
          rationale: "Looker ratio of ACV sums; dimensionless share",
          aggregation: "sum",
          currency: "none",
        },
      },
      {
        lookerField:
          "fct_tam_buildings.customer_gross_margin_customer_adjusted",
        metricViewName: "tam_buildings",
        databricksField: "customer_gross_margin_customer_adjusted",
        kind: "measure",
        currency: "CAD",
        unit: "percent",
        evidence: {
          rationale: "Gross margin percent; CAD only inside conversion CASE",
          aggregation: "sum",
        },
      },
    ]);

    const repaired = repairAmbiguousCurrencyMappings(mapping, {
      version: "1",
      source: {
        type: "explore",
        model: "gdi",
        explore: "tam_buildings",
      },
      grain: { dimensions: [] },
      joins: [],
      dimensions: [],
      measures: [
        {
          name: "fct_tam_buildings.revenue_share_customer_adjusted",
          type: "number",
          sql: "1.0 * ${acv} / ${tam}",
          valueFormat: "0.0%",
        },
        {
          name: "fct_tam_buildings.customer_gross_margin_customer_adjusted",
          type: "number",
          sql: "${margin} / ${revenue}",
          valueFormat: "0.00%",
        },
      ],
      filters: [],
      parameters: [],
      derivedTables: [],
      liquidLogic: [],
      userAttributes: [],
      formatting: {},
      tileQueries: [],
      unsupportedFeatures: [],
      lookmlFiles: [],
    });

    const share = repaired.entries.find((e) =>
      e.lookerField.includes("revenue_share")
    );
    assert.ok(share);
    assert.strictEqual(share!.currency, undefined);
    assert.strictEqual(share!.unit, "percent");

    const result = compileBenchmarkFromMapping({
      mapping: repaired,
      inventories,
      lookerFields: [
        "fct_tam_buildings.revenue_share_customer_adjusted",
        "fct_tam_buildings.customer_gross_margin_customer_adjusted",
      ],
      preferredMetricView: "tam_buildings",
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.issues));
    assert.ok(!result.issues.some((i) => i.code === "ambiguous_currency"));
  });

  it("still fails true CAD vs USD name conflicts", () => {
    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "tam_mv",
        schema: "dev",
        description: "",
        yaml: cadYaml,
      },
    ];
    const inventories = loadMetricViewInventories(assets);
    const mapping = mappingTable([
      {
        lookerField: "tam.revenue_cad",
        metricViewName: "tam_mv",
        databricksField: "revenue_usd",
        kind: "measure",
        currency: "CAD",
        evidence: {
          rationale: "wrong currency alias",
          currency: "CAD",
          aggregation: "sum",
        },
      },
    ]);
    const result = compileBenchmarkFromMapping({
      mapping,
      inventories,
      lookerFields: ["tam.revenue_cad"],
      preferredMetricView: "tam_mv",
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "ambiguous_currency"));
  });
});

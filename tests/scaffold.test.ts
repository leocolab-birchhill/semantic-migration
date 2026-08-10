import { describe, it } from "node:test";
import assert from "node:assert";
import { parse as parseYaml } from "yaml";
import {
  mergeScaffoldIntoAssets,
  parsePassthroughColumn,
  preserveMetricViewFieldsOnPatch,
  scaffoldPassthroughDimensions,
} from "../lib/migration/scaffold";
import { mapPool } from "../lib/migration/concurrency";
import type { IntermediateRepresentation, ProposedAsset } from "../lib/migration/types";

describe("parsePassthroughColumn", () => {
  it("accepts ${TABLE}.col", () => {
    assert.strictEqual(parsePassthroughColumn("${TABLE}.account"), "account");
  });

  it("accepts quoted table refs", () => {
    assert.strictEqual(
      parsePassthroughColumn("${TABLE}.`month_date`"),
      "month_date"
    );
  });

  it("accepts bare identifiers", () => {
    assert.strictEqual(parsePassthroughColumn("building_id"), "building_id");
  });

  it("rejects CASE expressions", () => {
    assert.strictEqual(
      parsePassthroughColumn("CASE WHEN ${TABLE}.x > 0 THEN 1 ELSE 0 END"),
      null
    );
  });

  it("rejects parameter refs", () => {
    assert.strictEqual(
      parsePassthroughColumn("${currency_selector}"),
      null
    );
  });
});

describe("scaffoldPassthroughDimensions", () => {
  const inventory = {
    version: "1",
    source: { type: "explore", model: "gdi", explore: "building_monthly_financials" },
    dimensions: [
      {
        name: "building_monthly_financials.account",
        type: "string",
        sql: "${TABLE}.account",
        label: "Account",
      },
      {
        name: "building_monthly_financials.currency_amt",
        type: "number",
        sql: "CASE WHEN ${currency} = 'CAD' THEN ${TABLE}.amt ELSE ${TABLE}.amt_usd END",
        label: "Amount",
      },
      {
        name: "building_monthly_financials.hidden_dim",
        type: "string",
        sql: "${TABLE}.secret",
        hidden: true,
      },
    ],
    measures: [],
    joins: [],
    tileQueries: [],
  } as unknown as IntermediateRepresentation;

  it("scaffolds only simple passthrough dims", () => {
    const scaffold = scaffoldPassthroughDimensions(
      inventory,
      "building_monthly_financials"
    );
    assert.strictEqual(scaffold.dimensions.length, 1);
    assert.strictEqual(scaffold.dimensions[0].name, "account");
    assert.strictEqual(scaffold.dimensions[0].expr, "account");
    assert.strictEqual(scaffold.fieldMappings.length, 1);
    assert.ok(scaffold.scaffoldedBareNames.includes("account"));
  });

  it("merges missing scaffold dims into metric_view YAML", () => {
    const scaffold = scaffoldPassthroughDimensions(
      inventory,
      "building_monthly_financials"
    );
    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "building_monthly_financials",
        schema: "semantic_migration_dev",
        description: "",
        yaml: `version: "1.1"
source: databricks_prd.dbt_production.fct
dimensions:
  - name: currency_amt
    expr: amt
measures: []
`,
        fieldMappings: [],
      },
    ];
    const merged = mergeScaffoldIntoAssets(
      assets,
      scaffold,
      "building_monthly_financials"
    );
    const doc = parseYaml(merged[0].yaml!) as {
      dimensions: Array<{ name: string }>;
    };
    const names = doc.dimensions.map((d) => d.name).sort();
    assert.deepStrictEqual(names, ["account", "currency_amt"]);
    assert.ok(
      merged[0].fieldMappings?.some((m) => m.databricksField === "account")
    );
  });
});

describe("preserveMetricViewFieldsOnPatch", () => {
  const previousYaml = `version: "1.1"
source: cat.dev.prepared
dimensions:
  - name: account
    expr: account
  - name: include_in_tam_owner
    expr: include_in_tam_owner
measures:
  - name: actual
    expr: SUM(actual_cad)
`;

  it("restores dimensions dropped by a full-YAML replacement patch", () => {
    const patched = `version: "1.1"
source: cat.dev.prepared
dimensions:
  - name: account
    expr: account
measures:
  - name: actual
    expr: COALESCE(SUM(actual_cad), 0)
`;
    const result = preserveMetricViewFieldsOnPatch(previousYaml, patched);
    assert.deepStrictEqual(result.restored, [
      "dimension include_in_tam_owner",
    ]);
    const doc = parseYaml(result.yaml) as {
      dimensions: Array<{ name: string }>;
      measures: Array<{ name: string; expr: string }>;
    };
    assert.ok(
      doc.dimensions.some((d) => d.name === "include_in_tam_owner")
    );
    // The patched measure expr wins — only missing fields are restored.
    assert.strictEqual(doc.measures[0].expr, "COALESCE(SUM(actual_cad), 0)");
  });

  it("does not restore fields when the source changed", () => {
    const patched = `version: "1.1"
source: cat.dev.other_source
dimensions:
  - name: account
    expr: account
measures: []
`;
    const result = preserveMetricViewFieldsOnPatch(previousYaml, patched);
    assert.deepStrictEqual(result.restored, []);
    assert.strictEqual(result.yaml, patched);
  });
});

describe("mapPool", () => {
  it("preserves order and respects concurrency", async () => {
    const started: number[] = [];
    const results = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      await new Promise((r) => setTimeout(r, 20));
      return n * 10;
    });
    assert.deepStrictEqual(results, [10, 20, 30, 40, 50]);
    assert.strictEqual(started.length, 5);
  });
});

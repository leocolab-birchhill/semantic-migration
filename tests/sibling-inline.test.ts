import { describe, it } from "node:test";
import assert from "node:assert";
import { parse as parseYaml } from "yaml";
import {
  inlineSiblingMetricViewRefs,
  parseUnresolvedColumnNames,
  parseUnresolvedColumnSuggestions,
  preferCadSuggestion,
  rewriteSqlUnresolvedColumns,
} from "../lib/migration/sibling-inline";

describe("parseUnresolvedColumnNames", () => {
  it("extracts the missing column from Databricks errors", () => {
    const err =
      "[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column, variable, or function parameter with name `sector_consolidated` cannot be resolved. Did you mean one of the following? [`churn_month_date`, `latitude`]";
    assert.deepStrictEqual(parseUnresolvedColumnNames(err), [
      "sector_consolidated",
    ]);
  });

  it("extracts the column from qualified alias.column errors", () => {
    const err =
      "[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column, variable, or function parameter with name `t`.`customer_gross_profit` cannot be resolved. Did you mean one of the following? [`t`.`customer_gross_profit_cad`, `t`.`customer_gross_profit_usd`]";
    assert.deepStrictEqual(parseUnresolvedColumnNames(err), [
      "customer_gross_profit",
    ]);
  });
});

describe("rewriteSqlUnresolvedColumns", () => {
  it("rewrites bare currency stems to *_cad suggestions", () => {
    const err =
      "Failed to deploy SQL view tam_buildings_prepared: [UNRESOLVED_COLUMN.WITH_SUGGESTION] A column, variable, or function parameter with name `t`.`customer_gross_profit` cannot be resolved. Did you mean one of the following? [`t`.`customer_gross_profit_cad`, `t`.`customer_gross_profit_usd`]";
    const unresolved = parseUnresolvedColumnNames(err);
    const to = preferCadSuggestion(parseUnresolvedColumnSuggestions(err));
    assert.strictEqual(to, "customer_gross_profit_cad");
    const sql =
      "SELECT t.customer_gross_profit AS gp, t.`customer_gross_profit` AS gp2 FROM src t";
    const { sql: out, replaced } = rewriteSqlUnresolvedColumns(
      sql,
      unresolved.map((from) => ({ from, to: to! }))
    );
    assert.ok(replaced.length >= 1);
    assert.match(out, /customer_gross_profit_cad/);
    assert.doesNotMatch(out, /(?<!_)customer_gross_profit(?!_)/);
  });
});

describe("inlineSiblingMetricViewRefs", () => {
  it("inlines a sibling dimension expr into an order dim", () => {
    const yaml = `version: "1.1"
source: cat.dev.t
dimensions:
  - name: sector_consolidated
    expr: |-
      CASE WHEN sector IS NULL THEN 'Unknown' ELSE sector END
  - name: custom_sector_consolidated_order
    expr: |-
      CASE WHEN sector_consolidated = 'A' THEN 1 ELSE 2 END
measures:
  - name: count
    expr: COUNT(*)
`;
    const { yaml: out, inlined } = inlineSiblingMetricViewRefs(yaml, [
      "sector_consolidated",
    ]);
    assert.ok(inlined.some((i) => i.field === "custom_sector_consolidated_order"));
    const doc = parseYaml(out) as Record<string, unknown>;
    const dims = doc.dimensions as Array<Record<string, unknown>>;
    const order = dims.find((d) => d.name === "custom_sector_consolidated_order")!;
    assert.match(
      String(order.expr),
      /CASE WHEN sector IS NULL THEN 'Unknown' ELSE sector END/
    );
    assert.doesNotMatch(
      String(order.expr).replace(
        /CASE WHEN sector IS NULL THEN 'Unknown' ELSE sector END/g,
        ""
      ),
      /\bsector_consolidated\b/
    );
  });

  it("does not rewrite unrelated source columns when no sibling logic", () => {
    const yaml = `version: "1.1"
source: cat.dev.t
dimensions:
  - name: sector
    expr: sector
  - name: region
    expr: region
measures:
  - name: count
    expr: COUNT(*)
`;
    const { yaml: out, inlined } = inlineSiblingMetricViewRefs(yaml);
    assert.strictEqual(inlined.length, 0);
    assert.strictEqual(out, yaml);
  });

  it("does not replace SQL COUNT(…) when a measure is named count", () => {
    const yaml = `version: "1.1"
source: cat.dev.t
dimensions:
  - name: account
    expr: account
measures:
  - name: count
    expr: COALESCE(COUNT(*), 0)
  - name: accounts_count
    expr: COUNT(DISTINCT account)
`;
    const { yaml: out, inlined } = inlineSiblingMetricViewRefs(yaml);
    assert.strictEqual(inlined.length, 0);
    assert.match(out, /expr: COUNT\(DISTINCT account\)/);
    assert.doesNotMatch(out, /\)\(DISTINCT/);
  });
});

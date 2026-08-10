import { describe, it } from "node:test";
import assert from "node:assert";
import { collectGenerateReferencedBareNames } from "../lib/openai/client";
import type { IntermediateRepresentation } from "../lib/migration/types";

function baseInventory(
  overrides: Partial<IntermediateRepresentation> = {}
): IntermediateRepresentation {
  return {
    version: "1.0",
    source: { type: "explore", model: "gdi", explore: "building_monthly_financials" },
    grain: {
      dimensions: [
        "building_monthly_financials.account",
        "building_monthly_financials.acct_group",
      ],
    },
    joins: [],
    dimensions: [
      { name: "building_monthly_financials.account", type: "string" },
      { name: "building_monthly_financials.acct_group", type: "string" },
      { name: "building_monthly_financials.account_number", type: "string" },
      { name: "building_monthly_financials.unused_dim", type: "string" },
      { name: "building_monthly_financials.year", type: "string" },
    ],
    measures: [
      { name: "building_monthly_financials.actual", type: "sum", sql: "${TABLE}.actual" },
      { name: "building_monthly_financials.budget", type: "sum", sql: "${TABLE}.budget" },
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
    ...overrides,
  };
}

describe("collectGenerateReferencedBareNames", () => {
  it("keeps smoke/baseline sample dims and grain even without tiles", () => {
    const names = collectGenerateReferencedBareNames(baseInventory());
    assert.ok(names.has("account"));
    assert.ok(names.has("acct_group"));
    assert.ok(names.has("account_number"));
    assert.ok(names.has("actual"));
    assert.ok(names.has("budget"));
    assert.equal(names.has("unused_dim"), false);
  });

  it("includes benchmark fields, filters, and filterExpression refs", () => {
    const names = collectGenerateReferencedBareNames(
      baseInventory({
        benchmarks: [
          {
            tileId: "t1",
            title: "YTD",
            model: "gdi",
            explore: "building_monthly_financials",
            fields: ["revenue", "building_monthly_financials.month_date"],
            filters: { "building_monthly_financials.is_quebec": "Yes" },
            filterExpression:
              '${year} >= "2020" AND ${month_date} <= ${anchor_month}',
            dynamicFields: [
              {
                kind: "measure",
                name: "revenue",
                basedOn: "building_monthly_financials.actual",
                filters: { "building_monthly_financials.cost_gl_format": "REV" },
                raw: {},
              },
            ],
          },
        ],
      })
    );
    assert.ok(names.has("revenue"));
    assert.ok(names.has("month_date"));
    assert.ok(names.has("is_quebec"));
    assert.ok(names.has("year"));
    assert.ok(names.has("anchor_month"));
    assert.ok(names.has("cost_gl_format"));
    assert.equal(names.has("unused_dim"), false);
  });
});

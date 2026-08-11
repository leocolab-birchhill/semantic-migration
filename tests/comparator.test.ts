import { describe, it } from "node:test";
import assert from "node:assert";
import {
  alignRowSetsByName,
  compareRowSets,
  lookerJsonBiToRowSet,
} from "../lib/migration/comparator";
import {
  buildColumnTypes,
  buildMetricViewSelect,
  canonicalizeFieldName,
  measureNameSet,
} from "../lib/migration/query-builder";
import { buildTestCases } from "../lib/migration/test-cases";
import type { IntermediateRepresentation } from "../lib/migration/types";

describe("compareRowSets", () => {
  it("matches identical integer rows", () => {
    const a = { columns: ["id", "count"], rows: [[1, 100], [2, 200]] };
    const b = { columns: ["id", "count"], rows: [[1, 100], [2, 200]] };
    const result = compareRowSets(a, b, { id: "int", count: "int" }, {
      decimalScale: 2,
      timezone: "UTC",
    });
    assert.strictEqual(result.match, true);
    assert.strictEqual(result.inconclusive, false);
    assert.strictEqual(result.verdict, "match");
  });

  it("detects decimal differences at configured scale", () => {
    const a = { columns: ["amount"], rows: [[10.005]] };
    const b = { columns: ["amount"], rows: [[10.006]] };
    const result = compareRowSets(a, b, { amount: "decimal" }, {
      decimalScale: 2,
      timezone: "UTC",
    });
    assert.strictEqual(result.match, true);
  });

  it("matches LookML sum values despite scientific notation strings", () => {
    const looker = {
      columns: ["fct.revenue"],
      rows: [[1086894984.6217957]],
    };
    const db = {
      columns: ["revenue"],
      rows: [["1.0868949846217957E9"]],
    };
    const result = compareRowSets(
      looker,
      db,
      { revenue: "sum", "fct.revenue": "sum" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.match, true);
    assert.strictEqual(result.verdict, "match");
  });

  it("matches sum measures with float dust via decimalScale", () => {
    const looker = {
      columns: ["sector", "revenue"],
      rows: [["Office", 0.01826970576467391]],
    };
    const db = {
      columns: ["sector", "revenue"],
      rows: [["Office", "0.018269705764673908"]],
    };
    const result = compareRowSets(
      looker,
      db,
      { sector: "string", revenue: "number" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.match, true);
  });

  it("treats top-N key set drift as boundary_drift when measures match", () => {
    const looker = {
      columns: ["owner", "buildings"],
      rows: [
        ["Acme", 10],
        ["Beta", 9],
        ["OnlyLooker", 1],
      ],
    };
    const db = {
      columns: ["owner", "buildings"],
      rows: [
        ["Acme", "10"],
        ["Beta", "9"],
        ["OnlyDb", "1"],
      ],
    };
    const result = compareRowSets(
      looker,
      db,
      { owner: "string", buildings: "count_distinct" },
      { decimalScale: 2, timezone: "UTC", boundaryOverlapRatio: 0.5 }
    );
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.boundaryDrift, true);
    assert.strictEqual(result.verdict, "boundary_drift");
    assert.strictEqual(result.measureDiffCount, 0);
    assert.strictEqual(result.sharedKeyCount, 2);
  });

  it("fails when shared-key measures differ", () => {
    const looker = {
      columns: ["owner", "buildings"],
      rows: [["Acme", 10]],
    };
    const db = {
      columns: ["owner", "buildings"],
      rows: [["Acme", "7"]],
    };
    const result = compareRowSets(
      looker,
      db,
      { owner: "string", buildings: "sum" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.boundaryDrift, false);
    assert.strictEqual(result.verdict, "mismatch");
    assert.ok(result.measureDiffCount > 0);
  });

  it("fails on row count mismatch", () => {
    const a = { columns: ["id"], rows: [[1], [2]] };
    const b = { columns: ["id"], rows: [[1]] };
    const result = compareRowSets(a, b, { id: "int" }, {
      decimalScale: 2,
      timezone: "UTC",
    });
    assert.strictEqual(result.match, false);
    assert.ok(result.summary.includes("Row count mismatch") || result.verdict === "mismatch");
  });

  it("canonicalizes row order", () => {
    const a = { columns: ["name"], rows: [["b"], ["a"]] };
    const b = { columns: ["name"], rows: [["a"], ["b"]] };
    const result = compareRowSets(a, b, { name: "string" }, {
      decimalScale: 2,
      timezone: "UTC",
    });
    assert.strictEqual(result.match, true);
  });

  it("treats zero-vs-zero as inconclusive", () => {
    const a = { columns: ["id"], rows: [] };
    const b = { columns: ["id"], rows: [] };
    const result = compareRowSets(a, b, { id: "int" }, {
      decimalScale: 2,
      timezone: "UTC",
    });
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.inconclusive, true);
    assert.ok(result.summary.includes("inconclusive"));
  });

  it("aligns columns by canonical name", () => {
    const looker = {
      columns: ["explore.account", "explore.cnt"],
      rows: [["Acme", 1]],
    };
    const db = { columns: ["cnt", "account"], rows: [[1, "Acme"]] };
    const result = compareRowSets(looker, db, { account: "string", cnt: "int" }, {
      decimalScale: 2,
      timezone: "UTC",
    });
    assert.strictEqual(result.match, true);
  });

  it("fails when column names differ", () => {
    const looker = { columns: ["a"], rows: [[1]] };
    const db = { columns: ["b"], rows: [[1]] };
    const result = compareRowSets(looker, db, {}, {
      decimalScale: 2,
      timezone: "UTC",
    });
    assert.strictEqual(result.match, false);
    assert.ok(result.summary.includes("Column name mismatch"));
  });
  it("treats low-overlap list drift as boundary_drift when measures match", () => {
    const looker = {
      columns: ["owner", "buildings"],
      rows: [
        ["Acme", 10],
        ["Beta", 1],
        ["OnlyLooker", 1],
        ["OnlyLooker2", 1],
      ],
    };
    const db = {
      columns: ["owner", "buildings"],
      rows: [
        ["Acme", "10"],
        ["Beta", "1"],
        ["OnlyDb", "1"],
        ["OnlyDb2", "1"],
      ],
    };
    const result = compareRowSets(
      looker,
      db,
      { owner: "string", buildings: "count_distinct" },
      { decimalScale: 2, timezone: "UTC", boundaryOverlapRatio: 0.9 }
    );
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.boundaryDrift, true);
    assert.strictEqual(result.verdict, "boundary_drift");
    assert.strictEqual(result.measureDiffCount, 0);
  });

  it("marks zero-overlap samples inconclusive rather than value mismatch", () => {
    const looker = {
      columns: ["account", "n"],
      rows: [["A", 1], ["B", 1]],
    };
    const db = {
      columns: ["account", "n"],
      rows: [["C", "1"], ["D", "1"]],
    };
    const result = compareRowSets(
      looker,
      db,
      { account: "string", n: "sum" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.inconclusive, true);
    assert.strictEqual(result.verdict, "inconclusive");
    assert.strictEqual(result.measureDiffCount, 0);
  });

  it("treats null and empty-string dimension keys as the same identity", () => {
    // Looker often emits both null and ""; Databricks collapses to null.
    // After normalizing identity, measures on the collapsed key are summed.
    const looker = {
      columns: ["account", "budget"],
      rows: [
        [null, -396041.91],
        ["", -85951.6],
      ],
    };
    const db = {
      columns: ["account", "budget"],
      rows: [
        [null, "-396041.91"],
        [null, "-85951.6"],
      ],
    };
    const result = compareRowSets(
      looker,
      db,
      { account: "string", budget: "sum" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.match, true);
    assert.strictEqual(result.measureDiffCount, 0);
    assert.strictEqual(result.sharedKeyCount, 1);
  });

  it("matches smoke-style null vs empty account groups by summing collapsed keys", () => {
    const looker = {
      columns: ["account", "actual"],
      rows: [
        [null, 574149.6664706608],
        ["", 1656154.4300000002],
        ["401K Payable - Employee Portion", 61892.368636],
      ],
    };
    const db = {
      columns: ["account", "actual"],
      rows: [
        [null, "574149.6664706236"],
        [null, "1656154.4300000002"],
        ["401K Payable - Employee Portion", "61892.36863600001"],
      ],
    };
    const result = compareRowSets(
      looker,
      db,
      { account: "string", actual: "sum" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.match, true);
    assert.strictEqual(result.verdict, "match");
  });

  it("matches float half-up edge cases that look identical at display scale", () => {
    const looker = {
      columns: ["account", "budget"],
      rows: [["Amortization - Tradename Newbold", -180328.025]],
    };
    const db = {
      columns: ["account", "budget"],
      rows: [["Amortization - Tradename Newbold", "-180328.02500000002"]],
    };
    const result = compareRowSets(
      looker,
      db,
      { account: "string", budget: "sum" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.match, true);
    assert.strictEqual(result.measureDiffCount, 0);
  });

  it("still fails real cent-level measure differences at scale 2", () => {
    const looker = {
      columns: ["account", "actual"],
      rows: [["Acme", 100.0]],
    };
    const db = {
      columns: ["account", "actual"],
      rows: [["Acme", "100.02"]],
    };
    const result = compareRowSets(
      looker,
      db,
      { account: "string", actual: "sum" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.verdict, "mismatch");
  });

  it("keeps numeric-looking string IDs as row keys (account_number)", () => {
    const looker = {
      columns: ["account", "account_number", "budget"],
      rows: [
        [null, "1013", 0],
        [null, null, -396041.91],
      ],
    };
    const db = {
      columns: ["account", "account_number", "budget"],
      rows: [
        [null, "1013", "0.0"],
        [null, null, "-396041.91"],
      ],
    };
    const result = compareRowSets(
      looker,
      db,
      { account: "string", account_number: "string", budget: "sum" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(result.match, true);
    assert.strictEqual(result.measureDiffCount, 0);
    assert.strictEqual(result.sharedKeyCount, 2);
  });
});

describe("alignRowSetsByName", () => {
  it("reorders databricks columns to looker order", () => {
    const aligned = alignRowSetsByName(
      { columns: ["x", "y"], rows: [[1, 2]] },
      { columns: ["y", "x"], rows: [[2, 1]] }
    );
    assert.deepStrictEqual(aligned.columns, ["x", "y"]);
    assert.deepStrictEqual(aligned.databricks.rows[0], [1, 2]);
  });
});

describe("lookerJsonBiToRowSet", () => {
  it("converts json_bi data to row set", () => {
    const result = lookerJsonBiToRowSet({
      data: [
        { dim: "a", measure: 10 },
        { dim: "b", measure: 20 },
      ],
    });
    assert.deepStrictEqual(result.columns, ["dim", "measure"]);
    assert.strictEqual(result.rows.length, 2);
  });

  it("keeps columns from fields metadata when data is empty", () => {
    const result = lookerJsonBiToRowSet({
      data: [],
      fields: [{ name: "account", type: "string" }],
    });
    assert.deepStrictEqual(result.columns, ["account"]);
    assert.strictEqual(result.rows.length, 0);
  });

  it("parses real Looker json_bi shape (metadata + rows with value wrappers)", () => {
    const result = lookerJsonBiToRowSet({
      metadata: {
        fields: {
          dimensions: [{ name: "fct_tam_buildings.sector" }],
          measures: [{ name: "fct_tam_buildings.buildings_count_customer_adjusted" }],
        },
        has_totals: false,
      },
      rows: [
        {
          "fct_tam_buildings.sector": { value: "Warehouse/Distribution" },
          "fct_tam_buildings.buildings_count_customer_adjusted": { value: 87375 },
        },
        {
          "fct_tam_buildings.sector": { value: "Office" },
          "fct_tam_buildings.buildings_count_customer_adjusted": { value: 61750 },
        },
      ],
    });
    assert.deepStrictEqual(result.columns, [
      "fct_tam_buildings.sector",
      "fct_tam_buildings.buildings_count_customer_adjusted",
    ]);
    assert.strictEqual(result.rows.length, 2);
    assert.deepStrictEqual(result.rows[0], ["Warehouse/Distribution", 87375]);
  });

  it("drops the appended totals row when has_totals is true", () => {
    const result = lookerJsonBiToRowSet({
      metadata: {
        fields: {
          dimensions: [],
          measures: [{ name: "e.revenue" }],
        },
        has_totals: true,
      },
      rows: [
        { "e.revenue": { value: 100 } },
        { "e.revenue": { value: 100 } }, // totals duplicate
      ],
    });
    assert.strictEqual(result.rows.length, 1);
    assert.deepStrictEqual(result.rows[0], [100]);
  });

  it("aligns prefixed Looker json_bi columns with bare Databricks columns", () => {
    const looker = lookerJsonBiToRowSet({
      metadata: {
        fields: {
          dimensions: [{ name: "e.sector" }],
          measures: [{ name: "e.revenue" }],
        },
        has_totals: false,
      },
      rows: [
        { "e.sector": { value: "Office" }, "e.revenue": { value: 10.5 } },
      ],
    });
    const db = { columns: ["sector", "revenue"], rows: [["Office", "10.5"]] };
    const outcome = compareRowSets(
      looker,
      db,
      { sector: "string", revenue: "decimal" },
      { decimalScale: 2, timezone: "UTC" }
    );
    assert.strictEqual(outcome.match, true);
  });
});

describe("buildMetricViewSelect", () => {
  it("wraps measures with MEASURE and adds GROUP BY ALL", () => {
    const sql = buildMetricViewSelect({
      catalog: "cat",
      schema: "dev",
      viewName: "mv_x",
      fields: ["explore.account", "explore.revenue"],
      measureNames: new Set(["revenue"]),
      limit: 50,
    });
    assert.ok(sql.includes("MEASURE(`revenue`) AS `revenue`"));
    assert.ok(sql.includes("`account`"));
    assert.ok(sql.includes("GROUP BY ALL"));
    assert.ok(sql.includes("LIMIT 50"));
  });

  it("groups dimension-only queries so rows match Looker's distinct output", () => {
    const sql = buildMetricViewSelect({
      catalog: "cat",
      schema: "dev",
      viewName: "mv_x",
      fields: ["account"],
      measureNames: new Set(["revenue"]),
    });
    assert.ok(sql.includes("GROUP BY ALL"));
  });
});

describe("buildColumnTypes / canonicalize", () => {
  it("maps looker-prefixed names to inventory types", () => {
    const types = buildColumnTypes(["tam.account", "tam.cnt"], {
      dimensions: [{ name: "account", type: "string" }],
      measures: [{ name: "cnt", type: "number" }],
    });
    assert.strictEqual(types.account, "string");
    assert.strictEqual(types.cnt, "number");
    assert.strictEqual(canonicalizeFieldName("tam.account"), "account");
    assert.ok(measureNameSet([{ name: "Cnt" }]).has("cnt"));
  });
});

describe("buildTestCases", () => {
  const baseInventory: IntermediateRepresentation = {
    version: "1",
    source: { type: "explore", model: "m", explore: "e" },
    grain: { dimensions: [] },
    joins: [],
    dimensions: [
      { name: "account", type: "string", hidden: false },
      { name: "region", type: "string", hidden: false },
    ],
    measures: [{ name: "revenue", type: "number" }],
    filters: [],
    parameters: [],
    derivedTables: [],
    liquidLogic: [],
    userAttributes: [],
    formatting: {},
    tileQueries: [],
    unsupportedFeatures: [],
    lookmlFiles: [],
  };

  it("builds baseline and smoke tests for explores", () => {
    const tests = buildTestCases(baseInventory);
    assert.ok(tests.some((t) => t.id === "baseline"));
    assert.ok(tests.some((t) => t.id === "smoke_dim_measure"));
    assert.ok(tests.some((t) => t.type === "schema"));
  });

  it("runs pivoted tiles as value-parity tests (pivot dims as columns)", () => {
    const tests = buildTestCases({
      ...baseInventory,
      source: { type: "dashboard", model: "m", explore: "e", dashboardId: "1" },
      dimensions: [
        ...baseInventory.dimensions,
        { name: "account", type: "string" },
        { name: "region", type: "string" },
      ],
      measures: [
        ...baseInventory.measures,
        { name: "revenue", type: "sum", sql: "SUM(1)" },
      ],
      tileQueries: [
        {
          id: "t1",
          title: "Pivoted",
          model: "m",
          explore: "e",
          fields: ["account", "revenue"],
          pivots: ["region"],
        },
      ],
    });
    const pivoted = tests.find((t) => t.id === "tile_t1_pivot");
    assert.ok(pivoted);
    assert.strictEqual(pivoted?.skipStatus, undefined);
    assert.strictEqual(pivoted?.type, "pivot");
    assert.ok(pivoted?.name.includes("pivot dims as columns"));
    assert.ok(!(pivoted?.lookerQuery as { pivots?: string[] }).pivots);
  });
});

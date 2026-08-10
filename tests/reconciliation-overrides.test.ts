import { describe, it } from "node:test";
import assert from "node:assert";
import { compareRowSets } from "../lib/migration/comparator";
import { buildMetricViewSelect } from "../lib/migration/query-builder";
import {
  collectAllowedPlanDimensions,
  emptyOverrides,
  formatRuntimeDefect,
  mergeOverrides,
  resolveCompareConfigForTest,
  resolveQueryPlanForTest,
  sanitizeComparePatches,
  sanitizeQueryPlanPatches,
  shouldPauseDiagnosis,
  validatePredicateSql,
} from "../lib/migration/reconciliation-overrides";

describe("reconciliation overrides", () => {
  it("allows plan predicates for inventory dimensions added by the same diagnosis", () => {
    const allowed = collectAllowedPlanDimensions(
      ["sector"],
      [
        "fct_tam_buildings.property_id",
        "fct_tam_buildings.building_rba",
      ]
    );
    assert.deepStrictEqual(allowed, [
      "sector",
      "property_id",
      "building_rba",
    ]);

    const { accepted, rejected } = sanitizeQueryPlanPatches(
      [
        {
          testName: "TAM Metrics",
          filters: [],
          predicates: [
            "`property_id` <> '10630US'",
            "(`building_rba` >= 20000 OR `building_rba` IS NULL)",
          ],
          rationale: "restore Looker population",
        },
      ],
      allowed
    );
    assert.strictEqual(accepted.length, 1);
    assert.strictEqual(rejected.length, 0);
  });

  it("applies actionable patches before honoring optional human-input requests", () => {
    assert.strictEqual(
      shouldPauseDiagnosis({
        needsHumanInput: true,
        semanticPatchCount: 0,
        mappingPatchCount: 0,
        hasPlanOrComparePatch: true,
        onlyRuntimeDefect: false,
      }),
      false
    );
    assert.strictEqual(
      shouldPauseDiagnosis({
        needsHumanInput: true,
        semanticPatchCount: 0,
        mappingPatchCount: 0,
        hasPlanOrComparePatch: false,
        onlyRuntimeDefect: false,
      }),
      true
    );
  });

  it("validates safe predicates and rejects unsafe SQL", () => {
    const allowed = new Set(["year", "month_date", "anchor_month"]);
    assert.strictEqual(
      validatePredicateSql("`year` >= 2020", allowed).ok,
      true
    );
    assert.strictEqual(
      validatePredicateSql("`month_date` <= `anchor_month`", allowed).ok,
      true
    );
    assert.strictEqual(
      validatePredicateSql(
        "(`year` >= 2020 OR `year` IS NULL)",
        allowed
      ).ok,
      true
    );
    assert.strictEqual(
      validatePredicateSql(
        "(CAST(`year` AS STRING) NOT LIKE '%2012%' OR `year` IS NULL)",
        allowed
      ).ok,
      true
    );
    assert.strictEqual(
      validatePredicateSql(
        "CAST(`year` AS STRING) <= CAST(YEAR(CURRENT_TIMESTAMP()) AS STRING)",
        allowed
      ).ok,
      true
    );
    assert.strictEqual(
      validatePredicateSql("`year` >= 2020; DROP TABLE x", allowed).ok,
      false
    );
    assert.strictEqual(
      validatePredicateSql("`unknown_dim` >= 1", allowed).ok,
      false
    );
  });

  it("rejects unresolved Looker ${...} templates in filters and predicates", () => {
    const allowed = new Set(["month_date", "anchor_month"]);
    assert.strictEqual(
      validatePredicateSql(
        "`month_date` <= '${building_monthly_financials.anchor_month}'",
        allowed
      ).ok,
      false
    );

    const { accepted, rejected } = sanitizeQueryPlanPatches(
      [
        {
          testName: "Car Expenses vs. Budget",
          filters: [
            {
              field: "month_date",
              expression: "<= ${building_monthly_financials.anchor_month}",
            },
          ],
          predicates: ["`month_date` <= `anchor_month`"],
          rationale: "restore anchor month grain",
        },
      ],
      ["month_date", "anchor_month"]
    );
    // Bad templated filter dropped; the valid predicate keeps the patch alive.
    assert.strictEqual(accepted.length, 1);
    assert.strictEqual(accepted[0].filters.length, 0);
    assert.deepStrictEqual(accepted[0].predicates, [
      "`month_date` <= `anchor_month`",
    ]);
    assert.ok(
      rejected.some((r) => r.reason.includes("template"))
    );
  });

  it("sanitizes query-plan patches and merges filters into metric-view SQL", () => {
    const { accepted, rejected } = sanitizeQueryPlanPatches(
      [
        {
          testName: "YTD Total Claims",
          filters: [{ field: "building_monthly_financials.year", expression: ">=2020" }],
          predicates: ["`month_date` <= `anchor_month`"],
          rationale: "restore tile grain",
        },
        {
          testName: "bad",
          filters: [],
          predicates: ["1=1; DELETE FROM t"],
          rationale: "attack",
        },
      ],
      ["year", "month_date", "anchor_month"]
    );
    assert.strictEqual(accepted.length, 1);
    assert.ok(rejected.length >= 1);

    const overrides = mergeOverrides(emptyOverrides(), {
      queryPlanPatches: accepted,
    });
    const plan = resolveQueryPlanForTest(overrides, "YTD Total Claims");
    assert.ok(plan);
    assert.strictEqual(plan!.filters.year, ">=2020");
    assert.ok(plan!.predicates.includes("`month_date` <= `anchor_month`"));

    const sql = buildMetricViewSelect({
      catalog: "c",
      schema: "s",
      viewName: "v",
      fields: ["year", "claims"],
      measureNames: new Set(["claims"]),
      filters: plan!.filters,
      predicates: plan!.predicates,
      limit: 50,
    });
    assert.ok(sql.includes("`year` >= 2020"));
    assert.ok(sql.includes("`month_date` <= `anchor_month`"));
  });

  it("applies compare patches for decimalScale and forceKeyColumns", () => {
    const patches = sanitizeComparePatches([
      {
        testName: "",
        decimalScale: 4,
        forceKeyColumns: [],
        rationale: "tighter scale",
      },
      {
        testName: "Baseline explore query",
        decimalScale: -1,
        forceKeyColumns: ["account", "account_number"],
        rationale: "include account_number key",
      },
    ]);
    const overrides = mergeOverrides(emptyOverrides(), {
      comparePatches: patches,
    });
    const cfg = resolveCompareConfigForTest(
      { decimalScale: 2, timezone: "UTC" },
      overrides,
      "Baseline explore query"
    );
    assert.strictEqual(cfg.decimalScale, 4);
    assert.deepStrictEqual(cfg.forceKeyColumns, [
      "account",
      "account_number",
    ]);

    const result = compareRowSets(
      {
        columns: ["account", "account_number", "budget"],
        rows: [
          [null, "1013", 0],
          [null, null, -1.23456],
        ],
      },
      {
        columns: ["account", "account_number", "budget"],
        rows: [
          [null, "1013", "0"],
          [null, null, "-1.23456"],
        ],
      },
      { account: "string", account_number: "string", budget: "sum" },
      {
        decimalScale: cfg.decimalScale!,
        timezone: "UTC",
        forceKeyColumns: cfg.forceKeyColumns,
      }
    );
    assert.strictEqual(result.match, true);
  });

  it("formats runtime defects", () => {
    assert.strictEqual(
      formatRuntimeDefect({
        present: false,
        component: "",
        summary: "",
        repro: "",
      }),
      undefined
    );
    assert.ok(
      formatRuntimeDefect({
        present: true,
        component: "filter_compiler",
        summary: "dropped year filter",
        repro: "16 vs 7 rows",
      })?.includes("filter_compiler")
    );
  });
});

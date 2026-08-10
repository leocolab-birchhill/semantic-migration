import { describe, it } from "node:test";
import assert from "node:assert";
import {
  applyNullZeroCoalesceRepair,
  ensureAggregateCoalesceZero,
  failuresAreOnlyNullVsZero,
  measuresNeedingCoalesceZero,
} from "../lib/migration/coalesce-repair";
import { isNullVsZeroMismatch } from "../lib/migration/comparator";
import type { FailureTestEvidence } from "../lib/migration/reconciliation-overrides";
import type { ProposedAsset } from "../lib/migration/types";

describe("null↔0 coalesce repair", () => {
  it("detects Looker 0 vs Databricks null", () => {
    assert.strictEqual(isNullVsZeroMismatch(0, null), true);
    assert.strictEqual(isNullVsZeroMismatch(null, 0), true);
    assert.strictEqual(isNullVsZeroMismatch("0", null), true);
    assert.strictEqual(isNullVsZeroMismatch(0, 1), false);
    assert.strictEqual(isNullVsZeroMismatch(null, null), false);
  });

  it("wraps aggregate exprs once", () => {
    assert.strictEqual(
      ensureAggregateCoalesceZero("SUM(budget)"),
      "COALESCE(SUM(budget), 0)"
    );
    assert.strictEqual(
      ensureAggregateCoalesceZero("COALESCE(SUM(budget), 0)"),
      "COALESCE(SUM(budget), 0)"
    );
    assert.strictEqual(
      ensureAggregateCoalesceZero("source_col"),
      "source_col"
    );
  });

  it("identifies measures dominated by null↔0 diffs", () => {
    const failed: FailureTestEvidence[] = [
      {
        name: "Baseline",
        summary: "mismatch",
        columnDiffs: [
          {
            column: "budget",
            rowIndex: 0,
            lookerValue: 0,
            databricksValue: null,
            match: false,
          },
          {
            column: "budget",
            rowIndex: 1,
            lookerValue: 0,
            databricksValue: null,
            match: false,
          },
        ],
      },
    ];
    assert.deepStrictEqual(measuresNeedingCoalesceZero(failed), ["budget"]);
    assert.strictEqual(failuresAreOnlyNullVsZero(failed), true);
  });

  it("patches metric-view YAML for matching measures only", () => {
    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "tam_buildings",
        rationale: "test",
        yaml: [
          "version: '1.1'",
          "source: cat.sch.tbl",
          "dimensions:",
          "  - name: account",
          "    expr: account",
          "measures:",
          "  - name: budget",
          "    expr: SUM(budget)",
          "  - name: revenue",
          "    expr: SUM(revenue)",
        ].join("\n"),
      },
    ];
    const failed: FailureTestEvidence[] = [
      {
        name: "Baseline",
        summary: "mismatch",
        columnDiffs: [
          {
            column: "budget",
            rowIndex: 0,
            lookerValue: 0,
            databricksValue: null,
            match: false,
          },
        ],
      },
    ];
    const { assets: next, patchedMeasures } = applyNullZeroCoalesceRepair(
      assets,
      failed
    );
    assert.deepStrictEqual(patchedMeasures, ["budget"]);
    assert.match(next[0].yaml ?? "", /COALESCE\(SUM\(budget\), 0\)/);
    assert.match(next[0].yaml ?? "", /expr: SUM\(revenue\)/);
  });
});

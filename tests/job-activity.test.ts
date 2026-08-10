import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildActivityAlerts,
  resolveTileCoverageCounts,
  wasReclaimed,
} from "../lib/migration/job-activity";

describe("job-activity alerts", () => {
  it("detects reclaimed jobs", () => {
    assert.strictEqual(
      wasReclaimed("foo [reclaimed after stale heartbeat]"),
      true
    );
  });

  it("warns on long diagnose", () => {
    const alerts = buildActivityAlerts({
      status: "running",
      phase: "diagnose",
      errorMessage: null,
      updatedAt: new Date(Date.now() - 400_000).toISOString(),
      heartbeatAt: new Date().toISOString(),
      iterationCount: 3,
    });
    assert.ok(alerts.some((a) => a.title.includes("Diagnose")));
  });

  it("errors on stale heartbeat", () => {
    const alerts = buildActivityAlerts({
      status: "running",
      phase: "test",
      errorMessage: null,
      updatedAt: new Date().toISOString(),
      heartbeatAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      iterationCount: 2,
    });
    assert.ok(alerts.some((a) => a.level === "error"));
  });
});

describe("resolveTileCoverageCounts", () => {
  it("prefers live tests over empty report summary", () => {
    const counts = resolveTileCoverageCounts({
      tests: [
        { status: "pass", iteration_id: "i1" },
        { status: "fail", iteration_id: "i1" },
      ],
      reportSummary: {
        recreated: 0,
        mismatch: 0,
        compileError: 0,
        unsupported: 0,
        inconclusive: 0,
        error: 0,
        total: 0,
      },
      expectedTotal: 31,
    });
    assert.strictEqual(counts.total, 2);
    assert.strictEqual(counts.pass, 1);
    assert.strictEqual(counts.fail, 1);
    assert.strictEqual(counts.pending, false);
  });

  it("shows expected denominator while awaiting tests", () => {
    const counts = resolveTileCoverageCounts({
      tests: [],
      reportSummary: null,
      expectedTotal: 31,
    });
    assert.strictEqual(counts.total, 31);
    assert.strictEqual(counts.pending, true);
    assert.strictEqual(counts.pass, 0);
  });

  it("uses report when tests empty but report has totals", () => {
    const counts = resolveTileCoverageCounts({
      tests: [],
      reportSummary: {
        recreated: 20,
        closeMatch: 2,
        mismatch: 1,
        compileError: 0,
        unsupported: 0,
        inconclusive: 0,
        error: 0,
        total: 23,
      },
    });
    assert.strictEqual(counts.total, 23);
    assert.strictEqual(counts.pass, 20);
    assert.strictEqual(counts.closeMatch, 2);
    assert.strictEqual(counts.pending, false);
  });
});

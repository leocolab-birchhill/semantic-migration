import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildMigrationReport,
  formatNeedsInputMessage,
} from "../lib/migration/report";
import type { MigrationJobRecord } from "../lib/migration/types";

const baseJob: MigrationJobRecord = {
  id: "job-1",
  tenantId: "default",
  userEmail: "u@example.com",
  status: "needs_input",
  lookerSourceType: "table_scope",
  lookerModel: null,
  lookerExplore: null,
  lookerDashboardId: null,
  lookerDashboardTitle: null,
  databricksHost: "adb.example.com",
  warehouseId: "wh",
  catalog: "databricks_prd",
  sourceSchema: "dbt_production",
  sourceTable: "fct_tam_buildings",
  devSchema: "semantic_migration_dev",
  prodSchema: "business_semantics",
  maxIterations: 5,
  decimalScale: 2,
  timezone: "UTC",
  currentPhase: "diagnose",
  iterationCount: 2,
  inventory: null,
  parityReport: null,
  migrationScope: null,
  errorMessage: "Ambiguous measure population",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  approvedAt: null,
  publishedAt: null,
  heartbeatAt: null,
};

describe("buildMigrationReport", () => {
  it("lists written objects, tile buckets, and next steps for needs_input", () => {
    const report = buildMigrationReport({
      job: baseJob,
      assets: [
        {
          type: "sql_view",
          name: "tam_buildings_semantic_base",
          schema: "semantic_migration_dev",
          description: "",
          sql: "SELECT 1",
        },
        {
          type: "metric_view",
          name: "tam_buildings",
          schema: "semantic_migration_dev",
          description: "",
          yaml: "version: 1.1",
        },
      ],
      tests: [
        {
          test_name: "Old iter pass",
          status: "pass",
          iteration_id: "iter-1",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          test_name: "Revenue Share",
          status: "pass",
          diff_summary: "All rows match",
          iteration_id: "iter-2",
          created_at: "2026-01-01T01:00:00.000Z",
        },
        {
          test_name: "Outside TAM",
          status: "fail",
          diff_summary: "value mismatch",
          iteration_id: "iter-2",
          created_at: "2026-01-01T01:00:01.000Z",
        },
        {
          test_name: "Pivot tile",
          status: "unsupported",
          diff_summary: "pivots unsupported",
          iteration_id: "iter-2",
          created_at: "2026-01-01T01:00:02.000Z",
        },
      ],
      events: [
        {
          id: "e1",
          jobId: "job-1",
          iterationNumber: 1,
          eventType: "inventory_done",
          title: "inventory",
          detail: null,
          payload: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: "e2",
          jobId: "job-1",
          iterationNumber: 1,
          eventType: "deploy_done",
          title: "deployed",
          detail: "wrote views",
          payload: null,
          createdAt: new Date().toISOString(),
        },
      ],
      diagnosis: "Need LookML filters for outside_tam",
      pauseReason: "Ambiguous measure population",
    });

    assert.strictEqual(report.writtenToDatabricks.length, 2);
    assert.ok(
      report.writtenToDatabricks[0].fqn.includes("semantic_migration_dev")
    );
    assert.strictEqual(report.summary.total, 3); // latest iteration only
    assert.strictEqual(report.summary.recreated, 1);
    assert.strictEqual(report.summary.closeMatch, 0);
    assert.strictEqual(report.summary.mismatch, 1);
    assert.strictEqual(report.summary.unsupported, 1);
    assert.ok(report.scorecard);
    assert.strictEqual(report.scorecard.exactMatches, 1);
    assert.ok(report.scorecard.verdict.length > 0);
    assert.ok(report.scorecard.howToUse.length >= 2);
    assert.ok(report.whatWasDone.length >= 2);
    assert.ok(report.nextSteps.some((s) => /Inspect|Databricks/i.test(s)));
    assert.ok(report.nextSteps.some((s) => /Rerun/i.test(s)));

    const msg = formatNeedsInputMessage(report);
    assert.ok(msg.includes("Written to Databricks"));
    assert.ok(msg.includes("Next:"));
    assert.ok(msg.includes("usable") || msg.includes("exact"));
  });

  it("maps pass_with_boundary_drift to close_match in the scorecard", () => {
    const report = buildMigrationReport({
      job: { ...baseJob, status: "awaiting_approval" },
      assets: [
        {
          type: "metric_view",
          name: "tam_buildings",
          schema: "semantic_migration_dev",
          description: "",
          yaml: "version: 1.1",
        },
      ],
      tests: [
        {
          test_name: "Owners",
          status: "pass_with_boundary_drift",
          diff_summary: "boundary drift",
          iteration_id: "iter-1",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          test_name: "Revenue",
          status: "pass",
          diff_summary: "All rows match",
          iteration_id: "iter-1",
          created_at: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    assert.strictEqual(report.summary.closeMatch, 1);
    assert.strictEqual(report.summary.recreated, 1);
    assert.strictEqual(report.scorecard.closeMatches, 1);
    assert.strictEqual(report.scorecard.accuracyPercent, 100);
    assert.ok(/usable|accurate|top-N/i.test(report.scorecard.verdict));
  });
});

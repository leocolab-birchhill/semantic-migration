import type { MigrationPhase } from "@/lib/migration/types";

export const PHASE_LABELS: Record<string, string> = {
  inventory: "Reading Looker inventory",
  baseline: "Capturing Looker tile benchmarks",
  generate: "Generating Databricks assets (GPT)",
  validate: "Validating generated assets",
  deploy_dev: "Deploying to dev schema",
  test: "Running parity tests",
  compare: "Comparing results",
  diagnose: "Diagnosing failures (GPT)",
  patch: "Applying patches",
  awaiting_approval: "Awaiting your approval",
  publish: "Publishing to production",
  complete: "Complete",
};

export const PHASE_HINTS: Record<string, string> = {
  inventory: "Pulling dimensions, measures, and joins from the Looker explore.",
  baseline:
    "Re-running every dashboard tile in Looker to capture baseline results. This can take several minutes.",
  generate:
    "OpenAI is proposing SQL views and metric-view YAML for your dev schema.",
  deploy_dev:
    "Creating or replacing views in your WRITE TO dev schema in Databricks.",
  test:
    "Each tile query runs on Databricks and is compared row-by-row to the Looker baseline.",
  diagnose:
    "OpenAI is analyzing failures and deciding what to patch. Usually 1–5 minutes; longer may mean a hang or database connectivity issue.",
  patch: "Merging GPT patches before the next deploy/test cycle.",
  awaiting_approval:
    "Mandatory tiles passed. Review the migration report and approve when ready.",
};

/** Heartbeat older than this while running → show a warning in the UI. */
export const HEARTBEAT_WARN_SECONDS = 120;

/** Matches worker reclaim threshold (15 min). */
export const HEARTBEAT_STALE_SECONDS = 15 * 60;

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase.replace(/_/g, " ");
}

export function phaseHint(phase: string): string | undefined {
  return PHASE_HINTS[phase];
}

export function secondsSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor(ms / 1000));
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

export function wasReclaimed(errorMessage: string | null | undefined): boolean {
  return Boolean(
    errorMessage?.includes("reclaimed after stale heartbeat") ||
      errorMessage?.includes("worker heartbeat went stale")
  );
}

export interface TestStatusCounts {
  pass: number;
  closeMatch: number;
  fail: number;
  compileError: number;
  unsupported: number;
  inconclusive: number;
  error: number;
  total: number;
}

export function countTestsByStatus(
  tests: Array<{ status: string; iteration_id?: string | null }>
): TestStatusCounts {
  const latestId = findLatestIterationId(tests);
  const slice = latestId
    ? tests.filter((t) => t.iteration_id === latestId)
    : tests;

  const counts: TestStatusCounts = {
    pass: 0,
    closeMatch: 0,
    fail: 0,
    compileError: 0,
    unsupported: 0,
    inconclusive: 0,
    error: 0,
    total: slice.length,
  };

  for (const t of slice) {
    switch (t.status) {
      case "pass":
        counts.pass++;
        break;
      case "pass_with_boundary_drift":
        counts.closeMatch++;
        break;
      case "fail":
        counts.fail++;
        break;
      case "query_compilation_error":
        counts.compileError++;
        break;
      case "unsupported":
        counts.unsupported++;
        break;
      case "inconclusive":
        counts.inconclusive++;
        break;
      default:
        counts.error++;
    }
  }
  return counts;
}

/** Prefer live test rows over a stale empty migration report summary. */
export function resolveTileCoverageCounts(params: {
  tests: Array<{
    status: string;
    iteration_id?: string | null;
    created_at?: string;
  }>;
  reportSummary?: {
    recreated: number;
    closeMatch?: number;
    mismatch: number;
    compileError: number;
    unsupported: number;
    inconclusive: number;
    error: number;
    total: number;
  } | null;
  /** Expected tile/test count before parity runs (benchmarks / scope tiles). */
  expectedTotal?: number | null;
}): TestStatusCounts & { pending: boolean } {
  const fromTests = countTestsByStatus(params.tests);
  const report = params.reportSummary;

  // Live tests win when present — crash reports can leave total=0 summaries.
  if (fromTests.total > 0) {
    return { ...fromTests, pending: false };
  }

  if (report && report.total > 0) {
    return {
      pass: report.recreated,
      closeMatch: report.closeMatch ?? 0,
      fail: report.mismatch,
      compileError: report.compileError,
      unsupported: report.unsupported,
      inconclusive: report.inconclusive,
      error: report.error,
      total: report.total,
      pending: false,
    };
  }

  const expected = params.expectedTotal ?? 0;
  return {
    pass: 0,
    closeMatch: 0,
    fail: 0,
    compileError: 0,
    unsupported: 0,
    inconclusive: 0,
    error: 0,
    total: expected,
    pending: expected > 0,
  };
}

/** Best-effort expected tile count from job inventory / migration scope. */
export function expectedTileCountFromJob(job: {
  inventory?: {
    benchmarks?: unknown[];
    tileQueries?: unknown[];
  } | null;
  migrationScope?: { tiles?: unknown[] } | null;
}): number {
  const benches = job.inventory?.benchmarks?.length ?? 0;
  if (benches > 0) return benches;
  const tiles = job.migrationScope?.tiles?.length ?? 0;
  if (tiles > 0) return tiles;
  const queries = job.inventory?.tileQueries?.length ?? 0;
  return queries;
}

export function findLatestIterationId(
  tests: Array<{ iteration_id?: string | null; created_at?: string | Date }>
): string | null {
  let latestId: string | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  let sawTimestamp = false;
  for (const t of tests) {
    if (!t.iteration_id) continue;
    const at = t.created_at ? new Date(t.created_at).getTime() : Number.NaN;
    if (!Number.isNaN(at)) {
      sawTimestamp = true;
      if (at >= latestAt) {
        latestAt = at;
        latestId = t.iteration_id;
      }
    } else if (!sawTimestamp) {
      latestId = t.iteration_id;
    }
  }
  return latestId;
}

export interface ActivityAlert {
  level: "info" | "warn" | "error";
  title: string;
  detail: string;
}

export function buildActivityAlerts(params: {
  status: string;
  phase: string;
  errorMessage: string | null;
  updatedAt: string;
  heartbeatAt: string | null;
  iterationCount: number;
  latestIterationNumber?: number;
}): ActivityAlert[] {
  const alerts: ActivityAlert[] = [];
  const hbSec = secondsSince(params.heartbeatAt ?? params.updatedAt);
  const updatedSec = secondsSince(params.updatedAt);

  if (wasReclaimed(params.errorMessage)) {
    alerts.push({
      level: "error",
      title: "Job was abandoned after a stale heartbeat",
      detail:
        "The worker stopped updating this job for 15+ minutes. It was cancelled (not auto-restarted). Use Rerun or Start migration when the worker is healthy.",
    });
  }

  if (
    params.status === "cancelled" &&
    /heartbeat went stale|Cancelled by user/i.test(params.errorMessage ?? "")
  ) {
    alerts.push({
      level: "info",
      title: "Job stopped",
      detail:
        params.errorMessage ??
        "This run was cancelled. Start a new migration or Rerun when ready.",
    });
  }

  if (params.status === "running") {
    if (params.phase === "diagnose" && updatedSec != null && updatedSec > 300) {
      alerts.push({
        level: "warn",
        title: "Diagnose has been running a long time",
        detail:
          "GPT diagnose usually finishes in 1–5 minutes. If this exceeds ~10 minutes, check that npm run worker is running and the database connection is healthy (Lakebase token may have expired).",
      });
    }

    if (hbSec != null && hbSec >= HEARTBEAT_WARN_SECONDS) {
      alerts.push({
        level: hbSec >= HEARTBEAT_STALE_SECONDS ? "error" : "warn",
        title:
          hbSec >= HEARTBEAT_STALE_SECONDS
            ? "Worker heartbeat is stale — job will be cancelled soon"
            : "No worker heartbeat recently",
        detail:
          hbSec >= HEARTBEAT_STALE_SECONDS
            ? `Last heartbeat was ${formatDuration(hbSec)} ago. At 15 minutes the job is cancelled (not restarted). Restart npm run worker if needed, then Rerun.`
            : `Last heartbeat ${formatDuration(hbSec)} ago. Long steps (baseline, GPT) are normal, but ensure npm run worker is still running.`,
      });
    }

    if (
      params.latestIterationNumber != null &&
      params.iterationCount > 0 &&
      params.latestIterationNumber < params.iterationCount &&
      (params.phase === "inventory" || params.phase === "baseline")
    ) {
      alerts.push({
        level: "warn",
        title: "Job may have restarted mid-run",
        detail: `UI shows iteration ${params.iterationCount} but the latest saved repair loop is ${params.latestIterationNumber}.`,
      });
    }
  }

  if (params.status === "pending") {
    alerts.push({
      level: "info",
      title: "Waiting for worker",
      detail:
        "Job is queued. The background worker (npm run worker / start:local) will pick it up shortly.",
    });
  }

  return alerts;
}

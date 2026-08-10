import { v4 as uuidv4 } from "uuid";
import { query } from "@/lib/db/client";
import {
  getJobArtifacts,
  getJobTests,
  saveArtifact,
} from "@/lib/migration/jobs";
import type {
  MigrationJobRecord,
  ProposedAsset,
} from "@/lib/migration/types";

export type MigrationEventType =
  | "phase_start"
  | "inventory_done"
  | "baseline_done"
  | "generate_done"
  | "deploy_done"
  | "deploy_failed"
  | "test_summary"
  | "diagnose"
  | "needs_input"
  | "awaiting_approval"
  | "failed"
  | "published"
  | "info";

export interface MigrationEvent {
  id: string;
  jobId: string;
  iterationNumber: number | null;
  eventType: MigrationEventType;
  title: string;
  detail: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export type TileRecreationStatus =
  | "recreated"
  | "close_match"
  | "mismatch"
  | "unsupported"
  | "compile_error"
  | "error"
  | "inconclusive";

export interface MigrationReportTile {
  name: string;
  status: TileRecreationStatus;
  summary: string;
}

export interface MigrationReportObject {
  type: string;
  name: string;
  fqn: string;
  deployedAt?: string;
}

export interface MigrationReportScorecard {
  /** 0–100 share of tiles that are usable (exact or close match). */
  accuracyPercent: number;
  exactMatches: number;
  closeMatches: number;
  mismatches: number;
  blocked: number;
  /** One-line verdict for non-technical readers. */
  verdict: string;
  /** How to try the metric view in Databricks. */
  howToUse: string[];
}

export interface MigrationReport {
  version: "1";
  generatedAt: string;
  jobStatus: string;
  pauseReason: string | null;
  writtenToDatabricks: MigrationReportObject[];
  writeTarget: string;
  publishTarget: string;
  tiles: MigrationReportTile[];
  summary: {
    recreated: number;
    closeMatch?: number;
    mismatch: number;
    unsupported: number;
    compileError: number;
    error: number;
    inconclusive: number;
    total: number;
  };
  scorecard?: MigrationReportScorecard;
  whatWasDone: string[];
  nextSteps: string[];
  diagnosis: string | null;
}

function fqn(catalog: string, schema: string, name: string): string {
  return `${catalog}.${schema}.${name}`;
}

export async function saveJobEvent(params: {
  jobId: string;
  eventType: MigrationEventType;
  title: string;
  detail?: string;
  iterationNumber?: number;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO migration_events (
      id, job_id, iteration_number, event_type, title, detail, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      uuidv4(),
      params.jobId,
      params.iterationNumber ?? null,
      params.eventType,
      params.title,
      params.detail ?? null,
      params.payload ? JSON.stringify(params.payload) : null,
    ]
  );
}

export async function getJobEvents(jobId: string): Promise<MigrationEvent[]> {
  const { rows } = await query(
    `SELECT * FROM migration_events
     WHERE job_id = $1
     ORDER BY created_at ASC`,
    [jobId]
  );
  return rows.map((row) => ({
    id: row.id as string,
    jobId: row.job_id as string,
    iterationNumber: (row.iteration_number as number | null) ?? null,
    eventType: row.event_type as MigrationEventType,
    title: row.title as string,
    detail: (row.detail as string | null) ?? null,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  }));
}

function mapTestStatus(status: string): TileRecreationStatus {
  switch (status) {
    case "pass":
      return "recreated";
    case "pass_with_boundary_drift":
      return "close_match";
    case "fail":
      return "mismatch";
    case "unsupported":
      return "unsupported";
    case "query_compilation_error":
      return "compile_error";
    case "inconclusive":
      return "inconclusive";
    default:
      return "error";
  }
}

function buildScorecard(params: {
  summary: MigrationReport["summary"];
  writeTarget: string;
  metricViewNames: string[];
}): MigrationReportScorecard {
  const usable = params.summary.recreated + (params.summary.closeMatch ?? 0);
  const blocked =
    params.summary.unsupported +
    params.summary.compileError +
    params.summary.inconclusive;
  const comparable =
    usable + params.summary.mismatch + params.summary.error;
  const accuracyPercent =
    comparable > 0 ? Math.round((usable / comparable) * 100) : 0;

  let verdict: string;
  if (comparable === 0 && blocked > 0) {
    verdict =
      "No comparable tiles ran — check unsupported / compile issues below.";
  } else if (params.summary.mismatch === 0 && params.summary.error === 0) {
    verdict =
      (params.summary.closeMatch ?? 0) > 0
        ? `Metric view looks usable: all comparable tiles match (including ${params.summary.closeMatch} with minor top-N list differences).`
        : "Metric view looks accurate: all comparable Looker tiles match Databricks.";
  } else if (accuracyPercent >= 80) {
    verdict = `Mostly accurate (${accuracyPercent}% usable). Review the mismatched tiles below.`;
  } else {
    verdict = `Needs attention: only ${accuracyPercent}% of comparable tiles match Looker.`;
  }

  const mv =
    params.metricViewNames[0] ??
    "(metric view name from written objects above)";
  const howToUse = [
    `In Databricks Catalog Explorer, open ${params.writeTarget} and inspect the metric view.`,
    `In a SQL warehouse notebook/editor, query it with MEASURE(), e.g. SELECT … MEASURE(your_measure) FROM ${params.writeTarget}.${mv} GROUP BY …`,
    "Compare those results to the same Looker dashboard tiles — the scorecard below already did that for selected benchmarks.",
    "Creating a full Databricks AI/BI dashboard from this app is not automated yet; start from the metric view in Databricks Dashboards and add tiles that call MEASURE().",
  ];

  return {
    accuracyPercent,
    exactMatches: params.summary.recreated,
    closeMatches: params.summary.closeMatch ?? 0,
    mismatches: params.summary.mismatch,
    blocked,
    verdict,
    howToUse,
  };
}

function buildNextSteps(params: {
  job: MigrationJobRecord;
  reportStatus: string;
  hasDeployed: boolean;
  mismatch: number;
  unsupported: number;
  compileError: number;
}): string[] {
  const writeTarget = `${params.job.catalog}.${params.job.devSchema}`;
  const steps: string[] = [];

  if (params.reportStatus === "needs_input") {
    steps.push(
      `Inspect what was written in Databricks: ${writeTarget} (SQL views + metric views listed above).`
    );
    if (params.mismatch > 0 || params.compileError > 0) {
      steps.push(
        "Review mismatched / compile-error tiles below — those are the blockers the agent could not safely auto-fix."
      );
    }
    if (params.unsupported > 0) {
      steps.push(
        "Unsupported tiles (pivots, missing LookML fields) will not block a partial migration; decide whether to accept them as out of scope."
      );
    }
    steps.push(
      "Rerun this configuration after updating LookML inventory, field definitions, or confirming ambiguous measure populations."
    );
    steps.push(
      "Or start a new migration once the source explore/dashboard definitions are clarified."
    );
    return steps;
  }

  if (params.reportStatus === "awaiting_approval") {
    steps.push(
      "Review the migration report and approve when tile parity looks correct."
    );
    steps.push(
      `Objects are only in ${writeTarget} until you publish to production.`
    );
    return steps;
  }

  if (params.reportStatus === "failed") {
    steps.push(
      params.hasDeployed
        ? `Partial assets may still exist in ${writeTarget} — inspect before cleaning up.`
        : "Nothing durable may have been written — check the timeline for the last successful step."
    );
    steps.push("Rerun this configuration after addressing the failure reason.");
    return steps;
  }

  if (params.hasDeployed) {
    steps.push(`Inspect deployed objects in ${writeTarget}.`);
  }
  return steps;
}

/**
 * Build a user-facing migration report from the latest test results + deployed assets.
 * Always includes what was written and concrete next steps — especially for needs_input.
 */
export function buildMigrationReport(params: {
  job: MigrationJobRecord;
  assets: ProposedAsset[];
  tests: Array<{
    test_name: string;
    status: string;
    diff_summary?: string | null;
    iteration_id?: string | null;
    created_at?: Date | string;
  }>;
  events?: MigrationEvent[];
  diagnosis?: string | null;
  pauseReason?: string | null;
}): MigrationReport {
  const { job, assets } = params;
  const writeTarget = `${job.catalog}.${job.devSchema}`;
  const publishTarget = `${job.catalog}.${job.prodSchema ?? job.devSchema.replace(/_dev$/, "_prod")}`;

  // Prefer latest iteration's tests only (tests accumulate across iterations).
  let latestIterationId: string | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  let sawTimestamp = false;
  for (const t of params.tests) {
    if (!t.iteration_id) continue;
    const at = t.created_at ? new Date(t.created_at).getTime() : Number.NaN;
    if (!Number.isNaN(at)) {
      sawTimestamp = true;
      if (at >= latestAt) {
        latestAt = at;
        latestIterationId = t.iteration_id;
      }
    } else if (!sawTimestamp) {
      // No timestamps available: last row wins (append order).
      latestIterationId = t.iteration_id;
    }
  }
  const latestTests = latestIterationId
    ? params.tests.filter((t) => t.iteration_id === latestIterationId)
    : params.tests;

  // "Semantic schema coverage" is an informational inventory note, not a
  // Looker-vs-Databricks check — keep it out of tile buckets and % usable.
  const schemaCoverage = latestTests.find(
    (t) => t.test_name === "Semantic schema coverage"
  );
  const tileTests = latestTests.filter(
    (t) => t.test_name !== "Semantic schema coverage"
  );

  const tiles: MigrationReportTile[] = tileTests.map((t) => ({
    name: t.test_name,
    status: mapTestStatus(t.status),
    summary: t.diff_summary ?? "",
  }));

  const summary = {
    recreated: tiles.filter((t) => t.status === "recreated").length,
    closeMatch: tiles.filter((t) => t.status === "close_match").length,
    mismatch: tiles.filter((t) => t.status === "mismatch").length,
    unsupported: tiles.filter((t) => t.status === "unsupported").length,
    compileError: tiles.filter((t) => t.status === "compile_error").length,
    error: tiles.filter((t) => t.status === "error").length,
    inconclusive: tiles.filter((t) => t.status === "inconclusive").length,
    total: tiles.length,
  };

  const deployEvent = [...(params.events ?? [])]
    .reverse()
    .find((e) => e.eventType === "deploy_done");
  const deployedAt = deployEvent?.createdAt;

  const writtenToDatabricks: MigrationReportObject[] = assets
    .filter((a) => a.type === "sql_view" || a.type === "metric_view")
    .map((a) => ({
      type: a.type,
      name: a.name,
      fqn: fqn(job.catalog, job.devSchema, a.name),
      deployedAt,
    }));

  const whatWasDone: string[] = [];
  const events = params.events ?? [];
  if (events.some((e) => e.eventType === "inventory_done")) {
    whatWasDone.push("Looker inventory captured (dimensions, measures, joins).");
  }
  if (events.some((e) => e.eventType === "baseline_done")) {
    whatWasDone.push("Looker tile benchmarks captured for parity comparison.");
  }
  if (events.some((e) => e.eventType === "generate_done")) {
    whatWasDone.push("Databricks SQL views / metric views generated.");
  }
  if (writtenToDatabricks.length > 0) {
    whatWasDone.push(
      `Wrote ${writtenToDatabricks.length} object(s) to ${writeTarget}: ${writtenToDatabricks
        .map((o) => o.name)
        .join(", ")}.`
    );
  } else if (events.some((e) => e.eventType === "deploy_failed")) {
    whatWasDone.push("Attempted Databricks deploy but it failed (see timeline).");
  }
  if (summary.total > 0) {
    whatWasDone.push(
      `Ran ${summary.total} tile/smoke tests: ${summary.recreated} exact match, ${summary.closeMatch} close match, ${summary.mismatch} mismatch, ${summary.unsupported} unsupported, ${summary.compileError} compile errors.`
    );
  }
  if (schemaCoverage?.diff_summary) {
    whatWasDone.push(
      `Semantic schema inventoried: ${schemaCoverage.diff_summary} (informational — not a parity check).`
    );
  }
  if (params.diagnosis) {
    whatWasDone.push("OpenAI diagnosed remaining failures and paused for human input.");
  }

  const nextSteps = buildNextSteps({
    job,
    reportStatus: job.status,
    hasDeployed: writtenToDatabricks.length > 0,
    mismatch: summary.mismatch,
    unsupported: summary.unsupported,
    compileError: summary.compileError,
  });

  const scorecard = buildScorecard({
    summary,
    writeTarget,
    metricViewNames: writtenToDatabricks
      .filter((o) => o.type === "metric_view")
      .map((o) => o.name),
  });

  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    jobStatus: job.status,
    pauseReason: params.pauseReason ?? job.errorMessage,
    writtenToDatabricks,
    writeTarget,
    publishTarget,
    tiles,
    summary,
    scorecard,
    whatWasDone,
    nextSteps,
    diagnosis: params.diagnosis ?? null,
  };
}

export async function saveMigrationReport(
  jobId: string,
  report: MigrationReport
): Promise<void> {
  // Keep only the latest report artifact
  await query(
    `DELETE FROM migration_artifacts
     WHERE job_id = $1 AND artifact_type = 'documentation' AND name = 'migration_report'`,
    [jobId]
  );
  await saveArtifact(
    jobId,
    "documentation",
    "migration_report",
    JSON.stringify(report, null, 2)
  );
}

export async function buildAndSaveMigrationReport(params: {
  job: MigrationJobRecord;
  assets: ProposedAsset[];
  diagnosis?: string | null;
  pauseReason?: string | null;
  statusOverride?: string;
}): Promise<MigrationReport> {
  const [tests, events] = await Promise.all([
    getJobTests(params.job.id),
    getJobEvents(params.job.id),
  ]);
  const report = buildMigrationReport({
    job: {
      ...params.job,
      status: (params.statusOverride ?? params.job.status) as MigrationJobRecord["status"],
      errorMessage: params.pauseReason ?? params.job.errorMessage,
    },
    assets: params.assets,
    tests: tests as Array<{
      test_name: string;
      status: string;
      diff_summary?: string | null;
      iteration_id?: string | null;
      created_at?: Date | string;
    }>,
    events,
    diagnosis: params.diagnosis,
    pauseReason: params.pauseReason,
  });
  await saveMigrationReport(params.job.id, report);
  return report;
}

export async function getLatestMigrationReport(
  jobId: string
): Promise<MigrationReport | null> {
  const artifacts = await getJobArtifacts(jobId);
  const row = [...artifacts]
    .reverse()
    .find(
      (a) =>
        a.artifact_type === "documentation" && a.name === "migration_report"
    );
  if (!row) return null;
  try {
    return JSON.parse(row.content as string) as MigrationReport;
  } catch {
    return null;
  }
}

/** Short user-facing pause blurb always listing write target + next action. */
export function formatNeedsInputMessage(report: MigrationReport): string {
  const objects =
    report.writtenToDatabricks.length > 0
      ? report.writtenToDatabricks.map((o) => o.fqn).join(", ")
      : "(no objects deployed yet)";
  const reason = report.pauseReason?.trim() || "Agent needs guidance on remaining failures.";
  const next = report.nextSteps[0] ?? "Rerun this configuration after reviewing the report.";
  return [
    reason,
    "",
    `Written to Databricks: ${objects}`,
    `Parity so far: ${(report.summary.recreated ?? 0) + (report.summary.closeMatch ?? 0)}/${report.summary.total} tiles usable (${report.summary.recreated} exact, ${report.summary.closeMatch ?? 0} close, ${report.summary.mismatch} mismatch, ${report.summary.unsupported} unsupported).`,
    `Next: ${next}`,
  ].join("\n");
}

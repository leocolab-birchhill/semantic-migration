"use client";

import type { MigrationJobRecord } from "@/lib/migration/types";
import type { MigrationEvent, MigrationReport } from "@/lib/migration/report";
import {
  buildActivityAlerts,
  expectedTileCountFromJob,
  formatDuration,
  phaseHint,
  phaseLabel,
  resolveTileCoverageCounts,
  secondsSince,
} from "@/lib/migration/job-activity";

interface WorkerStatus {
  databaseOk: boolean;
  databaseError?: string;
  workerLikelyUp: boolean;
  runningJobs: number;
  hint?: string;
  activeJob?: {
    secondsSinceHeartbeat: number | null;
    heartbeatWarning: boolean;
    heartbeatStale: boolean;
    reclaimed: boolean;
  };
}

interface JobActivityPanelProps {
  job: MigrationJobRecord;
  tests: Array<{
    status: string;
    iteration_id?: string | null;
    created_at?: string;
  }>;
  iterations: Array<{
    iteration_number?: number;
    phase?: string;
    diagnosis?: string | null;
    tests_passed?: number;
    tests_failed?: number;
    needs_human_input?: boolean;
  }>;
  events: MigrationEvent[];
  migrationReport: MigrationReport | null;
  workerStatus: WorkerStatus | null;
}

export function JobActivityPanel({
  job,
  tests,
  iterations,
  events,
  migrationReport,
  workerStatus,
}: JobActivityPanelProps) {
  const latestIter = iterations.length
    ? [...iterations].sort(
        (a, b) => (b.iteration_number ?? 0) - (a.iteration_number ?? 0)
      )[0]
    : undefined;

  const coverage = resolveTileCoverageCounts({
    tests,
    reportSummary: migrationReport?.summary ?? null,
    expectedTotal: expectedTileCountFromJob(job),
  });
  const counts = coverage;

  const hbSec =
    secondsSince(job.heartbeatAt ?? job.updatedAt) ??
    workerStatus?.activeJob?.secondsSinceHeartbeat ??
    null;

  const alerts = buildActivityAlerts({
    status: job.status,
    phase: job.currentPhase,
    errorMessage: job.errorMessage,
    updatedAt: job.updatedAt,
    heartbeatAt: job.heartbeatAt,
    iterationCount: job.iterationCount,
    latestIterationNumber: latestIter?.iteration_number,
  });

  if (!workerStatus?.databaseOk) {
    alerts.unshift({
      level: "error",
      title: "Database unreachable",
      detail:
        workerStatus?.databaseError ??
        "The app cannot reach Postgres/Lakebase. The worker cannot save job progress. Fix credentials and restart npm run worker.",
    });
  } else if (workerStatus && !workerStatus.workerLikelyUp) {
    alerts.unshift({
      level: "warn",
      title: "Worker may not be running",
      detail:
        workerStatus.hint ??
        "Start npm run worker in a separate terminal so jobs can process.",
    });
  }

  const latestEvent = events.length ? events[events.length - 1] : null;
  const hint = phaseHint(job.currentPhase);

  const usable = counts.pass + (counts.closeMatch ?? 0);
  const denom =
    counts.total > 0 ? String(counts.total) : coverage.pending ? "…" : "—";

  return (
    <div className="mt-4 space-y-3">
      {/* Live status strip */}
      <div className="rounded-md border border-blue-200 bg-blue-50/80 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-blue-950">
              {job.status === "running" ? "In progress" : job.status.replace(/_/g, " ")}
              {": "}
              {phaseLabel(job.currentPhase)}
            </p>
            {hint && (
              <p className="mt-1 text-xs text-blue-900/80">{hint}</p>
            )}
          </div>
          <div className="text-right text-xs text-blue-900/70">
            {hbSec != null && (
              <p>Last worker ping: {formatDuration(hbSec)} ago</p>
            )}
            <p>Updated: {new Date(job.updatedAt).toLocaleTimeString()}</p>
          </div>
        </div>

        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <div className="rounded bg-white/60 px-2 py-1.5">
            <dt className="text-blue-800/70">Repair loop</dt>
            <dd className="font-semibold text-blue-950">
              {latestIter?.iteration_number ?? job.iterationCount} /{" "}
              {job.maxIterations}
              {latestIter?.phase && (
                <span className="ml-1 font-normal text-blue-900/70">
                  ({latestIter.phase})
                </span>
              )}
            </dd>
          </div>
          <div className="rounded bg-white/60 px-2 py-1.5">
            <dt className="text-blue-800/70">Tile coverage</dt>
            <dd className="font-semibold text-blue-950">
              {coverage.pending ? (
                <span className="text-blue-900/80">
                  0/{denom} awaiting tests
                </span>
              ) : (
                <span className="text-green-700">
                  {usable}/{denom} usable
                </span>
              )}
              {(counts.compileError > 0 || counts.unsupported > 0) && (
                <span className="mt-0.5 block font-normal text-amber-800">
                  {counts.compileError > 0 && (
                    <>{counts.compileError} need fix</>
                  )}
                  {counts.compileError > 0 && counts.unsupported > 0 && " · "}
                  {counts.unsupported > 0 && (
                    <>{counts.unsupported} platform/Looker gap</>
                  )}
                </span>
              )}
              {counts.fail > 0 && (
                <span className="mt-0.5 block font-normal text-red-700">
                  {counts.fail} value mismatch
                </span>
              )}
            </dd>
          </div>
          <div className="rounded bg-white/60 px-2 py-1.5">
            <dt className="text-blue-800/70">Worker / DB</dt>
            <dd className="font-semibold text-blue-950">
              {workerStatus?.databaseOk ? (
                workerStatus.workerLikelyUp ? (
                  <span className="text-green-700">Healthy</span>
                ) : (
                  <span className="text-amber-700">Check worker</span>
                )
              ) : (
                <span className="text-red-700">DB error</span>
              )}
            </dd>
          </div>
        </dl>

        {latestEvent && job.status === "running" && (
          <p className="mt-2 text-xs text-blue-900/75">
            Latest step: <span className="font-medium">{latestEvent.title}</span>
            {latestEvent.detail && (
              <span className="text-blue-800/60">
                {" "}
                —{" "}
                {latestEvent.detail.length > 120
                  ? `${latestEvent.detail.slice(0, 120)}…`
                  : latestEvent.detail}
              </span>
            )}
          </p>
        )}
      </div>

      {alerts.map((a, i) => (
        <div
          key={`${a.level}-${a.title}-${i}`}
          className={`rounded-md border px-3 py-2 text-sm ${
            a.level === "error"
              ? "border-red-200 bg-red-50 text-red-900"
              : a.level === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-950"
                : "border-zinc-200 bg-zinc-50 text-zinc-800"
          }`}
        >
          <p className="font-semibold">{a.title}</p>
          <p className="mt-0.5 text-xs opacity-90">{a.detail}</p>
        </div>
      ))}

      {latestIter?.diagnosis &&
        (job.status === "running" && job.currentPhase === "diagnose" ? (
          <div className="rounded-md border border-purple-200 bg-purple-50/50 px-3 py-2 text-sm">
            <p className="font-semibold text-purple-900">
              Previous diagnosis (iteration {latestIter.iteration_number})
            </p>
            <p className="mt-1 text-xs text-purple-950/85">
              {latestIter.diagnosis.length > 400
                ? `${latestIter.diagnosis.slice(0, 400)}…`
                : latestIter.diagnosis}
            </p>
          </div>
        ) : null)}
    </div>
  );
}

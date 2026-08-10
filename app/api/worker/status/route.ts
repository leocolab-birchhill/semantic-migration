import { NextResponse } from "next/server";
import { query, isDatabaseConfigured } from "@/lib/db/client";
import {
  HEARTBEAT_STALE_SECONDS,
  HEARTBEAT_WARN_SECONDS,
  secondsSince,
} from "@/lib/migration/job-activity";
import { apiError } from "@/lib/api-utils";

export async function GET() {
  try {
    if (!isDatabaseConfigured()) {
      return NextResponse.json({
        databaseOk: false,
        databaseError: "DATABASE_URL or Lakebase is not configured",
        workerLikelyUp: false,
        runningJobs: 0,
      });
    }

    let databaseOk = true;
    let databaseError: string | undefined;
    try {
      await query("SELECT 1");
    } catch (err) {
      databaseOk = false;
      databaseError =
        err instanceof Error ? err.message : "Database connection failed";
    }

    if (!databaseOk) {
      return NextResponse.json({
        databaseOk: false,
        databaseError,
        workerLikelyUp: false,
        runningJobs: 0,
        hint: "Restart npm run worker after fixing Lakebase/Postgres credentials. Jobs cannot save progress without database access.",
      });
    }

    const { rows } = await query<{
      id: string;
      current_phase: string;
      iteration_count: number;
      heartbeat_at: Date | null;
      updated_at: Date;
      error_message: string | null;
    }>(
      `SELECT id, current_phase, iteration_count, heartbeat_at, updated_at, error_message
       FROM migration_jobs
       WHERE status = 'running'
       ORDER BY updated_at DESC
       LIMIT 5`
    );

    const runningJobs = rows.length;
    const primary = rows[0];
    const heartbeatAt = primary?.heartbeat_at
      ? (primary.heartbeat_at as Date).toISOString()
      : null;
    const hbSec = secondsSince(heartbeatAt ?? primary?.updated_at?.toISOString());

    const workerLikelyUp =
      runningJobs === 0 ||
      (hbSec != null && hbSec < HEARTBEAT_WARN_SECONDS * 2);

    return NextResponse.json({
      databaseOk: true,
      workerLikelyUp,
      runningJobs,
      heartbeatWarnSeconds: HEARTBEAT_WARN_SECONDS,
      heartbeatStaleSeconds: HEARTBEAT_STALE_SECONDS,
      activeJob: primary
        ? {
            id: primary.id,
            phase: primary.current_phase,
            iterationCount: primary.iteration_count,
            heartbeatAt,
            updatedAt: (primary.updated_at as Date).toISOString(),
            secondsSinceHeartbeat: hbSec,
            heartbeatStale: hbSec != null && hbSec >= HEARTBEAT_STALE_SECONDS,
            heartbeatWarning: hbSec != null && hbSec >= HEARTBEAT_WARN_SECONDS,
            reclaimed: Boolean(
              primary.error_message?.includes("reclaimed after stale heartbeat") ||
                primary.error_message?.includes("worker heartbeat went stale")
            ),
          }
        : null,
      hint: !workerLikelyUp
        ? "Worker may be down or database auth is failing. Run npm run worker in a separate terminal."
        : runningJobs === 0
          ? "Worker is idle — no running jobs."
          : undefined,
    });
  } catch (err) {
    return apiError(err);
  }
}

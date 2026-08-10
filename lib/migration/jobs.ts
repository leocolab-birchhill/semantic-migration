import { v4 as uuidv4 } from "uuid";
import { query, withTransaction } from "@/lib/db/client";
import type {
  ConfirmedMigrationScope,
  CreateMigrationJobInput,
  IntermediateRepresentation,
  MigrationJobRecord,
  MigrationJobStatus,
  MigrationPhase,
  ParityReport,
  ProposedAsset,
} from "@/lib/migration/types";
import { validateMigrationSchemas } from "@/lib/migration/schema-guard";

function rowToJob(row: Record<string, unknown>): MigrationJobRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    userEmail: row.user_email as string | null,
    status: row.status as MigrationJobRecord["status"],
    lookerSourceType: row.looker_source_type as string,
    lookerModel: row.looker_model as string | null,
    lookerExplore: row.looker_explore as string | null,
    lookerDashboardId: row.looker_dashboard_id as string | null,
    lookerDashboardTitle: row.looker_dashboard_title as string | null,
    databricksHost: row.databricks_host as string,
    warehouseId: row.warehouse_id as string,
    catalog: row.catalog as string,
    sourceSchema: row.source_schema as string,
    sourceTable: row.source_table as string,
    devSchema: row.dev_schema as string,
    prodSchema: row.prod_schema as string | null,
    maxIterations: row.max_iterations as number,
    decimalScale: row.decimal_scale as number,
    timezone: row.timezone as string,
    currentPhase: row.current_phase as MigrationPhase,
    iterationCount: row.iteration_count as number,
    inventory: row.inventory as IntermediateRepresentation | null,
    parityReport: row.parity_report as ParityReport | null,
    migrationScope: (row.migration_scope as ConfirmedMigrationScope) ?? null,
    errorMessage: row.error_message as string | null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    heartbeatAt: row.heartbeat_at
      ? (row.heartbeat_at as Date).toISOString()
      : null,
    approvedAt: row.approved_at
      ? (row.approved_at as Date).toISOString()
      : null,
    publishedAt: row.published_at
      ? (row.published_at as Date).toISOString()
      : null,
  };
}

export async function createJob(
  input: CreateMigrationJobInput,
  userEmail?: string
): Promise<{ job: MigrationJobRecord; created: boolean }> {
  const email = userEmail ?? null;

  const schemaCheck = validateMigrationSchemas({
    sourceSchema: input.sourceSchema,
    devSchema: input.devSchema,
    prodSchema: input.prodSchema,
  });
  if (!schemaCheck.ok) {
    throw new Error(schemaCheck.errors.join("; "));
  }

  if (input.lookerSourceType === "table_scope") {
    const scope = input.migrationScope;
    if (!scope?.explores?.length) {
      throw new Error("table_scope jobs require at least one confirmed Explore");
    }
    // Tiles are optional — explores without dashboards/Looks can still migrate.
  }

  if (input.idempotencyKey && email) {
    const existing = await query(
      `SELECT * FROM migration_jobs
       WHERE user_email = $1 AND idempotency_key = $2
       ORDER BY created_at DESC LIMIT 1`,
      [email, input.idempotencyKey]
    );
    if (existing.rows.length) {
      return { job: rowToJob(existing.rows[0]), created: false };
    }
  }

  const id = uuidv4();
  try {
    const { rows } = await query(
      `INSERT INTO migration_jobs (
        id, user_email, looker_source_type, looker_model, looker_explore,
        looker_dashboard_id, databricks_host, warehouse_id, catalog,
        source_schema, source_table, dev_schema, prod_schema,
        max_iterations, decimal_scale, timezone, idempotency_key,
        migration_scope
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *`,
      [
        id,
        email,
        input.lookerSourceType,
        input.lookerModel ?? null,
        input.lookerExplore ?? null,
        input.lookerDashboardId ?? null,
        input.databricksHost,
        input.warehouseId,
        input.catalog,
        input.sourceSchema,
        input.sourceTable,
        input.devSchema,
        input.prodSchema ?? null,
        input.maxIterations ?? 5,
        input.decimalScale ?? 2,
        input.timezone ?? "UTC",
        input.idempotencyKey ?? null,
        input.migrationScope ? JSON.stringify(input.migrationScope) : null,
      ]
    );
    return { job: rowToJob(rows[0]), created: true };
  } catch (err) {
    // Race on unique idempotency index — return the winner
    if (input.idempotencyKey && email) {
      const existing = await query(
        `SELECT * FROM migration_jobs
         WHERE user_email = $1 AND idempotency_key = $2
         ORDER BY created_at DESC LIMIT 1`,
        [email, input.idempotencyKey]
      );
      if (existing.rows.length) {
        return { job: rowToJob(existing.rows[0]), created: false };
      }
    }
    throw err;
  }
}

export function jobToCreateInput(
  job: MigrationJobRecord,
  idempotencyKey?: string
): CreateMigrationJobInput {
  return {
    lookerSourceType: job.lookerSourceType as
      | "explore"
      | "dashboard"
      | "table_scope",
    lookerModel: job.lookerModel ?? undefined,
    lookerExplore: job.lookerExplore ?? undefined,
    lookerDashboardId: job.lookerDashboardId ?? undefined,
    databricksHost: job.databricksHost,
    warehouseId: job.warehouseId,
    catalog: job.catalog,
    sourceSchema: job.sourceSchema,
    sourceTable: job.sourceTable,
    devSchema: job.devSchema,
    prodSchema: job.prodSchema ?? undefined,
    maxIterations: job.maxIterations,
    decimalScale: job.decimalScale,
    timezone: job.timezone,
    migrationScope: job.migrationScope ?? undefined,
    idempotencyKey,
  };
}

export async function getJob(id: string): Promise<MigrationJobRecord | null> {
  const { rows } = await query("SELECT * FROM migration_jobs WHERE id = $1", [id]);
  return rows.length ? rowToJob(rows[0]) : null;
}

/** Columns for the recent-jobs list — omit bulky inventory / parity JSON. */
const JOB_LIST_COLUMNS = `
  id, tenant_id, user_email, status, looker_source_type, looker_model, looker_explore,
  looker_dashboard_id, looker_dashboard_title, databricks_host, warehouse_id, catalog,
  source_schema, source_table, dev_schema, prod_schema, max_iterations, decimal_scale,
  timezone, current_phase, iteration_count,
  NULL::jsonb AS inventory, NULL::jsonb AS parity_report, migration_scope,
  error_message, created_at, updated_at, heartbeat_at, approved_at, published_at
`;

export async function listJobs(
  userEmail?: string,
  limit = 20
): Promise<MigrationJobRecord[]> {
  const { rows } = userEmail
    ? await query(
        `SELECT ${JOB_LIST_COLUMNS} FROM migration_jobs WHERE user_email = $1 ORDER BY created_at DESC LIMIT $2`,
        [userEmail, limit]
      )
    : await query(
        `SELECT ${JOB_LIST_COLUMNS} FROM migration_jobs ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
  return rows.map(rowToJob);
}

export async function updateJobStatus(
  id: string,
  status: MigrationJobStatus,
  extra?: {
    currentPhase?: MigrationPhase;
    errorMessage?: string | null;
    inventory?: IntermediateRepresentation;
    parityReport?: ParityReport;
    iterationCount?: number;
    lookerDashboardTitle?: string;
    publishedAt?: boolean;
  }
): Promise<void> {
  const sets = ["status = $2", "updated_at = NOW()", "heartbeat_at = NOW()"];
  const params: unknown[] = [id, status];
  let idx = 3;

  if (extra?.currentPhase) {
    sets.push(`current_phase = $${idx++}`);
    params.push(extra.currentPhase);
  }
  if (extra?.errorMessage !== undefined) {
    sets.push(`error_message = $${idx++}`);
    params.push(extra.errorMessage);
  }
  if (extra?.inventory) {
    sets.push(`inventory = $${idx++}`);
    params.push(JSON.stringify(extra.inventory));
  }
  if (extra?.parityReport) {
    sets.push(`parity_report = $${idx++}`);
    params.push(JSON.stringify(extra.parityReport));
  }
  if (extra?.iterationCount !== undefined) {
    sets.push(`iteration_count = $${idx++}`);
    params.push(extra.iterationCount);
  }
  if (extra?.lookerDashboardTitle) {
    sets.push(`looker_dashboard_title = $${idx++}`);
    params.push(extra.lookerDashboardTitle);
  }
  if (extra?.publishedAt) {
    sets.push(`published_at = NOW()`);
  }

  await query(`UPDATE migration_jobs SET ${sets.join(", ")} WHERE id = $1`, params);
}

export async function touchJobHeartbeat(id: string): Promise<void> {
  await query(
    `UPDATE migration_jobs SET heartbeat_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id]
  );
}

/**
 * Abandon jobs stuck in running without a recent heartbeat (default 15 min).
 * Sets cancelled — does NOT re-queue — so restarting the worker won't revive
 * old runs and flood the UI.
 */
export async function reclaimStaleRunningJobs(
  staleMinutes = 15
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE migration_jobs
     SET status = 'cancelled',
         error_message = CASE
           WHEN COALESCE(error_message, '') LIKE '%Stopped: worker heartbeat went stale%'
             THEN error_message
           ELSE trim(both FROM COALESCE(error_message, '') ||
             ' Stopped: worker heartbeat went stale — not auto-restarted. Start a new migration or Rerun when ready.')
         END,
         updated_at = NOW(),
         heartbeat_at = NULL
     WHERE status = 'running'
       AND (
         heartbeat_at IS NULL AND updated_at < NOW() - ($1 || ' minutes')::interval
         OR heartbeat_at < NOW() - ($1 || ' minutes')::interval
       )`,
    [String(staleMinutes)]
  );
  return rowCount ?? 0;
}

/**
 * Cancel leftover pending jobs that were previously auto-requeued after a
 * stale heartbeat (legacy reclaim → pending). Safe no-op once those are gone.
 */
export async function abandonLegacyReclaimedPending(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE migration_jobs
     SET status = 'cancelled',
         error_message = CASE
           WHEN COALESCE(error_message, '') LIKE '%Stopped: worker heartbeat went stale%'
             THEN error_message
           ELSE trim(both FROM COALESCE(error_message, '') ||
             ' Stopped: worker heartbeat went stale — not auto-restarted. Start a new migration or Rerun when ready.')
         END,
         updated_at = NOW(),
         heartbeat_at = NULL
     WHERE status = 'pending'
       AND error_message ILIKE '%reclaimed after stale heartbeat%'`
  );
  return rowCount ?? 0;
}

export async function cancelJob(id: string): Promise<MigrationJobRecord | null> {
  const { rows } = await query(
    `UPDATE migration_jobs
     SET status = 'cancelled',
         error_message = CASE
           WHEN status = 'cancelled' THEN error_message
           ELSE trim(both FROM COALESCE(error_message, '') || ' Cancelled by user.')
         END,
         updated_at = NOW(),
         heartbeat_at = NULL
     WHERE id = $1
       AND status IN ('pending', 'running', 'needs_input')
     RETURNING *`,
    [id]
  );
  return rows.length ? rowToJob(rows[0]) : null;
}

export async function claimPendingJob(): Promise<MigrationJobRecord | null> {
  await reclaimStaleRunningJobs().catch(() => 0);
  await abandonLegacyReclaimedPending().catch(() => 0);

  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE migration_jobs
       SET status = 'running', updated_at = NOW(), heartbeat_at = NOW()
       WHERE id = (
         SELECT id FROM migration_jobs
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    );
    return result.rows.length ? rowToJob(result.rows[0]) : null;
  });
}

export async function saveIteration(
  jobId: string,
  iterationNumber: number,
  data: {
    phase: string;
    modelName?: string;
    diagnosis?: string;
    rationale?: string;
    testsRun: number;
    testsPassed: number;
    testsFailed: number;
    needsHumanInput?: boolean;
  }
): Promise<string> {
  const id = uuidv4();
  // On conflict, return the EXISTING row id — a fresh uuid is not inserted and
  // must not be used as migration_artifacts.iteration_id (FK).
  const result = await query<{ id: string }>(
    `INSERT INTO migration_iterations (
      id, job_id, iteration_number, phase, model_name, diagnosis, rationale,
      tests_run, tests_passed, tests_failed, needs_human_input
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (job_id, iteration_number) DO UPDATE SET
      phase = EXCLUDED.phase,
      diagnosis = EXCLUDED.diagnosis,
      rationale = EXCLUDED.rationale,
      tests_run = EXCLUDED.tests_run,
      tests_passed = EXCLUDED.tests_passed,
      tests_failed = EXCLUDED.tests_failed,
      needs_human_input = EXCLUDED.needs_human_input
    RETURNING id`,
    [
      id,
      jobId,
      iterationNumber,
      data.phase,
      data.modelName ?? "gpt-5.6",
      data.diagnosis ?? null,
      data.rationale ?? null,
      data.testsRun,
      data.testsPassed,
      data.testsFailed,
      data.needsHumanInput ?? false,
    ]
  );
  return result.rows[0]?.id ?? id;
}

export async function saveArtifact(
  jobId: string,
  artifactType: string,
  name: string,
  content: string,
  iterationId?: string
): Promise<void> {
  await query(
    `INSERT INTO migration_artifacts (id, job_id, iteration_id, artifact_type, name, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv4(), jobId, iterationId ?? null, artifactType, name, content]
  );
}

/** Replace deployable sql/yaml artifacts with the final successful snapshot. */
export async function saveFinalAssetSnapshot(
  jobId: string,
  assets: ProposedAsset[],
  iterationId?: string
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM migration_artifacts
       WHERE job_id = $1 AND artifact_type IN ('sql', 'yaml', 'asset_snapshot')`,
      [jobId]
    );

    for (const asset of assets) {
      if (asset.type === "sql_view") {
        if (!asset.sql?.trim()) {
          throw new Error(
            `Cannot snapshot sql_view ${asset.name}: missing sql`
          );
        }
        await client.query(
          `INSERT INTO migration_artifacts (id, job_id, iteration_id, artifact_type, name, content)
           VALUES ($1, $2, $3, 'sql', $4, $5)`,
          [uuidv4(), jobId, iterationId ?? null, asset.name, asset.sql]
        );
      } else if (asset.type === "metric_view") {
        if (!asset.yaml?.trim()) {
          throw new Error(
            `Cannot snapshot metric_view ${asset.name}: missing yaml`
          );
        }
        await client.query(
          `INSERT INTO migration_artifacts (id, job_id, iteration_id, artifact_type, name, content)
           VALUES ($1, $2, $3, 'yaml', $4, $5)`,
          [uuidv4(), jobId, iterationId ?? null, asset.name, asset.yaml]
        );
      }
    }

    await client.query(
      `INSERT INTO migration_artifacts (id, job_id, iteration_id, artifact_type, name, content)
       VALUES ($1, $2, $3, 'asset_snapshot', 'final', $4)`,
      [
        uuidv4(),
        jobId,
        iterationId ?? null,
        JSON.stringify({
          assets,
          savedAt: new Date().toISOString(),
        }),
      ]
    );
  });
}

export interface ArtifactRow {
  artifact_type: string;
  name: string;
  content: string;
  created_at?: Date;
}

/** Latest non-empty sql/yaml artifact per name, optionally restricted to parity objects. */
export async function getLatestDeployableArtifacts(
  jobId: string,
  allowedNames?: Set<string>
): Promise<ArtifactRow[]> {
  const { rows } = await query(
    `SELECT DISTINCT ON (artifact_type, name)
       artifact_type, name, content, created_at
     FROM migration_artifacts
     WHERE job_id = $1
       AND artifact_type IN ('sql', 'yaml')
       AND TRIM(content) <> ''
     ORDER BY artifact_type, name, created_at DESC`,
    [jobId]
  );

  const artifacts = rows as ArtifactRow[];
  if (!allowedNames || allowedNames.size === 0) return artifacts;
  return artifacts.filter((a) => allowedNames.has(a.name));
}

export async function getFinalAssetSnapshot(
  jobId: string
): Promise<ProposedAsset[] | null> {
  const { rows } = await query(
    `SELECT content FROM migration_artifacts
     WHERE job_id = $1 AND artifact_type = 'asset_snapshot' AND name = 'final'
     ORDER BY created_at DESC LIMIT 1`,
    [jobId]
  );
  if (!rows.length) return null;
  try {
    const parsed = JSON.parse(rows[0].content as string) as {
      assets?: ProposedAsset[];
    };
    return parsed.assets ?? null;
  } catch {
    return null;
  }
}

export async function saveTestResult(
  jobId: string,
  data: {
    testName: string;
    testType: string;
    lookerQuery?: Record<string, unknown>;
    lookerSql?: string;
    lookerResult?: unknown;
    databricksSql?: string;
    databricksResult?: unknown;
    status: string;
    diffSummary?: string;
    iterationId?: string;
  }
): Promise<void> {
  await query(
    `INSERT INTO migration_tests (
      id, job_id, iteration_id, test_name, test_type,
      looker_query, looker_sql, looker_result,
      databricks_sql, databricks_result, status, diff_summary
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      uuidv4(),
      jobId,
      data.iterationId ?? null,
      data.testName,
      data.testType,
      data.lookerQuery ? JSON.stringify(data.lookerQuery) : null,
      data.lookerSql ?? null,
      data.lookerResult ? JSON.stringify(data.lookerResult) : null,
      data.databricksSql ?? null,
      data.databricksResult ? JSON.stringify(data.databricksResult) : null,
      data.status,
      data.diffSummary ?? null,
    ]
  );
}

export async function approveJob(id: string): Promise<void> {
  await query(
    `UPDATE migration_jobs SET status = 'approved', approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id]
  );
}

export async function getJobIterations(jobId: string) {
  const { rows } = await query(
    "SELECT * FROM migration_iterations WHERE job_id = $1 ORDER BY iteration_number",
    [jobId]
  );
  return rows;
}

export async function getJobTests(jobId: string, opts?: { lite?: boolean }) {
  if (opts?.lite) {
    const { rows } = await query(
      `SELECT id, job_id, iteration_id, test_name, status, diff_summary,
              databricks_sql, created_at
       FROM migration_tests WHERE job_id = $1 ORDER BY created_at`,
      [jobId]
    );
    return rows;
  }
  const { rows } = await query(
    "SELECT * FROM migration_tests WHERE job_id = $1 ORDER BY created_at",
    [jobId]
  );
  return rows;
}

export async function getJobArtifacts(jobId: string, opts?: { lite?: boolean }) {
  if (opts?.lite) {
    const { rows } = await query(
      `SELECT id, job_id, iteration_id, artifact_type, name, created_at
       FROM migration_artifacts WHERE job_id = $1 ORDER BY created_at`,
      [jobId]
    );
    return rows;
  }
  const { rows } = await query(
    "SELECT * FROM migration_artifacts WHERE job_id = $1 ORDER BY created_at",
    [jobId]
  );
  return rows;
}

export type { ProposedAsset };

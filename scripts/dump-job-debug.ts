/**
 * Dump recent migration jobs + test failures for debugging.
 * Usage: npx tsx scripts/dump-job-debug.ts [jobId]
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import { query } from "../lib/db/client";

async function main() {
  const jobIdArg = process.argv[2];

  const { rows: jobs } = await query<{
    id: string;
    status: string;
    current_phase: string | null;
    source_table: string | null;
    catalog: string | null;
    source_schema: string | null;
    dev_schema: string | null;
    prod_schema: string | null;
    error_message: string | null;
    iteration_count: number | null;
    max_iterations: number | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, status, current_phase, source_table, catalog, source_schema,
            dev_schema, prod_schema, error_message, iteration_count, max_iterations,
            created_at::text, updated_at::text
     FROM migration_jobs
     ORDER BY created_at DESC
     LIMIT 10`
  );

  console.log("=== Recent jobs ===");
  for (const j of jobs) {
    console.log(
      JSON.stringify(
        {
          id: j.id,
          status: j.status,
          phase: j.current_phase,
          table: `${j.catalog}.${j.source_schema}.${j.source_table}`,
          dev: j.dev_schema,
          prod: j.prod_schema,
          iter: `${j.iteration_count}/${j.max_iterations}`,
          error: j.error_message?.slice(0, 300),
          updated: j.updated_at,
        },
        null,
        2
      )
    );
  }

  const targetId =
    jobIdArg ||
    jobs.find((j) => j.status === "needs_input")?.id ||
    jobs.find((j) => j.source_table?.includes("tam_buildings"))?.id ||
    jobs[0]?.id;

  if (!targetId) {
    console.log("No jobs found");
    return;
  }

  console.log("\n=== Dumping job", targetId, "===\n");

  const { rows: fullJobs } = await query<{
    id: string;
    status: string;
    current_phase: string | null;
    error_message: string | null;
    inventory: unknown;
    parity_report: unknown;
    migration_scope: unknown;
  }>("SELECT id, status, current_phase, error_message, inventory, parity_report, migration_scope FROM migration_jobs WHERE id = $1", [
    targetId,
  ]);

  const job = fullJobs[0];
  if (!job) {
    console.log("Job not found");
    return;
  }

  const outDir = path.resolve(process.cwd(), "tmp-debug");
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(
    path.join(outDir, "job.json"),
    JSON.stringify(
      {
        id: job.id,
        status: job.status,
        phase: job.current_phase,
        error_message: job.error_message,
        migration_scope: job.migration_scope,
        inventory_summary: summarizeInventory(job.inventory),
        parity_report: job.parity_report,
      },
      null,
      2
    )
  );

  const { rows: tests } = await query<{
    id: string;
    test_name: string;
    status: string;
    looker_sql: string | null;
    databricks_sql: string | null;
    looker_result: unknown;
    databricks_result: unknown;
    diff_summary: string | null;
    iteration_id: string | null;
  }>(
    `SELECT id, test_name, status, looker_sql, databricks_sql, looker_result,
            databricks_result, diff_summary, iteration_id
     FROM migration_tests
     WHERE job_id = $1
     ORDER BY created_at DESC`,
    [targetId]
  );

  fs.writeFileSync(path.join(outDir, "tests.json"), JSON.stringify(tests, null, 2));

  console.log(`Tests: ${tests.length}`);
  for (const t of tests) {
    console.log(
      `- [${t.status}] ${t.test_name}\n  diff: ${(t.diff_summary ?? "").slice(0, 500)}\n  db_sql: ${(t.databricks_sql ?? "").slice(0, 400)}`
    );
  }

  const { rows: arts } = await query<{
    id: string;
    artifact_type: string;
    name: string | null;
    content: string | null;
    version: number | null;
    iteration_id: string | null;
  }>(
    `SELECT id, artifact_type, name, content, version, iteration_id
     FROM migration_artifacts
     WHERE job_id = $1
     ORDER BY created_at DESC`,
    [targetId]
  );

  const artSummary = arts.map((a) => ({
    id: a.id,
    type: a.artifact_type,
    name: a.name,
    version: a.version,
    iteration_id: a.iteration_id,
    contentLen: a.content?.length ?? 0,
    contentPreview: a.content?.slice(0, 500),
  }));
  fs.writeFileSync(path.join(outDir, "artifacts-summary.json"), JSON.stringify(artSummary, null, 2));

  for (const a of arts) {
    const safe = (a.name ?? a.artifact_type ?? a.id).replace(/[^\w.-]+/g, "_");
    if (a.content) {
      fs.writeFileSync(
        path.join(outDir, `artifact_${a.artifact_type}_${safe}_v${a.version ?? "x"}.txt`),
        a.content
      );
    }
  }

  const { rows: iters } = await query<{
    iteration_number: number;
    phase: string | null;
    diagnosis: string | null;
    rationale: string | null;
    needs_human_input: boolean | null;
    tests_passed: number | null;
    tests_failed: number | null;
  }>(
    `SELECT iteration_number, phase, diagnosis, rationale, needs_human_input, tests_passed, tests_failed
     FROM migration_iterations
     WHERE job_id = $1
     ORDER BY iteration_number DESC`,
    [targetId]
  );
  fs.writeFileSync(path.join(outDir, "iterations.json"), JSON.stringify(iters, null, 2));

  console.log(`\nArtifacts: ${arts.length}`);
  console.log(`Iterations: ${iters.length}`);
  for (const it of iters) {
    console.log(
      `- iter ${it.iteration_number} phase=${it.phase} needs_input=${it.needs_human_input} pass=${it.tests_passed} fail=${it.tests_failed}`
    );
    if (it.rationale) console.log(`  rationale: ${it.rationale.slice(0, 500)}`);
    if (it.diagnosis) {
      console.log(`  diagnosis: ${it.diagnosis.slice(0, 800)}`);
      try {
        const d = JSON.parse(it.diagnosis) as Record<string, unknown>;
        console.log(
          `  parsed needsHumanInput=${d.needsHumanInput} reason=${String(d.humanInputReason ?? "").slice(0, 500)} patches=${Array.isArray(d.patches) ? d.patches.length : 0}`
        );
      } catch {
        /* diagnosis may be plain text */
      }
    }
  }

  console.log(`\nWrote debug files to ${outDir}`);
}

function summarizeInventory(inv: unknown) {
  if (!inv || typeof inv !== "object") return inv;
  const i = inv as Record<string, unknown>;
  const dims = Array.isArray(i.dimensions) ? i.dimensions : [];
  const measures = Array.isArray(i.measures) ? i.measures : [];
  return {
    keys: Object.keys(i),
    dimensionCount: dims.length,
    measureCount: measures.length,
    measureNames: measures
      .slice(0, 80)
      .map((m: { name?: string; lookerName?: string }) => m.name ?? m.lookerName),
    dimensionNames: dims
      .slice(0, 80)
      .map((d: { name?: string; lookerName?: string }) => d.name ?? d.lookerName),
  };
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});

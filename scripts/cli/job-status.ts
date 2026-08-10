#!/usr/bin/env npx tsx
/**
 * Compact job status for headless runs.
 *
 *   npm run cli:job                         # list recent jobs
 *   npm run cli:job -- <jobId>              # one job: status, phase, failures
 *   npm run cli:job -- <jobId> --watch      # poll until terminal status
 *   npm run cli:job -- <jobId> --rerun      # clone into a fresh job (new code picks it up)
 *
 * For full artifact/test dumps use: npx tsx scripts/dump-job-debug.ts <jobId>
 */
import dotenv from "dotenv";
import path from "path";
import { randomUUID } from "crypto";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const TERMINAL_STATUSES = new Set([
  "awaiting_approval",
  "approved",
  "published",
  "failed",
  "cancelled",
  "needs_input",
]);

function fmtJob(job: {
  id: string;
  status: string;
  currentPhase: string | null;
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  iterationCount: number;
  maxIterations: number;
  errorMessage: string | null;
  updatedAt: string;
}): string {
  const parts = [
    `${job.id}`,
    `${job.status}${job.currentPhase ? `/${job.currentPhase}` : ""}`,
    `${job.catalog}.${job.sourceSchema}.${job.sourceTable}`,
    `iter ${job.iterationCount}/${job.maxIterations}`,
    `updated ${job.updatedAt}`,
  ];
  if (job.errorMessage) parts.push(`error: ${job.errorMessage.slice(0, 160)}`);
  return parts.join("  |  ");
}

async function printFailures(jobId: string) {
  const { getJobTests } = await import("../../lib/migration/jobs");
  const tests = (await getJobTests(jobId, { lite: true })) as Array<{
    test_name: string;
    status: string;
    diff_summary: unknown;
  }>;
  const failed = tests.filter((t) => t.status === "failed");
  const passed = tests.filter((t) => t.status === "passed").length;
  console.log(`\ntests: ${passed} passed, ${failed.length} failed (of ${tests.length})`);
  for (const t of failed.slice(0, 20)) {
    const diff =
      typeof t.diff_summary === "string"
        ? t.diff_summary
        : JSON.stringify(t.diff_summary);
    console.log(`  FAIL ${t.test_name} — ${(diff ?? "").slice(0, 200)}`);
  }
  if (failed.length > 20) console.log(`  … and ${failed.length - 20} more`);
}

async function main() {
  const args = process.argv.slice(2);
  const jobId = args.find((a) => !a.startsWith("--"));
  const watch = args.includes("--watch");
  const rerun = args.includes("--rerun");

  const { getJob, listJobs, createJob, jobToCreateInput } = await import(
    "../../lib/migration/jobs"
  );

  if (!jobId) {
    const jobs = await listJobs(undefined, 15);
    if (!jobs.length) {
      console.log("No jobs found.");
      return;
    }
    console.log("=== Recent jobs ===");
    for (const j of jobs) console.log(fmtJob(j));
    return;
  }

  const job = await getJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }

  if (rerun) {
    const { job: clone, created } = await createJob(
      jobToCreateInput(job, `rerun:${jobId}:${randomUUID()}`),
      process.env.MIGRATION_USER_EMAIL ?? job.userEmail ?? undefined
    );
    console.log(
      `[rerun] ${created ? "Created" : "Reused"} job ${clone.id} (clone of ${jobId})`
    );
    console.log(`Watch it: npm run cli:job -- ${clone.id} --watch`);
    return;
  }

  console.log(fmtJob(job));
  if (TERMINAL_STATUSES.has(job.status)) {
    await printFailures(jobId);
    if (job.status === "awaiting_approval") {
      console.log(`\nReview + approve: npm run cli:approve -- ${jobId}`);
    }
    return;
  }

  if (!watch) {
    await printFailures(jobId);
    return;
  }

  console.log("[watch] Polling every 10s until the job reaches a terminal status… (Ctrl+C to stop)");
  let lastLine = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 10_000));
    const current = await getJob(jobId);
    if (!current) {
      console.error("[watch] Job disappeared");
      process.exit(1);
    }
    const line = fmtJob(current);
    if (line !== lastLine) {
      console.log(line);
      lastLine = line;
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      await printFailures(jobId);
      if (current.status === "awaiting_approval") {
        console.log(`\nReview + approve: npm run cli:approve -- ${jobId}`);
      }
      if (current.status === "needs_input") {
        console.log("\nJob paused for human input — inspect with: npx tsx scripts/dump-job-debug.ts " + jobId);
      }
      return;
    }
  }
}

main()
  .then(() => {
    // pg pool keeps the event loop alive ~30s otherwise.
    process.exit(0);
  })
  .catch((err) => {
    console.error("[job-status] Fatal:", err);
    process.exit(1);
  });

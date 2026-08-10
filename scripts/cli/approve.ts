#!/usr/bin/env npx tsx
/**
 * Review and approve/publish a migration job from the terminal.
 *
 *   npm run cli:approve -- <jobId>                       # print parity report only
 *   npm run cli:approve -- <jobId> --confirm             # approve (awaiting_approval -> approved)
 *   npm run cli:approve -- <jobId> --publish --confirm   # publish (approved -> published, writes prod schema)
 *
 * Both state changes require the explicit --confirm flag. Publication writes
 * to the job's prod schema (never dbt_production) and is a human decision.
 */
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const args = process.argv.slice(2);
  const jobId = args.find((a) => !a.startsWith("--"));
  const confirm = args.includes("--confirm");
  const publish = args.includes("--publish");

  if (!jobId) {
    console.error("Usage: npm run cli:approve -- <jobId> [--publish] [--confirm]");
    process.exit(1);
  }

  const { getJob, approveJob } = await import("../../lib/migration/jobs");
  const job = await getJob(jobId);
  if (!job) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }

  console.log(`Job ${job.id}`);
  console.log(`  status: ${job.status}  table: ${job.catalog}.${job.sourceSchema}.${job.sourceTable}`);
  console.log(`  dev schema: ${job.devSchema}  prod schema: ${job.prodSchema ?? "(none)"}`);

  const report = job.parityReport;
  if (report) {
    console.log("\n=== Parity report ===");
    console.log(`  tests: ${report.testsPassed} passed, ${report.testsFailed} failed${report.testsInconclusive ? `, ${report.testsInconclusive} inconclusive` : ""}`);
    if (report.mandatoryBenchmarkCount != null) {
      console.log(`  mandatory benchmarks: ${report.mandatoryBenchmarksPassed ?? 0}/${report.mandatoryBenchmarkCount} passed`);
    }
    console.log(`  objects: ${report.objectsCreated.map((o) => `${o.type} ${o.schema}.${o.name}`).join(", ") || "(none)"}`);
    if (report.intentionalDifferences.length) {
      console.log("  intentional differences:");
      for (const d of report.intentionalDifferences) console.log(`    - ${d}`);
    }
    if (report.unsupportedLookerFeatures.length) {
      console.log("  unsupported Looker features:");
      for (const u of report.unsupportedLookerFeatures) console.log(`    - ${u}`);
    }
    if (report.approvalBlockedReason) {
      console.log(`  APPROVAL BLOCKED: ${report.approvalBlockedReason}`);
    }
  } else {
    console.log("\n(no parity report on this job yet)");
  }

  if (publish) {
    if (job.status !== "approved") {
      console.error(`\nCannot publish: job status is "${job.status}" (must be "approved").`);
      process.exit(1);
    }
    if (!confirm) {
      console.log(`\nDry run. Publication writes metric views to ${job.prodSchema ?? "(prod schema)"}.`);
      console.log(`To publish for real: npm run cli:approve -- ${jobId} --publish --confirm`);
      return;
    }
    const { publishApprovedJob } = await import("../../lib/migration/worker");
    await publishApprovedJob(jobId);
    console.log(`\nPublished job ${jobId} to ${job.prodSchema}.`);
    return;
  }

  if (job.status !== "awaiting_approval") {
    console.error(`\nCannot approve: job status is "${job.status}" (must be "awaiting_approval").`);
    process.exit(1);
  }
  if (report?.approvalBlockedReason) {
    console.error(`\nCannot approve: ${report.approvalBlockedReason}`);
    process.exit(1);
  }
  if (!confirm) {
    console.log(`\nDry run. To approve: npm run cli:approve -- ${jobId} --confirm`);
    return;
  }

  await approveJob(jobId);
  console.log(`\nApproved job ${jobId}.`);
  console.log(`Publish when ready: npm run cli:approve -- ${jobId} --publish --confirm`);
}

main()
  .then(() => {
    // pg pool keeps the event loop alive ~30s otherwise.
    process.exit(0);
  })
  .catch((err) => {
    console.error("[approve] Fatal:", err);
    process.exit(1);
  });

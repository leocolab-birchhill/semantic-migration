#!/usr/bin/env npx tsx
/**
 * Run Looker↔Databricks parity for a migrations/<table> draft.
 * Writes harness/last-run.json for the local Cursor fix loop.
 *
 *   npm run cli:parity -- <catalog.schema.table>
 *   npm run cli:parity -- --job <jobId>
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const jobIdArg = argValue(args, "--job");
  const tableKeyArg = args.find((a) => !a.startsWith("--") && a.includes("."));

  const {
    migrationDir,
    readDraftAssets,
    readParityConfig,
  } = await import("../../lib/migration/repo-artifacts");
  const { getJob } = await import("../../lib/migration/jobs");
  const { buildTestCases } = await import("../../lib/migration/test-cases");
  const { runParityTests, deployAssetsToDev } = await import(
    "../../lib/migration/worker"
  );
  const { emptyOverrides } = await import(
    "../../lib/migration/reconciliation-overrides"
  );
  const { sanitizeGeneratedAssets } = await import(
    "../../lib/migration/deploy-normalize"
  );

  let tableKey = tableKeyArg;
  let job = jobIdArg ? await getJob(jobIdArg) : null;

  if (!tableKey && job) {
    tableKey = `${job.catalog}.${job.sourceSchema}.${job.sourceTable}`;
  }
  if (!tableKey) {
    console.error(
      "Usage: npm run cli:parity -- <catalog.schema.table> | --job <jobId>"
    );
    process.exit(1);
  }

  const cfg = readParityConfig(tableKey);
  if (!job && cfg.jobId) {
    job = await getJob(cfg.jobId);
  }
  if (!job || job.id.startsWith("cli-parity-")) {
    // runParityTests persists rows to migration_tests — needs a real job FK.
    console.error(
      "[parity] A real migration job id is required (FK to migration_jobs).\n" +
        "  npm run cli:parity -- --job <jobId>\n" +
        "  or ensure harness/parity.config.json has jobId from the worker / cli:draft --job"
    );
    process.exit(1);
  }

  const invPath = path.join(migrationDir(tableKey), "inventory.json");
  if (!fs.existsSync(invPath)) {
    console.error(`Missing inventory.json under migrations/${tableKey}`);
    process.exit(1);
  }
  const inventory = JSON.parse(fs.readFileSync(invPath, "utf8"));
  let assets = readDraftAssets(tableKey);
  assets = sanitizeGeneratedAssets(
    assets,
    cfg.catalog,
    cfg.devSchema,
    inventory
  );

  const fieldMapping = inventory.fieldMapping ?? {
    version: "1.0",
    entries: [],
    updatedAt: new Date().toISOString(),
  };

  const testCases = buildTestCases(inventory, {
    benchmarks: inventory.benchmarks,
  });

  // Ensure deployed assets match current draft (idempotent CREATE OR REPLACE).
  if (!args.includes("--skip-deploy")) {
    console.log(`[parity] Redeploying draft to ${cfg.catalog}.${cfg.devSchema}…`);
    await deployAssetsToDev(job, assets, inventory);
  }

  console.log(`[parity] Running ${testCases.length} test case(s)…`);
  const { saveIteration } = await import("../../lib/migration/jobs");
  const iterationId = await saveIteration(job.id, (job.iterationCount ?? 0) + 1, {
    phase: "test",
    rationale: "cli:parity local Cursor fix loop",
    testsRun: testCases.length,
    testsPassed: 0,
    testsFailed: 0,
  });
  let results;
  try {
    results = await runParityTests({
      job,
      inventory,
      assets,
      testCases,
      iterationId,
      fieldMapping,
      overrides: emptyOverrides(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/foreign key|migration_tests|migration_jobs/i.test(message)) {
      console.error(
        "[parity] DB persistence failed. Ensure the job id exists in migration_jobs."
      );
    }
    throw err;
  }

  const lastRun = {
    ranAt: new Date().toISOString(),
    tableKey,
    jobId: job.id,
    summary: {
      passed: results.passed,
      failed: results.failed,
      inconclusive: results.inconclusive,
      mandatoryPassed: results.mandatoryPassed,
      mandatoryFailed: results.mandatoryFailed,
      compileErrors: results.compileErrors,
      sqlErrors: results.sqlErrors,
    },
    compilationFailures: results.compilationFailures,
    failures: [...results.failureEvidenceByTest.entries()].map(
      ([name, evidence]) => ({
        name,
        status: evidence.status,
        summary: evidence.summary,
        columnDiffs: evidence.columnDiffs?.slice?.(0, 20) ?? evidence.columnDiffs,
        databricksSql: evidence.databricksSql?.slice?.(0, 4000),
      })
    ),
    nextSteps:
      results.mandatoryFailed > 0 || results.failed > 0
        ? [
            "Read cases/README.md and migrations/<table>/edge-cases/",
            "Patch draft/sql_view.sql and/or draft/metric_view.yaml",
            `npm run cli:deploy -- ${tableKey}`,
            `npm run cli:parity -- ${tableKey}`,
            "Append an edge-case note when fixed",
          ]
        : ["All mandatory checks passed — npm run cli:approve -- <jobId> --confirm"],
  };

  const outPath = path.join(migrationDir(tableKey), "harness", "last-run.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(lastRun, null, 2));

  console.log(
    `[parity] ${results.passed} pass, ${results.failed} fail, ${results.inconclusive} inconclusive; mandatory ${results.mandatoryPassed}/${results.mandatoryPassed + results.mandatoryFailed}`
  );
  console.log(`[parity] Wrote ${outPath}`);
  if (results.failed > 0 || results.mandatoryFailed > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[parity] Fatal:", err);
    process.exit(1);
  });

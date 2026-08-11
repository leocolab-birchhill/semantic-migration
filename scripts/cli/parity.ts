#!/usr/bin/env npx tsx
/**
 * Run Looker↔Databricks parity for migrations/<table>/draft.
 * Writes harness/last-run.json (filesystem-only — no job DB).
 *
 *   npm run cli:parity -- <catalog.schema.table>
 *   npm run cli:parity -- <catalog.schema.table> --skip-deploy
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const args = process.argv.slice(2);
  const tableKey = args.find((a) => !a.startsWith("--") && a.includes("."));
  if (!tableKey) {
    console.error(
      "Usage: npm run cli:parity -- <catalog.schema.table> [--skip-deploy]"
    );
    process.exit(1);
  }

  const { migrationDir, readDraftAssets, readParityConfig } = await import(
    "../../lib/migration/repo-artifacts"
  );
  const { localJobFromTable, readInventory } = await import(
    "../../lib/migration/local-context"
  );
  const { deployAssetsToDev, runParityTests } = await import(
    "../../lib/migration/worker"
  );
  const { buildTestCases } = await import("../../lib/migration/test-cases");
  const { emptyOverrides } = await import(
    "../../lib/migration/reconciliation-overrides"
  );
  const { sanitizeGeneratedAssets } = await import(
    "../../lib/migration/deploy-normalize"
  );

  const cfg = readParityConfig(tableKey);
  const inventory = readInventory(tableKey);
  const job = localJobFromTable(tableKey, { inventory });

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

  if (!args.includes("--skip-deploy")) {
    console.log(
      `[parity] Redeploying draft to ${cfg.catalog}.${cfg.devSchema}…`
    );
    await deployAssetsToDev(job, assets, inventory);
  }

  console.log(`[parity] Running ${testCases.length} test case(s)…`);
  const results = await runParityTests({
    job,
    inventory,
    assets,
    testCases,
    fieldMapping,
    overrides: emptyOverrides(),
    persistResults: false,
  });

  const lastRun = {
    ranAt: new Date().toISOString(),
    tableKey,
    status:
      results.mandatoryFailed > 0 || results.failed > 0
        ? "needs_fix"
        : "ready_to_publish",
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
        : [
            "All mandatory checks passed",
            `npm run cli:publish -- ${tableKey} --confirm`,
          ],
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

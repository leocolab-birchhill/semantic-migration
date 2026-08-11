#!/usr/bin/env npx tsx
/**
 * Publish migrations/<table>/draft to the prod schema after parity passes.
 * Requires harness/last-run.json status === ready_to_publish (unless --force).
 *
 *   npm run cli:publish -- <catalog.schema.table> --confirm
 *   npm run cli:publish -- <catalog.schema.table> --confirm --force
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const args = process.argv.slice(2);
  const tableKey = args.find((a) => !a.startsWith("--") && a.includes("."));
  const confirm = args.includes("--confirm");
  const force = args.includes("--force");

  if (!tableKey || !confirm) {
    console.error(
      "Usage: npm run cli:publish -- <catalog.schema.table> --confirm [--force]"
    );
    process.exit(1);
  }

  const { migrationDir, readDraftAssets, readParityConfig } = await import(
    "../../lib/migration/repo-artifacts"
  );
  const { localJobFromTable, readInventory } = await import(
    "../../lib/migration/local-context"
  );
  const { publishAssetsToProd } = await import("../../lib/migration/worker");
  const { sanitizeGeneratedAssets } = await import(
    "../../lib/migration/deploy-normalize"
  );

  const lastRunPath = path.join(
    migrationDir(tableKey),
    "harness",
    "last-run.json"
  );
  if (!fs.existsSync(lastRunPath)) {
    console.error(
      `[publish] Missing ${lastRunPath}. Run: npm run cli:parity -- ${tableKey}`
    );
    process.exit(1);
  }
  const lastRun = JSON.parse(fs.readFileSync(lastRunPath, "utf8")) as {
    status?: string;
    summary?: { mandatoryFailed?: number; failed?: number };
  };
  const ok =
    lastRun.status === "ready_to_publish" ||
    (lastRun.summary?.mandatoryFailed === 0 &&
      (lastRun.summary?.failed ?? 0) === 0);
  if (!ok && !force) {
    console.error(
      `[publish] Parity not green (status=${lastRun.status ?? "unknown"}). Fix + re-run parity, or pass --force.`
    );
    process.exit(1);
  }

  const cfg = readParityConfig(tableKey);
  const inventory = readInventory(tableKey);
  const job = localJobFromTable(tableKey, { inventory });
  let assets = readDraftAssets(tableKey);
  assets = sanitizeGeneratedAssets(
    assets,
    cfg.catalog,
    job.prodSchema ?? cfg.devSchema,
    inventory
  );

  console.log(
    `[publish] Publishing ${assets.length} asset(s) to ${cfg.catalog}.${job.prodSchema}…`
  );
  const published = await publishAssetsToProd(job, assets);
  for (const p of published) {
    console.log(`  OK ${p.type} ${p.fqn}`);
  }

  const stamp = {
    ...lastRun,
    status: "published",
    publishedAt: new Date().toISOString(),
    publishedTo: published.map((p) => p.fqn),
  };
  fs.writeFileSync(lastRunPath, JSON.stringify(stamp, null, 2));
  console.log(`[publish] Done. Updated ${lastRunPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[publish] Fatal:", err);
    process.exit(1);
  });

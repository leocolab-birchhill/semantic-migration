#!/usr/bin/env npx tsx
/**
 * Deploy migrations/<table>/draft assets to the Databricks dev schema.
 *
 *   npm run cli:deploy -- <catalog.schema.table>
 */
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const args = process.argv.slice(2);
  const tableKey = args.find((a) => !a.startsWith("--") && a.includes("."));
  if (!tableKey) {
    console.error("Usage: npm run cli:deploy -- <catalog.schema.table>");
    process.exit(1);
  }

  const { readDraftAssets, readParityConfig } = await import(
    "../../lib/migration/repo-artifacts"
  );
  const { localJobFromTable, readInventory } = await import(
    "../../lib/migration/local-context"
  );
  const { deployAssetsToDev } = await import("../../lib/migration/worker");
  const { sanitizeGeneratedAssets } = await import(
    "../../lib/migration/deploy-normalize"
  );

  const cfg = readParityConfig(tableKey);
  const inventory = readInventory(tableKey);
  const job = localJobFromTable(tableKey, { inventory });

  let assets = readDraftAssets(tableKey);
  assets = sanitizeGeneratedAssets(assets, cfg.catalog, cfg.devSchema, inventory);

  console.log(
    `[deploy] Deploying ${assets.length} asset(s) to ${cfg.catalog}.${cfg.devSchema}…`
  );
  const deployed = await deployAssetsToDev(job, assets, inventory);
  for (const d of deployed) {
    console.log(`  OK ${d.type} ${d.fqn}`);
  }
  console.log(`[deploy] Done. Next: npm run cli:parity -- ${tableKey}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[deploy] Fatal:", err);
    process.exit(1);
  });

#!/usr/bin/env npx tsx
/**
 * Deploy migrations/<table>/draft assets to the job's Databricks dev schema.
 *
 *   npm run cli:deploy -- <catalog.schema.table>
 *   npm run cli:deploy -- --job <jobId>
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
  const jobId = argValue(args, "--job");
  const tableKey = args.find((a) => !a.startsWith("--") && a.includes("."));

  const {
    migrationDir,
    readDraftAssets,
    readParityConfig,
    writeMigrationArtifacts,
  } = await import("../../lib/migration/repo-artifacts");
  const { deployAssetsToDev } = await import("../../lib/migration/worker");
  const { getJob } = await import("../../lib/migration/jobs");
  const { sanitizeGeneratedAssets } = await import(
    "../../lib/migration/deploy-normalize"
  );

  let catalog: string;
  let sourceSchema: string;
  let sourceTable: string;
  let devSchema: string;
  let warehouseId: string;
  let databricksHost: string;
  let inventory;
  let jobRecord;

  if (jobId) {
    jobRecord = await getJob(jobId);
    if (!jobRecord) {
      console.error(`Job not found: ${jobId}`);
      process.exit(1);
    }
    catalog = jobRecord.catalog;
    sourceSchema = jobRecord.sourceSchema;
    sourceTable = jobRecord.sourceTable;
    devSchema = jobRecord.devSchema;
    warehouseId = jobRecord.warehouseId;
    databricksHost = jobRecord.databricksHost;
    inventory = jobRecord.inventory;
    const key = `${catalog}.${sourceSchema}.${sourceTable}`;
    const draftDir = path.join(migrationDir(key), "draft");
    if (!fs.existsSync(draftDir) && inventory) {
      // Bootstrap from job if draft folder missing
      const assets = await import("../../lib/migration/jobs").then((m) =>
        m.getFinalAssetSnapshot(jobId)
      );
      if (!assets?.length) {
        console.error(
          "No draft/ folder and no final asset snapshot — run cli:draft first"
        );
        process.exit(1);
      }
      writeMigrationArtifacts({
        catalog,
        sourceSchema,
        sourceTable,
        devSchema,
        warehouseId,
        databricksHost,
        decimalScale: jobRecord.decimalScale,
        timezone: jobRecord.timezone,
        jobId,
        scope: jobRecord.migrationScope,
        inventory,
        assets,
        fieldMapping: inventory.fieldMapping,
      });
    }
  } else if (tableKey) {
    const cfg = readParityConfig(tableKey);
    catalog = cfg.catalog;
    sourceSchema = cfg.sourceSchema;
    sourceTable = cfg.sourceTable;
    devSchema = cfg.devSchema;
    warehouseId = cfg.warehouseId;
    databricksHost = cfg.databricksHost;
    const invPath = path.join(migrationDir(tableKey), "inventory.json");
    inventory = fs.existsSync(invPath)
      ? JSON.parse(fs.readFileSync(invPath, "utf8"))
      : null;
    if (cfg.jobId) {
      jobRecord = await getJob(cfg.jobId);
    }
  } else {
    console.error(
      "Usage: npm run cli:deploy -- <catalog.schema.table> | --job <jobId>"
    );
    process.exit(1);
  }

  const key = `${catalog}.${sourceSchema}.${sourceTable}`;
  let assets = readDraftAssets(key);
  if (inventory) {
    assets = sanitizeGeneratedAssets(assets, catalog, devSchema, inventory);
  }

  // Prefer a real job record for deploy helpers; synthesize a minimal one.
  const job =
    jobRecord ??
    ({
      id: "cli-deploy",
      catalog,
      sourceSchema,
      sourceTable,
      devSchema,
      warehouseId,
      databricksHost,
      inventory,
      decimalScale: 2,
      timezone: "UTC",
    } as Awaited<ReturnType<typeof getJob>>);

  if (!job) {
    console.error("Failed to resolve job context");
    process.exit(1);
  }

  console.log(
    `[deploy] Deploying ${assets.length} asset(s) to ${catalog}.${devSchema}…`
  );
  const deployed = await deployAssetsToDev(job, assets, inventory);
  for (const d of deployed) {
    console.log(`  OK ${d.type} ${d.fqn}`);
  }
  console.log(`[deploy] Done. Next: npm run cli:parity -- ${key}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[deploy] Fatal:", err);
    process.exit(1);
  });

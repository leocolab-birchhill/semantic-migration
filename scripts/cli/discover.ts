#!/usr/bin/env npx tsx
/**
 * Headless discovery: find Looker explores/tiles/views that reference a
 * Databricks table and write an editable scope draft for create-job.ts.
 *
 *   npm run cli:discover -- <catalog>.<schema>.<table> [--no-sql-probe] [--out <file>]
 *
 * Output: tmp-debug/scope-draft.json
 * Every explore/tile has an `include` flag (default true). Edit the draft
 * (flip include to false, adjust warehouseId/devSchema) then run:
 *   npm run cli:create-job -- --scope tmp-debug/scope-draft.json
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function main() {
  const args = process.argv.slice(2);
  const tableArg = args.find((a) => !a.startsWith("--"));
  if (!tableArg || tableArg.split(".").length !== 3) {
    console.error(
      "Usage: npm run cli:discover -- <catalog>.<schema>.<table> [--no-sql-probe] [--out <file>]"
    );
    process.exit(1);
  }
  const [catalog, schema, table] = tableArg.split(".");
  const probeGeneratedSql = !args.includes("--no-sql-probe");
  const outIdx = args.indexOf("--out");
  const outFile =
    outIdx >= 0 && args[outIdx + 1]
      ? args[outIdx + 1]
      : path.join("tmp-debug", "scope-draft.json");

  console.log(
    `[discover] Scanning Looker for references to ${catalog}.${schema}.${table} (SQL probe: ${probeGeneratedSql ? "on" : "off"})…`
  );
  console.log("[discover] This scans LookML files, explores, dashboards, and Looks — expect a few minutes.");

  const { discoverLookerDependencies } = await import(
    "../../lib/migration/discover"
  );
  const result = await discoverLookerDependencies({
    catalog,
    schema,
    table,
    probeGeneratedSql,
  });

  const { getConfiguredHost } = await import("../../lib/databricks/env-auth");

  const draft = {
    _instructions:
      "Review before creating a job: set include:false on explores/tiles to exclude, fill databricks.warehouseId (npm run cli:doctor lists warehouses), then run: npm run cli:create-job -- --scope <this file>",
    sourceTable: { catalog, schema, table },
    databricks: {
      host: getConfiguredHost() ?? "SET_ME (DATABRICKS_HOST missing from .envs)",
      warehouseId: "SET_ME",
      devSchema: "semantic_migration_dev",
      prodSchema: "business_semantics",
    },
    options: {
      maxIterations: 5,
      decimalScale: 2,
      timezone: "UTC",
    },
    explores: result.explores.map((e) => ({
      include: true,
      model: e.model,
      explore: e.explore,
      label: e.label,
      confidence: e.confidence,
      evidence: e.evidence.map((ev) => ev.detail),
      viewNames: e.viewNames,
    })),
    tiles: result.tiles.map((t) => ({
      include: true,
      // Full DiscoveredTile payload is preserved — create-job needs it intact.
      ...t,
    })),
    views: result.views,
    searchedAt: result.searchedAt,
  };

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outFile), JSON.stringify(draft, null, 2));

  console.log(`\n[discover] Found ${result.explores.length} explore(s), ${result.tiles.length} tile(s), ${result.views.length} view(s).`);
  for (const e of result.explores) {
    console.log(`  explore ${e.model}.${e.explore} [${e.confidence}]`);
  }
  const byDashboard = new Map<string, number>();
  for (const t of result.tiles) {
    const key = t.dashboardTitle ?? t.dashboardId ?? (t.lookId ? `Look ${t.lookId}` : "unknown");
    byDashboard.set(key, (byDashboard.get(key) ?? 0) + 1);
  }
  for (const [dash, count] of byDashboard) {
    console.log(`  dashboard "${dash}" — ${count} tile(s)`);
  }
  console.log(`\n[discover] Scope draft written to ${outFile}`);
  console.log("[discover] Next: review/edit the draft (include flags, warehouseId), then:");
  console.log(`  npm run cli:create-job -- --scope ${outFile}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[discover] Fatal:", err);
    process.exit(1);
  });

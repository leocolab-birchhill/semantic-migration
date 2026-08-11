#!/usr/bin/env npx tsx
/**
 * Environment inventory + dependency graph (inventory-first planning).
 *
 *   npm run cli:inventory [--project <name>] [--model <name>]
 *     [--max-explores N] [--skip-consumers] [--out-dir tmp-debug]
 *
 * Writes:
 *   <out-dir>/inventory.json
 *   <out-dir>/dependency-graph.json
 *   <out-dir>/dependency-graph.mmd
 *
 * Does not start migration. Next: npm run cli:plan
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

function argValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) out.push(args[++i]);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = argValue(args, "--out-dir") ?? path.join("tmp-debug");
  const maxExplores = Number(argValue(args, "--max-explores") ?? "40");
  const skipConsumers = args.includes("--skip-consumers");
  const projects = argValues(args, "--project");
  const models = argValues(args, "--model");

  console.log("[inventory] Collecting Looker environment inventory…");
  console.log(
    "[inventory] Caps:",
    JSON.stringify({ maxExplores, skipConsumers, projects, models })
  );

  const { collectEnvironmentInventory, redactInventorySecrets } = await import(
    "../../lib/migration/env-inventory"
  );
  const { buildDependencyGraph } = await import(
    "../../lib/migration/dependency-graph"
  );
  const { toMermaid, isLargeGraph, toDomainSummaryMermaid } = await import(
    "../../lib/migration/graph-export"
  );

  const inventory = await collectEnvironmentInventory({
    projects: projects.length ? projects : undefined,
    models: models.length ? models : undefined,
    maxExplores,
    skipConsumers,
  });
  const safeInventory = redactInventorySecrets(inventory);
  const graph = buildDependencyGraph(safeInventory);

  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  const invPath = path.join(outDir, "inventory.json");
  const graphPath = path.join(outDir, "dependency-graph.json");
  const mmdPath = path.join(outDir, "dependency-graph.mmd");

  fs.writeFileSync(path.resolve(invPath), JSON.stringify(safeInventory, null, 2));
  fs.writeFileSync(path.resolve(graphPath), JSON.stringify(graph, null, 2));
  const mermaid = isLargeGraph(graph)
    ? toDomainSummaryMermaid(graph)
    : toMermaid(graph, { direction: "LR" });
  fs.writeFileSync(path.resolve(mmdPath), mermaid);

  const s = safeInventory.summary;
  console.log("\n[inventory] Summary");
  console.log(
    `  projects=${s.projects} models=${s.models} files=${s.files} explores=${s.explores} views=${s.views}`
  );
  console.log(
    `  fields=${s.fields} joins=${s.joins} derived=${s.derivedTables} dashboards=${s.dashboards} looks=${s.looks}`
  );
  console.log(`  sources=${s.sources} graph: ${graph.nodes.length} nodes / ${graph.edges.length} edges`);
  console.log(`  issues=${graph.issues.length}`);
  if (s.unavailable.length) {
    console.log("  unavailable:");
    for (const u of s.unavailable.slice(0, 12)) console.log(`    - ${u}`);
    if (s.unavailable.length > 12) {
      console.log(`    … +${s.unavailable.length - 12} more`);
    }
  }
  console.log(`\n[inventory] Wrote ${invPath}`);
  console.log(`[inventory] Wrote ${graphPath}`);
  console.log(`[inventory] Wrote ${mmdPath}`);
  console.log("[inventory] Next: npm run cli:plan");
  console.log(
    "[inventory] Do not migrate until the human approves components from the plan."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[inventory] Fatal:", err);
    process.exit(1);
  });

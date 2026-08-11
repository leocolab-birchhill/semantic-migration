#!/usr/bin/env npx tsx
/**
 * Propose atomic migration components from inventory + dependency graph.
 *
 *   npm run cli:plan [--in-dir tmp-debug] [--scope-mode consumer-parity|explore-retirement]
 *     [--both-scopes] [--out-dir tmp-debug]
 *
 * Reads inventory.json + dependency-graph.json (builds graph if missing).
 * Writes component-plan.yaml, component mermaid files.
 * Does NOT start draft/deploy — wait for human approval.
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
  const inDir = argValue(args, "--in-dir") ?? path.join("tmp-debug");
  const outDir = argValue(args, "--out-dir") ?? inDir;
  const scopeMode =
    (argValue(args, "--scope-mode") as
      | "consumer-parity"
      | "explore-retirement"
      | undefined) ?? "consumer-parity";
  const bothScopes = args.includes("--both-scopes");

  const invPath = path.join(inDir, "inventory.json");
  if (!fs.existsSync(invPath)) {
    console.error(`[plan] Missing ${invPath}. Run: npm run cli:inventory`);
    process.exit(1);
  }

  const { buildDependencyGraph } = await import(
    "../../lib/migration/dependency-graph"
  );
  const { proposeComponents, compareScopeModes } = await import(
    "../../lib/migration/component-planner"
  );
  const {
    componentPlanToYaml,
    validateComponentPlan,
  } = await import("../../lib/migration/component-manifest");
  const { presentGraphForChat, toComponentMermaid } = await import(
    "../../lib/migration/graph-export"
  );
  const { redactInventorySecrets } = await import(
    "../../lib/migration/env-inventory"
  );

  const inventory = redactInventorySecrets(
    JSON.parse(fs.readFileSync(path.resolve(invPath), "utf8"))
  );

  let graph;
  const graphPath = path.join(inDir, "dependency-graph.json");
  if (fs.existsSync(graphPath)) {
    graph = JSON.parse(fs.readFileSync(path.resolve(graphPath), "utf8"));
  } else {
    graph = buildDependencyGraph(inventory);
  }

  fs.mkdirSync(path.resolve(outDir), { recursive: true });

  const plans = bothScopes
    ? compareScopeModes(graph, inventory.summary)
    : {
        consumerParity:
          scopeMode === "consumer-parity"
            ? proposeComponents(graph, inventory.summary, { scopeMode })
            : null,
        exploreRetirement:
          scopeMode === "explore-retirement"
            ? proposeComponents(graph, inventory.summary, { scopeMode })
            : null,
      };

  const primary =
    scopeMode === "explore-retirement"
      ? plans.exploreRetirement ?? plans.consumerParity!
      : plans.consumerParity ?? plans.exploreRetirement!;

  primary.graph_artifact_path = path.join(outDir, "dependency-graph.json").replace(/\\/g, "/");
  primary.mermaid_summary_path = path.join(outDir, "dependency-graph.mmd").replace(/\\/g, "/");

  const issues = validateComponentPlan(primary);
  if (issues.length) {
    console.warn("[plan] Validation warnings:");
    for (const issue of issues.slice(0, 20)) {
      console.warn(`  - ${issue.path}: ${issue.message}`);
    }
  }

  const planPath = path.join(outDir, "component-plan.yaml");
  fs.writeFileSync(path.resolve(planPath), componentPlanToYaml(primary));

  if (bothScopes && plans.consumerParity && plans.exploreRetirement) {
    fs.writeFileSync(
      path.resolve(path.join(outDir, "component-plan.consumer-parity.yaml")),
      componentPlanToYaml(plans.consumerParity)
    );
    fs.writeFileSync(
      path.resolve(path.join(outDir, "component-plan.explore-retirement.yaml")),
      componentPlanToYaml(plans.exploreRetirement)
    );
  }

  const presentation = presentGraphForChat(
    graph,
    primary.components,
    primary.graph_artifact_path
  );
  fs.writeFileSync(
    path.resolve(path.join(outDir, "chat-graph-domain.mmd")),
    presentation.domainMermaid
  );

  const compDir = path.join(outDir, "component-graphs");
  fs.mkdirSync(path.resolve(compDir), { recursive: true });
  for (const c of primary.components) {
    fs.writeFileSync(
      path.resolve(path.join(compDir, `${c.id}.mmd`)),
      toComponentMermaid(graph, c)
    );
  }

  console.log("\n[plan] Inventory summary");
  const s = primary.inventory_summary;
  console.log(
    `  explores=${s.explores} views=${s.views} consumers(dashboards/looks)=${s.dashboards}/${s.looks} sources=${s.sources}`
  );
  console.log(
    `  graph mode=${presentation.mode} nodes=${presentation.nodeCount} edges=${presentation.edgeCount}`
  );

  console.log("\n[plan] Proposed components");
  console.log(
    "  name | grain | root | consumers | deps | scope | confidence | risks"
  );
  for (const c of primary.components) {
    console.log(
      `  ${c.name} | ${c.grain} | ${c.root_explores.join(",") || "(foundation)"} | ${c.selected_consumers.length} | ${c.depends_on_components.join(",") || "-"} | ${c.scope_mode} | ${c.confidence} | ${c.risks[0] ?? "-"}`
    );
  }

  console.log("\n[plan] Migration waves");
  for (const w of primary.waves) {
    console.log(`  wave ${w.wave}: ${w.label} → ${w.component_ids.join(", ") || "(none)"}`);
    console.log(`    ${w.justification}`);
  }

  console.log(`\n[plan] Recommended first: ${primary.recommended_first}`);
  console.log("[plan] Questions:");
  for (const q of primary.questions.slice(0, 8)) console.log(`  - ${q}`);

  console.log(`\n[plan] Wrote ${planPath}`);
  console.log(`[plan] Domain mermaid: ${path.join(outDir, "chat-graph-domain.mmd")}`);
  console.log(`[plan] Component mermaids: ${compDir}/`);
  console.log(
    "\n[plan] APPROVAL CHECKPOINT — do not run draft/deploy until the human approves, merges, splits, or defers components."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[plan] Fatal:", err);
    process.exit(1);
  });

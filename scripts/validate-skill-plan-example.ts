/**
 * One-shot validation + example plan (dev helper).
 * Run: npx tsx scripts/validate-skill-plan-example.ts
 */
import fs from "fs";
import path from "path";
import { buildInventoryFromFixture } from "../lib/migration/env-inventory";
import { buildDependencyGraph } from "../lib/migration/dependency-graph";
import { proposeComponents } from "../lib/migration/component-planner";
import {
  presentGraphForChat,
  toComponentMermaid,
} from "../lib/migration/graph-export";
import {
  validateComponentPlan,
  componentPlanToYaml,
} from "../lib/migration/component-manifest";

const skillPath = path.join(
  ".cursor",
  "skills",
  "looker-databricks-migration",
  "SKILL.md"
);
const skill = fs.readFileSync(skillPath, "utf8");
const fm = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fm) throw new Error("missing frontmatter");
if (!/name:\s*looker-databricks-migration/.test(fm[1])) {
  throw new Error("bad name");
}
if (!/description:/.test(fm[1])) throw new Error("missing description");
const lines = skill.split(/\r?\n/).length;
if (lines > 500) throw new Error(`SKILL.md too long: ${lines}`);
for (const r of [
  "component-methodology.md",
  "looker-dependency-rules.md",
  "databricks-mapping.md",
  "risk-and-validation-rules.md",
]) {
  const p = path.join(
    ".cursor",
    "skills",
    "looker-databricks-migration",
    "references",
    r
  );
  if (!fs.existsSync(p)) throw new Error(`missing ${r}`);
}
console.log(`SKILL validation OK; lines=${lines}`);

const inventory = buildInventoryFromFixture({
  projects: [{ id: "p1", name: "p1" }],
  models: [{ name: "sales", project: "p1" }],
  explores: [
    {
      project: "p1",
      model: "sales",
      explore: "orders",
      viewName: "orders",
      sqlTableName: "sales.orders",
      joins: [
        {
          name: "customers",
          relationship: "many_to_one",
          sqlOn: "${orders.customer_id}=${customers.id}",
        },
      ],
      dimensions: [
        { name: "orders.id" },
        { name: "orders.region" },
        { name: "customers.name" },
      ],
      measures: [{ name: "orders.revenue" }],
    },
    {
      project: "p1",
      model: "sales",
      explore: "support_tickets",
      viewName: "tickets",
      sqlTableName: "support.tickets",
      joins: [{ name: "customers", relationship: "many_to_one" }],
      dimensions: [{ name: "tickets.id" }, { name: "customers.name" }],
      measures: [{ name: "tickets.count" }],
    },
  ],
  views: [
    { project: "p1", name: "orders", sqlTableName: "sales.orders" },
    { project: "p1", name: "tickets", sqlTableName: "support.tickets" },
    { project: "p1", name: "customers", sqlTableName: "crm.customers" },
  ],
  consumers: [
    {
      id: "d1",
      kind: "dashboard",
      title: "Executive Sales",
      model: "sales",
      explore: "orders",
      fields: ["orders.revenue", "orders.region", "customers.name"],
    },
    {
      id: "l1",
      kind: "look",
      title: "Weekly Ticket Volume",
      model: "sales",
      explore: "support_tickets",
      fields: ["tickets.count", "customers.name"],
    },
  ],
});

const graph = buildDependencyGraph(inventory);
const plan = proposeComponents(graph, inventory.summary, {
  scopeMode: "consumer-parity",
});
const issues = validateComponentPlan(plan);
console.log(`plan validation issues=${issues.length}`);
if (issues.length) console.log(issues);

const presentation = presentGraphForChat(
  graph,
  plan.components,
  "tmp-debug/dependency-graph.json"
);
const outDir = "tmp-debug";
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "example-component-plan.yaml"),
  componentPlanToYaml(plan)
);
fs.writeFileSync(path.join(outDir, "example-domain.mmd"), presentation.domainMermaid);
const first =
  plan.components.find((c) => c.id === plan.recommended_first) ??
  plan.components[0];
fs.writeFileSync(
  path.join(outDir, "example-first-component.mmd"),
  toComponentMermaid(graph, first)
);

console.log(
  JSON.stringify(
    {
      mode: presentation.mode,
      nodes: presentation.nodeCount,
      edges: presentation.edgeCount,
      components: plan.components.map((c) => ({
        id: c.id,
        name: c.name,
        foundation: !!c.is_foundation,
        deps: c.depends_on_components,
        tests: c.acceptance_tests.length,
      })),
      waves: plan.waves,
      recommended_first: plan.recommended_first,
    },
    null,
    2
  )
);
console.log("---DOMAIN MERMAID---");
console.log(presentation.domainMermaid);
console.log("---FIRST COMPONENT MERMAID---");
console.log(toComponentMermaid(graph, first));

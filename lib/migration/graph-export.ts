/**
 * Mermaid + artifact export for dependency graphs.
 * Large graphs are summarized; focused component graphs stay readable.
 */

import type {
  ComponentManifest,
  DependencyGraph,
  GraphNode,
  GraphNodeType,
} from "@/lib/migration/dependency-types";
import { subgraph } from "@/lib/migration/dependency-graph";

const LARGE_NODE_THRESHOLD = 40;

export function isLargeGraph(graph: DependencyGraph, threshold = LARGE_NODE_THRESHOLD): boolean {
  return graph.nodes.length > threshold;
}

function esc(label: string): string {
  return label.replace(/[[\]{}|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function mermaidNodeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "n$1");
}

function shape(node: GraphNode): string {
  const id = mermaidNodeId(node.id);
  const label = esc(`${typePrefix(node.type)} ${node.label}`);
  switch (node.type) {
    case "source":
    case "databricks_asset":
      return `${id}[(${label})]`;
    case "consumer":
      return `${id}[${label}]`;
    case "explore":
      return `${id}[${label}]`;
    case "security_policy":
      return `${id}{{${label}}}`;
    default:
      return `${id}[${label}]`;
  }
}

function typePrefix(type: GraphNodeType): string {
  switch (type) {
    case "source":
      return "Source:";
    case "transformation":
      return "Xform:";
    case "derived_table":
      return "Derived:";
    case "looker_view":
      return "View:";
    case "semantic_field":
      return "Field:";
    case "explore":
      return "Explore:";
    case "consumer":
      return "Consumer:";
    case "security_policy":
      return "Policy:";
    case "databricks_asset":
      return "DBX:";
    default:
      return "";
  }
}

export interface MermaidExportOptions {
  direction?: "LR" | "TD";
  /** Optional component boundaries as subgraphs. */
  components?: Array<{ id: string; name: string; nodeIds: string[] }>;
  maxNodes?: number;
  includeLegend?: boolean;
  title?: string;
}

export function toMermaid(
  graph: DependencyGraph,
  options: MermaidExportOptions = {}
): string {
  const direction = options.direction ?? "LR";
  const maxNodes = options.maxNodes ?? 80;
  let nodes = graph.nodes;
  let edges = graph.edges;

  if (nodes.length > maxNodes) {
    // Prefer explores, consumers, views, sources — drop fine-grained fields first
    const priority: Record<GraphNodeType, number> = {
      explore: 0,
      consumer: 1,
      looker_view: 2,
      source: 3,
      derived_table: 4,
      databricks_asset: 5,
      security_policy: 6,
      transformation: 7,
      semantic_field: 8,
    };
    nodes = [...nodes]
      .sort((a, b) => priority[a.type] - priority[b.type])
      .slice(0, maxNodes);
    const keep = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }

  const lines: string[] = [`flowchart ${direction}`];
  if (options.title) {
    lines.push(`    %% ${esc(options.title)}`);
  }

  const nodeSet = new Set(nodes.map((n) => n.id));
  const placed = new Set<string>();

  if (options.components?.length) {
    for (const c of options.components) {
      const cid = mermaidNodeId(`component_${c.id}`);
      lines.push(`    subgraph ${cid}["Component: ${esc(c.name)}"]`);
      for (const nid of c.nodeIds) {
        if (!nodeSet.has(nid)) continue;
        const node = nodes.find((n) => n.id === nid);
        if (!node || placed.has(nid)) continue;
        lines.push(`      ${shape(node)}`);
        placed.add(nid);
      }
      lines.push("    end");
    }
  }

  for (const node of nodes) {
    if (placed.has(node.id)) continue;
    lines.push(`    ${shape(node)}`);
  }

  for (const e of edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    if (e.type === "includes_available") {
      lines.push(
        `    ${mermaidNodeId(e.from)} -.->|${esc(e.label ?? e.type)}| ${mermaidNodeId(e.to)}`
      );
    } else {
      lines.push(
        `    ${mermaidNodeId(e.from)} -->|${esc(e.label ?? e.type)}| ${mermaidNodeId(e.to)}`
      );
    }
  }

  if (options.includeLegend !== false) {
    lines.push("    %% Legend: solid=confirmed/inferred dep; dotted=availability-only include");
    lines.push(
      "    %% Node types: Source/DBX cylinders; Explore/View/Field boxes; Policy hexagon"
    );
  }

  return lines.join("\n");
}

/** Domain-level summary: consumers → explores → key sources (no field spam). */
export function toDomainSummaryMermaid(graph: DependencyGraph): string {
  const keepTypes = new Set<GraphNodeType>([
    "consumer",
    "explore",
    "looker_view",
    "source",
    "databricks_asset",
    "security_policy",
  ]);
  const nodes = graph.nodes.filter((n) => keepTypes.has(n.type));
  // Cap views if still huge
  let selected = nodes;
  if (selected.length > 36) {
    const explores = selected.filter((n) => n.type === "explore");
    const consumers = selected.filter((n) => n.type === "consumer").slice(0, 12);
    const sources = selected.filter((n) => n.type === "source").slice(0, 12);
    const views = selected.filter((n) => n.type === "looker_view").slice(0, 12);
    const rest = selected.filter(
      (n) =>
        n.type !== "explore" &&
        n.type !== "consumer" &&
        n.type !== "source" &&
        n.type !== "looker_view"
    );
    selected = [...consumers, ...explores, ...views, ...sources, ...rest].slice(0, 36);
  }
  const ids = new Set(selected.map((n) => n.id));
  return toMermaid(subgraph(graph, ids), {
    direction: "LR",
    title: "Domain summary",
    includeLegend: true,
  });
}

export function toComponentMermaid(
  graph: DependencyGraph,
  component: ComponentManifest
): string {
  const ids = new Set(component.node_ids ?? []);
  // Always include explore roots + consumers by label match
  for (const n of graph.nodes) {
    if (n.type === "explore" && component.root_explores.some((e) => n.id.endsWith(`:${e.toLowerCase()}`) || n.identity.explore === e)) {
      ids.add(n.id);
    }
    if (
      n.type === "consumer" &&
      component.selected_consumers.some(
        (c) =>
          n.id.includes(c.toLowerCase()) ||
          n.label.toLowerCase().includes(c.toLowerCase())
      )
    ) {
      ids.add(n.id);
    }
  }
  const focused = subgraph(graph, ids);
  return toMermaid(focused, {
    direction: "LR",
    title: component.name,
    components: [
      {
        id: component.id,
        name: component.name,
        nodeIds: Array.from(ids),
      },
    ],
    includeLegend: true,
  });
}

export interface ChatGraphPresentation {
  mode: "full" | "summarized";
  domainMermaid: string;
  componentMermaids: Array<{ id: string; name: string; mermaid: string }>;
  fullGraphPathHint: string;
  nodeCount: number;
  edgeCount: number;
}

export function presentGraphForChat(
  graph: DependencyGraph,
  components: ComponentManifest[],
  artifactPath = "tmp-debug/dependency-graph.json"
): ChatGraphPresentation {
  const large = isLargeGraph(graph);
  const domainMermaid = large
    ? toDomainSummaryMermaid(graph)
    : toMermaid(graph, {
        direction: "LR",
        components: components.map((c) => ({
          id: c.id,
          name: c.name,
          nodeIds: c.node_ids ?? [],
        })),
      });

  return {
    mode: large ? "summarized" : "full",
    domainMermaid,
    componentMermaids: components.map((c) => ({
      id: c.id,
      name: c.name,
      mermaid: toComponentMermaid(graph, c),
    })),
    fullGraphPathHint: artifactPath,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}

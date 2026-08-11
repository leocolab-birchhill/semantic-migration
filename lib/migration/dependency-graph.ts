/**
 * Deterministic dependency-graph construction and graph algorithms.
 * Model judgment must not invent edges — only interpret business semantics.
 */

import {
  detectFanOut,
  detectManyToMany,
  parseExploreBlocks,
  parseIncludes,
  parseRefinements,
  parseViewBlocks,
} from "@/lib/migration/lookml-parse";
import { extractQualifiedTableRefsFromSql, normalizeTableRef } from "@/lib/migration/table-names";
import type {
  DependencyEvidenceKind,
  DependencyGraph,
  EnvironmentInventory,
  GraphEdge,
  GraphEdgeType,
  GraphIssue,
  GraphNode,
  GraphNodeType,
} from "@/lib/migration/dependency-types";

function nodeId(type: GraphNodeType, ...parts: Array<string | undefined | null>): string {
  return [type, ...parts.filter(Boolean).map((p) => String(p).toLowerCase())].join(":");
}

function edgeId(from: string, type: GraphEdgeType, to: string): string {
  return `${from}|${type}|${to}`;
}

function addNode(map: Map<string, GraphNode>, node: GraphNode): void {
  if (!map.has(node.id)) map.set(node.id, node);
  else {
    const existing = map.get(node.id)!;
    map.set(node.id, {
      ...existing,
      ...node,
      identity: { ...existing.identity, ...node.identity },
      flags: { ...existing.flags, ...node.flags },
      metadata: { ...existing.metadata, ...node.metadata },
    });
  }
}

function addEdge(
  edges: Map<string, GraphEdge>,
  from: string,
  to: string,
  type: GraphEdgeType,
  evidence: DependencyEvidenceKind,
  opts?: { coupling?: GraphEdge["coupling"]; label?: string; metadata?: Record<string, unknown> }
): void {
  const id = edgeId(from, type, to);
  if (edges.has(id)) return;
  edges.set(id, {
    id,
    from,
    to,
    type,
    evidence,
    coupling: opts?.coupling,
    label: opts?.label ?? type,
    metadata: opts?.metadata,
  });
}

function sourceNodeFromCanonical(canonical: string): GraphNode {
  const ref = normalizeTableRef(canonical);
  return {
    id: nodeId("source", canonical),
    type: "source",
    label: canonical,
    identity: {
      catalog: ref?.catalog ?? undefined,
      schema: ref?.schema ?? undefined,
      object: ref?.table ?? canonical,
    },
  };
}

/**
 * Build a typed dependency graph from an environment inventory.
 * `include:` statements become availability_only unless another edge proves use.
 */
export function buildDependencyGraph(inventory: EnvironmentInventory): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const issues: GraphIssue[] = [];

  for (const src of inventory.sources) {
    addNode(nodes, sourceNodeFromCanonical(src.canonical));
  }

  for (const asset of inventory.databricksAssets) {
    const id = nodeId(
      "databricks_asset",
      asset.catalog,
      asset.schema,
      asset.name
    );
    addNode(nodes, {
      id,
      type: "databricks_asset",
      label: asset.label ?? `${asset.catalog ?? ""}.${asset.schema ?? ""}.${asset.name}`,
      identity: {
        catalog: asset.catalog,
        schema: asset.schema,
        object: asset.name,
      },
      metadata: { kind: asset.kind },
    });
  }

  for (const view of inventory.views) {
    const vid = nodeId("looker_view", view.project, view.name);
    addNode(nodes, {
      id: vid,
      type: "looker_view",
      label: `View: ${view.name}`,
      identity: {
        project: view.project,
        file: view.path,
        object: view.name,
      },
      flags: {
        dynamicSql: Boolean(view.derivedTableSql),
        liquid: false,
      },
    });

    if (view.sqlTableName) {
      const ref = normalizeTableRef(view.sqlTableName);
      if (ref) {
        const sid = nodeId("source", ref.canonical);
        addNode(nodes, sourceNodeFromCanonical(ref.canonical));
        addEdge(edges, vid, sid, "builds_from", "statically_inferred", {
          coupling: "hard",
        });
      }
    }

    if (view.derivedTableSql) {
      const dtId = nodeId("derived_table", view.project, view.name);
      addNode(nodes, {
        id: dtId,
        type: "derived_table",
        label: `Derived: ${view.name}`,
        identity: { project: view.project, object: view.name, file: view.path },
        flags: { dynamicSql: true },
      });
      addEdge(edges, vid, dtId, "depends_on", "statically_inferred", {
        coupling: "hard",
      });
      for (const raw of extractQualifiedTableRefsFromSql(view.derivedTableSql)) {
        const ref = normalizeTableRef(raw);
        if (!ref) continue;
        const sid = nodeId("source", ref.canonical);
        addNode(nodes, sourceNodeFromCanonical(ref.canonical));
        addEdge(edges, dtId, sid, "builds_from", "statically_inferred", {
          coupling: "hard",
        });
      }
    }

    for (const ext of view.extends ?? []) {
      const parentId = nodeId("looker_view", view.project, ext);
      addNode(nodes, {
        id: parentId,
        type: "looker_view",
        label: `View: ${ext}`,
        identity: { project: view.project, object: ext },
      });
      addEdge(edges, vid, parentId, "extends", "statically_inferred", {
        coupling: "hard",
      });
    }

    if (view.refined) {
      // Refinement target is the same view name; record refine edge to base if present.
      addEdge(edges, vid, vid, "refines", "statically_inferred", {
        coupling: "hard",
        label: "refines",
      });
    }
  }

  // LookML file-level includes / parses (availability vs proven use)
  for (const file of inventory.files) {
    for (const inc of parseIncludes(file.contents)) {
      const availId = nodeId("looker_view", file.project, `include:${inc.path}`);
      addNode(nodes, {
        id: availId,
        type: "looker_view",
        label: `Include: ${inc.path}`,
        identity: { project: file.project, file: inc.path, object: inc.path },
        metadata: { availabilityOnly: true },
      });
      const fileAnchor = nodeId("transformation", file.project, file.path);
      addNode(nodes, {
        id: fileAnchor,
        type: "transformation",
        label: `File: ${file.path}`,
        identity: { project: file.project, file: file.path },
      });
      addEdge(edges, fileAnchor, availId, "includes_available", "availability_only", {
        coupling: "incidental",
        label: "includes (availability)",
      });
    }

    for (const vb of parseViewBlocks(file.contents)) {
      const vid = nodeId("looker_view", file.project, vb.name);
      addNode(nodes, {
        id: vid,
        type: "looker_view",
        label: `View: ${vb.name}`,
        identity: { project: file.project, file: file.path, object: vb.name },
        flags: {
          liquid: vb.hasLiquid,
          userAttributeDeps: vb.hasUserAttributes,
          dynamicSql: vb.hasDynamicSql,
        },
      });
      if (vb.sqlTableName) {
        const ref = normalizeTableRef(vb.sqlTableName);
        if (ref) {
          const sid = nodeId("source", ref.canonical);
          addNode(nodes, sourceNodeFromCanonical(ref.canonical));
          addEdge(edges, vid, sid, "builds_from", "statically_inferred", {
            coupling: "hard",
          });
        }
      }
      if (vb.derivedTableSql) {
        const dtId = nodeId("derived_table", file.project, vb.name);
        addNode(nodes, {
          id: dtId,
          type: "derived_table",
          label: `Derived: ${vb.name}`,
          identity: { project: file.project, object: vb.name, file: file.path },
          flags: {
            liquid: vb.hasLiquid,
            dynamicSql: vb.hasDynamicSql,
            userAttributeDeps: vb.hasUserAttributes,
          },
        });
        addEdge(edges, vid, dtId, "depends_on", "statically_inferred", {
          coupling: "hard",
        });
        for (const raw of extractQualifiedTableRefsFromSql(vb.derivedTableSql)) {
          const ref = normalizeTableRef(raw);
          if (!ref) continue;
          const sid = nodeId("source", ref.canonical);
          addNode(nodes, sourceNodeFromCanonical(ref.canonical));
          addEdge(edges, dtId, sid, "builds_from", "statically_inferred", {
            coupling: "hard",
          });
        }
      }
      for (const ext of vb.extendsViews) {
        const parentId = nodeId("looker_view", file.project, ext);
        addNode(nodes, {
          id: parentId,
          type: "looker_view",
          label: `View: ${ext}`,
          identity: { project: file.project, object: ext },
        });
        addEdge(edges, vid, parentId, "extends", "statically_inferred", {
          coupling: "hard",
        });
      }
      if (vb.hasLiquid) {
        issues.push({
          kind: "liquid",
          severity: "warn",
          nodeIds: [vid],
          message: `View ${vb.name} uses Liquid templating`,
        });
      }
      if (vb.hasUserAttributes) {
        issues.push({
          kind: "user_attribute",
          severity: "warn",
          nodeIds: [vid],
          message: `View ${vb.name} depends on user attributes`,
        });
      }
      if (vb.hasDynamicSql) {
        issues.push({
          kind: "dynamic_sql",
          severity: "warn",
          nodeIds: [vid],
          message: `View ${vb.name} has dynamic / derived SQL`,
        });
      }
    }

    for (const rf of parseRefinements(file.contents)) {
      const refinedId = nodeId("looker_view", file.project, `+${rf.viewName}`);
      const baseId = nodeId("looker_view", file.project, rf.viewName);
      addNode(nodes, {
        id: refinedId,
        type: "looker_view",
        label: `Refine: +${rf.viewName}`,
        identity: { project: file.project, object: rf.viewName, file: file.path },
      });
      addNode(nodes, {
        id: baseId,
        type: "looker_view",
        label: `View: ${rf.viewName}`,
        identity: { project: file.project, object: rf.viewName },
      });
      addEdge(edges, refinedId, baseId, "refines", "statically_inferred", {
        coupling: "hard",
      });
    }

    for (const eb of parseExploreBlocks(file.contents)) {
      const modelGuess =
        inventory.models.find((m) => m.project === file.project)?.name ??
        file.project;
      const eid = nodeId("explore", modelGuess, eb.name);
      addNode(nodes, {
        id: eid,
        type: "explore",
        label: `Explore: ${eb.name}`,
        identity: {
          project: file.project,
          model: modelGuess,
          explore: eb.name,
          file: file.path,
        },
        flags: {
          liquid: eb.hasLiquid,
          userAttributeDeps: eb.hasUserAttributes,
        },
      });
      const baseView = eb.viewName ?? eb.name;
      const vid = nodeId("looker_view", file.project, baseView);
      addNode(nodes, {
        id: vid,
        type: "looker_view",
        label: `View: ${baseView}`,
        identity: { project: file.project, object: baseView },
      });
      addEdge(edges, eid, vid, "depends_on", "statically_inferred", {
        coupling: "hard",
        label: "based on",
      });
      for (const join of eb.joins) {
        const jvid = nodeId("looker_view", file.project, join.name);
        addNode(nodes, {
          id: jvid,
          type: "looker_view",
          label: `View: ${join.name}`,
          identity: { project: file.project, object: join.name },
          flags: {
            manyToMany: detectManyToMany(join.relationship),
            fanOutRisk: detectFanOut(join.relationship),
          },
        });
        addEdge(edges, eid, jvid, "joins", "statically_inferred", {
          coupling: "hard",
          metadata: { relationship: join.relationship, type: join.type },
        });
        if (detectManyToMany(join.relationship)) {
          issues.push({
            kind: "many_to_many",
            severity: "warn",
            nodeIds: [eid, jvid],
            message: `Explore ${eb.name} has many_to_many join to ${join.name}`,
          });
        } else if (detectFanOut(join.relationship)) {
          issues.push({
            kind: "fan_out",
            severity: "info",
            nodeIds: [eid, jvid],
            message: `Explore ${eb.name} has one_to_many join to ${join.name} (fan-out risk)`,
          });
        }
      }
    }
  }

  for (const explore of inventory.explores) {
    const project =
      explore.project ??
      inventory.models.find((m) => m.name === explore.model)?.project ??
      explore.model;
    const eid = nodeId("explore", explore.model, explore.explore);
    addNode(nodes, {
      id: eid,
      type: "explore",
      label: `Explore: ${explore.label ?? explore.explore}`,
      identity: {
        project,
        model: explore.model,
        explore: explore.explore,
      },
    });

    const baseView = explore.viewName ?? explore.explore;
    const vid = nodeId("looker_view", project, baseView);
    addNode(nodes, {
      id: vid,
      type: "looker_view",
      label: `View: ${baseView}`,
      identity: { project, model: explore.model, object: baseView },
    });
    addEdge(edges, eid, vid, "depends_on", "confirmed", {
      coupling: "hard",
      label: "based on",
    });

    if (explore.sqlTableName) {
      const ref = normalizeTableRef(explore.sqlTableName);
      if (ref) {
        const sid = nodeId("source", ref.canonical);
        addNode(nodes, sourceNodeFromCanonical(ref.canonical));
        addEdge(edges, vid, sid, "builds_from", "confirmed", { coupling: "hard" });
      }
    }

    for (const join of explore.joins) {
      const jvid = nodeId("looker_view", project, join.name);
      addNode(nodes, {
        id: jvid,
        type: "looker_view",
        label: `View: ${join.name}`,
        identity: { project, model: explore.model, object: join.name },
        flags: {
          manyToMany: detectManyToMany(join.relationship),
          fanOutRisk: detectFanOut(join.relationship),
        },
      });
      addEdge(edges, eid, jvid, "joins", "confirmed", {
        coupling: "hard",
        metadata: { relationship: join.relationship },
      });
      if (detectManyToMany(join.relationship)) {
        issues.push({
          kind: "many_to_many",
          severity: "warn",
          nodeIds: [eid, jvid],
          message: `Explore ${explore.explore} has many_to_many join to ${join.name}`,
        });
      }
    }

    for (const dim of explore.dimensions) {
      const fid = nodeId("semantic_field", explore.model, explore.explore, dim.name);
      addNode(nodes, {
        id: fid,
        type: "semantic_field",
        label: dim.name,
        identity: {
          project,
          model: explore.model,
          explore: explore.explore,
          field: dim.name,
        },
        flags: { hidden: dim.hidden },
      });
      addEdge(edges, eid, fid, "depends_on", "confirmed", { coupling: "soft" });
      if (dim.hidden) {
        issues.push({
          kind: "hidden_or_deprecated",
          severity: "info",
          nodeIds: [fid],
          message: `Hidden dimension ${dim.name}`,
        });
      }
      const viewPart = dim.name.includes(".") ? dim.name.split(".")[0] : baseView;
      const fieldView = nodeId("looker_view", project, viewPart);
      addEdge(edges, fid, fieldView, "depends_on", "statically_inferred", {
        coupling: "hard",
      });
    }

    for (const measure of explore.measures) {
      const fid = nodeId(
        "semantic_field",
        explore.model,
        explore.explore,
        measure.name
      );
      addNode(nodes, {
        id: fid,
        type: "semantic_field",
        label: measure.name,
        identity: {
          project,
          model: explore.model,
          explore: explore.explore,
          field: measure.name,
        },
        flags: { hidden: measure.hidden },
      });
      addEdge(edges, eid, fid, "depends_on", "confirmed", { coupling: "soft" });
      const viewPart = measure.name.includes(".")
        ? measure.name.split(".")[0]
        : baseView;
      const fieldView = nodeId("looker_view", project, viewPart);
      addEdge(edges, fid, fieldView, "depends_on", "statically_inferred", {
        coupling: "hard",
      });
    }

    for (const grant of explore.accessGrants ?? []) {
      const sid = nodeId("security_policy", explore.model, grant);
      addNode(nodes, {
        id: sid,
        type: "security_policy",
        label: `Access: ${grant}`,
        identity: { model: explore.model, object: grant },
      });
      addEdge(edges, eid, sid, "governed_by", "confirmed", { coupling: "hard" });
    }
  }

  for (const consumer of inventory.consumers) {
    const cid = nodeId("consumer", consumer.kind, consumer.id);
    addNode(nodes, {
      id: cid,
      type: "consumer",
      label: `${consumer.kind}: ${consumer.title}`,
      identity: {
        object: consumer.id,
        consumerKind: consumer.kind,
        model: consumer.model,
        explore: consumer.explore,
      },
      metadata: { fields: consumer.fields, owner: consumer.owner },
    });
    if (consumer.model && consumer.explore) {
      const eid = nodeId("explore", consumer.model, consumer.explore);
      addNode(nodes, {
        id: eid,
        type: "explore",
        label: `Explore: ${consumer.explore}`,
        identity: { model: consumer.model, explore: consumer.explore },
      });
      addEdge(edges, cid, eid, "consumes", "runtime_observed", {
        coupling: "soft",
      });
      for (const field of consumer.fields ?? []) {
        const fid = nodeId(
          "semantic_field",
          consumer.model,
          consumer.explore,
          field
        );
        if (nodes.has(fid)) {
          addEdge(edges, cid, fid, "consumes", "runtime_observed", {
            coupling: "soft",
          });
        }
      }
    }
  }

  // Map sources to existing Databricks assets when canonical names match
  for (const node of nodes.values()) {
    if (node.type !== "source") continue;
    const canonical = node.label.toLowerCase();
    for (const asset of inventory.databricksAssets) {
      const assetKey = [asset.catalog, asset.schema, asset.name]
        .filter(Boolean)
        .join(".")
        .toLowerCase();
      if (assetKey && (canonical === assetKey || canonical.endsWith(`.${asset.name.toLowerCase()}`))) {
        const aid = nodeId(
          "databricks_asset",
          asset.catalog,
          asset.schema,
          asset.name
        );
        addEdge(edges, node.id, aid, "maps_to", "confirmed", {
          coupling: "soft",
        });
      }
    }
  }

  const graph: DependencyGraph = {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    issues: [],
  };

  graph.issues = [...issues, ...detectGraphIssues(graph)];
  return graph;
}

export function detectCycles(graph: DependencyGraph): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    // Skip self-refine noise and availability-only edges for cycle hard deps
    if (e.type === "includes_available") continue;
    if (e.from === e.to) continue;
    adj.get(e.from)?.push(e.to);
  }

  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): void {
    if (visiting.has(id)) {
      const idx = stack.indexOf(id);
      if (idx >= 0) cycles.push(stack.slice(idx).concat(id));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const next of adj.get(id) ?? []) dfs(next);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const n of graph.nodes) dfs(n.id);
  return cycles;
}

export function findOrphans(graph: DependencyGraph): string[] {
  const connected = new Set<string>();
  for (const e of graph.edges) {
    connected.add(e.from);
    connected.add(e.to);
  }
  return graph.nodes
    .filter((n) => !connected.has(n.id) && n.type !== "databricks_asset")
    .map((n) => n.id);
}

export function detectGraphIssues(graph: DependencyGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  for (const cycle of detectCycles(graph)) {
    issues.push({
      kind: "cycle",
      severity: "error",
      nodeIds: cycle,
      message: `Hard-dependency cycle: ${cycle.join(" → ")}`,
    });
  }
  for (const orphan of findOrphans(graph)) {
    issues.push({
      kind: "orphan",
      severity: "info",
      nodeIds: [orphan],
      message: `Orphaned object with no edges: ${orphan}`,
    });
  }
  for (const node of graph.nodes) {
    if (node.flags?.unsupportedTarget) {
      issues.push({
        kind: "unsupported_target",
        severity: "warn",
        nodeIds: [node.id],
        message: `Unsupported target behavior: ${node.label}`,
      });
    }
    if (node.flags?.aggregateAware) {
      issues.push({
        kind: "aggregate_awareness",
        severity: "info",
        nodeIds: [node.id],
        message: `Aggregate awareness: ${node.label}`,
      });
    }
  }
  for (const e of graph.edges) {
    if (e.evidence === "unresolved") {
      issues.push({
        kind: "unresolved_reference",
        severity: "warn",
        nodeIds: [e.from, e.to],
        message: `Unresolved reference ${e.from} → ${e.to}`,
      });
    }
  }
  return issues;
}

export interface ClosureOptions {
  /** Stop traversal at these node ids (e.g. approved foundations / Databricks assets). */
  stopAt?: Set<string>;
  /** Edge types to follow upstream. */
  edgeTypes?: GraphEdgeType[];
  /** Skip availability-only edges (default true). */
  skipAvailabilityOnly?: boolean;
  /** Only hard coupling when set. */
  hardOnly?: boolean;
}

/**
 * Upstream dependency closure from roots.
 * Does NOT traverse reverse edges into unrelated downstream consumers.
 */
export function upstreamClosure(
  graph: DependencyGraph,
  roots: string[],
  options: ClosureOptions = {}
): Set<string> {
  const skipAvailability = options.skipAvailabilityOnly !== false;
  const stopAt = options.stopAt ?? new Set<string>();
  const allowed = options.edgeTypes
    ? new Set(options.edgeTypes)
    : null;

  const outEdges = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (skipAvailability && (e.type === "includes_available" || e.evidence === "availability_only")) {
      continue;
    }
    if (allowed && !allowed.has(e.type)) continue;
    if (options.hardOnly && e.coupling && e.coupling !== "hard") continue;
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from)!.push(e);
  }

  const result = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    if (stopAt.has(id)) continue;
    const node = graph.nodes.find((n) => n.id === id);
    if (node?.type === "databricks_asset") continue;
    for (const e of outEdges.get(id) ?? []) {
      if (!result.has(e.to)) queue.push(e.to);
    }
  }
  return result;
}

/**
 * Downstream consumers of a node (explicit reverse traversal — opt-in only).
 * Component planning must not use this to expand scope via shared sources.
 */
export function downstreamConsumers(
  graph: DependencyGraph,
  rootIds: string[]
): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type === "includes_available") continue;
    if (!reverse.has(e.to)) reverse.set(e.to, []);
    reverse.get(e.to)!.push(e.from);
  }
  const result = new Set<string>();
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const from of reverse.get(id) ?? []) {
      if (!result.has(from)) queue.push(from);
    }
  }
  return result;
}

export function nodesByType(
  graph: DependencyGraph,
  type: GraphNodeType
): GraphNode[] {
  return graph.nodes.filter((n) => n.type === type);
}

export function getNode(graph: DependencyGraph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function subgraph(
  graph: DependencyGraph,
  nodeIds: Set<string>
): DependencyGraph {
  const nodes = graph.nodes.filter((n) => nodeIds.has(n.id));
  const edges = graph.edges.filter(
    (e) => nodeIds.has(e.from) && nodeIds.has(e.to)
  );
  return {
    version: graph.version,
    generatedAt: graph.generatedAt,
    nodes,
    edges,
    issues: graph.issues.filter((i) => i.nodeIds.some((id) => nodeIds.has(id))),
  };
}

/** Shared upstream nodes appearing in 2+ closures (candidate foundation seeds). */
export function findRepeatedUpstreamSubgraphs(
  closures: Array<{ id: string; nodes: Set<string> }>
): Array<{ nodeId: string; consumerComponentIds: string[] }> {
  const counts = new Map<string, string[]>();
  for (const c of closures) {
    for (const n of c.nodes) {
      if (!counts.has(n)) counts.set(n, []);
      counts.get(n)!.push(c.id);
    }
  }
  return Array.from(counts.entries())
    .filter(([, comps]) => new Set(comps).size >= 2)
    .map(([nodeId, consumerComponentIds]) => ({
      nodeId,
      consumerComponentIds: Array.from(new Set(consumerComponentIds)),
    }))
    .sort((a, b) => b.consumerComponentIds.length - a.consumerComponentIds.length);
}

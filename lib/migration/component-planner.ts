/**
 * Propose atomic migration components from a dependency graph.
 * Deterministic traversal + heuristics; business judgment stays with the agent/human.
 */

import {
  detectCycles,
  findRepeatedUpstreamSubgraphs,
  getNode,
  nodesByType,
  upstreamClosure,
} from "@/lib/migration/dependency-graph";
import type {
  ComponentManifest,
  ComponentPlan,
  CouplingStrength,
  DependencyGraph,
  EnvironmentInventorySummary,
  MigrationWave,
  OrdinalRating,
  ScopeMode,
} from "@/lib/migration/dependency-types";

export interface PlanOptions {
  scopeMode?: ScopeMode;
  /** When set, only plan these explore ids (explore:model:name). */
  exploreIds?: string[];
  /** Prefer consumer-parity field sets from these consumer node ids. */
  consumerIds?: string[];
  /** Approved foundation / databricks stop nodes. */
  stopAt?: string[];
  businessDomainByExplore?: Record<string, string>;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function ratingFromCount(n: number, highAt: number, mediumAt: number): OrdinalRating {
  if (n >= highAt) return "high";
  if (n >= mediumAt) return "medium";
  return "low";
}

function invertRating(r: OrdinalRating): OrdinalRating {
  if (r === "high") return "low";
  if (r === "low") return "high";
  return "medium";
}

/**
 * Classify coupling between two nodes given connecting edge metadata.
 */
export function classifyCoupling(
  graph: DependencyGraph,
  a: string,
  b: string
): CouplingStrength {
  const edges = graph.edges.filter(
    (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a)
  );
  if (edges.some((e) => e.coupling === "hard")) return "hard";
  if (edges.some((e) => e.type === "includes_available" || e.evidence === "availability_only")) {
    return "incidental";
  }
  if (edges.some((e) => e.coupling === "soft")) return "soft";
  // Shared source only via builds_from from different parents → incidental
  const aNode = getNode(graph, a);
  const bNode = getNode(graph, b);
  if (aNode?.type === "source" || bNode?.type === "source") return "incidental";
  return edges.length ? "soft" : "incidental";
}

function consumerFieldsForExplore(
  graph: DependencyGraph,
  exploreId: string,
  consumerFilter?: Set<string>
): { consumerIds: string[]; fieldIds: string[] } {
  const consumerIds: string[] = [];
  const fieldIds: string[] = [];
  for (const e of graph.edges) {
    if (e.type !== "consumes") continue;
    if (e.to !== exploreId && !e.to.startsWith("semantic_field:")) continue;
    if (consumerFilter && !consumerFilter.has(e.from)) continue;
    const from = getNode(graph, e.from);
    if (from?.type !== "consumer") continue;
    if (e.to === exploreId) {
      consumerIds.push(e.from);
      continue;
    }
    // field consume — only if field belongs to this explore
    if (e.to.includes(exploreId.replace(/^explore:/, "")) || e.to.includes(exploreId.split(":").slice(1).join(":"))) {
      consumerIds.push(e.from);
      fieldIds.push(e.to);
    }
  }
  // Also: consumers that consume this explore
  for (const e of graph.edges) {
    if (e.type === "consumes" && e.to === exploreId) {
      if (!consumerFilter || consumerFilter.has(e.from)) consumerIds.push(e.from);
    }
  }
  return {
    consumerIds: Array.from(new Set(consumerIds)),
    fieldIds: Array.from(new Set(fieldIds)),
  };
}

function collectIncludes(
  graph: DependencyGraph,
  nodeIds: Set<string>
): ComponentManifest["includes"] {
  const views: string[] = [];
  const fields: string[] = [];
  const joins: string[] = [];
  const transformations: string[] = [];
  const security_policies: string[] = [];

  for (const id of nodeIds) {
    const n = getNode(graph, id);
    if (!n) continue;
    if (n.type === "looker_view") views.push(n.identity.object ?? n.label);
    if (n.type === "semantic_field") fields.push(n.identity.field ?? n.label);
    if (n.type === "derived_table" || n.type === "transformation") {
      transformations.push(n.label);
    }
    if (n.type === "security_policy") security_policies.push(n.label);
  }

  for (const e of graph.edges) {
    if (e.type === "joins" && nodeIds.has(e.from) && nodeIds.has(e.to)) {
      joins.push(`${e.from}→${e.to}`);
    }
  }

  return { views, fields, joins, transformations, security_policies };
}

function atomicityCheck(
  graph: DependencyGraph,
  nodeIds: Set<string>,
  manifest: Pick<ComponentManifest, "acceptance_tests" | "owner" | "source_assets">
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (nodeIds.size === 0) failures.push("empty component");
  if (!manifest.acceptance_tests.length) {
    failures.push("missing acceptance tests");
  }
  if (!manifest.source_assets.length) {
    const hasDbx = [...nodeIds].some((id) => getNode(graph, id)?.type === "databricks_asset");
    if (!hasDbx) failures.push("no source or target assets");
  }
  // Hard cycle entirely inside component is OK (merged); cycle crossing boundary is not
  for (const cycle of detectCycles(graph)) {
    const inside = cycle.filter((id) => nodeIds.has(id));
    const outside = cycle.filter((id) => !nodeIds.has(id));
    if (inside.length && outside.length) {
      failures.push(`hard dependency cycle crosses component boundary: ${cycle.join(" → ")}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function defaultAcceptanceTests(
  exploreName: string,
  scopeMode: ScopeMode
): ComponentManifest["acceptance_tests"] {
  if (scopeMode === "consumer-parity") {
    return [
      {
        description: `Selected dashboard/Look tiles for ${exploreName} match within tolerance`,
        tolerance: "0.1_percent",
      },
      {
        description: `Row counts for mandatory consumer queries on ${exploreName} match`,
        tolerance: "exact_or_documented_boundary",
      },
    ];
  }
  return [
    {
      description: `Full explore semantic contract for ${exploreName}: measures match by grain dimensions`,
      tolerance: "0.1_percent",
    },
    {
      description: `Ad-hoc dimension drill paths for ${exploreName} return equivalent populations`,
      tolerance: "0.1_percent",
    },
  ];
}

/**
 * Build candidate components rooted at explores (or explore families).
 * Upstream-only traversal — shared sources do NOT pull unrelated explores.
 */
export function proposeComponents(
  graph: DependencyGraph,
  inventorySummary: EnvironmentInventorySummary,
  options: PlanOptions = {}
): ComponentPlan {
  const scopeMode = options.scopeMode ?? "consumer-parity";
  const stopAt = new Set(options.stopAt ?? []);
  for (const n of graph.nodes) {
    if (n.type === "databricks_asset") stopAt.add(n.id);
  }

  const consumerFilter = options.consumerIds
    ? new Set(options.consumerIds)
    : undefined;

  let explores = nodesByType(graph, "explore");
  if (options.exploreIds?.length) {
    const allow = new Set(options.exploreIds);
    explores = explores.filter((e) => allow.has(e.id));
  }

  const drafts: ComponentManifest[] = [];
  const closures: Array<{ id: string; nodes: Set<string> }> = [];

  for (const explore of explores) {
    const exploreName = explore.identity.explore ?? explore.label;
    const { consumerIds, fieldIds } = consumerFieldsForExplore(
      graph,
      explore.id,
      consumerFilter
    );

    const roots = [explore.id];
    if (scopeMode === "consumer-parity") {
      // Only fields required by selected consumers when known; else explore+joins+views
      if (fieldIds.length) roots.push(...fieldIds);
      // Still need explore structure
    }

    const closure = upstreamClosure(graph, roots, { stopAt });
    // Ensure join targets of this explore are included
    for (const e of graph.edges) {
      if (e.from === explore.id && (e.type === "joins" || e.type === "depends_on")) {
        const more = upstreamClosure(graph, [e.to], { stopAt });
        for (const id of more) closure.add(id);
      }
    }

    // Consumer-parity: drop semantic fields not consumed when we have consumer field evidence
    if (scopeMode === "consumer-parity" && fieldIds.length) {
      const keepFields = new Set(fieldIds);
      for (const id of [...closure]) {
        const n = getNode(graph, id);
        if (n?.type === "semantic_field" && !keepFields.has(id)) closure.delete(id);
      }
    }

    const id = slugify(exploreName);
    const sources = [...closure]
      .map((nid) => getNode(graph, nid))
      .filter((n) => n?.type === "source")
      .map((n) => n!.label);

    const targets = [...closure]
      .map((nid) => getNode(graph, nid))
      .filter((n) => n?.type === "databricks_asset")
      .map((n) => n!.label);

    const excluded: string[] = [];
    // Explicitly record sibling explores that share sources but are not in closure roots
    for (const other of explores) {
      if (other.id === explore.id) continue;
      const otherSources = [...upstreamClosure(graph, [other.id], { stopAt })]
        .map((nid) => getNode(graph, nid))
        .filter((n) => n?.type === "source")
        .map((n) => n!.id);
      const shared = otherSources.filter((s) =>
        [...closure].some((c) => c === s)
      );
      if (shared.length) {
        excluded.push(
          `explore ${other.identity.explore} (shared source only; not downstream-expanded)`
        );
      }
    }

    const includes = collectIncludes(graph, closure);
    const domain =
      options.businessDomainByExplore?.[exploreName] ??
      explore.identity.model ??
      "unspecified";

    const issuesFor = graph.issues.filter((i) =>
      i.nodeIds.some((nid) => closure.has(nid))
    );
    const risks: string[] = issuesFor.map((i) => i.message);
    const unresolved = issuesFor
      .filter((i) => i.kind === "unresolved_reference")
      .map((i) => i.message);

    const consumerLabels = consumerIds.map(
      (cid) => getNode(graph, cid)?.label ?? cid
    );

    const scores = {
      business_value: consumerIds.length ? ratingFromCount(consumerIds.length, 3, 1) : "medium" as OrdinalRating,
      usage: ratingFromCount(consumerIds.length, 5, 2),
      data_readiness: targets.length ? ("high" as OrdinalRating) : ("medium" as OrdinalRating),
      owner_availability: "medium" as OrdinalRating,
      testability: consumerIds.length ? ("high" as OrdinalRating) : ("medium" as OrdinalRating),
      semantic_complexity: ratingFromCount(includes.joins.length + includes.transformations.length, 4, 2),
      unsupported_features: ratingFromCount(
        issuesFor.filter((i) => i.kind === "unsupported_target" || i.kind === "liquid").length,
        2,
        1
      ),
      security_complexity: ratingFromCount(includes.security_policies.length, 2, 1),
      dependency_burden: ratingFromCount(closure.size, 40, 15),
      migration_risk: "medium" as OrdinalRating,
    };
    scores.migration_risk = invertRating(
      scores.testability === "high" && scores.semantic_complexity === "low"
        ? "high"
        : scores.semantic_complexity
    );

    const manifest: ComponentManifest = {
      id,
      name: `${explore.label.replace(/^Explore:\s*/i, "")} Analysis`,
      business_domain: domain,
      scope_mode: scopeMode,
      grain: `explore grain for ${exploreName}`,
      root_explores: [exploreName],
      selected_consumers: consumerLabels,
      includes,
      source_assets: sources,
      target_assets: targets,
      depends_on_components: [],
      excluded,
      deferred: [],
      unresolved_dependencies: unresolved,
      acceptance_tests: defaultAcceptanceTests(exploreName, scopeMode),
      risks,
      owner: null,
      confidence: issuesFor.some((i) => i.severity === "error")
        ? "low"
        : issuesFor.some((i) => i.severity === "warn")
          ? "medium"
          : "high",
      rationale: `Rooted at explore ${exploreName}; upstream closure only (${closure.size} nodes). Scope=${scopeMode}. Shared sources do not pull sibling explores.`,
      scores,
      node_ids: Array.from(closure),
      is_foundation: false,
    };

    const atomic = atomicityCheck(graph, closure, manifest);
    manifest.atomic = atomic.ok;
    manifest.atomicity_failures = atomic.failures;

    drafts.push(manifest);
    closures.push({ id: manifest.id, nodes: closure });
  }

  // Merge hard-dependency cycles across explores into one component
  for (const cycle of detectCycles(graph)) {
    const exploreIdsInCycle = cycle.filter((id) => getNode(graph, id)?.type === "explore");
    if (exploreIdsInCycle.length < 2) continue;
    const involved = drafts.filter((d) =>
      d.node_ids?.some((nid) => cycle.includes(nid))
    );
    if (involved.length < 2) continue;
    const mergedNodes = new Set<string>();
    for (const c of involved) for (const n of c.node_ids ?? []) mergedNodes.add(n);
    for (const id of cycle) mergedNodes.add(id);
    const primary = involved[0];
    primary.id = slugify(involved.map((c) => c.id).join("-"));
    primary.name = `Merged: ${involved.map((c) => c.root_explores[0]).join(" + ")}`;
    primary.root_explores = involved.flatMap((c) => c.root_explores);
    primary.selected_consumers = Array.from(
      new Set(involved.flatMap((c) => c.selected_consumers))
    );
    primary.node_ids = Array.from(mergedNodes);
    primary.includes = collectIncludes(graph, mergedNodes);
    primary.rationale +=
      " Merged because hard-dependency cycle required co-migration.";
    primary.risks.push("Merged due to hard dependency cycle");
    primary.confidence = "low";
    const drop = new Set(involved.slice(1).map((c) => c.id));
    for (let i = drafts.length - 1; i >= 0; i--) {
      if (drop.has(drafts[i].id)) drafts.splice(i, 1);
    }
  }

  // Shared foundations: repeated looker_view / transformation with coherent multi-use
  const repeated = findRepeatedUpstreamSubgraphs(closures).filter((r) => {
    const n = getNode(graph, r.nodeId);
    return (
      n &&
      (n.type === "looker_view" ||
        n.type === "derived_table" ||
        n.type === "transformation" ||
        n.type === "security_policy") &&
      !n.metadata?.availabilityOnly
    );
  });

  const foundationCandidates = new Map<string, string[]>();
  for (const r of repeated) {
    if (r.consumerComponentIds.length < 2) continue;
    const n = getNode(graph, r.nodeId)!;
    // Prefer dimension-like shared views (name heuristics)
    const key = n.identity.object ?? n.label;
    if (!foundationCandidates.has(key)) foundationCandidates.set(key, []);
    for (const c of r.consumerComponentIds) foundationCandidates.get(key)!.push(c);
  }

  for (const [key, comps] of foundationCandidates) {
    const uniqueComps = Array.from(new Set(comps));
    if (uniqueComps.length < 2) continue;
    // Avoid creating foundation for every shared source table — only views/transforms
    const sampleNode = graph.nodes.find(
      (n) =>
        (n.identity.object === key || n.label.includes(key)) &&
        n.type !== "source"
    );
    if (!sampleNode || sampleNode.type === "source") continue;
    if (sampleNode.type === "semantic_field") continue;

    const foundationId = slugify(`foundation-${key}`);
    if (drafts.some((d) => d.id === foundationId)) continue;

    const foundationClosure = upstreamClosure(graph, [sampleNode.id], { stopAt });
    const foundation: ComponentManifest = {
      id: foundationId,
      name: `Foundation: ${key}`,
      business_domain: "shared",
      scope_mode: scopeMode,
      grain: `shared dimension/transform: ${key}`,
      root_explores: [],
      selected_consumers: uniqueComps,
      includes: collectIncludes(graph, foundationClosure),
      source_assets: [...foundationClosure]
        .map((id) => getNode(graph, id))
        .filter((n) => n?.type === "source")
        .map((n) => n!.label),
      target_assets: [],
      depends_on_components: [],
      excluded: [],
      deferred: [],
      unresolved_dependencies: [],
      acceptance_tests: [
        {
          description: `Foundation ${key} keys and attributes match across consumer components`,
          tolerance: "exact",
        },
      ],
      risks: ["Must remain a stable interface for multiple consumers"],
      owner: null,
      confidence: "medium",
      rationale:
        "Repeated upstream subgraph with multiple genuine consumers; proposed as shared foundation with stable interface — not merely high centrality.",
      is_foundation: true,
      node_ids: Array.from(foundationClosure),
      scores: {
        business_value: "high",
        usage: "high",
        data_readiness: "medium",
        owner_availability: "medium",
        testability: "high",
        semantic_complexity: "medium",
        unsupported_features: "low",
        security_complexity: "low",
        dependency_burden: "low",
        migration_risk: "medium",
      },
    };
    const atomic = atomicityCheck(graph, foundationClosure, foundation);
    foundation.atomic = atomic.ok;
    foundation.atomicity_failures = atomic.failures;
    drafts.unshift(foundation);

    for (const c of drafts) {
      if (uniqueComps.includes(c.id) && !c.is_foundation) {
        if (!c.depends_on_components.includes(foundationId)) {
          c.depends_on_components.push(foundationId);
        }
      }
    }
  }

  const waves = buildMigrationWaves(drafts);
  const recommended = recommendFirst(drafts, waves);
  const questions = buildQuestions(drafts, graph, scopeMode);

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    scope_mode_default: scopeMode,
    inventory_summary: inventorySummary,
    components: drafts,
    waves,
    recommended_first: recommended,
    questions,
  };
}

export function buildMigrationWaves(components: ComponentManifest[]): MigrationWave[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const remaining = new Set(components.map((c) => c.id));
  const waves: MigrationWave[] = [];
  let waveNum = 1;

  // Wave 0-ish: foundations first
  const foundations = components.filter((c) => c.is_foundation).map((c) => c.id);
  if (foundations.length) {
    waves.push({
      wave: waveNum++,
      label: "Shared foundation components",
      component_ids: foundations,
      justification:
        "Stable shared interfaces must land before dependent business semantics.",
    });
    for (const id of foundations) remaining.delete(id);
  }

  while (remaining.size) {
    const ready = [...remaining].filter((id) => {
      const c = byId.get(id)!;
      return c.depends_on_components.every((d) => !remaining.has(d));
    });
    const batch = ready.length ? ready : [...remaining].slice(0, 1);
    const hasSourcesOnly = batch.every((id) => {
      const c = byId.get(id)!;
      return c.root_explores.length === 0 && !c.is_foundation;
    });
    waves.push({
      wave: waveNum++,
      label: hasSourcesOnly
        ? "Source and transformation prerequisites"
        : "Business semantic components",
      component_ids: batch,
      justification: hasSourcesOnly
        ? "Upstream sources/transforms required before semantic contracts."
        : "Explore-rooted semantic contracts after foundations/prerequisites.",
    });
    for (const id of batch) remaining.delete(id);
  }

  // Consumer wave note — consumers migrate with their component; explicit final wave if any orphan consumers deferred
  const deferredConsumers = components.flatMap((c) => c.deferred);
  if (deferredConsumers.length) {
    waves.push({
      wave: waveNum++,
      label: "Dashboards and other consumers",
      component_ids: [],
      justification: `Deferred consumers: ${deferredConsumers.join(", ")}`,
    });
  }

  return waves;
}

function recommendFirst(
  components: ComponentManifest[],
  waves: MigrationWave[]
): string | null {
  const nonFoundation = components.filter((c) => !c.is_foundation && c.atomic !== false);
  if (!nonFoundation.length) {
    return components.find((c) => c.is_foundation)?.id ?? components[0]?.id ?? null;
  }
  // Prefer medium complexity, has consumers, earlier wave
  const waveIndex = new Map<string, number>();
  for (const w of waves) {
    for (const id of w.component_ids) waveIndex.set(id, w.wave);
  }

  const scored = [...nonFoundation].sort((a, b) => {
    const aUsage = a.scores?.usage === "high" ? 2 : a.scores?.usage === "medium" ? 1 : 0;
    const bUsage = b.scores?.usage === "high" ? 2 : b.scores?.usage === "medium" ? 1 : 0;
    const aComplex =
      a.scores?.semantic_complexity === "low" ? 2 : a.scores?.semantic_complexity === "medium" ? 1 : 0;
    const bComplex =
      b.scores?.semantic_complexity === "low" ? 2 : b.scores?.semantic_complexity === "medium" ? 1 : 0;
    const aWave = waveIndex.get(a.id) ?? 99;
    const bWave = waveIndex.get(b.id) ?? 99;
    return bUsage + bComplex - aWave - (aUsage + aComplex - bWave);
  });
  return scored[0]?.id ?? null;
}

function buildQuestions(
  components: ComponentManifest[],
  graph: DependencyGraph,
  scopeMode: ScopeMode
): string[] {
  const qs: string[] = [
    `Confirm scope mode: currently ${scopeMode}. Switch to ${
      scopeMode === "consumer-parity" ? "explore-retirement" : "consumer-parity"
    } if the other better matches your goal.`,
  ];
  for (const c of components) {
    if (!c.owner) qs.push(`Who owns component "${c.name}"?`);
    if (c.confidence === "low") {
      qs.push(`Review low-confidence boundaries for "${c.name}": ${c.risks[0] ?? "see risks"}`);
    }
    if (c.grain.startsWith("explore grain")) {
      qs.push(`Confirm business grain for "${c.name}" (replace explore-default grain).`);
    }
  }
  if (graph.issues.some((i) => i.kind === "many_to_many")) {
    qs.push("Many-to-many joins detected — confirm fan-out handling before migration.");
  }
  if (graph.issues.some((i) => i.kind === "user_attribute")) {
    qs.push("User-attribute security detected — confirm Databricks row-filter mapping.");
  }
  return Array.from(new Set(qs));
}

/** Compare two scope-mode plans for the same graph (for chat presentation). */
export function compareScopeModes(
  graph: DependencyGraph,
  summary: EnvironmentInventorySummary,
  base?: Omit<PlanOptions, "scopeMode">
): { consumerParity: ComponentPlan; exploreRetirement: ComponentPlan } {
  return {
    consumerParity: proposeComponents(graph, summary, {
      ...base,
      scopeMode: "consumer-parity",
    }),
    exploreRetirement: proposeComponents(graph, summary, {
      ...base,
      scopeMode: "explore-retirement",
    }),
  };
}

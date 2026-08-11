/**
 * Validate and serialize atomic migration component manifests.
 */

import { stringify, parse } from "yaml";
import type {
  ComponentManifest,
  ComponentPlan,
  ScopeMode,
} from "@/lib/migration/dependency-types";

export interface ManifestValidationIssue {
  path: string;
  message: string;
}

const SCOPE_MODES: ScopeMode[] = ["consumer-parity", "explore-retirement"];

export function validateComponentManifest(
  manifest: ComponentManifest
): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = [];
  if (!manifest.id?.trim()) issues.push({ path: "id", message: "id is required" });
  if (!manifest.name?.trim()) issues.push({ path: "name", message: "name is required" });
  if (!manifest.business_domain?.trim()) {
    issues.push({ path: "business_domain", message: "business_domain is required" });
  }
  if (!SCOPE_MODES.includes(manifest.scope_mode)) {
    issues.push({
      path: "scope_mode",
      message: `scope_mode must be one of ${SCOPE_MODES.join(", ")}`,
    });
  }
  if (!manifest.grain?.trim()) issues.push({ path: "grain", message: "grain is required" });
  if (!manifest.is_foundation && !manifest.root_explores?.length) {
    issues.push({
      path: "root_explores",
      message: "non-foundation components need at least one root explore",
    });
  }
  if (!manifest.acceptance_tests?.length) {
    issues.push({
      path: "acceptance_tests",
      message: "at least one acceptance test is required for atomicity",
    });
  } else {
    manifest.acceptance_tests.forEach((t, i) => {
      if (!t.description?.trim()) {
        issues.push({
          path: `acceptance_tests[${i}].description`,
          message: "description is required",
        });
      }
    });
  }
  if (!manifest.includes) {
    issues.push({ path: "includes", message: "includes block is required" });
  }
  return issues;
}

export function validateComponentPlan(plan: ComponentPlan): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = [];
  const ids = new Set<string>();
  for (const [i, c] of plan.components.entries()) {
    if (ids.has(c.id)) {
      issues.push({ path: `components[${i}].id`, message: `duplicate id ${c.id}` });
    }
    ids.add(c.id);
    for (const issue of validateComponentManifest(c)) {
      issues.push({ ...issue, path: `components[${i}].${issue.path}` });
    }
    for (const dep of c.depends_on_components) {
      if (!ids.has(dep) && !plan.components.some((x) => x.id === dep)) {
        // may appear later — check after loop
      }
    }
  }
  for (const [i, c] of plan.components.entries()) {
    for (const dep of c.depends_on_components) {
      if (!plan.components.some((x) => x.id === dep)) {
        issues.push({
          path: `components[${i}].depends_on_components`,
          message: `unknown dependency ${dep}`,
        });
      }
    }
  }
  if (
    plan.recommended_first &&
    !plan.components.some((c) => c.id === plan.recommended_first)
  ) {
    issues.push({
      path: "recommended_first",
      message: `recommended_first ${plan.recommended_first} not in components`,
    });
  }
  return issues;
}

export function componentPlanToYaml(plan: ComponentPlan): string {
  // Omit bulky node_ids from default YAML export (kept in JSON graph artifacts)
  const slim: ComponentPlan = {
    ...plan,
    components: plan.components.map((c) => {
      const { node_ids: _nodeIds, scores, ...rest } = c;
      return { ...rest, scores };
    }),
  };
  return stringify(slim, { lineWidth: 100, sortMapEntries: false });
}

export function parseComponentPlanYaml(text: string): ComponentPlan {
  return parse(text) as ComponentPlan;
}

export function emptyManifest(partial: Partial<ComponentManifest> & Pick<ComponentManifest, "id" | "name">): ComponentManifest {
  return {
    business_domain: "unspecified",
    scope_mode: "consumer-parity",
    grain: "unspecified",
    root_explores: [],
    selected_consumers: [],
    includes: {
      views: [],
      fields: [],
      joins: [],
      transformations: [],
      security_policies: [],
    },
    source_assets: [],
    target_assets: [],
    depends_on_components: [],
    excluded: [],
    deferred: [],
    unresolved_dependencies: [],
    acceptance_tests: [],
    risks: [],
    owner: null,
    confidence: "medium",
    rationale: "",
    ...partial,
  };
}

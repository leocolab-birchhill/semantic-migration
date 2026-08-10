/**
 * Agent-driven reconciliation overrides: per-tile query-plan patches and
 * compare-policy knobs. Validated and applied by the worker — never arbitrary
 * code execution.
 */

import {
  canonicalizeFieldName,
  stripLookerFieldPrefix,
} from "@/lib/migration/query-builder";
import type { CompareConfig } from "@/lib/migration/comparator";

export interface QueryPlanFilterPatch {
  field: string;
  expression: string;
}

/** Per-test Databricks WHERE / filter overrides from diagnosis. */
export interface QueryPlanPatch {
  /** Must match TestCase.name / tile title. */
  testName: string;
  /** Looker-style field → expression filters (merged on top of extracted filters). */
  filters: QueryPlanFilterPatch[];
  /**
   * Extra SQL predicates using backtick-quoted bare identifiers only
   * (e.g. `month_date` <= `anchor_month`). Validated before apply.
   */
  predicates: string[];
  rationale: string;
}

/** Compare-policy overrides (global or per-test). */
export interface ComparePolicyPatch {
  /** Empty string = apply globally to all tests. */
  testName: string;
  /** -1 means leave job decimalScale unchanged. */
  decimalScale: number;
  /** Non-empty replaces automatic key-column detection for that scope. */
  forceKeyColumns: string[];
  rationale: string;
}

/** Platform/runtime defect the agent cannot fix via assets or plan patches. */
export interface RuntimeDefect {
  present: boolean;
  /** e.g. filter_compiler, comparator, field_mapping */
  component: string;
  summary: string;
  repro: string;
}

export interface ReconciliationOverrides {
  queryPlanPatches: QueryPlanPatch[];
  comparePatches: ComparePolicyPatch[];
  updatedAt: string;
}

/** Dimensions allowed in safe plan patches, including fields added by the same diagnosis. */
export function collectAllowedPlanDimensions(
  exposedMetricViewDimensions: string[],
  inventoryDimensionNames: string[]
): string[] {
  return Array.from(
    new Set(
      [...exposedMetricViewDimensions, ...inventoryDimensionNames]
        .map((name) => stripLookerFieldPrefix(name).trim())
        .filter(Boolean)
    )
  );
}

/** Optional human context must not block safe patches already returned by diagnose. */
export function shouldPauseDiagnosis(input: {
  needsHumanInput: boolean;
  semanticPatchCount: number;
  mappingPatchCount: number;
  hasPlanOrComparePatch: boolean;
  onlyRuntimeDefect: boolean;
}): boolean {
  const actionable =
    input.semanticPatchCount > 0 ||
    input.mappingPatchCount > 0 ||
    input.hasPlanOrComparePatch;
  return input.onlyRuntimeDefect || (input.needsHumanInput && !actionable);
}

export interface FailureTestEvidence {
  name: string;
  summary: string;
  status?: string;
  /** Required dashboard/Look benchmark vs synthetic smoke/schema evidence. */
  mandatory?: boolean;
  columnDiffs: unknown[];
  unresolvedLookerFields?: string[];
  metricViewName?: string;
  databricksSql?: string;
  lookerSql?: string;
  filterExpression?: string;
  filters?: Record<string, string>;
  predicates?: string[];
  lookerRowCount?: number;
  databricksRowCount?: number;
  mismatchKind?: string;
}

const UNSAFE_SQL =
  /;|--|\/\*|\*\'|xp_|into\s+outfile|information_schema|system\.|execute\s+immediate/i;

function stripBalancedOuterParens(input: string): string {
  let s = input.trim();
  for (;;) {
    if (!s.startsWith("(") || !s.endsWith(")")) return s;
    let depth = 0;
    let quoted = false;
    let enclosesAll = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "'" && s[i - 1] !== "\\") quoted = !quoted;
      if (quoted) continue;
      if (s[i] === "(") depth++;
      if (s[i] === ")") depth--;
      if (depth === 0 && i < s.length - 1) {
        enclosesAll = false;
        break;
      }
    }
    if (!enclosesAll || depth !== 0 || quoted) return s;
    s = s.slice(1, -1).trim();
  }
}

function splitTopLevelBoolean(input: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "'" && input[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth !== 0) continue;
    const rest = input.slice(i);
    const match = rest.match(/^\s+(AND|OR)\s+/i);
    if (!match) continue;
    parts.push(input.slice(start, i).trim());
    i += match[0].length - 1;
    start = i + 1;
  }
  if (parts.length === 0) return null;
  parts.push(input.slice(start).trim());
  return parts;
}

function isAllowedPredicateShape(input: string): boolean {
  const stripped = stripBalancedOuterParens(input);
  const compounds = splitTopLevelBoolean(stripped);
  if (compounds) {
    return compounds.every(
      (part) => part.length > 0 && isAllowedPredicateShape(part)
    );
  }

  const allowedAtoms = [
    /^ID\s*(>=|<=|<>|!=|=|>|<)\s*ID$/i,
    /^ID\s*(>=|<=|<>|!=|=|>|<)\s*-?\d+(\.\d+)?$/i,
    /^ID\s*(>=|<=|<>|!=|=|>|<)\s*'[^']*'$/i,
    /^ID\s+IS\s+(NOT\s+)?NULL$/i,
    /^(CAST\(ID AS STRING\)|ID)\s+(NOT\s+)?LIKE\s+'[^']*'$/i,
    /^LOWER\(CAST\(ID AS STRING\)\)\s+(NOT\s+)?LIKE\s+'[^']*'$/i,
    /^CAST\(ID AS STRING\)\s*(>=|<=|<>|!=|=|>|<)\s*CAST\(ID AS STRING\)$/i,
    /^CAST\(ID AS STRING\)\s*<=\s*CAST\(YEAR\(CURRENT_TIMESTAMP\(\)\) AS STRING\)$/i,
    /^TRY_CAST\(ID AS INT\)\s*<=\s*YEAR\(CURRENT_DATE\(\)\)$/i,
    /^TRY_CAST\(ID AS INT\)\s*<=\s*YEAR\(CURRENT_TIMESTAMP\(\)\)$/i,
    /^ID\s*<=\s*YEAR\(CURRENT_DATE\(\)\)$/i,
    /^ID\s*<=\s*YEAR\(CURRENT_TIMESTAMP\(\)\)$/i,
  ];
  return allowedAtoms.some((re) => re.test(stripped));
}

/** Reject predicates that aren't safe dimension comparisons. */
export function validatePredicateSql(
  predicate: string,
  allowedBareNames: Set<string>
): { ok: true } | { ok: false; reason: string } {
  const p = predicate.trim();
  if (!p) return { ok: false, reason: "empty predicate" };
  if (p.length > 500) return { ok: false, reason: "predicate too long" };
  if (UNSAFE_SQL.test(p)) {
    return { ok: false, reason: "predicate contains disallowed SQL" };
  }
  if (p.includes("${")) {
    return {
      ok: false,
      reason:
        "predicate contains an unresolved Looker ${...} template — use backtick dimension names instead",
    };
  }

  const idents = [...p.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (idents.length === 0) {
    return {
      ok: false,
      reason: "predicate must quote dimension names in backticks",
    };
  }
  if (allowedBareNames.size > 0) {
    for (const ident of idents) {
      const bare = canonicalizeFieldName(ident);
      if (!allowedBareNames.has(bare)) {
        return {
          ok: false,
          reason: `unknown dimension "${ident}" in predicate`,
        };
      }
    }
  }

  const stripped = p
    .replace(/`[^`]+`/g, "ID")
    .replace(/\s+/g, " ")
    .trim();

  if (!isAllowedPredicateShape(stripped)) {
    return { ok: false, reason: `predicate shape not allowed: ${p}` };
  }

  return { ok: true };
}

export function emptyOverrides(): ReconciliationOverrides {
  return {
    queryPlanPatches: [],
    comparePatches: [],
    updatedAt: new Date().toISOString(),
  };
}

export function mergeQueryPlanPatches(
  existing: QueryPlanPatch[],
  incoming: QueryPlanPatch[]
): QueryPlanPatch[] {
  const byName = new Map<string, QueryPlanPatch>();
  for (const p of existing) {
    if (p.testName.trim()) byName.set(p.testName, p);
  }
  for (const p of incoming) {
    if (!p.testName.trim()) continue;
    const prev = byName.get(p.testName);
    if (!prev) {
      byName.set(p.testName, {
        testName: p.testName,
        filters: [...(p.filters ?? [])],
        predicates: [...(p.predicates ?? [])],
        rationale: p.rationale ?? "",
      });
      continue;
    }
    const filterMap = new Map(
      prev.filters.map((f) => [canonicalizeFieldName(f.field), f])
    );
    for (const f of p.filters ?? []) {
      filterMap.set(canonicalizeFieldName(f.field), f);
    }
    const preds = new Set([...prev.predicates, ...(p.predicates ?? [])]);
    byName.set(p.testName, {
      testName: p.testName,
      filters: [...filterMap.values()],
      predicates: [...preds],
      rationale: p.rationale || prev.rationale,
    });
  }
  return [...byName.values()];
}

export function mergeComparePatches(
  existing: ComparePolicyPatch[],
  incoming: ComparePolicyPatch[]
): ComparePolicyPatch[] {
  const byKey = new Map<string, ComparePolicyPatch>();
  for (const p of existing) {
    byKey.set(p.testName.trim(), p);
  }
  for (const p of incoming) {
    byKey.set(p.testName.trim(), p);
  }
  return [...byKey.values()];
}

export function mergeOverrides(
  current: ReconciliationOverrides,
  incoming: {
    queryPlanPatches?: QueryPlanPatch[];
    comparePatches?: ComparePolicyPatch[];
  }
): ReconciliationOverrides {
  return {
    queryPlanPatches: mergeQueryPlanPatches(
      current.queryPlanPatches,
      incoming.queryPlanPatches ?? []
    ),
    comparePatches: mergeComparePatches(
      current.comparePatches,
      incoming.comparePatches ?? []
    ),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate and sanitize agent query-plan patches against known dimension names.
 */
export function sanitizeQueryPlanPatches(
  patches: QueryPlanPatch[],
  allowedDimensionNames: string[]
): { accepted: QueryPlanPatch[]; rejected: Array<{ testName: string; reason: string }> } {
  const allowed = new Set(
    allowedDimensionNames.map((n) => canonicalizeFieldName(n))
  );
  const accepted: QueryPlanPatch[] = [];
  const rejected: Array<{ testName: string; reason: string }> = [];

  for (const patch of patches ?? []) {
    if (!patch.testName?.trim()) {
      rejected.push({ testName: "", reason: "missing testName" });
      continue;
    }
    const filters: QueryPlanFilterPatch[] = [];
    for (const f of patch.filters ?? []) {
      if (!f.field?.trim() || f.expression == null) continue;
      const bare = canonicalizeFieldName(f.field);
      if (!allowed.has(bare) && allowed.size > 0) {
        // Allow through if inventory empty (early); otherwise reject unknown dims
        rejected.push({
          testName: patch.testName,
          reason: `filter field "${f.field}" not in metric-view dimensions`,
        });
        continue;
      }
      if (String(f.expression).length > 500 || UNSAFE_SQL.test(f.expression)) {
        rejected.push({
          testName: patch.testName,
          reason: `unsafe filter expression on "${f.field}"`,
        });
        continue;
      }
      if (String(f.expression).includes("${")) {
        // Looker ${view.field} templates compile into string literals and
        // produce CAST errors — cross-field conditions belong in predicates.
        rejected.push({
          testName: patch.testName,
          reason: `filter expression on "${f.field}" contains an unresolved Looker \${...} template`,
        });
        continue;
      }
      filters.push({
        field: stripLookerFieldPrefix(f.field),
        expression: String(f.expression).trim(),
      });
    }

    const predicates: string[] = [];
    for (const pred of patch.predicates ?? []) {
      const check = validatePredicateSql(pred, allowed);
      if (!check.ok) {
        rejected.push({ testName: patch.testName, reason: check.reason });
        continue;
      }
      predicates.push(pred.trim());
    }

    if (filters.length === 0 && predicates.length === 0) {
      rejected.push({
        testName: patch.testName,
        reason: "no valid filters or predicates",
      });
      continue;
    }

    accepted.push({
      testName: patch.testName.trim(),
      filters,
      predicates,
      rationale: patch.rationale ?? "",
    });
  }

  return { accepted, rejected };
}

export function sanitizeComparePatches(
  patches: ComparePolicyPatch[]
): ComparePolicyPatch[] {
  return (patches ?? [])
    .filter((p) => p && typeof p.rationale === "string")
    .map((p) => ({
      testName: (p.testName ?? "").trim(),
      decimalScale:
        typeof p.decimalScale === "number" && p.decimalScale >= 0
          ? Math.min(12, Math.floor(p.decimalScale))
          : -1,
      forceKeyColumns: (p.forceKeyColumns ?? [])
        .map((c) => stripLookerFieldPrefix(String(c)).trim())
        .filter(Boolean)
        .slice(0, 20),
      rationale: p.rationale ?? "",
    }))
    .filter(
      (p) => p.decimalScale >= 0 || p.forceKeyColumns.length > 0
    );
}

export function resolveCompareConfigForTest(
  base: CompareConfig,
  overrides: ReconciliationOverrides,
  testName: string
): CompareConfig {
  const globalPatch = overrides.comparePatches.find((p) => !p.testName);
  const testPatch = overrides.comparePatches.find((p) => p.testName === testName);

  let decimalScale = base.decimalScale;
  let forceKeyColumns = base.forceKeyColumns;

  for (const patch of [globalPatch, testPatch]) {
    if (!patch) continue;
    if (patch.decimalScale >= 0) decimalScale = patch.decimalScale;
    if (patch.forceKeyColumns.length > 0) {
      forceKeyColumns = patch.forceKeyColumns;
    }
  }

  return { ...base, decimalScale, forceKeyColumns };
}

export function resolveQueryPlanForTest(
  overrides: ReconciliationOverrides,
  testName: string
): { filters: Record<string, string>; predicates: string[] } | undefined {
  const patch = overrides.queryPlanPatches.find((p) => p.testName === testName);
  if (!patch) return undefined;
  const filters: Record<string, string> = {};
  for (const f of patch.filters) {
    filters[f.field] = f.expression;
  }
  return {
    filters,
    predicates: [...patch.predicates],
  };
}

export function formatRuntimeDefect(defect: RuntimeDefect | undefined): string | undefined {
  if (!defect?.present) return undefined;
  const parts = [
    `Runtime defect (${defect.component || "unknown"})`,
    defect.summary,
  ];
  if (defect.repro?.trim()) parts.push(`Repro: ${defect.repro.trim()}`);
  return parts.filter(Boolean).join(" — ");
}

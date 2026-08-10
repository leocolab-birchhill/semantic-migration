/**
 * Deterministic COALESCE(..., 0) repair for Looker-vs-Databricks null↔0 gaps.
 * Looker often returns 0 for empty aggregate groups; Databricks MEASURE() returns null.
 * Only wraps measures named in failure diffs — never blanket-rewrites healthy measures.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ProposedAsset } from "@/lib/migration/types";
import type { FailureTestEvidence } from "@/lib/migration/reconciliation-overrides";
import { isNullVsZeroMismatch } from "@/lib/migration/comparator";

export { isNullVsZeroMismatch } from "@/lib/migration/comparator";

function bareColumn(name: string): string {
  const s = String(name ?? "").trim();
  if (!s) return "";
  return s.includes(".") ? s.slice(s.lastIndexOf(".") + 1) : s;
}

/** Measure column names whose sample diffs are predominantly null↔0. */
export function measuresNeedingCoalesceZero(
  failedTests: FailureTestEvidence[]
): string[] {
  const counts = new Map<string, { nullZero: number; other: number }>();

  for (const t of failedTests) {
    for (const raw of t.columnDiffs ?? []) {
      const d = raw as {
        column?: string;
        lookerValue?: unknown;
        databricksValue?: unknown;
        rowIndex?: number;
      };
      // Skip key-set membership samples (rowIndex -1).
      if (d.rowIndex === -1) continue;
      const col = bareColumn(d.column ?? "");
      if (!col) continue;
      const entry = counts.get(col.toLowerCase()) ?? {
        nullZero: 0,
        other: 0,
      };
      if (isNullVsZeroMismatch(d.lookerValue, d.databricksValue)) {
        entry.nullZero++;
      } else {
        entry.other++;
      }
      counts.set(col.toLowerCase(), entry);
    }
  }

  const out: string[] = [];
  for (const [name, c] of counts) {
    if (c.nullZero > 0 && c.nullZero >= c.other) {
      out.push(name);
    }
  }
  return out;
}

/**
 * Wrap an aggregate measure expr in COALESCE(..., 0) when not already coalesced.
 * Leaves non-aggregate / already-coalesced exprs unchanged.
 */
export function ensureAggregateCoalesceZero(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) return trimmed;
  if (/^coalesce\s*\(/i.test(trimmed)) return trimmed;
  // Only wrap when the top-level expression looks aggregate-ish.
  if (
    !/\b(sum|count|count_if|count_distinct|avg|average|mean|min|max|median|any_value|bool_or|bool_and)\s*\(/i.test(
      trimmed
    )
  ) {
    return trimmed;
  }
  return `COALESCE(${trimmed}, 0)`;
}

export function applyNullZeroCoalesceRepair(
  assets: ProposedAsset[],
  failedTests: FailureTestEvidence[]
): { assets: ProposedAsset[]; patchedMeasures: string[] } {
  const targets = new Set(
    measuresNeedingCoalesceZero(failedTests).map((n) => n.toLowerCase())
  );
  if (targets.size === 0) {
    return { assets, patchedMeasures: [] };
  }

  const patchedMeasures: string[] = [];

  const next = assets.map((asset) => {
    if (asset.type !== "metric_view" || !asset.yaml?.trim()) return asset;
    let doc: Record<string, unknown>;
    try {
      doc = parseYaml(asset.yaml) as Record<string, unknown>;
    } catch {
      return asset;
    }
    if (!doc || typeof doc !== "object") return asset;
    const measures = Array.isArray(doc.measures)
      ? (doc.measures as Record<string, unknown>[])
      : [];
    if (measures.length === 0) return asset;

    let changed = false;
    const updated = measures.map((m) => {
      const name = bareColumn(String(m?.name ?? "")).toLowerCase();
      if (!name || !targets.has(name)) return m;
      const expr = typeof m.expr === "string" ? m.expr : "";
      const wrapped = ensureAggregateCoalesceZero(expr);
      if (!expr || wrapped === expr.trim()) return m;
      changed = true;
      if (!patchedMeasures.includes(name)) patchedMeasures.push(name);
      return { ...m, expr: wrapped };
    });

    if (!changed) return asset;
    return {
      ...asset,
      yaml: stringifyYaml({ ...doc, measures: updated }, {
        lineWidth: 0,
      }),
    };
  });

  return { assets: next, patchedMeasures };
}

/** True when every value-diff sample across failures is null↔0 (no other cell diffs). */
export function failuresAreOnlyNullVsZero(
  failedTests: FailureTestEvidence[]
): boolean {
  let sawValueDiff = false;
  for (const t of failedTests) {
    if (t.status === "query_compilation_error" || t.status === "error") {
      return false;
    }
    for (const raw of t.columnDiffs ?? []) {
      const d = raw as {
        lookerValue?: unknown;
        databricksValue?: unknown;
        rowIndex?: number;
      };
      if (d.rowIndex === -1) continue;
      sawValueDiff = true;
      if (!isNullVsZeroMismatch(d.lookerValue, d.databricksValue)) {
        return false;
      }
    }
  }
  return sawValueDiff;
}

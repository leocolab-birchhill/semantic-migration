/**
 * Databricks metric-view dimension/measure exprs resolve against the *source*
 * relation only — not sibling fields in the same YAML. Looker often writes
 * ${view.other_dim}; those must be inlined (or materialized on the sql_view).
 *
 * This module performs a single-level, name-scoped inline when a field expr
 * references another dimension/measure name from the same metric view.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

function bareName(field: string): string {
  const s = String(field ?? "").trim();
  if (!s) return "";
  return s.includes(".") ? s.slice(s.lastIndexOf(".") + 1) : s;
}

/** Names that collide with SQL aggregates — never auto-inline these as siblings. */
const SQL_FUNCTION_NAMES = new Set([
  "count",
  "sum",
  "avg",
  "average",
  "mean",
  "min",
  "max",
  "median",
  "coalesce",
  "cast",
  "if",
  "iff",
  "nullif",
  "nvl",
  "greatest",
  "least",
  "any_value",
  "bool_or",
  "bool_and",
  "count_if",
  "count_distinct",
]);

function listFieldNodes(
  doc: Record<string, unknown>
): Array<{ key: "fields" | "dimensions" | "measures"; node: Record<string, unknown> }> {
  const out: Array<{
    key: "fields" | "dimensions" | "measures";
    node: Record<string, unknown>;
  }> = [];
  for (const key of ["fields", "dimensions", "measures"] as const) {
    const list = doc[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      out.push({ key, node: item as Record<string, unknown> });
    }
  }
  return out;
}

/**
 * Extract unresolved column names from Databricks UNRESOLVED_COLUMN errors.
 * Handles both bare `` `col` `` and qualified `` `alias`.`col` `` forms —
 * always returns the column (never the table alias alone).
 */
export function parseUnresolvedColumnNames(errorMessage: string): string[] {
  const cols: string[] = [];
  const primary =
    /(?:column|parameter)\s+with\s+name\s+(?:[`']([A-Za-z_][\w$]*)[`']\.)?[`']([A-Za-z_][\w$]*)[`']\s+cannot\s+be\s+resolved/i.exec(
      errorMessage
    ) ??
    /UNRESOLVED_COLUMN[^\n]*?\bname\s+(?:[`']([A-Za-z_][\w$]*)[`']\.)?[`']([A-Za-z_][\w$]*)[`']/i.exec(
      errorMessage
    ) ??
    /Column\s+(?:[`']([A-Za-z_][\w$]*)[`']\.)?[`']([A-Za-z_][\w$]*)[`']\s+cannot\s+be\s+resolved/i.exec(
      errorMessage
    );
  // Group 2 is the column when qualified (alias.col); group 1 is the column when bare
  // (and group 2 is undefined). Prefer the rightmost captured identifier.
  const col = primary?.[2] ?? primary?.[1];
  if (col) cols.push(col);
  return cols;
}

/**
 * Parse "Did you mean …" suggestions from UNRESOLVED_COLUMN.WITH_SUGGESTION.
 * Prefers `*_cad` when both currency variants are offered (Looker CAD default).
 */
export function parseUnresolvedColumnSuggestions(
  errorMessage: string
): string[] {
  const block =
    /Did you mean[^[]*\[([^\]]+)\]/i.exec(errorMessage)?.[1] ??
    /Did you mean one of the following\?\s*\[([^\]]+)\]/i.exec(errorMessage)?.[1];
  if (!block) return [];

  const names: string[] = [];
  const re = /(?:[`']([A-Za-z_][\w$]*)[`']\.)?[`']([A-Za-z_][\w$]*)[`']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    names.push(m[2] ?? m[1]);
  }
  return names;
}

/** Prefer *_cad over *_usd (and first suggestion otherwise). */
export function preferCadSuggestion(suggestions: string[]): string | null {
  if (!suggestions.length) return null;
  const cad = suggestions.find((s) => /_cad$/i.test(s));
  if (cad) return cad;
  return suggestions[0] ?? null;
}

/**
 * Rewrite unresolved identifiers in SQL using Databricks suggestions
 * (e.g. customer_gross_profit → customer_gross_profit_cad).
 * Preserves table/alias qualifiers (`t`.`col` / t.col).
 */
export function rewriteSqlUnresolvedColumns(
  sql: string,
  replacements: Array<{ from: string; to: string }>
): { sql: string; replaced: Array<{ from: string; to: string }> } {
  let next = sql;
  const replaced: Array<{ from: string; to: string }> = [];
  for (const { from, to } of replacements) {
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    const re = new RegExp(
      `(^|[^A-Za-z0-9_\`])(?:\`${escapeRegExp(from)}\`|${escapeRegExp(from)})(?![A-Za-z0-9_])`,
      "gi"
    );
    if (!re.test(next)) continue;
    re.lastIndex = 0;
    next = next.replace(re, (_m, prefix: string) => {
      replaced.push({ from, to });
      return `${prefix}\`${to}\``;
    });
  }
  return { sql: next, replaced };
}

/**
 * Replace identifier refs to sibling field names with that sibling's expr
 * (wrapped in parentheses). One level only — does not recursively expand.
 *
 * @param onlyNames when set, only inline references to these bare names
 *   (used after UNRESOLVED_COLUMN for a specific missing column).
 */
export function inlineSiblingMetricViewRefs(
  yamlText: string,
  onlyNames?: string[]
): { yaml: string; inlined: Array<{ field: string; usedSibling: string }> } {
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(yamlText) as Record<string, unknown>;
  } catch {
    return { yaml: yamlText, inlined: [] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { yaml: yamlText, inlined: [] };
  }

  const nodes = listFieldNodes(doc);
  const exprByName = new Map<string, string>();
  for (const { node } of nodes) {
    const name = bareName(String(node.name ?? "")).toLowerCase();
    const expr = typeof node.expr === "string" ? node.expr.trim() : "";
    if (name && expr) exprByName.set(name, expr);
  }

  const allow = onlyNames?.length
    ? new Set(onlyNames.map((n) => bareName(n).toLowerCase()).filter(Boolean))
    : null;

  const inlined: Array<{ field: string; usedSibling: string }> = [];
  let changed = false;

  for (const { node } of nodes) {
    const self = bareName(String(node.name ?? ""));
    const selfKey = self.toLowerCase();
    const expr = typeof node.expr === "string" ? node.expr : "";
    if (!self || !expr.trim()) continue;

    let next = expr;
    for (const [sibName, sibExpr] of exprByName) {
      if (sibName === selfKey) continue;
      if (allow && !allow.has(sibName)) continue;
      // Never treat SQL aggregate/window function names as sibling field refs.
      // A measure named `count` must not rewrite `COUNT(DISTINCT …)` / `COUNT(*)`.
      if (SQL_FUNCTION_NAMES.has(sibName) && !allow) continue;
      // Skip trivial self-passthrough siblings (name === expr) — replacing
      // `sector` with `(sector)` is noise; only inline when sibling has real logic
      // OR when we're targeting an UNRESOLVED name (allow set).
      const trivial =
        bareName(sibExpr).toLowerCase() === sibName &&
        !/[^A-Za-z0-9_`.]/.test(sibExpr.replace(/`/g, ""));
      if (trivial && !allow) continue;

      // Match `sib` or bare sib as a SQL identifier (not a substring).
      // Negative lookahead for `(` so COUNT( / SUM( stay function calls.
      const re = new RegExp(
        `(^|[^A-Za-z0-9_\`])(?:\`${escapeRegExp(sibName)}\`|${escapeRegExp(sibName)})(?![A-Za-z0-9_])(?!\\s*\\()`,
        "gi"
      );
      if (!re.test(next)) continue;
      re.lastIndex = 0;
      next = next.replace(re, (_m, prefix: string) => {
        inlined.push({ field: self, usedSibling: sibName });
        return `${prefix}(${sibExpr})`;
      });
    }

    if (next !== expr) {
      node.expr = next;
      changed = true;
    }
  }

  if (!changed) return { yaml: yamlText, inlined: [] };

  return {
    yaml: stringifyYaml(doc, {
      lineWidth: 0,
      defaultKeyType: "PLAIN",
      defaultStringType: "PLAIN",
    }).trim(),
    inlined,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

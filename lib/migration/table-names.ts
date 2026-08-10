/**
 * Normalize Looker/Databricks table references for dependency matching.
 * Handles backticks, double quotes, brackets, and 1–3 part names.
 */

export interface NormalizedTableRef {
  catalog: string | null;
  schema: string | null;
  table: string;
  /** Lowercased dotted form for comparison: catalog.schema.table or schema.table or table */
  canonical: string;
  /** All match keys that should hit this table (qualified + short forms). */
  matchKeys: string[];
}

function stripQuotes(part: string): string {
  const trimmed = part.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Strip trailing SQL aliases (`table AS alias`) and trailing punctuation so
 * LookML/SQL refs normalize to a bare table identifier.
 */
export function stripSqlAlias(raw: string): string {
  let s = raw.trim().replace(/;+\s*$/, "").trim();
  // FROM/JOIN targets often appear as `schema.table AS alias`
  s = s.replace(/\s+(?:as|AS)\s+[a-zA-Z_][a-zA-Z0-9_]*\s*$/, "").trim();
  return s;
}

/** Split a possibly quoted multi-part identifier on unquoted dots. */
export function splitQualifiedName(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];

  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        // Escaped quote (`` or "")
        if (s[i + 1] === quote) {
          current += ch + ch;
          i++;
          continue;
        }
        quote = null;
        current += ch;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "`" || ch === '"' || ch === "'" || ch === "[") {
      quote = ch === "[" ? "]" : ch;
      current += ch;
      continue;
    }

    if (ch === ".") {
      parts.push(stripQuotes(current));
      current = "";
      continue;
    }

    current += ch;
  }

  if (current) parts.push(stripQuotes(current));
  return parts.filter(Boolean);
}

export function normalizeTableRef(
  raw: string,
  defaults?: { catalog?: string; schema?: string }
): NormalizedTableRef | null {
  const parts = splitQualifiedName(stripSqlAlias(raw));
  if (parts.length === 0) return null;

  let catalog: string | null = null;
  let schema: string | null = null;
  let table: string;

  if (parts.length === 1) {
    table = parts[0];
    schema = defaults?.schema ?? null;
    catalog = defaults?.catalog ?? null;
  } else if (parts.length === 2) {
    schema = parts[0];
    table = parts[1];
    catalog = defaults?.catalog ?? null;
  } else {
    catalog = parts[parts.length - 3];
    schema = parts[parts.length - 2];
    table = parts[parts.length - 1];
  }

  if (!table) return null;

  const c = catalog?.toLowerCase() ?? null;
  const sch = schema?.toLowerCase() ?? null;
  const t = table.toLowerCase();

  const matchKeys = new Set<string>([t]);
  if (sch) matchKeys.add(`${sch}.${t}`);
  if (c && sch) matchKeys.add(`${c}.${sch}.${t}`);

  const canonical =
    c && sch ? `${c}.${sch}.${t}` : sch ? `${sch}.${t}` : t;

  return {
    catalog: catalog,
    schema: schema,
    table,
    canonical,
    matchKeys: Array.from(matchKeys),
  };
}

/** Build match keys for a Databricks source table. */
export function sourceTableMatchKeys(
  catalog: string,
  schema: string,
  table: string
): string[] {
  const ref = normalizeTableRef(`${catalog}.${schema}.${table}`);
  return ref?.matchKeys ?? [table.toLowerCase()];
}

/**
 * True if haystack (LookML sql_table_name, derived SQL, or generated SQL)
 * references the target Databricks table.
 */
export function referencesTable(
  haystack: string | null | undefined,
  catalog: string,
  schema: string,
  table: string
): boolean {
  if (!haystack) return false;
  const keys = sourceTableMatchKeys(catalog, schema, table);
  const lowered = haystack.toLowerCase();

  // Strip common quote chars for substring matching of qualified names
  const flattened = lowered.replace(/[`"'\[\]]/g, "");

  for (const key of keys) {
    if (flattened.includes(key)) return true;
  }

  // Also try matching each sql_table_name-like token in the haystack
  const tokenRe =
    /(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[a-zA-Z0-9_]+)(?:\.(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[a-zA-Z0-9_]+)){0,2}/g;
  const tokens = haystack.match(tokenRe) ?? [];
  for (const token of tokens) {
    const ref = normalizeTableRef(token, { catalog, schema });
    if (!ref) continue;
    for (const key of ref.matchKeys) {
      if (keys.includes(key)) return true;
    }
  }

  return false;
}

/** Extract sql_table_name values from LookML text. */
export function extractSqlTableNames(lookml: string): string[] {
  const results: string[] = [];
  const re = /sql_table_name\s*:\s*([^\n{;]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lookml)) !== null) {
    const value = stripSqlAlias(m[1].trim().replace(/;;\s*$/, "").trim());
    if (value) results.push(value);
  }
  return results;
}

/** Extract derived_table sql: blocks (best-effort). */
export function extractDerivedTableSql(lookml: string): string[] {
  const results: string[] = [];
  const re = /derived_table\s*:\s*\{[\s\S]*?sql\s*:\s*([\s\S]*?)\s*;;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lookml)) !== null) {
    const sql = m[1].trim();
    if (sql) results.push(sql);
  }
  return results;
}

/**
 * Best-effort extraction of 2–3 part table refs from SQL (FROM/JOIN targets).
 * Skips single-token aliases.
 */
export function extractQualifiedTableRefsFromSql(sql: string): string[] {
  const results: string[] = [];
  const re =
    /(?:from|join)\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[a-zA-Z_][a-zA-Z0-9_]*)(?:\.(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[a-zA-Z_][a-zA-Z0-9_]*)){1,2})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const value = stripSqlAlias(m[1].trim());
    if (value) results.push(value);
  }
  return results;
}

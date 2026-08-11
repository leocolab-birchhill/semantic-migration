/**
 * Lightweight LookML structural parsers for dependency-graph construction.
 * Intentionally heuristic — evidence kinds distinguish confidence.
 */

export interface ParsedInclude {
  path: string;
}

export interface ParsedExtend {
  viewName: string;
  extends: string[];
}

export interface ParsedRefine {
  viewName: string;
}

export interface ParsedViewBlock {
  name: string;
  sqlTableName?: string;
  derivedTableSql?: string;
  /** Parent view names from LookML `extends: [...]`. */
  extendsViews: string[];
  hasLiquid: boolean;
  hasUserAttributes: boolean;
  hasDynamicSql: boolean;
}

export interface ParsedExploreJoin {
  name: string;
  type?: string;
  sqlOn?: string;
  relationship?: string;
  foreignKey?: string;
}

export interface ParsedExploreBlock {
  name: string;
  viewName?: string;
  joins: ParsedExploreJoin[];
  hasLiquid: boolean;
  hasUserAttributes: boolean;
}

const LIQUID_RE = /\{\%|\{\{/;
const USER_ATTR_RE = /_user_attributes\[|user_attribute/i;
const DYNAMIC_SQL_RE = /sql:\s*\$\{|execute_as|sql_trigger_value/i;

export function parseIncludes(contents: string): ParsedInclude[] {
  const out: ParsedInclude[] = [];
  const re = /include:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contents))) {
    out.push({ path: m[1] });
  }
  return out;
}

export function parseViewBlocks(contents: string): ParsedViewBlock[] {
  const views: ParsedViewBlock[] = [];
  const re = /view:\s*([A-Za-z0-9_]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contents))) {
    const name = m[1];
    const body = extractBalancedBlock(contents, m.index + m[0].length - 1);
    const sqlTable = body.match(/sql_table_name:\s*([^\n;]+)/)?.[1]?.trim();
    const derived = body.match(
      /derived_table:\s*\{[\s\S]*?sql:\s*([\s\S]*?);;/
    )?.[1];
    const extendsMatch = body.match(/extends:\s*\[([^\]]+)\]/);
    const extendsViews = extendsMatch
      ? extendsMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/["']/g, ""))
          .filter(Boolean)
      : [];
    views.push({
      name,
      sqlTableName: sqlTable?.replace(/;;\s*$/, "").trim(),
      derivedTableSql: derived?.trim(),
      extendsViews,
      hasLiquid: LIQUID_RE.test(body),
      hasUserAttributes: USER_ATTR_RE.test(body),
      hasDynamicSql: DYNAMIC_SQL_RE.test(body) || Boolean(derived && LIQUID_RE.test(derived)),
    });
  }
  return views;
}

export function parseExploreBlocks(contents: string): ParsedExploreBlock[] {
  const explores: ParsedExploreBlock[] = [];
  const re = /explore:\s*([A-Za-z0-9_]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contents))) {
    const name = m[1];
    const body = extractBalancedBlock(contents, m.index + m[0].length - 1);
    const viewName = body.match(/view_name:\s*([A-Za-z0-9_]+)/)?.[1];
    const joins: ParsedExploreJoin[] = [];
    const joinRe = /join:\s*([A-Za-z0-9_]+)\s*\{/g;
    let jm: RegExpExecArray | null;
    while ((jm = joinRe.exec(body))) {
      const joinBody = extractBalancedBlock(body, jm.index + jm[0].length - 1);
      joins.push({
        name: jm[1],
        type: joinBody.match(/type:\s*([A-Za-z0-9_]+)/)?.[1],
        sqlOn: joinBody.match(/sql_on:\s*([^;]+)/)?.[1]?.trim(),
        relationship: joinBody.match(/relationship:\s*([A-Za-z0-9_]+)/)?.[1],
        foreignKey: joinBody.match(/foreign_key:\s*([A-Za-z0-9_.]+)/)?.[1],
      });
    }
    explores.push({
      name,
      viewName,
      joins,
      hasLiquid: LIQUID_RE.test(body),
      hasUserAttributes: USER_ATTR_RE.test(body),
    });
  }
  return explores;
}

export function parseRefinements(contents: string): ParsedRefine[] {
  const out: ParsedRefine[] = [];
  const re = /view:\s*\+\s*([A-Za-z0-9_]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contents))) {
    out.push({ viewName: m[1] });
  }
  return out;
}

export function parseExtends(contents: string): ParsedExtend[] {
  return parseViewBlocks(contents)
    .filter((v) => v.extendsViews.length > 0)
    .map((v) => ({ viewName: v.name, extends: v.extendsViews }));
}

/** Extract `{...}` body starting at the opening brace index. */
export function extractBalancedBlock(text: string, openBraceIndex: number): string {
  if (text[openBraceIndex] !== "{") return "";
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(openBraceIndex + 1, i);
    }
  }
  return text.slice(openBraceIndex + 1);
}

export function detectManyToMany(relationship?: string): boolean {
  return (relationship ?? "").toLowerCase().replace(/_/g, "") === "manytomany";
}

export function detectFanOut(relationship?: string): boolean {
  const r = (relationship ?? "").toLowerCase().replace(/_/g, "");
  return r === "onetomany" || r === "manytomany";
}

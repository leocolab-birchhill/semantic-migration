/**
 * Build Databricks SQL against a Unity Catalog metric view.
 * Dimensions are selected directly; measures use MEASURE(...); grouped queries use GROUP BY ALL.
 * Looker-style filters are applied as WHERE predicates so missing filters fail parity.
 */

export function stripLookerFieldPrefix(field: string): string {
  const parts = field.split(".");
  return parts[parts.length - 1];
}

export function canonicalizeFieldName(field: string): string {
  return stripLookerFieldPrefix(field).toLowerCase();
}

export interface MetricViewQueryInput {
  catalog: string;
  schema: string;
  viewName: string;
  fields: string[];
  measureNames: Set<string>;
  limit?: number;
  /** Looker filters: field → filter expression string. */
  filters?: Record<string, string>;
  /**
   * Extra SQL WHERE fragments (already translated), e.g. cross-field
   * comparisons from Looker filter_expression.
   */
  predicates?: string[];
  sorts?: string[];
  /** Metric view parameters to pass to the table-valued function. */
  parameters?: Record<string, string>;
}

export interface ParsedLookerFilterExpression {
  /** Field → Looker filter expression (matches_filter contents). */
  filters: Record<string, string>;
  /** Extra SQL predicates using bare field names in backticks. */
  predicates: string[];
}

function sqlLiteral(raw: string): string {
  if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, "''")}'`;
}

function escIdent(ident: string): string {
  return ident.replace(/`/g, "``");
}

/**
 * Translate Looker dashboard filter_expression into field filters + SQL predicates.
 * Supports matches_filter, ${field} cmp literal, ${a} cmp ${b}, and
 * concat(${year},"") <= concat(extract_years(now()),"").
 */
export function parseLookerFilterExpression(
  expression: string | undefined
): ParsedLookerFilterExpression {
  const filters: Record<string, string> = {};
  const predicates: string[] = [];
  if (!expression?.trim()) return { filters, predicates };

  const text = expression.replace(/\s+/g, " ").trim();
  const parts = text.split(/\s+AND\s+/i);

  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;

    const mf = p.match(
      /^matches_filter\(\s*\$\{([^}]+)\}\s*,\s*`([^`]*)`\s*\)$/i
    );
    if (mf) {
      const field = mf[1].trim();
      const expr = mf[2].trim();
      if (field && expr) {
        filters[field] = filters[field] ? `${filters[field]},${expr}` : expr;
      }
      continue;
    }

    const yearNow = p.match(
      /^concat\(\s*\$\{([^}]+)\}\s*,\s*""\s*\)\s*<=\s*concat\(\s*extract_years\(\s*now\(\s*\)\s*\)\s*,\s*""\s*\)$/i
    );
    if (yearNow) {
      const bare = stripLookerFieldPrefix(yearNow[1].trim());
      predicates.push(
        `CAST(\`${escIdent(bare)}\` AS STRING) <= CAST(YEAR(CURRENT_TIMESTAMP()) AS STRING)`
      );
      continue;
    }

    const cross = p.match(
      /^\$\{([^}]+)\}\s*(>=|<=|<>|!=|=|>|<)\s*\$\{([^}]+)\}$/
    );
    if (cross) {
      const left = stripLookerFieldPrefix(cross[1].trim());
      const op = cross[2] === "!=" ? "<>" : cross[2];
      const right = stripLookerFieldPrefix(cross[3].trim());
      predicates.push(
        `\`${escIdent(left)}\` ${op} \`${escIdent(right)}\``
      );
      continue;
    }

    const lit = p.match(
      /^\$\{([^}]+)\}\s*(>=|<=|<>|!=|=|>|<)\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))$/
    );
    if (lit) {
      const bare = stripLookerFieldPrefix(lit[1].trim());
      const op = lit[2] === "!=" ? "<>" : lit[2];
      const raw = lit[3] ?? lit[4] ?? lit[5] ?? "";
      predicates.push(`\`${escIdent(bare)}\` ${op} ${sqlLiteral(raw)}`);
      continue;
    }
  }

  return { filters, predicates };
}

/**
 * Translate a Looker filter value into a simple SQL predicate.
 * Supports equality, comma lists (incl. % wildcards), -NULL, and basic comparisons.
 */
export function lookerFilterToSql(
  field: string,
  expression: string
): string | null {
  const bare = stripLookerFieldPrefix(field);
  const col = `\`${escIdent(bare)}\``;
  const expr = expression.trim();
  if (!expr) return null;

  if (expr === "-NULL" || expr.toLowerCase() === "not null") {
    return `${col} IS NOT NULL`;
  }
  if (expr === "NULL" || expr.toLowerCase() === "is null") {
    return `${col} IS NULL`;
  }

  // Comparison operators: >=10, <5, etc.
  const cmp = expr.match(/^(>=|<=|<>|!=|>|<)\s*(.+)$/);
  if (cmp) {
    const op = cmp[1] === "!=" ? "<>" : cmp[1];
    const raw = cmp[2].trim();
    return `${col} ${op} ${sqlLiteral(raw)}`;
  }

  // Comma-separated list → IN / NOT IN / NOT LIKE (Looker "-x,-y" / "-%2013%").
  // Positive tokens may also be NULL or comparisons ("NULL,>=20000" on numeric
  // dims must become `col IS NULL OR col >= 20000`, never IN ('NULL','>=20000')).
  if (expr.includes(",")) {
    const parts = expr.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      // In list context the "-" prefix is Looker exclusion (even "-0").
      const negations = parts.filter((p) => p.startsWith("-"));
      if (negations.length === parts.length) {
        const notNull = negations.some(
          (p) => p.slice(1).trim().toUpperCase() === "NULL"
        );
        const values = negations
          .map((p) => p.slice(1).trim())
          .filter((p) => p.toUpperCase() !== "NULL");
        const exact = values.filter((p) => !p.includes("%"));
        const likes = values.filter((p) => p.includes("%"));
        const clauses: string[] = [];
        if (exact.length) {
          const inClause = `${col} NOT IN (${exact.map(sqlLiteral).join(", ")})`;
          clauses.push(notNull ? inClause : `(${inClause} OR ${col} IS NULL)`);
        }
        for (const pattern of likes) {
          const like = `CAST(${col} AS STRING) NOT LIKE '${pattern.replace(/'/g, "''")}'`;
          clauses.push(notNull ? like : `(${like} OR ${col} IS NULL)`);
        }
        if (notNull) clauses.push(`${col} IS NOT NULL`);
        if (clauses.length) return clauses.join(" AND ");
      } else {
        const positives = parts.filter((p) => !p.startsWith("-"));
        const negatives = parts
          .filter((p) => p.startsWith("-"))
          .map((p) => p.slice(1).trim())
          .filter(Boolean);

        const orClauses: string[] = [];
        const exact: string[] = [];
        let includeNull = false;
        for (const p of positives) {
          if (p.toUpperCase() === "NULL") {
            includeNull = true;
            continue;
          }
          const cmpTok = p.match(/^(>=|<=|<>|!=|>|<)\s*(.+)$/);
          if (cmpTok) {
            const op = cmpTok[1] === "!=" ? "<>" : cmpTok[1];
            orClauses.push(`${col} ${op} ${sqlLiteral(cmpTok[2].trim())}`);
            continue;
          }
          if (p.includes("%")) {
            orClauses.push(
              `CAST(${col} AS STRING) LIKE '${p.replace(/'/g, "''")}'`
            );
            continue;
          }
          exact.push(p);
        }
        if (exact.length) {
          orClauses.unshift(`${col} IN (${exact.map(sqlLiteral).join(", ")})`);
        }
        if (includeNull) orClauses.push(`${col} IS NULL`);

        const negClauses = negatives.map((v) =>
          v.includes("%")
            ? `CAST(${col} AS STRING) NOT LIKE '${v.replace(/'/g, "''")}'`
            : `${col} <> ${sqlLiteral(v)}`
        );

        const positive =
          orClauses.length === 0
            ? null
            : orClauses.length === 1
              ? orClauses[0]
              : `(${orClauses.join(" OR ")})`;
        const all = [positive, ...negClauses].filter(
          (c): c is string => Boolean(c)
        );
        if (all.length) return all.join(" AND ");
      }
    }
  }

  // Single negation: "-value" / "-%pat%" excludes it but keeps NULLs (Looker
  // semantics). Only a fully numeric token ("-5") is a negative literal —
  // "-10630US" is an exclusion of "10630US".
  if (expr.startsWith("-") && !/^-\d+(\.\d+)?$/.test(expr)) {
    const value = expr.slice(1).trim();
    if (value) {
      if (value.includes("%")) {
        return `(CAST(${col} AS STRING) NOT LIKE '${value.replace(/'/g, "''")}' OR ${col} IS NULL)`;
      }
      return `(${col} <> ${sqlLiteral(value)} OR ${col} IS NULL)`;
    }
  }

  // Wildcard equality
  if (expr.includes("%")) {
    return `CAST(${col} AS STRING) LIKE '${expr.replace(/'/g, "''")}'`;
  }

  // Default: equality
  return `${col} = ${sqlLiteral(expr)}`;
}

export function buildMetricViewSelect(input: MetricViewQueryInput): string {
  const esc = (s: string) => s.replace(/`/g, "``");
  const limit = input.limit ?? 100;

  const selectParts: string[] = [];
  const hasMeasures = input.fields.some((f) =>
    input.measureNames.has(canonicalizeFieldName(f))
  );

  for (const field of input.fields) {
    const bare = stripLookerFieldPrefix(field);
    const isMeasure = input.measureNames.has(canonicalizeFieldName(field));
    if (isMeasure) {
      selectParts.push(`MEASURE(\`${esc(bare)}\`) AS \`${esc(bare)}\``);
    } else {
      selectParts.push(`\`${esc(bare)}\``);
    }
  }

  if (selectParts.length === 0) {
    selectParts.push("*");
  }

  const from = `\`${esc(input.catalog)}\`.\`${esc(input.schema)}\`.\`${esc(input.viewName)}\``;
  const params = input.parameters && Object.keys(input.parameters).length > 0
    ? `(${Object.entries(input.parameters).map(([k, v]) => `${k} => ${sqlLiteral(v)}`).join(", ")})`
    : "";
  const fromWithParams = `${from}${params}`;

  const wherePartsSet = new Set<string>();
  const whereParts: string[] = [];
  const addWherePart = (clause: string) => {
    if (!wherePartsSet.has(clause)) {
      wherePartsSet.add(clause);
      whereParts.push(clause);
    }
  };
  if (input.filters) {
    for (const [field, expression] of Object.entries(input.filters)) {
      const predicate = lookerFilterToSql(field, expression);
      if (predicate) addWherePart(predicate);
    }
  }
  if (input.predicates) {
    for (const predicate of input.predicates) {
      if (predicate?.trim()) addWherePart(predicate.trim());
    }
  }
  const where =
    whereParts.length > 0 ? `\nWHERE ${whereParts.join(" AND ")}` : "";

  const orderParts: string[] = [];
  const selectedBare = new Set(
    input.fields.map((f) => canonicalizeFieldName(stripLookerFieldPrefix(f)))
  );
  if (input.sorts) {
    for (const sort of input.sorts) {
      const desc = sort.trim().toLowerCase().endsWith(" desc");
      const field = sort.replace(/\s+desc$/i, "").replace(/\s+asc$/i, "").trim();
      const bare = stripLookerFieldPrefix(field);
      const bareKey = canonicalizeFieldName(bare);
      const isMeasure = input.measureNames.has(canonicalizeFieldName(field));
      // Prefer the SELECT alias when the measure is already projected —
      // MEASURE(alias) is invalid. Use MEASURE() only for sort keys omitted
      // from SELECT (common when Looker sorts by an out-of-inventory measure).
      const orderExpr =
        isMeasure && !selectedBare.has(bareKey)
          ? `MEASURE(\`${esc(bare)}\`)`
          : `\`${esc(bare)}\``;
      orderParts.push(`${orderExpr}${desc ? " DESC" : ""}`);
    }
  }
  // Stable default when the Looker tile has no sorts — avoids arbitrary LIMIT samples.
  if (orderParts.length === 0) {
    const firstDim = input.fields.find(
      (f) => !input.measureNames.has(canonicalizeFieldName(f))
    );
    if (firstDim) {
      orderParts.push(`\`${esc(stripLookerFieldPrefix(firstDim))}\``);
    }
  }
  const orderBy =
    orderParts.length > 0 ? `\nORDER BY ${orderParts.join(", ")}` : "";

  // Looker always aggregates: dimension-only queries return distinct combos,
  // so GROUP BY ALL is required even without measures for row parity.
  const groupBy =
    hasMeasures || input.fields.length > 0 ? "\nGROUP BY ALL" : "";
  return `SELECT ${selectParts.join(", ")} FROM ${fromWithParams}${where}${groupBy}${orderBy}\nLIMIT ${limit}`;
}

/** Build column type map from inventory field metadata. */
export function buildColumnTypes(
  fields: string[],
  inventory: {
    dimensions: Array<{ name: string; type: string }>;
    measures: Array<{ name: string; type: string }>;
  }
): Record<string, string> {
  const types: Record<string, string> = {};
  const dimMap = new Map(
    inventory.dimensions.map((d) => [canonicalizeFieldName(d.name), d.type])
  );
  const measureMap = new Map(
    inventory.measures.map((m) => [canonicalizeFieldName(m.name), m.type])
  );

  for (const field of fields) {
    const key = canonicalizeFieldName(field);
    const bare = stripLookerFieldPrefix(field);
    types[bare] = measureMap.get(key) ?? dimMap.get(key) ?? "string";
    types[field] = types[bare];
    types[key] = types[bare];
  }
  return types;
}

export function measureNameSet(
  measures: Array<{ name: string }>
): Set<string> {
  return new Set(measures.map((m) => canonicalizeFieldName(m.name)));
}

/**
 * Pick the metric view asset for a benchmark/test.
 * Prefers explicit metricViewName, then explore-named asset, then first metric_view.
 */
export function resolveMetricViewAsset<
  T extends { type: string; name: string },
>(
  assets: T[],
  opts?: { metricViewName?: string; explore?: string }
): T | undefined {
  const metricViews = assets.filter((a) => a.type === "metric_view");
  if (opts?.metricViewName) {
    const exact = metricViews.find(
      (a) => a.name.toLowerCase() === opts.metricViewName!.toLowerCase()
    );
    if (exact) return exact;
  }
  if (opts?.explore) {
    const suggested = opts.explore
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const byExplore = metricViews.find(
      (a) =>
        a.name.toLowerCase() === suggested ||
        a.name.toLowerCase().includes(suggested)
    );
    if (byExplore) return byExplore;
  }
  return metricViews[0] ?? assets[0];
}

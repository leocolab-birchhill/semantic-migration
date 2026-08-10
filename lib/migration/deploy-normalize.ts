import { enrichMetricViewYamlWithAgentMetadata } from "@/lib/migration/agent-metadata";
import { inlineSiblingMetricViewRefs } from "@/lib/migration/sibling-inline";
import type {
  IntermediateRepresentation,
  ProposedAsset,
} from "@/lib/migration/types";
import { parseDocument } from "yaml";

/** Strip markdown fences the model sometimes wraps around SQL/YAML. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:sql|yaml|yml|json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Strip a leading CREATE [OR REPLACE] VIEW ... AS if the model included full DDL.
 * Deploy always wraps the body with our catalog/schema/name.
 */
export function normalizeSqlViewBody(sql: string): string {
  let body = stripCodeFences(sql);

  // Strip accidental LANGUAGE YAML / WITH METRICS wrappers if dumped into sql
  body = body.replace(
    /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:`[^`]+`(?:\.`[^`]+`){0,2}|[\w.]+)\s+WITH\s+METRICS\s+(?:LANGUAGE\s+YAML\s+)?AS\s*(?:\$\$[\s\S]*?\$\$|'[\s\S]*')\s*;?\s*$/i,
    ""
  );
  if (!body.trim()) {
    throw new Error("sql_view body was empty after stripping metric-view DDL");
  }

  const createMatch = body.match(
    /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`(?:\.`[^`]+`){0,2}|[\w.]+)\s+AS\s+/i
  );
  if (createMatch) {
    body = body.slice(createMatch[0].length).trim();
  }

  // Trailing semicolon is fine for Databricks but normalize away for composition
  body = body.replace(/;\s*$/, "").trim();

  if (!/^(WITH\b|SELECT\b|\()/i.test(body)) {
    throw new Error(
      `sql_view body must start with WITH, SELECT, or '(' after normalization; got: ${body.slice(0, 80)}`
    );
  }

  return body;
}

/**
 * Return only the YAML document for a metric view.
 * Strips fences, CREATE VIEW wrappers, and dollar-quoted AS bodies.
 * Also quotes SQL scalars that would break YAML (e.g. CASE with 'Matched: ...').
 */
export function normalizeMetricViewYaml(yaml: string): string {
  let text = stripCodeFences(yaml);

  // Full DDL: CREATE ... WITH METRICS [LANGUAGE YAML] AS $$...$$ or AS '...'
  const dollarDdl = text.match(
    /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:`[^`]+`(?:\.`[^`]+`){0,2}|[\w.]+)[\s\S]*?\bAS\s*\$\$([\s\S]*?)\$\$\s*;?\s*$/i
  );
  if (dollarDdl) {
    text = dollarDdl[1].trim();
  } else {
    const singleDdl = text.match(
      /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:`[^`]+`(?:\.`[^`]+`){0,2}|[\w.]+)[\s\S]*?\bAS\s*'([\s\S]*)'\s*;?\s*$/i
    );
    if (singleDdl) {
      text = singleDdl[1].replace(/''/g, "'").trim();
    }
  }

  // Bare $$...$$ wrapper without CREATE
  const bareDollar = text.match(/^\$\$([\s\S]*)\$\$\s*;?\s*$/);
  if (bareDollar) {
    text = bareDollar[1].trim();
  }

  text = text.replace(/^\uFEFF/, "").trim();

  if (!/^(version|source|comment)\s*:/im.test(text)) {
    throw new Error(
      `metric_view yaml must contain version/source after normalization; got: ${text.slice(0, 80)}`
    );
  }

  const normalized = quoteYamlMetadataScalars(serializeYamlSqlScalars(text));
  validateMetricViewYaml(normalized);
  return normalized;
}

/** YAML plain scalars break on ": ", leading indicators, or " #" comments. */
function yamlPlainScalarIsUnsafe(value: string): boolean {
  return (
    /:\s/.test(value) ||
    value.endsWith(":") ||
    /\s#/.test(value) ||
    /^[&*!|>%@`"'{[\-?,]/.test(value)
  );
}

/**
 * Deterministically quote metadata string values the model tends to emit
 * unquoted with inner colons (e.g. `display_name: ACV Matched: Excluded`),
 * which otherwise fail YAML parsing. Also quotes synonym list items.
 */
export function quoteYamlMetadataScalars(yaml: string): string {
  const metadataKeys = /^(\s*(?:-\s+)?)(display_name|comment|description|label)(\s*:\s*)(.+)$/;
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let synonymsIndent: number | null = null;

  for (const line of lines) {
    // Track whether we're inside a `synonyms:` block scalar list.
    const synonymsHeader = line.match(/^(\s*)synonyms\s*:\s*$/);
    if (synonymsHeader) {
      synonymsIndent = synonymsHeader[1].length;
      out.push(line);
      continue;
    }
    if (synonymsIndent !== null) {
      const item = line.match(/^(\s*)-\s+(.*)$/);
      if (item && item[1].length > synonymsIndent) {
        const value = item[2].trimEnd();
        if (
          value !== "" &&
          !/^["']/.test(value) &&
          yamlPlainScalarIsUnsafe(value)
        ) {
          out.push(`${item[1]}- ${JSON.stringify(value)}`);
          continue;
        }
        out.push(line);
        continue;
      }
      if (line.trim() !== "") synonymsIndent = null;
    }

    const m = line.match(metadataKeys);
    if (!m) {
      out.push(line);
      continue;
    }
    const value = m[4].trimEnd();
    if (value === "" || /^["']/.test(value) || /^[|>][+-]?(?:\s|$)/.test(value)) {
      out.push(line);
      continue;
    }
    if (yamlPlainScalarIsUnsafe(value)) {
      out.push(`${m[1]}${m[2]}${m[3]}${JSON.stringify(value)}`);
    } else {
      out.push(line);
    }
  }

  return out.join("\n");
}

/**
 * Deterministically rewrite every inline SQL-bearing scalar as a block scalar.
 * This avoids YAML treating SQL backticks, colons, #, braces, or other indicator
 * characters as YAML syntax. Already quoted and block-style values remain intact.
 */
export function serializeYamlSqlScalars(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const m = line.match(/^(\s*)(expr|filter|on|'on')\s*:\s*(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }

    const indent = m[1];
    const key = m[2];
    const raw = m[3];
    const value = raw.trimEnd();

    // Empty, quoted, and existing block scalars are already valid YAML.
    if (
      value === "" ||
      /^["']/.test(value) ||
      /^[|>][+-]?(?:\s|$)/.test(value)
    ) {
      out.push(line);
      continue;
    }

    const contentIndent = `${indent}  `;
    out.push(`${indent}${key}: |-`);
    // Preserve intentional leading spaces in the SQL value if any
    out.push(`${contentIndent}${value.trim()}`);
  }

  return out.join("\n");
}

interface MetricViewDocument {
  version?: unknown;
  source?: unknown;
  dimensions?: unknown;
  fields?: unknown;
  measures?: unknown;
}

/** Parse and shape-check YAML locally so malformed definitions never reach Databricks. */
export function validateMetricViewYaml(yaml: string): void {
  const document = parseDocument(yaml, {
    prettyErrors: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    const details = document.errors.map((error) => error.message).join("; ");
    throw new Error(`Invalid metric-view YAML after normalization: ${details}`);
  }

  const value = document.toJS() as MetricViewDocument | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid metric-view YAML: document must be a mapping");
  }
  if (
    (typeof value.version !== "string" && typeof value.version !== "number") ||
    value.version === ""
  ) {
    throw new Error("Invalid metric-view YAML: version is required");
  }
  if (typeof value.source !== "string" || value.source.trim() === "") {
    throw new Error("Invalid metric-view YAML: source must be a non-empty string");
  }
  const fields = value.fields ?? value.dimensions;
  if (!Array.isArray(fields) && !Array.isArray(value.measures)) {
    throw new Error(
      "Invalid metric-view YAML: fields/dimensions or measures must be an array"
    );
  }
}

/**
 * Wrap YAML in Databricks dollar-quoted literals.
 * Databricks SQL only accepts plain $$...$$ (not PostgreSQL-style $tag$...$tag$).
 */
export function dollarQuote(content: string): string {
  if (content.includes("$$")) {
    throw new Error(
      "metric_view yaml contains '$$', which cannot be embedded in Databricks dollar-quoted literals"
    );
  }
  // Match documented form: AS $$\n<yaml>\n$$
  return `$$\n${content}\n$$`;
}

/**
 * Rewrite metric-view `source:` to the deployed three-part name when it
 * references a sql_view asset from this job (avoids wrong schema after rename).
 */
export function rewriteMetricViewSource(
  yaml: string,
  catalog: string,
  schema: string,
  sqlViewNames: string[]
): string {
  if (sqlViewNames.length === 0) return yaml;

  const nameSet = new Set(sqlViewNames.map((n) => n.toLowerCase()));
  return yaml.replace(
    /^(\s*source:\s*)(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m,
    (full, prefix: string, dq?: string, sq?: string, bare?: string) => {
      const raw = (dq ?? sq ?? bare ?? "").trim();
      if (!raw) return full;
      const parts = raw.replace(/`/g, "").split(".");
      const viewName = parts[parts.length - 1];
      if (!nameSet.has(viewName.toLowerCase())) return full;
      return `${prefix}${catalog}.${schema}.${viewName}`;
    }
  );
}

/**
 * If the metric view `source` does not already point at a job sql_view, point it
 * at the primary sql_view. Prevents TABLE_OR_VIEW_NOT_FOUND when the model left
 * source as the production table name that collides with the metric-view name,
 * or a bare name that resolves in the wrong schema.
 */
export function ensureMetricViewSourcesJobSqlView(
  yaml: string,
  catalog: string,
  schema: string,
  sqlViewNames: string[],
  /** Prefer this sql_view name when multiple exist (e.g. *_enriched). */
  preferredSqlViewName?: string
): { yaml: string; changed: boolean; source: string | null } {
  if (sqlViewNames.length === 0) {
    return { yaml, changed: false, source: null };
  }

  const preferred =
    (preferredSqlViewName &&
      sqlViewNames.find(
        (n) => n.toLowerCase() === preferredSqlViewName.toLowerCase()
      )) ||
    sqlViewNames.find((n) => /_enriched$|_base$|_prepared$/i.test(n)) ||
    sqlViewNames[0];

  const target = `${catalog}.${schema}.${preferred}`;
  const nameSet = new Set(sqlViewNames.map((n) => n.toLowerCase()));

  const match = yaml.match(
    /^(\s*source:\s*)(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m
  );
  if (!match) {
    // No source line — insert after version if present, else at top.
    const inserted = yaml.match(/^version:\s*.*$/m)
      ? yaml.replace(/^(version:\s*.*)$/m, `$1\nsource: ${target}`)
      : `source: ${target}\n${yaml}`;
    return { yaml: inserted, changed: true, source: target };
  }

  const raw = (match[2] ?? match[3] ?? match[4] ?? "").trim().replace(/`/g, "");
  const parts = raw.split(".");
  const viewName = parts[parts.length - 1]?.toLowerCase() ?? "";
  const alreadyJobSqlView = nameSet.has(viewName);
  const alreadyCorrectFqn =
    raw.toLowerCase() === target.toLowerCase() ||
    (parts.length === 3 &&
      parts[0].toLowerCase() === catalog.toLowerCase() &&
      parts[1].toLowerCase() === schema.toLowerCase() &&
      nameSet.has(viewName));

  if (alreadyJobSqlView && alreadyCorrectFqn) {
    return { yaml, changed: false, source: raw };
  }
  if (alreadyJobSqlView) {
    const next = rewriteMetricViewSource(yaml, catalog, schema, sqlViewNames);
    return {
      yaml: next,
      changed: next !== yaml,
      source: target,
    };
  }

  const next = yaml.replace(
    /^(\s*source:\s*)(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m,
    `$1${target}`
  );
  return { yaml: next, changed: true, source: target };
}

/** sql_views first (metric views often depend on them), then metric_views, then rest. */
export function sortAssetsForDeploy(assets: ProposedAsset[]): ProposedAsset[] {
  const rank = (type: ProposedAsset["type"]) => {
    if (type === "sql_view") return 0;
    if (type === "metric_view") return 1;
    return 2;
  };
  return [...assets].sort((a, b) => rank(a.type) - rank(b.type));
}

export function prepareSqlViewForDeploy(asset: ProposedAsset): string {
  if (!asset.sql?.trim()) {
    throw new Error(`sql_view ${asset.name} is missing sql`);
  }
  return normalizeSqlViewBody(asset.sql);
}

export function prepareMetricViewForDeploy(
  asset: ProposedAsset,
  catalog: string,
  schema: string,
  sqlViewNames: string[],
  inventory?: IntermediateRepresentation | null
): string {
  if (!asset.yaml?.trim()) {
    throw new Error(`metric_view ${asset.name} is missing yaml`);
  }
  const enriched = enrichMetricViewYamlWithAgentMetadata(
    normalizeMetricViewYaml(asset.yaml),
    inventory,
    asset.fieldMappings
  );
  const ensured = ensureMetricViewSourcesJobSqlView(
    normalizeMetricViewYaml(enriched),
    catalog,
    schema,
    sqlViewNames
  );
  const inlined = inlineSiblingMetricViewRefs(ensured.yaml);
  const yaml = rewriteMetricViewSource(
    inlined.yaml,
    catalog,
    schema,
    sqlViewNames
  );
  validateMetricViewYaml(yaml);
  return yaml;
}

/**
 * Deterministically clean model output before save/deploy.
 * Semantic content stays; DDL wrappers and fences are app-owned.
 */
export function sanitizeGeneratedAssets(
  assets: ProposedAsset[],
  catalog: string,
  schema: string,
  inventory?: IntermediateRepresentation | null
): ProposedAsset[] {
  const sqlViewNames = assets
    .filter((a) => a.type === "sql_view")
    .map((a) => a.name);

  return assets.map((asset) => {
    if (asset.type === "sql_view" && asset.sql?.trim()) {
      return { ...asset, sql: normalizeSqlViewBody(asset.sql), yaml: undefined };
    }
    if (asset.type === "metric_view" && asset.yaml?.trim()) {
      const enriched = enrichMetricViewYamlWithAgentMetadata(
        normalizeMetricViewYaml(asset.yaml),
        inventory,
        asset.fieldMappings ?? inventory?.fieldMapping?.entries
      );
      const ensured = ensureMetricViewSourcesJobSqlView(
        normalizeMetricViewYaml(enriched),
        catalog,
        schema,
        sqlViewNames
      );
      const inlined = inlineSiblingMetricViewRefs(ensured.yaml);
      const yaml = rewriteMetricViewSource(
        inlined.yaml,
        catalog,
        schema,
        sqlViewNames
      );
      validateMetricViewYaml(yaml);
      return {
        ...asset,
        sql: undefined,
        yaml,
      };
    }
    if (asset.type === "sql_view") {
      return { ...asset, yaml: undefined };
    }
    if (asset.type === "metric_view") {
      return { ...asset, sql: undefined };
    }
    return asset;
  });
}

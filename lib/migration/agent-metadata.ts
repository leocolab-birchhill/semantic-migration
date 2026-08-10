/**
 * Map Looker semantic metadata onto Databricks metric-view agent metadata
 * (YAML 1.1): display_name, comment, synonyms, format.
 * @see https://docs.databricks.com/aws/en/business-semantics/agent-metadata
 */

import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import {
  detectCurrency,
  looksLikeRatioOrPercent,
  normalizeCurrencyToken,
} from "@/lib/migration/field-mapping";
import type {
  FieldMappingEntry,
  IntermediateRepresentation,
  IrDimension,
  IrMeasure,
} from "@/lib/migration/types";

const MAX_DISPLAY = 255;
const MAX_SYNONYMS = 10;
const MAX_SYNONYM_LEN = 255;

export type DatabricksFormat = Record<string, unknown>;

interface LookerFieldMeta {
  name: string;
  label?: string;
  description?: string;
  valueFormat?: string;
  tags?: string[];
  type?: string;
  kind: "dimension" | "measure";
  currency?: string;
  unit?: string;
}

function bareName(field: string): string {
  return field.split(".").pop()!.trim();
}

function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim();
}

/** Title-case a snake_case / dotted technical name for display. */
export function humanizeFieldName(name: string): string {
  const bare = bareName(name)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!bare) return name;
  return bare.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function countDecimalPlaces(fmt: string): number | undefined {
  const m = fmt.match(/\.([0#]+)/);
  if (!m) return undefined;
  return Math.min(10, m[1].length);
}

function decimalPlacesSpec(
  places: number | undefined
): Record<string, unknown> | undefined {
  if (places == null) return undefined;
  return { type: "exact", places };
}

/**
 * Convert Looker value_format / type / currency hints into Databricks format.
 * Never assign numeric/percentage/currency formats to string-like Looker types —
 * Databricks rejects those with COLUMN_FORMAT_INCOMPATIBLE_WITH_COLUMN_TYPE.
 */
export function lookerValueFormatToDatabricksFormat(params: {
  valueFormat?: string;
  lookerType?: string;
  currency?: string;
  unit?: string;
  fieldName?: string;
  label?: string;
  description?: string;
}): DatabricksFormat | undefined {
  const fmt = (params.valueFormat ?? "").trim();
  const type = (params.lookerType ?? "").toLowerCase();
  const currency =
    normalizeCurrencyToken(params.currency) ??
    detectCurrency(
      params.fieldName,
      params.label,
      params.description,
      params.valueFormat
    );
  const unitHints = [
    params.unit,
    params.fieldName,
    params.label,
    params.description,
    params.valueFormat,
  ];

  if (
    type === "date" ||
    type === "date_only" ||
    (type.startsWith("date_") && !type.includes("time"))
  ) {
    return {
      type: "date",
      date_format: "year_month_day",
      leading_zeros: true,
    };
  }
  if (
    type === "date_time" ||
    type === "datetime" ||
    type === "timestamp" ||
    type === "time" ||
    type.includes("time")
  ) {
    return {
      type: "date_time",
      date_format: "year_month_day",
      time_format: "locale_hour_minute_second",
      leading_zeros: true,
    };
  }

  // String / categorical dimensions must not get numeric formats.
  if (isStringLikeLookerType(type)) {
    return undefined;
  }

  if (
    looksLikeRatioOrPercent(...unitHints) ||
    /%/.test(fmt) ||
    params.unit === "percent"
  ) {
    const places = countDecimalPlaces(fmt);
    const out: DatabricksFormat = { type: "percentage" };
    const dp = decimalPlacesSpec(places);
    if (dp) out.decimal_places = dp;
    return out;
  }

  const looksCurrency =
    params.unit === "currency" ||
    Boolean(currency) ||
    /\$|¤|cad|usd|eur|gbp/i.test(fmt) ||
    /\$/.test(fmt);

  if (looksCurrency && !looksLikeRatioOrPercent(...unitHints)) {
    const places = countDecimalPlaces(fmt) ?? 2;
    return {
      type: "currency",
      currency_code: currency ?? "USD",
      decimal_places: { type: "exact", places },
      hide_group_separator: false,
    };
  }

  if (fmt || params.unit === "count" || /count|sum|avg|number/i.test(type)) {
    const places = countDecimalPlaces(fmt);
    const out: DatabricksFormat = { type: "number" };
    const dp = decimalPlacesSpec(places);
    if (dp) out.decimal_places = dp;
    if (/0\.|#/.test(fmt) && !/,/.test(fmt)) {
      out.hide_group_separator = true;
    }
    return out;
  }

  return undefined;
}

/** Looker types that produce STRING (or non-numeric) Databricks columns. */
export function isStringLikeLookerType(type?: string): boolean {
  const t = (type ?? "").toLowerCase().trim();
  if (!t) return false;
  return (
    t === "string" ||
    t === "yesno" ||
    t === "tier" ||
    t === "zipcode" ||
    t === "location" ||
    t.includes("string")
  );
}

export function isNumericDatabricksFormat(format: unknown): boolean {
  if (!format || typeof format !== "object" || Array.isArray(format)) {
    return false;
  }
  const t = String((format as { type?: unknown }).type ?? "").toLowerCase();
  return t === "number" || t === "percentage" || t === "currency";
}

/** Heuristic: CASE/WHEN returning quoted literals is a string column. */
export function exprLooksLikeStringColumn(expr?: string): boolean {
  const s = (expr ?? "").trim();
  if (!s) return false;
  // Aggregate measures are numeric even when they wrap CASE.
  if (
    /^\s*(sum|count|count_if|count_distinct|avg|average|mean|min|max|median)\s*\(/i.test(
      s
    ) ||
    /^\s*coalesce\s*\(\s*(sum|count|avg|min|max)\s*\(/i.test(s)
  ) {
    return false;
  }
  // CASE … THEN 'literal' / ELSE 'literal'
  if (/\bcase\b/i.test(s) && /then\s+'[^']+'/i.test(s)) return true;
  // Pure quoted string or cast to string
  if (/^cast\s*\(.*\bas\s+string\s*\)/i.test(s)) return true;
  return false;
}

/**
 * Strip number/percentage/currency formats from string-typed fields.
 * Prevents Databricks COLUMN_FORMAT_INCOMPATIBLE_WITH_COLUMN_TYPE deploy loops.
 */
export function stripIncompatibleMetricViewFormats(
  yamlText: string,
  inventory?: IntermediateRepresentation | null,
  fieldMappings?: FieldMappingEntry[] | null
): { yaml: string; stripped: string[] } {
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(yamlText) as Record<string, unknown>;
  } catch {
    return { yaml: yamlText, stripped: [] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { yaml: yamlText, stripped: [] };
  }

  const mappings =
    fieldMappings ?? inventory?.fieldMapping?.entries ?? undefined;
  const stripped: string[] = [];

  const scrubList = (key: "fields" | "dimensions" | "measures") => {
    const list = doc[key];
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const node = item as Record<string, unknown>;
      const name = String(node.name ?? "");
      if (!name || isEmptyMeta(node.format)) continue;
      if (!isNumericDatabricksFormat(node.format)) continue;

      const meta = resolveLookerMeta(name, inventory, mappings);
      const expr = typeof node.expr === "string" ? node.expr : undefined;
      const stringy =
        isStringLikeLookerType(meta?.type) || exprLooksLikeStringColumn(expr);
      if (!stringy) continue;

      delete node.format;
      stripped.push(name);
    }
  };

  scrubList("fields");
  scrubList("dimensions");
  scrubList("measures");

  if (stripped.length === 0) return { yaml: yamlText, stripped };

  return {
    yaml: stringifyYaml(doc, {
      lineWidth: 0,
      defaultKeyType: "PLAIN",
      defaultStringType: "PLAIN",
    }).trim(),
    stripped,
  };
}

/** Parse Databricks COLUMN_FORMAT_INCOMPATIBLE column names from an error. */
export function parseIncompatibleFormatColumns(errorMessage: string): string[] {
  const cols: string[] = [];
  const re =
    /Column\s+[`']?([A-Za-z_][\w$]*)[`']?\s+has\s+(?:numeric|percentage|currency)\s+format/gi;
  for (const m of errorMessage.matchAll(re)) {
    if (m[1] && !cols.includes(m[1])) cols.push(m[1]);
  }
  return cols;
}

/**
 * Force-remove formats on columns named in a Databricks format error,
 * plus any other string fields with numeric formats.
 */
export function repairFormatIncompatibleYaml(
  yamlText: string,
  errorMessage: string,
  inventory?: IntermediateRepresentation | null,
  fieldMappings?: FieldMappingEntry[] | null
): { yaml: string; stripped: string[] } {
  const named = parseIncompatibleFormatColumns(errorMessage).map((c) =>
    c.toLowerCase()
  );
  const base = stripIncompatibleMetricViewFormats(
    yamlText,
    inventory,
    fieldMappings
  );

  if (named.length === 0) return base;

  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(base.yaml) as Record<string, unknown>;
  } catch {
    return base;
  }
  if (!doc || typeof doc !== "object") return base;

  const stripped = [...base.stripped];
  for (const key of ["fields", "dimensions", "measures"] as const) {
    const list = doc[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const node = item as Record<string, unknown>;
      const name = String(node.name ?? "");
      if (!name || !named.includes(name.toLowerCase())) continue;
      if (isEmptyMeta(node.format)) continue;
      delete node.format;
      if (!stripped.includes(name)) stripped.push(name);
    }
  }

  if (stripped.length === base.stripped.length) return base;

  return {
    yaml: stringifyYaml(doc, {
      lineWidth: 0,
      defaultKeyType: "PLAIN",
      defaultStringType: "PLAIN",
    }).trim(),
    stripped,
  };
}

/** Build up to 10 Genie synonyms from Looker label/tags/humanized name. */
export function buildSynonyms(params: {
  technicalName: string;
  displayName?: string;
  label?: string;
  tags?: string[];
  description?: string;
}): string[] {
  const exclude = new Set<string>();
  const addExclude = (s?: string) => {
    if (!s?.trim()) return;
    exclude.add(s.trim().toLowerCase());
  };
  addExclude(params.technicalName);
  addExclude(bareName(params.technicalName));
  addExclude(params.displayName);

  const candidates: string[] = [];
  const push = (raw?: string) => {
    if (!raw?.trim()) return;
    const v = clip(raw.replace(/\s+/g, " "), MAX_SYNONYM_LEN);
    if (!v) return;
    const key = v.toLowerCase();
    if (exclude.has(key)) return;
    if (candidates.some((c) => c.toLowerCase() === key)) return;
    exclude.add(key);
    candidates.push(v);
  };

  push(params.label);
  for (const tag of params.tags ?? []) push(tag);

  const human = humanizeFieldName(params.technicalName);
  push(human);
  // Shorter alias without aggregation suffixes common in LookML
  push(
    human
      .replace(/\b(Sum|Count|Avg|Average|Min|Max|Total)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
  );

  // Pull quoted phrases from description as light synonyms
  const desc = params.description ?? "";
  for (const m of desc.matchAll(/"([^"]{2,80})"/g)) {
    push(m[1]);
  }

  return candidates.slice(0, MAX_SYNONYMS);
}

function resolveLookerMeta(
  databricksField: string,
  inventory: IntermediateRepresentation | null | undefined,
  fieldMappings?: FieldMappingEntry[] | null
): LookerFieldMeta | undefined {
  if (!inventory) return undefined;
  const dbBare = bareName(databricksField).toLowerCase();

  const mapping = (fieldMappings ?? inventory.fieldMapping?.entries ?? []).find(
    (e) => bareName(e.databricksField).toLowerCase() === dbBare
  );

  const lookerBare = mapping
    ? bareName(mapping.lookerField).toLowerCase()
    : dbBare;

  const measure =
    inventory.measures.find(
      (m) => bareName(m.name).toLowerCase() === lookerBare
    ) ??
    inventory.measures.find((m) => bareName(m.name).toLowerCase() === dbBare);
  if (measure) {
    return {
      name: measure.name,
      label: measure.label,
      description: measure.description,
      valueFormat: measure.valueFormat,
      tags: measure.tags,
      type: measure.type,
      kind: "measure",
      currency: mapping?.currency,
      unit: mapping?.unit,
    };
  }

  const dimension =
    inventory.dimensions.find(
      (d) => bareName(d.name).toLowerCase() === lookerBare
    ) ??
    inventory.dimensions.find((d) => bareName(d.name).toLowerCase() === dbBare);
  if (dimension) {
    return {
      name: dimension.name,
      label: dimension.label,
      description: dimension.description,
      valueFormat: dimension.valueFormat,
      tags: dimension.tags,
      type: dimension.type,
      kind: "dimension",
      currency: mapping?.currency,
      unit: mapping?.unit,
    };
  }

  return undefined;
}

function isEmptyMeta(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function enrichFieldNode(
  node: Record<string, unknown>,
  meta: LookerFieldMeta | undefined
): boolean {
  if (!meta && isEmptyMeta(node.display_name) && isEmptyMeta(node.comment)) {
    // Still humanize bare technical names when inventory miss
  }

  let changed = false;
  const technicalName = String(node.name ?? "");
  if (!technicalName) return false;

  // GPT sometimes emits `description` — Databricks agent metadata uses `comment`
  if (isEmptyMeta(node.comment) && !isEmptyMeta(node.description)) {
    node.comment = clip(String(node.description), 4000);
    delete node.description;
    changed = true;
  }

  const display =
    (typeof node.display_name === "string" && node.display_name.trim()) ||
    (meta?.label ? clip(meta.label, MAX_DISPLAY) : undefined) ||
    clip(humanizeFieldName(technicalName), MAX_DISPLAY);

  if (isEmptyMeta(node.display_name) && display) {
    node.display_name = display;
    changed = true;
  }

  if (isEmptyMeta(node.comment) && meta?.description?.trim()) {
    node.comment = clip(meta.description, 4000);
    changed = true;
  }

  const format = lookerValueFormatToDatabricksFormat({
    valueFormat: meta?.valueFormat,
    lookerType: meta?.type,
    currency: meta?.currency,
    unit: meta?.unit,
    fieldName: meta?.name ?? technicalName,
    label: meta?.label,
    description: meta?.description,
  });
  if (isEmptyMeta(node.format) && format) {
    node.format = format;
    changed = true;
  }

  // Drop numeric formats on string columns even if GPT / prior enrich set them.
  const expr = typeof node.expr === "string" ? node.expr : undefined;
  if (
    !isEmptyMeta(node.format) &&
    isNumericDatabricksFormat(node.format) &&
    (isStringLikeLookerType(meta?.type) || exprLooksLikeStringColumn(expr))
  ) {
    delete node.format;
    changed = true;
  }

  const existingSynonyms = Array.isArray(node.synonyms)
    ? (node.synonyms as unknown[]).map((s) => String(s))
    : [];
  const built = buildSynonyms({
    technicalName,
    displayName:
      typeof node.display_name === "string" ? node.display_name : display,
    label: meta?.label,
    tags: meta?.tags,
    description: meta?.description,
  });
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const s of [...existingSynonyms, ...built]) {
    const v = clip(String(s), MAX_SYNONYM_LEN);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    if (key === technicalName.toLowerCase()) continue;
    if (
      typeof node.display_name === "string" &&
      key === node.display_name.toLowerCase()
    ) {
      continue;
    }
    seen.add(key);
    merged.push(v);
    if (merged.length >= MAX_SYNONYMS) break;
  }
  if (merged.length > 0) {
    const prev = JSON.stringify(existingSynonyms);
    const next = JSON.stringify(merged);
    if (prev !== next) {
      node.synonyms = merged;
      changed = true;
    }
  }

  return changed;
}

/**
 * Enrich metric-view YAML with Databricks agent metadata from Looker inventory.
 * Idempotent: fills missing fields; preserves existing non-empty agent metadata
 * except incompatible numeric formats on string columns (always stripped).
 * Forces version 1.1 when any agent metadata is present (Databricks requirement).
 */
export function enrichMetricViewYamlWithAgentMetadata(
  yamlText: string,
  inventory?: IntermediateRepresentation | null,
  fieldMappings?: FieldMappingEntry[] | null
): string {
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(yamlText) as Record<string, unknown>;
  } catch {
    return yamlText;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return yamlText;

  let touched = false;
  const mappings =
    fieldMappings ?? inventory?.fieldMapping?.entries ?? undefined;

  const enrichList = (key: "fields" | "dimensions" | "measures") => {
    const list = doc[key];
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const node = item as Record<string, unknown>;
      const name = String(node.name ?? "");
      const meta = resolveLookerMeta(name, inventory, mappings);
      if (enrichFieldNode(node, meta)) touched = true;
    }
  };

  enrichList("fields");
  enrichList("dimensions");
  enrichList("measures");

  // View-level comment from explore source when missing
  if (isEmptyMeta(doc.comment) && inventory?.source?.explore) {
    doc.comment = `Migrated Looker explore ${inventory.source.model}.${inventory.source.explore}`;
    touched = true;
  }

  const hasAgentMeta = (() => {
    const lists = [doc.fields, doc.dimensions, doc.measures];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const n = item as Record<string, unknown>;
        if (
          !isEmptyMeta(n.display_name) ||
          !isEmptyMeta(n.synonyms) ||
          !isEmptyMeta(n.format) ||
          !isEmptyMeta(n.comment)
        ) {
          return true;
        }
      }
    }
    return !isEmptyMeta(doc.comment);
  })();

  if (hasAgentMeta) {
    const ver = String(doc.version ?? "");
    if (ver !== "1.1") {
      doc.version = "1.1";
      touched = true;
    }
  }

  if (!touched && !hasAgentMeta) return yamlText;

  // Leave dimensions vs fields structure as-is. Caller should run
  // serializeYamlSqlScalars / normalizeMetricViewYaml so expr stays block-safe.
  const enriched = stringifyYaml(doc, {
    lineWidth: 0,
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
  }).trim();

  // Final pass: strip any remaining incompatible formats (defense in depth).
  const scrubbed = stripIncompatibleMetricViewFormats(
    enriched,
    inventory,
    mappings
  );
  return scrubbed.yaml;
}

/** Test helper: build metadata for a single Looker measure/dimension. */
export function agentMetadataForLookerField(
  field: IrDimension | IrMeasure,
  kind: "dimension" | "measure",
  extras?: { currency?: string; unit?: string }
): {
  display_name: string;
  comment?: string;
  synonyms: string[];
  format?: DatabricksFormat;
} {
  const display_name = clip(
    field.label?.trim() || humanizeFieldName(field.name),
    MAX_DISPLAY
  );
  const format = lookerValueFormatToDatabricksFormat({
    valueFormat: field.valueFormat,
    lookerType: field.type,
    currency: extras?.currency,
    unit: extras?.unit,
    fieldName: field.name,
    label: field.label,
    description: field.description,
  });
  return {
    display_name,
    comment: field.description?.trim()
      ? clip(field.description, 4000)
      : undefined,
    synonyms: buildSynonyms({
      technicalName: bareName(field.name),
      displayName: display_name,
      label: field.label,
      tags: field.tags,
      description: field.description,
    }),
    format,
  };
}

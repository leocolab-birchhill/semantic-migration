/**
 * Parse Looker query.dynamic_fields (custom measures, custom dimensions,
 * table calculations) into a normalized shape for inventory + generation.
 */

export type LookerDynamicFieldKind =
  | "measure"
  | "dimension"
  | "table_calculation";

export interface LookerDynamicField {
  kind: LookerDynamicFieldKind;
  /** Bare field name as it appears in query.fields / result columns. */
  name: string;
  label?: string;
  /** Table calc / custom dimension Looker expression. */
  expression?: string;
  /** Custom measure base field (e.g. view.actual). */
  basedOn?: string;
  type?: string;
  /** Custom measure filters, when present. */
  filters?: Record<string, string>;
  valueFormat?: string | null;
  valueFormatName?: string | null;
  /** Original object for round-trip into Looker query bodies. */
  raw: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringFilters(
  value: unknown
): Record<string, string> | undefined {
  const obj = asRecord(value);
  if (!obj) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
    else if (v != null) out[k] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeOne(raw: Record<string, unknown>): LookerDynamicField | null {
  if (typeof raw.table_calculation === "string" && raw.table_calculation) {
    return {
      kind: "table_calculation",
      name: raw.table_calculation,
      label: typeof raw.label === "string" ? raw.label : undefined,
      expression: typeof raw.expression === "string" ? raw.expression : undefined,
      type: typeof raw._type_hint === "string" ? raw._type_hint : undefined,
      valueFormat:
        typeof raw.value_format === "string" ? raw.value_format : null,
      valueFormatName:
        typeof raw.value_format_name === "string"
          ? raw.value_format_name
          : null,
      raw,
    };
  }

  if (typeof raw.measure === "string" && raw.measure) {
    return {
      kind: "measure",
      name: raw.measure,
      label: typeof raw.label === "string" ? raw.label : undefined,
      basedOn: typeof raw.based_on === "string" ? raw.based_on : undefined,
      type: typeof raw.type === "string" ? raw.type : undefined,
      filters: stringFilters(raw.filters ?? raw.filter),
      valueFormat:
        typeof raw.value_format === "string" ? raw.value_format : null,
      valueFormatName:
        typeof raw.value_format_name === "string"
          ? raw.value_format_name
          : null,
      expression: typeof raw.expression === "string" ? raw.expression : undefined,
      raw,
    };
  }

  if (typeof raw.dimension === "string" && raw.dimension) {
    return {
      kind: "dimension",
      name: raw.dimension,
      label: typeof raw.label === "string" ? raw.label : undefined,
      expression: typeof raw.expression === "string" ? raw.expression : undefined,
      type: typeof raw._type_hint === "string" ? raw._type_hint : undefined,
      valueFormat:
        typeof raw.value_format === "string" ? raw.value_format : null,
      valueFormatName:
        typeof raw.value_format_name === "string"
          ? raw.value_format_name
          : null,
      raw,
    };
  }

  return null;
}

/** Parse Looker dynamic_fields (JSON string or array) into normalized defs. */
export function parseLookerDynamicFields(
  value: unknown
): LookerDynamicField[] {
  if (value == null || value === "") return [];

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const out: LookerDynamicField[] = [];
  for (const item of parsed) {
    const rec = asRecord(item);
    if (!rec) continue;
    const norm = normalizeOne(rec);
    if (norm) out.push(norm);
  }
  return out;
}

/** Serialize dynamic fields back to the JSON string Looker query APIs expect. */
export function serializeLookerDynamicFields(
  fields: LookerDynamicField[] | undefined
): string | undefined {
  if (!fields?.length) return undefined;
  return JSON.stringify(fields.map((f) => f.raw));
}

/** Bare names defined by dynamic fields (case-insensitive map → canonical name). */
export function dynamicFieldNameMap(
  fields: LookerDynamicField[] | undefined
): Map<string, LookerDynamicField> {
  const map = new Map<string, LookerDynamicField>();
  for (const f of fields ?? []) {
    const key = f.name.toLowerCase();
    if (!map.has(key)) map.set(key, f);
  }
  return map;
}

export function compactDynamicFieldForPrompt(f: LookerDynamicField): {
  kind: LookerDynamicFieldKind;
  name: string;
  label?: string;
  expression?: string;
  basedOn?: string;
  type?: string;
  filters?: Record<string, string>;
  valueFormat?: string | null;
  valueFormatName?: string | null;
} {
  return {
    kind: f.kind,
    name: f.name,
    label: f.label,
    expression: f.expression,
    basedOn: f.basedOn,
    type: f.type,
    filters: f.filters,
    valueFormat: f.valueFormat,
    valueFormatName: f.valueFormatName,
  };
}

/** Deduplicate dynamic fields by kind+name (case-insensitive). */
export function mergeDynamicFields(
  ...groups: Array<LookerDynamicField[] | undefined>
): LookerDynamicField[] | undefined {
  const byKey = new Map<string, LookerDynamicField>();
  for (const group of groups) {
    for (const f of group ?? []) {
      const key = `${f.kind}:${f.name.toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, f);
    }
  }
  const out = Array.from(byKey.values());
  return out.length ? out : undefined;
}

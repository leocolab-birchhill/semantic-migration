/**
 * Deterministic passthrough-dimension scaffolding for generate.
 * Removes trivial LookML column refs from the LLM output surface so generate
 * only reasons about measures, dynamic fields, and non-trivial dimensions.
 */

import {
  humanizeFieldName,
  lookerValueFormatToDatabricksFormat,
} from "@/lib/migration/agent-metadata";
import type {
  FieldMappingEntry,
  IntermediateRepresentation,
  IrDimension,
  ProposedAsset,
} from "@/lib/migration/types";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ScaffoldedDimension {
  name: string;
  expr: string;
  display_name: string;
  comment?: string;
  format?: Record<string, unknown>;
}

export interface DimensionScaffold {
  dimensions: ScaffoldedDimension[];
  fieldMappings: FieldMappingEntry[];
  /** Bare field names already handled — LLM must not re-emit these. */
  scaffoldedBareNames: string[];
}

function bareName(field: string): string {
  return field.split(".").pop()!.trim();
}

/**
 * Extract a simple source column from LookML sql.
 * Accepts: `${TABLE}.col`, `${TABLE}.\`col\``, bare `col`, `` `col` ``.
 * Rejects CASE/WHEN, ${param}, liquid, functions, multi-statement.
 */
export function parsePassthroughColumn(
  sql: string | undefined
): string | null {
  if (!sql) return null;
  let s = sql.trim();
  // Strip outer parentheses once
  if (s.startsWith("(") && s.endsWith(")")) {
    s = s.slice(1, -1).trim();
  }
  // Reject anything with control flow / params / liquid / commas (except inside identifiers)
  if (
    /\$\{(?!TABLE\})/i.test(s) ||
    /\b(case|when|then|else|end|cast|coalesce|if|nullif)\b/i.test(s) ||
    /\{%|%\}|::/.test(s) ||
    /[+\-*/]|<|>|=/.test(s.replace(/\$\{TABLE\}/gi, ""))
  ) {
    return null;
  }

  // ${TABLE}.col or ${TABLE}.`col`
  const tableRef = s.match(
    /^\$\{TABLE\}\s*\.\s*(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][\w$]*))$/i
  );
  if (tableRef) {
    return tableRef[1] ?? tableRef[2] ?? tableRef[3] ?? tableRef[4] ?? null;
  }

  // Bare identifier (optionally quoted)
  const bare = s.match(
    /^(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][\w$]*))$/
  );
  if (bare) {
    return bare[1] ?? bare[2] ?? bare[3] ?? bare[4] ?? null;
  }

  return null;
}

export function isPassthroughDimension(dim: IrDimension): boolean {
  if (dim.hidden) return false;
  return parsePassthroughColumn(dim.sql) != null;
}

/**
 * Build metric-view dimension entries + fieldMappings for simple passthrough dims.
 * metricViewName is filled later when the primary explore name is known; pass
 * a placeholder and rewrite, or pass the explore name up front.
 */
export function scaffoldPassthroughDimensions(
  inventory: IntermediateRepresentation,
  metricViewName: string
): DimensionScaffold {
  const dimensions: ScaffoldedDimension[] = [];
  const fieldMappings: FieldMappingEntry[] = [];
  const scaffoldedBareNames: string[] = [];

  for (const dim of inventory.dimensions) {
    if (dim.hidden) continue;
    const col = parsePassthroughColumn(dim.sql);
    if (!col) continue;

    const name = bareName(dim.name);
    const display =
      dim.label?.trim() || humanizeFieldName(dim.name);
    const format = lookerValueFormatToDatabricksFormat({
      valueFormat: dim.valueFormat,
      lookerType: dim.type,
      fieldName: dim.name,
      label: dim.label,
      description: dim.description,
    });

    const entry: ScaffoldedDimension = {
      name,
      expr: col,
      display_name: display.slice(0, 255),
    };
    if (dim.description?.trim()) {
      entry.comment = dim.description.trim();
    }
    if (format) entry.format = format;
    dimensions.push(entry);
    scaffoldedBareNames.push(name.toLowerCase());

    fieldMappings.push({
      lookerField: dim.name,
      metricViewName,
      databricksField: name,
      kind: "dimension",
      populationGrain: "row",
      evidence: {
        aggregation: "none",
        filters: [],
        currency: "",
        unit: "",
        populationGrain: "row",
        lookmlSql: dim.sql ?? "",
        databricksExpr: col,
        rationale:
          "Deterministic passthrough: LookML sql is a simple source column reference; mapped 1:1 by name.",
      },
    });
  }

  return { dimensions, fieldMappings, scaffoldedBareNames };
}

/**
 * Guard against full-YAML replacement patches silently dropping fields that
 * earlier iterations added (e.g. dimensions exposed to fix compile errors).
 * Re-appends any dimension/measure present in the previous YAML but missing
 * (by name) from the patched YAML. Skipped when the source table changed,
 * since old exprs may no longer resolve.
 */
export function preserveMetricViewFieldsOnPatch(
  previousYaml: string | undefined,
  patchedYaml: string
): { yaml: string; restored: string[] } {
  if (!previousYaml?.trim() || !patchedYaml.trim()) {
    return { yaml: patchedYaml, restored: [] };
  }

  let prevDoc: Record<string, unknown>;
  let nextDoc: Record<string, unknown>;
  try {
    prevDoc = parseYaml(previousYaml) as Record<string, unknown>;
    nextDoc = parseYaml(patchedYaml) as Record<string, unknown>;
  } catch {
    return { yaml: patchedYaml, restored: [] };
  }
  if (!prevDoc || !nextDoc || typeof prevDoc !== "object" || typeof nextDoc !== "object") {
    return { yaml: patchedYaml, restored: [] };
  }
  if (
    String(prevDoc.source ?? "").trim() &&
    String(nextDoc.source ?? "").trim() &&
    String(prevDoc.source).trim() !== String(nextDoc.source).trim()
  ) {
    return { yaml: patchedYaml, restored: [] };
  }

  const restored: string[] = [];
  for (const key of ["dimensions", "measures"] as const) {
    const prevList = Array.isArray(prevDoc[key])
      ? (prevDoc[key] as Record<string, unknown>[])
      : [];
    if (prevList.length === 0) continue;
    const nextList = Array.isArray(nextDoc[key])
      ? ([...(nextDoc[key] as unknown[])] as Record<string, unknown>[])
      : [];
    const nextNames = new Set(
      nextList.map((d) => String(d?.name ?? "").toLowerCase()).filter(Boolean)
    );
    for (const item of prevList) {
      const name = String(item?.name ?? "").toLowerCase();
      if (!name || nextNames.has(name)) continue;
      nextList.push(item);
      nextNames.add(name);
      restored.push(`${key.slice(0, -1)} ${item.name}`);
    }
    if (nextList.length > 0) nextDoc[key] = nextList;
  }

  if (restored.length === 0) return { yaml: patchedYaml, restored };
  return { yaml: stringifyYaml(nextDoc, { lineWidth: 0 }), restored };
}

/**
 * Merge scaffolded dimensions into the primary metric_view YAML.
 * Prefers existing LLM dimensions when names collide; appends missing scaffolded ones.
 * Also merges scaffolded fieldMappings that aren't already present.
 */
export function mergeScaffoldIntoAssets(
  assets: ProposedAsset[],
  scaffold: DimensionScaffold,
  preferredMetricViewName?: string
): ProposedAsset[] {
  if (scaffold.dimensions.length === 0) return assets;

  const primaryIdx = (() => {
    if (preferredMetricViewName) {
      const i = assets.findIndex(
        (a) =>
          a.type === "metric_view" &&
          a.name.toLowerCase() === preferredMetricViewName.toLowerCase()
      );
      if (i >= 0) return i;
    }
    return assets.findIndex((a) => a.type === "metric_view" && a.yaml?.trim());
  })();
  if (primaryIdx < 0) return assets;

  return assets.map((asset, idx) => {
    if (idx !== primaryIdx || !asset.yaml?.trim()) return asset;

    let doc: Record<string, unknown>;
    try {
      doc = parseYaml(asset.yaml) as Record<string, unknown>;
    } catch {
      return asset;
    }
    if (!doc || typeof doc !== "object") return asset;

    const dimKey = Array.isArray(doc.dimensions)
      ? "dimensions"
      : Array.isArray(doc.fields)
        ? "fields"
        : "dimensions";
    const existing = Array.isArray(doc[dimKey])
      ? ([...(doc[dimKey] as unknown[])] as Record<string, unknown>[])
      : [];
    const existingNames = new Set(
      existing
        .map((d) => String(d?.name ?? "").toLowerCase())
        .filter(Boolean)
    );

    for (const s of scaffold.dimensions) {
      if (existingNames.has(s.name.toLowerCase())) continue;
      const node: Record<string, unknown> = {
        name: s.name,
        expr: s.expr,
        display_name: s.display_name,
      };
      if (s.comment) node.comment = s.comment;
      if (s.format) node.format = s.format;
      existing.push(node);
      existingNames.add(s.name.toLowerCase());
    }
    doc[dimKey] = existing;
    if (!doc.version) doc.version = "1.1";

    const existingMaps = asset.fieldMappings ?? [];
    const mapKeys = new Set(
      existingMaps.map(
        (m) =>
          `${m.lookerField.toLowerCase()}::${m.databricksField.toLowerCase()}`
      )
    );
    const mergedMaps = [...existingMaps];
    for (const m of scaffold.fieldMappings) {
      const key = `${m.lookerField.toLowerCase()}::${m.databricksField.toLowerCase()}`;
      if (mapKeys.has(key)) continue;
      mergedMaps.push({
        ...m,
        metricViewName: asset.name,
      });
      mapKeys.add(key);
    }

    return {
      ...asset,
      yaml: stringifyYaml(doc, { lineWidth: 0 }),
      fieldMappings: mergedMaps,
    };
  });
}

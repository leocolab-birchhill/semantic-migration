/**
 * Persistent Looker ↔ Databricks field mapping for benchmark SQL compilation.
 * Benchmark queries must use this mapping only — never assume identical names.
 */

import { parse as parseYaml } from "yaml";
import {
  canonicalizeFieldName,
  stripLookerFieldPrefix,
} from "@/lib/migration/query-builder";
import type {
  FieldMappingEntry,
  FieldMappingTable,
  IntermediateRepresentation,
  IrMeasure,
  MetricViewInventory,
  ProposedAsset,
  SemanticMappingEvidence,
} from "@/lib/migration/types";

export interface CompilationIssue {
  code:
    | "unmapped_looker_field"
    | "missing_databricks_field"
    | "wrong_metric_view"
    | "ambiguous_currency"
    | "missing_mapping_entry"
    | "empty_inventory";
  lookerField?: string;
  databricksField?: string;
  metricViewName?: string;
  detail: string;
}

export interface BenchmarkCompilationResult {
  ok: boolean;
  status?: "query_compilation_error";
  issues: CompilationIssue[];
  /** Databricks field names to SELECT (mapped). */
  databricksFields: string[];
  /** Subset that are measures (for MEASURE()). */
  measureNames: Set<string>;
  /** Remapped filters keyed by Databricks dimension name. */
  filters?: Record<string, string>;
  /**
   * Extra SQL WHERE predicates with Databricks field names already applied
   * (cross-field comparisons from Looker filter_expression).
   */
  predicates?: string[];
  /** Remapped sorts using Databricks names. */
  sorts?: string[];
  metricViewName: string;
  /** Mapping rows used for this benchmark. */
  usedMappings: FieldMappingEntry[];
}

/** Extract currency token from a field name / format / description. */
export function detectCurrency(
  ...parts: Array<string | undefined | null>
): string | undefined {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (/\bcad\b|_cad\b|\(cad\)|canadian/.test(text)) return "CAD";
  if (/\busd\b|_usd\b|\(usd\)|us\s*dollar/.test(text)) return "USD";
  if (/\beur\b|_eur\b|\(eur\)|euro/.test(text)) return "EUR";
  if (/\bgbp\b|_gbp\b|\(gbp\)|pound/.test(text)) return "GBP";
  return undefined;
}

/**
 * Treat GPT/"none"/ratio tokens as no currency so they don't false-conflict with
 * CAD CASE branches inside metric-view expressions.
 */
export function normalizeCurrencyToken(
  value?: string | null
): string | undefined {
  if (value == null) return undefined;
  const t = String(value).trim().toLowerCase();
  if (!t) return undefined;
  if (
    [
      "none",
      "null",
      "n/a",
      "na",
      "percent",
      "pct",
      "ratio",
      "dimensionless",
      "unitless",
      "share",
      "rate",
      "count",
    ].includes(t)
  ) {
    return undefined;
  }
  return detectCurrency(t) ?? (t.length <= 4 ? t.toUpperCase() : undefined);
}

/** Ratio / percent / share-like measures — not currency amounts. */
export function looksLikeRatioOrPercent(
  ...parts: Array<string | undefined | null>
): boolean {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (!text) return false;
  if (/\bpercent\b|\bpct\b|%/.test(text)) return true;
  if (
    /\bshare\b|\bmargin\b|\bpenetration\b|\brate\b|\bratio\b|\bpct\b/.test(text)
  ) {
    return true;
  }
  return false;
}

export function detectUnit(
  ...parts: Array<string | undefined | null>
): string | undefined {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (looksLikeRatioOrPercent(text)) return "percent";
  if (/\bcount\b|\bcnt\b/.test(text)) return "count";
  if (detectCurrency(...parts)) return "currency";
  return undefined;
}

export function detectAggregation(sql?: string, type?: string): string | undefined {
  const s = `${sql ?? ""} ${type ?? ""}`.toLowerCase();
  if (/\bsum\s*\(/.test(s) || type === "sum") return "sum";
  if (/\bcount\s*\(/.test(s) || type === "count" || type === "count_distinct")
    return "count";
  if (/\bavg\s*\(/.test(s) || type === "average" || type === "avg") return "average";
  if (/\bmin\s*\(/.test(s) || type === "min") return "min";
  if (/\bmax\s*\(/.test(s) || type === "max") return "max";
  return type && type !== "number" && type !== "string" ? type : undefined;
}

/**
 * Parse metric-view YAML into a structured inventory of dimensions and measures.
 */
export function parseMetricViewInventory(
  metricViewName: string,
  yamlText: string
): MetricViewInventory {
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(yamlText) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse metric view YAML for ${metricViewName}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const dimensions: MetricViewInventory["dimensions"] = [];
  const measures: MetricViewInventory["measures"] = [];

  const dimNodes = (doc.dimensions ?? doc.fields) as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(dimNodes)) {
    for (const d of dimNodes) {
      const name = String(d.name ?? "");
      if (!name) continue;
      dimensions.push({
        name,
        expr: typeof d.expr === "string" ? d.expr : undefined,
      });
    }
  }

  const paramNodes = doc.parameters as Array<Record<string, unknown>> | undefined;
  const parameters: MetricViewInventory["parameters"] = [];
  if (Array.isArray(paramNodes)) {
    for (const p of paramNodes) {
      const name = String(p.name ?? "");
      const data_type = String(p.data_type ?? "string");
      if (!name) continue;
      parameters.push({
        name,
        data_type,
        default: p.default,
      });
    }
  }

  const measureNodes = doc.measures as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(measureNodes)) {
    for (const m of measureNodes) {
      const name = String(m.name ?? "");
      if (!name) continue;
      measures.push({
        name,
        expr: typeof m.expr === "string" ? m.expr : undefined,
      });
    }
  }

  return {
    name: metricViewName,
    source: typeof doc.source === "string" ? doc.source : undefined,
    parameters: parameters.length > 0 ? parameters : undefined,
    dimensions,
    measures,
  };
}

export function loadMetricViewInventories(
  assets: ProposedAsset[]
): Map<string, MetricViewInventory> {
  const map = new Map<string, MetricViewInventory>();
  for (const asset of assets) {
    if (asset.type !== "metric_view" || !asset.yaml?.trim()) continue;
    map.set(
      asset.name.toLowerCase(),
      parseMetricViewInventory(asset.name, asset.yaml)
    );
  }
  return map;
}

/**
 * Rewrite mapping metricViewName values so they point at deployed metric_view
 * assets. GPT often emits a parallel name (e.g. tam_buildings_cad_default)
 * while the asset is deployed as tam_buildings / tam_buildings_metrics.
 */
export function reconcileMappingMetricViewNames(
  mapping: FieldMappingTable,
  assets: ProposedAsset[]
): FieldMappingTable {
  const metricViews = assets
    .filter((a) => a.type === "metric_view")
    .map((a) => a.name);
  if (metricViews.length === 0 || mapping.entries.length === 0) return mapping;

  const byLower = new Map(metricViews.map((n) => [n.toLowerCase(), n]));

  const resolveName = (name: string): string => {
    const exact = byLower.get(name.toLowerCase());
    if (exact) return exact;
    if (metricViews.length === 1) return metricViews[0];

    const pref = name.toLowerCase();
    const prefixMatches = metricViews.filter((n) => {
      const k = n.toLowerCase();
      return k === pref || k.startsWith(`${pref}_`) || pref.startsWith(`${k}_`);
    });
    if (prefixMatches.length === 1) return prefixMatches[0];
    return name;
  };

  return {
    ...mapping,
    entries: mapping.entries.map((e) => ({
      ...e,
      metricViewName: resolveName(e.metricViewName),
    })),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Coerce a preferred/explore metric view name onto an inventory that actually
 * exists (e.g. explore "tam_buildings" → asset "tam_buildings_metrics").
 */
export function coerceMetricViewName(
  preferred: string | undefined,
  inventories: Map<string, MetricViewInventory>,
  mappingViews: Iterable<string> = []
): string | undefined {
  const keys = Array.from(inventories.keys());
  if (keys.length === 0) return preferred;

  const has = (n: string) => inventories.has(n.toLowerCase());
  const canonical = (n: string) =>
    inventories.get(n.toLowerCase())?.name ?? n;

  if (preferred && has(preferred)) return canonical(preferred);

  const mapped = Array.from(
    new Set(Array.from(mappingViews).map((v) => v.toLowerCase()))
  );
  if (mapped.length === 1 && has(mapped[0])) return canonical(mapped[0]);

  if (preferred) {
    const pref = preferred.toLowerCase();
    const matches = keys.filter(
      (k) => k === pref || k.startsWith(`${pref}_`) || pref.startsWith(`${k}_`)
    );
    if (matches.length === 1) return canonical(matches[0]);
  }

  if (keys.length === 1) return canonical(keys[0]);
  return preferred;
}

function lookerKey(name: string): string {
  return canonicalizeFieldName(name);
}

/**
 * Build semantic evidence for a Looker→Databricks mapping.
 * Name similarity alone is never sufficient for currency/population decisions.
 */
export function buildSemanticEvidence(params: {
  lookerField: string;
  databricksField: string;
  lookerMeasure?: IrMeasure;
  databricksExpr?: string;
  currency?: string;
  unit?: string;
  populationGrain?: string;
  aggregation?: string;
  rationale: string;
}): SemanticMappingEvidence {
  const lookerCurrency = detectCurrency(
    params.lookerField,
    params.lookerMeasure?.name,
    params.lookerMeasure?.label,
    params.lookerMeasure?.description,
    params.lookerMeasure?.valueFormat
  );
  const dbCurrency = detectCurrency(
    params.databricksField,
    params.databricksExpr,
    params.currency
  );

  return {
    aggregation:
      params.aggregation ??
      detectAggregation(params.lookerMeasure?.sql, params.lookerMeasure?.type),
    filters: params.lookerMeasure?.filters,
    currency: params.currency ?? lookerCurrency ?? dbCurrency,
    unit:
      params.unit ??
      detectUnit(
        params.lookerField,
        params.databricksField,
        params.lookerMeasure?.valueFormat
      ),
    populationGrain: params.populationGrain,
    lookmlSql: params.lookerMeasure?.sql,
    databricksExpr: params.databricksExpr,
    rationale: params.rationale,
  };
}

/**
 * Currencies must agree when both sides declare one (CAD vs USD protection).
 * Tokens like "none" / "percent" are treated as undeclared.
 */
export function currenciesCompatible(
  lookerCurrency?: string,
  databricksCurrency?: string
): boolean {
  const a = normalizeCurrencyToken(lookerCurrency);
  const b = normalizeCurrencyToken(databricksCurrency);
  if (!a || !b) return true;
  return a.toUpperCase() === b.toUpperCase();
}

/**
 * Create or merge a field mapping table from assets that already declare mappings,
 * plus Looker inventory for semantic metadata. Does not invent mappings by name similarity.
 */
export function collectFieldMappings(
  assets: ProposedAsset[],
  inventory?: IntermediateRepresentation
): FieldMappingTable {
  const entries: FieldMappingEntry[] = [];
  const byLooker = new Map<string, FieldMappingEntry>();

  for (const asset of assets) {
    if (!asset.fieldMappings?.length) continue;
    for (const entry of asset.fieldMappings) {
      const normalized: FieldMappingEntry = {
        ...entry,
        metricViewName: entry.metricViewName || asset.name,
        lookerField: entry.lookerField,
        databricksField: entry.databricksField,
      };
      const key = `${lookerKey(normalized.lookerField)}::${normalized.metricViewName.toLowerCase()}`;
      byLooker.set(key, normalized);
    }
  }

  // Enrich currency/unit/population from Looker IR when missing
  if (inventory) {
    const measureByName = new Map(
      inventory.measures.map((m) => [lookerKey(m.name), m])
    );
    for (const [key, entry] of byLooker) {
      const looker = measureByName.get(lookerKey(entry.lookerField));
      const ratioLike = looksLikeRatioOrPercent(
        entry.lookerField,
        looker?.valueFormat,
        looker?.type,
        entry.unit,
        entry.currency
      );
      const currency = ratioLike
        ? undefined
        : normalizeCurrencyToken(
            entry.currency ??
              detectCurrency(
                entry.lookerField,
                looker?.name,
                looker?.label,
                looker?.description,
                looker?.valueFormat,
                entry.databricksField
              )
          );
      const unit =
        entry.unit ??
        (ratioLike
          ? "percent"
          : detectUnit(
              entry.lookerField,
              looker?.valueFormat,
              entry.databricksField
            ));
      const populationGrain =
        entry.populationGrain ??
        assetGrainFor(assets, entry.metricViewName) ??
        inventory.grain.sqlDistinctKey ??
        inventory.grain.primaryKey;
      const priorEvidence = entry.evidence;
      byLooker.set(key, {
        ...entry,
        currency,
        unit,
        populationGrain,
        evidence:
          priorEvidence ??
          (looker
            ? buildSemanticEvidence({
                lookerField: entry.lookerField,
                databricksField: entry.databricksField,
                lookerMeasure: looker,
                currency,
                unit,
                populationGrain,
                rationale: "Enriched from Looker inventory metadata",
              })
            : undefined),
      });
    }
  }

  entries.push(...byLooker.values());
  return {
    version: "1.0",
    entries,
    updatedAt: new Date().toISOString(),
  };
}

function assetGrainFor(
  assets: ProposedAsset[],
  metricViewName: string
): string | undefined {
  return assets.find(
    (a) =>
      a.type === "metric_view" &&
      a.name.toLowerCase() === metricViewName.toLowerCase()
  )?.grain;
}

/** Retain prior mappings across repair iterations; apply explicit patches only. */
export function mergeFieldMappings(
  previous: FieldMappingTable | null | undefined,
  next: FieldMappingTable | null | undefined,
  patches?: FieldMappingEntry[]
): FieldMappingTable {
  const byKey = new Map<string, FieldMappingEntry>();

  for (const e of previous?.entries ?? []) {
    byKey.set(`${lookerKey(e.lookerField)}::${e.metricViewName.toLowerCase()}`, e);
  }
  for (const e of next?.entries ?? []) {
    byKey.set(`${lookerKey(e.lookerField)}::${e.metricViewName.toLowerCase()}`, e);
  }
  for (const e of patches ?? []) {
    byKey.set(`${lookerKey(e.lookerField)}::${e.metricViewName.toLowerCase()}`, e);
  }

  return {
    version: "1.0",
    entries: Array.from(byKey.values()),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clear stale currency tags on ratio/share measures and normalize "none" tokens
 * so compile no longer false-fails against CAD CASE branches in exprs.
 */
export function repairAmbiguousCurrencyMappings(
  mapping: FieldMappingTable,
  inventory?: IntermediateRepresentation | null
): FieldMappingTable {
  const measureByName = new Map(
    (inventory?.measures ?? []).map((m) => [lookerKey(m.name), m])
  );

  const entries = mapping.entries.map((entry) => {
    const looker = measureByName.get(lookerKey(entry.lookerField));
    const ratioLike = looksLikeRatioOrPercent(
      entry.lookerField,
      looker?.valueFormat,
      looker?.type,
      looker?.label,
      entry.unit,
      entry.currency,
      entry.evidence?.unit,
      entry.evidence?.currency,
      entry.evidence?.rationale
    );
    const normalizedCurrency = normalizeCurrencyToken(entry.currency);
    const lookerNameCurrency = detectCurrency(
      entry.lookerField,
      looker?.name,
      looker?.label,
      looker?.valueFormat
    );

    if (ratioLike || (!lookerNameCurrency && entry.currency)) {
      const unit =
        entry.unit ??
        (ratioLike
          ? "percent"
          : detectUnit(entry.lookerField, looker?.valueFormat));
      const evidence = entry.evidence
        ? {
            ...entry.evidence,
            currency: ratioLike
              ? undefined
              : normalizeCurrencyToken(entry.evidence.currency),
            unit: entry.evidence.unit ?? unit,
          }
        : entry.evidence;
      return {
        ...entry,
        currency: ratioLike ? undefined : lookerNameCurrency ?? normalizedCurrency,
        unit,
        evidence,
      };
    }

    if (entry.currency && !normalizedCurrency) {
      return { ...entry, currency: undefined };
    }
    if (entry.currency !== normalizedCurrency) {
      return { ...entry, currency: normalizedCurrency };
    }
    return entry;
  });

  return {
    version: mapping.version || "1.0",
    entries,
    updatedAt: new Date().toISOString(),
  };
}

export function findMappingForLookerField(
  mapping: FieldMappingTable,
  lookerField: string,
  metricViewName?: string
): FieldMappingEntry | undefined {
  const key = lookerKey(lookerField);
  const candidates = mapping.entries.filter((e) => lookerKey(e.lookerField) === key);
  if (metricViewName) {
    const exact = candidates.find(
      (e) => e.metricViewName.toLowerCase() === metricViewName.toLowerCase()
    );
    if (exact) return exact;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Resolve which metric view a benchmark must use from the mapping of its fields.
 * Fails if fields disagree on the target metric view.
 */
export function resolveBenchmarkMetricView(
  mapping: FieldMappingTable,
  lookerFields: string[],
  preferredMetricView?: string,
  inventories?: Map<string, MetricViewInventory>
): { metricViewName?: string; issues: CompilationIssue[] } {
  const issues: CompilationIssue[] = [];
  const views = new Set<string>();

  for (const field of lookerFields) {
    const entry = findMappingForLookerField(mapping, field, preferredMetricView);
    if (!entry) {
      issues.push({
        code: "unmapped_looker_field",
        lookerField: field,
        detail: `No field mapping for Looker field "${field}"`,
      });
      continue;
    }
    views.add(entry.metricViewName.toLowerCase());
  }

  const coerced = inventories
    ? coerceMetricViewName(preferredMetricView, inventories, views)
    : preferredMetricView;

  if (coerced) {
    const pref = coerced.toLowerCase();
    if (views.size > 0 && !views.has(pref)) {
      // Mapping targets a different name than the coerced inventory view —
      // still route to the inventory view when it is the only deployable one
      // or when mappings can be reconciled by callers first.
      if (inventories?.has(pref) && views.size === 1) {
        return { metricViewName: coerced, issues };
      }
      issues.push({
        code: "wrong_metric_view",
        metricViewName: coerced,
        detail: `Benchmark routed to "${coerced}" but mapped fields target: ${Array.from(views).join(", ")}`,
      });
      return { metricViewName: coerced, issues };
    }
    return {
      metricViewName: coerced,
      issues,
    };
  }

  if (views.size === 0) {
    return { issues };
  }
  if (views.size > 1) {
    issues.push({
      code: "wrong_metric_view",
      detail: `Looker fields map to multiple metric views: ${Array.from(views).join(", ")}`,
    });
    return { issues };
  }

  const only = Array.from(views)[0];
  const canonical = mapping.entries.find(
    (e) => e.metricViewName.toLowerCase() === only
  )?.metricViewName;
  const resolved =
    inventories && canonical
      ? coerceMetricViewName(canonical, inventories, views) ?? canonical
      : canonical ?? only;
  return { metricViewName: resolved, issues };
}

/**
 * Compile a Databricks benchmark query plan strictly from the field mapping.
 * Never assumes Looker and Databricks names are identical.
 */
/** Remap backtick-quoted identifiers in a SQL predicate via bare-name lookup. */
function remapPredicateIdents(
  predicate: string,
  remapBare: (bare: string) => string
): string {
  return predicate.replace(/`([^`]+)`/g, (_, ident: string) => {
    const mapped = remapBare(ident);
    return `\`${mapped.replace(/`/g, "``")}\``;
  });
}

export function compileBenchmarkFromMapping(params: {
  mapping: FieldMappingTable;
  inventories: Map<string, MetricViewInventory>;
  lookerFields: string[];
  filters?: Record<string, string>;
  /** Extra SQL predicates; backtick idents remapped to Databricks names. */
  predicates?: string[];
  sorts?: string[];
  preferredMetricView?: string;
}): BenchmarkCompilationResult {
  const issues: CompilationIssue[] = [];
  const usedMappings: FieldMappingEntry[] = [];

  // Align mapping metricViewName values to inventories that actually exist
  // (explore "tam_buildings" vs deployed "tam_buildings_metrics").
  const inventoryAssets = Array.from(params.inventories.values()).map((inv) => ({
    name: inv.name,
    type: "metric_view" as const,
    description: "",
    schema: "",
  }));
  const mapping = reconcileMappingMetricViewNames(
    params.mapping,
    inventoryAssets
  );

  const routed = resolveBenchmarkMetricView(
    mapping,
    params.lookerFields,
    params.preferredMetricView,
    params.inventories
  );
  issues.push(...routed.issues);

  const metricViewName = routed.metricViewName;
  if (!metricViewName) {
    return {
      ok: false,
      status: "query_compilation_error",
      issues,
      databricksFields: [],
      measureNames: new Set(),
      metricViewName: params.preferredMetricView ?? "",
      usedMappings,
    };
  }

  const inventory =
    params.inventories.get(metricViewName.toLowerCase()) ??
    params.inventories.get(metricViewName);
  if (!inventory) {
    issues.push({
      code: "empty_inventory",
      metricViewName,
      detail: `No metric-view inventory loaded for "${metricViewName}"`,
    });
    return {
      ok: false,
      status: "query_compilation_error",
      issues,
      databricksFields: [],
      measureNames: new Set(),
      metricViewName,
      usedMappings,
    };
  }

  const dimNames = new Set(
    inventory.dimensions.map((d) => canonicalizeFieldName(d.name))
  );
  const measureNamesInv = new Set(
    inventory.measures.map((m) => canonicalizeFieldName(m.name))
  );
  const measureExprs = new Map(
    inventory.measures.map((m) => [canonicalizeFieldName(m.name), m.expr])
  );

  const databricksFields: string[] = [];
  const measureNames = new Set<string>();

  for (const lookerField of params.lookerFields) {
    const entry = findMappingForLookerField(
      mapping,
      lookerField,
      metricViewName
    );
    if (!entry) {
      issues.push({
        code: "unmapped_looker_field",
        lookerField,
        metricViewName,
        detail: `Unmapped Looker field "${lookerField}" for metric view "${metricViewName}"`,
      });
      continue;
    }

    if (entry.metricViewName.toLowerCase() !== metricViewName.toLowerCase()) {
      issues.push({
        code: "wrong_metric_view",
        lookerField,
        metricViewName: entry.metricViewName,
        detail: `Field "${lookerField}" maps to "${entry.metricViewName}", not "${metricViewName}"`,
      });
      continue;
    }

    const dbName = entry.databricksField;
    const dbKey = canonicalizeFieldName(dbName);
    const exists =
      dimNames.has(dbKey) ||
      measureNamesInv.has(dbKey) ||
      // allow exact case match as defined
      inventory.dimensions.some((d) => d.name === dbName) ||
      inventory.measures.some((m) => m.name === dbName);

    if (!exists) {
      issues.push({
        code: "missing_databricks_field",
        lookerField,
        databricksField: dbName,
        metricViewName,
        detail: `Mapped Databricks ${entry.kind} "${dbName}" does not exist on metric view "${metricViewName}"`,
      });
      continue;
    }

    // Currency semantic check: refuse CAD↔USD silent aliasing on field *names*.
    // Do not treat CAD CASE branches inside a ratio/share expr as Looker currency.
    const lookerNameCurrency = detectCurrency(lookerField);
    const lookerMetaCurrency = normalizeCurrencyToken(entry.currency);
    const lookerUnit =
      entry.unit ??
      detectUnit(lookerField, entry.unit, entry.evidence?.unit);
    const isRatioLike =
      looksLikeRatioOrPercent(
        lookerField,
        entry.unit,
        entry.evidence?.unit,
        entry.evidence?.rationale
      ) || lookerUnit === "percent";

    const lookerCurrency = lookerNameCurrency ?? lookerMetaCurrency;
    const dbNameCurrency = detectCurrency(dbName);
    const dbExprCurrency = detectCurrency(measureExprs.get(dbKey));
    // Prefer field-name currency; only use expr currency when Looker also declares one
    // and the measure is not a dimensionless ratio/share.
    const effectiveDbCurrency = isRatioLike
      ? dbNameCurrency
      : (dbNameCurrency ??
        (lookerCurrency ? dbExprCurrency : undefined) ??
        normalizeCurrencyToken(entry.currency));

    if (
      lookerCurrency &&
      effectiveDbCurrency &&
      !currenciesCompatible(lookerCurrency, effectiveDbCurrency)
    ) {
      issues.push({
        code: "ambiguous_currency",
        lookerField,
        databricksField: dbName,
        detail: `Currency mismatch: Looker "${lookerField}" is ${lookerCurrency} but Databricks "${dbName}" is ${effectiveDbCurrency}`,
      });
      continue;
    }
    // Stronger: field-name currencies must agree when both present
    if (
      lookerNameCurrency &&
      dbNameCurrency &&
      !currenciesCompatible(lookerNameCurrency, dbNameCurrency)
    ) {
      issues.push({
        code: "ambiguous_currency",
        lookerField,
        databricksField: dbName,
        detail: `Currency mismatch: Looker "${lookerField}" is ${lookerNameCurrency} but Databricks "${dbName}" is ${dbNameCurrency}`,
      });
      continue;
    }

    usedMappings.push(entry);
    databricksFields.push(dbName);
    if (entry.kind === "measure" || measureNamesInv.has(dbKey)) {
      measureNames.add(canonicalizeFieldName(dbName));
    }
  }

  // Remap filters using mapping (dimension side)
  let filters: Record<string, string> | undefined;
  if (params.filters) {
    filters = {};
    for (const [lookerFilterField, expression] of Object.entries(params.filters)) {
      // Dashboard tiles often include empty filter placeholders and Looker
      // parameters (e.g. parent_customer_filter) that are not metric-view dims.
      if (expression == null || String(expression).trim() === "") {
        continue;
      }
      const entry = findMappingForLookerField(
        mapping,
        lookerFilterField,
        metricViewName
      );
      if (!entry) {
        // Identity fallback for filter dimensions: filters aren't in tile
        // SELECT lists, so mappings rarely cover them. An exact bare-name
        // dimension on the metric view is safe to filter on directly.
        const bareKey = canonicalizeFieldName(lookerFilterField);
        if (dimNames.has(bareKey)) {
          const canonicalDim =
            inventory.dimensions.find(
              (d) => canonicalizeFieldName(d.name) === bareKey
            )?.name ?? stripLookerFieldPrefix(lookerFilterField);
          filters[canonicalDim] = expression;
          continue;
        }
        issues.push({
          code: "unmapped_looker_field",
          lookerField: lookerFilterField,
          detail: `Filter field "${lookerFilterField}" has no mapping and no matching dimension on "${metricViewName}"`,
        });
        continue;
      }
      const dbKey = canonicalizeFieldName(entry.databricksField);
      if (!dimNames.has(dbKey) && !measureNamesInv.has(dbKey)) {
        issues.push({
          code: "missing_databricks_field",
          lookerField: lookerFilterField,
          databricksField: entry.databricksField,
          detail: `Mapped filter dimension "${entry.databricksField}" missing on "${metricViewName}"`,
        });
        continue;
      }
      filters[entry.databricksField] = expression;
    }
    if (Object.keys(filters).length === 0) filters = undefined;
  }

  const remapFilterBare = (bare: string): string => {
    const entry = findMappingForLookerField(mapping, bare, metricViewName);
    if (entry) return entry.databricksField;
    const bareKey = canonicalizeFieldName(bare);
    if (dimNames.has(bareKey)) {
      return (
        inventory!.dimensions.find(
          (d) => canonicalizeFieldName(d.name) === bareKey
        )?.name ?? stripLookerFieldPrefix(bare)
      );
    }
    return stripLookerFieldPrefix(bare);
  };

  let predicates: string[] | undefined;
  if (params.predicates?.length) {
    predicates = params.predicates.map((p) =>
      remapPredicateIdents(p, remapFilterBare)
    );
  }

  let sorts: string[] | undefined;
  if (params.sorts) {
    sorts = [];
    for (const sort of params.sorts) {
      const desc = /\s+desc$/i.test(sort.trim());
      const field = sort.replace(/\s+desc$/i, "").replace(/\s+asc$/i, "").trim();
      const entry = findMappingForLookerField(mapping, field, metricViewName);
      if (!entry) {
        issues.push({
          code: "unmapped_looker_field",
          lookerField: field,
          detail: `Sort field "${field}" has no mapping`,
        });
        continue;
      }
      sorts.push(`${entry.databricksField}${desc ? " desc" : ""}`);
      // Sort keys may be measures omitted from SELECT (out-of-inventory Looker
      // fields). Still mark them so ORDER BY can wrap MEASURE().
      if (
        entry.kind === "measure" ||
        measureNamesInv.has(canonicalizeFieldName(entry.databricksField))
      ) {
        measureNames.add(canonicalizeFieldName(entry.databricksField));
      }
    }
  }

  const ok = issues.length === 0 && databricksFields.length === params.lookerFields.length;

  return {
    ok,
    status: ok ? undefined : "query_compilation_error",
    issues,
    databricksFields,
    measureNames,
    filters,
    predicates,
    sorts,
    metricViewName,
    usedMappings,
  };
}

/**
 * Reject OpenAI mapping suggestions that rely only on name similarity
 * when currency/population conflict or evidence is missing.
 */
export function acceptMappingSuggestion(params: {
  lookerField: string;
  suggestedDatabricksField: string;
  lookerMeasure?: IrMeasure;
  databricksExpr?: string;
  evidence?: SemanticMappingEvidence;
}): { accept: boolean; reason: string } {
  const evidence = params.evidence;
  if (!evidence?.rationale?.trim()) {
    return {
      accept: false,
      reason: "Mapping rejected: semantic evidence/rationale is required",
    };
  }

  const lookerCurrency = normalizeCurrencyToken(
    detectCurrency(
      params.lookerField,
      params.lookerMeasure?.name,
      params.lookerMeasure?.label,
      params.lookerMeasure?.valueFormat
    ) ?? evidence.currency
  );
  const dbCurrency = normalizeCurrencyToken(
    detectCurrency(
      params.suggestedDatabricksField,
      // Ignore expr CAD for ratio-like Looker fields
      looksLikeRatioOrPercent(
        params.lookerField,
        params.lookerMeasure?.valueFormat,
        evidence.unit,
        evidence.currency
      )
        ? undefined
        : params.databricksExpr,
      evidence.currency
    )
  );

  if (!currenciesCompatible(lookerCurrency, dbCurrency)) {
    return {
      accept: false,
      reason: `Mapping rejected: currency conflict ${lookerCurrency} vs ${dbCurrency} (name similarity is not enough)`,
    };
  }

  // Same bare name alone is not evidence when currencies differ in sibling fields —
  // already handled above. Require aggregation or expr for measures.
  const isMeasureLike =
    Boolean(params.lookerMeasure) ||
    Boolean(detectAggregation(params.databricksExpr, params.lookerMeasure?.type));

  if (isMeasureLike) {
    const agg =
      evidence.aggregation ??
      detectAggregation(params.lookerMeasure?.sql, params.lookerMeasure?.type) ??
      detectAggregation(params.databricksExpr);
    if (!agg && !evidence.lookmlSql && !params.databricksExpr) {
      return {
        accept: false,
        reason:
          "Mapping rejected: measure mapping needs aggregation/filter/expr evidence, not name similarity",
      };
    }
  }

  return { accept: true, reason: "ok" };
}

/** Attach mapping entries onto metric_view assets (mutates copies). */
export function applyMappingTableToAssets(
  assets: ProposedAsset[],
  mapping: FieldMappingTable
): ProposedAsset[] {
  return assets.map((asset) => {
    if (asset.type !== "metric_view") return asset;
    const entries = mapping.entries.filter(
      (e) => e.metricViewName.toLowerCase() === asset.name.toLowerCase()
    );
    return { ...asset, fieldMappings: entries };
  });
}

export function formatCompilationError(issues: CompilationIssue[]): string {
  return issues.map((i) => `[${i.code}] ${i.detail}`).join("; ");
}

/** Helper for tests / repair: strip Looker prefix consistently. */
export { stripLookerFieldPrefix, canonicalizeFieldName };

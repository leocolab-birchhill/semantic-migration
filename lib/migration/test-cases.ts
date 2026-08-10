import {
  dynamicFieldNameMap,
  serializeLookerDynamicFields,
  type LookerDynamicField,
} from "@/lib/migration/dynamic-fields";
import type {
  IntermediateRepresentation,
  LookerBenchmark,
  TestCase,
} from "@/lib/migration/types";

/**
 * Build reconciliation tests from Looker semantic inventory / dashboard tiles.
 * Unsupported tile features (e.g. table totals) are recorded as skipped rather
 * than silent passes.
 *
 * Mandatory tests = real dashboard/Look tile benchmarks only.
 * Synthetic smoke/baseline tests are never mandatory and cannot alone unlock approval.
 *
 * Scope = explore inventory (+ captured dynamic_fields formulas). Dashboard tiles
 * are validation harnesses for that scope: fields not in inventory/dynamic defs
 * are dropped (no inventory-gap tests). Partially resolvable tiles still run on
 * the resolvable subset only.
 *
 * Dashboard dynamic fields (custom measures / table calcs) with known formulas are
 * expected columns for parity tests and must be implemented in the metric view
 * (or dashboard_calc) by generation.
 */

function expectedColumnsFromResolved(resolved: {
  resolved: string[];
  dynamic: LookerDynamicField[];
}): string[] {
  return [
    ...resolved.resolved,
    ...resolved.dynamic.map((d) => d.name),
  ];
}

/** Keep only tile fields that resolved against inventory or dynamic defs. */
function keepResolvableFields(
  fields: string[],
  missing: string[]
): string[] {
  if (missing.length === 0) return fields;
  const miss = new Set(missing.map((f) => f.toLowerCase()));
  return fields.filter((f) => !miss.has(f.toLowerCase()));
}
export function buildTestCases(
  inventory: IntermediateRepresentation,
  options?: { benchmarks?: LookerBenchmark[] }
): TestCase[] {
  const tests: TestCase[] = [];
  const model = inventory.source.model;
  const explore = inventory.source.explore;
  const benchmarks = options?.benchmarks ?? inventory.benchmarks ?? [];
  const visibleDims = inventory.dimensions.filter((d) => !d.hidden);
  const measures = inventory.measures;

  // Schema coverage — documents what the semantic layer exposes (never mandatory)
  tests.push({
    id: "schema_coverage",
    name: "Semantic schema coverage",
    type: "schema",
    lookerQuery: {
      model,
      view: explore,
      fields: [],
      limit: "1",
    },
    expectedColumns: [],
    skipReason: `${visibleDims.length} dimensions, ${measures.length} measures inventoried`,
    skipStatus: "inconclusive",
    mandatory: false,
  });

  // Prefer immutable captured benchmarks when present
  if (benchmarks.length > 0) {
    for (const b of benchmarks) {
      const dynamicFields =
        b.dynamicFields ??
        inventory.tileQueries.find((t) => t.id === b.tileId)?.dynamicFields ??
        [];
      const resolvedFields = resolveFieldsAgainstInventory(
        inventory,
        b.fields,
        dynamicFields
      );
      const expectedColumns = expectedColumnsFromResolved(resolvedFields);
      // Outside explore/dynamic scope — not part of the migrated semantic layer.
      if (expectedColumns.length === 0) continue;

      const isPivot = Boolean(b.pivots && b.pivots.length > 0);
      const fields = keepResolvableFields(b.fields, resolvedFields.missing);

      tests.push({
        id: isPivot ? `benchmark_${b.tileId}_pivot` : `benchmark_${b.tileId}`,
        name: isPivot ? `${b.title} (pivot dims as columns)` : b.title,
        type: isPivot ? "pivot" : "tile",
        lookerQuery: {
          ...b.queryDefinition,
          // Only inventory/dynamic fields — out-of-scope tile fields are ignored.
          fields,
          pivots: isPivot ? undefined : b.queryDefinition.pivots,
        },
        expectedColumns,
        mandatory: true,
        capturedJsonBi: isPivot ? undefined : b.jsonBi,
        capturedLookerSql: b.generatedSql,
        metricViewName: suggestMetricViewName(b.explore),
      });
    }
  } else if (inventory.tileQueries.length > 0) {
    for (const tile of inventory.tileQueries) {
      if (!tile.fields || tile.fields.length === 0) {
        tests.push({
          id: `tile_${tile.id}_empty`,
          name: `${tile.title} (no fields)`,
          type: "tile",
          lookerQuery: { model: tile.model, view: tile.explore, fields: [] },
          expectedColumns: [],
          skipReason: "Tile has no fields",
          skipStatus: "inconclusive",
          mandatory: true,
        });
        continue;
      }

      const dynamicFieldsJson = serializeLookerDynamicFields(tile.dynamicFields);
      const resolvedFields = resolveFieldsAgainstInventory(
        inventory,
        tile.fields,
        tile.dynamicFields
      );

      if (tile.pivots && tile.pivots.length > 0) {
        const pivotExpected = expectedColumnsFromResolved(resolvedFields);
        if (pivotExpected.length === 0) continue;

        const pivotFields = keepResolvableFields(
          tile.fields,
          resolvedFields.missing
        );
        tests.push({
          id: `tile_${tile.id}_pivot`,
          name: `${tile.title} (pivot dims as columns)`,
          type: "pivot",
          lookerQuery: {
            model: tile.model,
            view: tile.explore,
            fields: pivotFields,
            filters: tile.filters,
            sorts: tile.sorts,
            limit: (tile.limit ?? 100).toString(),
            query_timezone: tile.timezone,
            ...(dynamicFieldsJson
              ? { dynamic_fields: dynamicFieldsJson }
              : {}),
          },
          expectedColumns: pivotExpected,
          mandatory: true,
          metricViewName: suggestMetricViewName(tile.explore),
        });
        continue;
      }

      if (tile.total) {
        tests.push({
          id: `tile_${tile.id}_total`,
          name: `${tile.title} (table totals unsupported)`,
          type: "total",
          lookerQuery: {
            model: tile.model,
            view: tile.explore,
            fields: tile.fields,
            total: true,
            ...(dynamicFieldsJson
              ? { dynamic_fields: dynamicFieldsJson }
              : {}),
          },
          expectedColumns: tile.fields,
          skipReason:
            "Looker table totals are not yet translated to metric-view SQL",
          skipStatus: "unsupported",
          mandatory: false,
        });
      }

      const expectedColumns = expectedColumnsFromResolved(resolvedFields);
      if (expectedColumns.length === 0) continue;

      const fields = keepResolvableFields(
        tile.fields,
        resolvedFields.missing
      );
      const lookerQuery: Record<string, unknown> = {
        model: tile.model,
        view: tile.explore,
        fields,
        filters: tile.filters,
        sorts: tile.sorts,
        limit: (tile.limit ?? 100).toString(),
        query_timezone: tile.timezone,
      };
      if (tile.filterExpression) {
        lookerQuery.filter_expression = tile.filterExpression;
      }
      if (dynamicFieldsJson) {
        lookerQuery.dynamic_fields = dynamicFieldsJson;
      }

      tests.push({
        id: `tile_${tile.id}`,
        name: tile.title,
        type: "tile",
        lookerQuery,
        expectedColumns,
        mandatory: true,
        metricViewName: suggestMetricViewName(tile.explore),
      });
    }
  }

  // Baseline / smoke — synthetic, never mandatory
  const sampleDims = visibleDims.slice(0, 3).map((d) => d.name);
  const sampleMeasures = measures.slice(0, 2).map((m) => m.name);
  if (sampleDims.length > 0 || sampleMeasures.length > 0) {
    tests.push({
      id: "baseline",
      name: "Baseline explore query",
      type: "measure",
      lookerQuery: {
        model,
        view: explore,
        fields: [...sampleDims, ...sampleMeasures],
        sorts: sampleDims[0] ? [sampleDims[0]] : undefined,
        limit: "100",
      },
      expectedColumns: [...sampleDims, ...sampleMeasures],
      mandatory: false,
    });
  }
  if (sampleDims[0] && sampleMeasures[0]) {
    tests.push({
      id: "smoke_dim_measure",
      name: `Smoke: ${sampleDims[0]} + ${sampleMeasures[0]}`,
      type: "smoke",
      lookerQuery: {
        model,
        view: explore,
        fields: [sampleDims[0], sampleMeasures[0]],
        sorts: [sampleDims[0]],
        limit: "50",
      },
      expectedColumns: [sampleDims[0], sampleMeasures[0]],
      mandatory: false,
    });
  } else if (sampleDims[0]) {
    tests.push({
      id: "smoke_dimension",
      name: `Smoke dimension: ${sampleDims[0]}`,
      type: "dimension",
      lookerQuery: {
        model,
        view: explore,
        fields: [sampleDims[0]],
        limit: "50",
      },
      expectedColumns: [sampleDims[0]],
      mandatory: false,
    });
  }

  return tests;
}

/** Default metric view naming: explore name sanitized. */
export function suggestMetricViewName(explore: string): string {
  return explore
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

/** Fields referenced by a tile that are absent from explore inventory AND dynamic fields. */
export function fieldsMissingFromInventory(
  inventory: IntermediateRepresentation,
  fields: string[],
  dynamicFields?: LookerDynamicField[]
): string[] {
  return resolveFieldsAgainstInventory(inventory, fields, dynamicFields)
    .missing;
}

/**
 * Resolve tile field names against explore inventory and dashboard dynamic fields.
 * - resolved: LookML inventory hits (prefer fully-qualified inventory name)
 * - dynamic: dashboard custom measures / dims / table calcs with formulas
 * - missing: neither inventory nor dynamic definition
 */
export function resolveFieldsAgainstInventory(
  inventory: IntermediateRepresentation,
  fields: string[],
  dynamicFields?: LookerDynamicField[]
): {
  resolved: string[];
  dynamic: LookerDynamicField[];
  missing: string[];
} {
  const entries = [...inventory.dimensions, ...inventory.measures];
  const byFull = new Map(entries.map((f) => [f.name.toLowerCase(), f.name]));
  const byBare = new Map<string, string>();
  const byLabel = new Map<string, string>();
  for (const f of entries) {
    const bare = f.name.includes(".")
      ? f.name.slice(f.name.lastIndexOf(".") + 1).toLowerCase()
      : f.name.toLowerCase();
    if (!byBare.has(bare)) byBare.set(bare, f.name);
    if (f.label) {
      const label = f.label.toLowerCase().trim();
      if (label && !byLabel.has(label)) byLabel.set(label, f.name);
    }
  }

  const dynMap = dynamicFieldNameMap([
    ...(dynamicFields ?? []),
    ...(inventory.dynamicFields ?? []),
  ]);

  const resolved: string[] = [];
  const dynamic: LookerDynamicField[] = [];
  const missing: string[] = [];
  const seenDyn = new Set<string>();

  for (const field of fields) {
    const lower = field.toLowerCase();
    const bare = field.includes(".")
      ? field.slice(field.lastIndexOf(".") + 1).toLowerCase()
      : lower;
    const hit =
      byFull.get(lower) ??
      byBare.get(bare) ??
      byBare.get(lower) ??
      byLabel.get(lower);
    if (hit) {
      resolved.push(hit);
      continue;
    }

    const dyn = dynMap.get(bare) ?? dynMap.get(lower);
    if (dyn) {
      if (!seenDyn.has(dyn.name.toLowerCase())) {
        dynamic.push(dyn);
        seenDyn.add(dyn.name.toLowerCase());
      }
      continue;
    }

    missing.push(field);
  }

  return { resolved, dynamic, missing };
}

/** Count runnable mandatory benchmarks (excludes skipped unsupported). */
export function countMandatoryBenchmarks(tests: TestCase[]): {
  total: number;
  runnable: number;
} {
  const mandatory = tests.filter((t) => t.mandatory);
  return {
    total: mandatory.length,
    runnable: mandatory.filter((t) => !t.skipStatus).length,
  };
}

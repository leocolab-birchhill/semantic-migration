import {

  getQuerySql,

  runInlineQuery,

  type LookerQueryWrite,

} from "@/lib/looker/client";

import { lookerJsonBiToRowSet } from "@/lib/migration/comparator";

import { mapPool } from "@/lib/migration/concurrency";

import { serializeLookerDynamicFields } from "@/lib/migration/dynamic-fields";

import type {

  ConfirmedMigrationScope,

  LookerBenchmark,

} from "@/lib/migration/types";



/** Parallel Looker tile captures — keeps API polite while cutting wall time. */

const BASELINE_CONCURRENCY = 6;



/**

 * Capture immutable Looker benchmarks for every selected tile before generation.

 * Stores query definition, filters, dynamic_fields, SQL, and exact json_bi results.

 */

export async function captureLookerBenchmarks(

  scope: ConfirmedMigrationScope,

  defaultTimezone = "UTC"

): Promise<LookerBenchmark[]> {

  // Explore-only migrations may have no dashboard/Look tiles; smoke tests still run.

  if (scope.tiles.length === 0) {

    return [];

  }



  return mapPool(scope.tiles, BASELINE_CONCURRENCY, async (tile) => {

    if (!tile.fields || tile.fields.length === 0) {

      throw new Error(

        `Benchmark tile "${tile.title}" has no fields and cannot prove parity`

      );

    }



    const dynamicFieldsJson = serializeLookerDynamicFields(tile.dynamicFields);



    const queryDefinition: LookerQueryWrite = {

      model: tile.model,

      view: tile.explore,

      fields: tile.fields,

      filters: tile.filters,

      sorts: tile.sorts,

      limit: String(tile.limit ?? 500),

      pivots: tile.pivots,

      total: tile.total,

      query_timezone: tile.timezone ?? defaultTimezone,

      ...(dynamicFieldsJson ? { dynamic_fields: dynamicFieldsJson } : {}),

    };



    const queryBody = {

      ...queryDefinition,

      ...(tile.filterExpression

        ? { filter_expression: tile.filterExpression }

        : {}),

    };



    let generatedSql: string | undefined;

    try {

      generatedSql = await getQuerySql(queryBody as LookerQueryWrite);

    } catch {

      generatedSql = undefined;

    }



    const jsonBi = await runInlineQuery(

      queryBody as LookerQueryWrite,

      "json_bi"

    );



    const parsed = lookerJsonBiToRowSet(

      jsonBi as unknown as Record<string, unknown>

    );

    const rowCount = parsed.rows.length;



    if (rowCount === 0 && parsed.columns.length === 0) {

      throw new Error(

        `Benchmark tile "${tile.title}" returned no rows and no schema from Looker — ` +

          `the captured baseline would be unusable. Check the tile query/filters before starting migration.`

      );

    }



    return {

      tileId: tile.id,

      title: tile.title,

      model: tile.model,

      explore: tile.explore,

      sourceKind: tile.sourceKind,

      queryDefinition: queryBody as Record<string, unknown>,

      fields: tile.fields,

      filters: tile.filters,

      filterExpression: tile.filterExpression,

      pivots: tile.pivots,

      sorts: tile.sorts,

      limit: tile.limit,

      timezone: tile.timezone ?? defaultTimezone,

      generatedSql,

      jsonBi,

      rowCount,

      capturedAt: new Date().toISOString(),

      mandatory: true as const,

      dynamicFields: tile.dynamicFields,

    };

  });

}



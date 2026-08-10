import {
  getExplore,
  getModel,
  getProjectFileContent,
  getQuery,
  listProjectFiles,
  type LookerFileEntry,
} from "@/lib/looker/client";
import {
  parseLookerDynamicFields,
  type LookerDynamicField,
  mergeDynamicFields,
} from "@/lib/migration/dynamic-fields";
import type {
  ConfirmedMigrationScope,
  IntermediateRepresentation,
  IrDimension,
  IrFilter,
  IrJoin,
  IrMeasure,
  IrParameter,
  IrTileQuery,
} from "@/lib/migration/types";

function dedupeDynamicFields(
  fields: LookerDynamicField[]
): LookerDynamicField[] {
  return mergeDynamicFields(fields) ?? [];
}

interface LookerField {
  name?: string;
  label?: string;
  type?: string;
  sql?: string;
  description?: string;
  hidden?: boolean;
  value_format?: string;
  tags?: string[];
  category?: string;
  /** Measure-level filters (LookML `filters:` blocks) — critical population evidence. */
  filters?: Array<{ field?: string; condition?: string } | string>;
}

interface LookerExploreDetail {
  name: string;
  label?: string;
  description?: string;
  view_name?: string;
  sql_table_name?: string;
  fields?: { dimensions?: LookerField[]; measures?: LookerField[] };
  joins?: Array<{
    name?: string;
    type?: string;
    sql_on?: string;
    relationship?: string;
    foreign_key?: string;
  }>;
  sets?: unknown[];
  always_filter?: unknown[];
}

function mapDimension(f: LookerField): IrDimension {
  return {
    name: f.name ?? "",
    label: f.label,
    type: f.type ?? "string",
    sql: f.sql,
    description: f.description,
    hidden: f.hidden,
    valueFormat: f.value_format,
    tags: f.tags,
  };
}

function mapMeasure(f: LookerField): IrMeasure {
  return {
    name: f.name ?? "",
    label: f.label,
    type: f.type ?? "number",
    sql: f.sql,
    description: f.description,
    valueFormat: f.value_format,
    tags: f.tags,
    filters: f.filters?.map((flt) =>
      typeof flt === "string"
        ? flt
        : `${flt.field ?? ""}: ${flt.condition ?? ""}`.trim()
    ),
  };
}

async function collectLookmlFiles(
  projectName: string,
  modelName: string
): Promise<Array<{ path: string; contents: string }>> {
  const files: Array<{ path: string; contents: string }> = [];
  try {
    const projects = await listProjectFiles(projectName);
    await walkProjectFiles(projectName, projects, files, modelName);
  } catch {
    // Project file access may be restricted; continue with API metadata only
  }
  return files;
}

async function walkProjectFiles(
  projectId: string,
  entries: LookerFileEntry[],
  out: Array<{ path: string; contents: string }>,
  modelFilter: string
): Promise<void> {
  for (const entry of entries) {
    if (entry.type === "dir" || entry.type === "directory") {
      const children = await listProjectFiles(projectId, entry.path);
      await walkProjectFiles(projectId, children, out, modelFilter);
    } else if (
      entry.extension === ".lkml" ||
      entry.extension === ".lookml" ||
      entry.path.includes(modelFilter)
    ) {
      try {
        const file = await getProjectFileContent(projectId, entry.path);
        if (file.contents) {
          out.push({ path: entry.path, contents: file.contents });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
}

export async function buildExploreInventory(
  modelName: string,
  exploreName: string
): Promise<IntermediateRepresentation> {
  const [model, exploreRaw] = await Promise.all([
    getModel(modelName),
    getExplore(modelName, exploreName),
  ]);

  const explore = exploreRaw as unknown as LookerExploreDetail;
  const dims = (explore.fields?.dimensions ?? []).map(mapDimension);
  const measures = (explore.fields?.measures ?? []).map(mapMeasure);

  const joins: IrJoin[] = (explore.joins ?? []).map((j) => ({
    name: j.name ?? "",
    type: j.type ?? "left_outer",
    sqlOn: j.sql_on,
    relationship: j.relationship,
    foreignKey: j.foreign_key,
  }));

  const filters: IrFilter[] = [];
  const parameters: IrParameter[] = [];

  for (const f of explore.fields?.dimensions ?? []) {
    if (f.type === "filter") {
      filters.push({ name: f.name ?? "", type: f.type });
    }
  }

  const lookmlFiles = await collectLookmlFiles(model.project_name, modelName);

  const unsupported: string[] = [];
  if (explore.sets?.length) unsupported.push("sets");
  if (explore.always_filter?.length) unsupported.push("always_filter");

  return {
    version: "1.0",
    source: {
      type: "explore",
      model: modelName,
      explore: exploreName,
      projectName: model.project_name,
    },
    grain: {
      sqlDistinctKey: undefined,
      dimensions: dims.filter((d) => !d.hidden).map((d) => d.name),
    },
    joins,
    dimensions: dims,
    measures,
    filters,
    parameters,
    derivedTables: [],
    liquidLogic: [],
    userAttributes: [],
    formatting: {},
    tileQueries: [],
    unsupportedFeatures: unsupported,
    lookmlFiles,
  };
}

export async function buildDashboardInventory(
  dashboardId: string,
  dashboardTitle: string,
  elements: Array<{
    id: string;
    title?: string;
    query?: Record<string, unknown>;
    query_id?: string | null;
    result_maker?: { query?: Record<string, unknown> };
  }>
): Promise<IntermediateRepresentation> {
  const tileQueries: IrTileQuery[] = [];
  let primaryModel = "";
  let primaryExplore = "";
  const allDynamic: LookerDynamicField[] = [];

  for (const el of elements) {
    let q = el.query;
    if (
      (!q || !(q.model || q.view)) &&
      el.result_maker?.query
    ) {
      q = el.result_maker.query;
    }
    if ((!q || !(q.model || q.view)) && el.query_id) {
      try {
        q = await getQuery(el.query_id);
      } catch {
        continue;
      }
    }

    const query = q as {
      model?: string;
      view?: string;
      fields?: string[];
      filters?: Record<string, string>;
      filter_expression?: string;
      sorts?: string[];
      limit?: string;
      pivots?: string[];
      total?: boolean;
      query_timezone?: string;
      dynamic_fields?: unknown;
    } | undefined;

    if (!query?.model || !query?.view) continue;

    if (!primaryModel) {
      primaryModel = query.model;
      primaryExplore = query.view;
    }

    const dynamicFields = parseLookerDynamicFields(query.dynamic_fields);
    allDynamic.push(...dynamicFields);

    tileQueries.push({
      id: el.id,
      title: el.title ?? `Tile ${el.id}`,
      model: query.model,
      explore: query.view,
      fields: query.fields ?? [],
      filters: query.filters,
      filterExpression: query.filter_expression,
      sorts: query.sorts,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      pivots: query.pivots,
      total: query.total,
      timezone: query.query_timezone,
      sourceKind: "dashboard_tile",
      dashboardId,
      dashboardTitle,
      dynamicFields: dynamicFields.length ? dynamicFields : undefined,
    });
  }

  if (!primaryModel || !primaryExplore) {
    throw new Error("Dashboard has no queryable tiles");
  }

  const base = await buildExploreInventory(primaryModel, primaryExplore);
  const dynamicFields = dedupeDynamicFields(allDynamic);
  return {
    ...base,
    source: {
      ...base.source,
      type: "dashboard",
      dashboardId,
      dashboardTitle,
    },
    tileQueries,
    dynamicFields: dynamicFields.length ? dynamicFields : undefined,
  };
}

/**
 * Build inventory from a confirmed table-first scope (selected explores + tiles).
 */
export async function buildScopedInventory(
  scope: ConfirmedMigrationScope
): Promise<IntermediateRepresentation> {
  if (scope.explores.length === 0) {
    throw new Error("Select at least one Explore to migrate");
  }

  const primary = scope.explores[0];
  let merged = await buildExploreInventory(primary.model, primary.explore);

  const dimNames = new Set(merged.dimensions.map((d) => d.name));
  const measureNames = new Set(merged.measures.map((m) => m.name));
  const joinNames = new Set(merged.joins.map((j) => j.name));
  const lookmlPaths = new Set(merged.lookmlFiles.map((f) => f.path));

  for (const explore of scope.explores.slice(1)) {
    const next = await buildExploreInventory(explore.model, explore.explore);
    for (const d of next.dimensions) {
      if (!dimNames.has(d.name)) {
        merged.dimensions.push(d);
        dimNames.add(d.name);
      }
    }
    for (const m of next.measures) {
      if (!measureNames.has(m.name)) {
        merged.measures.push(m);
        measureNames.add(m.name);
      }
    }
    for (const j of next.joins) {
      if (!joinNames.has(j.name)) {
        merged.joins.push(j);
        joinNames.add(j.name);
      }
    }
    for (const f of next.lookmlFiles) {
      if (!lookmlPaths.has(f.path)) {
        merged.lookmlFiles.push(f);
        lookmlPaths.add(f.path);
      }
    }
    merged.unsupportedFeatures = Array.from(
      new Set([...merged.unsupportedFeatures, ...next.unsupportedFeatures])
    );
  }

  const tileQueries: IrTileQuery[] = scope.tiles.map((t) => ({
    id: t.id,
    title: t.title,
    model: t.model,
    explore: t.explore,
    fields: t.fields,
    filters: t.filters,
    filterExpression: t.filterExpression,
    sorts: t.sorts,
    limit: t.limit,
    pivots: t.pivots,
    total: t.total,
    timezone: t.timezone,
    sourceKind: t.sourceKind,
    dashboardId: t.dashboardId,
    dashboardTitle: t.dashboardTitle,
    lookId: t.lookId,
    dynamicFields: t.dynamicFields,
  }));

  const dynamicFields = dedupeDynamicFields(
    scope.tiles.flatMap((t) => t.dynamicFields ?? [])
  );

  return {
    ...merged,
    source: {
      type: "table_scope",
      model: primary.model,
      explore: primary.explore,
      projectName: merged.source.projectName,
      sourceTable: scope.sourceTable,
    },
    grain: {
      ...merged.grain,
      dimensions: merged.dimensions.filter((d) => !d.hidden).map((d) => d.name),
    },
    tileQueries,
    confirmedExplores: scope.explores,
    dynamicFields: dynamicFields.length ? dynamicFields : undefined,
  };
}

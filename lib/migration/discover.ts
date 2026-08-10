import {
  getDashboard,
  getExplore,
  getLook,
  getModel,
  getProjectFileContent,
  getQuery,
  getQuerySql,
  listDashboards,
  listLooks,
  listModels,
  listProjectFiles,
  type LookerDashboardElement,
  type LookerFileEntry,
  type LookerQueryWrite,
} from "@/lib/looker/client";
import {
  confidenceFromEvidence,
  maxConfidence,
} from "@/lib/migration/discovery-confidence";
import { parseLookerDynamicFields } from "@/lib/migration/dynamic-fields";
import {
  extractDerivedTableSql,
  extractQualifiedTableRefsFromSql,
  extractSqlTableNames,
  normalizeTableRef,
  referencesTable,
} from "@/lib/migration/table-names";
import type {
  DiscoveredExplore,
  DiscoveredTile,
  DiscoveredView,
  DiscoveryEvidence,
  LookerReferencedTable,
  LookerReferencedTableSource,
  LookerReferencedTablesResult,
  TableDiscoveryResult,
} from "@/lib/migration/types";

interface FileHit {
  project: string;
  path: string;
  contents: string;
  viewName: string | null;
  evidence: DiscoveryEvidence[];
}

async function walkAllFiles(
  projectId: string,
  entries: LookerFileEntry[],
  out: Array<{ path: string; project: string }>
): Promise<void> {
  for (const entry of entries) {
    if (entry.type === "dir" || entry.type === "directory") {
      const children = await listProjectFiles(projectId, entry.path);
      await walkAllFiles(projectId, children, out);
      continue;
    }
    if (
      entry.extension === ".lkml" ||
      entry.extension === ".lookml" ||
      entry.path.endsWith(".lkml") ||
      entry.path.endsWith(".lookml")
    ) {
      out.push({ path: entry.path, project: projectId });
    }
  }
}

function viewNameFromPath(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  if (base.endsWith(".view.lkml")) {
    return base.replace(/\.view\.lkml$/, "");
  }
  return null;
}

function scanFileForTable(
  contents: string,
  path: string,
  catalog: string,
  schema: string,
  table: string
): DiscoveryEvidence[] {
  const evidence: DiscoveryEvidence[] = [];

  for (const sqlTable of extractSqlTableNames(contents)) {
    if (referencesTable(sqlTable, catalog, schema, table)) {
      evidence.push({
        kind: "sql_table_name",
        detail: `sql_table_name: ${sqlTable}`,
        path,
      });
    }
  }

  for (const derived of extractDerivedTableSql(contents)) {
    if (referencesTable(derived, catalog, schema, table)) {
      evidence.push({
        kind: "derived_sql",
        detail: "derived_table sql references source table",
        path,
      });
    }
  }

  // Catch FROM/JOIN references outside derived_table blocks
  if (
    evidence.length === 0 &&
    referencesTable(contents, catalog, schema, table)
  ) {
    evidence.push({
      kind: "derived_sql",
      detail: "LookML contents reference source table",
      path,
    });
  }

  return evidence;
}

async function collectLookmlHits(
  catalog: string,
  schema: string,
  table: string
): Promise<FileHit[]> {
  const models = await listModels();
  const projects = Array.from(
    new Set(models.map((m) => m.project_name).filter(Boolean))
  );

  const fileIndex: Array<{ path: string; project: string }> = [];
  for (const project of projects) {
    try {
      const root = await listProjectFiles(project);
      await walkAllFiles(project, root, fileIndex);
    } catch {
      // Project file access may be restricted
    }
  }

  const hits: FileHit[] = [];
  // Cap file reads to keep discovery responsive
  const limited = fileIndex.slice(0, 500);

  for (const file of limited) {
    try {
      const content = await getProjectFileContent(file.project, file.path);
      const contents = content.contents ?? "";
      if (!contents) continue;
      const evidence = scanFileForTable(
        contents,
        file.path,
        catalog,
        schema,
        table
      );
      if (evidence.length === 0) continue;
      hits.push({
        project: file.project,
        path: file.path,
        contents,
        viewName: viewNameFromPath(file.path),
        evidence,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return hits;
}

function parseQueryFields(q: Record<string, unknown> | undefined): {
  model?: string;
  explore?: string;
  fields: string[];
  filters?: Record<string, string>;
  filterExpression?: string;
  sorts?: string[];
  limit?: number;
  pivots?: string[];
  total?: boolean;
  timezone?: string;
  dynamicFields: ReturnType<typeof parseLookerDynamicFields>;
} {
  if (!q) return { fields: [], dynamicFields: [] };
  return {
    model: typeof q.model === "string" ? q.model : undefined,
    explore: typeof q.view === "string" ? q.view : undefined,
    fields: Array.isArray(q.fields) ? (q.fields as string[]) : [],
    filters:
      q.filters && typeof q.filters === "object"
        ? (q.filters as Record<string, string>)
        : undefined,
    filterExpression:
      typeof q.filter_expression === "string"
        ? q.filter_expression
        : undefined,
    sorts: Array.isArray(q.sorts) ? (q.sorts as string[]) : undefined,
    limit:
      typeof q.limit === "string"
        ? parseInt(q.limit, 10)
        : typeof q.limit === "number"
          ? q.limit
          : undefined,
    pivots: Array.isArray(q.pivots) ? (q.pivots as string[]) : undefined,
    total: Boolean(q.total),
    timezone:
      typeof q.query_timezone === "string" ? q.query_timezone : undefined,
    dynamicFields: parseLookerDynamicFields(q.dynamic_fields),
  };
}

/** Prefer nested query, then result_maker.query, then fetch by query_id. */
async function resolveElementQuery(
  el: LookerDashboardElement
): Promise<Record<string, unknown> | undefined> {
  if (el.query && typeof el.query === "object") {
    const q = el.query as Record<string, unknown>;
    if (q.model || q.view || (Array.isArray(q.fields) && q.fields.length)) {
      return q;
    }
  }

  const resultMaker = (el as { result_maker?: { query?: Record<string, unknown> } })
    .result_maker;
  if (resultMaker?.query && typeof resultMaker.query === "object") {
    return resultMaker.query;
  }

  if (el.query_id) {
    try {
      return await getQuery(el.query_id);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Discover Looker semantic content that ultimately references a Databricks table.
 */
export async function discoverLookerDependencies(input: {
  catalog: string;
  schema: string;
  table: string;
  /** When true, also probe generated SQL for dashboards/looks (slower). */
  probeGeneratedSql?: boolean;
}): Promise<TableDiscoveryResult> {
  const { catalog, schema, table } = input;
  const probeSql = input.probeGeneratedSql !== false;

  const fileHits = await collectLookmlHits(catalog, schema, table);

  const viewsByName = new Map<string, DiscoveredView>();
  for (const hit of fileHits) {
    const name = hit.viewName ?? hit.path;
    const existing = viewsByName.get(name);
    const confidence = confidenceFromEvidence(hit.evidence);
    if (!existing) {
      viewsByName.set(name, {
        name,
        project: hit.project,
        path: hit.path,
        confidence,
        evidence: hit.evidence,
        role: "automatic_dependency",
      });
    } else {
      existing.evidence.push(...hit.evidence);
      existing.confidence = maxConfidence(existing.confidence, confidence);
    }
  }

  const viewNames = new Set(viewsByName.keys());
  const exploresByKey = new Map<string, DiscoveredExplore>();

  const models = await listModels();
  for (const modelSummary of models) {
    let modelDetail: Awaited<ReturnType<typeof getModel>>;
    try {
      modelDetail = await getModel(modelSummary.name);
    } catch {
      continue;
    }

    for (const exploreSummary of modelDetail.explores ?? []) {
      try {
        const exploreRaw = await getExplore(
          modelSummary.name,
          exploreSummary.name
        );
        const explore = exploreRaw as {
          name?: string;
          view_name?: string;
          sql_table_name?: string;
          joins?: Array<{ name?: string; sql_table_name?: string }>;
        };

        const evidence: DiscoveryEvidence[] = [];
        const linkedViews: string[] = [];

        if (
          explore.sql_table_name &&
          referencesTable(explore.sql_table_name, catalog, schema, table)
        ) {
          evidence.push({
            kind: "explore_metadata",
            detail: `explore sql_table_name: ${explore.sql_table_name}`,
          });
        }

        const baseView = explore.view_name ?? explore.name ?? exploreSummary.name;
        if (baseView && viewNames.has(baseView)) {
          linkedViews.push(baseView);
          evidence.push({
            kind: "sql_table_name",
            detail: `base view ${baseView} references source table`,
          });
        }

        // Name heuristic: view named like the table
        if (
          baseView &&
          baseView.toLowerCase() === table.toLowerCase() &&
          !linkedViews.includes(baseView)
        ) {
          linkedViews.push(baseView);
          evidence.push({
            kind: "query_view",
            detail: `explore base view name matches table ${table}`,
          });
        }

        for (const join of explore.joins ?? []) {
          if (join.name && viewNames.has(join.name)) {
            linkedViews.push(join.name);
            evidence.push({
              kind: "sql_table_name",
              detail: `joined view ${join.name} references source table`,
            });
          }
          if (
            join.sql_table_name &&
            referencesTable(join.sql_table_name, catalog, schema, table)
          ) {
            evidence.push({
              kind: "explore_metadata",
              detail: `join ${join.name} sql_table_name: ${join.sql_table_name}`,
            });
          }
        }

        if (evidence.length === 0) continue;

        const key = `${modelSummary.name}.${exploreSummary.name}`;
        exploresByKey.set(key, {
          model: modelSummary.name,
          explore: exploreSummary.name,
          label: exploreSummary.label ?? undefined,
          confidence: confidenceFromEvidence(evidence),
          evidence,
          viewNames: Array.from(new Set(linkedViews)),
          role: "migration_unit",
        });
      } catch {
        // Skip explores that fail to load
      }
    }
  }

  // If we found views but no explores yet, attach explores whose name/view matches
  if (exploresByKey.size === 0 && viewNames.size > 0) {
    for (const modelSummary of models) {
      try {
        const modelDetail = await getModel(modelSummary.name);
        for (const exploreSummary of modelDetail.explores ?? []) {
          if (!viewNames.has(exploreSummary.name)) continue;
          const key = `${modelSummary.name}.${exploreSummary.name}`;
          exploresByKey.set(key, {
            model: modelSummary.name,
            explore: exploreSummary.name,
            label: exploreSummary.label ?? undefined,
            confidence: "medium",
            evidence: [
              {
                kind: "query_view",
                detail: `explore name matches discovered view ${exploreSummary.name}`,
              },
            ],
            viewNames: [exploreSummary.name],
            role: "migration_unit",
          });
        }
      } catch {
        // continue
      }
    }
  }

  const exploreKeys = new Set(exploresByKey.keys());
  const tiles: DiscoveredTile[] = [];

  // Dashboard tiles
  let dashboards: Awaited<ReturnType<typeof listDashboards>> = [];
  try {
    dashboards = await listDashboards();
  } catch {
    dashboards = [];
  }

  for (const dash of dashboards.slice(0, 100)) {
    let detail: Awaited<ReturnType<typeof getDashboard>>;
    try {
      detail = await getDashboard(dash.id);
    } catch {
      continue;
    }

    for (const el of detail.dashboard_elements ?? []) {
      const query = await resolveElementQuery(el);
      const parsed = parseQueryFields(query);
      if (!parsed.model || !parsed.explore) continue;

      const exploreKey = `${parsed.model}.${parsed.explore}`;
      const evidence: DiscoveryEvidence[] = [];

      if (exploreKeys.has(exploreKey)) {
        evidence.push({
          kind: "query_view",
          detail: `tile uses explore ${exploreKey}`,
        });
      }

      if (probeSql && parsed.fields.length > 0) {
        try {
          const sql = await getQuerySql({
            model: parsed.model,
            view: parsed.explore,
            fields: parsed.fields.slice(0, 5),
            filters: parsed.filters,
            limit: "1",
            query_timezone: parsed.timezone,
            dynamic_fields: parsed.dynamicFields.length
              ? JSON.stringify(parsed.dynamicFields.map((f) => f.raw))
              : undefined,
          } as LookerQueryWrite);
          if (referencesTable(sql, catalog, schema, table)) {
            evidence.push({
              kind: "generated_sql",
              detail: "tile generated SQL references source table",
            });
          }
        } catch {
          // SQL probe optional
        }
      }

      if (evidence.length === 0) continue;

      tiles.push({
        id: `dash:${dash.id}:${el.id}`,
        title: el.title ?? `${detail.title} / ${el.id}`,
        model: parsed.model,
        explore: parsed.explore,
        sourceKind: "dashboard_tile",
        dashboardId: dash.id,
        dashboardTitle: detail.title,
        fields: parsed.fields,
        filters: parsed.filters,
        filterExpression: parsed.filterExpression,
        sorts: parsed.sorts,
        limit: parsed.limit,
        pivots: parsed.pivots,
        total: parsed.total,
        timezone: parsed.timezone,
        confidence: confidenceFromEvidence(evidence),
        evidence,
        role: "validation_benchmark",
        dynamicFields: parsed.dynamicFields.length
          ? parsed.dynamicFields
          : undefined,
      });

      // Ensure explore is present
      if (!exploresByKey.has(exploreKey)) {
        exploresByKey.set(exploreKey, {
          model: parsed.model,
          explore: parsed.explore,
          confidence: confidenceFromEvidence(evidence),
          evidence: [...evidence],
          viewNames: [],
          role: "migration_unit",
        });
      }
    }
  }

  // Looks
  let looks: Awaited<ReturnType<typeof listLooks>> = [];
  try {
    looks = await listLooks(100);
  } catch {
    looks = [];
  }

  for (const lookSummary of looks) {
    let look: Awaited<ReturnType<typeof getLook>>;
    try {
      look = await getLook(lookSummary.id);
    } catch {
      continue;
    }

    const parsed = parseQueryFields(look.query);
    if (!parsed.model || !parsed.explore) {
      // Some Looks only expose query_id
      if (look.query_id) {
        try {
          const q = await getQuery(look.query_id);
          Object.assign(parsed, parseQueryFields(q));
        } catch {
          // continue with empty
        }
      }
    }
    if (!parsed.model || !parsed.explore) continue;

    const exploreKey = `${parsed.model}.${parsed.explore}`;
    const evidence: DiscoveryEvidence[] = [];

    if (exploreKeys.has(exploreKey) || exploresByKey.has(exploreKey)) {
      evidence.push({
        kind: "query_view",
        detail: `look uses explore ${exploreKey}`,
      });
    }

    if (probeSql && parsed.fields.length > 0) {
      try {
        const sql = await getQuerySql({
          model: parsed.model,
          view: parsed.explore,
          fields: parsed.fields.slice(0, 5),
          filters: parsed.filters,
          limit: "1",
          query_timezone: parsed.timezone,
          dynamic_fields: parsed.dynamicFields.length
            ? JSON.stringify(parsed.dynamicFields.map((f) => f.raw))
            : undefined,
        } as LookerQueryWrite);
        if (referencesTable(sql, catalog, schema, table)) {
          evidence.push({
            kind: "generated_sql",
            detail: "look generated SQL references source table",
          });
        }
      } catch {
        // optional
      }
    }

    if (evidence.length === 0) continue;

    tiles.push({
      id: `look:${look.id}`,
      title: look.title,
      model: parsed.model,
      explore: parsed.explore,
      sourceKind: "look",
      lookId: look.id,
      fields: parsed.fields,
      filters: parsed.filters,
      filterExpression: parsed.filterExpression,
      sorts: parsed.sorts,
      limit: parsed.limit,
      pivots: parsed.pivots,
      total: parsed.total,
      timezone: parsed.timezone,
      confidence: confidenceFromEvidence(evidence),
      evidence,
      role: "validation_benchmark",
      dynamicFields: parsed.dynamicFields.length
        ? parsed.dynamicFields
        : undefined,
    });

    if (!exploresByKey.has(exploreKey)) {
      exploresByKey.set(exploreKey, {
        model: parsed.model,
        explore: parsed.explore,
        confidence: confidenceFromEvidence(evidence),
        evidence: [...evidence],
        viewNames: [],
        role: "migration_unit",
      });
    }
  }

  return {
    catalog,
    schema,
    table,
    views: Array.from(viewsByName.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    explores: Array.from(exploresByKey.values()).sort((a, b) =>
      `${a.model}.${a.explore}`.localeCompare(`${b.model}.${b.explore}`)
    ),
    tiles: tiles.sort((a, b) => a.title.localeCompare(b.title)),
    searchedAt: new Date().toISOString(),
  };
}

/** Pure helper for unit tests — score a LookML snippet against a table. */
export function scoreLookmlAgainstTable(
  lookml: string,
  path: string,
  catalog: string,
  schema: string,
  table: string
): DiscoveryEvidence[] {
  return scanFileForTable(lookml, path, catalog, schema, table);
}

function addReferencedTable(
  byKey: Map<string, LookerReferencedTable>,
  raw: string,
  source: LookerReferencedTableSource
): void {
  const ref = normalizeTableRef(raw);
  if (!ref || !ref.schema) return; // need at least schema.table to be actionable

  const key = ref.canonical;
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, {
      catalog: ref.catalog,
      schema: ref.schema,
      table: ref.table,
      canonical: ref.canonical,
      sources: [source],
    });
    return;
  }
  existing.sources.push(source);
  if (!existing.catalog && ref.catalog) existing.catalog = ref.catalog;
}

/**
 * Scan Looker LookML + explore metadata for Databricks tables referenced via
 * sql_table_name / derived SQL / join sql_table_name. Used to surface migration
 * candidates on the Databricks connection tab.
 */
export async function listLookerReferencedTables(): Promise<LookerReferencedTablesResult> {
  const byKey = new Map<string, LookerReferencedTable>();
  let truncated = false;
  let fileCount = 0;

  const models = await listModels();
  const projects = Array.from(
    new Set(models.map((m) => m.project_name).filter(Boolean))
  );

  const fileIndex: Array<{ path: string; project: string }> = [];
  for (const project of projects) {
    try {
      const root = await listProjectFiles(project);
      await walkAllFiles(project, root, fileIndex);
    } catch {
      // Project file access may be restricted
    }
  }

  const limited = fileIndex.slice(0, 500);
  truncated = fileIndex.length > limited.length;
  fileCount = limited.length;

  for (const file of limited) {
    try {
      const content = await getProjectFileContent(file.project, file.path);
      const contents = content.contents ?? "";
      if (!contents) continue;
      const viewName = viewNameFromPath(file.path) ?? undefined;

      for (const sqlTable of extractSqlTableNames(contents)) {
        addReferencedTable(byKey, sqlTable, {
          kind: "lookml_view",
          detail: `sql_table_name: ${sqlTable}`,
          project: file.project,
          path: file.path,
          viewName,
        });
      }

      for (const derived of extractDerivedTableSql(contents)) {
        for (const sqlTable of extractQualifiedTableRefsFromSql(derived)) {
          addReferencedTable(byKey, sqlTable, {
            kind: "derived_sql",
            detail: `derived_table FROM/JOIN: ${sqlTable}`,
            project: file.project,
            path: file.path,
            viewName,
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  for (const modelSummary of models) {
    let modelDetail: Awaited<ReturnType<typeof getModel>>;
    try {
      modelDetail = await getModel(modelSummary.name);
    } catch {
      continue;
    }

    for (const exploreSummary of modelDetail.explores ?? []) {
      try {
        const exploreRaw = await getExplore(
          modelSummary.name,
          exploreSummary.name
        );
        const explore = exploreRaw as {
          name?: string;
          sql_table_name?: string;
          joins?: Array<{ name?: string; sql_table_name?: string }>;
        };

        if (explore.sql_table_name) {
          addReferencedTable(byKey, explore.sql_table_name, {
            kind: "explore",
            detail: `explore sql_table_name: ${explore.sql_table_name}`,
            model: modelSummary.name,
            explore: exploreSummary.name,
          });
        }

        for (const join of explore.joins ?? []) {
          if (!join.sql_table_name) continue;
          addReferencedTable(byKey, join.sql_table_name, {
            kind: "join",
            detail: `join ${join.name ?? "?"} sql_table_name: ${join.sql_table_name}`,
            model: modelSummary.name,
            explore: exploreSummary.name,
          });
        }
      } catch {
        // Skip explores that fail to load
      }
    }
  }

  const tables = Array.from(byKey.values()).sort((a, b) =>
    a.canonical.localeCompare(b.canonical)
  );

  return {
    tables,
    searchedAt: new Date().toISOString(),
    truncated,
    fileCount,
  };
}

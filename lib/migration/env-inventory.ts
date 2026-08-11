/**
 * Environment-wide Looker inventory extraction (APIs + LookML).
 * Never stores credentials/tokens. Caps work for responsiveness.
 */

import {
  getDashboard,
  getExplore,
  getLook,
  getModel,
  getProjectFileContent,
  listDashboards,
  listLooks,
  listModels,
  listProjectFiles,
  listProjects,
  type LookerFileEntry,
} from "@/lib/looker/client";
import { parseViewBlocks } from "@/lib/migration/lookml-parse";
import {
  extractDerivedTableSql,
  extractSqlTableNames,
  normalizeTableRef,
} from "@/lib/migration/table-names";
import type {
  EnvironmentInventory,
  EnvironmentInventorySummary,
  InventoryConsumer,
  InventoryDatabricksAsset,
  InventoryExplore,
  InventoryLookmlFile,
  InventorySource,
  InventoryView,
} from "@/lib/migration/dependency-types";

export interface InventoryOptions {
  /** Limit projects by name/id. */
  projects?: string[];
  /** Limit models by name. */
  models?: string[];
  maxExplores?: number;
  maxFiles?: number;
  maxDashboards?: number;
  maxLooks?: number;
  /** Skip dashboard/look fan-out (structure-only). */
  skipConsumers?: boolean;
  /** Known Databricks assets to attach (optional). */
  databricksAssets?: InventoryDatabricksAsset[];
}

async function walkLookmlFiles(
  projectId: string,
  entries: LookerFileEntry[],
  out: Array<{ project: string; path: string }>
): Promise<void> {
  for (const entry of entries) {
    if (entry.type === "dir" || entry.type === "directory") {
      const children = await listProjectFiles(projectId, entry.path);
      await walkLookmlFiles(projectId, children, out);
      continue;
    }
    if (
      entry.extension === ".lkml" ||
      entry.extension === ".lookml" ||
      entry.path.endsWith(".lkml") ||
      entry.path.endsWith(".lookml")
    ) {
      out.push({ project: projectId, path: entry.path });
    }
  }
}

function emptySummary(): EnvironmentInventorySummary {
  return {
    projects: 0,
    models: 0,
    files: 0,
    explores: 0,
    views: 0,
    fields: 0,
    joins: 0,
    derivedTables: 0,
    dashboards: 0,
    looks: 0,
    schedules: 0,
    sources: 0,
    databricksAssets: 0,
    unavailable: [],
    unresolvedDependencies: [],
  };
}

function summarize(inv: Omit<EnvironmentInventory, "summary">): EnvironmentInventorySummary {
  const summary = emptySummary();
  summary.projects = inv.projects.length;
  summary.models = inv.models.length;
  summary.files = inv.files.length;
  summary.explores = inv.explores.length;
  summary.views = inv.views.length;
  summary.fields = inv.explores.reduce(
    (n, e) => n + e.dimensions.length + e.measures.length,
    0
  );
  summary.joins = inv.explores.reduce((n, e) => n + e.joins.length, 0);
  summary.derivedTables = inv.views.filter((v) => v.derivedTableSql).length;
  summary.dashboards = inv.consumers.filter((c) => c.kind === "dashboard").length;
  summary.looks = inv.consumers.filter((c) => c.kind === "look").length;
  summary.schedules = inv.consumers.filter((c) => c.kind === "schedule").length;
  summary.sources = inv.sources.length;
  summary.databricksAssets = inv.databricksAssets.length;
  return summary;
}

/**
 * Build inventory from an in-memory fixture (tests / offline).
 */
export function buildInventoryFromFixture(partial: {
  projects?: EnvironmentInventory["projects"];
  models?: EnvironmentInventory["models"];
  files?: InventoryLookmlFile[];
  explores?: InventoryExplore[];
  views?: InventoryView[];
  consumers?: InventoryConsumer[];
  sources?: InventorySource[];
  databricksAssets?: InventoryDatabricksAsset[];
  notes?: string[];
  unavailable?: string[];
}): EnvironmentInventory {
  const base = {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    projects: partial.projects ?? [],
    models: partial.models ?? [],
    files: partial.files ?? [],
    explores: partial.explores ?? [],
    views: partial.views ?? [],
    consumers: partial.consumers ?? [],
    sources: partial.sources ?? [],
    databricksAssets: partial.databricksAssets ?? [],
    notes: partial.notes,
  };

  // Derive sources from explores/views/files when not supplied
  if (!partial.sources?.length) {
    const sources = new Map<string, InventorySource>();
    const consider = (raw?: string) => {
      if (!raw) return;
      const ref = normalizeTableRef(raw);
      if (!ref) return;
      sources.set(ref.canonical, {
        catalog: ref.catalog,
        schema: ref.schema,
        table: ref.table,
        canonical: ref.canonical,
      });
    };
    for (const e of base.explores) consider(e.sqlTableName);
    for (const v of base.views) {
      consider(v.sqlTableName);
      if (v.derivedTableSql) {
        for (const t of extractSqlTableNames(v.derivedTableSql)) consider(t);
      }
    }
    for (const f of base.files) {
      for (const t of extractSqlTableNames(f.contents)) consider(t);
      for (const sql of extractDerivedTableSql(f.contents)) {
        for (const t of extractSqlTableNames(sql)) consider(t);
      }
      for (const vb of parseViewBlocks(f.contents)) {
        consider(vb.sqlTableName);
      }
    }
    base.sources = Array.from(sources.values());
  }

  const summary = summarize(base);
  if (partial.unavailable?.length) {
    summary.unavailable = partial.unavailable;
  }
  return { ...base, summary };
}

/**
 * Live Looker environment inventory (best-effort within caps).
 */
export async function collectEnvironmentInventory(
  options: InventoryOptions = {}
): Promise<EnvironmentInventory> {
  const unavailable: string[] = [];
  const maxExplores = options.maxExplores ?? 40;
  const maxFiles = options.maxFiles ?? 300;
  const maxDashboards = options.maxDashboards ?? 80;
  const maxLooks = options.maxLooks ?? 80;

  let projects: EnvironmentInventory["projects"] = [];
  try {
    projects = await listProjects();
  } catch {
    unavailable.push("projects API");
  }
  if (options.projects?.length) {
    const allow = new Set(options.projects.map((p) => p.toLowerCase()));
    projects = projects.filter(
      (p) => allow.has(p.id.toLowerCase()) || allow.has(p.name.toLowerCase())
    );
  }

  let models = await listModels();
  if (options.models?.length) {
    const allow = new Set(options.models.map((m) => m.toLowerCase()));
    models = models.filter((m) => allow.has(m.name.toLowerCase()));
  }
  if (options.projects?.length) {
    const allow = new Set(options.projects.map((p) => p.toLowerCase()));
    models = models.filter((m) => allow.has(m.project_name.toLowerCase()));
  }

  const files: InventoryLookmlFile[] = [];
  const fileIndex: Array<{ project: string; path: string }> = [];
  const projectIds = Array.from(
    new Set([
      ...projects.map((p) => p.id),
      ...models.map((m) => m.project_name),
    ])
  );

  for (const projectId of projectIds) {
    try {
      const root = await listProjectFiles(projectId);
      await walkLookmlFiles(projectId, root, fileIndex);
    } catch {
      unavailable.push(`project files:${projectId}`);
    }
  }

  for (const file of fileIndex.slice(0, maxFiles)) {
    try {
      const content = await getProjectFileContent(file.project, file.path);
      if (content.contents) {
        files.push({
          project: file.project,
          path: file.path,
          contents: content.contents,
        });
      }
    } catch {
      // skip unreadable
    }
  }
  if (fileIndex.length > maxFiles) {
    unavailable.push(`lookml files truncated at ${maxFiles}`);
  }

  const views: InventoryView[] = [];
  for (const file of files) {
    for (const vb of parseViewBlocks(file.contents)) {
      views.push({
        project: file.project,
        path: file.path,
        name: vb.name,
        sqlTableName: vb.sqlTableName,
        derivedTableSql: vb.derivedTableSql,
        extends: vb.extends,
      });
    }
  }

  const explores: InventoryExplore[] = [];
  let exploreCount = 0;
  for (const model of models) {
    if (exploreCount >= maxExplores) break;
    let modelDetail: Awaited<ReturnType<typeof getModel>>;
    try {
      modelDetail = await getModel(model.name);
    } catch {
      unavailable.push(`model:${model.name}`);
      continue;
    }
    for (const ex of modelDetail.explores ?? []) {
      if (exploreCount >= maxExplores) break;
      try {
        const raw = (await getExplore(model.name, ex.name)) as Record<
          string,
          unknown
        >;
        const fields = raw.fields as
          | {
              dimensions?: Array<Record<string, unknown>>;
              measures?: Array<Record<string, unknown>>;
            }
          | undefined;
        const joins = (raw.joins as Array<Record<string, unknown>> | undefined) ?? [];
        explores.push({
          project: model.project_name,
          model: model.name,
          explore: ex.name,
          label: (ex.label as string | null) ?? undefined,
          viewName: (raw.view_name as string | undefined) ?? undefined,
          sqlTableName: (raw.sql_table_name as string | undefined) ?? undefined,
          joins: joins.map((j) => ({
            name: String(j.name ?? ""),
            type: j.type as string | undefined,
            sqlOn: j.sql_on as string | undefined,
            relationship: j.relationship as string | undefined,
            foreignKey: j.foreign_key as string | undefined,
          })),
          dimensions: (fields?.dimensions ?? []).map((d) => ({
            name: String(d.name ?? ""),
            type: d.type as string | undefined,
            sql: d.sql as string | undefined,
            hidden: Boolean(d.hidden),
            description: d.description as string | undefined,
          })),
          measures: (fields?.measures ?? []).map((m) => ({
            name: String(m.name ?? ""),
            type: m.type as string | undefined,
            sql: m.sql as string | undefined,
            hidden: Boolean(m.hidden),
            description: m.description as string | undefined,
          })),
        });
        exploreCount++;
      } catch {
        unavailable.push(`explore:${model.name}.${ex.name}`);
      }
    }
  }
  if (exploreCount >= maxExplores) {
    unavailable.push(`explores truncated at ${maxExplores}`);
  }

  const consumers: InventoryConsumer[] = [];
  if (!options.skipConsumers) {
    try {
      const dashboards = (await listDashboards()).slice(0, maxDashboards);
      for (const d of dashboards) {
        try {
          const detail = await getDashboard(d.id);
          for (const el of detail.dashboard_elements ?? []) {
            const q =
              (el.query as Record<string, unknown> | undefined) ??
              (el.result_maker?.query as Record<string, unknown> | undefined);
            if (!q) continue;
            const modelName = String(q.model ?? "");
            const exploreName = String(q.view ?? "");
            if (!modelName || !exploreName) continue;
            consumers.push({
              id: `dashboard:${d.id}:element:${el.id}`,
              kind: "dashboard",
              title: el.title ?? d.title,
              model: modelName,
              explore: exploreName,
              fields: Array.isArray(q.fields) ? (q.fields as string[]) : [],
            });
          }
        } catch {
          unavailable.push(`dashboard:${d.id}`);
        }
      }
    } catch {
      unavailable.push("dashboards API");
    }

    try {
      const looks = (await listLooks(maxLooks)).slice(0, maxLooks);
      for (const look of looks) {
        try {
          const detail = await getLook(look.id);
          const q = detail.query as Record<string, unknown> | undefined;
          if (!q) continue;
          consumers.push({
            id: `look:${look.id}`,
            kind: "look",
            title: detail.title,
            model: String(q.model ?? ""),
            explore: String(q.view ?? ""),
            fields: Array.isArray(q.fields) ? (q.fields as string[]) : [],
          });
        } catch {
          unavailable.push(`look:${look.id}`);
        }
      }
    } catch {
      unavailable.push("looks API");
    }
  } else {
    unavailable.push("consumers skipped by option");
  }

  unavailable.push(
    "schedules/deliveries not available via current Looker client",
    "usage/query-history popularity not available via current Looker client",
    "embedded/API consumers only when present as dashboards/Looks"
  );

  const inv = buildInventoryFromFixture({
    projects,
    models: models.map((m) => ({
      name: m.name,
      project: m.project_name,
      label: m.label,
    })),
    files,
    explores,
    views,
    consumers,
    databricksAssets: options.databricksAssets ?? [],
    unavailable,
    notes: [
      "Inventory exhaustively within API/file caps; migrate selectively after component approval.",
      "Never includes credentials or tokens.",
    ],
  });

  return inv;
}

/** Redact accidental secret-like keys from inventory JSON before write/log. */
export function redactInventorySecrets<T>(value: T): T {
  const secretKey = /(password|secret|token|api[_-]?key|credential|authorization|private[_-]?key)/i;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (secretKey.test(k)) {
          out[k] = "[REDACTED]";
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    if (typeof v === "string" && /Bearer\s+[A-Za-z0-9._\-]+/i.test(v)) {
      return v.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
    }
    return v;
  };
  return walk(value) as T;
}

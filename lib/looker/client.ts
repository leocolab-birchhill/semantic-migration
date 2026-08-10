import { getLookerConfig } from "@/lib/config/looker";

export class LookerApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string
  ) {
    super(message);
    this.name = "LookerApiError";
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const config = getLookerConfig();
  if (!config) {
    throw new LookerApiError("Looker is not configured", 500);
  }

  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 30_000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(`${config.host}/api/4.0/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LookerApiError("Looker login failed", res.status, text);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  const expiresIn = data.expires_in ?? 3600;
  tokenCache = {
    token: data.access_token,
    expiresAt: now + expiresIn * 1000,
  };

  return tokenCache.token;
}

async function lookerFetch(path: string): Promise<Response> {
  const config = getLookerConfig();
  if (!config) {
    throw new LookerApiError("Looker is not configured", 500);
  }

  const token = await getAccessToken();
  const res = await fetch(`${config.host}/api/4.0${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  return res;
}

async function lookerJson<T>(path: string): Promise<T> {
  const res = await lookerFetch(path);
  const text = await res.text();
  if (!res.ok) {
    throw new LookerApiError(`Looker API error: ${path}`, res.status, text);
  }
  return JSON.parse(text) as T;
}

export interface LookerModelSummary {
  name: string;
  label: string | null;
  project_name: string;
}

export interface LookerExploreSummary {
  name: string;
  label: string | null;
  description: string | null;
}

export interface LookerViewSummary {
  name: string;
  label: string | null;
}

export async function listModels(): Promise<LookerModelSummary[]> {
  return lookerJson<LookerModelSummary[]>(
    "/lookml_models?fields=name,label,project_name"
  );
}

export async function getModel(name: string) {
  return lookerJson<{
    name: string;
    label: string | null;
    project_name: string;
    explores: LookerExploreSummary[];
  }>(`/lookml_models/${encodeURIComponent(name)}?fields=name,label,project_name,explores`);
}

async function walkProjectViewFiles(
  projectId: string,
  entries: LookerFileEntry[],
  views: Map<string, string | null>
): Promise<void> {
  for (const entry of entries) {
    if (entry.type === "dir" || entry.type === "directory") {
      const children = await listProjectFiles(projectId, entry.path);
      await walkProjectViewFiles(projectId, children, views);
      continue;
    }

    if (!entry.path.endsWith(".view.lkml")) continue;
    const name =
      entry.path
        .split("/")
        .pop()
        ?.replace(/\.view\.lkml$/, "") ?? entry.path;
    if (!views.has(name)) {
      views.set(name, null);
    }
  }
}

export async function listViews(modelName: string): Promise<LookerViewSummary[]> {
  const model = await getModel(modelName);
  const views = new Map<string, string | null>();

  try {
    const rootEntries = await listProjectFiles(model.project_name);
    await walkProjectViewFiles(model.project_name, rootEntries, views);
  } catch {
    // Project file access may be restricted; fall back to explore names.
  }

  if (views.size === 0) {
    for (const explore of model.explores ?? []) {
      views.set(explore.name, explore.label);
    }
  }

  return Array.from(views.entries())
    .map(([name, label]) => ({ name, label }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getExplore(modelName: string, exploreName: string) {
  return lookerJson<Record<string, unknown>>(
    `/lookml_models/${encodeURIComponent(modelName)}/explores/${encodeURIComponent(exploreName)}`
  );
}

async function findViewFilePath(
  projectId: string,
  viewName: string,
  entries: LookerFileEntry[]
): Promise<string | null> {
  for (const entry of entries) {
    if (entry.type === "dir" || entry.type === "directory") {
      const children = await listProjectFiles(projectId, entry.path);
      const nested = await findViewFilePath(projectId, viewName, children);
      if (nested) return nested;
      continue;
    }

    if (entry.path.endsWith(`/${viewName}.view.lkml`) || entry.path === `${viewName}.view.lkml`) {
      return entry.path;
    }
  }

  return null;
}

export async function getView(modelName: string, viewName: string) {
  const model = await getModel(modelName);
  const projectId = model.project_name;
  const rootEntries = await listProjectFiles(projectId);
  const filePath = await findViewFilePath(projectId, viewName, rootEntries);

  if (filePath) {
    const file = await getProjectFileContent(projectId, filePath);
    return {
      name: viewName,
      model: modelName,
      project: projectId,
      path: file.path,
      type: file.type,
      contents: file.contents ?? "",
    };
  }

  const explore = model.explores?.find((item) => item.name === viewName);
  if (explore) {
    return getExplore(modelName, explore.name);
  }

  throw new LookerApiError(
    `View not found for model ${modelName}: ${viewName}`,
    404
  );
}

export interface LookerProjectSummary {
  id: string;
  name: string;
}

export async function listProjects(): Promise<LookerProjectSummary[]> {
  return lookerJson<LookerProjectSummary[]>("/projects?fields=id,name");
}

export interface LookerFileEntry {
  type: string;
  path: string;
  extension?: string;
  git_status?: string;
}

export async function listProjectFiles(
  projectId: string,
  filePath = ""
): Promise<LookerFileEntry[]> {
  const encodedPath = filePath ? encodeURIComponent(filePath) : "%2F";
  return lookerJson<LookerFileEntry[]>(
    `/projects/${encodeURIComponent(projectId)}/files/${encodedPath}`
  );
}

export async function getProjectFileContent(projectId: string, filePath: string) {
  const encodedPath = filePath
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  return lookerJson<{ path: string; type: string; editable: boolean; contents?: string }>(
    `/projects/${encodeURIComponent(projectId)}/files/${encodedPath}`
  );
}

// --- Dashboards ---

export interface LookerDashboardSummary {
  id: string;
  title: string;
  description: string | null;
  folder?: { name: string };
}

export async function listDashboards(
  title?: string
): Promise<LookerDashboardSummary[]> {
  const params = new URLSearchParams({
    fields: "id,title,description,folder",
  });
  if (title) params.set("title", title);
  return lookerJson<LookerDashboardSummary[]>(`/dashboards?${params}`);
}

export interface LookerDashboardElement {
  id: string;
  title: string | null;
  type: string;
  query_id: string | null;
  result_maker_id: string | null;
  query?: Record<string, unknown>;
  result_maker?: {
    id?: string;
    query?: Record<string, unknown>;
  };
}

export interface LookerDashboardDetail {
  id: string;
  title: string;
  description: string | null;
  dashboard_elements: LookerDashboardElement[];
}

export async function getDashboard(dashboardId: string): Promise<LookerDashboardDetail> {
  // Nested query fields (incl. dynamic_fields) are required for tile parity.
  // result_maker.query covers LookML dashboards where query is nested.
  return lookerJson<LookerDashboardDetail>(
    `/dashboards/${encodeURIComponent(dashboardId)}?fields=id,title,description,dashboard_elements(id,title,type,query_id,result_maker_id,query(model,view,fields,filters,filter_expression,sorts,limit,pivots,total,query_timezone,dynamic_fields),result_maker(id,query(model,view,fields,filters,filter_expression,sorts,limit,pivots,total,query_timezone,dynamic_fields)))`
  );
}

// --- Queries ---

export interface LookerQueryWrite {
  model: string;
  view: string;
  fields: string[];
  filters?: Record<string, string>;
  filter_expression?: string;
  sorts?: string[];
  limit?: string;
  pivots?: string[];
  total?: boolean;
  query_timezone?: string;
  /** JSON string of custom fields / table calculations. */
  dynamic_fields?: string;
}

export interface LookerQueryResult {
  data: Array<Record<string, unknown>>;
  fields?: Array<{ name: string; type: string }>;
  sql?: string;
}

async function lookerPost<T>(path: string, body?: unknown): Promise<T> {
  const config = getLookerConfig();
  if (!config) throw new LookerApiError("Looker is not configured", 500);

  const token = await getAccessToken();
  const res = await fetch(`${config.host}/api/4.0${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new LookerApiError(`Looker API error: ${path}`, res.status, text);
  }
  return JSON.parse(text) as T;
}

export async function runInlineQuery(
  query: LookerQueryWrite,
  resultFormat: "json" | "json_bi" | "sql" = "json_bi"
): Promise<LookerQueryResult> {
  return lookerPost<LookerQueryResult>(
    `/queries/run/${resultFormat}?apply_formatting=false&apply_vis=false&cache=false&server_table_calcs=true`,
    query
  );
}

export async function createQuery(query: LookerQueryWrite): Promise<{ id: string }> {
  return lookerPost<{ id: string }>("/queries", query);
}

export async function runQueryById(
  queryId: string,
  resultFormat: "json" | "json_bi" | "sql" = "json_bi"
): Promise<LookerQueryResult> {
  return lookerPost<LookerQueryResult>(
    `/queries/${encodeURIComponent(queryId)}/run/${resultFormat}?cache=false`,
  );
}

export async function getQuerySql(query: LookerQueryWrite): Promise<string> {
  const result = await runInlineQuery(query, "sql");
  return typeof result === "string" ? result : (result as unknown as string);
}

// --- Looks ---

export interface LookerLookSummary {
  id: string;
  title: string;
  description: string | null;
  query_id?: string | null;
  model?: { id?: string } | string | null;
}

export async function listLooks(limit = 200): Promise<LookerLookSummary[]> {
  const params = new URLSearchParams({
    fields: "id,title,description,query_id,model",
    limit: String(limit),
  });
  return lookerJson<LookerLookSummary[]>(`/looks?${params}`);
}

export interface LookerLookDetail {
  id: string;
  title: string;
  description: string | null;
  query?: Record<string, unknown>;
  query_id?: string | null;
}

export async function getLook(lookId: string): Promise<LookerLookDetail> {
  return lookerJson<LookerLookDetail>(
    `/looks/${encodeURIComponent(lookId)}?fields=id,title,description,query_id,query(model,view,fields,filters,filter_expression,sorts,limit,pivots,total,query_timezone,dynamic_fields)`
  );
}

export async function getQuery(queryId: string): Promise<Record<string, unknown>> {
  return lookerJson<Record<string, unknown>>(
    `/queries/${encodeURIComponent(queryId)}?fields=id,model,view,fields,filters,filter_expression,sorts,limit,pivots,total,query_timezone,dynamic_fields`
  );
}

import { resolveEnvAuth } from "@/lib/databricks/env-auth";
import {
  dollarQuote,
  normalizeMetricViewYaml,
} from "@/lib/migration/deploy-normalize";

export class DatabricksApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string
  ) {
    super(message);
    this.name = "DatabricksApiError";
  }
}

/** Unwrap Node/undici `fetch failed` into something actionable. */
export function formatFetchError(err: unknown, host?: string): string {
  if (!(err instanceof Error)) return String(err);
  const cause =
    err.cause instanceof Error
      ? err.cause
      : err.cause && typeof err.cause === "object"
        ? (err.cause as { code?: string; message?: string })
        : null;
  const code =
    cause && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  const causeMsg =
    cause instanceof Error
      ? cause.message
      : cause && "message" in cause && typeof cause.message === "string"
        ? cause.message
        : undefined;

  if (err.message === "fetch failed" || code) {
    const parts = [
      `Could not reach Databricks${host ? ` at ${host}` : ""}`,
      code,
      causeMsg,
    ].filter(Boolean);
    return `${parts.join(": ")}. On corporate VPN/proxy TLS, restart with system CAs (npm scripts set this), or run: npm run auth:databricks`;
  }
  return err.message;
}

export interface StatementResult {
  status: "SUCCEEDED" | "FAILED" | "CANCELED" | "PENDING" | "RUNNING";
  error?: { message?: string };
  manifest?: {
    schema?: { columns?: Array<{ name: string; type_name?: string }> };
  };
  result?: {
    data_array?: string[][];
  };
}

async function ensureAccessToken(): Promise<{ host: string; token: string }> {
  const envAuth = await resolveEnvAuth();
  if (envAuth) {
    return { host: envAuth.host, token: envAuth.token };
  }
  throw new DatabricksApiError(
    "Not authenticated — set DATABRICKS_HOST + CLI profile (npm run auth:databricks) or DATABRICKS_TOKEN",
    401
  );
}

async function databricksFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const { host, token } = await ensureAccessToken();
  try {
    return await fetch(`${host}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (err) {
    throw new DatabricksApiError(formatFetchError(err, host), 502);
  }
}

export async function listWarehouses() {
  const res = await databricksFetch("/api/2.0/sql/warehouses");
  if (!res.ok) {
    const body = await res.text();
    throw new DatabricksApiError("Failed to list warehouses", res.status, body);
  }
  const data = (await res.json()) as {
    warehouses?: Array<{ id: string; name: string; state: string }>;
  };
  return (data.warehouses ?? []).map((w) => ({
    id: w.id,
    name: w.name,
    state: w.state,
  }));
}

export async function executeStatement(
  warehouseId: string,
  statement: string,
  waitTimeout = "30s"
): Promise<StatementResult> {
  const res = await databricksFetch("/api/2.0/sql/statements", {
    method: "POST",
    body: JSON.stringify({
      warehouse_id: warehouseId,
      statement,
      wait_timeout: waitTimeout,
      on_wait_timeout: "CANCEL",
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new DatabricksApiError(
      "Statement execution request failed",
      res.status,
      body
    );
  }

  const data = JSON.parse(body) as {
    status?: { state?: StatementResult["status"]; error?: { message?: string } };
    manifest?: StatementResult["manifest"];
    result?: StatementResult["result"];
  };

  return {
    status: data.status?.state ?? "FAILED",
    error: data.status?.error,
    manifest: data.manifest,
    result: data.result,
  };
}

export function rowsFromResult(result: StatementResult): string[][] {
  return result.result?.data_array ?? [];
}

export async function listCatalogs(warehouseId: string): Promise<string[]> {
  const result = await executeStatement(warehouseId, "SHOW CATALOGS");
  if (result.status !== "SUCCEEDED") {
    throw new DatabricksApiError(
      result.error?.message ?? "Failed to list catalogs",
      400
    );
  }
  return rowsFromResult(result)
    .map((row) => row[0])
    .filter(Boolean);
}

export async function listSchemas(
  warehouseId: string,
  catalog: string
): Promise<string[]> {
  const result = await executeStatement(
    warehouseId,
    `SHOW SCHEMAS IN \`${catalog.replace(/`/g, "``")}\``
  );
  if (result.status !== "SUCCEEDED") {
    throw new DatabricksApiError(
      result.error?.message ?? "Failed to list schemas",
      400
    );
  }
  return rowsFromResult(result)
    .map((row) => row[0])
    .filter(Boolean);
}

export async function listTables(
  warehouseId: string,
  catalog: string,
  schema: string
): Promise<string[]> {
  const esc = (s: string) => s.replace(/`/g, "``");
  const result = await executeStatement(
    warehouseId,
    `SHOW TABLES IN \`${esc(catalog)}\`.\`${esc(schema)}\``
  );
  if (result.status !== "SUCCEEDED") {
    throw new DatabricksApiError(
      result.error?.message ?? "Failed to list tables",
      400
    );
  }
  return rowsFromResult(result)
    .map((row) => row[1] ?? row[0])
    .filter(Boolean);
}

function qualified(catalog: string, schema: string, table?: string): string {
  const esc = (s: string) => s.replace(/`/g, "``");
  const base = `\`${esc(catalog)}\`.\`${esc(schema)}\``;
  return table ? `${base}.\`${esc(table)}\`` : base;
}

export async function createProbeView(
  warehouseId: string,
  catalog: string,
  schema: string,
  viewName: string
): Promise<StatementResult> {
  return executeStatement(
    warehouseId,
    `CREATE OR REPLACE VIEW ${qualified(catalog, schema, viewName)} AS SELECT 1 AS probe`
  );
}

export async function dropProbeView(
  warehouseId: string,
  catalog: string,
  schema: string,
  viewName: string
): Promise<StatementResult> {
  return executeStatement(
    warehouseId,
    `DROP VIEW IF EXISTS ${qualified(catalog, schema, viewName)}`
  );
}

export async function createMetricView(
  warehouseId: string,
  catalog: string,
  schema: string,
  viewName: string,
  yamlDefinition: string
): Promise<StatementResult> {
  const esc = (s: string) => s.replace(/`/g, "``");
  // Databricks requires: WITH METRICS LANGUAGE YAML AS $$\n<yaml>\n$$
  // (plain $$ only — tagged $name$ quotes are not supported and error at '$')
  const yaml = normalizeMetricViewYaml(yamlDefinition);
  const quoted = dollarQuote(yaml);
  const fqn = `\`${esc(catalog)}\`.\`${esc(schema)}\`.\`${esc(viewName)}\``;
  const ddl = `CREATE OR REPLACE VIEW ${fqn}\nWITH METRICS\nLANGUAGE YAML\nAS ${quoted}`;

  const first = await executeStatement(warehouseId, ddl);
  if (first.status === "SUCCEEDED") return first;

  // CREATE OR REPLACE cannot replace an existing object of a different kind
  // (e.g. plain view vs metric view). Drop and retry once — the caller owns
  // this schema and intends replacement.
  if (/TABLE_OR_VIEW_ALREADY_EXISTS|already exists/i.test(first.error?.message ?? "")) {
    await executeStatement(warehouseId, `DROP VIEW IF EXISTS ${fqn}`);
    await executeStatement(warehouseId, `DROP TABLE IF EXISTS ${fqn}`);
    return executeStatement(warehouseId, ddl);
  }

  return first;
}

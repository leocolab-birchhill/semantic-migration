import { execFile } from "child_process";
import { promisify } from "util";
import { resolveEnvAuth } from "@/lib/databricks/env-auth";

const execFileAsync = promisify(execFile);

export interface LakebaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  sslmode: string;
  endpoint: string | null;
}

let credentialCache: { token: string; expiresAt: number } | null = null;

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}

export function isLakebaseConfigured(): boolean {
  if (process.env.DATABASE_URL) return false;

  const hasPg = Boolean(
    process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE
  );
  if (!hasPg) return false;

  if (process.env.AUTH_METHOD === "LAKEBASE_OAUTH_V1") {
    return Boolean(
      process.env.LAKEBASE_DATABRICKS_HOST ||
        process.env.LAKEBASE_DATABRICKS_TOKEN ||
        process.env.LAKEBASE_DATABRICKS_CLI_PROFILE
    );
  }

  return Boolean(getLakebaseEndpoint());
}

export function getLakebaseConfig(): LakebaseConfig | null {
  if (!isLakebaseConfigured()) return null;

  return {
    host: process.env.PGHOST!,
    port: parseInt(process.env.PGPORT ?? "5432", 10),
    database: process.env.PGDATABASE!,
    user: process.env.PGUSER!,
    sslmode: process.env.PGSSLMODE ?? "require",
    endpoint: getLakebaseEndpoint(),
  };
}

function getLakebaseEndpoint(): string | null {
  if (process.env.LAKEBASE_ENDPOINT) {
    return process.env.LAKEBASE_ENDPOINT;
  }

  const projectId = process.env.LAKEBASE_PROJECT_ID;
  const branchId = process.env.LAKEBASE_BRANCH_ID;
  const endpointId = process.env.LAKEBASE_ENDPOINT_ID;
  if (!projectId || !branchId || !endpointId) return null;

  return `projects/${projectId}/branches/${branchId}/endpoints/${endpointId}`;
}

async function resolveLakebaseWorkspaceAuth() {
  const host = process.env.LAKEBASE_DATABRICKS_HOST;
  if (!host) {
    throw new Error(
      "LAKEBASE_DATABRICKS_HOST is required for Lakebase auth (Birch Hill / BHEP workspace URL)."
    );
  }

  const auth = await resolveEnvAuth({
    host: normalizeHost(host),
    token: process.env.LAKEBASE_DATABRICKS_TOKEN ?? null,
    profile: process.env.LAKEBASE_DATABRICKS_CLI_PROFILE ?? "bhep",
    authMode: process.env.LAKEBASE_DATABRICKS_AUTH_MODE ?? "cli",
  });

  if (!auth) {
    throw new Error(
      "Lakebase workspace auth is not configured. Set LAKEBASE_DATABRICKS_HOST and either LAKEBASE_DATABRICKS_TOKEN or LAKEBASE_DATABRICKS_CLI_PROFILE (run: databricks auth login -p bhep)."
    );
  }

  return auth;
}

async function passwordFromWorkspaceToken(): Promise<string> {
  const auth = await resolveLakebaseWorkspaceAuth();
  return auth.token;
}

async function passwordFromPostgresCredentialApi(): Promise<{
  token: string;
  expiresAt: number;
}> {
  const endpoint = getLakebaseEndpoint();
  if (!endpoint) {
    throw new Error(
      "LAKEBASE_PROJECT_ID, LAKEBASE_BRANCH_ID, and LAKEBASE_ENDPOINT_ID are required for postgres credential exchange."
    );
  }

  const auth = await resolveLakebaseWorkspaceAuth();
  const res = await fetch(`${auth.host}/api/2.0/postgres/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ endpoint }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Lakebase credential request failed (${res.status}): ${text}`);
  }

  const data = JSON.parse(text) as {
    token?: string;
    expiration_time?: string;
  };

  if (!data.token) {
    throw new Error("Lakebase credential response did not include a token");
  }

  const expiresAt = data.expiration_time
    ? new Date(data.expiration_time).getTime()
    : Date.now() + 55 * 60_000;

  return { token: data.token, expiresAt };
}

export async function getLakebasePassword(): Promise<string> {
  const now = Date.now();
  if (credentialCache && credentialCache.expiresAt > now + 60_000) {
    return credentialCache.token;
  }

  let token: string;
  let expiresAt = now + 50 * 60_000;

  if (process.env.AUTH_METHOD === "LAKEBASE_OAUTH_V1") {
    // Lakebase BYOT: use the Birch Hill workspace OAuth token directly as PGPASSWORD.
    // Do not call Neon/Lakebase management APIs for discovery.
    token = await passwordFromWorkspaceToken();
  } else {
    try {
      const cred = await passwordFromPostgresCredentialApi();
      token = cred.token;
      expiresAt = cred.expiresAt;
    } catch (apiErr) {
      const endpoint = getLakebaseEndpoint();
      const profile = process.env.LAKEBASE_DATABRICKS_CLI_PROFILE ?? "bhep";
      if (!endpoint) {
        const apiMessage = apiErr instanceof Error ? apiErr.message : String(apiErr);
        if (/fetch failed/i.test(apiMessage)) {
          throw new Error(
            `Lakebase credential fetch failed (Databricks auth likely expired). Run: npm run auth:databricks  (profile: ${profile})`
          );
        }
        throw apiErr;
      }

      try {
        const { stdout } = await execFileAsync(
          "databricks",
          [
            "postgres",
            "generate-database-credential",
            endpoint,
            "-o",
            "json",
            "-p",
            profile,
          ],
          { timeout: 30_000 }
        );
        const data = JSON.parse(stdout.trim()) as {
          token?: string;
          expiration_time?: string;
        };
        if (!data.token) {
          throw new Error("CLI credential response did not include a token");
        }
        token = data.token;
        if (data.expiration_time) {
          expiresAt = new Date(data.expiration_time).getTime();
        }
      } catch (cliErr) {
        const apiMessage = apiErr instanceof Error ? apiErr.message : String(apiErr);
        const cliMessage = cliErr instanceof Error ? cliErr.message : String(cliErr);
        throw new Error(
          `Could not obtain Lakebase database credential. API: ${apiMessage}. CLI: ${cliMessage}. Run: npm run auth:databricks`
        );
      }
    }
  }

  credentialCache = { token, expiresAt };
  return token;
}

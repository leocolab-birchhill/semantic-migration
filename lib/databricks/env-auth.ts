import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface EnvDatabricksAuth {
  host: string;
  token: string;
  mode: "pat" | "cli";
  profile?: string;
}

let cliTokenCache: { token: string; expiresAt: number; profile: string } | null = null;

export interface EnvAuthOptions {
  host?: string | null;
  token?: string | null;
  profile?: string;
  authMode?: string | null;
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}

export function getConfiguredHost(): string | null {
  const host =
    process.env.DATABRICKS_HOST ??
    process.env.DATABRICKS_TENANT_HOST ??
    null;
  return host ? normalizeHost(host) : null;
}

export function isEnvAuthConfigured(): boolean {
  if (process.env.DATABRICKS_TOKEN && getConfiguredHost()) return true;
  if (process.env.DATABRICKS_CLI_PROFILE || process.env.DATABRICKS_AUTH_MODE === "cli") {
    return Boolean(getConfiguredHost());
  }
  return false;
}

async function tokenFromCliProfile(profile: string): Promise<string> {
  const now = Date.now();
  if (
    cliTokenCache &&
    cliTokenCache.profile === profile &&
    cliTokenCache.expiresAt > now + 60_000
  ) {
    return cliTokenCache.token;
  }

  const { stdout } = await execFileAsync(
    "databricks",
    ["auth", "token", "-p", profile, "-o", "json"],
    { timeout: 30_000 }
  );

  const trimmed = stdout.trim();
  let token: string | undefined;
  let expiresAt = now + 50 * 60_000;

  try {
    const parsed = JSON.parse(trimmed) as {
      access_token?: string;
      token?: string;
      expiry?: string;
    };
    token = parsed.access_token ?? parsed.token;
    if (parsed.expiry) expiresAt = new Date(parsed.expiry).getTime();
  } catch {
    token = trimmed;
  }

  if (!token) {
    throw new Error(
      `Could not read token from Databricks CLI profile "${profile}". Run: databricks auth login -p ${profile}`
    );
  }

  cliTokenCache = { token, expiresAt, profile };
  return token;
}

export interface RequiredCliProfile {
  purpose: "workspace" | "lakebase";
  profile: string;
  host: string;
  loginCommand: string;
}

/** CLI profiles this app needs when running in env/CLI auth mode (not OAuth session). */
export function listRequiredCliProfiles(): RequiredCliProfile[] {
  const profiles: RequiredCliProfile[] = [];

  const workspaceHost = getConfiguredHost();
  const workspaceUsesCli =
    !process.env.DATABRICKS_TOKEN &&
    Boolean(
      process.env.DATABRICKS_CLI_PROFILE || process.env.DATABRICKS_AUTH_MODE === "cli"
    );
  if (workspaceHost && workspaceUsesCli) {
    const profile = process.env.DATABRICKS_CLI_PROFILE ?? "gdi";
    profiles.push({
      purpose: "workspace",
      profile,
      host: workspaceHost,
      loginCommand: `databricks auth login --host ${workspaceHost} -p ${profile}`,
    });
  }

  const lakebaseHost = process.env.LAKEBASE_DATABRICKS_HOST
    ? normalizeHost(process.env.LAKEBASE_DATABRICKS_HOST)
    : null;
  const lakebaseUsesCli =
    !process.env.LAKEBASE_DATABRICKS_TOKEN &&
    Boolean(
      process.env.LAKEBASE_DATABRICKS_CLI_PROFILE ||
        process.env.LAKEBASE_DATABRICKS_AUTH_MODE === "cli" ||
        process.env.AUTH_METHOD === "LAKEBASE_OAUTH_V1"
    );
  if (lakebaseHost && lakebaseUsesCli) {
    const profile = process.env.LAKEBASE_DATABRICKS_CLI_PROFILE ?? "bhep";
    if (!profiles.some((p) => p.profile === profile)) {
      profiles.push({
        purpose: "lakebase",
        profile,
        host: lakebaseHost,
        loginCommand: `databricks auth login --host ${lakebaseHost} -p ${profile}`,
      });
    }
  }

  return profiles;
}

/** Drop cached CLI tokens (e.g. after re-login). */
export function clearCliTokenCache(): void {
  cliTokenCache = null;
}

/** Resolve Databricks credentials from env PAT or local CLI profile (dev mode). */
export async function resolveEnvAuth(
  options: EnvAuthOptions = {}
): Promise<EnvDatabricksAuth | null> {
  const host = options.host ?? getConfiguredHost();
  if (!host) return null;

  const normalizedHost = normalizeHost(host);
  const pat = options.token ?? process.env.DATABRICKS_TOKEN;
  if (pat) {
    return { host: normalizedHost, token: pat, mode: "pat" };
  }

  const authMode = options.authMode ?? process.env.DATABRICKS_AUTH_MODE;
  const profile = options.profile ?? process.env.DATABRICKS_CLI_PROFILE ?? "gdi";

  if (authMode === "cli" || options.profile || process.env.DATABRICKS_CLI_PROFILE) {
    const token = await tokenFromCliProfile(profile);
    return { host: normalizedHost, token, mode: "cli", profile };
  }

  return null;
}

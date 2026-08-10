import type { TenantConfig } from "@/lib/types";

const DEFAULT_TENANT_ID = "default";

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "").toLowerCase();
}

/**
 * OAuth *application* credentials (registered in Databricks admin).
 * These are NOT user passwords — they identify this web app to Databricks OIDC.
 * User credentials are entered on Databricks' login page and never stored in env.
 */
function getOAuthAppConfig(): Omit<TenantConfig, "host" | "id"> | null {
  const clientId = process.env.DATABRICKS_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATABRICKS_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.DATABRICKS_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

/** Whether the OAuth app is configured (client id/secret/redirect). */
export function isOAuthConfigured(): boolean {
  return getOAuthAppConfig() !== null;
}

/** Default workspace host hint for the connect form (optional). */
export function getDefaultWorkspaceHost(): string | null {
  const host = process.env.DATABRICKS_TENANT_HOST;
  return host ? normalizeHost(host) : null;
}

/** Single-tenant config from env. Extend with a registry for multi-tenant later. */
export function getDefaultTenant(): TenantConfig | null {
  const oauth = getOAuthAppConfig();
  const host = getDefaultWorkspaceHost();
  if (!oauth || !host) return null;

  return { id: DEFAULT_TENANT_ID, host, ...oauth };
}

/**
 * Resolve tenant for a user-entered workspace URL.
 * Uses the same OAuth app credentials for any workspace host the user provides.
 */
export function resolveTenant(requestedHost: string): TenantConfig | null {
  const oauth = getOAuthAppConfig();
  if (!oauth) return null;

  const host = normalizeHost(requestedHost);
  if (!host.startsWith("https://")) return null;

  return { id: DEFAULT_TENANT_ID, host, ...oauth };
}

export function getTenantForHost(host: string): TenantConfig | null {
  return resolveTenant(host);
}

import { NextResponse } from "next/server";
import {
  getConfiguredHost,
  isEnvAuthConfigured,
  listRequiredCliProfiles,
  resolveEnvAuth,
} from "@/lib/databricks/env-auth";
import {
  getDefaultTenant,
  getDefaultWorkspaceHost,
  isOAuthConfigured,
} from "@/lib/config/tenants";
import { getSession, isSessionAuthenticated } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  const tenant = getDefaultTenant();
  const oauthConfigured = isOAuthConfigured();
  const envAuthConfigured = isEnvAuthConfigured();
  const cliProfiles = listRequiredCliProfiles();

  let envAuthenticated = false;
  let envHost: string | null = null;
  let authMode: "oauth" | "env" | null = null;
  let envAuthError: string | null = null;

  if (isSessionAuthenticated(session)) {
    authMode = "oauth";
  } else if (envAuthConfigured) {
    try {
      const envAuth = await resolveEnvAuth();
      envAuthenticated = Boolean(envAuth);
      envHost = envAuth?.host ?? null;
      if (envAuthenticated) authMode = "env";
    } catch (err) {
      envAuthenticated = false;
      envAuthError = err instanceof Error ? err.message : String(err);
    }
  }

  const authenticated =
    isSessionAuthenticated(session) || envAuthenticated;

  return NextResponse.json({
    authenticated,
    authMode,
    host: isSessionAuthenticated(session)
      ? session.host
      : envHost,
    configuredHost:
      tenant?.host ?? getDefaultWorkspaceHost() ?? getConfiguredHost(),
    oauthConfigured,
    envAuthConfigured,
    envAuthError,
    cliProfiles,
    reauthCommand: "npm run auth:databricks",
    userEmail: session.userEmail ?? (envAuthenticated ? "cli-profile" : null),
    userName: session.userName ?? null,
  });
}

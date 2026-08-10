import { isEnvAuthConfigured, resolveEnvAuth } from "@/lib/databricks/env-auth";
import { getSession, isSessionAuthenticated } from "@/lib/session";

async function tryGetSession() {
  try {
    return await getSession();
  } catch {
    // cookies() is unavailable outside a Next.js request (worker / scripts).
    return null;
  }
}

export async function isDatabricksAuthenticated(): Promise<boolean> {
  if (isEnvAuthConfigured()) {
    try {
      const envAuth = await resolveEnvAuth();
      if (envAuth) return true;
    } catch {
      // fall through to session
    }
  }

  const session = await tryGetSession();
  if (session && isSessionAuthenticated(session)) return true;
  return false;
}

export async function getDatabricksHost(): Promise<string | null> {
  try {
    const envAuth = await resolveEnvAuth();
    if (envAuth?.host) return envAuth.host;
  } catch {
    // fall through
  }

  const session = await tryGetSession();
  if (session && isSessionAuthenticated(session)) return session.host;
  return null;
}

export async function getActorEmail(): Promise<string | null> {
  const session = await tryGetSession();
  if (session?.userEmail) return session.userEmail;
  if (await isDatabricksAuthenticated()) return "env-auth";
  return null;
}

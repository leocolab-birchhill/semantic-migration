import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export interface SessionData {
  tenantId?: string;
  host?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  userEmail?: string;
  userName?: string;
  /** Temporary PKCE verifier during OAuth handshake */
  codeVerifier?: string;
  oauthState?: string;
}

function getSessionOptions(): SessionOptions {
  const password =
    process.env.SESSION_SECRET ??
    (process.env.NODE_ENV === "development"
      ? "dev-only-insecure-session-secret-32chars"
      : undefined);
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return {
    password,
    cookieName: "looker-metric-migration",
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 8,
    },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), getSessionOptions());
}

export function isSessionAuthenticated(
  session: SessionData
): session is SessionData & {
  accessToken: string;
  host: string;
  tenantId: string;
} {
  return Boolean(
    session.accessToken && session.host && session.tenantId && session.expiresAt
  );
}

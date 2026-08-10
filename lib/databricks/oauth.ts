import { createHash, randomBytes } from "crypto";
import type { TenantConfig } from "@/lib/types";
import { OAUTH_SCOPES } from "@/lib/types";

export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function generateOAuthState(): string {
  return randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(
  tenant: TenantConfig,
  codeChallenge: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: tenant.clientId,
    redirect_uri: tenant.redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${tenant.host}/oidc/v1/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeCodeForTokens(
  tenant: TenantConfig,
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: tenant.clientId,
    client_secret: tenant.clientSecret,
    redirect_uri: tenant.redirectUri,
    code,
    code_verifier: codeVerifier,
  });

  const res = await fetch(`${tenant.host}/oidc/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

export async function fetchUserInfo(
  host: string,
  accessToken: string
): Promise<{ email?: string; name?: string }> {
  const res = await fetch(`${host}/oidc/v1/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  return res.json() as Promise<{ email?: string; name?: string }>;
}

export async function refreshAccessToken(
  tenant: TenantConfig,
  refreshToken: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: tenant.clientId,
    client_secret: tenant.clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(`${tenant.host}/oidc/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

import { NextRequest, NextResponse } from "next/server";
import { getTenantForHost } from "@/lib/config/tenants";
import { exchangeCodeForTokens, fetchUserInfo } from "@/lib/databricks/oauth";
import { getSession } from "@/lib/session";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  if (error) {
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(errorDescription ?? error)}`, request.url)
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/?error=Missing+authorization+code", request.url)
    );
  }

  const session = await getSession();

  if (!session.oauthState || session.oauthState !== state) {
    return NextResponse.redirect(
      new URL("/?error=Invalid+OAuth+state", request.url)
    );
  }

  if (!session.codeVerifier || !session.tenantId) {
    return NextResponse.redirect(
      new URL("/?error=OAuth+session+expired", request.url)
    );
  }

  const tenant = session.host ? getTenantForHost(session.host) : null;
  if (!tenant) {
    return NextResponse.redirect(
      new URL("/?error=Tenant+configuration+missing", request.url)
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(tenant, code, session.codeVerifier);

    session.accessToken = tokens.access_token;
    session.refreshToken = tokens.refresh_token;
    session.expiresAt = Date.now() + tokens.expires_in * 1000;
    session.host = tenant.host;
    session.tenantId = tenant.id;
    session.codeVerifier = undefined;
    session.oauthState = undefined;

    const userInfo = await fetchUserInfo(tenant.host, tokens.access_token);
    session.userEmail = userInfo.email;
    session.userName = userInfo.name;

    await session.save();

    return NextResponse.redirect(new URL("/?connected=1", request.url));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(message)}`, request.url)
    );
  }
}

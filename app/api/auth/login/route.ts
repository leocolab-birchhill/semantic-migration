import { NextRequest, NextResponse } from "next/server";
import { resolveTenant } from "@/lib/config/tenants";
import {
  buildAuthorizeUrl,
  generateOAuthState,
  generatePkce,
} from "@/lib/databricks/oauth";
import { getSession } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { host?: string };
    const host = body.host?.trim();

    if (!host) {
      return NextResponse.json({ error: "Workspace URL is required" }, { status: 400 });
    }

    const tenant = resolveTenant(host);
    if (!tenant) {
      return NextResponse.json(
        {
          error:
            "Databricks OAuth is not configured. Set DATABRICKS_OAUTH_CLIENT_ID, DATABRICKS_OAUTH_CLIENT_SECRET, and DATABRICKS_OAUTH_REDIRECT_URI.",
        },
        { status: 400 }
      );
    }

    const { codeVerifier, codeChallenge } = generatePkce();
    const state = generateOAuthState();
    const session = await getSession();

    session.tenantId = tenant.id;
    session.host = tenant.host;
    session.codeVerifier = codeVerifier;
    session.oauthState = state;
    await session.save();

    const authorizeUrl = buildAuthorizeUrl(tenant, codeChallenge, state);
    return NextResponse.json({ authorizeUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

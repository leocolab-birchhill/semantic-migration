import { NextResponse } from "next/server";
import { getLookerConfig, getOpenAiKey } from "@/lib/config/looker";

export async function GET() {
  const config = getLookerConfig();
  return NextResponse.json({
    configured: Boolean(config),
    host: config?.host ?? null,
    openaiConfigured: Boolean(getOpenAiKey()),
    missing: config
      ? []
      : [
          !process.env.LOOKER_HOST && !process.env.Looker_HOST ? "LOOKER_HOST" : null,
          !process.env.LOOKER_CLIENT_ID && !process.env.Looker_Client_ID
            ? "LOOKER_CLIENT_ID"
            : null,
          !process.env.LOOKER_CLIENT_SECRET && !process.env.Looker_Client_Secret
            ? "LOOKER_CLIENT_SECRET"
            : null,
        ].filter(Boolean),
  });
}

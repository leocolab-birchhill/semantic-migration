import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-utils";
import { getLookerConfig } from "@/lib/config/looker";
import { listLookerReferencedTables } from "@/lib/migration/discover";

export async function GET() {
  try {
    const config = getLookerConfig();
    if (!config) {
      return NextResponse.json(
        {
          error:
            "Looker is not configured. Set LOOKER_HOST, LOOKER_CLIENT_ID, and LOOKER_CLIENT_SECRET.",
        },
        { status: 400 }
      );
    }

    const result = await listLookerReferencedTables();
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}

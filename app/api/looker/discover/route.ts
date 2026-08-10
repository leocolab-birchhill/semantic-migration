import { NextRequest, NextResponse } from "next/server";
import { apiError, requireFields } from "@/lib/api-utils";
import { discoverLookerDependencies } from "@/lib/migration/discover";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const missing = requireFields(body, ["catalog", "schema", "table"]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    const result = await discoverLookerDependencies({
      catalog: String(body.catalog),
      schema: String(body.schema),
      table: String(body.table),
      probeGeneratedSql: body.probeGeneratedSql !== false,
    });

    return NextResponse.json({ discovery: result });
  } catch (err) {
    return apiError(err);
  }
}

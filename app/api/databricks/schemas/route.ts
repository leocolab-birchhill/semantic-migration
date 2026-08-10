import { NextRequest, NextResponse } from "next/server";
import { listSchemas } from "@/lib/databricks/client";
import { apiError, requireFields } from "@/lib/api-utils";

export async function GET(request: NextRequest) {
  try {
    const warehouseId = request.nextUrl.searchParams.get("warehouseId");
    const catalog = request.nextUrl.searchParams.get("catalog");
    const missing = requireFields({ warehouseId, catalog }, ["warehouseId", "catalog"]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    const schemas = await listSchemas(warehouseId!, catalog!);
    return NextResponse.json({ schemas });
  } catch (err) {
    return apiError(err);
  }
}

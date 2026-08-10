import { NextRequest, NextResponse } from "next/server";
import { listTables } from "@/lib/databricks/client";
import { apiError, requireFields } from "@/lib/api-utils";

export async function GET(request: NextRequest) {
  try {
    const warehouseId = request.nextUrl.searchParams.get("warehouseId");
    const catalog = request.nextUrl.searchParams.get("catalog");
    const schema = request.nextUrl.searchParams.get("schema");
    const missing = requireFields(
      { warehouseId, catalog, schema },
      ["warehouseId", "catalog", "schema"]
    );
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    const tables = await listTables(warehouseId!, catalog!, schema!);
    return NextResponse.json({ tables });
  } catch (err) {
    return apiError(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { listCatalogs } from "@/lib/databricks/client";
import { apiError, requireFields } from "@/lib/api-utils";

export async function GET(request: NextRequest) {
  try {
    const warehouseId = request.nextUrl.searchParams.get("warehouseId");
    const missing = requireFields({ warehouseId }, ["warehouseId"]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    const catalogs = await listCatalogs(warehouseId!);
    return NextResponse.json({ catalogs });
  } catch (err) {
    return apiError(err);
  }
}

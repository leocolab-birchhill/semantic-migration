import { NextRequest, NextResponse } from "next/server";
import { assessPermissions } from "@/lib/databricks/permissions";
import { apiError, requireFields } from "@/lib/api-utils";
import type { ResourceSelection } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<ResourceSelection>;
    const missing = requireFields(body, [
      "warehouseId",
      "catalog",
      "sourceSchema",
      "sourceTable",
      "destSchema",
    ]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    const assessment = await assessPermissions({
      warehouseId: body.warehouseId!,
      catalog: body.catalog!,
      sourceSchema: body.sourceSchema!,
      sourceTable: body.sourceTable!,
      destSchema: body.destSchema!,
      createNewSchema: Boolean(body.createNewSchema),
    });

    return NextResponse.json(assessment);
  } catch (err) {
    return apiError(err);
  }
}

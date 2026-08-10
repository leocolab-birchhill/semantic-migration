import { NextRequest, NextResponse } from "next/server";
import { runWriteProbe } from "@/lib/databricks/permissions";
import { apiError, requireFields } from "@/lib/api-utils";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      warehouseId?: string;
      catalog?: string;
      destSchema?: string;
      confirmed?: boolean;
    };

    const missing = requireFields(body, ["warehouseId", "catalog", "destSchema"]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    if (!body.confirmed) {
      return NextResponse.json(
        { error: "Write probe requires explicit confirmation (confirmed: true)" },
        { status: 400 }
      );
    }

    const assessment = await runWriteProbe(
      body.warehouseId!,
      body.catalog!,
      body.destSchema!
    );

    return NextResponse.json(assessment);
  } catch (err) {
    return apiError(err);
  }
}

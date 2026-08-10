import { NextRequest, NextResponse } from "next/server";
import { createMetricView } from "@/lib/databricks/client";
import { apiError, requireFields } from "@/lib/api-utils";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      warehouseId?: string;
      catalog?: string;
      destSchema?: string;
      viewName?: string;
      yaml?: string;
      confirmed?: boolean;
    };

    const missing = requireFields(body, [
      "warehouseId",
      "catalog",
      "destSchema",
      "viewName",
      "yaml",
    ]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    if (!body.confirmed) {
      return NextResponse.json(
        { error: "Metric view creation requires explicit confirmation (confirmed: true)" },
        { status: 400 }
      );
    }

    const result = await createMetricView(
      body.warehouseId!,
      body.catalog!,
      body.destSchema!,
      body.viewName!,
      body.yaml!
    );

    if (result.status !== "SUCCEEDED") {
      return NextResponse.json(
        {
          ok: false,
          error: result.error?.message ?? "Metric view creation failed",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: `Metric view ${body.catalog}.${body.destSchema}.${body.viewName} created`,
    });
  } catch (err) {
    return apiError(err);
  }
}

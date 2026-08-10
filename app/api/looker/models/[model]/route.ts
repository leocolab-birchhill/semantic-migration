import { NextRequest, NextResponse } from "next/server";
import { getModel, listViews } from "@/lib/looker/client";
import { apiError } from "@/lib/api-utils";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ model: string }> }
) {
  try {
    const { model } = await context.params;
    const modelDetail = await getModel(model);
    let views: Awaited<ReturnType<typeof listViews>> = [];
    try {
      views = await listViews(model);
    } catch {
      // Views are optional in the explorer; explores remain available.
    }
    return NextResponse.json({
      model: modelDetail,
      explores: modelDetail.explores ?? [],
      views,
    });
  } catch (err) {
    return apiError(err);
  }
}

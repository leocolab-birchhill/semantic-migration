import { NextRequest, NextResponse } from "next/server";
import { getView } from "@/lib/looker/client";
import { apiError } from "@/lib/api-utils";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ model: string; view: string }> }
) {
  try {
    const { model, view } = await context.params;
    const detail = await getView(model, view);
    return NextResponse.json({ detail });
  } catch (err) {
    return apiError(err);
  }
}

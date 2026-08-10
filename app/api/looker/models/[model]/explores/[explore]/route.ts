import { NextRequest, NextResponse } from "next/server";
import { getExplore } from "@/lib/looker/client";
import { apiError } from "@/lib/api-utils";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ model: string; explore: string }> }
) {
  try {
    const { model, explore } = await context.params;
    const detail = await getExplore(model, explore);
    return NextResponse.json({ detail });
  } catch (err) {
    return apiError(err);
  }
}

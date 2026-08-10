import { NextRequest, NextResponse } from "next/server";
import { getDashboard } from "@/lib/looker/client";
import { apiError } from "@/lib/api-utils";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const dashboard = await getDashboard(id);
    return NextResponse.json({ dashboard });
  } catch (err) {
    return apiError(err);
  }
}

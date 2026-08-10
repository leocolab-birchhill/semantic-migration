import { NextRequest, NextResponse } from "next/server";
import { listDashboards } from "@/lib/looker/client";
import { apiError } from "@/lib/api-utils";

export async function GET(request: NextRequest) {
  try {
    const title = request.nextUrl.searchParams.get("title") ?? undefined;
    const dashboards = await listDashboards(title);
    return NextResponse.json({ dashboards });
  } catch (err) {
    return apiError(err);
  }
}

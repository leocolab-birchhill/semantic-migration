import { NextRequest, NextResponse } from "next/server";
import { getProjectFileContent, listProjectFiles } from "@/lib/looker/client";
import { apiError } from "@/lib/api-utils";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ project: string }> }
) {
  try {
    const { project } = await context.params;
    const path = request.nextUrl.searchParams.get("path") ?? "";
    const content = request.nextUrl.searchParams.get("content") === "1";

    if (content && path) {
      const file = await getProjectFileContent(project, path);
      return NextResponse.json({ file });
    }

    const files = await listProjectFiles(project, path);
    return NextResponse.json({ files });
  } catch (err) {
    return apiError(err);
  }
}

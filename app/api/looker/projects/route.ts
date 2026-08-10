import { NextResponse } from "next/server";
import { listProjects } from "@/lib/looker/client";
import { apiError } from "@/lib/api-utils";

export async function GET() {
  try {
    const projects = await listProjects();
    return NextResponse.json({ projects });
  } catch (err) {
    return apiError(err);
  }
}

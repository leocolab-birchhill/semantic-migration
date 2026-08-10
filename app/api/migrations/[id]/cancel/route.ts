import { NextRequest, NextResponse } from "next/server";
import { cancelJob, getJob } from "@/lib/migration/jobs";
import { isDatabricksAuthenticated } from "@/lib/databricks/auth-check";
import { apiError } from "@/lib/api-utils";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await isDatabricksAuthenticated())) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { id } = await params;
    const existing = await getJob(id);
    if (!existing) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (
      !["pending", "running", "needs_input"].includes(existing.status)
    ) {
      return NextResponse.json(
        {
          error: `Cannot cancel a job with status "${existing.status}"`,
          job: existing,
        },
        { status: 409 }
      );
    }

    const job = await cancelJob(id);
    if (!job) {
      return NextResponse.json(
        { error: "Job could not be cancelled", job: existing },
        { status: 409 }
      );
    }

    return NextResponse.json({ job, cancelled: true });
  } catch (err) {
    return apiError(err);
  }
}

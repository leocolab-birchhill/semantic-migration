import { NextRequest, NextResponse } from "next/server";
import { approveJob, getJob } from "@/lib/migration/jobs";
import { publishApprovedJob } from "@/lib/migration/worker";
import { isDatabricksAuthenticated } from "@/lib/databricks/auth-check";
import { apiError } from "@/lib/api-utils";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await isDatabricksAuthenticated())) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { id } = await params;
    const body = (await request.json()) as { action?: string; confirmed?: boolean };

    if (!body.confirmed) {
      return NextResponse.json(
        { error: "Production publication requires explicit confirmation (confirmed: true)" },
        { status: 400 }
      );
    }

    const job = await getJob(id);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (body.action === "approve") {
      if (job.status !== "awaiting_approval") {
        return NextResponse.json(
          { error: `Cannot approve job in status: ${job.status}` },
          { status: 400 }
        );
      }
      await approveJob(id);
      return NextResponse.json({ ok: true, status: "approved" });
    }

    if (body.action === "publish") {
      if (job.status !== "approved") {
        return NextResponse.json(
          { error: "Job must be approved before publishing" },
          { status: 400 }
        );
      }
      await publishApprovedJob(id);
      return NextResponse.json({ ok: true, status: "published" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return apiError(err);
  }
}

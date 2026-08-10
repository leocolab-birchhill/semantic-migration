import { NextRequest, NextResponse } from "next/server";
import {
  getJob,
  getJobArtifacts,
  getJobIterations,
  getJobTests,
} from "@/lib/migration/jobs";
import {
  getJobEvents,
  getLatestMigrationReport,
} from "@/lib/migration/report";
import { isDatabricksAuthenticated } from "@/lib/databricks/auth-check";
import { apiError } from "@/lib/api-utils";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await isDatabricksAuthenticated())) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { id } = await params;
    const lite = request.nextUrl.searchParams.get("lite") === "1";
    const job = await getJob(id);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const [iterations, tests, artifacts, events, migrationReport] =
      await Promise.all([
        getJobIterations(id),
        getJobTests(id, { lite }),
        getJobArtifacts(id, { lite }),
        getJobEvents(id),
        getLatestMigrationReport(id),
      ]);

    return NextResponse.json({
      job,
      iterations,
      tests,
      artifacts,
      events,
      migrationReport,
    });
  } catch (err) {
    return apiError(err);
  }
}

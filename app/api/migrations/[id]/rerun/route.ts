import { NextRequest, NextResponse } from "next/server";
import { createJob, getJob, jobToCreateInput } from "@/lib/migration/jobs";
import { getActorEmail, isDatabricksAuthenticated } from "@/lib/databricks/auth-check";
import { apiError } from "@/lib/api-utils";
import { v4 as uuidv4 } from "uuid";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await isDatabricksAuthenticated())) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { id } = await params;
    const source = await getJob(id);
    if (!source) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    let body: { idempotencyKey?: string } = {};
    try {
      body = (await request.json()) as { idempotencyKey?: string };
    } catch {
      body = {};
    }

    const idempotencyKey =
      body.idempotencyKey ?? `rerun:${id}:${uuidv4()}`;

    const { job, created } = await createJob(
      jobToCreateInput(source, idempotencyKey),
      (await getActorEmail()) ?? undefined
    );

    return NextResponse.json(
      {
        job,
        created,
        restoredSelections: {
          looker: {
            type:
              source.lookerSourceType === "dashboard"
                ? "dashboard"
                : "explore",
            model: source.lookerModel,
            explore: source.lookerExplore,
            dashboardId: source.lookerDashboardId,
            dashboardTitle: source.lookerDashboardTitle,
            label:
              source.lookerSourceType === "table_scope"
                ? `${source.catalog}.${source.sourceSchema}.${source.sourceTable}`
                : source.lookerSourceType === "dashboard"
                  ? source.lookerDashboardTitle ??
                    source.lookerDashboardId ??
                    "Dashboard"
                  : `${source.lookerModel}.${source.lookerExplore}`,
          },
          databricks: {
            warehouseId: source.warehouseId,
            catalog: source.catalog,
            sourceSchema: source.sourceSchema,
            sourceTable: source.sourceTable,
            destSchema: source.devSchema,
            prodSchema: source.prodSchema ?? undefined,
          },
          prodSchema: source.prodSchema,
          connectedHost: source.databricksHost,
          migrationScope: source.migrationScope,
        },
      },
      { status: created ? 201 : 200 }
    );
  } catch (err) {
    return apiError(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { isDatabaseConfigured } from "@/lib/db/client";
import { createJob, listJobs } from "@/lib/migration/jobs";
import { getActorEmail, isDatabricksAuthenticated } from "@/lib/databricks/auth-check";
import { apiError, requireFields } from "@/lib/api-utils";
import { validateMigrationSchemas } from "@/lib/migration/schema-guard";
import type { CreateMigrationJobInput } from "@/lib/migration/types";

export async function GET() {
  try {
    if (!isDatabaseConfigured()) {
      return NextResponse.json({ jobs: [], dbConfigured: false });
    }
    const jobs = await listJobs((await getActorEmail()) ?? undefined);
    return NextResponse.json({ jobs, dbConfigured: true });
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isDatabaseConfigured()) {
      return NextResponse.json(
        { error: "Database is not configured" },
        { status: 503 }
      );
    }

    if (!(await isDatabricksAuthenticated())) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = (await request.json()) as CreateMigrationJobInput;
    const bodyRecord = body as unknown as Record<string, unknown>;
    const missing = requireFields(bodyRecord, [
      "lookerSourceType",
      "databricksHost",
      "warehouseId",
      "catalog",
      "sourceSchema",
      "sourceTable",
      "devSchema",
    ]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    const schemaCheck = validateMigrationSchemas({
      sourceSchema: body.sourceSchema,
      devSchema: body.devSchema,
      prodSchema: body.prodSchema,
    });
    if (!schemaCheck.ok) {
      return NextResponse.json(
        { error: schemaCheck.errors.join("; ") },
        { status: 400 }
      );
    }

    if (body.lookerSourceType === "explore") {
      const exploreMissing = requireFields(bodyRecord, [
        "lookerModel",
        "lookerExplore",
      ]);
      if (exploreMissing) {
        return NextResponse.json({ error: exploreMissing }, { status: 400 });
      }
    } else if (body.lookerSourceType === "dashboard") {
      const dashMissing = requireFields(bodyRecord, ["lookerDashboardId"]);
      if (dashMissing) {
        return NextResponse.json({ error: dashMissing }, { status: 400 });
      }
    } else if (body.lookerSourceType === "table_scope") {
      const scope = body.migrationScope;
      if (!scope?.explores?.length) {
        return NextResponse.json(
          { error: "Select at least one Explore to migrate" },
          { status: 400 }
        );
      }
      // Tiles optional: explore/view migrations without dashboards are allowed.
      // Seed primary looker fields from first confirmed explore
      body.lookerModel = scope.explores[0].model;
      body.lookerExplore = scope.explores[0].explore;
    } else {
      return NextResponse.json(
        { error: "Invalid lookerSourceType" },
        { status: 400 }
      );
    }

    const { job, created } = await createJob(
      body,
      (await getActorEmail()) ?? undefined
    );
    return NextResponse.json(
      { job, created },
      { status: created ? 201 : 200 }
    );
  } catch (err) {
    return apiError(err);
  }
}

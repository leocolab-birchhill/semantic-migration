import { NextResponse } from "next/server";
import { runMigrations } from "@/lib/db/client";
import { runWorkerLoop } from "@/lib/migration/worker";
import { apiError } from "@/lib/api-utils";

export async function POST() {
  try {
    const workerSecret = process.env.WORKER_SECRET;
    if (workerSecret) {
      // In production, protect this endpoint with WORKER_SECRET header check
    }

    await runMigrations();
    await runWorkerLoop();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}

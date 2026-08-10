#!/usr/bin/env npx tsx
/**
 * Durable background worker for migration jobs.
 * Run: npm run worker
 *
 * Polls PostgreSQL for pending jobs and processes them through the
 * reconciliation loop. In production, run as a separate process or
 * cron hitting POST /api/worker/tick.
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import { runMigrations } from "../lib/db/client";
import { runWorkerLoop } from "../lib/migration/worker";

const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_MS ?? "5000", 10);

async function main() {
  console.log("[worker] Starting migration worker…");
  try {
    await runMigrations();
    console.log("[worker] Migrations applied");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[worker] Startup failed:", message);
    if (/fetch failed|auth|token|401|unauthorized/i.test(message)) {
      console.error(
        "[worker] Databricks/Lakebase auth likely expired. Run: npm run auth:databricks"
      );
      console.error(
        "[worker] Or boot everything with: npm run start:local"
      );
    }
    throw err;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runWorkerLoop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[worker] Error:", message);
      if (/fetch failed|auth|token|401|unauthorized/i.test(message)) {
        console.error(
          "[worker] Hint: npm run auth:databricks  (then restart this worker)"
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});

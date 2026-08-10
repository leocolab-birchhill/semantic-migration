#!/usr/bin/env npx tsx
/**
 * Create a table-first migration job from a confirmed scope draft
 * (produced by scripts/cli/discover.ts, then reviewed/edited by a human).
 *
 *   npm run cli:create-job -- --scope tmp-debug/scope-draft.json
 *
 * Bypasses the session-authed HTTP route and calls createJob() directly;
 * the background worker (npm run worker) picks the job up automatically.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import type {
  ConfirmedMigrationScope,
  CreateMigrationJobInput,
  DiscoveredTile,
  DiscoveredView,
} from "../../lib/migration/types";

interface ScopeDraft {
  sourceTable: { catalog: string; schema: string; table: string };
  databricks: {
    host: string;
    warehouseId: string;
    devSchema: string;
    prodSchema?: string;
  };
  options?: {
    maxIterations?: number;
    decimalScale?: number;
    timezone?: string;
  };
  explores: Array<{
    include?: boolean;
    model: string;
    explore: string;
  }>;
  tiles: Array<DiscoveredTile & { include?: boolean }>;
  views: DiscoveredView[];
}

async function main() {
  const args = process.argv.slice(2);
  const scopeIdx = args.indexOf("--scope");
  const scopeFile =
    scopeIdx >= 0 && args[scopeIdx + 1]
      ? args[scopeIdx + 1]
      : path.join("tmp-debug", "scope-draft.json");

  if (!fs.existsSync(path.resolve(scopeFile))) {
    console.error(`Scope file not found: ${scopeFile}`);
    console.error("Run discovery first: npm run cli:discover -- <catalog>.<schema>.<table>");
    process.exit(1);
  }

  const draft = JSON.parse(
    fs.readFileSync(path.resolve(scopeFile), "utf8")
  ) as ScopeDraft;

  const problems: string[] = [];
  if (!draft.sourceTable?.catalog || !draft.sourceTable?.schema || !draft.sourceTable?.table) {
    problems.push("sourceTable.catalog/schema/table are required");
  }
  if (!draft.databricks?.host || draft.databricks.host.startsWith("SET_ME")) {
    problems.push("databricks.host is not set (set DATABRICKS_HOST in .envs and re-run discover, or edit the draft)");
  }
  if (!draft.databricks?.warehouseId || draft.databricks.warehouseId === "SET_ME") {
    problems.push("databricks.warehouseId is not set — pick a warehouse id (npm run cli:doctor lists them)");
  }
  if (!draft.databricks?.devSchema) {
    problems.push("databricks.devSchema is required");
  }

  const explores = (draft.explores ?? []).filter((e) => e.include !== false);
  if (!explores.length) {
    problems.push("at least one explore must have include: true");
  }

  if (problems.length) {
    console.error("[create-job] Scope draft is not ready:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const tiles = (draft.tiles ?? [])
    .filter((t) => t.include !== false)
    .map((t) => {
      const { include: _include, ...tile } = t;
      return tile as DiscoveredTile;
    });

  const migrationScope: ConfirmedMigrationScope = {
    sourceTable: draft.sourceTable,
    explores: explores.map((e) => ({ model: e.model, explore: e.explore })),
    tiles,
    views: draft.views ?? [],
  };

  const input: CreateMigrationJobInput = {
    lookerSourceType: "table_scope",
    lookerModel: migrationScope.explores[0].model,
    lookerExplore: migrationScope.explores[0].explore,
    databricksHost: draft.databricks.host,
    warehouseId: draft.databricks.warehouseId,
    catalog: draft.sourceTable.catalog,
    sourceSchema: draft.sourceTable.schema,
    sourceTable: draft.sourceTable.table,
    devSchema: draft.databricks.devSchema,
    prodSchema: draft.databricks.prodSchema,
    maxIterations: draft.options?.maxIterations,
    decimalScale: draft.options?.decimalScale,
    timezone: draft.options?.timezone,
    migrationScope,
    idempotencyKey: `cli:${randomUUID()}`,
  };

  const { createJob } = await import("../../lib/migration/jobs");
  const userEmail = process.env.MIGRATION_USER_EMAIL;
  const { job, created } = await createJob(input, userEmail);

  console.log(`[create-job] ${created ? "Created" : "Reused existing"} job ${job.id}`);
  console.log(`  table:      ${job.catalog}.${job.sourceSchema}.${job.sourceTable}`);
  console.log(`  explores:   ${migrationScope.explores.map((e) => `${e.model}.${e.explore}`).join(", ")}`);
  console.log(`  benchmarks: ${tiles.length} tile(s)`);
  console.log(`  dev schema: ${job.devSchema}  prod schema: ${job.prodSchema ?? "(none)"}`);
  console.log(`  status:     ${job.status}`);
  console.log("\nNext:");
  console.log("  npm run worker                      # if not already running");
  console.log(`  npm run cli:job -- ${job.id} --watch`);
}

main()
  .then(() => {
    // pg pool keeps the event loop alive ~30s otherwise.
    process.exit(0);
  })
  .catch((err) => {
    console.error("[create-job] Fatal:", err);
    process.exit(1);
  });

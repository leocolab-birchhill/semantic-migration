/**
 * Build a MigrationJobRecord-shaped context from migrations/<table>/ artifacts.
 * Used by skill CLI (no Postgres job row).
 */
import fs from "fs";
import path from "path";
import {
  migrationDir,
  readParityConfig,
} from "@/lib/migration/repo-artifacts";
import type {
  IntermediateRepresentation,
  MigrationJobRecord,
} from "@/lib/migration/types";

export function readInventory(tableKey: string): IntermediateRepresentation {
  const invPath = path.join(migrationDir(tableKey), "inventory.json");
  if (!fs.existsSync(invPath)) {
    throw new Error(`Missing inventory.json under migrations/${tableKey}`);
  }
  return JSON.parse(fs.readFileSync(invPath, "utf8")) as IntermediateRepresentation;
}

export function readScopeProdSchema(tableKey: string): string | null {
  const scopePath = path.join(migrationDir(tableKey), "scope.json");
  if (!fs.existsSync(scopePath)) return null;
  try {
    const scope = JSON.parse(fs.readFileSync(scopePath, "utf8")) as {
      databricks?: { prodSchema?: string };
    };
    return scope.databricks?.prodSchema ?? null;
  } catch {
    return null;
  }
}

/** Minimal job-shaped context for deploy / parity / publish helpers. */
export function localJobFromTable(
  tableKey: string,
  overrides?: Partial<MigrationJobRecord>
): MigrationJobRecord {
  const cfg = readParityConfig(tableKey);
  const inventory = overrides?.inventory ?? readInventory(tableKey);
  const prodSchema =
    overrides?.prodSchema ??
    cfg.prodSchema ??
    readScopeProdSchema(tableKey) ??
    "business_semantics";

  return {
    id: overrides?.id ?? `local:${tableKey}`,
    tenantId: overrides?.tenantId ?? "local",
    userEmail: overrides?.userEmail ?? null,
    status: overrides?.status ?? "running",
    lookerSourceType: overrides?.lookerSourceType ?? "table_scope",
    lookerModel: overrides?.lookerModel ?? null,
    lookerExplore: overrides?.lookerExplore ?? null,
    lookerDashboardId: overrides?.lookerDashboardId ?? null,
    lookerDashboardTitle: overrides?.lookerDashboardTitle ?? null,
    databricksHost: overrides?.databricksHost ?? cfg.databricksHost,
    warehouseId: overrides?.warehouseId ?? cfg.warehouseId,
    catalog: overrides?.catalog ?? cfg.catalog,
    sourceSchema: overrides?.sourceSchema ?? cfg.sourceSchema,
    sourceTable: overrides?.sourceTable ?? cfg.sourceTable,
    devSchema: overrides?.devSchema ?? cfg.devSchema,
    prodSchema,
    maxIterations: overrides?.maxIterations ?? 1,
    decimalScale: overrides?.decimalScale ?? cfg.decimalScale,
    timezone: overrides?.timezone ?? cfg.timezone,
    currentPhase: overrides?.currentPhase ?? "test",
    iterationCount: overrides?.iterationCount ?? 0,
    inventory,
    parityReport: overrides?.parityReport ?? null,
    migrationScope: overrides?.migrationScope ?? null,
    errorMessage: overrides?.errorMessage ?? null,
    createdAt: overrides?.createdAt ?? new Date().toISOString(),
    updatedAt: overrides?.updatedAt ?? new Date().toISOString(),
    heartbeatAt: overrides?.heartbeatAt ?? null,
    approvedAt: overrides?.approvedAt ?? null,
    publishedAt: overrides?.publishedAt ?? null,
  };
}

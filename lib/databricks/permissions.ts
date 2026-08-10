import { executeStatement, rowsFromResult } from "@/lib/databricks/client";
import type { PermissionAssessment, PermissionCheckResult, ResourceSelection } from "@/lib/types";

function check(
  id: string,
  label: string,
  passed: boolean,
  message: string,
  missingGrant?: string,
  error?: string
): PermissionCheckResult {
  return {
    id,
    label,
    status: passed ? "pass" : "fail",
    message,
    missingGrant: passed ? undefined : missingGrant,
    error,
  };
}

function skipped(id: string, label: string, message: string): PermissionCheckResult {
  return { id, label, status: "skipped", message };
}

async function runSql(
  warehouseId: string,
  statement: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await executeStatement(warehouseId, statement);
    if (result.status === "SUCCEEDED") {
      return { ok: true };
    }
    return { ok: false, error: result.error?.message ?? "Statement failed" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function esc(s: string): string {
  return s.replace(/`/g, "``");
}

function qualified(catalog: string, schema: string, table?: string): string {
  const base = `\`${esc(catalog)}\`.\`${esc(schema)}\``;
  return table ? `${base}.\`${esc(table)}\`` : base;
}

async function grantsInclude(
  warehouseId: string,
  statement: string,
  privilege: string
): Promise<{ ok: boolean; grants: string; error?: string }> {
  try {
    const result = await executeStatement(warehouseId, statement);
    if (result.status !== "SUCCEEDED") {
      return {
        ok: false,
        grants: "",
        error: result.error?.message ?? "Could not read grants",
      };
    }
    const rows = rowsFromResult(result);
    const grants = rows.map((r) => r.join(" | ")).join("\n");
    const upper = grants.toUpperCase();
    const priv = privilege.toUpperCase();
    const ok =
      upper.includes(priv) ||
      upper.includes("ALL PRIVILEGES") ||
      upper.includes("MANAGE");
    return { ok, grants, error: ok ? undefined : `Grant not found: ${privilege}` };
  } catch (err) {
    return {
      ok: false,
      grants: "",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function assessPermissions(
  selection: ResourceSelection
): Promise<PermissionAssessment> {
  const {
    warehouseId,
    catalog,
    sourceSchema,
    sourceTable,
    destSchema,
    createNewSchema,
  } = selection;

  const checks: PermissionCheckResult[] = [];

  const warehouse = await runSql(warehouseId, "SELECT 1");
  checks.push(
    check(
      "warehouse_access",
      "SQL warehouse access",
      warehouse.ok,
      warehouse.ok
        ? "Can execute statements on the selected warehouse"
        : "Cannot execute on the selected warehouse",
      "USAGE on SQL warehouse",
      warehouse.error
    )
  );

  const useCatalog = await runSql(warehouseId, `USE CATALOG \`${esc(catalog)}\``);
  checks.push(
    check(
      "use_catalog",
      "USE CATALOG",
      useCatalog.ok,
      useCatalog.ok ? `Can use catalog ${catalog}` : `Cannot use catalog ${catalog}`,
      `USE CATALOG on \`${catalog}\``,
      useCatalog.error
    )
  );

  const schemaAccess = await runSql(
    warehouseId,
    `DESCRIBE SCHEMA ${qualified(catalog, destSchema)}`
  );
  checks.push(
    check(
      "use_schema",
      "Destination schema access",
      schemaAccess.ok,
      schemaAccess.ok
        ? `Can access destination schema ${catalog}.${destSchema}`
        : `Cannot access destination schema ${catalog}.${destSchema}`,
      `USAGE on \`${catalog}\`.\`${destSchema}\``,
      schemaAccess.error
    )
  );

  const selectSource = await runSql(
    warehouseId,
    `SELECT * FROM ${qualified(catalog, sourceSchema, sourceTable)} LIMIT 0`
  );
  checks.push(
    check(
      "select_source",
      "SELECT on source table",
      selectSource.ok,
      selectSource.ok
        ? `Can read ${catalog}.${sourceSchema}.${sourceTable}`
        : `Cannot read ${catalog}.${sourceSchema}.${sourceTable}`,
      `SELECT on \`${catalog}\`.\`${sourceSchema}\`.\`${sourceTable}\``,
      selectSource.error
    )
  );

  const schemaGrants = await grantsInclude(
    warehouseId,
    `SHOW GRANTS ON SCHEMA ${qualified(catalog, destSchema)}`,
    "CREATE TABLE"
  );
  checks.push(
    check(
      "create_table",
      "CREATE TABLE on destination schema (read-only grant check)",
      schemaGrants.ok,
      schemaGrants.ok
        ? "Grants suggest CREATE TABLE is allowed on destination schema"
        : "CREATE TABLE grant not visible; run write probe for definitive validation",
      `CREATE TABLE on \`${catalog}\`.\`${destSchema}\``,
      schemaGrants.error
    )
  );

  if (createNewSchema) {
    const catalogGrants = await grantsInclude(
      warehouseId,
      `SHOW GRANTS ON CATALOG \`${esc(catalog)}\``,
      "CREATE SCHEMA"
    );
    checks.push(
      check(
        "create_schema",
        "CREATE SCHEMA (new schema requested)",
        catalogGrants.ok,
        catalogGrants.ok
          ? "Grants suggest CREATE SCHEMA is allowed on catalog"
          : "CREATE SCHEMA grant not visible; schema must exist or run write probe",
        `CREATE SCHEMA on \`${catalog}\``,
        catalogGrants.error
      )
    );
  } else {
    checks.push(
      skipped(
        "create_schema",
        "CREATE SCHEMA",
        "Skipped — using an existing destination schema"
      )
    );
  }

  return {
    checks,
    allPassed: checks.every((c) => c.status === "pass" || c.status === "skipped"),
  };
}

export async function runWriteProbe(
  warehouseId: string,
  catalog: string,
  destSchema: string,
  probeName = "__permission_probe"
): Promise<PermissionAssessment> {
  const checks: PermissionCheckResult[] = [];
  const fqView = qualified(catalog, destSchema, probeName);

  const create = await runSql(
    warehouseId,
    `CREATE OR REPLACE VIEW ${fqView} AS SELECT 1 AS probe`
  );
  checks.push(
    check(
      "probe_create_view",
      "Write probe: CREATE VIEW",
      create.ok,
      create.ok
        ? "Successfully created probe view (write access confirmed)"
        : "Failed to create probe view",
      `CREATE VIEW on \`${catalog}\`.\`${destSchema}\``,
      create.error
    )
  );

  if (create.ok) {
    const drop = await runSql(warehouseId, `DROP VIEW IF EXISTS ${fqView}`);
    checks.push(
      check(
        "probe_drop_view",
        "Write probe: DROP VIEW (cleanup)",
        drop.ok,
        drop.ok ? "Probe view removed" : "Failed to drop probe view",
        `DROP on \`${catalog}\`.\`${destSchema}\`.\`${probeName}\``,
        drop.error
      )
    );
  }

  return {
    checks,
    allPassed: checks.every((c) => c.status === "pass"),
  };
}

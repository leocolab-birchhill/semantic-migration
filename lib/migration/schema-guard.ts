/** Destination schema defaults and hard-blocks for table-first migrations. */

export const DEFAULT_DEV_SCHEMA = "semantic_migration_dev";
export const DEFAULT_PROD_SCHEMA = "business_semantics";
export const FORBIDDEN_WRITE_SCHEMA = "dbt_production";

export interface SchemaGuardInput {
  sourceSchema: string;
  devSchema: string;
  prodSchema?: string | null;
}

export interface SchemaGuardResult {
  ok: boolean;
  errors: string[];
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Hard-block writing migration objects to unsafe schemas.
 * Dev must not equal source schema, prod schema, or dbt_production.
 * Prod must never be dbt_production. Source objects stay read-only.
 */
export function validateMigrationSchemas(
  input: SchemaGuardInput
): SchemaGuardResult {
  const errors: string[] = [];
  const source = norm(input.sourceSchema);
  const dev = norm(input.devSchema);
  const prod = input.prodSchema ? norm(input.prodSchema) : null;

  if (!dev) {
    errors.push("Dev schema is required");
  }

  if (dev === FORBIDDEN_WRITE_SCHEMA) {
    errors.push(
      `Dev schema cannot be ${FORBIDDEN_WRITE_SCHEMA} (source objects are read-only)`
    );
  }

  if (dev && source && dev === source) {
    errors.push(
      "Dev schema cannot equal the source schema (source tables stay read-only)"
    );
  }

  if (prod && dev === prod) {
    errors.push("Dev schema cannot equal the production schema");
  }

  if (prod === FORBIDDEN_WRITE_SCHEMA) {
    errors.push(
      `Production schema cannot be ${FORBIDDEN_WRITE_SCHEMA} (never write migration objects there)`
    );
  }

  return { ok: errors.length === 0, errors };
}

export function assertSafeWriteSchema(
  schema: string,
  role: "dev" | "prod"
): void {
  if (norm(schema) === FORBIDDEN_WRITE_SCHEMA) {
    throw new Error(
      `Refusing to write ${role} migration objects to ${FORBIDDEN_WRITE_SCHEMA}`
    );
  }
}

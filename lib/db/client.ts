import { Pool, type PoolClient, type QueryResultRow } from "pg";
import fs from "fs";
import path from "path";
import {
  getLakebaseConfig,
  getLakebasePassword,
  isLakebaseConfigured,
} from "@/lib/db/lakebase-auth";

let pool: Pool | null = null;
let poolExpiresAt = 0;

async function createPool(): Promise<Pool> {
  if (isLakebaseConfigured()) {
    const config = getLakebaseConfig();
    if (!config) {
      throw new Error("Lakebase is not fully configured");
    }

    const password = await getLakebasePassword();
    poolExpiresAt = Date.now() + 50 * 60_000;

    return new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password,
      ssl: config.sslmode === "require" ? { rejectUnauthorized: true } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 30_000,
    });
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Database is not configured. Set DATABASE_URL or Lakebase PG* variables."
    );
  }

  poolExpiresAt = Number.POSITIVE_INFINITY;
  return new Pool({ connectionString });
}

async function ensurePool(): Promise<Pool> {
  const needsRefresh =
    !pool || (isLakebaseConfigured() && Date.now() > poolExpiresAt - 60_000);

  if (needsRefresh) {
    if (pool) {
      await pool.end().catch(() => undefined);
      pool = null;
    }
    pool = await createPool();
  }

  if (!pool) {
    throw new Error("Failed to initialize database pool");
  }

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const activePool = await ensurePool();
  const result = await activePool.query<T>(text, params);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const activePool = await ensurePool();
  const client = await activePool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(process.cwd(), "db", "migrations");
  if (!fs.existsSync(migrationsDir)) return;

  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const { rows } = await query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [file]
    );
    if (rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file]
      );
    });
  }
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL) || isLakebaseConfigured();
}

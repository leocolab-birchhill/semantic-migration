import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import { getLakebaseConfig, getLakebasePassword } from "../lib/db/lakebase-auth";
import { query } from "../lib/db/client";

async function main() {
  const config = getLakebaseConfig();
  if (!config) {
    console.error("FAIL: Lakebase is not configured");
    process.exit(1);
  }

  if (!process.env.LAKEBASE_DATABRICKS_HOST) {
    console.error(
      "FAIL: LAKEBASE_DATABRICKS_HOST is empty. Set your Birch Hill (bhep-workspace) URL, then run:\n" +
        "  databricks auth login --host <LAKEBASE_DATABRICKS_HOST> -p bhep"
    );
    process.exit(1);
  }

  console.log("Lakebase host:", config.host);
  console.log("Lakebase user:", config.user);
  console.log("Auth method:", process.env.AUTH_METHOD ?? "(default)");

  await getLakebasePassword();
  console.log("OK: obtained Lakebase password token");

  const { rows } = await query<{ db: string; user: string }>(
    "SELECT current_database() AS db, current_user AS user"
  );
  console.log("Connected:", rows[0]);
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});

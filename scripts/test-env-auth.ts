import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });

import { resolveEnvAuth } from "../lib/databricks/env-auth";

async function main() {
  const auth = await resolveEnvAuth();
  if (!auth) {
    console.error("FAIL: no env auth resolved");
    process.exit(1);
  }
  console.log("OK host:", auth.host, "mode:", auth.mode);
  const res = await fetch(`${auth.host}/api/2.0/sql/warehouses`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  console.log("Warehouses API:", res.status, res.ok ? "OK" : "FAILED");
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});

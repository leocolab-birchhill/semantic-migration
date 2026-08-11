#!/usr/bin/env npx tsx
/**
 * Headless preflight: verify every dependency the migration pipeline needs
 * and print an exact remediation for each failure.
 *
 *   npm run cli:doctor
 *
 * Exit code 0 = all checks passed; 1 = at least one failure.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string, fix?: string) {
  results.push({ name, ok, detail, fix });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name} — ${detail}`);
  if (!ok && fix) console.log(`       fix: ${fix}`);
}

async function checkEnvFiles() {
  const hasEnvs = fs.existsSync(path.resolve(process.cwd(), ".envs"));
  const hasEnvLocal = fs.existsSync(path.resolve(process.cwd(), ".env.local"));
  record(
    "env file",
    hasEnvs || hasEnvLocal,
    hasEnvs || hasEnvLocal
      ? `found ${[hasEnvs && ".envs", hasEnvLocal && ".env.local"].filter(Boolean).join(", ")}`
      : "no .envs or .env.local found",
    "cp .envs.example .envs  # then fill in values (see .envs.example comments)"
  );
}

async function checkLooker() {
  const { getLookerConfig } = await import("../../lib/config/looker");
  const config = getLookerConfig();
  if (!config) {
    record(
      "looker config",
      false,
      "LOOKER_HOST / LOOKER_CLIENT_ID / LOOKER_CLIENT_SECRET missing",
      "Add the shared Looker credentials to .envs (from team vault)"
    );
    return;
  }
  record("looker config", true, `host ${config.host}`);
  try {
    const { listModels } = await import("../../lib/looker/client");
    const models = await listModels();
    record("looker api", true, `authenticated; ${models.length} models visible`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(
      "looker api",
      false,
      message.slice(0, 200),
      "Verify LOOKER_CLIENT_ID / LOOKER_CLIENT_SECRET are current, and that the Looker host is reachable (VPN?)"
    );
  }
}

async function checkOpenAi() {
  const { getOpenAiKey } = await import("../../lib/config/looker");
  const key = getOpenAiKey();
  record(
    "openai key",
    Boolean(key),
    key ? "OPENAI_API_KEY is set" : "OPENAI_API_KEY is missing",
    "Add the shared OPENAI_API_KEY to .envs (from team vault)"
  );
}

async function checkDatabricksAuth() {
  const { getConfiguredHost, isEnvAuthConfigured, resolveEnvAuth, listRequiredCliProfiles } =
    await import("../../lib/databricks/env-auth");

  const host = getConfiguredHost();
  if (!host) {
    record(
      "databricks host",
      false,
      "DATABRICKS_HOST (or DATABRICKS_TENANT_HOST) is not set",
      "Set DATABRICKS_HOST=https://<your-workspace> in your .envs"
    );
    return;
  }
  record("databricks host", true, host);

  if (!isEnvAuthConfigured()) {
    record(
      "databricks auth",
      false,
      "no PAT and no CLI profile configured for headless auth",
      "Set DATABRICKS_AUTH_MODE=cli + DATABRICKS_CLI_PROFILE=<profile> (then: npm run auth:databricks), or set DATABRICKS_TOKEN"
    );
    return;
  }

  const profiles = listRequiredCliProfiles();
  try {
    const auth = await resolveEnvAuth();
    if (!auth) throw new Error("resolveEnvAuth returned null");
    record(
      "databricks auth",
      true,
      `mode=${auth.mode}${auth.profile ? ` profile=${auth.profile}` : ""}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const loginHint =
      profiles.map((p) => p.loginCommand).join(" ; ") ||
      "npm run auth:databricks";
    record(
      "databricks auth",
      false,
      message.slice(0, 200),
      `Token missing/expired — run: npm run auth:databricks  (or directly: ${loginHint})`
    );
    return;
  }

  // Warehouse reachability proves network + permissions, not just a token.
  try {
    const { listWarehouses } = await import("../../lib/databricks/client");
    const warehouses = await listWarehouses();
    const names = warehouses
      .slice(0, 5)
      .map((w: { id: string; name: string }) => `${w.name} (${w.id})`)
      .join(", ");
    record(
      "databricks warehouses",
      warehouses.length > 0,
      warehouses.length
        ? `${warehouses.length} reachable: ${names}${warehouses.length > 5 ? ", …" : ""}`
        : "0 warehouses visible",
      "Ask a workspace admin for SQL warehouse access, or check the workspace URL"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(
      "databricks warehouses",
      false,
      message.slice(0, 200),
      /fetch|ENOTFOUND|ECONN|certificate|TLS/i.test(message)
        ? "Network/TLS issue — corporate VPN/SSL inspection needs Node --use-system-ca (npm scripts set this). Retry via: npm run cli:doctor"
        : "Run: npm run auth:databricks  (then retry)"
    );
  }
}

async function main() {
  console.log("=== Migration skill preflight (no job DB) ===\n");
  await checkEnvFiles();
  await checkLooker();
  await checkOpenAi();
  await checkDatabricksAuth();

  const failures = results.filter((r) => !r.ok);
  console.log(
    `\n${failures.length === 0 ? "All checks passed — ready to run migrations." : `${failures.length} check(s) failed — fix the items above, then re-run: npm run cli:doctor`}`
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[doctor] Fatal:", err);
  process.exit(1);
});

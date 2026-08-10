#!/usr/bin/env npx tsx
/**
 * Ensure Databricks CLI profiles used by this app have valid tokens.
 * Opens browser login only when a profile's token is missing/expired.
 *
 *   npm run auth:databricks
 */
import { spawn, spawnSync } from "child_process";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import {
  clearCliTokenCache,
  listRequiredCliProfiles,
  type RequiredCliProfile,
} from "../lib/databricks/env-auth";

function tokenOk(profile: string): boolean {
  const result = spawnSync(
    "databricks",
    ["auth", "token", "-p", profile, "-o", "json"],
    { encoding: "utf8", timeout: 30_000 }
  );
  if (result.status !== 0) return false;
  const out = (result.stdout ?? "").trim();
  if (!out) return false;
  try {
    const parsed = JSON.parse(out) as { access_token?: string; token?: string };
    return Boolean(parsed.access_token ?? parsed.token);
  } catch {
    return out.length > 20;
  }
}

async function login(profile: RequiredCliProfile): Promise<void> {
  console.log(`\n[auth] Logging in profile "${profile.profile}" (${profile.purpose})…`);
  console.log(`[auth] ${profile.loginCommand}\n`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "databricks",
      ["auth", "login", "--host", profile.host, "-p", profile.profile],
      { stdio: "inherit", shell: process.platform === "win32" }
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`databricks auth login exited with code ${code}`));
    });
  });
}

async function main() {
  const profiles = listRequiredCliProfiles();
  if (profiles.length === 0) {
    if (process.env.DATABRICKS_TOKEN || process.env.LAKEBASE_DATABRICKS_TOKEN) {
      console.log("[auth] Using PAT env tokens — CLI login not required.");
      return;
    }
    console.log(
      "[auth] No CLI profiles configured. Set DATABRICKS_CLI_PROFILE / LAKEBASE_DATABRICKS_CLI_PROFILE or PATs."
    );
    return;
  }

  console.log("[auth] Checking Databricks CLI profiles…");
  let allOk = true;

  for (const profile of profiles) {
    if (tokenOk(profile.profile)) {
      console.log(`[auth] ✓ ${profile.profile} (${profile.purpose}) — token ok`);
    } else {
      allOk = false;
      console.log(`[auth] ✗ ${profile.profile} (${profile.purpose}) — needs login`);
      await login(profile);
      if (!tokenOk(profile.profile)) {
        throw new Error(
          `Still no token for profile "${profile.profile}". Re-run: ${profile.loginCommand}`
        );
      }
      console.log(`[auth] ✓ ${profile.profile} — login succeeded`);
    }
  }

  clearCliTokenCache();
  if (allOk) {
    console.log("[auth] All Databricks CLI profiles ready.");
  } else {
    console.log("[auth] Databricks auth refreshed. Restart worker/dev if they were already running.");
  }
}

main().catch((err) => {
  console.error("[auth] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * One-command local boot: Databricks CLI auth → Next.js + migration worker.
 *
 *   npm run start:local
 */
import { spawn, type ChildProcess } from "child_process";

async function runEnsureAuth(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "auth:databricks"], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`auth ensure exited with code ${code}`));
    });
  });
}

function startNpmScript(script: string, label: string): ChildProcess {
  const child = spawn("npm", ["run", script], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  child.on("error", (err) => {
    console.error(`[${label}] failed to start:`, err.message);
  });
  return child;
}

async function main() {
  console.log("[start:local] Ensuring Databricks auth…");
  await runEnsureAuth();

  console.log("[start:local] Starting Next.js (dev) + migration worker…");
  console.log("[start:local] Open http://localhost:3000 — Ctrl+C stops both.\n");

  const children = [startNpmScript("dev", "dev"), startNpmScript("worker", "worker")];

  const shutdown = (signal: NodeJS.Signals) => {
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const codes = await Promise.all(
    children.map(
      (child) =>
        new Promise<number>((resolve) => {
          child.on("close", (code) => resolve(code ?? 1));
        })
    )
  );

  const failed = codes.find((c) => c !== 0);
  process.exit(failed ?? 0);
}

main().catch((err) => {
  console.error("[start:local] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

---
name: looker-databricks-migration
description: >-
  Operates the Looker-to-Databricks migration pipeline: OpenAI one-shot YAML
  draft plus per-table parity harness, then local Cursor repair against
  Databricks CLI/API feedback with an accumulating edge-case repo. Use when
  working in viewReconciliationAgent, migration jobs, Looker explores/tiles,
  metric views, parity failures, or semantic layer migration. On every
  invocation, open by stating requirements (credentials, target schemas,
  Databricks grants), then run the credentials/schema gate before any
  discover, draft, or repair work.
disable-model-invocation: true
---

# Looker → Databricks Migration (OpenAI draft + local fix)

OpenAI drafts **once**. The local Cursor model owns **all repair**, using
Databricks CLI/API feedback and the edge-case repo. Never call OpenAI diagnose.

## First action on every invocation

**Stop. Do not run discover / create-job / draft / worker / deploy yet.**

1. **State requirements** (sections below) so the human sees what is needed.
2. **Check** soft prereqs → `npm run cli:doctor` → missing credentials →
   target schemas → Databricks grants.
3. Only after doctor is green **and** the human has confirmed target schemas
   (create if needed) → ask for `catalog.schema.table` or a job id.

Full protocol: [setup-auth.md](setup-auth.md).

---

## Requirements (state these first)

### A — Credentials (fill `.envs`, do not paste secrets into chat)

Tell the human they must supply credentials **by editing `.envs`** (copy from
`.envs.example` if missing). **Never ask them to paste secret values into
chat.** Give exact variable names and `[PER-DEV]` / `[SHARED]` labels.

| Cluster | Variables | Source |
|---------|-----------|--------|
| Databricks workspace | `DATABRICKS_HOST`, `DATABRICKS_AUTH_MODE=cli`, `DATABRICKS_CLI_PROFILE` (or `DATABRICKS_TOKEN`) | `[PER-DEV]` |
| Looker API | `LOOKER_HOST`, `LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET` | `[SHARED]` vault |
| OpenAI | `OPENAI_API_KEY` | `[SHARED]` vault |
| Job DB | `DATABASE_URL` **or** Lakebase `PG*` + `LAKEBASE_*` | `[PER-DEV]` or `[SHARED]` |

When a cluster is missing/broken, **explicitly request it**:

1. Name the variables and whether they are `[PER-DEV]` or `[SHARED]`.
2. Instruct: open `.envs` in the IDE, paste values **there** (from vault /
   workspace), save. Reply **done** — do **not** paste secrets into chat.
3. For expired CLI tokens: run `npm run auth:databricks` and wait for the
   human to finish **every** browser profile listed.

### B — Databricks target schemas (confirm before create-job)

**Always ask and get an explicit answer** before creating a job:

1. **Catalog** (usually same as source, e.g. `databricks_prd`)
2. **Dev schema** (deploy target for SQL views + metric views during migration)  
   Default in drafts: `semantic_migration_dev`
3. **Prod schema** (publish target on approve only)  
   Default: `business_semantics`
4. Do these schemas **already exist**, or should they be **created**?
   - Exist → use them; verify `USAGE` + `CREATE TABLE` / write access
   - Create → human (or admin) must have `CREATE SCHEMA` on the catalog;
     create via Databricks UI/SQL, then confirm names again
5. Confirm: **never write to `dbt_production`** (source only)

Record confirmed names into `tmp-debug/scope-draft.json`
(`databricks.devSchema` / `databricks.prodSchema`) before `cli:create-job`.

### C — Databricks permissions (list for the human / admin)

The Databricks identity used by the CLI profile (or PAT) needs at least:

| Privilege | On | Why |
|-----------|-----|-----|
| Can use SQL warehouse | Selected warehouse | `cli:doctor` warehouses + all SQL |
| `USE CATALOG` | Target catalog | Resolve objects |
| `USE SCHEMA` + `SELECT` | Source schema / table | Inventory + parity queries |
| `USE SCHEMA` | Dev (and prod if publishing) schema | Deploy / approve |
| `CREATE TABLE` / create views + metric views | Dev schema | `cli:deploy` (`CREATE OR REPLACE VIEW` / metric views) |
| `CREATE SCHEMA` | Catalog | **Only if** creating a new dest schema |
| Drop/replace own views | Dev schema | Redeploy / cleanup |

Optional write probe (UI / admin): create+drop a probe view in the dest schema.

Looker needs an API user that can see the model/explore/tiles for the table.
OpenAI needs a key that can call the generate model. Job DB must accept
connections (local Postgres or Lakebase OAuth via `bhep` profile).

---

## Check gate (after stating requirements)

1. Soft prereqs: `node_modules`, Databricks CLI, `.envs` from `.envs.example`.
2. `npm run cli:doctor` — source of truth for auth/API/DB/warehouses.
3. For each FAIL, guide **one cluster at a time** (credential request pattern
   above). Re-run doctor until **all PASS**.
4. **Schema confirmation** (section B) — do not skip even if doctor is green.
5. Then: migration-ready; ask for `catalog.schema.table` or job id.

If doctor is already all PASS, still **briefly restate** requirements status
(hosts/modes only — never secrets) and **still confirm schemas** before
discover/create-job. Do not re-litigate working credentials.

## Division of labor

| Actor | Does | Does not |
|-------|------|----------|
| **OpenAI** (worker / `cli:draft`) | One-shot metric-view YAML + SQL + harness config | Diagnose, iterative patches |
| **You (Cursor local model)** | Requirements briefing; credentials/schema gate; patch `draft/`; deploy+parity; edge-case notes | Invent credentials; echo `.envs` values; collect secrets in chat |
| **Human** | Paste credentials into `.envs` (not chat); browser auth; confirm schemas; approve/publish | — |

## Core workflow (only after gate + schema confirm)

```
state requirements → check doctor → confirm schemas
  → discover → human confirms explore/tile scope → create-job → worker/draft
  → OpenAI generate (once) → write migrations/<table>/
  → deploy + parity once
  → pass? awaiting_approval
  → fail? needs_input → YOU fix locally (no OpenAI diagnose)
```

Headless equivalent:

```bash
npm run cli:doctor
# confirm databricks.devSchema / prodSchema in scope draft (create schemas if needed)
npm run cli:discover -- <catalog>.<schema>.<table>
# edit tmp-debug/scope-draft.json (warehouseId, include flags, schemas)
npm run cli:create-job -- --scope tmp-debug/scope-draft.json
npm run worker   # generate once; pauses on failure
# OR after a job exists:
npm run cli:draft -- --job <jobId>
npm run cli:deploy -- <catalog.schema.table>
npm run cli:parity -- --job <jobId>
```

## Local fix loop (your job)

When status is `needs_input` or `cli:parity` exits non-zero:

1. Read `migrations/<table>/harness/last-run.json`
2. Read [cases/README.md](../../../cases/README.md) and `migrations/<table>/edge-cases/`
3. Patch `draft/sql_view.sql` and/or `draft/metric_view.yaml` (not free-form new apps)
4. `npm run cli:deploy -- <tableKey>` then `npm run cli:parity -- --job <jobId>`
5. **Required:** append `migrations/<table>/edge-cases/NNN-*.md` using [cases/_TEMPLATE.md](../../../cases/_TEMPLATE.md); promote to `cases/` if reusable
6. When mandatory tiles pass → `npm run cli:approve -- <jobId> --confirm` (human)

If mid-run auth dies (`fetch failed`, doctor auth FAIL), return to the
credentials gate — usually `npm run auth:databricks` — then retry deploy/parity.

## Hard rules

- Never call `diagnoseFailures` / OpenAI repair for a live job.
- Never resume a stale paused job after worker code changes — `--rerun` / new job.
- Never write to `dbt_production`; publish only via explicit approve.
- Correctness comes from parity gates + Looker benchmarks, not generation.
- After every successful fix, write an edge-case note (regression ratchet).
- Never read/print `.envs` secrets; never collect secrets in chat — instruct
  paste into `.envs` only.
- Never skip explicit human confirmation of dev/prod schema names (and create
  vs exist).

## References

- [setup-auth.md](setup-auth.md) — credentials gate, schema gate, permissions
- [operations.md](operations.md) — CLI commands and statuses
- [debugging.md](debugging.md) — failure taxonomy for local fixes
- [verification.md](verification.md) — what “correct” means
- [translation-guide.md](translation-guide.md) — deterministic vs LLM boundary
- [edge-cases.md](edge-cases.md) — how to grow the case library

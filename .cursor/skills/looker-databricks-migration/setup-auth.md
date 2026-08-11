# Setup and Authentication

## One-time onboarding (new teammate)

1. Clone the repo, `npm install`.
2. `cp .envs.example .envs` and fill values — the template marks each
   variable `[PER-DEV]` or `[SHARED]` (shared values come from the team
   vault; never commit `.envs`).
3. Database: local Postgres via `npm run db:up && npm run db:migrate`, or
   the shared Lakebase config.
4. `npm run auth:databricks` — opens a browser once to log the CLI profile
   into the workspace.
5. Confirm Databricks **dev** and **prod** schemas exist (or create them).
6. `npm run cli:doctor` — must be all PASS before running migrations.

## Auth model

| Service | Scope | Mechanism |
|---------|-------|-----------|
| Databricks workspace | Per-dev (any workspace) | `DATABRICKS_HOST` + `DATABRICKS_CLI_PROFILE` (CLI OAuth token) or `DATABRICKS_TOKEN` (PAT) |
| Looker | Shared team API user | `LOOKER_HOST` / `LOOKER_CLIENT_ID` / `LOOKER_CLIENT_SECRET` |
| OpenAI | Shared team key | `OPENAI_API_KEY` |
| Job DB | Per-dev or shared | `DATABASE_URL` (Postgres) or Lakebase `PG*` + `LAKEBASE_*` |

Pointing at a different Databricks workspace = change `DATABRICKS_HOST` and
`DATABRICKS_CLI_PROFILE` in your `.envs`, run `npm run auth:databricks`,
restart the worker. No code changes.

The OAuth app variables (`DATABRICKS_OAUTH_*`, `SESSION_SECRET`) are only
needed for the optional web UI, not for headless use.

## Requirements briefing (open every skill start with this)

Before soft prereqs / doctor, the agent **states** what is required:

1. **Credentials** — variables below; human pastes values into `.envs` only.
2. **Target schemas** — catalog + dev + prod; exist or create.
3. **Databricks grants** — warehouse, catalog, source read, dest write.

Then the agent **checks** (doctor + human confirmation). Do not start
discover until both are done.

---

## Credential checklist (request explicitly when missing)

Instruct the human to open `.envs` and paste values **into that file**.
**Never ask them to paste secret values into chat.**

### Required for headless migration

| Variable(s) | Label | What to tell the human |
|-------------|-------|------------------------|
| `DATABRICKS_HOST` | `[PER-DEV]` | Workspace URL, no trailing slash |
| `DATABRICKS_AUTH_MODE=cli` + `DATABRICKS_CLI_PROFILE` | `[PER-DEV]` | Preferred; then `npm run auth:databricks` |
| **or** `DATABRICKS_TOKEN` | `[PER-DEV]` | PAT alternative to CLI profile |
| `LOOKER_HOST`, `LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET` | `[SHARED]` | From team vault → paste into `.envs` |
| `OPENAI_API_KEY` | `[SHARED]` | From team vault → paste into `.envs` |
| Job DB: `DATABASE_URL` **or** Lakebase block (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGSSLMODE`, `AUTH_METHOD`, `LAKEBASE_DATABRICKS_*`) | `[PER-DEV]` / `[SHARED]` | Ask local Postgres vs Lakebase first |

### Optional (web UI only)

`DATABRICKS_OAUTH_*`, `SESSION_SECRET` — skip for CLI/worker-only use.

### Credential request script (copy this pattern)

When doctor (or presence check) shows a gap:

1. “These credentials are required / failing: …”
2. “Open `.envs` and paste values for: `VAR1`, `VAR2`, … (`[SHARED]` from vault / `[PER-DEV]` from your workspace).”
3. Point at the matching commented block in `.envs.example`.
4. “Do **not** paste the secret values into this chat. Reply **done** when saved.”
5. Re-run `npm run cli:doctor`.

For expired Databricks/Lakebase tokens (not missing vars):

1. “CLI refresh token expired for profile(s): …”
2. Start `npm run auth:databricks`; human completes every listed browser login.
3. Re-run doctor.

---

## Target schema gate (mandatory before create-job)

After doctor is green (or in parallel once auth works), **ask**:

1. Confirm **catalog** for writes (usually source catalog).
2. Confirm **dev schema** name (draft default `semantic_migration_dev`).
3. Confirm **prod schema** name (draft default `business_semantics`).
4. Ask: **Do these schemas already exist, or do they need to be created?**
   - **Exist** → proceed; if deploy fails on missing schema, stop and ask again.
   - **Create** → list required grant `CREATE SCHEMA` on catalog; give SQL sketch:

```sql
CREATE SCHEMA IF NOT EXISTS <catalog>.<dev_schema>;
CREATE SCHEMA IF NOT EXISTS <catalog>.<prod_schema>;
-- then GRANT USAGE / CREATE TABLE to the migration user (admin)
```

5. Confirm source schema (e.g. `dbt_production`) is **read-only** — never a
   deploy target.

Write answers into `tmp-debug/scope-draft.json` before `cli:create-job`.

---

## Databricks permissions to grant (migration user)

Give this list to the human/admin when warehouses fail, deploy fails, or
on first onboarding:

| # | Grant / capability | Object | Needed for |
|---|-------------------|--------|------------|
| 1 | Use SQL warehouse | Chosen warehouse id | doctor, deploy, parity |
| 2 | `USE CATALOG` | Target catalog | All Unity Catalog work |
| 3 | `USE SCHEMA` + `SELECT` | Source schema / table | Discover inventory, parity |
| 4 | `USE SCHEMA` | Dev schema | Deploy + query metric views |
| 5 | `CREATE TABLE` (create/replace views & metric views) | Dev schema | `cli:deploy` |
| 6 | Modify/drop own views | Dev schema | Redeploy |
| 7 | `USE SCHEMA` + write (same as 4–6) | Prod schema | Only if publishing via approve |
| 8 | `CREATE SCHEMA` | Catalog | **Only if** creating new dest schemas |

Also: corporate VPN / TLS as needed; npm scripts use `--use-system-ca`.

Looker API user: see explores/dashboards/tiles for the source table.
OpenAI: generate access for one-shot draft.
Lakebase (if used): OAuth profile (e.g. `bhep`) can obtain DB password.

---

## Agent credentials gate (mandatory on every skill start)

**Do this before discover / create-job / draft / worker.**

### Security rules (non-negotiable)

- Never read, print, echo, or quote values from `.envs` / `.env.local`.
- Never ask the user to paste API keys, client secrets, PATs, or tokens into
  **chat**. Tell them to paste into `.envs` locally (IDE), then reply when
  done.
- Browser OAuth is always human-driven (`npm run auth:databricks`). You may
  start the command; you must wait for the human to finish the browser flow.
- Prefer presence / doctor output only (PASS/FAIL + remediation text).

### Step A — Soft prerequisites (no secrets)

Confirm, in order, and fix with the human before doctor:

1. Repo root is `viewReconciliationAgent` (has `package.json` + this skill).
2. `node_modules` exists → else `npm install`.
3. Databricks CLI installed → `databricks --version` (install if missing).
4. Env file exists → else run `cp .envs.example .envs` for them and say so.

### Step B — Run doctor (source of truth)

```bash
npm run cli:doctor
```

Parse PASS/FAIL lines. **If any FAIL, do not continue to migration work.**

### Step C — Guided fill loop (one gap cluster at a time)

For each failing check, **explicitly request** the missing credentials using
the checklist / request script above. Prefer **one cluster per turn**.
After they say **done**, re-run `npm run cli:doctor`.

| Doctor check | What to ask / tell the human | Where value comes from |
|--------------|------------------------------|------------------------|
| env file | Create `.envs` from example | Agent can `cp .envs.example .envs` |
| databricks host | Paste `DATABRICKS_HOST` into `.envs` (no trailing slash) | Their workspace URL |
| databricks auth (no profile/PAT) | Choose CLI vs PAT; set mode/profile or paste PAT into `.envs`; then browser login if CLI | Per-dev |
| databricks auth (expired token) | Run `npm run auth:databricks`; complete every profile in the browser | Browser OAuth |
| databricks warehouses | VPN on? Ask admin for warehouse **USAGE** + list grants above | Permissions / network |
| looker config / looker api | Paste `LOOKER_HOST`, `LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET` into `.envs` | Shared team vault |
| openai key | Paste `OPENAI_API_KEY` into `.envs` | Shared team vault |
| database (not configured) | Ask: **local Postgres** or **Lakebase**? Then only matching steps | Per-dev or shared |
| database (auth/token) | Usually Lakebase refresh expired → `npm run auth:databricks` | Browser OAuth |

### Step D — Schema + permissions confirmation

Even when doctor is all PASS:

1. Confirm catalog / `devSchema` / `prodSchema` (exist vs create).
2. If create: ensure `CREATE SCHEMA` grant; create schemas; re-confirm names.
3. Remind the Databricks grants table if deploy/warehouse previously failed.

### Step E — Ready gate

When doctor is **all PASS** (including warehouses) **and** schemas are
confirmed:

1. Tell the human they are **slash-ready / migration-ready**.
2. Briefly list what is configured (hosts / modes / schema names only —
   never secrets).
3. Ask what table to migrate (`catalog.schema.table`) or what job to resume.

If doctor still fails after two remediation cycles on the same check, stop and
escalate: paste the doctor FAIL lines + fix hints, ask for a human/admin.

### Optional: env key presence (names only)

If you need to know *which* keys are unset before doctor is informative, you
may run a **names-only** check (set vs missing / placeholder). Never print
values. Do not open `.envs` in the editor for the user in a way that dumps
secrets into the transcript.

## Agent rules for auth (ongoing)

- Browser logins are always done by the human. When doctor reports an auth
  failure, relay the printed fix command and wait.
- Never read, print, or echo values from `.envs`.
- Worker showing `fetch failed` mid-run usually means an expired CLI token:
  human runs `npm run auth:databricks`, then restart the worker.
- Missing dest schema at deploy → return to schema gate; do not invent names.

## Doctor remediation table

| Check | Failure means | Fix |
|-------|---------------|-----|
| env file | no `.envs`/`.env.local` | `cp .envs.example .envs`, fill values |
| database | DB unreachable or token expired | Local: `npm run db:up && npm run db:migrate`. Lakebase: `npm run auth:databricks` |
| looker config | missing LOOKER_* vars | Paste shared credentials into `.envs` from vault |
| looker api | bad credentials / network | Verify credentials current; check VPN |
| openai key | missing OPENAI_API_KEY | Paste shared key into `.envs` from vault |
| databricks host | missing DATABRICKS_HOST | Paste workspace URL into `.envs` |
| databricks auth | no PAT/profile or expired token | `npm run auth:databricks` or paste PAT into `.envs` |
| databricks warehouses | token OK but API fails | VPN/TLS (`npm run cli:*`), or admin warehouse + UC grants |

Corporate SSL inspection note: always run scripts through the npm aliases
(`npm run cli:*`) — they set `node --use-system-ca`, which raw
`npx tsx …` does not.

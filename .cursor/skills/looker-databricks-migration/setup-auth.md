# Setup and Authentication (skill CLI)

## One-time onboarding

1. Clone the repo, `npm install`.
2. Install Databricks CLI.
3. `cp .envs.example .envs` and fill values (`[PER-DEV]` vs `[SHARED]`).
4. `npm run auth:databricks` — browser login for the CLI profile.
5. `npm run cli:doctor` — must be all PASS.

No Postgres / Lakebase / Docker. No web UI OAuth app.

## Auth model

| Service | Scope | Mechanism |
|---------|-------|-----------|
| Databricks | Per-dev | `DATABRICKS_HOST` + CLI profile OAuth, or `DATABRICKS_TOKEN` |
| Looker | Shared | `LOOKER_HOST` / `LOOKER_CLIENT_ID` / `LOOKER_CLIENT_SECRET` |
| OpenAI | Shared | `OPENAI_API_KEY` |

## Target schema gate (before draft)

Always confirm with the human:

1. Catalog
2. Dev schema (deploy target)
3. Prod schema (publish target)
4. Create vs already exists
5. Never `dbt_production`

Write into `tmp-debug/scope-draft.json` before `cli:draft`.

## Agent credentials gate (every skill start)

### Security

- Never read/print/echo `.envs` values.
- Never ask the user to paste secrets into chat — edit `.envs` locally.
- Browser OAuth is human-driven (`npm run auth:databricks`).

### Steps

1. Soft prereqs: `node_modules`, `databricks --version`, `.envs` exists.
2. `npm run cli:doctor`
3. Guide one FAIL cluster at a time; re-doctor after each fix.
4. Confirm schemas.
5. Proceed to discover/draft.

| Doctor check | Coach the human |
|--------------|-----------------|
| env file | `cp .envs.example .envs` |
| databricks host / auth | Set host + profile; `npm run auth:databricks` |
| databricks warehouses | VPN / admin warehouse access |
| looker config / api | Add LOOKER_* from vault into `.envs` |
| openai key | Add `OPENAI_API_KEY` from vault into `.envs` |

## Doctor remediation

| Check | Fix |
|-------|-----|
| env file | `cp .envs.example .envs` |
| looker | Shared vault credentials |
| openai | Shared vault key |
| databricks host | Set `DATABRICKS_HOST` |
| databricks auth | `npm run auth:databricks` |
| warehouses | VPN / admin grants |

Always use `npm run cli:*` (sets `node --use-system-ca`).

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
5. `npm run cli:doctor` — must be all PASS before running migrations.

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

## Agent rules for auth

- Browser logins are always done by the human. When doctor reports an auth
  failure, relay the printed fix command and wait.
- Never read, print, or echo values from `.envs`.
- Worker showing `fetch failed` mid-run usually means an expired CLI token:
  human runs `npm run auth:databricks`, then restart the worker.

## Doctor remediation table

| Check | Failure means | Fix |
|-------|---------------|-----|
| env file | no `.envs`/`.env.local` | `cp .envs.example .envs`, fill values |
| database | DB unreachable or token expired | Local: `npm run db:up && npm run db:migrate`. Lakebase: `npm run auth:databricks` |
| looker config | missing LOOKER_* vars | Add shared credentials from vault |
| looker api | bad credentials / network | Verify credentials current; check VPN |
| openai key | missing OPENAI_API_KEY | Add shared key from vault |
| databricks host | missing DATABRICKS_HOST | Set your workspace URL in `.envs` |
| databricks auth | no PAT/profile or expired token | `npm run auth:databricks` |
| databricks warehouses | token OK but API fails | VPN/TLS issue (npm scripts pass `--use-system-ca`), or ask admin for warehouse access |

Corporate SSL inspection note: always run scripts through the npm aliases
(`npm run cli:*`) — they set `node --use-system-ca`, which raw
`npx tsx …` does not.

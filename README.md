# Looker → Databricks Migration Agent

Production-ready MVP for migrating Looker dashboards and explores into Databricks Unity Catalog semantic layers with automated reconciliation.

**Clone and run without public secrets:** see [SETUP.md](SETUP.md).  
**Cursor skill (team):** `.cursor/skills/looker-databricks-migration/` — OpenAI one-shot draft, local Cursor fix loop, edge-case repo.

## Architecture

```
app/
  api/
    auth/           # Databricks OAuth U2M with PKCE (user sign-in)
    looker/         # Looker 4.0 API (server-side client credentials)
    databricks/     # Unity Catalog, permissions, metric views
    migrations/     # Job CRUD, approval, publication
    worker/         # Background worker tick endpoint
  home-client.tsx   # Tabbed UI: Migration / Looker / Databricks
components/
  MigrationPanel    # Migration wizard, progress, approval
  LookerPanel       # Models, explores, dashboards, LookML files
  DatabricksPanel   # OAuth connect, catalog tree, permissions
lib/
  db/               # PostgreSQL client + migrations
  looker/           # Looker 4.0 API adapter
  databricks/       # OAuth, SQL warehouse, permissions
  migration/        # IR, inventory, comparator, jobs, worker
  openai/           # GPT-5.6 reconciliation (structured outputs)
scripts/
  worker.ts         # Durable background worker process
db/migrations/      # PostgreSQL schema
```

## Core flow

1. User signs in via Databricks OAuth (on-site U2M with PKCE)
2. App authenticates to BHEP Looker using server-side `LOOKER_CLIENT_ID` / `LOOKER_CLIENT_SECRET`
3. **Table-first:** user selects a Databricks source table + SQL warehouse, and sets
   - WRITE TO (dev): defaults to `semantic_migration_dev`
   - PUBLISH TO (prod): defaults to `business_semantics`
   - Dev schema is hard-blocked if it equals the source schema, prod schema, or `dbt_production`
4. App discovers Looker views/Explores/dashboard+Look tiles that reference the table (LookML `sql_table_name`, derived SQL, explore metadata, generated SQL)
5. User confirms migration units (Explores) and validation benchmarks (tiles) — nothing is assumed
6. Before generation, the worker captures immutable Looker benchmarks (query, filters, SQL, exact `json_bi`)
7. Reconciliation loop: inventory → baseline → generate → deploy_dev (SQL view then metric views) → test → diagnose → patch → repeat
8. `awaiting_approval` is allowed only when at least one real tile benchmark exists and every mandatory benchmark passes (synthetic smoke tests cannot prove parity)
9. User reviews parity report and explicitly approves production publication (never writes to `dbt_production`)

Legacy Looker-first (pick explore/dashboard first) remains available in the Migration tab.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Databricks OAuth app with redirect URI `http://localhost:3000/api/auth/callback`
- Looker API credentials (client ID + secret)
- OpenAI API key

## Environment variables

Create `.envs` or `.env.local`:

| Variable | Description |
|----------|-------------|
| `DATABRICKS_TENANT_HOST` | Workspace URL (no trailing slash) |
| `DATABRICKS_OAUTH_CLIENT_ID` | OAuth client ID |
| `DATABRICKS_OAUTH_CLIENT_SECRET` | OAuth client secret |
| `DATABRICKS_OAUTH_REDIRECT_URI` | Must match OAuth app registration |
| `SESSION_SECRET` | Random string, ≥ 32 characters |
| `LOOKER_HOST` | BHEP Looker instance URL |
| `LOOKER_CLIENT_ID` | Looker API client ID |
| `LOOKER_CLIENT_SECRET` | Looker API client secret |
| `OPENAI_API_KEY` | OpenAI API key for reconciliation |
| `DATABASE_URL` | PostgreSQL connection string |
| `WORKER_POLL_MS` | Worker poll interval (default 5000) |

## Run locally

```bash
npm install

# Start PostgreSQL and set DATABASE_URL (or use Lakebase via .envs), then:
npm run db:migrate

# One command: Databricks CLI auth (browser if needed) + Next.js + worker
# Scripts use Node --use-system-ca so corporate VPN/SSL inspection works on Windows.
npm run start:local
```

Or run pieces separately:

```bash
# Refresh Databricks CLI tokens only (when worker shows "fetch failed")
npm run auth:databricks

# Terminal 1: web app
npm run dev

# Terminal 2: background worker
npm run worker
```

Open [http://localhost:3000](http://localhost:3000).

If the UI shows CLI auth expired, run `npm run auth:databricks`, restart the worker, then click **Re-check auth** on the Databricks tab.

If warehouses/catalogs stay empty but auth looks connected, check the red error under **SQL warehouse** — corporate SSL inspection often needs a restart with the updated npm scripts (they pass `--use-system-ca`). Then click **Retry loading warehouses**.

## Security

- Looker, OpenAI, and Databricks secrets are server-side only
- Tokens stored in encrypted httpOnly cookies (iron-session)
- Credentials and raw datasets are never sent to OpenAI
- Candidate writes restricted to the job's dev schema
- Production publication requires explicit user approval
- Portfolio-company authorization should be applied at the app layer (Looker API credentials represent one API user)

## Tests

```bash
npm test
```

Unit tests cover the deterministic comparator (integers, decimals, row ordering, timezone normalization).

## Reconciliation loop

The worker processes jobs through:

`inventory → baseline → generate → validate → deploy_dev → test → compare → diagnose → patch → repeat → awaiting_approval → publish`

Every iteration records model version, diagnosis, SQL/YAML diffs, test results, and rationale in PostgreSQL.

## Not yet implemented

- Multi-tenant registry (design supports extension via `tenant_id`)
- Portfolio-company authorization UI
- Unity Catalog row filters / functions deployment
- Full Liquid/`filter_expression` → Databricks translation (basic Looker filters are applied; advanced Liquid remains unsupported)
- Exhaustive Looker project crawl beyond the first 500 LookML files / 100 dashboards

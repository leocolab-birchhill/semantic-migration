---
name: looker-databricks-migration
description: >-
  Operates the Looker-to-Databricks migration skill CLI: OpenAI one-shot YAML
  draft plus per-table parity under migrations/, then local Cursor repair
  against Databricks feedback with an accumulating cases/ edge-case repo.
  Filesystem-only — no job database or web app. Use when working in
  viewReconciliationAgent, Looker explores/tiles, metric views, parity
  failures, or semantic layer migration. On every invocation, state
  requirements then run the credentials/schema gate before discover/draft.
disable-model-invocation: true
---

# Looker → Databricks Migration (skill CLI)

OpenAI drafts **once**. You (local Cursor) own **all repair** using
`harness/last-run.json` + `cases/`. Never call OpenAI diagnose.

Artifacts are files under `migrations/<catalog.schema.table>/`. There is **no
Postgres job DB** and **no web app**.

## First action on every invocation

**Stop. Do not run discover / draft / deploy yet.**

1. **State requirements** (below).
2. Soft prereqs → `npm run cli:doctor` → missing credentials → confirm target
   schemas.
3. Only when doctor is green **and** schemas are confirmed → ask for
   `catalog.schema.table`.

Full protocol: [setup-auth.md](setup-auth.md).

---

## Requirements (state these first)

### A — Credentials (edit `.envs`, never paste secrets into chat)

| Cluster | Variables | Source |
|---------|-----------|--------|
| Databricks | `DATABRICKS_HOST`, `DATABRICKS_AUTH_MODE=cli`, `DATABRICKS_CLI_PROFILE` (or `DATABRICKS_TOKEN`) | `[PER-DEV]` |
| Looker | `LOOKER_HOST`, `LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET` | `[SHARED]` vault |
| OpenAI | `OPENAI_API_KEY` | `[SHARED]` vault |

For each missing cluster: name the variables, tell the human to paste into
`.envs` (not chat), reply **done**. Expired CLI tokens →
`npm run auth:databricks` (wait for every browser profile).

### B — Databricks target schemas (confirm before draft)

1. **Catalog** (usually same as source)
2. **Dev schema** (default `semantic_migration_dev`)
3. **Prod schema** (default `business_semantics`) — publish only
4. Exist already vs need create?
5. Never write to `dbt_production`

Write confirmed names into `tmp-debug/scope-draft.json`
(`databricks.devSchema` / `databricks.prodSchema`).

### C — Permissions

| Privilege | On |
|-----------|-----|
| Use SQL warehouse | Chosen warehouse |
| `USE CATALOG` | Target catalog |
| `USE SCHEMA` + `SELECT` | Source schema/table |
| `USE SCHEMA` + create views/metric views | Dev (and prod if publishing) |
| `CREATE SCHEMA` | Catalog — only if creating dest schema |

---

## Check gate

1. `node_modules`, Databricks CLI, `.envs` from `.envs.example`
2. `npm run cli:doctor` until all PASS
3. Schema confirmation (section B)
4. Ask for `catalog.schema.table`

## Core workflow

```
requirements → doctor → confirm schemas
  → discover → human edits scope (warehouse, include flags, schemas)
  → draft (OpenAI once) → deploy → parity
  → fail? patch draft/ + edge-case note → deploy → parity
  → pass? human cli:publish --confirm
```

```bash
npm run cli:doctor
npm run cli:discover -- <catalog>.<schema>.<table>
# edit tmp-debug/scope-draft.json
npm run cli:draft -- --scope tmp-debug/scope-draft.json
npm run cli:deploy -- <catalog.schema.table>
npm run cli:parity -- <catalog.schema.table>
npm run cli:publish -- <catalog.schema.table> --confirm
```

## Local fix loop

When `cli:parity` exits non-zero (`harness/last-run.json` status `needs_fix`):

1. Read `migrations/<table>/harness/last-run.json`
2. Read [cases/README.md](../../../cases/README.md) + table `edge-cases/`
3. Patch `draft/sql_view.sql` and/or `draft/metric_view.yaml`
4. `npm run cli:deploy -- <tableKey>` then `npm run cli:parity -- <tableKey>`
5. Append `migrations/<table>/edge-cases/NNN-*.md`; promote to `cases/` if reusable
6. Remind human to **commit/PR** case notes for team learning (not auto-pushed)
7. When green → `npm run cli:publish -- <tableKey> --confirm`

## Hard rules

- Never OpenAI diagnose / repair loops.
- Never write to `dbt_production`; publish only via explicit `--confirm`.
- Correctness = parity gates + Looker benchmarks, not generation.
- Never read/print `.envs` secrets; never collect secrets in chat.
- Always confirm dev/prod schema names before draft.

## References

- [setup-auth.md](setup-auth.md)
- [operations.md](operations.md)
- [debugging.md](debugging.md)
- [verification.md](verification.md)
- [translation-guide.md](translation-guide.md)
- [edge-cases.md](edge-cases.md)

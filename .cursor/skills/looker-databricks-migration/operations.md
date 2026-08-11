# Operations Reference

## Preflight (every session)

1. State requirements (credentials → target schemas → Databricks grants).
2. `npm run cli:doctor` until all PASS; request missing creds into `.envs`
   (never into chat).
3. Human confirms catalog + `devSchema` + `prodSchema` (exist vs create).
4. Then discover / create-job. See [setup-auth.md](setup-auth.md).

## CLI commands

| Command | Purpose |
|---------|---------|
| `npm run cli:doctor` | Preflight (DB, Looker, OpenAI, Databricks auth/warehouses) |
| `npm run cli:discover -- <cat>.<sch>.<table>` | Looker discovery → `tmp-debug/scope-draft.json` |
| `npm run cli:create-job -- --scope <file>` | Create table_scope job |
| `npm run cli:draft -- --job <id>` \| `--scope <file>` | OpenAI **one-shot** draft → `migrations/<table>/` |
| `npm run cli:deploy -- <tableKey>` \| `--job <id>` | Deploy `draft/` to Databricks dev schema |
| `npm run cli:parity -- --job <id>` | Looker↔Databricks parity → `harness/last-run.json` |
| `npm run cli:job -- [id] [--watch\|--rerun]` | Status / watch / clone job |
| `npm run cli:approve -- <id> [--publish] --confirm` | Approve / publish (human) |
| `npm run worker` | Background worker (generate once; pause for local fix on failure) |
| `npm run auth:databricks` | Human browser login for CLI profiles |
| `npm test` | Unit + golden tests |

## Artifact layout

```
migrations/<catalog.schema.table>/
  draft/sql_view.sql
  draft/metric_view.yaml
  draft/field_mappings.json
  harness/parity.config.json
  harness/last-run.json
  edge-cases/
cases/                          # shared library
```

## Job statuses (local-fix era)

| Status | Meaning | Next |
|--------|---------|------|
| `running` | Inventory / baseline / generate / deploy / test | Watch |
| `needs_input` | OpenAI draft done; parity/deploy failed — **local Cursor fix** | Edit draft → deploy → parity |
| `awaiting_approval` | Mandatory tiles passed | Human approve |
| `approved` / `published` | Ready / live in prod schema | — |
| `failed` | Exhausted or unrecoverable | Dump, new job |

Worker no longer runs OpenAI diagnose iterations. Deterministic repairs only
(format strip, unresolved column rewrite, COALESCE null↔0, source repoint).

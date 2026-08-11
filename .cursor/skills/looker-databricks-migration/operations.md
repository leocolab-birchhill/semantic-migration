# Operations Reference

## CLI commands

| Command | Purpose |
|---------|---------|
| `npm run cli:doctor` | Preflight (Looker, OpenAI, Databricks auth/warehouses) |
| `npm run cli:discover -- <cat>.<sch>.<table>` | Looker discovery → `tmp-debug/scope-draft.json` |
| `npm run cli:draft -- --scope <file>` | OpenAI **one-shot** draft → `migrations/<table>/` |
| `npm run cli:deploy -- <tableKey>` | Deploy `draft/` to Databricks **dev** schema |
| `npm run cli:parity -- <tableKey>` | Looker↔Databricks parity → `harness/last-run.json` |
| `npm run cli:publish -- <tableKey> --confirm` | Publish draft to **prod** schema (parity must be green) |
| `npm run auth:databricks` | Human browser login for CLI profile |
| `npm test` | Unit + golden tests |

## Artifact layout

```
migrations/<catalog.schema.table>/
  scope.json
  inventory.json          # gitignored
  draft/sql_view.sql
  draft/metric_view.yaml
  draft/field_mappings.json
  harness/parity.config.json
  harness/last-run.json   # gitignored; status needs_fix | ready_to_publish | published
  edge-cases/
cases/                    # shared library — commit to share
```

## Statuses (filesystem)

| `last-run.json` status | Meaning | Next |
|------------------------|---------|------|
| `needs_fix` | Parity failed | Patch draft → deploy → parity; write edge-case |
| `ready_to_publish` | Mandatory tiles passed | `cli:publish --confirm` |
| `published` | Prod deploy done | Done |

## Onboarding order

1. Credentials gate + doctor
2. Confirm schemas
3. Discover → draft → deploy → parity → publish

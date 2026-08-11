# Operations Reference

## CLI commands

| Command | Purpose |
|---------|---------|
| `npm run cli:doctor` | Preflight (Looker, OpenAI, Databricks auth/warehouses) |
| `npm run cli:inventory` | Environment inventory + dependency graph → `tmp-debug/` |
| `npm run cli:plan` | Propose atomic components → `component-plan.yaml` (wait for approval) |
| `npm run cli:discover -- <cat>.<sch>.<table>` | Looker discovery → `tmp-debug/scope-draft.json` |
| `npm run cli:draft -- --scope <file>` | OpenAI **one-shot** draft → `migrations/<table>/` |
| `npm run cli:deploy -- <tableKey>` | Deploy `draft/` to Databricks **dev** schema |
| `npm run cli:parity -- <tableKey>` | Looker↔Databricks parity → `harness/last-run.json` |
| `npm run cli:publish -- <tableKey> --confirm` | Publish draft to **prod** schema (parity must be green) |
| `npm run auth:databricks` | Human browser login for CLI profile |
| `npm test` | Unit + golden tests |

### Inventory / plan flags

```bash
npm run cli:inventory -- --project gdi --model gdi --max-explores 40
npm run cli:plan -- --scope-mode consumer-parity
npm run cli:plan -- --both-scopes
```

## Artifact layout

```
tmp-debug/
  inventory.json
  dependency-graph.json
  dependency-graph.mmd
  component-plan.yaml
  chat-graph-domain.mmd
  component-graphs/<id>.mmd
  scope-draft.json          # after approved discover

migrations/<catalog.schema.table>/
  scope.json
  inventory.json          # gitignored (per-table IR)
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
3. **Inventory → plan → human component approval**
4. Discover → draft → deploy → parity → publish (approved components only)

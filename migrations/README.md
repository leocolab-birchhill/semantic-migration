# migrations/

Per-table OpenAI draft + local Cursor fix artifacts.

Created automatically by the worker (after generate) or by:

```bash
npm run cli:draft -- --scope tmp-debug/scope-draft.json
# or
npm run cli:draft -- --job <jobId>
```

Layout:

```
migrations/<catalog.schema.table>/
  README.md
  scope.json
  inventory.json
  draft/
    sql_view.sql
    metric_view.yaml
    field_mappings.json
    assets.json
  harness/
    parity.config.json
    parity.ts          # pointer to npm run cli:parity
    last-run.json      # written by cli:parity
  edge-cases/          # Cursor must append notes after each fix
```

Do not commit secrets. Inventory may contain Looker SQL — review before
pushing if your org treats that as sensitive.

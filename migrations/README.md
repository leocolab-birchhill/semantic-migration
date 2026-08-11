# migrations/

Per-table OpenAI draft + local Cursor fix artifacts (filesystem-only).

```bash
npm run cli:draft -- --scope tmp-debug/scope-draft.json
```

Layout:

```
migrations/<catalog.schema.table>/
  README.md
  scope.json
  inventory.json       # gitignored
  draft/
    sql_view.sql
    metric_view.yaml
    field_mappings.json
    assets.json
  harness/
    parity.config.json
    last-run.json      # gitignored; written by cli:parity
  edge-cases/          # append notes after each fix; promote reusable to cases/
```

Do not commit secrets. Inventory may contain Looker SQL — review before
pushing if your org treats that as sensitive.

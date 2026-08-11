# Migration: databricks_prd.dbt_production.fct_tam_buildings

Artifacts for the OpenAI one-shot draft → local Cursor fix loop.

- `draft/` — SQL view + metric-view YAML (edit these when fixing)
- `harness/parity.config.json` — tile benchmarks + knobs
- `harness/last-run.json` — latest parity diffs / SQL errors
- `edge-cases/` — lessons from Cursor fixes for this table

Commands:

```bash
npm run cli:deploy -- databricks_prd.dbt_production.fct_tam_buildings
npm run cli:parity -- databricks_prd.dbt_production.fct_tam_buildings
```

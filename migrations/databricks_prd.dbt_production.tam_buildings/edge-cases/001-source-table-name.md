# 001 — Source table is fct_tam_buildings

## Symptom
Deploy failed: `TABLE_OR_VIEW_NOT_FOUND` for `databricks_prd.dbt_production.tam_buildings`.

## Cause
Migration key / user shorthand used `tam_buildings`, but Looker explore
`sql_table_name` and Unity Catalog both point at `fct_tam_buildings`.

## Fix
Point `draft/sql_view.sql` and `draft/assets.json` `FROM` at
`databricks_prd.dbt_production.fct_tam_buildings`. Deploy reads
`assets.json` first when present. Keep artifact key as
`databricks_prd.dbt_production.tam_buildings` for continuity with discover scope.

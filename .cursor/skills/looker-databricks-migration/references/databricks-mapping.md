# Databricks mapping guidance

## Stop conditions for upstream closure

Stop traversing when you hit:

- An existing `databricks_asset` node (`maps_to` / known table/view/metric view)
- An approved shared foundation component interface
- An explicitly deferred external dependency

## After component approval

Map each approved component to execution artifacts:

1. Identify primary `source_assets` (catalog.schema.table)
2. Run existing `cli:discover` for those tables (preserves auth + parity path)
3. Restrict scope draft explores/tiles to the component’s
   `root_explores` / `selected_consumers`
4. `cli:draft` → `cli:deploy` → `cli:parity` → `cli:publish --confirm`

## Target conventions

| Looker | Databricks |
|--------|------------|
| Explore semantic contract | Metric view (+ staging SQL view) |
| Joins | Staging SQL view LEFT JOINs |
| Access grants / user attrs | Row filters / policies (confirm with human) |
| Derived tables / PDTs | Tables/views or materialized equivalents |
| Consumer tiles | Parity benchmarks |

## Do not

- Write to `dbt_production`
- Publish without `--confirm` and green parity
- Assume name-only equality between Looker fields and Databricks columns —
  use field mappings + semantic evidence

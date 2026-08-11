# Edge case: explore SQL population filters + non-null party names

## Symptom
Customer-adjusted TAM measures were systematically high vs Looker
(e.g. Warehouse/Distribution buildings 109739 vs 87375).

## Databricks / Looker evidence
Looker benchmark SQL WHERE includes explore filters:
- at least one of property_manager_name / key_tenant_name / owner_name /
  cust_parent_customer is non-null (`LIKE '%'` — NULLs fail)
- `property_id <> '10630US'`
- `coalesce(sector,'') <> 'Residential'`
- `outside_geographic_tam = 'F'`
- `building_rba IS NULL OR building_rba >= 20000`

Plus `in_extended_tam_scope_flag` at threshold 100000.

## Root cause
Draft SQL view selected the raw table without the explore population
predicate. Scope-flag logic alone is not enough.

## Patch
Rebuild `draft/sql_view.sql` with those filters and materialize
`in_extended_tam_scope_flag_default`; measures reference that column.

## Prevention
When Looker generated SQL shows explore WHERE clauses shared across
tiles, bake them into the staging sql_view before parity.

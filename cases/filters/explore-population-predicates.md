# Explore population filters in staging SQL

## Symptom
Customer-adjusted measures systematically higher than Looker after scope-flag
logic alone is correct.

## Root cause
Looker explore SQL applies a shared WHERE (non-null party-name fields via
`LIKE '%'`, exclude Residential / outside geo / outlier property_id, RBA
threshold). Omitting it from the staging sql_view overstates TAM population.

## Patch
Bake Looker explore WHERE into `draft/sql_view.sql` and materialize
`in_extended_tam_scope_flag_default` for measures.

## Prevention
Diff Looker `jsonBi.sql` WHERE across tiles before first parity; shared
predicates belong on the sql_view.

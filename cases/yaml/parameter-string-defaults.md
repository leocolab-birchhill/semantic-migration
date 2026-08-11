# STRING parameter defaults need SQL quotes

## Symptom
Metric-view deploy fails with `METRIC_VIEW_INVALID_VIEW_DEFINITION`:
parameter default must be a constant expression (e.g. got `CAD`).

## Root cause
Databricks evaluates parameter `default` as SQL. Bare tokens are
identifiers; STRING literals must be SQL-quoted inside the YAML scalar
(`default: "'CAD'"`). Numeric defaults stay bare.

## Patch
Set STRING parameter defaults to `"'value'"` in metric-view YAML before
deploy. Optionally harden `deploy-normalize` / draft prompt to do this
automatically.

## Prevention
When emitting `parameters:` with `data_type: STRING`, always SQL-quote
`default`.

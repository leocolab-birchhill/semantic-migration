# Looker 0 vs Databricks null on empty aggregates

## Symptom
Mandatory tile fails only on measures where Looker shows `0` and Databricks
shows `null` (empty groups).

## Root cause
Looker returns 0 for empty aggregate groups; Databricks `MEASURE()` returns
null.

## Patch
Wrap sum/count-style measure exprs with `COALESCE(expr, 0)` in metric-view
YAML (or rely on worker deterministic coalesce repair). Prefer staging in
draft YAML for permanence.

## Prevention
Generate prompt rule + `applyNullZeroCoalesceRepair` in worker.

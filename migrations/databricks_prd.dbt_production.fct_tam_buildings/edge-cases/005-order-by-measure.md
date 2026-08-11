# Edge case: ORDER BY measure omitted from SELECT

## Symptom
Parity SQL error `UNRESOLVED_COLUMN` for sort field `buildings_count` while
SELECT only had `MEASURE(buildings_count_customer_adjusted)`.

## Root cause
Looker tiles often sort by a measure missing from explore inventory (dropped
from `expectedColumns` / SELECT) but still listed in `sorts`. Bare
`ORDER BY \`buildings_count\`` fails; `ORDER BY MEASURE(...)` is required
**only when the sort key is not already projected**. Wrapping an already-
selected measure alias in MEASURE() is invalid
(`METRIC_VIEW_INVALID_MEASURE_FUNCTION_INPUT`).

## Patch (engine)
- `lib/migration/query-builder.ts` — `ORDER BY MEASURE()` iff sort measure
  is absent from SELECT; otherwise order by alias
- `lib/migration/field-mapping.ts` — include sort measure names in
  `measureNames` even when omitted from SELECT

## Prevention
Unit coverage for both cases: sort measure in SELECT vs sort-only measure.

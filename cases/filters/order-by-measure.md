# ORDER BY measure omitted from SELECT

## Symptom
`UNRESOLVED_COLUMN` on a sort measure, or
`METRIC_VIEW_INVALID_MEASURE_FUNCTION_INPUT` if every measure sort is wrapped
in MEASURE().

## Root cause
Looker may sort by a measure dropped from SELECT (out of inventory). Bare
ORDER BY fails; MEASURE(alias) is also invalid when the measure is already
selected.

## Patch (engine)
`buildMetricViewSelect`: ORDER BY MEASURE() only when the sort measure is
not in SELECT; otherwise order by the projected alias. Include sort measures
in `measureNames` during compile.

## Prevention
Unit tests for sort-in-SELECT vs sort-only measure keys.

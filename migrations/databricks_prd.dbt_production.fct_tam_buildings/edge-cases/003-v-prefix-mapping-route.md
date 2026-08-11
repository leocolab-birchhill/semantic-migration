# Edge case: V_ prefix breaks explore→metric-view routing

## Symptom
After renaming deployed assets to `V_skill_test_*`, parity reported
`unmapped_looker_field` for measures that clearly existed in
`draft/field_mappings.json`.

## Root cause
Test cases prefer `suggestMetricViewName(explore)` (`tam_buildings`).
`findMappingForLookerField` exact-matches `metricViewName`;
`coerceMetricViewName` only accepts `explore`, `explore_*`, or `*_explore`
shapes — a `V_skill_test_` prefix does not coerce.

## Patch
Keep Databricks object names as `V_skill_test_*` (deployed FQNs).
Keep mapping `metricViewName` as the explore name `tam_buildings` so
routing resolves; single metric-view inventory coerces SQL `FROM` to the
prefixed asset.

## Prevention
If test naming prefixes are required, teach coerce/findMapping about an
explicit `assetName` vs `routingName`, or pass preferred from harness
deployed name.

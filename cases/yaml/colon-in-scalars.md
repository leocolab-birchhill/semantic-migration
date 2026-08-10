# Colons in YAML metadata scalars

## Symptom
Metric-view deploy / YAML parse fails when `display_name` or `comment`
contains unquoted colons (e.g. `Matched: Excluded`).

## Root cause
Nested YAML mapping parse — metadata scalars with `:` must be quoted.

## Patch (engine)
`lib/migration/deploy-normalize.ts` — `quoteYamlMetadataScalars`.

## Prevention
Golden / unit tests in `tests/deploy-normalize.test.ts`.

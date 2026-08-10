# Null ≡ empty string in comparator keys

## Symptom
Parity shows mismatches on rows that look identical; UI showed `□` vs blank;
totals match when summed but keyed compare fails.

## Root cause
Looker emits both `null` and `""` for missing dims. Databricks JSON may
collapse blanks. Naive Map last-write-wins paired wrong measure values.

## Patch (engine)
`lib/migration/comparator.ts` — `normalizeKeyPart` / `isBlankDimValue`,
duplicate-key sum-collapse via `buildKeyedRowMap`.

## Prevention
Do not "fix" this in YAML. Keep comparator identity rules; add golden/
unit tests under `tests/comparator.test.ts`.

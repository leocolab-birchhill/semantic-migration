# NULL + comparison filter lists

## Symptom
`CAST_INVALID_INPUT` when a dashboard filter is `building_rba: "NULL,>=20000"`
(or similar). Wrong SQL becomes `IN ('NULL','>=20000')`.

## Root cause
Looker filter grammar: comma lists mix NULL, comparisons, and literals.
Must compile to `col IS NULL OR col >= 20000`, not string IN.

## Patch (engine)
`lib/migration/query-builder.ts` — `lookerFilterToSql` positive-token
handling for NULL and `>=`/`<=` in lists.

## Prevention
Golden fixture: `tests/golden/fixtures/filter-grammar.json`.

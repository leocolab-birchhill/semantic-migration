# Edge case: passthrough scaffold missing from draft YAML

## Symptom
Parity compile errors: unmapped Looker fields like `fct_tam_buildings.sector`,
`account`, `owner_name`, etc. Metric view had only ~10 semantic dimensions;
simple `${TABLE}.col` passthroughs were absent.

## Databricks / Looker evidence
`harness/last-run.json` compilationFailures with `[unmapped_looker_field]`
for tile dimensions that are plain source columns in LookML.

## Root cause
`scaffoldPassthroughDimensions` + `mergeScaffoldIntoAssets` should append
these after OpenAI generate. The written draft lacked them (only LLM
non-passthrough dims remained), so tile compilation could not map filters/
group-bys.

## Patch
Re-ran scaffold merge locally against `inventory.json` into
`V_skill_test_tam_buildings`, then redeployed.

## Prevention
After `cli:draft`, assert primary metric view dimension count includes
scaffolded passthrough bare names (e.g. `sector`) before deploy/parity.

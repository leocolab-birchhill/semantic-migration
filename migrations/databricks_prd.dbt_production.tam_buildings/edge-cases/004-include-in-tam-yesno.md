# 004 — include_in_tam_* yesno filters

## Symptom
Parity compile error: unmapped filter fields
`include_in_tam_owner`, `include_in_tam_property_manager`,
`include_in_tam_key_tenant`.

## Fix
Add metric-view dimensions that map boolean source columns to Looker
`Yes`/`No` strings, plus field_mappings entries.

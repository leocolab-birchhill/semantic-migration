# 003 — Bake Looker explore WHERE into staging SQL

## Symptom
Customer-adjusted measures systematically higher than Looker (e.g. buildings
87375 Looker vs 109739 Databricks by sector).

## Cause
Explore `gdi.tam_buildings` applies a shared WHERE (party-name LIKE '%',
exclude property_id 10630US / Residential / outside geo, RBA >= 20k or null).
Draft staging view omitted it.

## Fix
Add the explore predicates to `draft/sql_view.sql` (and `assets.json`).
See `cases/filters/explore-population-predicates.md`.

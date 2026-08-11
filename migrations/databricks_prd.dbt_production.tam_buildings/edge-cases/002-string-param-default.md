# 002 — STRING parameter default needs SQL quotes

## Symptom
Deploy: `METRIC_VIEW_INVALID_VIEW_DEFINITION` — Parameter 'currency'
default value must be a constant expression, got: cad.

## Fix
In `draft/metric_view.yaml` (+ `assets.json`): `default: "'cad'"`.
See `cases/yaml/parameter-string-defaults.md`.

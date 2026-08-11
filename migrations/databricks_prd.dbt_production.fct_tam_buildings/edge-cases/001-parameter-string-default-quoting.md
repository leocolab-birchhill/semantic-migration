# Edge case: STRING parameter defaults need SQL quotes

## Symptom
Deploy of `V_skill_test_tam_buildings` failed with:
`METRIC_VIEW_INVALID_VIEW_DEFINITION` — Parameter `currency_selector`
default value must be a constant expression, got: `CAD`.

## Databricks / Looker evidence
```
Reason: Parameter 'currency_selector' default value must be a constant
expression, got: CAD. To declare a literal string default, SQL-quote the
value inside the YAML scalar (e.g. default: "'foo'").
```

## Root cause
Databricks metric-view parameters evaluate `default` as a SQL expression.
Bare `CAD` is an identifier, not a string literal. STRING defaults must be
emitted as `"'CAD'"` (YAML scalar containing SQL-quoted text).

## Patch
In `draft/metric_view.yaml` (and synced `draft/assets.json`):
```yaml
parameters:
  - name: currency_selector
    data_type: STRING
    default: "'CAD'"
```
BIGINT defaults (e.g. `100000`) stay bare numeric literals.

## Prevention
Promote to `cases/yaml/parameter-string-defaults.md`. Prefer teaching the
draft prompt / deploy-normalize to SQL-quote STRING parameter defaults.

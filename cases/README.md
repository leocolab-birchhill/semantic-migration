# Edge-case library

Shared lessons from Looker → Databricks migration fixes. The Cursor agent
**must read this index** before patching draft YAML/SQL after a parity failure.

Per-table notes live under `migrations/<catalog.schema.table>/edge-cases/`.
Promote a case here when the lesson is reusable across tables.

## Index

| Symptom | Case |
|---------|------|
| null vs empty-string row keys / false mismatches | [comparator/null-empty-keys.md](comparator/null-empty-keys.md) |
| `CAST_INVALID_INPUT` from filters like `NULL,>=20000` | [filters/null-comparison-lists.md](filters/null-comparison-lists.md) |
| YAML deploy crash on colons in display_name | [yaml/colon-in-scalars.md](yaml/colon-in-scalars.md) |
| Looker 0 vs Databricks null on aggregates | [currency/null-vs-zero-aggregates.md](currency/null-vs-zero-aggregates.md) |

## How to add a case

Copy `_TEMPLATE.md` into the right folder, fill every section, link it from
this index. Prefer a failing golden fixture in `tests/golden/` when the fix
is deterministic (scaffold / filter compiler / comparator).

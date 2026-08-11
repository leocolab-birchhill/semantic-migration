# Edge-case repo rules

The edge-case library is how the local Cursor model gets better over time.

## Locations

| Path | Purpose |
|------|---------|
| `cases/` | Shared, reusable lessons (indexed in `cases/README.md`) |
| `migrations/<table>/edge-cases/` | Table-specific notes from this migration |
| `tests/golden/fixtures/` | Executable regressions for deterministic translators |

## After every successful local fix

1. Copy `cases/_TEMPLATE.md` → `migrations/<table>/edge-cases/NNN-short-slug.md`
2. Fill symptom, Databricks/Looker evidence, root cause, patch, prevention
3. If the lesson applies to other tables: add under `cases/<area>/` and link from `cases/README.md`
4. If the bug was in deterministic code (comparator, filter compiler, scaffold, YAML normalizer): add/adjust a golden or unit test in the **same change**
5. **Commit and open a PR** — nothing auto-pushes `cases/` to main; teammates only learn on `git pull`

## What not to put in cases/

- Secrets, PATs, full `.envs`
- Entire inventory dumps (point at `harness/last-run.json` excerpts instead)
- OpenAI prompt paste dumps

## Agent checklist before patching draft YAML

```
- [ ] Read cases/README.md index for matching symptom
- [ ] Read this table's edge-cases/ folder
- [ ] Read translation-guide.md hard rules (source-only exprs, naming, COALESCE)
- [ ] Prefer fixing draft/ over changing comparator unless evidence shows engine bug
```

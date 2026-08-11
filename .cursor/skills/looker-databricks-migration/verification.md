# Verification

LLM output is never trusted — proven against captured Looker benchmarks.

## Gates

1. **Immutable Looker benchmarks** (`json_bi`) captured before generate
2. **Deterministic comparator** (`lib/migration/comparator.ts`)
3. **`cli:parity`** — every mandatory tile must pass (`harness/last-run.json`)
4. **Human publish** — `cli:publish --confirm` (requires green parity unless `--force`)

## Two regimes

| Layer | Guarantee |
|-------|-----------|
| Deterministic (scaffold, filters, YAML normalize, comparator) | Provable via `npm test` + `tests/golden/` |
| OpenAI one-shot draft | Unguaranteed; proven only by parity |

## Local fix does not weaken gates

Cursor may edit `draft/` freely, but publish still requires mandatory
benchmarks green. After each fix, add an edge-case note and, for engine bugs,
a golden/unit test. Commit/PR `cases/` updates for team learning.

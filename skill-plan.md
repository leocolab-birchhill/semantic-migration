# OpenAI Draft + Local Cursor Fix Loop

## Goal

Restructure the Looker→Databricks migration skill so **OpenAI drafts once**
(YAML + SQL + parity harness config) and the **local Cursor model owns all
repair**, using Databricks CLI/API feedback and an accumulating edge-case
repo. The worker's OpenAI diagnose/repair loop is removed.

## Architecture

```
doctor → discover → confirm scope → create-job → worker
  → OpenAI generate (once) → migrations/<table>/draft + harness
  → deploy + parity
  → pass → awaiting_approval
  → fail → needs_input → Cursor patches draft → cli:deploy → cli:parity
  → write edge-case note → repeat until green → human approve
```

## Auth

- **Databricks:** per-dev `DATABRICKS_HOST` + CLI profile (`npm run auth:databricks`)
- **Looker / OpenAI:** shared team credentials in `.envs` (never committed)

## Division of labor

- **OpenAI:** one-shot `generateDatabricksAssets` only
- **Cursor local model:** classify failures, patch `draft/`, run deploy/parity, grow `cases/` and `migrations/*/edge-cases/`
- **Human:** auth, scope confirmation, approve/publish

## Key paths

| Path | Role |
|------|------|
| `lib/migration/worker.ts` | Generate once; deterministic repairs only; pause `needs_input` for local fix |
| `lib/migration/repo-artifacts.ts` | Write/read `migrations/<table>/` |
| `scripts/cli/draft.ts` | Headless OpenAI draft |
| `scripts/cli/deploy.ts` | Deploy draft to Databricks |
| `scripts/cli/parity.ts` | Parity oracle → `harness/last-run.json` |
| `cases/` | Shared edge-case library |
| `.cursor/skills/looker-databricks-migration/` | Skill playbook |

## Harness design

OpenAI fills `harness/parity.config.json` (tiles, knobs). The runner is the
fixed `cli:parity` script (not free-form LLM-generated executables).

## Out of scope

- Local models inside the worker process
- OpenAI diagnose loop
- Multi-workspace switching per job (still per-dev `.envs`)

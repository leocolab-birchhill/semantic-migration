---
name: looker-databricks-migration
description: >-
  Operates the Looker-to-Databricks migration pipeline: OpenAI one-shot YAML
  draft plus per-table parity harness, then local Cursor repair against
  Databricks CLI/API feedback with an accumulating edge-case repo. Use when
  working in viewReconciliationAgent, migration jobs, Looker explores/tiles,
  metric views, parity failures, or semantic layer migration.
---

# Looker → Databricks Migration (OpenAI draft + local fix)

OpenAI drafts **once**. The local Cursor model owns **all repair**, using
Databricks CLI/API feedback and the edge-case repo. Never call OpenAI diagnose.

## Division of labor

| Actor | Does | Does not |
|-------|------|----------|
| **OpenAI** (worker / `cli:draft`) | One-shot metric-view YAML + SQL + harness config after reading inventory/dependencies | Diagnose, iterative patches |
| **You (Cursor local model)** | Read `harness/last-run.json`, consult `cases/`, patch `draft/`, deploy+parity, write edge-case notes | Author the first draft; invent credentials |
| **Human** | Browser auth (`npm run auth:databricks`), confirm scope, approve/publish | — |

## Core workflow

```
doctor → discover → human confirms scope → create-job → worker
  → OpenAI generate (once) → write migrations/<table>/
  → deploy + parity once
  → pass? awaiting_approval
  → fail? needs_input → YOU fix locally (no OpenAI diagnose)
```

Headless equivalent:

```bash
npm run cli:doctor
npm run cli:discover -- <catalog>.<schema>.<table>
# edit tmp-debug/scope-draft.json (warehouseId, include flags)
npm run cli:create-job -- --scope tmp-debug/scope-draft.json
npm run worker   # generate once; pauses on failure
# OR after a job exists:
npm run cli:draft -- --job <jobId>
npm run cli:deploy -- <catalog.schema.table>
npm run cli:parity -- --job <jobId>
```

## Local fix loop (your job)

When status is `needs_input` or `cli:parity` exits non-zero:

1. Read `migrations/<table>/harness/last-run.json`
2. Read [cases/README.md](../../../cases/README.md) and `migrations/<table>/edge-cases/`
3. Patch `draft/sql_view.sql` and/or `draft/metric_view.yaml` (not free-form new apps)
4. `npm run cli:deploy -- <tableKey>` then `npm run cli:parity -- --job <jobId>`
5. **Required:** append `migrations/<table>/edge-cases/NNN-*.md` using [cases/_TEMPLATE.md](../../../cases/_TEMPLATE.md); promote to `cases/` if reusable
6. When mandatory tiles pass → `npm run cli:approve -- <jobId> --confirm` (human)

## Hard rules

- Never call `diagnoseFailures` / OpenAI repair for a live job.
- Never resume a stale paused job after worker code changes — `--rerun` / new job.
- Never write to `dbt_production`; publish only via explicit approve.
- Correctness comes from parity gates + Looker benchmarks, not generation.
- After every successful fix, write an edge-case note (regression ratchet).

## References

- [setup-auth.md](setup-auth.md) — per-dev Databricks, shared Looker/OpenAI
- [operations.md](operations.md) — CLI commands and statuses
- [debugging.md](debugging.md) — failure taxonomy for local fixes
- [verification.md](verification.md) — what “correct” means
- [translation-guide.md](translation-guide.md) — deterministic vs LLM boundary
- [edge-cases.md](edge-cases.md) — how to grow the case library

# Design: end-to-end migration job in <10 minutes (same quality)

**Date:** 2026-08-05
**Context:** Job `54ecaac6` (fct_building_monthly_financials, 61 dims / 7 measures / 58 dynamic fields / 31 benchmarks) spent 15+ min in `generate`, hit the OpenAI SDK's **default 10-minute timeout** (`Request timed out.`), and was then **reclaimed** by the 15-min stale-heartbeat rule — which restarted inventory+baseline from scratch. The pipeline is currently unable to finish generate for a job this size, regardless of patience.

## Where the time goes (measured on job 54ecaac6)

| Stage | Today | Bottleneck |
|---|---|---|
| Inventory | ~5s | — |
| Baseline | ~3 min | 31 Looker queries sequential (`lib/migration/baseline.ts` `for` loop) |
| Generate | 10+ min → SDK timeout | single call; ~1.5MB pretty-printed JSON input; output = full metric-view YAML + agent metadata (display_name, comment, ≤10 synonyms, format) + fieldMappings **with evidence prose for every one of ~68 fields** |
| Reclaim rework | +5–20 min | heartbeat only touched *between* phases; 15-min reclaim restarts inventory/baseline |
| Parity tests | ~2–4 min | 34 Databricks `executeStatement` calls sequential (`runParityTests` `for` loop) |

Dominant cost: **generate output tokens**. The model hand-writes metadata and mapping-evidence for ~50 passthrough dimensions that require zero semantic reasoning.

## Fixes, in implementation order

### 1. Stop losing finished work (bug fixes, do first)

**1a. Set explicit OpenAI client timeout + retries** — `lib/openai/client.ts` `getClient()`:

```ts
client = new OpenAI({ apiKey, timeout: 20 * 60 * 1000, maxRetries: 1 });
```

**1b. Heartbeat keepalive during long calls** — the reclaim killed a job that was actively working. Add a helper in `lib/migration/worker.ts` and wrap every long-running await (generate, diagnose, baseline capture, deploy, parity loop):

```ts
async function withHeartbeat<T>(jobId: string, work: Promise<T>): Promise<T> {
  const t = setInterval(() => touchJobHeartbeat(jobId).catch(() => {}), 60_000);
  try { return await work; } finally { clearInterval(t); }
}
```

**1c. Phase checkpointing on reclaim/restart** — `processJob` already persists `inventory` (with `benchmarks`) onto the job row after baseline. On (re)start: if `job.inventory?.benchmarks?.length` and `capturedAt` of first benchmark is < 24h old, **skip inventory + baseline** and jump to generate. This alone saves ~3.5 min on every restart and makes reclaims cheap.

### 2. Shrink the generate call (biggest win, quality-neutral)

Split `generateDatabricksAssets` into deterministic scaffolding + one focused semantic call + optional async enrichment.

**2a. Deterministic scaffolding (TypeScript, no LLM).** For every inventory dimension whose LookML `sql` is a simple column reference (`${TABLE}.col` or bare identifier), generate the metric-view dimension entry and its `fieldMappings` row in code:

- `name` = Looker bare name, `expr` = source column
- `display_name` = Looker `label`, `comment` = Looker `description`
- `format` derived from `valueFormat` / `type` (date, number) via a small lookup
- mapping evidence = mechanical string ("passthrough column, same name/type") — this is *more* reliable than model-authored prose

For fct_building_monthly_financials that removes ~50 of 68 fields from the model's output. Fields that are NOT simple passthroughs (CASE, parameters, liquid, any measure, any dynamic field) go to the LLM.

**2b. Focused semantic call (keep `gpt-5.6`, keep `reasoning_effort: medium`).** The LLM now only produces:

- SQL view body (if dedup/transforms needed)
- Measures (all 7) + dynamic-field promotions (58) — the actual hard part: aggregation, FILTER WHERE, currency CASE, populations
- fieldMappings + evidence **only for those fields**
- Any non-passthrough dimensions

Include the scaffolded dimension names in the prompt as "already handled — do not re-emit" so the YAML merge is unambiguous. Merge scaffolded + LLM fields into the final YAML in code (`js-yaml` compose, or string-template the dimensions block).

Expected effect: output tokens drop ~70%, wall time for the call drops from 10+ min to roughly 2–4 min. Reasoning quality on measures/currency is unchanged — the model has the same evidence and fewer distractions.

**2c. Enrichment (synonyms) out of the critical path.** Synonyms/Genie metadata don't affect parity tests or approval. Either:

- run a parallel second call (`reasoning_effort: "low"`) that only emits `{fieldName → synonyms[]}` and merge before deploy, or
- backfill post-approval with `ALTER VIEW ... ALTER COLUMN ... COMMENT` / a metadata patch step.

Recommend the parallel call — it finishes well inside the semantic call's window, so it's free.

### 3. Shrink the generate input

- `JSON.stringify(metadata)` **without** `null, 2` — pretty-printing roughly doubles the char count of a 1.5MB payload for zero model benefit.
- Dedupe benchmark `lookerSql`: the 31 tiles share a handful of distinct SQL shapes. Hash the (truncated) SQL, send each unique SQL once in a `sqlLibrary` map, and reference by key from each benchmark.
- Keep `MAX_BENCHMARK_SQL_CHARS = 4000` but strip Looker SQL boilerplate (leading comments, `FROM`-clause fully-qualified names repeated per line) before truncating, so the 4000 chars are all signal.
- Keep the system prompt byte-stable (it already is) — OpenAI prompt caching then discounts the shared prefix on diagnose/retry calls.

### 4. Parallelize I/O

- **Baseline** (`captureLookerBenchmarks`): run tiles with concurrency 4–6 (`p-limit` or a simple worker pool). 31 tiles × ~6s → ~40s. Keep per-tile error attribution (tile title in the thrown error).
- **Parity tests** (`runParityTests`): the Looker side is already free (uses `capturedJsonBi`); run the Databricks `executeStatement` + compare per test with concurrency 4–8. Counters (`passed`, `mandatoryFailed`, maps) must be accumulated after `Promise.all`, not mutated concurrently — restructure to return per-test result objects and reduce.
- Databricks statement API and Looker API both tolerate this concurrency comfortably; make it a constant (`PARITY_CONCURRENCY = 6`).

### 5. Warm start for re-runs on the same table (optional, big win for iteration)

Job `9c2cc50b` already **published** assets for this exact table. On job start, look up the most recent `published` job with the same `catalog.sourceSchema.sourceTable`:

- Seed `assets` + `fieldMapping` from its final snapshot (`getFinalAssetSnapshot`).
- Skip the generate call entirely; go straight to deploy → test.
- Only if mandatory tests fail does the normal diagnose loop engage (which is already incremental).

Gate it behind a per-job flag (`reuseLastPublished: true` default) so a clean-slate run stays possible. This turns re-runs into ~3-minute jobs.

## Implementation status (2026-08-05 evening)

Shipped in code (see checklist items 1–8, 10):
- OpenAI 20-min timeout + heartbeat keepalive + 24h baseline checkpoint resume
- Compact prompts + benchmark SQL dedupe (`sqlLibrary` / `lookerSqlRef`)
- Deterministic passthrough dimension scaffolding + YAML merge
- Parallel baseline (concurrency 6) + parallel parity tests (concurrency 6)
- Tile coverage UI: prefer live tests; show `0/N awaiting tests` from scope/benchmarks instead of stuck `0/—`

Deferred: warm start from last published job (item 9); separate low-effort synonym enrichment call (agent-metadata enrich already fills synonyms post-generate).


| Stage | Before | After |
|---|---|---|
| Inventory | 5s | 5s (skipped on resume) |
| Baseline | ~3 min | ~40s (parallel; skipped on resume/warm start) |
| Generate | 10+ min (times out) | ~2–4 min (scaffold + focused call; 0 on warm start) |
| Deploy dev | ~30s | ~30s |
| Parity tests | ~2–4 min | ~1 min (parallel) |
| **Total (iteration 1)** | **never finished** | **~5–7 min** |

## Why quality is preserved

- The semantic reasoning surface (measure exprs, dynamic-field promotion, currency handling, mapping evidence for non-trivial fields) stays on `gpt-5.6` medium with the same evidence — unchanged.
- Passthrough dimensions generated deterministically are strictly more reliable than LLM-authored ones (no hallucinated exprs/synonym drift), and the mapping validator (`acceptMappingSuggestion`) still runs on everything.
- Synonyms/enrichment never influenced parity tests or approval gates; moving them off the critical path changes nothing observable in the report.
- All parity/compare logic is untouched.

## Implementation checklist (ordered)

1. [ ] OpenAI client timeout + maxRetries (`lib/openai/client.ts`)
2. [ ] `withHeartbeat` wrapper around long awaits (`lib/migration/worker.ts`)
3. [ ] Resume-from-checkpoint: skip inventory/baseline when fresh benchmarks exist on the job row
4. [ ] Compact JSON (drop `null, 2`) + benchmark SQL dedupe in generate/diagnose prompts
5. [ ] Deterministic dimension scaffolding module (`lib/migration/scaffold.ts`) + merge into generated YAML; slim the generate schema/prompt to semantic fields only
6. [ ] Parallel enrichment call for synonyms (low effort), merged pre-deploy
7. [ ] Parallelize baseline capture (concurrency 6)
8. [ ] Parallelize parity tests (concurrency 6, reduce-after-gather)
9. [ ] Warm start from last published job for same source table (flagged)
10. [ ] Tests: scaffold unit tests (passthrough detection, YAML merge), parallel-loop counter integrity, checkpoint-resume path

Items 1–3 are small and fix the "never finishes" failure mode outright. Items 4–5 are the latency core. Items 7–9 buy the rest of the budget.

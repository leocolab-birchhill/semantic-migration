# Handoff: Looker migration agent — dynamic fields, filter parity, reconciliation overrides, generate speedups

**Date:** 2026-08-05 (updated evening)  
**Context:** Table-first migration for `fct_building_monthly_financials` and related financial dashboards. Prior handoff covered Databricks tab, explore-only gates, `dynamic_fields` capture, filter/comparator fixes, and reconciliation overrides. This update adds **generate latency + reliability fixes**, **tile coverage UI**, and current job status.

---

## Executive summary

| Phase | Problem | Status |
|-------|---------|--------|
| Dynamic fields | ~31/34 tiles marked "inventory gap" (`revenue`, `total_overhead`, …) | **Fixed** — fetch `dynamic_fields` end-to-end |
| Filter compilation | YTD tiles returned 16 rows vs Looker's 7/5 — `filter_expression` dropped or mangled | **Fixed** — `parseLookerFilterExpression` + wildcard `matches_filter` |
| Comparator | False baseline "value mismatch" from `null` vs `""` keys and demoted `account_number` | **Fixed** — key heuristics + null sentinel |
| Diagnose loop | OpenAI correctly identified filter bugs but could only patch SQL/YAML | **Fixed** — `queryPlanPatches`, `comparePatches`, `runtimeDefect` |
| Generate latency | 10+ min generate → SDK timeout + 15 min reclaim restart | **Fixed** — scaffold, compact prompts, heartbeat, checkpoint resume |
| Tile coverage UI | Stuck `0/— usable` before parity tests run | **Fixed** — `resolveTileCoverageCounts` + expected tile denominator |

**Latest job (reference):** `e206b95b-3e1a-4eac-af60-02bb27f9537c` — **`awaiting_approval`** after 3 iterations on `fct_building_monthly_financials` (post speedup + filter fixes).  
**Published reference:** `9c2cc50b-b81d-47aa-bed6-ec44c475b9e6` — published same table earlier today (1 iteration).  
**Failed (infra):** `54ecaac6-7fe1-4bdd-9f2e-d2dbe0c6ed62` — deploy artifact FK error (`migration_artifacts_iteration_id_fkey`); parity had passed on iter 3 before a later restart.

**Tests:** 112 passing (`npm test`).

---

## 1. Databricks tab — "Referenced by Looker"

*(unchanged from prior handoff)*

- **UI:** `components/LookerReferencedTables.tsx` above Unity Catalog tree in `DatabricksPanel`.
- **API:** `GET /api/looker/referenced-tables`
- **Resolve:** `POST /api/databricks/resolve-table` for `schema.table` → catalog via warehouse.
- **Core:** `listLookerReferencedTables()` in `lib/migration/discover.ts`, `stripSqlAlias()` in `table-names.ts`.

---

## 2. Explore-only migration (no dashboard required)

*(unchanged from prior handoff)*

Tiles optional for table-first migrations. When no tiles selected, approval allowed on smoke/schema evidence only (weaker parity). When tiles are selected, every runnable mandatory benchmark must pass.

---

## 3. Dynamic fields fix (implemented)

Dashboard **custom measures / table calculations** were stored as bare field names without formulas → 31 `unsupported` tiles on job `53771485`.

### Pipeline

```
getDashboard / getLook / getQuery  →  dynamic_fields on tile query
  → discover / inventory / baseline  →  dynamicFields on scope + benchmarks
  → test-cases: resolveFieldsAgainstInventory() skips dynamic names as gaps
  → OpenAI generate/diagnose: compactDynamicFieldForPrompt()
```

### Key module

`lib/migration/dynamic-fields.ts` — `parseLookerDynamicFields()`, `mergeDynamicFields()`, `compactDynamicFieldForPrompt()`.

### User action for old jobs

**Re-discover + start a new job.** Job `53771485` scope/benchmarks lack `dynamicFields`; do not resume it.

---

## 4. Job `465efd98` — filter parity + comparator (fixed 2026-08-05)

### Symptoms (post–dynamic-fields job)

| Failure mode | Example tiles | Looker rows | Databricks rows |
|--------------|---------------|-------------|-----------------|
| Row count mismatch | YTD Total Overhead, YTD Claims, YTD Overtime % | 7 or 5 | 16 (unfiltered years) |
| Value mismatch | LTM Overhead Breakdown (% of Total Overhead) | 7 | 16 (inflated measures on shared keys) |
| False baseline fail | Baseline explore query | 100 | 100 (1 "budget" diff) |

OpenAI diagnose (iter 3–4) **correctly** said: measures match Looker SQL; failures are missing tile `filter_expression` predicates — not wrong metric-view expr. It could not fix them because diagnose only allowed SQL/YAML/mapping patches.

### Root causes

1. **`parseFilterExpression` was too narrow** — only `matches_filter(${field}, \`expr\`)`. Ignored:
   - `${year} >= "2020"`
   - `${month_date} <= ${anchor_month}`
   - `concat(${year},"") <= concat(extract_years(now()),"")`

2. **Wildcard `matches_filter` broken** — e.g. `-%2013%,-%2012%` hit the comma branch incorrectly and became a single bogus `<>` predicate. YTD Sales (no `%`) passed; YTD Total Overhead failed.

3. **Comparator key bugs**
   - `null` and `""` dimension values hashed to the same row key → wrong pairing on sparse `account` rows.
   - `account_number` demoted from keys (numeric-looking strings) → baseline compared on `(account, acct_group)` only.

4. **Misleading publish error** — `compileErrorCount` was set to `mandatoryFailed`, so value mismatches read as "couldn't run against metric view."

### Fixes shipped

| Area | File | Change |
|------|------|--------|
| Filter expression | `lib/migration/query-builder.ts` | `parseLookerFilterExpression()` — matches_filter, comparisons, cross-field, `extract_years(now())` |
| Wildcard filters | `lib/migration/query-builder.ts` | `lookerFilterToSql()` — `NOT LIKE` / mixed `NOT IN` for `-%2013%` lists |
| Worker filters | `lib/migration/worker.ts` | `extractFiltersFromTest()` uses full parser; passes `predicates` to `buildMetricViewSelect` |
| Comparator keys | `lib/migration/comparator.ts` | Null sentinel `\u0000`; keep `*_number` / `*_id` as keys |
| Approval copy | `lib/migration/approval.ts` | Separate compile vs value-mismatch messages |
| Field mapping | `lib/migration/field-mapping.ts` | `predicates` on `compileBenchmarkFromMapping` + ident remap |

---

## 5. Reconciliation overrides — three patch planes (implemented 2026-08-05)

Diagnose can now fix **reconciliation** edge cases without rewriting app code or baking tile-specific WHERE into shared measures.

### Architecture

```
test failures
  → diagnose (OpenAI)
       ├─ patches / mappingPatches     → semantic SQL view / metric-view YAML
       ├─ queryPlanPatches             → per-tile filters + SQL predicates
       ├─ comparePatches               → decimalScale, forceKeyColumns
       └─ runtimeDefect                → platform bug (pause, don't burn iterations)
  → worker merges overrides → retest (no redeploy if plan/compare only)
```

### New module: `lib/migration/reconciliation-overrides.ts`

- `QueryPlanPatch` — per `testName`: Looker-style `filters[]` + validated `predicates[]` (backtick dimension comparisons only).
- `ComparePolicyPatch` — global (`testName: ""`) or per-test `decimalScale`, `forceKeyColumns`.
- `RuntimeDefect` — `{ present, component, summary, repro }` when no safe override exists.
- `sanitizeQueryPlanPatches()` / `validatePredicateSql()` — reject `;`, `--`, unknown dimensions.
- `mergeOverrides()` — persisted across iterations as artifact `reconciliation_overrides`.

### Diagnose payload (enriched)

Each failed test now includes:

- `databricksSql`, `lookerSql`
- `filterExpression`, `filters`, `predicates`
- `lookerRowCount`, `databricksRowCount`, `mismatchKind`
- `sampleDiffs` (up to 5 cells)

### OpenAI schema (`lib/openai/client.ts`)

`DiagnoseOutput` extended with `queryPlanPatches`, `comparePatches`, `runtimeDefect`. System prompt documents all three planes and when to use each.

### Worker behavior

- `reconciliationOverrides` carried across iteration loop.
- Plan/compare patches applied before next `runParityTests()` — **no redeploy** when only overrides change.
- Pauses on `needsHumanInput`, `runtimeDefect` (no actionable patch), or empty diagnosis.
- Saves `documentation/reconciliation_overrides` artifact when patches accepted.

### Tests

`tests/reconciliation-overrides.test.ts` — predicate validation, plan merge → SQL, compare config, runtime defect formatting.

---

## 6. Generate speedups + reliability (implemented 2026-08-05 evening)

Job `54ecaac6` exposed three compounding problems: **OpenAI SDK 10-min default timeout**, **15-min stale-heartbeat reclaim** (no heartbeat during long calls), and **bloated generate output** (~50 passthrough dimensions hand-written by GPT).

### What shipped

| Change | File(s) | Effect |
|--------|---------|--------|
| OpenAI timeout 20 min + 1 retry | `lib/openai/client.ts` | Stops `Request timed out.` on large generates |
| `withHeartbeat()` every 60s | `lib/migration/worker.ts` | Reclaim won't kill active generate/diagnose/baseline/test |
| Checkpoint resume (<24h benchmarks) | `lib/migration/worker.ts` | After reclaim, skip inventory+baseline |
| Passthrough dimension scaffold | `lib/migration/scaffold.ts` | ~50 trivial dims built in TS; LLM only does measures/dynamic fields |
| Compact JSON + SQL dedupe | `lib/openai/client.ts` | `promptJson()` + `sqlLibrary` / `lookerSqlRef` on benchmarks |
| Parallel baseline (6) | `lib/migration/baseline.ts`, `concurrency.ts` | 31 Looker tiles ~40s vs ~3 min |
| Parallel parity tests (6) | `lib/migration/worker.ts` | Databricks compare ~1 min vs ~2–4 min |

### Generate flow (updated)

```
inventory + baseline
  → scaffoldPassthroughDimensions()     # deterministic dims + fieldMappings
  → generateDatabricksAssets()          # GPT: measures + dynamic fields + non-trivial dims only
  → mergeScaffoldIntoAssets()           # merge scaffold into metric_view YAML
  → sanitizeGeneratedAssets()           # agent metadata enrich (synonyms etc.)
  → deploy → test → diagnose loop
```

### Deferred (see `speedup-design.md`)

- Warm start from last **published** job for same source table (skip generate on re-run).
- Persist `response.usage` per job for per-migration cost tracking.
- Separate low-effort synonym enrichment call (agent-metadata enrich already fills synonyms post-generate).

### Expected timing (post-fix)

| Stage | Before | After |
|-------|--------|-------|
| Baseline | ~3 min | ~40s |
| Generate | 10+ min (timeout) | ~2–4 min |
| Parity tests | ~2–4 min | ~1 min |
| **First iteration total** | never finished | **~5–7 min** |

---

## 7. Tile coverage UI fix (implemented 2026-08-05 evening)

**Symptom:** Activity panel showed **`0/— usable`** while job was in generate/baseline despite 31 tiles in scope.

**Cause:** `JobActivityPanel` preferred an empty `migrationReport.summary` over live tests; denominator was `0` before parity ran.

**Fix:** `resolveTileCoverageCounts()` in `lib/migration/job-activity.ts`:
1. Prefer live test rows when present.
2. Fall back to report summary when tests empty but report has totals.
3. Before tests run, show **`0/N awaiting tests`** using `expectedTileCountFromJob()` (benchmarks → scope tiles → tileQueries).

---

## 8. OpenAI cost / usage (not tracked in-app)

- App does **not** persist `response.usage` (tokens) or dollar cost.
- Configured `OPENAI_API_KEY` lacks `api.usage.read` — org Costs/Usage API returns 403.
- **Actual billing:** [platform.openai.com/settings/organization/usage](https://platform.openai.com/settings/organization/usage) (group by Line item).

### Rough call volume (DB events, all time)

| Event | Count |
|-------|-------|
| `generate_done` | 11 |
| `diagnose` | 25 |

Failed/timed-out generates are **not** counted — real generate attempts are higher (~15–20).

### Order-of-magnitude estimate (Aug 3–5 dev session)

| Scenario | USD |
|----------|-----|
| Conservative | ~$40–80 |
| Likely (financials + 5-iter retries) | ~$80–150 |
| Per clean publish (1 iter) | ~$8–20 |
| Per 5-iter repair job | ~$25–50 |

Dominant cost: **generate output tokens** on financials (pre-scaffold). Post-scaffold jobs should be materially cheaper.

---

## 9. Table-first flow (current)

```
Source table
  → discover (views/explores/tiles + dynamicFields)
  → confirm scope
  → baseline (Looker json_bi + dynamic_fields)     [parallel, checkpoint-resumable]
  → inventory
  → scaffold passthrough dims (TS)
  → generate (OpenAI — measures + dynamic fields only)
  → merge scaffold → sanitize/enrich
  → deploy (dev)
  → test (parallel Databricks compare)
  → diagnose
       → semantic patches OR reconciliation overrides OR runtimeDefect
  → (redeploy if assets changed) → retest
  → approval / publish
```

### Where parity can still fail (expected)

- **Post-query table calculations** — may need `dashboard_calc` or manual dashboard rebuild.
- **Pivots / totals** — tracked as unsupported gaps.
- **Complex P&L logic** — may need multiple diagnose iterations on measure expr.
- **Unparseable filter_expression** — agent can emit `queryPlanPatch` with explicit predicates; if validation rejects, `runtimeDefect` or human input.
- **Explore-only jobs** — smoke/schema only; no tile proof.

---

## 10. What to do next

1. **Approve/publish** job `e206b95b` if migration report looks good — it's at `awaiting_approval`.
2. **Investigate** `54ecaac6` FK failure (`migration_artifacts_iteration_id_fkey` on deploy) — likely iteration row missing when saving artifact after reclaim/restart; fix before relying on that job.
3. **Restart worker** after pulling latest code so speedup + heartbeat changes are active: `npm run start:local`.
4. For new financials runs, expect **~5–7 min** first iteration with post-scaffold generate.
5. If job pauses with `runtimeDefect`, check `tmp-debug/` artifact `reconciliation_overrides` and diagnose event payload.

```bash
npm test
npx tsx scripts/dump-job-debug.ts [jobId]
npm run start:local   # app + worker
```

---

## 11. File change index

```
components/DatabricksPanel.tsx
components/LookerReferencedTables.tsx
components/MigrationPanel.tsx
components/MigrationCoveragePanel.tsx
components/JobActivityPanel.tsx              # tile coverage fix
app/api/looker/referenced-tables/route.ts
app/api/databricks/resolve-table/route.ts
app/api/migrations/route.ts
lib/looker/client.ts
lib/migration/discover.ts
lib/migration/dynamic-fields.ts
lib/migration/inventory.ts
lib/migration/baseline.ts                    # parallel tile capture
lib/migration/concurrency.ts                 # NEW — mapPool
lib/migration/scaffold.ts                    # NEW — passthrough dim scaffold
lib/migration/job-activity.ts                # resolveTileCoverageCounts
lib/migration/test-cases.ts
lib/migration/types.ts
lib/migration/table-names.ts
lib/migration/jobs.ts
lib/migration/approval.ts
lib/migration/worker.ts                      # heartbeat, checkpoint, parallel tests
lib/migration/query-builder.ts
lib/migration/comparator.ts
lib/migration/field-mapping.ts
lib/migration/reconciliation-overrides.ts
lib/openai/client.ts                         # timeout, compact prompts, scaffold merge
scripts/validate-tam-tiles.ts
speedup-design.md                            # design doc + implementation status
tests/table-first.test.ts
tests/comparator.test.ts
tests/reconciliation-overrides.test.ts
tests/scaffold.test.ts                       # NEW
tests/job-activity.test.ts                   # coverage count tests
```

---

## 12. Open questions / follow-ups

- [x] Fetch `dynamic_fields` on dashboard tiles end-to-end.
- [x] Compile common `filter_expression` patterns for Databricks parity SQL.
- [x] Give diagnose visibility into executed `databricksSql` and reconciliation patch planes.
- [x] Generate latency: scaffold, heartbeat, checkpoint resume, parallel I/O.
- [x] Tile coverage UI: show expected denominator before tests run.
- [ ] Approve/publish `e206b95b` and confirm production metric view.
- [ ] Fix `migration_artifacts_iteration_id_fkey` on reclaim/restart path (`54ecaac6`).
- [ ] Persist OpenAI `response.usage` per job event for cost visibility.
- [ ] Warm start from last published job for same source table.
- [ ] Golden tests with real Looker `filter_expression` payloads from BSG dashboards.
- [ ] Policy for `table_calculation` vs metric-view promotion (product).
- [ ] Optional: tool-using diagnose (`getFailedTestSql`, `dryRunPredicate`) instead of one-shot JSON.

---

## 13. Commands

```bash
npm test
npx tsx scripts/dump-job-debug.ts [jobId]
npm run start:local   # app + worker
```

---

## 14. Job reference summary

| Job ID | Status | Notes | Action |
|--------|--------|-------|--------|
| `e206b95b-…` | **awaiting_approval** | Financials, 3 iterations, post speedup | **Review report → approve/publish** |
| `9c2cc50b-…` | published | Financials, 1 iteration (earlier today) | Reference / compare assets |
| `54ecaac6-…` | failed (deploy) | Parity passed iter 3; FK error on artifact save after restart | Debug FK; rerun if needed |
| `465efd98-…` | failed (compare) | Pre filter/comparator fix | Abandon |
| `53771485-…` | needs_input | No `dynamicFields` on scope | Abandon — re-discover |

**Bottom line:** Filter/comparator/reconciliation fixes are validated — job `e206b95b` reached approval on financials with current code. Generate speedups address the timeout/reclaim failure mode. Next: publish `e206b95b`, fix artifact FK on reclaim path, optionally add usage tracking.

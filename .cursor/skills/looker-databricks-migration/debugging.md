# Debugging Playbook (local Cursor fix)

OpenAI diagnose is **disabled**. Classify failures, then fix draft artifacts
or deterministic engine code yourself.

## Step 1: Evidence

```bash
# Primary oracle for the fix loop:
cat migrations/<catalog.schema.table>/harness/last-run.json
```

Also read `cases/README.md` and `migrations/<table>/edge-cases/`.

## Step 2: Classify

| Class | Signals | Action |
|-------|---------|--------|
| Auth / infra | `fetch failed`, 401, token expired | Human: `npm run auth:databricks` |
| App / deterministic bug | Same values marked mismatch; CAST on filter lists; YAML colon crash | Fix engine + golden test; optionally patch draft as workaround |
| Semantic gap | Real measure/population diffs after shared WHERE | Patch `draft/metric_view.yaml` / `sql_view.sql`, redeploy, parity |

## Failure → module map

| Symptom | Module / artifact |
|---------|-------------------|
| null/empty key false fails | `lib/migration/comparator.ts` + `cases/comparator/` |
| `NULL,>=N` CAST | `lib/migration/query-builder.ts` + `cases/filters/` |
| YAML colon crash | `lib/migration/deploy-normalize.ts` + `cases/yaml/` |
| Looker 0 vs DB null | COALESCE measure with COALESCE — `cases/currency/` |
| Wrong metric-view source | `draft/metric_view.yaml` `source:` → sql_view |
| Sibling dim in expr | Inline SQL or materialize on sql_view (`translation-guide.md`) |

## Step 3: Fix loop

```bash
# edit draft/
npm run cli:deploy -- <catalog.schema.table>
npm run cli:parity -- <catalog.schema.table>
# write edge-case note; commit/PR cases/ when reusable
```

Do **not** call OpenAI diagnose.

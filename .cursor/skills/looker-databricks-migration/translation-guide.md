# LookML → Databricks Translation Guide

The pipeline splits translation between deterministic TypeScript (provably
correct, token-free) and an **OpenAI one-shot draft** (semantic reasoning).
Repair is owned by the **local Cursor model** against Databricks parity —
not by OpenAI diagnose. Read this before touching
`lib/migration/scaffold.ts`, `lib/migration/query-builder.ts`, draft YAML,
or the prompts in `lib/openai/client.ts`.

## Deterministic today (never send to the LLM)

| Translation | Rule | Module |
|-------------|------|--------|
| Passthrough dimensions | LookML `sql` is a bare column or `${TABLE}.col` (no CASE/liquid/params/operators) → metric-view dimension `expr: col`, display_name from label, format from value_format | `scaffold.ts` (`parsePassthroughColumn`) |
| Value formats | Looker `value_format` / type → Databricks format maps (currency, percentage, number, date) | `agent-metadata.ts` |
| Filter grammar | Looker filter strings: comma lists (`NULL,>=20000` → `col >= 20000 OR col IS NULL`), wildcards, exclusions (`-10630US`), numeric literals vs negation | `query-builder.ts` |
| Filter expressions | `parseLookerFilterExpression` for `filter_expression` syntax (YTD/LTM date logic) | `query-builder.ts` |
| Plan-patch hygiene | Reject unresolved `${…}` templates in patches; dedupe identical WHERE clauses; compound predicates (AND/OR/IS NULL/LIKE) validated | `reconciliation-overrides.ts` |
| YAML normalization | Quote metadata scalars containing colons; strip DDL wrappers; preserve existing fields on patch | `deploy-normalize.ts`, `scaffold.ts` |
| Comparator identity | null ≡ "", duplicate-key sum-collapse, half-unit-at-scale float compare | `comparator.ts` (OpenAI cannot edit; only decimalScale/forceKeyColumns knobs) |
| Null-vs-0 repair | Clear null↔0-only failures on aggregates → COALESCE applied deterministically | worker repair step |

## Deterministically expandable (phase 2 — prefer these over prompt work)

Biggest token savings and reliability wins, in order:

1. **Simple aggregate measures**: `type: sum|count|avg|min|max` over a single
   passthrough column, no filters → `AGG(col)` (+ `COALESCE(…, 0)` for
   sum/count per the empty-aggregate rule). Template in scaffold.
2. **Filtered measures**: measure `filters:` with equality/list values →
   `AGG(col) FILTER (WHERE …)` reusing the existing filter compiler.
3. **Currency `_selected` stems**: when both `*_cad` and `*_usd` columns are
   verified present on the source, materialize the CAD-default alias in the
   staging SQL view deterministically.

When adding a deterministic rule: keep the accepting grammar narrow
(reject anything ambiguous back to the LLM), add golden fixtures first,
and add the emitted names to `scaffoldedPassthroughDimensions`-style
"already handled — do not re-emit" lists in the prompt.

## Stays with the OpenAI one-shot draft (then Cursor may patch)

- CASE/liquid/parameter dimensions
- Sibling-field references: inline the sibling's SQL vs materialize a
  column on the staging view
- Dashboard dynamic fields: custom measures (basedOn + filters → FILTER
  WHERE / CASE), custom dimensions, table-calculation promotion vs
  `dashboard_calc`
- Population/grain predicates (TAM populations, anchor-month logic)
- Deduplication / transformation SQL views

After the draft lands in `migrations/<table>/draft/`, Cursor patches these
using `cli:parity` failures — do not re-invoke OpenAI diagnose.

## Databricks metric-view hard rules (violations = guaranteed failures)

1. **Source-only exprs**: every dimension/measure `expr` resolves against
   the metric view's `source` columns ONLY. No Looker-style
   `${view.sibling}` references — inline the SQL or materialize the column.
2. **Benchmark naming**: the metric view is named exactly after the Looker
   explore; every field used by a benchmark keeps the Looker bare field
   name (`fct_x.revenue_sum` → measure `revenue_sum`). Currency variants
   live inside the expr, not in the name.
3. **Empty aggregates**: Looker returns 0 for empty groups; Databricks
   `MEASURE()` returns null → wrap sum/count-style exprs in
   `COALESCE(expr, 0)` unless LookML preserves nulls.
4. **YAML shape**: `version: "1.1"`, `source`, `dimensions`/`fields`,
   `measures`; body only (the app wraps DDL); block scalars for any expr
   containing colons; never invent source columns.
5. **Currency stems**: physical columns are usually `*_cad`/`*_usd`; bare
   stems (`customer_revenue`, `rate`) are not physical — materialize the
   CAD default in the staging view.
6. **Patch completeness**: replacement YAML must retain every existing
   dimension and measure — partial replacements regress earlier fixes.

## Presentation vs semantics

Pivots, post-query table calculations, and dashboard chrome are
presentation-layer. They become `dashboard_calc` notes or documented gaps,
never metric-view fields. A genuine population difference after the shared
WHERE is restored is a data question for the user, not a translation bug.

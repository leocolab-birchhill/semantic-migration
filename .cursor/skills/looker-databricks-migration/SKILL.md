---
name: looker-databricks-migration
description: >-
  Operates the Looker-to-Databricks migration skill CLI with an inventory-first,
  dependency-graph methodology: exhaustively inventory the Looker environment,
  build a typed graph, propose atomic migration components, wait for approval,
  then OpenAI one-shot YAML draft plus per-table parity under migrations/ with
  local Cursor repair. Filesystem-only — no job database or web app. Use when
  working in viewReconciliationAgent, Looker explores/tiles, metric views,
  parity failures, semantic layer migration, dependency graphs, or migration
  component planning. On every invocation, state requirements then run the
  credentials/schema gate before inventory/plan/discover/draft.
disable-model-invocation: true
---

# Looker → Databricks Migration (skill CLI)

**Core principle:** Inventory exhaustively; migrate selectively.

An **atomic migration component** is the smallest independently deployable,
testable, and reversible semantic contract serving a coherent business use
case. It is **not** a LookML file, a source table, or an arbitrary connected
subgraph. A component may depend on approved shared foundations or existing
Databricks assets.

OpenAI drafts **once** after approval. You (local Cursor) own **all repair**
using `harness/last-run.json` + `cases/`. Never call OpenAI diagnose.

Artifacts are files under `tmp-debug/` (planning) and
`migrations/<catalog.schema.table>/` (execution). There is **no Postgres job
DB** and **no web app**.

## First action on every invocation

**Stop. Do not run inventory / plan / discover / draft / deploy yet.**

1. **State requirements** (below).
2. Soft prereqs → `npm run cli:doctor` → missing credentials → confirm target
   schemas.
3. Only when doctor is green **and** schemas are confirmed → begin
   **inventory-first planning** (not table discover).

Full protocol: [setup-auth.md](setup-auth.md).

---

## Requirements (state these first)

### A — Credentials (edit `.envs`, never paste secrets into chat)

| Cluster | Variables | Source |
|---------|-----------|--------|
| Databricks | `DATABRICKS_HOST`, `DATABRICKS_AUTH_MODE=cli`, `DATABRICKS_CLI_PROFILE` (or `DATABRICKS_TOKEN`) | `[PER-DEV]` |
| Looker | `LOOKER_HOST`, `LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET` | `[SHARED]` vault |
| OpenAI | `OPENAI_API_KEY` | `[SHARED]` vault |

For each missing cluster: name the variables, tell the human to paste into
`.envs` (not chat), reply **done**. Expired CLI tokens →
`npm run auth:databricks` (wait for every browser profile).

### B — Databricks target schemas (confirm before draft)

1. **Catalog** (usually same as source)
2. **Dev schema** (default `semantic_migration_dev`)
3. **Prod schema** (default `business_semantics`) — publish only
4. Exist already vs need create?
5. Never write to `dbt_production`

Write confirmed names into `tmp-debug/scope-draft.json`
(`databricks.devSchema` / `databricks.prodSchema`).

### C — Permissions

| Privilege | On |
|-----------|-----|
| Use SQL warehouse | Chosen warehouse |
| `USE CATALOG` | Target catalog |
| `USE SCHEMA` + `SELECT` | Source schema/table |
| `USE SCHEMA` + create views/metric views | Dev (and prod if publishing) |
| `CREATE SCHEMA` | Catalog — only if creating dest schema |

---

## Check gate

1. `node_modules`, Databricks CLI, `.envs` from `.envs.example`
2. `npm run cli:doctor` until all PASS
3. Schema confirmation (section B)
4. Run inventory → plan → **approval checkpoint** (do not migrate yet)

## Planning workflow (inventory-first)

```
requirements → doctor → confirm schemas
  → cli:inventory → cli:plan
  → present graph + components in chat (required response shape)
  → human approves / merges / splits / defers
  → ONLY THEN: discover/draft for approved component source tables
  → deploy → parity → local fix → publish
```

```bash
npm run cli:doctor
npm run cli:inventory
# optional filters: --project <name> --model <name> --max-explores 40
npm run cli:plan
# optional: --scope-mode consumer-parity|explore-retirement --both-scopes
# WAIT for human approval of component-plan.yaml
# Then for each approved component's primary source table(s):
npm run cli:discover -- <catalog>.<schema>.<table>
# edit tmp-debug/scope-draft.json (warehouse, include flags, schemas)
npm run cli:draft -- --scope tmp-debug/scope-draft.json
npm run cli:deploy -- <catalog.schema.table>
npm run cli:parity -- <catalog.schema.table>
npm run cli:publish -- <catalog.schema.table> --confirm
```

### Deterministic vs model judgment

| Deterministic (scripts/libs) | Model (you) |
|------------------------------|-------------|
| Inventory extraction, LookML parse, graph build, closures, cycles, overlap, manifest validation, Mermaid export | Business grain, component boundaries, ownership, ambiguity, chat rationale, foundation worthiness |

Never invent graph edges with the model. Never begin migration without approval.

### Scope modes

Ask when it materially changes the plan:

- **consumer-parity** — only fields/joins/sources required by selected dashboards, Looks, schedules, workflows
- **explore-retirement** — full supported semantic contract of the Explore

If unset: recommend one, or run `--both-scopes` and label both.

### Required chat response after analysis

1. **Inventory summary** — counts, coverage gaps, unresolved deps
2. **Dependency graph** — Mermaid in chat (full if small; domain summary + per-component graphs + path to `tmp-debug/dependency-graph.json` if large)
3. **Proposed components** — table: name, grain, root Explore, consumers, deps, scope, confidence, risks
4. **Component details** — focused graph + rationale each
5. **Recommended migration waves** — ordered with justification
6. **Recommended first component** — valuable but bounded
7. **Questions requiring human judgment**
8. **Approval checkpoint** — ask what to approve / change / merge / split / defer; **do not migrate**

Methodology detail: [references/component-methodology.md](references/component-methodology.md).

## Local fix loop (after approved migration execution)

When `cli:parity` exits non-zero (`harness/last-run.json` status `needs_fix`):

1. Read `migrations/<table>/harness/last-run.json`
2. Read [cases/README.md](../../../cases/README.md) + table `edge-cases/`
3. Patch `draft/sql_view.sql` and/or `draft/metric_view.yaml`
4. `npm run cli:deploy -- <tableKey>` then `npm run cli:parity -- <tableKey>`
5. Append `migrations/<table>/edge-cases/NNN-*.md`; promote to `cases/` if reusable
6. Remind human to **commit/PR** case notes for team learning (not auto-pushed)
7. When green → `npm run cli:publish -- <tableKey> --confirm`

## Hard rules

- Inventory exhaustively; migrate selectively.
- Never treat a LookML file, source table, or arbitrary connected graph as the default migration unit.
- Never OpenAI diagnose / repair loops.
- Never write to `dbt_production`; publish only via explicit `--confirm`.
- Correctness = parity gates + Looker benchmarks, not generation.
- Never read/print `.envs` secrets; never collect secrets in chat; never put secrets in inventory/graph artifacts.
- Always confirm dev/prod schema names before draft.
- Always show a readable Mermaid graph during analysis.
- Always wait for component approval before discover/draft/deploy.

## References

- [setup-auth.md](setup-auth.md)
- [operations.md](operations.md)
- [debugging.md](debugging.md)
- [verification.md](verification.md)
- [translation-guide.md](translation-guide.md)
- [edge-cases.md](edge-cases.md)
- [references/component-methodology.md](references/component-methodology.md)
- [references/looker-dependency-rules.md](references/looker-dependency-rules.md)
- [references/databricks-mapping.md](references/databricks-mapping.md)
- [references/risk-and-validation-rules.md](references/risk-and-validation-rules.md)

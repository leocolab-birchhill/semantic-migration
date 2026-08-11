# Looker → Databricks Migration Skill

Skill-first CLI that inventories the Looker environment, proposes atomic
migration components from a dependency graph, then (after approval) drafts
Databricks metric views and proves parity with Looker tile benchmarks.
**No web app. No Postgres job DB.**

**Core principle:** Inventory exhaustively; migrate selectively.

Planning artifacts live under `tmp-debug/`. Execution artifacts live under
`migrations/<catalog.schema.table>/`. Shared lessons live in `cases/`
(commit + PR to share with the team).

**Cursor skill:** `.cursor/skills/looker-databricks-migration/`  
**Setup:** [SETUP.md](SETUP.md)

## Flow

```
doctor → inventory → plan → approve components
  → discover → edit scope → draft (OpenAI once)
  → deploy → parity → (fix draft locally) → publish
```

```bash
npm install
cp .envs.example .envs   # fill Looker / OpenAI / Databricks
npm run auth:databricks  # browser login
npm run cli:doctor

npm run cli:inventory
npm run cli:plan
# review tmp-debug/component-plan.yaml — approve/merge/split/defer in chat
# only then:
npm run cli:discover -- <catalog>.<schema>.<table>
# edit tmp-debug/scope-draft.json (warehouseId, include flags, schemas)
npm run cli:draft -- --scope tmp-debug/scope-draft.json
npm run cli:deploy -- <catalog.schema.table>
npm run cli:parity -- <catalog.schema.table>
# on failure: patch draft/, redeploy, re-parity, write edge-case note
npm run cli:publish -- <catalog.schema.table> --confirm
```

Or in Agent chat: `/looker-databricks-migration`

## What “correct” means

Mandatory Looker tile benchmarks must pass against Databricks
(`harness/last-run.json`). OpenAI draft is not trusted until parity is green.
Component planning must wait for human approval before any draft/deploy.

## Layout

```
.cursor/skills/looker-databricks-migration/  # Cursor skill + references/
cases/                                       # shared edge-case library (git)
migrations/<table>/draft/                    # SQL + metric-view YAML
migrations/<table>/harness/last-run.json     # latest parity results
lib/looker|databricks|openai|migration/      # CLI libraries
scripts/cli/                                 # doctor inventory plan discover draft deploy parity publish
```

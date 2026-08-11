# Looker → Databricks Migration Skill

Skill-first CLI that drafts Databricks metric views from Looker, then proves
parity with Looker tile benchmarks. **No web app. No Postgres job DB.**

Artifacts live under `migrations/<catalog.schema.table>/`. Shared lessons live
in `cases/` (commit + PR to share with the team).

**Cursor skill:** `.cursor/skills/looker-databricks-migration/`  
**Setup:** [SETUP.md](SETUP.md)

## Flow

```
doctor → discover → edit scope → draft (OpenAI once)
  → deploy → parity → (fix draft locally) → publish
```

```bash
npm install
cp .envs.example .envs   # fill Looker / OpenAI / Databricks
npm run auth:databricks  # browser login
npm run cli:doctor

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

## Layout

```
.cursor/skills/looker-databricks-migration/  # Cursor skill
cases/                                       # shared edge-case library (git)
migrations/<table>/draft/                    # SQL + metric-view YAML
migrations/<table>/harness/last-run.json     # latest parity results
lib/looker|databricks|openai|migration/      # CLI libraries
scripts/cli/                                 # doctor discover draft deploy parity publish
```

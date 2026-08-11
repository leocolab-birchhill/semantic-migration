# Team setup (skill CLI — no public secrets)

This repo is safe to clone: **credentials are never in git**. There is no web
app and no job database to configure.

## What is shared in the repo

- Cursor skill: `.cursor/skills/looker-databricks-migration/`
- CLI + libraries (`lib/`, `scripts/cli/`, `tests/`)
- Edge-case library: `cases/` (promote lessons here via PR)
- Env **template** only: `.envs.example`

## What each developer does

1. `npm install`
2. Install the [Databricks CLI](https://docs.databricks.com/dev-tools/cli/install.html)
3. Copy env template and fill values:

```bash
cp .envs.example .envs
```

| Variable | Source |
|----------|--------|
| `LOOKER_HOST` / `LOOKER_CLIENT_ID` / `LOOKER_CLIENT_SECRET` | Shared team vault |
| `OPENAI_API_KEY` | Shared team vault |
| `DATABRICKS_HOST` + `DATABRICKS_CLI_PROFILE` | **Your** workspace (per-dev) |

4. Browser login (tokens stay on your machine):

```bash
npm run auth:databricks
```

5. Preflight:

```bash
npm run cli:doctor
```

6. Inventory-first planning (approve components before migrating):

```bash
npm run cli:inventory
npm run cli:plan
```

Then use Agent chat `/looker-databricks-migration` or continue with
`cli:discover` for **approved** component source tables only.

Never commit `.envs`. Never paste secrets into chat/issues/PRs.

## Team learning (`cases/`)

After a successful local fix, the skill writes notes under
`migrations/<table>/edge-cases/` and (when reusable) `cases/`. Those files are
**not** auto-pushed — commit and open a PR so teammates get them on `git pull`.

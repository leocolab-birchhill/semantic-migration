# Team setup (no public secrets)

This repo is safe to clone publicly: **credentials are never in git**.

## What is shared in the repo

- The Cursor skill: `.cursor/skills/looker-databricks-migration/`
- Migration pipeline code (`lib/`, `scripts/`, `app/`, `tests/`)
- Planning docs (`skill-plan.md`, `handoff.md`, `cases/`)
- Env **template** only: `.envs.example` (placeholder values, no secrets)

## What stays private (each developer)

1. Copy the template:

```bash
cp .envs.example .envs
```

2. Fill secrets from the **team vault** (1Password / Bitwarden / Azure Key Vault — not Slack, not the repo):

| Variable | Who provides it |
|----------|-----------------|
| `LOOKER_*` | Shared Looker API service account (team vault) |
| `OPENAI_API_KEY` | Shared team key (team vault) |
| `DATABASE_URL` or Lakebase `PG*` | Shared/local DB (team vault or `npm run db:up`) |
| `DATABRICKS_HOST` + `DATABRICKS_CLI_PROFILE` | **Your** workspace — per developer |

3. Authenticate Databricks locally (browser login; token stays on your machine):

```bash
npm run auth:databricks
```

4. Verify:

```bash
npm run cli:doctor
```

`.envs` is gitignored. Never commit it. Never paste secrets into issues/PRs.

## Why this works with a public (or org) repo

- GitHub only has code + empty placeholders
- Cursor discovers the skill from `.cursor/skills/` after clone
- Each user brings their own Databricks CLI session
- Shared Looker/OpenAI keys live in a secrets manager, not the repository

## Optional: org-only distribution

If you prefer secrets never leave your org at all:

- Keep the GitHub repo **private** under Birch Hill
- Or use a private package / internal mirror for the skill folder only
- CI (if any) should use [GitHub Actions secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions), not committed files

There is no safe way to put real API keys in a public repo and still “just clone and run.” The template + vault + CLI login pattern is the standard approach.

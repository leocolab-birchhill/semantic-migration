<!-- BEGIN:nextjs-agent-rules -->
# Skill CLI repo

This project is a **filesystem-only** Looker → Databricks migration CLI driven
by the Cursor skill in `.cursor/skills/looker-databricks-migration/`.

**Inventory exhaustively; migrate selectively.** Prefer `cli:inventory` →
`cli:plan` → human component approval before `cli:discover` / draft / deploy.

There is no Next.js app and no job database. Prefer `npm run cli:*` scripts.
<!-- END:nextjs-agent-rules -->

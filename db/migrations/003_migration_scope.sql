-- Confirmed table-first discovery scope (explores + benchmark tiles)

ALTER TABLE migration_jobs

  ADD COLUMN IF NOT EXISTS migration_scope JSONB;



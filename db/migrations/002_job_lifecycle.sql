-- Idempotency + worker heartbeat for migration jobs
ALTER TABLE migration_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE migration_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_migration_jobs_idempotency
  ON migration_jobs (user_email, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_migration_jobs_heartbeat
  ON migration_jobs (status, heartbeat_at)
  WHERE status = 'running';

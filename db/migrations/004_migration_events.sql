-- Job activity timeline: deploys, diagnoses, test summaries, pauses
CREATE TABLE IF NOT EXISTS migration_events (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
  iteration_number INT,
  event_type TEXT NOT NULL,
  -- phase_start | inventory_done | baseline_done | generate_done | deploy_done
  -- | deploy_failed | test_summary | diagnose | needs_input | awaiting_approval
  -- | failed | published | info
  title TEXT NOT NULL,
  detail TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_migration_events_job
  ON migration_events(job_id, created_at);

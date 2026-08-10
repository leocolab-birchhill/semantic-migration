-- Migration jobs: one per Looker → Databricks migration attempt
CREATE TABLE IF NOT EXISTS migration_jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  -- Looker source
  looker_source_type TEXT NOT NULL, -- 'explore' | 'dashboard'
  looker_model TEXT,
  looker_explore TEXT,
  looker_dashboard_id TEXT,
  looker_dashboard_title TEXT,
  -- Databricks target
  databricks_host TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  catalog TEXT NOT NULL,
  source_schema TEXT NOT NULL,
  source_table TEXT NOT NULL,
  dev_schema TEXT NOT NULL,
  prod_schema TEXT,
  -- Config
  max_iterations INT NOT NULL DEFAULT 5,
  decimal_scale INT NOT NULL DEFAULT 2,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- State
  current_phase TEXT NOT NULL DEFAULT 'inventory',
  iteration_count INT NOT NULL DEFAULT 0,
  inventory JSONB,
  parity_report JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_migration_jobs_status ON migration_jobs(status);
CREATE INDEX IF NOT EXISTS idx_migration_jobs_user ON migration_jobs(user_email);

-- Reconciliation iterations
CREATE TABLE IF NOT EXISTS migration_iterations (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
  iteration_number INT NOT NULL,
  phase TEXT NOT NULL,
  model_name TEXT,
  model_version TEXT,
  diagnosis TEXT,
  rationale TEXT,
  tests_run INT NOT NULL DEFAULT 0,
  tests_passed INT NOT NULL DEFAULT 0,
  tests_failed INT NOT NULL DEFAULT 0,
  needs_human_input BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, iteration_number)
);

CREATE INDEX IF NOT EXISTS idx_migration_iterations_job ON migration_iterations(job_id);

-- Versioned artifacts (SQL, YAML, test results, docs)
CREATE TABLE IF NOT EXISTS migration_artifacts (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
  iteration_id UUID REFERENCES migration_iterations(id) ON DELETE SET NULL,
  artifact_type TEXT NOT NULL, -- 'sql' | 'yaml' | 'test_result' | 'diff' | 'mapping' | 'documentation'
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_migration_artifacts_job ON migration_artifacts(job_id);

-- Individual test cases and results
CREATE TABLE IF NOT EXISTS migration_tests (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
  iteration_id UUID REFERENCES migration_iterations(id) ON DELETE SET NULL,
  test_name TEXT NOT NULL,
  test_type TEXT NOT NULL, -- 'tile' | 'measure' | 'dimension' | 'filter' | 'pivot' | 'total' | 'null' | 'timezone' | 'security'
  looker_query JSONB,
  looker_sql TEXT,
  looker_result JSONB,
  databricks_sql TEXT,
  databricks_result JSONB,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'pass' | 'fail' | 'error' | 'skipped'
  diff_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_migration_tests_job ON migration_tests(job_id);
CREATE INDEX IF NOT EXISTS idx_migration_tests_iteration ON migration_tests(iteration_id);

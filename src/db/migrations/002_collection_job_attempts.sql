-- Cloudflare D1 / SQLite compatible migration 002.
CREATE TABLE IF NOT EXISTS collection_job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  ota TEXT NOT NULL,
  stay_date TEXT NOT NULL,
  guests INTEGER NOT NULL,
  nights INTEGER NOT NULL,
  attempted_at_jst TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'skipped', 'blocked')),
  availability_status TEXT CHECK (
    availability_status IS NULL OR availability_status IN ('available', 'sold_out', 'not_listed', 'not_found', 'failed')
  ),
  price_total_tax_included INTEGER CHECK (
    price_total_tax_included IS NULL OR price_total_tax_included >= 0
  ),
  error_reason TEXT,
  screenshot_path TEXT,
  debug_json_path TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_job_attempts_job_id ON collection_job_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_collection_job_attempts_run_id ON collection_job_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_collection_job_attempts_stay_date ON collection_job_attempts(stay_date);
CREATE INDEX IF NOT EXISTS idx_collection_job_attempts_property_ota ON collection_job_attempts(property_id, ota);
CREATE INDEX IF NOT EXISTS idx_collection_job_attempts_attempted_at ON collection_job_attempts(attempted_at_jst);

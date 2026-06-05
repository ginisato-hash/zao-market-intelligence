-- Cloudflare D1 / SQLite compatible migration 004.
CREATE TABLE IF NOT EXISTS price_quality_flags (
  id TEXT PRIMARY KEY,
  rate_snapshot_id TEXT NOT NULL,
  source TEXT NOT NULL,
  property_id TEXT,
  stay_date TEXT NOT NULL,
  price_jpy INTEGER,
  flags_json TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('none', 'low', 'medium', 'high')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(rate_snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_price_quality_flags_snapshot_id ON price_quality_flags(rate_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_price_quality_flags_source ON price_quality_flags(source);
CREATE INDEX IF NOT EXISTS idx_price_quality_flags_stay_date ON price_quality_flags(stay_date);
CREATE INDEX IF NOT EXISTS idx_price_quality_flags_property_id ON price_quality_flags(property_id);
CREATE INDEX IF NOT EXISTS idx_price_quality_flags_severity ON price_quality_flags(severity);

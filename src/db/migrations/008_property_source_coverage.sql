-- Cloudflare D1 / SQLite compatible migration 008.
-- Property × source coverage foundation.
-- This is a coverage/candidate map, not price data. A new table is used
-- rather than overloading property_ota_links because coverage must also
-- track non-OTA sources (Google Hotels, official sites) and non-usable
-- states (blocked, captcha, login_required, unsupported, not_found).
CREATE TABLE IF NOT EXISTS property_source_coverage (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_property_id TEXT,
  property_url TEXT,
  coverage_status TEXT NOT NULL CHECK (
    coverage_status IN (
      'confirmed',
      'needs_review',
      'not_found',
      'blocked',
      'captcha',
      'login_required',
      'unsupported'
    )
  ),
  access_status TEXT,
  last_verified_at TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, source)
);

CREATE INDEX IF NOT EXISTS idx_property_source_coverage_property
  ON property_source_coverage(property_id);

CREATE INDEX IF NOT EXISTS idx_property_source_coverage_source
  ON property_source_coverage(source);

CREATE INDEX IF NOT EXISTS idx_property_source_coverage_status
  ON property_source_coverage(coverage_status);

CREATE INDEX IF NOT EXISTS idx_property_source_coverage_active
  ON property_source_coverage(active);

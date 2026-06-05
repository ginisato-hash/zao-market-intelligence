-- Cloudflare D1 / SQLite compatible migration 009.
-- Source-coverage candidates: verification TODOs for property/source pairs we
-- want to cover but for which we do not yet have a verified URL or source id.
-- This is deliberately separate from property_source_coverage so unverified
-- candidates never pollute active coverage. Promotion to coverage is a manual,
-- tested step (Phase 43X). No price data is ever stored here.
CREATE TABLE IF NOT EXISTS source_coverage_candidates (
  id TEXT PRIMARY KEY,
  property_id TEXT,
  property_name TEXT NOT NULL,
  source TEXT NOT NULL,
  candidate_property_url TEXT,
  candidate_source_property_id TEXT,
  candidate_label TEXT,
  evidence_note TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (
    verification_status IN (
      'candidate',
      'confirmed',
      'rejected',
      'needs_review'
    )
  ),
  reviewer_note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_name, source, candidate_property_url, candidate_source_property_id)
);

CREATE INDEX IF NOT EXISTS idx_source_coverage_candidates_property
  ON source_coverage_candidates(property_id);

CREATE INDEX IF NOT EXISTS idx_source_coverage_candidates_source
  ON source_coverage_candidates(source);

CREATE INDEX IF NOT EXISTS idx_source_coverage_candidates_status
  ON source_coverage_candidates(verification_status);

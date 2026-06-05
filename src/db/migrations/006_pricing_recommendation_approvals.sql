-- Cloudflare D1 / SQLite compatible migration 006.
CREATE TABLE IF NOT EXISTS pricing_recommendation_approvals (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stay_date TEXT NOT NULL,
  source_market TEXT NOT NULL,
  approval_status TEXT NOT NULL CHECK (
    approval_status IN ('auto_approved', 'needs_review', 'rejected')
  ),
  reasons_json TEXT NOT NULL,
  audit_flags_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(recommendation_id)
);

CREATE INDEX IF NOT EXISTS idx_pricing_recommendation_approvals_recommendation_id ON pricing_recommendation_approvals(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_pricing_recommendation_approvals_target_id ON pricing_recommendation_approvals(target_id);
CREATE INDEX IF NOT EXISTS idx_pricing_recommendation_approvals_stay_date ON pricing_recommendation_approvals(stay_date);
CREATE INDEX IF NOT EXISTS idx_pricing_recommendation_approvals_status ON pricing_recommendation_approvals(approval_status);

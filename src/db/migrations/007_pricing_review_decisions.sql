-- Cloudflare D1 / SQLite compatible migration 007.
-- Stores imported human manual-review decisions, separate from recommendations and approvals.
CREATE TABLE IF NOT EXISTS pricing_review_decisions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  stay_date TEXT NOT NULL,
  source_market TEXT NOT NULL,
  recommended_price_jpy INTEGER,
  approval_status TEXT NOT NULL,
  review_decision TEXT NOT NULL CHECK (
    review_decision IN ('pending','approved','rejected','needs_change')
  ),
  reviewer_note TEXT,
  imported_from_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(target_id, stay_date, source_market)
);

CREATE INDEX IF NOT EXISTS idx_pricing_review_decisions_stay_date ON pricing_review_decisions(stay_date);
CREATE INDEX IF NOT EXISTS idx_pricing_review_decisions_target_id ON pricing_review_decisions(target_id);
CREATE INDEX IF NOT EXISTS idx_pricing_review_decisions_review_decision ON pricing_review_decisions(review_decision);

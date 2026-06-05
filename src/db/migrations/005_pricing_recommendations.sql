-- Cloudflare D1 / SQLite compatible migration 005.
-- Existing local databases are rebuilt compatibly by src/db/client.ts.
CREATE INDEX IF NOT EXISTS idx_pricing_recommendations_stay_date ON pricing_recommendations(stay_date);

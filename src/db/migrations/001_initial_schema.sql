-- Cloudflare D1 / SQLite compatible initial schema.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  area_name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  property_type TEXT NOT NULL DEFAULT 'unknown' CHECK (property_type IN ('ryokan', 'hotel', 'pension', 'minshuku', 'lodge', 'vacation_rental', 'apartment', 'guesthouse', 'unknown')),
  price_segment TEXT NOT NULL DEFAULT 'unknown' CHECK (price_segment IN ('economy', 'midscale', 'upper_midscale', 'luxury', 'unknown')),
  meal_style TEXT NOT NULL DEFAULT 'unknown' CHECK (meal_style IN ('room_only', 'breakfast', 'half_board', 'mixed', 'unknown')),
  has_onsen INTEGER CHECK (has_onsen IS NULL OR has_onsen IN (0, 1)),
  ski_access TEXT NOT NULL DEFAULT 'unknown' CHECK (ski_access IN ('ski_in_out', 'walkable', 'shuttle', 'car', 'unknown')),
  room_count_estimate INTEGER CHECK (room_count_estimate IS NULL OR room_count_estimate >= 0),
  max_capacity_estimate INTEGER CHECK (max_capacity_estimate IS NULL OR max_capacity_estimate >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, postal_code)
);

CREATE TABLE IF NOT EXISTS property_ota_links (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  ota TEXT NOT NULL,
  ota_property_id TEXT,
  url TEXT NOT NULL DEFAULT '',
  property_url TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_verified_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  UNIQUE (property_id, ota)
);

CREATE TABLE IF NOT EXISTS collector_runs (
  id TEXT PRIMARY KEY,
  ota TEXT NOT NULL,
  started_at_jst TEXT NOT NULL,
  finished_at_jst TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  ota TEXT NOT NULL,
  stay_date TEXT NOT NULL,
  guests INTEGER NOT NULL CHECK (guests > 0),
  nights INTEGER NOT NULL CHECK (nights > 0),
  price_jpy INTEGER CHECK (price_jpy IS NULL OR price_jpy >= 0),
  price_total_tax_included INTEGER CHECK (price_total_tax_included IS NULL OR price_total_tax_included >= 0),
  availability_status TEXT NOT NULL CHECK (availability_status IN ('available', 'sold_out', 'not_listed', 'not_found', 'failed')),
  confidence TEXT NOT NULL CHECK (confidence IN ('A', 'B', 'C')),
  checked_at_jst TEXT NOT NULL,
  screenshot_key TEXT,
  raw_text_excerpt TEXT,
  error_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES collector_runs(id),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  CHECK (
    (availability_status = 'available' AND price_total_tax_included IS NOT NULL)
    OR (availability_status <> 'available' AND price_total_tax_included IS NULL)
  ),
  CHECK (
    (availability_status = 'failed' AND error_reason IS NOT NULL)
    OR (availability_status <> 'failed')
  ),
  UNIQUE (run_id, property_id, ota, stay_date, guests, nights, availability_status)
);

CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  ota TEXT NOT NULL,
  stay_date TEXT NOT NULL,
  availability_status TEXT NOT NULL CHECK (availability_status IN ('available', 'sold_out', 'not_listed', 'not_found', 'failed')),
  confidence TEXT NOT NULL CHECK (confidence IN ('A', 'B', 'C')),
  checked_at_jst TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES collector_runs(id),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  UNIQUE (run_id, property_id, ota, stay_date, availability_status)
);

CREATE TABLE IF NOT EXISTS market_daily_signals (
  id TEXT PRIMARY KEY,
  stay_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'jalan',
  postal_code TEXT NOT NULL,
  median_price_jpy INTEGER CHECK (median_price_jpy IS NULL OR median_price_jpy >= 0),
  min_price_jpy INTEGER CHECK (min_price_jpy IS NULL OR min_price_jpy >= 0),
  max_price_jpy INTEGER CHECK (max_price_jpy IS NULL OR max_price_jpy >= 0),
  quality_adjusted_median_price_jpy INTEGER CHECK (quality_adjusted_median_price_jpy IS NULL OR quality_adjusted_median_price_jpy >= 0),
  quality_adjusted_min_price_jpy INTEGER CHECK (quality_adjusted_min_price_jpy IS NULL OR quality_adjusted_min_price_jpy >= 0),
  quality_adjusted_max_price_jpy INTEGER CHECK (quality_adjusted_max_price_jpy IS NULL OR quality_adjusted_max_price_jpy >= 0),
  quality_adjusted_sample_size INTEGER NOT NULL DEFAULT 0 CHECK (quality_adjusted_sample_size >= 0),
  excluded_quality_flag_count INTEGER NOT NULL DEFAULT 0 CHECK (excluded_quality_flag_count >= 0),
  excluded_high_severity_count INTEGER NOT NULL DEFAULT 0 CHECK (excluded_high_severity_count >= 0),
  quality_adjustment_reason TEXT,
  available_count INTEGER NOT NULL DEFAULT 0 CHECK (available_count >= 0),
  sold_out_count INTEGER NOT NULL DEFAULT 0 CHECK (sold_out_count >= 0),
  not_listed_count INTEGER NOT NULL DEFAULT 0 CHECK (not_listed_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  sample_size INTEGER NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  confidence TEXT NOT NULL CHECK (confidence IN ('A', 'B', 'C', 'insufficient')),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (stay_date, source, postal_code)
);

CREATE TABLE IF NOT EXISTS pricing_targets (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id),
  UNIQUE (property_id)
);

CREATE TABLE IF NOT EXISTS target_inventory_snapshots (
  id TEXT PRIMARY KEY,
  pricing_target_id TEXT NOT NULL,
  stay_date TEXT NOT NULL,
  rooms_available INTEGER CHECK (rooms_available IS NULL OR rooms_available >= 0),
  checked_at_jst TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pricing_target_id) REFERENCES pricing_targets(id),
  UNIQUE (pricing_target_id, stay_date, checked_at_jst)
);

CREATE TABLE IF NOT EXISTS pricing_recommendations (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  stay_date TEXT NOT NULL,
  source_market TEXT NOT NULL,
  target_priority TEXT,
  raw_market_median_jpy INTEGER,
  quality_adjusted_market_median_jpy INTEGER,
  baseline_adr_jpy INTEGER NOT NULL,
  recommended_price_jpy INTEGER,
  min_price_jpy INTEGER,
  max_price_jpy INTEGER,
  confidence TEXT NOT NULL CHECK (confidence IN ('A', 'B', 'C', 'fallback')),
  recommendation_reason TEXT NOT NULL,
  market_signal_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (target_id, stay_date, source_market)
);

CREATE TABLE IF NOT EXISTS target_dates (
  target_date_id TEXT PRIMARY KEY,
  stay_date TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('S', 'A', 'B', 'C')),
  reason TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (stay_date)
);

CREATE INDEX IF NOT EXISTS idx_properties_postal_code ON properties(postal_code);
CREATE INDEX IF NOT EXISTS idx_property_ota_links_property_id ON property_ota_links(property_id);
CREATE INDEX IF NOT EXISTS idx_property_ota_links_ota ON property_ota_links(ota);
CREATE INDEX IF NOT EXISTS idx_collector_runs_ota ON collector_runs(ota);
CREATE INDEX IF NOT EXISTS idx_collector_runs_started_at_jst ON collector_runs(started_at_jst);
CREATE INDEX IF NOT EXISTS idx_rate_snapshots_stay_date ON rate_snapshots(stay_date);
CREATE INDEX IF NOT EXISTS idx_rate_snapshots_property_id ON rate_snapshots(property_id);
CREATE INDEX IF NOT EXISTS idx_rate_snapshots_ota ON rate_snapshots(ota);
CREATE INDEX IF NOT EXISTS idx_rate_snapshots_checked_at_jst ON rate_snapshots(checked_at_jst);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_stay_date ON inventory_snapshots(stay_date);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_property_id ON inventory_snapshots(property_id);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_ota ON inventory_snapshots(ota);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_checked_at_jst ON inventory_snapshots(checked_at_jst);
CREATE INDEX IF NOT EXISTS idx_market_daily_signals_stay_date ON market_daily_signals(stay_date);
CREATE INDEX IF NOT EXISTS idx_target_inventory_snapshots_stay_date ON target_inventory_snapshots(stay_date);
CREATE INDEX IF NOT EXISTS idx_target_inventory_snapshots_checked_at_jst ON target_inventory_snapshots(checked_at_jst);
CREATE INDEX IF NOT EXISTS idx_pricing_recommendations_stay_date ON pricing_recommendations(stay_date);
CREATE INDEX IF NOT EXISTS idx_target_dates_stay_date ON target_dates(stay_date);
CREATE INDEX IF NOT EXISTS idx_target_dates_priority ON target_dates(priority);
CREATE INDEX IF NOT EXISTS idx_target_dates_active ON target_dates(active);

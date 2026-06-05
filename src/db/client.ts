import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type LocalDatabase = Database.Database;

export const DEFAULT_LOCAL_DB_PATH = ".data/zao-market-intelligence.sqlite";

export function openLocalDatabase(path = DEFAULT_LOCAL_DB_PATH): LocalDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

export function executeMigration(db: LocalDatabase): void {
  const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  applyCompatibleAlterations(db);
}

export function runInTransaction<T>(db: LocalDatabase, work: () => T): T {
  return db.transaction(work)();
}

export function closeDatabase(db: LocalDatabase): void {
  db.close();
}

interface TableInfoRow {
  name: string;
}

function applyCompatibleAlterations(db: LocalDatabase): void {
  addMissingColumns(db, "properties", [
    "address TEXT",
    "lat REAL",
    "lng REAL",
    "property_type TEXT NOT NULL DEFAULT 'unknown'",
    "price_segment TEXT NOT NULL DEFAULT 'unknown'",
    "meal_style TEXT NOT NULL DEFAULT 'unknown'",
    "has_onsen INTEGER",
    "ski_access TEXT NOT NULL DEFAULT 'unknown'",
    "room_count_estimate INTEGER",
    "max_capacity_estimate INTEGER",
    "active INTEGER NOT NULL DEFAULT 1",
    "notes TEXT"
  ]);
  addMissingColumns(db, "property_ota_links", [
    "ota_property_id TEXT",
    "property_url TEXT",
    "active INTEGER NOT NULL DEFAULT 1",
    "last_verified_at TEXT",
    "notes TEXT"
  ]);

  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_properties_active ON properties(active);
    CREATE INDEX IF NOT EXISTS idx_properties_property_type ON properties(property_type);
    CREATE INDEX IF NOT EXISTS idx_properties_price_segment ON properties(price_segment);
    CREATE INDEX IF NOT EXISTS idx_properties_meal_style ON properties(meal_style);
    CREATE INDEX IF NOT EXISTS idx_property_ota_links_active ON property_ota_links(active);
    CREATE INDEX IF NOT EXISTS idx_target_dates_stay_date ON target_dates(stay_date);
    CREATE INDEX IF NOT EXISTS idx_target_dates_priority ON target_dates(priority);
    CREATE INDEX IF NOT EXISTS idx_target_dates_active ON target_dates(active);
  `);
  ensureMarketDailySignalsSchema(db);
  ensurePricingRecommendationsSchema(db);
}

function addMissingColumns(db: LocalDatabase, table: string, definitions: string[]): void {
  const existingColumns = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => (row as TableInfoRow).name)
  );

  for (const definition of definitions) {
    const columnName = definition.split(" ")[0];
    if (columnName !== undefined && !existingColumns.has(columnName)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }
}

function ensureMarketDailySignalsSchema(db: LocalDatabase): void {
  const existingColumns = new Set(
    db
      .prepare("PRAGMA table_info(market_daily_signals)")
      .all()
      .map((row) => (row as TableInfoRow).name)
  );
  const tableSql =
    (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'market_daily_signals'")
        .get() as { sql: string } | undefined
    )?.sql ?? "";

  const needsRebuild =
    !existingColumns.has("source") ||
    !existingColumns.has("min_price_jpy") ||
    !existingColumns.has("max_price_jpy") ||
    !existingColumns.has("not_listed_count") ||
    !existingColumns.has("sample_size") ||
    !existingColumns.has("generated_at") ||
    !tableSql.includes("'insufficient'") ||
    !tableSql.includes("UNIQUE (stay_date, source, postal_code)");

  if (!needsRebuild) {
    addMissingColumns(db, "market_daily_signals", [
      "quality_adjusted_median_price_jpy INTEGER",
      "quality_adjusted_min_price_jpy INTEGER",
      "quality_adjusted_max_price_jpy INTEGER",
      "quality_adjusted_sample_size INTEGER NOT NULL DEFAULT 0",
      "excluded_quality_flag_count INTEGER NOT NULL DEFAULT 0",
      "excluded_high_severity_count INTEGER NOT NULL DEFAULT 0",
      "quality_adjustment_reason TEXT"
    ]);
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS market_daily_signals_v2 (
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

    INSERT OR IGNORE INTO market_daily_signals_v2 (
      id,
      stay_date,
      source,
      postal_code,
      median_price_jpy,
      available_count,
      sold_out_count,
      failed_count,
      confidence,
      created_at,
      updated_at
    )
    SELECT
      id,
      stay_date,
      'jalan',
      postal_code,
      median_price_jpy,
      available_count,
      sold_out_count,
      failed_count,
      confidence,
      created_at,
      updated_at
    FROM market_daily_signals;

    DROP TABLE market_daily_signals;
    ALTER TABLE market_daily_signals_v2 RENAME TO market_daily_signals;
    CREATE INDEX IF NOT EXISTS idx_market_daily_signals_stay_date ON market_daily_signals(stay_date);
    CREATE INDEX IF NOT EXISTS idx_market_daily_signals_source ON market_daily_signals(source);
    CREATE INDEX IF NOT EXISTS idx_market_daily_signals_postal_code ON market_daily_signals(postal_code);
  `);
}

function ensurePricingRecommendationsSchema(db: LocalDatabase): void {
  const existingColumns = new Set(
    db
      .prepare("PRAGMA table_info(pricing_recommendations)")
      .all()
      .map((row) => (row as TableInfoRow).name)
  );
  const tableSql =
    (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pricing_recommendations'")
        .get() as { sql: string } | undefined
    )?.sql ?? "";
  const needsRebuild =
    !existingColumns.has("target_id") ||
    !existingColumns.has("source_market") ||
    !existingColumns.has("raw_market_median_jpy") ||
    !existingColumns.has("quality_adjusted_market_median_jpy") ||
    !existingColumns.has("baseline_adr_jpy") ||
    !existingColumns.has("confidence") ||
    !existingColumns.has("recommendation_reason") ||
    !existingColumns.has("updated_at") ||
    !tableSql.includes("UNIQUE (target_id, stay_date, source_market)");

  if (!needsRebuild) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_recommendations_v2 (
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

    INSERT OR IGNORE INTO pricing_recommendations_v2 (
      id,
      target_id,
      stay_date,
      source_market,
      baseline_adr_jpy,
      recommended_price_jpy,
      confidence,
      recommendation_reason,
      created_at,
      updated_at
    )
    SELECT
      id,
      COALESCE(pricing_target_id, 'legacy_target'),
      stay_date,
      'jalan',
      recommended_price_jpy,
      recommended_price_jpy,
      'fallback',
      COALESCE(reason, 'legacy_recommendation'),
      created_at,
      created_at
    FROM pricing_recommendations
    WHERE EXISTS (
      SELECT 1 FROM pragma_table_info('pricing_recommendations') WHERE name = 'pricing_target_id'
    );

    DROP TABLE pricing_recommendations;
    ALTER TABLE pricing_recommendations_v2 RENAME TO pricing_recommendations;
    CREATE INDEX IF NOT EXISTS idx_pricing_recommendations_target_id ON pricing_recommendations(target_id);
    CREATE INDEX IF NOT EXISTS idx_pricing_recommendations_source_market ON pricing_recommendations(source_market);
    CREATE INDEX IF NOT EXISTS idx_pricing_recommendations_stay_date ON pricing_recommendations(stay_date);
  `);
}

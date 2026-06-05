# zao-market-intelligence

Reusable Phase 0-6 foundation for OTA lodging market intelligence in postal code `990-2301`, Zao Onsen, Japan.

This project currently contains only offline, deterministic foundations:

- domain types for market data and future pricing records
- a mock collector with available, sold-out, not-listed, and failed outcomes
- SQLite / Cloudflare D1-compatible schema migration
- local SQLite persistence for mock collector facts
- property master and OTA-link seed import for initial `990-2301` lodging records
- target-date seed import and local collection job planning
- Cloudflare D1/R2 preparation scaffolding without requiring remote credentials
- first low-volume Jalan collector prototype scaffold
- utility functions for prices, dates, IDs, and confidence-aware statistics
- local tests for the core rules

It does not implement real OTA scraping, Miuraya-specific logic, pricing recommendations, Beds24 CSV generation, or AirHost XLSX generation.

## Requirements

- Node.js 22+
- npm

## Setup

```bash
npm install
npm run db:migrate
npm run seed:properties
npm run seed:target-dates
```

## Scripts

```bash
npm run test
npm run typecheck
npm run collect:mvp
npm run db:migrate
npm run collect:persist:mvp
npm run seed:properties
npm run seed:target-dates
npm run db:list:properties
npm run plan:jobs
npm run collect:planned:mock
npm run db:verify
npm run db:schema:print
```

`collect:mvp` runs the offline mock collector only.

`db:migrate` applies the D1-compatible migration to the local SQLite database at `.data/zao-market-intelligence.sqlite`.

`collect:persist:mvp` runs the mock collector and persists available, sold-out, not-listed, and failed facts to the local database.

`seed:properties` imports sample property master data and OTA-link placeholders from:

- `data/seeds/properties.990-2301.sample.json`
- `data/seeds/property_ota_links.990-2301.sample.json`

Edit these seed files manually when improving the property master. Keep unknown OTA URLs as `property_url: null`; do not invent OTA URLs, scrape websites, or add unverified links.

The included sample records are not a complete or fully verified list of all `990-2301` lodging properties. Every row should be manually verified before production use.

`db:list:properties` prints property counts, segmentation counts, OTA-link counts, and active properties that do not yet have active OTA links.

`seed:target-dates` imports sample target dates from `data/seeds/target_dates.990-2301.sample.json`. The sample dates are planning examples only and should be manually reviewed before production use.

`plan:jobs` builds local collection jobs from active properties, active OTA links, active target dates, and one fixed search condition: 2 adults, 0 children, 1 room, 1 night, JPY, total tax included.

Jobs with `property_url: null` are still included in planning so gaps stay visible, but they are not directly fetchable by a real collector yet.

`collect:planned:mock` builds planned jobs, executes a small max-10 mock collection run, and persists deterministic mock results. It does not access the internet.

`db:verify` checks local persistence invariants:

- failed, sold-out, and not-listed rows must not have price data
- failed rows must have `error_reason`

`db:schema:print` prints the initial D1-compatible SQL migration.

Real OTA scraping and browser access to OTA websites are intentionally not implemented yet.

## Cloudflare Preparation

Cloudflare scaffolding is present but remote deployment is manual and optional:

- `wrangler.toml` defines placeholder bindings for D1 (`ZAO_MARKET_DB`) and R2 (`ZAO_MARKET_SCREENSHOTS`).
- `docs/cloudflare-setup.md` explains how to create the D1 database, create the R2 bucket, update the D1 database ID, apply migrations, and verify tables.
- `src/db/cloudflare/verify_tables.sql` contains D1-compatible table verification SQL.

Environment mode defaults to local:

```env
DATABASE_MODE=local
LOCAL_DB_PATH=.data/zao-market-intelligence.sqlite
SCREENSHOT_STORAGE=local
LOCAL_SCREENSHOT_DIR=.data/screenshots
```

Future D1/R2 mode is represented by config placeholders:

```env
DATABASE_MODE=d1
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_D1_DATABASE_ID=
CLOUDFLARE_R2_BUCKET=zao-market-screenshots
SCREENSHOT_STORAGE=r2
```

Cloudflare scripts are available for manual use, but normal tests and local mock runs do not require Cloudflare login:

```bash
npm run cf:d1:list
npm run cf:d1:migrate:local
npm run cf:d1:migrate:remote
npm run cf:d1:verify:local
npm run cf:d1:verify:remote
npm run cf:r2:list
```

Remote Cloudflare commands may fail until Wrangler is installed, the user is logged in, and `wrangler.toml` has a real `database_id`.

## Screenshots

Screenshot storage is abstracted behind `ScreenshotStorage`.

- `LocalScreenshotStorage` writes to `.data/screenshots`.
- `NotImplementedR2ScreenshotStorage` throws a clear Phase 5 error.
- Screenshot keys use `screenshots/YYYY/MM/DD/run_id/property_id/ota/stay_date/job_id.png`.

Real R2 uploads will be implemented later.

## Jalan Prototype

Phase 6 adds a conservative Jalan prototype collector for one manually configured property URL and one or two dates.

Edit this file before running the real prototype:

```txt
data/prototype/jalan.prototype.json
```

Replace the placeholders:

```json
{
  "property_name": "MANUAL_PROPERTY_NAME_REQUIRED",
  "property_url": "MANUAL_PROPERTY_URL_REQUIRED",
  "stay_dates": ["YYYY-MM-DD"]
}
```

Use only a manually verified Jalan property URL. Do not invent URLs, crawl search results, use login sessions, bypass CAPTCHA, or run high-volume scraping.

Dry-run validates the config and prints planned attempts without opening a browser, writing DB rows, or creating screenshots:

```bash
npm run collect:jalan:prototype:dry-run
```

The checked-in placeholder config intentionally fails clearly until edited.

After adding one verified URL, run the low-volume prototype:

```bash
npm run collect:jalan:prototype
```

The prototype:

- opens one configured Jalan page with Playwright
- attempts only one or two configured stay dates
- captures local screenshots under `.data/screenshots/`
- persists `available`, `sold_out`, `not_listed`, or `failed`
- never invents prices for unavailable or failed states
- stores `error_reason` when blocked, unclear, timed out, or no conservative price/status can be found

Inspect the local DB afterward:

```bash
npm run db:verify
```

This is not full Jalan crawling and not production scraping.

## GitHub Actions

`.github/workflows/manual-validation.yml` provides a manual `workflow_dispatch` validation flow for typecheck, tests, local migration, seed import, planning, planned mock collection, and DB verification.

No scheduled cron has been added.

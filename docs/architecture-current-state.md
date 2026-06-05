# Architecture — Current State

Reusable OTA lodging market intelligence and pricing recommendation system for
Zao Onsen (postal code `990-2301`).

This document describes the system as it exists today. It is a point-in-time
snapshot for onboarding and review; it is not a roadmap.

Status legend: **active** = in production use · **parked** = investigated, not in
use · **feasibility only** = research/no collection · **planned** = designed,
not yet implemented.

---

## 1. Source strategy

The system collects only from **free, direct** sources. Paid data acquisition of
any kind is forbidden (see [Non-goals](#4-non-goals)).

| Source | Status | Notes |
|---|---|---|
| **Jalan (じゃらん)** | **active** | Sole production source. Direct Playwright collection of verified property URLs. |
| **Rakuten Travel (楽天トラベル)** | **parked** | Parked after Phase 23. Date picker is a custom widget (`f_nen*/f_tuki*/f_hi*` hidden inputs), not a standard `input[type=date]`. A single targeted direct-field-write experiment (Phase 27R) is documented but deferred until Jalan scale-up is stable. |
| **Booking.com** | **parked** | Page body appears empty/blocked (Akamai Bot Manager). No free direct path available without bypassing anti-bot controls, which is forbidden. |
| **Google Hotels** | **feasibility only** | Research only. SPA with reCAPTCHA + CDP detection blocks headless direct collection. The paid SerpAPI route is forbidden, so there is no implementation path; no collection occurs. |

The machine-readable encoding of this policy lives in
`data/config/source_capabilities.free-only.json` and is enforced by the source
capability registry (`src/services/sourceCapabilityRegistry.ts`) and the
`check:no-paid-sources` guard.

---

## 2. Data pipeline

Stages run left to right. Each stage reads from the local SQLite DB and writes to
its own table(s); raw collected data is never mutated by later stages.

```
verified URL seeds
      │
target date generator ──► target_dates
      │
budgeted planned runner (Jalan)
      │
      ├─► rate_snapshots         (price / availability, raw — immutable)
      ├─► inventory_snapshots    (inventory observations)
      └─► collection_job_attempts(per-attempt logging: outcome, paths, errors)
      │
audit reporting (run audit)      ──► read-only view over a collector run
      │
market signals (compute)         ──► market_daily_signals (raw median/min/max)
      │
quality flags (compute)          ──► price_quality_flags (suspicious-price flags)
      │
quality-adjusted signals         ──► market_daily_signals (adjusted fields, side by side with raw)
      │
pricing recommendations          ──► pricing_recommendations
      │
recommendation audit (read-only) ──► flags risky/low-confidence/fallback rows
      │
approval gate                    ──► (planned) pricing recommendation approvals
```

Stage notes:

- **Verified URL seeds** — only manually verified Jalan property URLs are seeded
  (`seed:jalan:verified`), resolved through the alias resolver so name variants
  map to canonical properties.
- **Target date generator** — produces the full-period target date set with
  priorities (`S/A/B/C`) written to `target_dates`.
- **Budgeted planned runner** — DB-driven Jalan runner that respects a request
  budget; supports dry-run mode.
- **Snapshots** — `rate_snapshots` (price + availability) and
  `inventory_snapshots`. Raw rows are preserved unchanged for all downstream use.
- **Attempt logging** — every collection attempt is logged in
  `collection_job_attempts` (outcome, screenshot path, debug JSON path, error
  reason), independent of whether a snapshot was produced.
- **Audit reporting** — source-agnostic, read-only report over a collector run
  (`inspect:audit`); cross-checks snapshots vs. attempts and surfaces data
  integrity warnings.
- **Market signals** — per-stay-date raw median / min / max and confidence from
  the latest snapshot per property/date.
- **Quality flags** — flags suspicious prices (e.g. too-low absolute, too-low vs
  market, single-sample low confidence) in a separate table; raw prices remain
  untouched.
- **Quality-adjusted signals** — recomputes medians excluding high-severity
  flagged rows; stored alongside the raw metrics in `market_daily_signals`.
- **Pricing recommendations** — derives a recommended price per target/date using
  quality-adjusted median → raw median → baseline ADR fallback, priority
  multipliers, min/max clamp, and rounding. No invented prices.
- **Recommendation audit** — read-only audit over `pricing_recommendations`
  (`audit:pricing-recommendations`) flagging fallback, low-confidence, raw
  quality-excluded fallback, adjusted-unavailable, clamped, large-gap, and
  no-signal rows.
- **Approval gate** *(planned, Phase 35)* — human/explicit approval step before a
  recommendation may be used downstream. Approval state to be recorded in its own
  table; recommendations remain immutable.

"No invented prices" policy: every recommended price traces to observed market
data or an explicitly marked baseline fallback; nothing is fabricated.

---

## 3. Tables

| Table | Purpose | Status |
|---|---|---|
| `properties` | Canonical property registry (name, postal code, attributes). | active |
| `property_ota_links` | Per-OTA links/identifiers for each property. | active |
| `target_dates` | Stay dates to collect, with priority and active flag. | active |
| `collector_runs` | One row per collection run (OTA, start time, status). | active |
| `rate_snapshots` | Raw price + availability observations (immutable). | active |
| `inventory_snapshots` | Raw inventory observations. | active |
| `collection_job_attempts` | Per-attempt log (outcome, paths, error reason). | active |
| `market_daily_signals` | Raw and quality-adjusted daily market metrics, side by side. | active |
| `price_quality_flags` | Suspicious-price flags with severity, keyed to a snapshot. | active |
| `pricing_recommendations` | Derived recommendations with reason, confidence, clamp/fallback metadata. | active |
| *pricing recommendation approvals* | Approval/sign-off state for recommendations. | **planned (Phase 35)** |

Schema source of truth: `src/db/migrations/` (`001_initial_schema.sql`,
`002_collection_job_attempts.sql`, `004_price_quality_flags.sql`,
`005_pricing_recommendations.sql`) plus the compatibility/rebuild logic in
`src/db/client.ts`. The same schema targets local SQLite and Cloudflare D1.

---

## 4. Non-goals

These are hard constraints, not preferences:

- **No paid APIs** of any kind for production operation.
- **No paid SERP APIs** — specifically no SerpAPI, DataForSEO.
- **No paid scraping platforms** — no Apify, Bright Data, Oxylabs, or similar.
- **No paid proxy services** / proxy rotation.
- **No CAPTCHA bypass**, stealth plugins, or anti-bot evasion.
- **No login / session-cookie injection** and **no hidden/internal APIs**.
- **No direct price upload** — the system produces recommendations only. It does
  not generate Beds24 CSV or AirHost XLSX and does not push prices to any OTA or
  channel manager.
- **No broad/at-scale scraping** — collection is limited to verified property
  URLs on planned target dates within a request budget.

`check:no-paid-sources` enforces the no-paid-source policy against both the
capability registry and `collect:`-prefixed package scripts.

---

## 5. Command map

Grouped by purpose. (Cloudflare `cf:*` commands manage D1/R2 infra and are
omitted here.)

### Seed / import
- `seed:properties` — import property seeds.
- `seed:property-aliases` — import property name aliases.
- `seed:jalan:verified` — import verified Jalan properties.
- `seed:target-dates` — import target date seeds.
- `target-dates:generate` — generate the full-period target date seed.

### Plan
- `plan:jobs` — plan collection jobs.
- `plan:jalan:budgeted` — plan budgeted Jalan jobs.

### Collect (Jalan active; others parked)
- `collect:jalan:budgeted` / `:dry-run` — budgeted planned Jalan runner.
- `collect:jalan:prototype`, `collect:jalan:multi-date`,
  `collect:jalan:single-property`, `collect:jalan:three-property`,
  `collect:jalan:five-property` (each with `:dry-run`) — earlier-phase Jalan
  runners.
- `collect:rakuten:prototype` / `:dry-run` — **parked**.
- `collect:mvp`, `collect:persist:mvp`, `collect:planned:mock` — MVP / mock
  runners.

### Compute
- `market:compute` — compute raw + quality-adjusted market signals.
- `quality:compute` — compute price quality flags.
- `pricing:recommend` — generate pricing recommendations.

### Inspect
- `inspect:target-dates`, `inspect:market-signals`, `inspect:quality`,
  `inspect:pricing-recommendations`, `inspect:sources`.
- `inspect:audit` — run audit report.
- Latest-run inspectors: `inspect:jalan:latest`,
  `inspect:jalan:budgeted:latest`, `inspect:jalan:multi-date:latest`,
  `inspect:jalan:three-property:latest`, `inspect:jalan:five-property:latest`,
  `inspect:attempts:latest`, `inspect:rakuten:latest`.

### Audit
- `inspect:audit` — collector run audit (snapshots vs. attempts).
- `audit:pricing-recommendations` — read-only pricing recommendation audit
  (`AUDIT_OUTPUT=json` for JSON).

### Guard
- `check:no-paid-sources` — enforce the free-only policy.

### Database
- `db:migrate`, `db:list:properties`, `db:schema:print`, `db:verify`.

### Quality gates
- `typecheck` — `tsc --noEmit`.
- `test` — `vitest run`.

---

_Last updated for Phase D1 (after Phase 34 recommendation audit; Phase 35
approval gate in progress)._

# Work Order: First5 Source ID Verification

**File to fill:** `data/seeds/source_coverage_candidates.990-2301.first5.verified.local.json`
**Validator:** `npm run validate:first5-verified-candidates`
**SOP reference:** `docs/source-id-verification-sop.md`
**Checklist:** `docs/source-id-verification-checklist-first5.md`

> ⚠️ **Never copy an example source ID into another property row.** Every source ID must be verified against the exact physical property in a normal browser. If an ID was verified for a different property, it must not be reused.

---

## Step 1 — Copy the template

```bash
cp data/seeds/source_coverage_candidates.990-2301.first5.template.json \
   data/seeds/source_coverage_candidates.990-2301.first5.verified.local.json
```

Open the copy in a text editor. You will edit 15 rows in place — do not add or remove rows. Do not change `property_name` or `source` values.

---

## Target properties and sources

| property_name | rakuten | booking | google_hotels |
|---|---|---|---|
| 深山荘 高見屋 | verify | verify | verify |
| 名湯リゾート ルーセント | verify | verify | verify |
| ホテル喜らく | verify | verify | verify |
| BED'n ONSEN HAMMOND | verify | verify | verify |
| 蔵王温泉 JURIN | verify | verify | verify |

---

## Step 2 — Verify each row in a normal browser

For each row, open the OTA in a normal desktop browser (no proxy, no extensions that inject requests), search for the property, confirm the match, and fill in the fields.

---

### Source A: Rakuten Travel

**URL pattern:** `https://travel.rakuten.co.jp/HOTEL/[hotelNo]/`

**Procedure:**
1. Open `https://travel.rakuten.co.jp/` in a normal browser.
2. Search for the property name in Japanese (e.g. `深山荘 高見屋`). If no results, try a shortened form.
3. Click the matching listing. Confirm: property name, 蔵王温泉 location, and type match.
4. Extract the hotel number from the URL path: `…/HOTEL/[hotelNo]/`.

> ⚠️ The IDs already known for other properties in this project must not be used here. Each `[hotelNo]` must be found by directly searching for the specific target property.

**Fields when found — use `confirmed`:**
```json
{
  "candidate_property_url": "https://travel.rakuten.co.jp/HOTEL/[hotelNo]/",
  "candidate_source_property_id": "[hotelNo]",
  "candidate_label": "Rakuten Travel HOTEL/[hotelNo] — verified for [property_name]",
  "evidence_note": "First-party Rakuten Travel HOTEL/[hotelNo] page matched target property name and Zao Onsen location.",
  "verification_status": "confirmed",
  "reviewer_note": "Verified manually in normal browser on YYYY-MM-DD."
}
```

Replace `[hotelNo]` with the number you found, `[property_name]` with the exact `property_name` value of the row, and `YYYY-MM-DD` with today's date.

**Fields when NOT found:**
```json
{
  "candidate_property_url": null,
  "candidate_source_property_id": null,
  "candidate_label": "TODO: Add label once Rakuten hotel page is verified",
  "evidence_note": "Searched travel.rakuten.co.jp for [property name]. No matching result found.",
  "verification_status": "candidate",
  "reviewer_note": null
}
```

---

### Source B: Booking.com

**URL pattern:** `https://www.booking.com/hotel/jp/[slug].ja.html`

**Procedure:**
1. Open `https://www.booking.com/` in a normal browser. Append `?lang=ja` if the UI is in English.
2. Search for the property name + `蔵王` (e.g. `深山荘 高見屋 蔵王`).
3. Click the matching listing. Confirm: property name, 蔵王温泉 address, and type match.
4. Extract the slug from the URL: between `hotel/jp/` and `.ja.html`.

**Fields when found — use `needs_review` (not `confirmed`):**
```json
{
  "candidate_property_url": "https://www.booking.com/hotel/jp/[slug].ja.html",
  "candidate_source_property_id": "[slug]",
  "candidate_label": "Booking.com slug [slug] — verified for [property_name]",
  "evidence_note": "First-party Booking.com page matched target property name and Zao Onsen location. Price collectability not yet verified.",
  "verification_status": "needs_review",
  "reviewer_note": "Slug verified manually in normal browser on YYYY-MM-DD. Keeping needs_review — Booking free-direct price collectability is not confirmed stable."
}
```

Replace `[slug]`, `[property_name]`, and `YYYY-MM-DD` with actual values.

**Do not set `verification_status: "confirmed"` for Booking** unless you have personally confirmed stable, date-scoped, free/direct price extraction — and your `reviewer_note` explicitly mentions `content_visible`, `safe_price`, `collectab`, `stable_access`, or `price_extract`. The validator will error without that evidence.

**Fields when NOT found:**
```json
{
  "candidate_property_url": null,
  "candidate_source_property_id": null,
  "candidate_label": "TODO: Add label once Booking.com page is verified",
  "evidence_note": "Searched booking.com for [property name]. No matching hotel/jp/ page found.",
  "verification_status": "candidate",
  "reviewer_note": null
}
```

---

### Source C: Google Hotels

**URL pattern:** `https://www.google.com/travel/hotels/entity/[token]`

**Procedure:**
1. Open `https://www.google.com/travel/hotels` in a normal browser.
2. Search for the property name + `蔵王温泉` (e.g. `深山荘 高見屋 蔵王温泉`).
3. Click the property in the results panel to open the detail panel.
4. Read the URL — it should contain `/entity/[token]`.
5. Confirm: property name and 蔵王温泉, Yamagata location match.
6. Copy the entire token after `/entity/` — it is case-sensitive.

**Fields when found — use `needs_review` (not `confirmed`):**
```json
{
  "candidate_property_url": "https://www.google.com/travel/hotels/entity/[token]",
  "candidate_source_property_id": "[token]",
  "candidate_label": "Google Hotels entity [token] — verified for [property_name]",
  "evidence_note": "Google Hotels entity matched target property name and Zao Onsen location. Free-direct price collectability remains unresolved.",
  "verification_status": "needs_review",
  "reviewer_note": "Entity verified manually in normal browser on YYYY-MM-DD. Keeping needs_review — Google Hotels free-direct access may remain unsupported (consent/JS wall possible)."
}
```

Replace `[token]`, `[property_name]`, and `YYYY-MM-DD` with actual values.

**Do not set `verification_status: "confirmed"` for Google Hotels** merely because the entity token exists. The validator will error unless `reviewer_note` explicitly mentions `free_direct`, `content_visible`, `safe_price`, or `collectab`.

**Fields when NOT found:**
```json
{
  "candidate_property_url": null,
  "candidate_source_property_id": null,
  "candidate_label": "TODO: Add label once Google Hotels entity token is verified",
  "evidence_note": "Searched google.com/travel/hotels for [property name]. No matching entity found.",
  "verification_status": "candidate",
  "reviewer_note": null
}
```

---

## Step 3 — Pre-save self-check

Before saving, confirm every row:

- [ ] `property_name` is **unchanged** from the template.
- [ ] `source` is **unchanged** from the template.
- [ ] Every non-null `candidate_property_url` is a full `https://` URL in the correct format for its source.
- [ ] Every `confirmed` row has a non-blank `reviewer_note`.
- [ ] No `evidence_note` still starts with `TODO:`.
- [ ] No source ID was copied from an example or from a row belonging to a different property — each ID was found by directly searching for that exact target property.
- [ ] Exactly 15 rows remain — no additions, no deletions.

---

## Step 4 — Run the validator

```bash
FIRST5_VERIFIED_CANDIDATES_FILE=data/seeds/source_coverage_candidates.990-2301.first5.verified.local.json \
  npm run validate:first5-verified-candidates
```

**Pass criteria:**
```
structurally_valid=true
ready_for_import=true
errors_count=0
```

**Acceptable warnings:** `warning[row=N]=evidence_note is still a TODO placeholder` only for rows where the property was genuinely not found (status remains `candidate`, URL is null). These are non-blocking.

**Unacceptable:** any `error[row=...]` line. Fix the flagged row and re-run until `errors_count=0`.

---

## Step 5 — Submit for review

Do **not** run import or promotion yourself. Share the filled file and validator output for explicit approval before proceeding.

```bash
# NOT YET — await explicit approval before running either of these
SOURCE_COVERAGE_CANDIDATES_FILE=data/seeds/source_coverage_candidates.990-2301.first5.verified.local.json \
  npm run seed:source-coverage-candidates

npm run promote:source-coverage-candidates
```

Do not run import or promotion until the filled file and validator output have been reviewed and explicitly approved.

---

## Commands never to run during manual verification

```bash
npm run seed:source-coverage-candidates
npm run promote:source-coverage-candidates
npm run probe:rakuten
npm run probe:booking
npm run probe:google-hotels
npm run collect:jalan:auto-update
```

Manual verification is only for filling the local JSON file and running the validator.

---

## Never do any of the following

| Forbidden | Why |
|---|---|
| Copy a source ID from an example or a different property row | Each ID is property-specific; cross-attaching creates wrong coverage data |
| SerpAPI, DataForSEO, Bright Data, Oxylabs, Apify, or any paid proxy | Paid scraping services — not permitted |
| CAPTCHA bypass tools or stealth browser plugins | Not permitted |
| Logging in to any OTA, injecting cookies | Not permitted |
| Collecting prices, rate data, or inventory data | Out of scope for this phase |
| Beds24 CSV, AirHost XLSX generation | Out of scope for this phase |
| Uploading or applying prices | Permanently out of scope |
| Modifying `property_name` or `source` values | Template values must not change |

---

## After validation passes

Once `structurally_valid=true`, `ready_for_import=true`, and `errors_count=0` are confirmed, share the file and validator output. The next step (**Phase 45X**) will import the verified candidates and promote actionable rows into `property_source_coverage`.

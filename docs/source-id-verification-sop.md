# Source ID Verification SOP

Manual procedure for verifying a property's presence on Rakuten Travel, Booking.com, and Google Hotels, and recording the result as a `source_coverage_candidate` record for later promotion.

---

## 1. Purpose

Before the system can collect pricing data from a source, it needs a verified source-specific identifier for each property:

| Source | Identifier | Placeholder |
|---|---|---|
| Rakuten Travel | Hotel number (`hotelNo`) | `[hotelNo]` |
| Booking.com | URL slug | `[slug]` |
| Google Hotels | Entity token | `[token]` |

This SOP describes how to find each identifier manually in a normal browser, confirm it belongs to the correct property, and record the result in a candidate seed file.

---

## 2. Scope

This SOP covers the **first-5-property batch**: 5 properties × 3 sources = 15 candidate rows. The target properties are:

1. 深山荘 高見屋
2. 名湯リゾート ルーセント
3. ホテル喜らく
4. BED'n ONSEN HAMMOND
5. 蔵王温泉 JURIN

Target sources: **rakuten**, **booking**, **google_hotels**

---

## 3. Prerequisites

- A normal desktop browser (Chrome or Firefox recommended; no proxy, no extensions that modify requests).
- The template seed file: `data/seeds/source_coverage_candidates.990-2301.first5.template.json`.
- The checklist: `docs/source-id-verification-checklist-first5.md`.
- Basic familiarity with Japanese katakana/kanji property names. All five target properties are in Zao Onsen (蔵王温泉), Yamagata Prefecture.

**This SOP is for source ID verification only.**
It is not for price collection. It is not for PMS/OTA upload. It is not for Beds24 or AirHost file generation.

**Do NOT use any of the following:**
- Paid APIs or paid scraping services: SerpAPI, DataForSEO, Bright Data, Oxylabs, Apify, or any paid proxy.
- CAPTCHA bypass tools or stealth browser plugins.
- Login sessions, cookies, or session injection of any kind.
- Any internal or hidden API endpoint.
- Price collection, rate data, or inventory data extraction.
- OTA/PMS upload tools, Beds24 CSV generation, or AirHost XLSX generation.

**Do not run these commands during manual verification:**

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

## 4. Verification Principles

**Never copy an example source ID into another property row.** Every source ID must be verified against the exact physical property in a normal browser. If an ID was verified for a different property, it must not be reused.

**Identity confirmation is required.** Finding a page with a similar name is not enough. Before recording an ID, confirm:
- The property name on the OTA page matches the target property (allow for minor transliteration differences).
- The location is Zao Onsen, Yamagata (蔵王温泉, 山形県).
- The property type (ryokan, hotel, etc.) is consistent with what you know of this property.

**One record per property per source.** Do not create duplicate rows.

**Record uncertainty honestly.** If you are unsure about a match, set `verification_status: "needs_review"` and explain in `reviewer_note`. Do not set `confirmed` for a match you have not personally verified.

---

## 5. Rakuten Travel Verification

**Identifier:** Hotel number (`hotelNo`). Appears in the URL as `HOTEL/[number]/`.

**Search procedure:**

1. Open [https://travel.rakuten.co.jp/](https://travel.rakuten.co.jp/) in a normal browser.
2. In the search box, enter the property name in Japanese. Example: `深山荘 高見屋`.
3. If no results, try shortened or alternative romanization. Example: `高見屋`.
4. On the results page, click the hotel listing that matches.
5. Check that the detail page URL contains `HOTEL/[number]/`. Example pattern: `https://travel.rakuten.co.jp/HOTEL/[hotelNo]/`.
6. Confirm: property name, location (蔵王温泉), and type match.

**Extracting the ID:**

- Copy the number from the URL path: `https://travel.rakuten.co.jp/HOTEL/[hotelNo]/` → `"[hotelNo]"`.

**What to record:**

```json
{
  "candidate_property_url": "https://travel.rakuten.co.jp/HOTEL/[hotelNo]/",
  "candidate_source_property_id": "[hotelNo]"
}
```

**Not found:** If the property is absent or no page matches, leave both fields `null`, add `"evidence_note"` explaining what you searched and found, and set `"verification_status": "candidate"` (unchanged).

---

## 6. Booking.com Verification

**Identifier:** URL slug. Appears in the URL as `hotel/jp/[slug].ja.html`.

**Search procedure:**

1. Open [https://www.booking.com/](https://www.booking.com/) in a normal browser with Japanese locale if possible (append `?lang=ja` to URLs).
2. Search for the property name. Example: `深山荘 高見屋 蔵王`.
3. Click the listing. On the hotel detail page, read the URL.
4. The URL format is: `https://www.booking.com/hotel/jp/[slug].ja.html`.
5. Confirm: property name, Zao Onsen address, and hotel type.

**Extracting the ID:**

- Copy the slug between `hotel/jp/` and `.ja.html`: `https://www.booking.com/hotel/jp/[slug].ja.html` → `"[slug]"`.

**What to record:**

```json
{
  "candidate_property_url": "https://www.booking.com/hotel/jp/[slug].ja.html",
  "candidate_source_property_id": "[slug]"
}
```

**Not found / ambiguous:** Some properties may have multiple Booking.com listings (e.g., different room types listed as separate hotels). Pick the listing that most closely matches the primary property. Note ambiguity in `reviewer_note`.

---

## 7. Google Hotels Verification

**Identifier:** Entity token. Appears in the URL as `/entity/[token]`.

**Search procedure:**

1. Open [https://www.google.com/travel/hotels](https://www.google.com/travel/hotels) in a normal browser.
2. Search for `深山荘 高見屋 蔵王温泉` (property name + 蔵王温泉).
3. Click the property in the results list.
4. On the property detail panel, check the URL. It should contain `/entity/[token]`. Example pattern: `https://www.google.com/travel/hotels/entity/[token]`.
5. Confirm: name and location match.

**Extracting the ID:**

- Copy the token after `/entity/`: `[token]` (a long alphanumeric string — copy exactly, it is case-sensitive).

**What to record:**

```json
{
  "candidate_property_url": "https://www.google.com/travel/hotels/entity/[token]",
  "candidate_source_property_id": "[token]"
}
```

**Notes:**

- The URL token only appears in the entity detail panel, not in the search results list.
- If Google Hotels shows a consent screen or JavaScript wall, note this in `evidence_note` and set `verification_status: "needs_review"`. The entity token may still be extractable from the URL before the wall loads.
- Google Hotels entity tokens are long base64-like strings. Copy them exactly — they are case-sensitive.

---

## 8. Name Matching Guidance

Japanese property names on OTA sites may differ slightly from the canonical name used in this project. The following differences are acceptable:

| Acceptable variation | Example |
|---|---|
| Full-width / half-width space | `深山荘　高見屋` vs `深山荘 高見屋` |
| Different kanji for the same reading | Rare but check carefully |
| Added/removed honorific or type suffix | `ホテル喜らく` vs `喜らく` |
| English letters mixed with Japanese | `BED'n ONSEN HAMMOND` may appear with different casing |
| Prefecture or area name appended | `蔵王温泉 JURIN（山形県）` |

**Reject the match if:**
- The property name is substantially different (different kanji with different meaning).
- The location is not Zao Onsen / Yamagata.
- The property appears to be a different business at the same address.

---

## 9. Filling in Candidate Fields

| Field | What to write |
|---|---|
| `property_name` | Copy exactly from the template — do not change. |
| `source` | Copy exactly from the template — do not change. |
| `candidate_property_url` | Full HTTPS URL of the verified property page. Set to `null` if not found. |
| `candidate_source_property_id` | The extracted identifier string (hotel number, slug, or token). Set to `null` if not found. |
| `candidate_label` | Short human-readable description. Example: `"Rakuten Travel HOTEL/[hotelNo] — verified for [property_name]"`. |
| `evidence_note` | Replace the `TODO:` placeholder with a factual sentence describing what you found and how. Minimum: what you searched, what you found, and why you are confident (or not). |
| `verification_status` | See Section 10. |
| `reviewer_note` | Required when `verification_status` is `confirmed`. Summarise the basis for confidence. Optional but recommended for `needs_review`. |

---

## 10. Verification Status Guide

| Status | When to use |
|---|---|
| `candidate` | You have not yet searched, or searching returned no clear match. Leave the template rows as `candidate` if you cannot verify. |
| `needs_review` | You found a plausible match but have some uncertainty (ambiguous name, multiple listings, JS wall prevented full page load). Fill in the URL and ID you found; a second reviewer will confirm. |
| `confirmed` | You have personally verified the property page loads, the name and location match, and you are confident the ID is correct. `reviewer_note` is required. |
| `rejected` | You searched and confirmed the property is definitively absent from this source, or the found listing does not match. |

---

## 11. Evidence Note Examples

**Good (confirmed Rakuten):**
> Searched travel.rakuten.co.jp for "深山荘 高見屋". First result links to HOTEL/[hotelNo]. Overview page shows property name 深山荘 高見屋, location 蔵王温泉, Yamagata. Hotel number [hotelNo] confirmed.

**Good (needs_review Booking):**
> Found booking.com/hotel/jp/[slug].ja.html. Property name 深山荘 高見屋 listed; address shows 蔵王温泉. A second listing [slug]-annex also appeared — took the main building. Marking needs_review for second confirmation.

**Good (not found, kept as candidate):**
> Searched travel.rakuten.co.jp for "名湯リゾート ルーセント" and "ルーセント 蔵王". No results matched. Also tried romanized "Lucent". No Rakuten page found.

**Bad (too vague):**
> Found it on Rakuten.

**Bad (no property match check):**
> URL is https://travel.rakuten.co.jp/HOTEL/99999/. Looks right.

---

## 12. Submission Checklist

Before saving the filled-in seed file, verify:

- [ ] All 15 rows are present (5 properties × 3 sources).
- [ ] `property_name` values are unchanged from the template.
- [ ] `source` values are unchanged from the template.
- [ ] Every row where you found a match has both `candidate_property_url` and `candidate_source_property_id` filled in (not null).
- [ ] Every `confirmed` row has a non-blank `reviewer_note`.
- [ ] Every `evidence_note` no longer contains `TODO:`.
- [ ] The checklist table in `docs/source-id-verification-checklist-first5.md` is filled in to match.
- [ ] Run `npm run inspect:source-verification-templates -- data/seeds/source_coverage_candidates.990-2301.first5.template.json` to confirm `template_rows_count=15` (if the template is still in template form, `all_rows_candidate=true`).
- [ ] Save the filled-in file under a new name, e.g. `source_coverage_candidates.990-2301.first5.filled.json`, rather than overwriting the template.

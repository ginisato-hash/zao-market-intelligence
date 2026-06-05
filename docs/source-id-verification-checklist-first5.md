# Source ID Verification Checklist — First 5 Properties

Batch: `source_coverage_candidates.990-2301.first5`
Sources: rakuten, booking, google_hotels
SOP: `docs/source-id-verification-sop.md`

Fill in the **Verified URL**, **Verified Source Property ID**, **Property Match Confirmed**, **Verification Status**, and **Reviewer Note** columns as you complete each row. Leave blank if not yet verified.

---

| property_name | source | search_term | expected_url_pattern | verified_url | verified_source_property_id | property_match_confirmed | verification_status | reviewer_note |
|---|---|---|---|---|---|---|---|---|
| 深山荘 高見屋 | rakuten | `深山荘 高見屋` on travel.rakuten.co.jp | `https://travel.rakuten.co.jp/HOTEL/[number]/` | | | | candidate | |
| 深山荘 高見屋 | booking | `深山荘 高見屋 蔵王` on booking.com | `https://www.booking.com/hotel/jp/[slug].ja.html` | | | | candidate | |
| 深山荘 高見屋 | google_hotels | `深山荘 高見屋 蔵王温泉` on google.com/travel/hotels | `https://www.google.com/travel/hotels/entity/[token]` | | | | candidate | |
| 名湯リゾート ルーセント | rakuten | `名湯リゾート ルーセント` on travel.rakuten.co.jp | `https://travel.rakuten.co.jp/HOTEL/[number]/` | | | | candidate | |
| 名湯リゾート ルーセント | booking | `名湯リゾート ルーセント 蔵王` on booking.com | `https://www.booking.com/hotel/jp/[slug].ja.html` | | | | candidate | |
| 名湯リゾート ルーセント | google_hotels | `名湯リゾート ルーセント 蔵王温泉` on google.com/travel/hotels | `https://www.google.com/travel/hotels/entity/[token]` | | | | candidate | |
| ホテル喜らく | rakuten | `ホテル喜らく` on travel.rakuten.co.jp | `https://travel.rakuten.co.jp/HOTEL/[number]/` | | | | candidate | |
| ホテル喜らく | booking | `ホテル喜らく 蔵王` on booking.com | `https://www.booking.com/hotel/jp/[slug].ja.html` | | | | candidate | |
| ホテル喜らく | google_hotels | `ホテル喜らく 蔵王温泉` on google.com/travel/hotels | `https://www.google.com/travel/hotels/entity/[token]` | | | | candidate | |
| BED'n ONSEN HAMMOND | rakuten | `BED'n ONSEN HAMMOND` on travel.rakuten.co.jp | `https://travel.rakuten.co.jp/HOTEL/[number]/` | | | | candidate | |
| BED'n ONSEN HAMMOND | booking | `BED'n ONSEN HAMMOND 蔵王` on booking.com | `https://www.booking.com/hotel/jp/[slug].ja.html` | | | | candidate | |
| BED'n ONSEN HAMMOND | google_hotels | `BED'n ONSEN HAMMOND 蔵王温泉` on google.com/travel/hotels | `https://www.google.com/travel/hotels/entity/[token]` | | | | candidate | |
| 蔵王温泉 JURIN | rakuten | `蔵王温泉 JURIN` on travel.rakuten.co.jp | `https://travel.rakuten.co.jp/HOTEL/[number]/` | | | | candidate | |
| 蔵王温泉 JURIN | booking | `蔵王温泉 JURIN` on booking.com | `https://www.booking.com/hotel/jp/[slug].ja.html` | | | | candidate | |
| 蔵王温泉 JURIN | google_hotels | `蔵王温泉 JURIN` on google.com/travel/hotels | `https://www.google.com/travel/hotels/entity/[token]` | | | | candidate | |

---

## Notes

- **search_term**: Suggested text to type into the OTA search box. Adjust if needed.
- **expected_url_pattern**: The URL structure to look for once you land on the property detail page.
- **verified_url**: The full URL of the property page you verified (copy from browser address bar).
- **verified_source_property_id**: The extracted identifier only (number, slug, or token — not the full URL).
- **property_match_confirmed**: Write `yes` if you confirmed name + location match; `no` if you found a page but rejected it; leave blank if not yet checked.
- **verification_status**: Update from `candidate` to `confirmed`, `needs_review`, or `rejected` as appropriate. See SOP Section 10.
- **reviewer_note**: Required for `confirmed`. Summarise the evidence. Example: "Searched Rakuten, HOTEL/12345 matches 深山荘 高見屋 at 蔵王温泉."

Once all rows are filled in, copy the verified data into the seed file and save as a new file (do not overwrite the `.template.json`).

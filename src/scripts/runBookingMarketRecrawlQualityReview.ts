// Phase ZMI BOOKING-MARKET-RECRAWL-QUALITY — per-observation quality review.
//
// Read-only. Aggregates the competitor re-crawl preview artifacts to explain WHY
// rows became confirmed / probable / unknown / excluded — especially batch 2's
// high exclusion rate (suite/family vs room-card selection vs date). Writes
// .data/validation/ artifacts only. No collection/append/publish.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPORT_DIR = ".data/reports/source-discovery";
const OUT_DIR = ".data/validation";

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function esc(v: string): string { return /[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v; }
function bucket(rb: string): string {
  if (rb === "confirmed_two_person_standard_room") return "confirmed";
  if (rb === "probable_two_person_standard_room") return "probable";
  if (rb === "unknown_room_basis") return "unknown";
  return "excluded";
}

interface QRow { batch_index: number; property: string; checkin: string; room_basis: string; exclusion_reason: string; room_name: string; bed_hint: string; occupancy_hint: string; price: string; was_usable_sample: boolean }

function run(): void {
  const rows: QRow[] = [];
  if (existsSync(REPORT_DIR)) {
    for (const f of readdirSync(REPORT_DIR).filter((x) => /^booking_market_recrawl_preview_.*\.json$/u.test(x)).sort()) {
      const d = JSON.parse(readFileSync(join(REPORT_DIR, f), "utf8")) as { selected_batch_index?: number; rows?: Array<Record<string, unknown>> };
      for (const r of d.rows ?? []) {
        const rb = String(r["room_basis"] ?? "unknown_room_basis");
        const price = r["primary_price_numeric"] === null || r["primary_price_numeric"] === undefined ? "" : String(r["primary_price_numeric"]);
        const reason = String(r["room_basis_reason"] ?? "");
        rows.push({
          batch_index: Number(d.selected_batch_index ?? -1),
          property: String(r["canonical_property_name"] ?? ""),
          checkin: String(r["checkin"] ?? ""),
          room_basis: rb,
          exclusion_reason: bucket(rb) === "excluded" ? reason : "",
          room_name: String(r["primary_room_name"] ?? ""),
          bed_hint: String(r["primary_bed_hint"] ?? ""),
          occupancy_hint: String(r["primary_occupancy_hint"] ?? ""),
          price,
          was_usable_sample: bucket(rb) !== "excluded" && price !== ""
        });
      }
    }
  }

  const byBatch: Record<string, { total: number; confirmed: number; probable: number; unknown: number; excluded: number; exclusion_reasons: Record<string, number> }> = {};
  for (const r of rows) {
    const k = String(r.batch_index);
    const b = byBatch[k] ?? (byBatch[k] = { total: 0, confirmed: 0, probable: 0, unknown: 0, excluded: 0, exclusion_reasons: {} });
    b.total += 1;
    const bk = bucket(r.room_basis) as "confirmed" | "probable" | "unknown" | "excluded";
    b[bk] += 1;
    if (bk === "excluded") b.exclusion_reasons[r.exclusion_reason || "unspecified"] = (b.exclusion_reasons[r.exclusion_reason || "unspecified"] ?? 0) + 1;
  }

  const batch2 = rows.filter((r) => r.batch_index === 2);
  const batch2Excluded = batch2.filter((r) => bucket(r.room_basis) === "excluded");
  const review = {
    generated_at_jst: jstNow(),
    total_observations: rows.length,
    by_batch: byBatch,
    batch2_analysis: {
      total: batch2.length,
      excluded: batch2Excluded.length,
      exclusion_rate: batch2.length ? Number((batch2Excluded.length / batch2.length).toFixed(3)) : 0,
      excluded_rows: batch2Excluded.map((r) => ({ property: r.property, checkin: r.checkin, room_basis: r.room_basis, exclusion_reason: r.exclusion_reason, room_name: r.room_name, bed_hint: r.bed_hint })),
      likely_cause: batch2Excluded.length === 0 ? "n/a" :
        (batch2Excluded.every((r) => /family_or_suite/u.test(r.room_basis)) ? "suite_or_family_room_cards_surfaced" : "mixed_room_type_or_card_selection")
    },
    rows
  };

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const jsonPath = resolve(OUT_DIR, "booking_market_recrawl_quality_review.json");
  const csvPath = resolve(OUT_DIR, "booking_market_recrawl_quality_review.csv");
  writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  const COLS = ["batch_index", "property", "checkin", "room_basis", "exclusion_reason", "room_name", "bed_hint", "occupancy_hint", "price", "was_usable_sample"];
  writeFileSync(csvPath, [COLS.join(",")].concat(rows.map((r) => COLS.map((c) => esc(String((r as unknown as Record<string, unknown>)[c] ?? ""))).join(","))).join("\n") + "\n", "utf8");

  console.log(`total_observations=${rows.length}`);
  for (const [k, b] of Object.entries(byBatch).sort()) console.log(`batch_${k}: total=${b.total} confirmed=${b.confirmed} probable=${b.probable} unknown=${b.unknown} excluded=${b.excluded} reasons=${JSON.stringify(b.exclusion_reasons)}`);
  console.log(`batch2_exclusion_rate=${review.batch2_analysis.exclusion_rate}`);
  console.log(`batch2_likely_cause=${review.batch2_analysis.likely_cause}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
}

run();

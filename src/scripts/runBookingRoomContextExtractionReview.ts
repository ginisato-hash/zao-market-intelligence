// Phase ZMI BOOKING-ROOM-CONTEXT review — extraction strengthening artifact.
//
// Read-only. Measures the impact of passing primaryBedHint / primaryOccupancyHint
// into classifyBookingRoomBasis at the live-probe stage. Because the change
// affects FUTURE live collection (stored history already carries baked-in
// markers), before/after is measured at the extraction/classification level over
// representative Booking price-card windows (OLD = roomName+cardText only; NEW =
// + bed/occupancy hint via classifyBookingRoomBasis). Also reports the CURRENT
// Booking room-basis distribution from canonical history for context.
//
// Writes .data/validation/ artifacts only. No collection, append, DB write/sync,
// publish, or pricing/PMS output. Does NOT read or modify .data/history rows
// beyond counting.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeBookingRenderedDomSignals } from "../services/bookingRenderedDomProbe";
import {
  classifyBookingRoomBasis,
  classifyRoomBasisFromParts
} from "../services/roomBasisClassification";
import { deriveBiRoomBasis, type BiHistoryRow } from "../services/biWebDataExport";

const HISTORY_DIR = ".data/history";
const OUT_DIR = ".data/validation";
const CHECKIN_RE = /^\d{4}-\d{2}-\d{2}$/u;

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

// Build a Booking price-card body window for the given room-context fragments.
function body(fragments: string[]): string {
  return ["蔵王国際ホテル", "2026年8月10日", "2026年8月11日", "1泊", "1室", ...fragments, "宿泊施設の説明と設備情報 ".repeat(30)].join(" ");
}

interface Sample { label: string; body: string; soldOut: boolean }

// Representative Booking room-card windows covering §3.1/§3.2/§3.3 patterns.
const SAMPLES: Sample[] = [
  { label: "twin_room_two_single_beds", body: body(["大人2名", "スタンダードツインルーム", "シングルベッド2台", "税・手数料込み", "￥24,000"]), soldOut: false },
  { label: "twin_room_en", body: body(["2 adults", "Standard Twin Room", "2 single beds", "tax included", "￥24,000"]), soldOut: false },
  { label: "double_room_one_double_bed", body: body(["大人2名", "ダブルルーム", "ダブルベッド", "税・手数料込み", "￥22,000"]), soldOut: false },
  { label: "bed_hint_only_no_room_name", body: body(["大人2名", "禁煙", "シングルベッド2台", "税・手数料込み", "￥23,000"]), soldOut: false },
  { label: "queen_bed_only", body: body(["大人2名", "禁煙", "queen bed", "税・手数料込み", "￥26,000"]), soldOut: false },
  { label: "occupancy_only_no_room_no_bed", body: body(["大人2名", "税・手数料込み", "￥64,790"]), soldOut: false },
  { label: "standard_room_2adults", body: body(["大人2名", "スタンダードルーム", "税・手数料込み", "￥28,000"]), soldOut: false },
  { label: "single_room", body: body(["大人2名", "シングルルーム", "税・手数料込み", "￥12,000"]), soldOut: false },
  { label: "semi_double", body: body(["大人2名", "セミダブルルーム", "税・手数料込み", "￥15,000"]), soldOut: false },
  { label: "triple_room", body: body(["大人2名", "トリプルルーム", "税・手数料込み", "￥33,000"]), soldOut: false },
  { label: "family_room", body: body(["大人2名", "ファミリールーム", "税・手数料込み", "￥40,000"]), soldOut: false },
  { label: "suite", body: body(["大人2名", "スイートルーム", "税・手数料込み", "￥52,000"]), soldOut: false },
  { label: "sold_out_no_price", body: body(["大人2名", "満室", "空室なし"]), soldOut: true }
];

const TARGET = { canonicalPropertyName: "蔵王国際ホテル", slug: "zao-kokusai" };

function classifySample(s: Sample): { before: string; after: string; primaryRoomName: string; primaryBedHint: string; primaryOccupancyHint: string } {
  const signals = analyzeBookingRenderedDomSignals({
    target: TARGET,
    checkin: "2026-08-10",
    checkout: "2026-08-11",
    loaded: true,
    httpStatus: 200,
    finalUrl: `https://www.booking.com/hotel/jp/${TARGET.slug}.ja.html`,
    pageTitle: TARGET.canonicalPropertyName,
    bodyText: s.body
  });
  const hasPrice = signals.priceCandidates.length > 0;
  const available = hasPrice && !signals.soldOutOrUnavailableDetected;
  // OLD: room name + card text only.
  const before = classifyRoomBasisFromParts({ roomName: signals.primaryRoomName, blockText: signals.primaryRoomCardText }).roomBasis;
  // NEW: + bed hint + occupancy hint via classifyBookingRoomBasis.
  const after = classifyBookingRoomBasis({
    roomName: signals.primaryRoomName,
    blockText: signals.primaryRoomCardText,
    bedHint: signals.primaryBedHint,
    occupancyHint: signals.primaryOccupancyHint,
    available,
    hasPrice
  }).roomBasis;
  return { before, after, primaryRoomName: signals.primaryRoomName, primaryBedHint: signals.primaryBedHint, primaryOccupancyHint: signals.primaryOccupancyHint };
}

function bucket(rb: string): "confirmed" | "probable" | "unknown" | "excluded" {
  if (rb === "confirmed_two_person_standard_room") return "confirmed";
  if (rb === "probable_two_person_standard_room") return "probable";
  if (rb === "unknown_room_basis") return "unknown";
  return "excluded";
}

// --- canonical history Booking distribution (context only) ---
function parseCsvLine(line: string): string[] {
  const cells: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur); return cells;
}
function splitCsvRecords(content: string): string[] {
  const records: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '"') { q = !q; cur += ch; continue; }
    if ((ch === "\n" || ch === "\r") && !q) { if (ch === "\r" && content[i + 1] === "\n") i += 1; records.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur !== "") records.push(cur);
  return records.filter((r) => r.length > 0);
}
function historyBookingDistribution(): { total: number; priced: number; confirmed: number; probable: number; unknown: number; excluded: number } {
  const out = { total: 0, priced: 0, confirmed: 0, probable: 0, unknown: 0, excluded: 0 };
  if (!existsSync(HISTORY_DIR)) return out;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const lines = splitCsvRecords(readFileSync(join(HISTORY_DIR, f), "utf8"));
    if (lines.length < 2) continue;
    const h = parseCsvLine(lines[0]!);
    const idx = (n: string): number => h.indexOf(n);
    const si = idx("source"), ni = idx("canonical_property_name"), ci = idx("checkin"), pi = idx("normalized_total_price"), ai = idx("availability_status");
    const scli = idx("source_classification"), wfi = idx("warning_flags"), exi = idx("is_price_excluded_from_dp"), deri = idx("dp_exclusion_reason"), bni = idx("basis_note");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      if ((c[si] ?? "").trim() !== "booking") continue;
      if ((c[ni] ?? "").trim() === "" || !CHECKIN_RE.test((c[ci] ?? "").trim())) continue;
      const row = {
        source: "booking", canonical_property_name: c[ni] ?? "", source_slug_or_code: "", checkin: c[ci] ?? "", checkout: "",
        availability_status: ai >= 0 ? (c[ai] ?? "") : "", normalized_total_price: ((c[pi] ?? "").trim() === "" ? null : Number(c[pi])),
        is_price_usable_for_dp_directional: false, collected_at_jst: "", tier: "",
        source_classification: scli >= 0 ? (c[scli] ?? "") : "", warning_flags: wfi >= 0 ? (c[wfi] ?? "") : "",
        basis_confidence: "", is_price_excluded_from_dp: exi >= 0 ? (c[exi] ?? "").toLowerCase() === "true" : false,
        dp_exclusion_reason: deri >= 0 ? (c[deri] ?? "") : "", basis_note: bni >= 0 ? (c[bni] ?? "") : ""
      } as BiHistoryRow;
      out.total += 1;
      if (row.normalized_total_price !== null) out.priced += 1;
      out[bucket(deriveBiRoomBasis(row))] += 1;
    }
  }
  return out;
}

function run(): void {
  const rows = SAMPLES.map((s) => ({ label: s.label, ...classifySample(s) }));
  const before = { confirmed: 0, probable: 0, unknown: 0, excluded: 0 };
  const after = { confirmed: 0, probable: 0, unknown: 0, excluded: 0 };
  let probableToConfirmed = 0;
  let unknownToConfirmedOrProbable = 0;
  let invalid = 0;
  const sampleRows = rows.map((r) => {
    const bb = bucket(r.before); const ab = bucket(r.after);
    before[bb] += 1; after[ab] += 1;
    if (bb === "probable" && ab === "confirmed") probableToConfirmed += 1;
    if (bb === "unknown" && (ab === "confirmed" || ab === "probable")) unknownToConfirmedOrProbable += 1;
    if (r.before === "" || r.after === "") invalid += 1;
    return { label: r.label, before: r.before, after: r.after, primary_room_name: r.primaryRoomName, primary_bed_hint: r.primaryBedHint, occupancy_hint: r.primaryOccupancyHint };
  });

  const hist = historyBookingDistribution();
  const review = {
    generated_at_jst: jstNow(),
    scope: "old-vs-new room-basis classification over representative Booking price-card windows; history distribution is context only",
    total_booking_rows: hist.total,
    booking_priced_rows: hist.priced,
    confirmed_before: before.confirmed,
    confirmed_after: after.confirmed,
    probable_before: before.probable,
    probable_after: after.probable,
    unknown_before: before.unknown,
    unknown_after: after.unknown,
    excluded_before: before.excluded,
    excluded_after: after.excluded,
    confirmed_gain: after.confirmed - before.confirmed,
    probable_to_confirmed_candidates: probableToConfirmed,
    unknown_to_confirmed_or_probable: unknownToConfirmedOrProbable,
    excluded_rows: after.excluded,
    unknown_room_basis_rows: after.unknown,
    invalid_rows: invalid,
    history_booking_distribution_current: hist,
    sample_confirmed_rows: sampleRows.filter((r) => bucket(r.after) === "confirmed").slice(0, 10),
    sample_probable_rows: sampleRows.filter((r) => bucket(r.after) === "probable").slice(0, 10),
    sample_unknown_rows: sampleRows.filter((r) => bucket(r.after) === "unknown").slice(0, 10),
    sample_excluded_rows: sampleRows.filter((r) => bucket(r.after) === "excluded").slice(0, 10),
    notes: [
      "before = classifyRoomBasisFromParts(roomName, cardText); after = classifyBookingRoomBasis(+bedHint,+occupancyHint).",
      "Impact applies to FUTURE live probe runs; stored history markers are unchanged.",
      "history_booking_distribution_current is derived from existing .data/history markers (no re-extraction possible from stored rows)."
    ]
  };

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const jsonPath = resolve(OUT_DIR, "booking_room_context_extraction_review.json");
  const csvPath = resolve(OUT_DIR, "booking_room_context_extraction_review.csv");
  writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  const csv = [["label", "before", "after", "primary_room_name", "primary_bed_hint", "occupancy_hint"], ...sampleRows.map((r) => [r.label, r.before, r.after, r.primary_room_name, r.primary_bed_hint, r.occupancy_hint])]
    .map((row) => row.map((v) => /[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v).join(",")).join("\n") + "\n";
  writeFileSync(csvPath, csv, "utf8");

  console.log(`samples=${SAMPLES.length}`);
  console.log(`confirmed_before=${before.confirmed} confirmed_after=${after.confirmed} confirmed_gain=${after.confirmed - before.confirmed}`);
  console.log(`probable_before=${before.probable} probable_after=${after.probable}`);
  console.log(`unknown_before=${before.unknown} unknown_after=${after.unknown}`);
  console.log(`excluded_before=${before.excluded} excluded_after=${after.excluded}`);
  console.log(`probable_to_confirmed_candidates=${probableToConfirmed}`);
  console.log(`unknown_to_confirmed_or_probable=${unknownToConfirmedOrProbable}`);
  console.log(`invalid_rows=${invalid}`);
  console.log(`history_booking_distribution_current=${JSON.stringify(hist)}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
}

run();

// Phase ZMI BOOKING-PRICE-CONFIDENCE review — before/after validation artifact.
//
// Read-only: reads canonical history, builds the unified BI rows, and reports how
// the probable-two-person-standard-room change moves price_confidence (before =
// old "low unless confirmed" cap; after = current confirmed->high / probable->
// medium / unknown->low ladder). Writes .data/validation/ artifacts only. No
// collection, append, DB write/sync, publish, or pricing/PMS output.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  deriveBiRoomBasis,
  latestObservations,
  unifyByPropertyCheckin,
  type BiHistoryRow,
  type UnifiedRow
} from "../services/biWebDataExport";

const HISTORY_DIR = ".data/history";
const OUT_DIR = ".data/validation";
const PERIOD_KEY_RE = /^\d{4}-\d{2}_(early|late)$/u;
const CHECKIN_RE = /^\d{4}-\d{2}-\d{2}$/u;

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur);
  return cells;
}

// Quote-aware record split (a newline inside a quoted field is content).
function splitCsvRecords(content: string): string[] {
  const records: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '"') { q = !q; cur += ch; continue; }
    if ((ch === "\n" || ch === "\r") && !q) {
      if (ch === "\r" && content[i + 1] === "\n") i += 1;
      records.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur !== "") records.push(cur);
  return records.filter((r) => r.length > 0);
}

function readHistory(): BiHistoryRow[] {
  const rows: BiHistoryRow[] = [];
  if (!existsSync(HISTORY_DIR)) return rows;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const lines = splitCsvRecords(readFileSync(join(HISTORY_DIR, f), "utf8"));
    if (lines.length < 2) continue;
    const h = parseCsvLine(lines[0]!);
    const idx = (n: string): number => h.indexOf(n);
    const si = idx("source"), ni = idx("canonical_property_name"), sci = idx("source_slug_or_code");
    const ci = idx("checkin"), coi = idx("checkout"), ai = idx("availability_status"), pi = idx("normalized_total_price");
    const ddi = idx("is_price_usable_for_dp_directional"), ti = idx("collected_at_jst"), tieri = idx("tier");
    const scli = idx("source_classification"), wfi = idx("warning_flags"), bci = idx("basis_confidence");
    const exi = idx("is_price_excluded_from_dp"), deri = idx("dp_exclusion_reason"), bni = idx("basis_note");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const ck = (c[ci] ?? "").trim();
      const nm = (c[ni] ?? "").trim();
      const src = (c[si] ?? "").trim();
      if (src === "" || nm === "" || !CHECKIN_RE.test(ck)) continue;
      const rawPrice = pi >= 0 ? (c[pi] ?? "").trim() : "";
      rows.push({
        source: c[si] ?? "",
        canonical_property_name: c[ni] ?? "",
        source_slug_or_code: sci >= 0 ? (c[sci] ?? "") : "",
        checkin: c[ci] ?? "",
        checkout: coi >= 0 ? (c[coi] ?? "") : "",
        availability_status: c[ai] ?? "",
        normalized_total_price: rawPrice === "" ? null : Number(rawPrice),
        is_price_usable_for_dp_directional: ddi >= 0 ? (c[ddi] ?? "").toLowerCase() === "true" : false,
        collected_at_jst: ti >= 0 ? (c[ti] ?? "") : "",
        tier: tieri >= 0 ? (c[tieri] ?? "") : "",
        source_classification: scli >= 0 ? (c[scli] ?? "") : "",
        warning_flags: wfi >= 0 ? (c[wfi] ?? "") : "",
        basis_confidence: bci >= 0 ? (c[bci] ?? "") : "",
        is_price_excluded_from_dp: exi >= 0 ? (c[exi] ?? "").toLowerCase() === "true" : false,
        dp_exclusion_reason: deri >= 0 ? (c[deri] ?? "") : "",
        basis_note: bni >= 0 ? (c[bni] ?? "") : ""
      });
    }
  }
  return rows;
}

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

// Old policy: overall confidence forced to "low" unless a CONFIRMED two-person
// sample exists (and a price exists). The "after" value is the row as exported.
function beforeConfidence(r: UnifiedRow): string {
  if (r.price_sample_count === 0) return "low";
  return r.confirmed_two_person_room_price_sample_count > 0 ? r.price_confidence : "low";
}

function run(): void {
  const raw = readHistory();
  const latest = latestObservations(raw);
  const unified = unifyByPropertyCheckin(latest);

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  const basis: Record<string, number> = {};
  const coverage: Record<string, number> = {};
  const lowReason: Record<string, number> = {};
  let pricedRows = 0;
  let invalidPeriod = 0, invalidCheckin = 0, nanLabel = 0;
  for (const r of unified) {
    inc(before, beforeConfidence(r));
    inc(after, r.price_confidence);
    inc(basis, r.price_basis_confidence);
    inc(coverage, r.price_coverage_confidence);
    if (r.median_directional_price !== null) pricedRows += 1;
    if (r.low_confidence_reason !== "") inc(lowReason, r.low_confidence_reason);
    if (!PERIOD_KEY_RE.test(r.period_key)) invalidPeriod += 1;
    if (!CHECKIN_RE.test(r.checkin)) invalidCheckin += 1;
    if ((r.period_label ?? "").includes("NaN")) nanLabel += 1;
  }

  // Room-basis over latest per-source observations.
  const roomBasis = { confirmed_two_person_standard_room: 0, probable_two_person_standard_room: 0, unknown_room_basis: 0, excluded_room_type: 0 };
  const booking = { total: 0, priced: 0, confirmed_two_person: 0, probable_two_person: 0, unknown_room_basis: 0 };
  for (const r of latest) {
    const rb = deriveBiRoomBasis(r);
    if (rb === "confirmed_two_person_standard_room") roomBasis.confirmed_two_person_standard_room += 1;
    else if (rb === "probable_two_person_standard_room") roomBasis.probable_two_person_standard_room += 1;
    else if (rb === "unknown_room_basis") roomBasis.unknown_room_basis += 1;
    else roomBasis.excluded_room_type += 1;
    if (r.source === "booking") {
      booking.total += 1;
      if (r.normalized_total_price !== null) booking.priced += 1;
      if (rb === "confirmed_two_person_standard_room") booking.confirmed_two_person += 1;
      else if (rb === "probable_two_person_standard_room") booking.probable_two_person += 1;
      else if (rb === "unknown_room_basis") booking.unknown_room_basis += 1;
    }
  }

  const notes: string[] = [];
  const movedUp = (after["medium"] ?? 0) + (after["high"] ?? 0) - ((before["medium"] ?? 0) + (before["high"] ?? 0));
  notes.push(`net_rows_lifted_to_medium_or_high=${movedUp}`);
  if (booking.confirmed_two_person === 0) notes.push("no_confirmed_two_person_yet_relies_on_probable_until_room_card_capture_lands");

  const review = {
    generated_at_jst: jstNow(),
    total_rows: unified.length,
    priced_rows: pricedRows,
    price_confidence_counts_before: before,
    price_confidence_counts_after: after,
    price_basis_confidence_counts: basis,
    price_coverage_confidence_counts: coverage,
    room_basis_counts: roomBasis,
    booking_rows: booking,
    low_confidence_reason_counts: lowReason,
    invalid_period_rows: invalidPeriod,
    invalid_checkin_rows: invalidCheckin,
    nan_period_label_rows: nanLabel,
    notes
  };

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const jsonPath = resolve(OUT_DIR, "booking_price_confidence_review.json");
  const csvPath = resolve(OUT_DIR, "booking_price_confidence_review.csv");
  writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  const csvRows = [
    ["metric", "before", "after"],
    ["price_confidence_low", String(before["low"] ?? 0), String(after["low"] ?? 0)],
    ["price_confidence_medium", String(before["medium"] ?? 0), String(after["medium"] ?? 0)],
    ["price_confidence_high", String(before["high"] ?? 0), String(after["high"] ?? 0)]
  ];
  writeFileSync(csvPath, csvRows.map((r) => r.join(",")).join("\n") + "\n", "utf8");

  console.log(`total_rows=${review.total_rows}`);
  console.log(`priced_rows=${review.priced_rows}`);
  console.log(`price_confidence_before=${JSON.stringify(before)}`);
  console.log(`price_confidence_after=${JSON.stringify(after)}`);
  console.log(`room_basis_counts=${JSON.stringify(roomBasis)}`);
  console.log(`booking_rows=${JSON.stringify(booking)}`);
  console.log(`low_confidence_reason_counts=${JSON.stringify(lowReason)}`);
  console.log(`invalid_period_rows=${invalidPeriod}`);
  console.log(`invalid_checkin_rows=${invalidCheckin}`);
  console.log(`nan_period_label_rows=${nanLabel}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
}

run();

// Phase ZMI BOOKING-RECRAWL — adaptive low-confidence Booking targeting.
//
// Read-only. Reads the unified BI dataset + canonical history, finds Booking
// (property, checkin) rows whose price confidence is weak (medium/low) or whose
// room basis is probable/unknown, and ranks which to RE-CRAWL via Booking
// preview so probable/unknown can become confirmed_two_person_standard_room and
// (later) price_confidence=high. Writes .data/crawl-priority/ artifacts only.
//
// NO collection, append, DB write/sync, publish, deploy, or pricing/PMS output.
// It NEVER raises confidence itself — it only produces a prioritized target list
// for the existing Booking preview dry-run (driven by ZMI_FORCE_CHECKIN_DATES
// against the verified Booking targets).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeName, isOwnProperty } from "../services/biWebDataExport";
import { VERIFIED_BOOKING_TARGETS } from "../services/autoRunnerBookingPreview";

const UNIFIED_CSV = "apps/zmi-bi-web/data/zmi_market_unified.csv";
const HISTORY_DIR = ".data/history";
const HOLIDAYS_FILE = "data/calendars/jp_holidays_2026_2027.json";
const OUT_DIR = ".data/crawl-priority";
const CHECKIN_RE = /^\d{4}-\d{2}-\d{2}$/u;

function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

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

function readUnified(): Array<Record<string, string>> {
  if (!existsSync(UNIFIED_CSV)) return [];
  const records = splitCsvRecords(readFileSync(UNIFIED_CSV, "utf8"));
  if (records.length < 2) return [];
  const header = parseCsvLine(records[0]!);
  return records.slice(1).map((line) => {
    const c = parseCsvLine(line); const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = c[i] ?? ""; });
    return o;
  });
}

// Booking presence/availability/price per folded (property, checkin) from history.
interface BookingFacts { present: boolean; available: boolean; priced: boolean; latest: string }
function readBookingHistoryFacts(): Map<string, BookingFacts> {
  const m = new Map<string, BookingFacts>();
  if (!existsSync(HISTORY_DIR)) return m;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const records = splitCsvRecords(readFileSync(join(HISTORY_DIR, f), "utf8"));
    if (records.length < 2) continue;
    const h = parseCsvLine(records[0]!);
    const idx = (n: string): number => h.indexOf(n);
    const si = idx("source"), ni = idx("canonical_property_name"), ci = idx("checkin"), pi = idx("normalized_total_price"), ai = idx("availability_status"), ti = idx("collected_at_jst");
    for (const line of records.slice(1)) {
      const c = parseCsvLine(line);
      if ((c[si] ?? "").trim() !== "booking") continue;
      const name = canonicalizeName((c[ni] ?? "").trim());
      const ck = (c[ci] ?? "").trim();
      if (name === "" || !CHECKIN_RE.test(ck)) continue;
      const key = `${name}|${ck}`;
      const prev = m.get(key) ?? { present: false, available: false, priced: false, latest: "" };
      prev.present = true;
      const avail = (c[ai] ?? "").trim().toLowerCase();
      if (avail === "available" || avail === "available_price_basis") prev.available = true;
      if ((c[pi] ?? "").trim() !== "" && (c[pi] ?? "").trim() !== "0") prev.priced = true;
      const t = (c[ti] ?? "").trim();
      if (t > prev.latest) prev.latest = t;
      m.set(key, prev);
    }
  }
  return m;
}

function readHolidays(): Set<string> {
  const s = new Set<string>();
  if (!existsSync(HOLIDAYS_FILE)) return s;
  try {
    const arr = JSON.parse(readFileSync(HOLIDAYS_FILE, "utf8")) as Array<{ date?: string }>;
    for (const h of arr) if (h.date && CHECKIN_RE.test(h.date)) s.add(h.date);
  } catch { /* ignore malformed seed */ }
  return s;
}

function isSaturday(checkin: string): boolean {
  return new Date(`${checkin}T00:00:00Z`).getUTCDay() === 6;
}
function dayAfter(checkin: string): string {
  const d = new Date(`${checkin}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function seasonBoost(checkin: string): { score: number; tag: string } {
  const mm = checkin.slice(5, 7); const dd = Number(checkin.slice(8, 10));
  if (mm === "07" || mm === "08") return { score: 8, tag: "summer" };
  if (mm === "12" || mm === "01" || mm === "02") return { score: 8, tag: "ski_winter" };
  if (mm === "10" || (mm === "09" && dd >= 20)) return { score: 8, tag: "autumn_foliage" };
  return { score: 0, tag: "" };
}

const VERIFIED_NAMES = new Set(VERIFIED_BOOKING_TARGETS.map((t) => canonicalizeName(t.canonicalPropertyName)));
const VERIFIED_SLUG = new Map(VERIFIED_BOOKING_TARGETS.map((t) => [canonicalizeName(t.canonicalPropertyName), t.slug]));

interface Target {
  priority_score: number; priority_bucket: "A" | "B" | "C" | "OWN"; checkin: string; period_key: string;
  canonical_property_name: string; is_own_property: boolean; target_scope: string; market_evidence_eligible: boolean;
  circularity_guard_reason: string; median_directional_price: string; price_confidence: string;
  price_basis_confidence: string; price_coverage_confidence: string; room_basis_confidence: string;
  room_only_price_sample_count: string; confirmed_two_person_room_price_sample_count: string;
  probable_two_person_room_price_sample_count: string; unknown_room_basis_count: string;
  source_count: string; available_source_count: string; sold_out_source_count: string;
  latest_collected_at_jst: string; target_reason: string; expected_gain: string; recommended_action: string;
  recrawlable_via_verified_target: boolean;
}

function run(): void {
  const unified = readUnified();
  const booking = readBookingHistoryFacts();
  const holidays = readHolidays();
  const today = todayJst();

  const targets: Target[] = [];
  let alreadyHighExcluded = 0;
  let ownAlreadyHighExcluded = 0;
  let ownHighGainExcluded = 0; // own rows that WOULD be market Priority A
  let invalid = 0;
  const n = (s: string): number => { const v = Number(s); return Number.isFinite(v) ? v : 0; };

  for (const r of unified) {
    const checkin = (r["checkin"] ?? "").trim();
    const name = (r["canonical_property_name"] ?? "").trim();
    if (!CHECKIN_RE.test(checkin) || name === "") { invalid += 1; continue; }
    if (checkin < today) continue; // future stays only

    const facts = booking.get(`${name}|${checkin}`);
    if (!facts?.present) continue; // Booking re-crawl targets only

    // Own properties (三浦屋 / 喜らく) are flagged by the unified CSV is_own_property
    // AND re-checked via the shared alias-aware classifier (circularity guard).
    const own = (r["is_own_property"] ?? "").toLowerCase() === "true" || isOwnProperty(name);

    const pc = (r["price_confidence"] ?? "").trim();
    const median = (r["median_directional_price"] ?? "").trim();
    const confirmed = n(r["confirmed_two_person_room_price_sample_count"] ?? "0");
    const probable = n(r["probable_two_person_room_price_sample_count"] ?? "0");
    const roomOnly = n(r["room_only_price_sample_count"] ?? "0");
    const unknownRoom = n(r["unknown_room_basis_count"] ?? "0");
    const avail = (r["unified_availability_status"] ?? "").trim();
    const wouldBeMarketA = pc === "medium" && probable > 0 && confirmed === 0 && median !== "";

    // --- Own property => monitoring only, never market evidence. ---
    if (own) {
      if (pc === "high") ownAlreadyHighExcluded += 1;
      if (wouldBeMarketA) ownHighGainExcluded += 1;
      const base = 50; let score = base; const tags: string[] = [];
      if (isSaturday(checkin)) { score += 15; tags.push("saturday"); }
      if (holidays.has(checkin)) { score += 12; tags.push("holiday"); }
      const seasonOwn = seasonBoost(checkin); if (seasonOwn.score) { score += seasonOwn.score; tags.push(seasonOwn.tag); }
      targets.push({
        priority_score: score, priority_bucket: "OWN", checkin, period_key: r["period_key"] ?? "",
        canonical_property_name: name, is_own_property: true, target_scope: "own_property_monitoring",
        market_evidence_eligible: false, circularity_guard_reason: "own_property_excluded_from_market_pricing_evidence",
        median_directional_price: median, price_confidence: pc,
        price_basis_confidence: r["price_basis_confidence"] ?? "", price_coverage_confidence: r["price_coverage_confidence"] ?? "",
        room_basis_confidence: r["room_basis_confidence"] ?? "", room_only_price_sample_count: String(roomOnly),
        confirmed_two_person_room_price_sample_count: String(confirmed), probable_two_person_room_price_sample_count: String(probable),
        unknown_room_basis_count: String(unknownRoom), source_count: String(n(r["source_count"] ?? "0")),
        available_source_count: r["available_source_count"] ?? "", sold_out_source_count: r["sold_out_source_count"] ?? "",
        latest_collected_at_jst: facts.latest || (r["latest_collected_at_jst"] ?? ""),
        target_reason: ["own_property_monitoring", ...tags].join("+"),
        expected_gain: "own_ota_listing_price_inventory_qa_only", recommended_action: "own_property_monitoring_only",
        recrawlable_via_verified_target: VERIFIED_NAMES.has(canonicalizeName(name))
      });
      continue;
    }

    // --- Market (competitor) evidence targets only below this point. ---
    if (pc === "high") { alreadyHighExcluded += 1; continue; }

    let bucket: "A" | "B" | "C" | null = null;
    let reason = ""; let expectedGain = ""; let action = "";
    if (wouldBeMarketA) {
      bucket = "A"; reason = "market_high_gain_medium_probable_not_confirmed";
      expectedGain = "competitor_probable_to_confirmed_then_high"; action = "booking_preview_room_context";
    } else if (pc === "low" && median !== "" && roomOnly > 0 && unknownRoom > 0) {
      bucket = "B"; reason = "market_room_basis_gap_low_unknown_with_price";
      expectedGain = "competitor_unknown_to_probable_or_confirmed"; action = "booking_preview_room_context";
    } else if (avail === "available" && median === "") {
      bucket = "C"; reason = "market_price_gap_available_no_price";
      expectedGain = "competitor_no_price_to_priced"; action = facts.available ? "booking_preview_price_refresh" : "booking_preview_availability_refresh";
    }
    if (bucket === null) continue;

    // Base score by bucket, plus §D importance boosts (competitor rows only).
    const base = bucket === "A" ? 100 : bucket === "B" ? 70 : 40;
    let score = base; const tags: string[] = [];
    if (isSaturday(checkin)) { score += 15; tags.push("saturday"); }
    if (holidays.has(checkin)) { score += 12; tags.push("holiday"); }
    if (holidays.has(dayAfter(checkin))) { score += 8; tags.push("day_before_holiday"); }
    const season = seasonBoost(checkin); if (season.score) { score += season.score; tags.push(season.tag); }
    if ((r["is_room_only_comp"] ?? "").toLowerCase() === "true") { score += 10; tags.push("room_only_comp"); }
    const sc = n(r["source_count"] ?? "0");
    if (sc <= 1) { score += 8; tags.push("thin_source_coverage"); } else if (sc === 2) { score += 3; tags.push("two_source_coverage"); }

    targets.push({
      priority_score: score, priority_bucket: bucket, checkin, period_key: r["period_key"] ?? "",
      canonical_property_name: name, is_own_property: false, target_scope: "market_evidence_recrawl",
      market_evidence_eligible: true, circularity_guard_reason: "",
      median_directional_price: median, price_confidence: pc,
      price_basis_confidence: r["price_basis_confidence"] ?? "", price_coverage_confidence: r["price_coverage_confidence"] ?? "",
      room_basis_confidence: r["room_basis_confidence"] ?? "", room_only_price_sample_count: String(roomOnly),
      confirmed_two_person_room_price_sample_count: String(confirmed), probable_two_person_room_price_sample_count: String(probable),
      unknown_room_basis_count: String(unknownRoom), source_count: String(sc),
      available_source_count: r["available_source_count"] ?? "", sold_out_source_count: r["sold_out_source_count"] ?? "",
      latest_collected_at_jst: facts.latest || (r["latest_collected_at_jst"] ?? ""),
      target_reason: [reason, ...tags].join("+"), expected_gain: expectedGain, recommended_action: action,
      recrawlable_via_verified_target: VERIFIED_NAMES.has(canonicalizeName(name))
    });
  }

  targets.sort((a, b) => (b.priority_score - a.priority_score) || a.checkin.localeCompare(b.checkin) || a.canonical_property_name.localeCompare(b.canonical_property_name));
  const ranked = targets.map((t, i) => ({ priority_rank: i + 1, ...t }));

  const market = ranked.filter((t) => t.target_scope === "market_evidence_recrawl");
  const ownRanked = ranked.filter((t) => t.target_scope === "own_property_monitoring");
  const counts = { A: 0, B: 0, C: 0 };
  for (const t of market) { if (t.priority_bucket === "A" || t.priority_bucket === "B" || t.priority_bucket === "C") counts[t.priority_bucket] += 1; }

  // Re-crawl checkin dates the EXISTING Booking preview runner can reach (verified
  // targets only) — MARKET dates and OWN dates kept separate so own-property
  // monitoring never drives a "market evidence" re-crawl.
  const recrawlDatesMarketVerified = [...new Set(market.filter((t) => t.recrawlable_via_verified_target).map((t) => t.checkin))].sort();
  const recrawlDatesOwnVerified = [...new Set(ownRanked.filter((t) => t.recrawlable_via_verified_target).map((t) => t.checkin))].sort();
  const marketTopDates = [...new Set(market.filter((t) => t.recrawlable_via_verified_target).slice(0, 40).map((t) => t.checkin))].sort();

  const review = {
    generated_at_jst: jstNow(),
    today_jst: today,
    inputs: { unified_csv: UNIFIED_CSV, history_dir: HISTORY_DIR },
    total_targets: ranked.length,
    // MARKET (competitor) evidence — own properties are NOT counted here.
    market_target_count: market.length,
    market_priority_a_count: counts.A,
    market_priority_b_count: counts.B,
    market_priority_c_count: counts.C,
    expected_high_gain_candidates: counts.A, // competitor probable -> confirmed -> high
    expected_medium_gain_candidates: counts.B, // competitor unknown -> probable/confirmed
    market_already_high_excluded_count: alreadyHighExcluded,
    // OWN-property monitoring — separated, never market/competitor evidence.
    own_property_target_count: ownRanked.length,
    own_property_monitoring_count: ownRanked.length,
    excluded_own_from_market_gain_count: ownHighGainExcluded,
    own_property_high_gain_candidates_excluded: ownHighGainExcluded,
    own_property_already_high_count: ownAlreadyHighExcluded,
    invalid_rows: invalid,
    verified_recrawl_targets: VERIFIED_BOOKING_TARGETS.map((t) => ({ canonical_property_name: t.canonicalPropertyName, slug: t.slug })),
    recrawl_checkin_dates_market_verified: recrawlDatesMarketVerified,
    recrawl_checkin_dates_own_verified: recrawlDatesOwnVerified,
    preview_connection: {
      note: "Drive the existing Booking preview dry-run with verified-target checkin dates. Preview only (no history append). MARKET and OWN dates are separate.",
      dry_run_command: "npm run auto-runner:booking-preview",
      market_live_preview_command_example: marketTopDates.length > 0 ? `COLLECT_BOOKING=1 ZMI_FORCE_CHECKIN_DATES=${marketTopDates.slice(0, 8).join(",")} npm run auto-runner:booking-preview` : "(no verified competitor target dates yet — see verified-target-gap review)",
      note_non_verified: "Targets whose property is not in VERIFIED_BOOKING_TARGETS cannot be re-crawled by the current preview runner; expanding verified targets is a separate gated step.",
      note_own_property: "Own-property dates are for own_property_monitoring (OTA listing / price-reflection / inventory QA) ONLY — never market pricing evidence."
    },
    top_50_market_targets: market.slice(0, 50),
    top_own_monitoring_targets: ownRanked.slice(0, 20),
    notes: [
      "This script never changes confidence; it only ranks re-crawl targets.",
      "confirmed is raised only when a live preview actually captures a room name / bed hint.",
      "Market Priority A = competitor high-gain (probable->confirmed); B = competitor room-basis; C = competitor price acquisition.",
      "Own properties (三浦屋 / 喜らく) are split into own_property_monitoring and excluded from all market gain counts (circularity guard)."
    ]
  };

  const COLS = [
    "priority_rank", "priority_score", "priority_bucket", "checkin", "period_key", "canonical_property_name",
    "is_own_property", "target_scope", "market_evidence_eligible", "circularity_guard_reason",
    "median_directional_price", "price_confidence", "price_basis_confidence", "price_coverage_confidence",
    "room_basis_confidence", "room_only_price_sample_count", "confirmed_two_person_room_price_sample_count",
    "probable_two_person_room_price_sample_count", "unknown_room_basis_count", "source_count",
    "available_source_count", "sold_out_source_count", "latest_collected_at_jst", "target_reason",
    "expected_gain", "recommended_action", "recrawlable_via_verified_target"
  ] as const;
  const esc = (v: string): string => /[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v;
  const csv = [COLS.join(",")].concat(
    ranked.map((t) => COLS.map((c) => esc(String((t as Record<string, unknown>)[c] ?? ""))).join(","))
  ).join("\n") + "\n";

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const jsonPath = resolve(OUT_DIR, "booking_low_confidence_targets.json");
  const csvPath = resolve(OUT_DIR, "booking_low_confidence_targets.csv");
  writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, csv, "utf8");

  console.log(`total_targets=${review.total_targets}`);
  console.log(`market_target_count=${market.length}`);
  console.log(`market_priority_a_count=${counts.A}`);
  console.log(`market_priority_b_count=${counts.B}`);
  console.log(`market_priority_c_count=${counts.C}`);
  console.log(`expected_high_gain_candidates=${review.expected_high_gain_candidates}`);
  console.log(`expected_medium_gain_candidates=${review.expected_medium_gain_candidates}`);
  console.log(`own_property_monitoring_count=${ownRanked.length}`);
  console.log(`excluded_own_from_market_gain_count=${ownHighGainExcluded}`);
  console.log(`own_property_high_gain_candidates_excluded=${ownHighGainExcluded}`);
  console.log(`market_already_high_excluded_count=${alreadyHighExcluded}`);
  console.log(`own_property_already_high_count=${ownAlreadyHighExcluded}`);
  console.log(`invalid_rows=${invalid}`);
  console.log(`recrawl_checkin_dates_market_verified_count=${recrawlDatesMarketVerified.length}`);
  console.log(`recrawl_checkin_dates_own_verified_count=${recrawlDatesOwnVerified.length}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
}

run();

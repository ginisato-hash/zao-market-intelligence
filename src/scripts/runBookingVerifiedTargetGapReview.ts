// Phase ZMI BOOKING-VERIFIED-TARGET-GAP — own vs competitor re-crawl gap review.
//
// Read-only. Splits the Booking re-crawl gap into:
//   - MARKET (competitor) verified-target gap: market Priority A/B/C rows whose
//     property is NOT in VERIFIED_BOOKING_TARGETS (the real market-evidence gap).
//   - OWN-property gap: 三浦屋 / 喜らく targets, which are monitoring-only and must
//     never be used as market/competitor pricing evidence (circularity guard).
// Booking slug candidates are pulled from existing .data/history evidence (never
// guessed). Writes .data/crawl-priority/ artifacts only. No collection, append,
// DB write/sync, publish, deploy, pricing/PMS. Does NOT modify .data/history.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeName, isOwnProperty, marketEvidenceEligible, OWN_PROPERTIES } from "../services/biWebDataExport";
import { VERIFIED_BOOKING_TARGETS } from "../services/autoRunnerBookingPreview";

const UNIFIED_CSV = "apps/zmi-bi-web/data/zmi_market_unified.csv";
const HISTORY_DIR = ".data/history";
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

// Booking slug candidates per folded canonical name + Booking presence per
// (folded name, checkin) — both from history evidence only.
function readBookingHistory(): { slugs: Map<string, Set<string>>; present: Set<string> } {
  const slugs = new Map<string, Set<string>>();
  const present = new Set<string>();
  if (!existsSync(HISTORY_DIR)) return { slugs, present };
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const recs = splitCsvRecords(readFileSync(join(HISTORY_DIR, f), "utf8"));
    if (recs.length < 2) continue;
    const h = parseCsvLine(recs[0]!); const idx = (n: string): number => h.indexOf(n);
    const si = idx("source"), ni = idx("canonical_property_name"), sl = idx("source_slug_or_code"), ci = idx("checkin");
    for (const line of recs.slice(1)) {
      const c = parseCsvLine(line);
      if ((c[si] ?? "").trim() !== "booking") continue;
      const name = canonicalizeName((c[ni] ?? "").trim());
      if (name === "") continue;
      const slug = (c[sl] ?? "").trim();
      if (slug !== "") { const set = slugs.get(name) ?? new Set<string>(); set.add(slug); slugs.set(name, set); }
      const ck = (c[ci] ?? "").trim();
      if (CHECKIN_RE.test(ck)) present.add(`${name}|${ck}`);
    }
  }
  return { slugs, present };
}

function readUnified(): Array<Record<string, string>> {
  if (!existsSync(UNIFIED_CSV)) return [];
  const recs = splitCsvRecords(readFileSync(UNIFIED_CSV, "utf8"));
  if (recs.length < 2) return [];
  const header = parseCsvLine(recs[0]!);
  return recs.slice(1).map((line) => { const c = parseCsvLine(line); const o: Record<string, string> = {}; header.forEach((hh, i) => { o[hh] = c[i] ?? ""; }); return o; });
}

function run(): void {
  const unified = readUnified();
  const { slugs: slugMap, present: bookingPresent } = readBookingHistory();
  const verifiedNames = new Set(VERIFIED_BOOKING_TARGETS.map((t) => canonicalizeName(t.canonicalPropertyName)));
  const today = todayJst();
  const n = (s: string): number => { const v = Number(s); return Number.isFinite(v) ? v : 0; };

  let marketA = 0, marketB = 0, marketC = 0;
  let marketARecrawlable = 0, marketANotRecrawlable = 0;
  let ownTargets = 0, ownWouldBeA = 0, ownRecrawlable = 0, ownMonitoringTotal = 0;
  let invalid = 0;
  const candidateMarket = new Map<string, { count: number; recrawlable: boolean }>();
  const candidateOwn = new Map<string, number>();

  for (const r of unified) {
    const checkin = (r["checkin"] ?? "").trim();
    const name = (r["canonical_property_name"] ?? "").trim();
    if (!CHECKIN_RE.test(checkin) || name === "") { invalid += 1; continue; }
    if (checkin < today) continue;
    // Booking re-crawl target requires a Booking row for THIS (property, checkin)
    // — same gate as the targeting script so bucket counts match.
    if (!bookingPresent.has(`${canonicalizeName(name)}|${checkin}`)) continue;

    const own = (r["is_own_property"] ?? "").toLowerCase() === "true" || isOwnProperty(name);
    const pc = (r["price_confidence"] ?? "").trim();
    const median = (r["median_directional_price"] ?? "").trim();
    const confirmed = n(r["confirmed_two_person_room_price_sample_count"] ?? "0");
    const probable = n(r["probable_two_person_room_price_sample_count"] ?? "0");
    const roomOnly = n(r["room_only_price_sample_count"] ?? "0");
    const unknownRoom = n(r["unknown_room_basis_count"] ?? "0");
    const avail = (r["unified_availability_status"] ?? "").trim();
    const recrawlable = verifiedNames.has(canonicalizeName(name));

    const isA = pc === "medium" && probable > 0 && confirmed === 0 && median !== "";
    const isB = pc === "low" && median !== "" && roomOnly > 0 && unknownRoom > 0;
    const isC = avail === "available" && median === "";

    if (own) {
      ownMonitoringTotal += 1; // every own booking-present future row is monitoring
      if (recrawlable) ownRecrawlable += 1;
      if (isA || isB || isC) { ownTargets += 1; candidateOwn.set(canonicalizeName(name), (candidateOwn.get(canonicalizeName(name)) ?? 0) + 1); }
      if (isA) ownWouldBeA += 1;
      continue;
    }
    if (pc === "high") continue;
    if (!(isA || isB || isC)) continue;
    if (isA) { marketA += 1; if (recrawlable) marketARecrawlable += 1; else marketANotRecrawlable += 1; }
    else if (isB) marketB += 1;
    else marketC += 1;
    const cm = candidateMarket.get(canonicalizeName(name)) ?? { count: 0, recrawlable };
    cm.count += 1; cm.recrawlable = recrawlable; candidateMarket.set(canonicalizeName(name), cm);
  }

  const slugList = (name: string): string[] => [...(slugMap.get(name) ?? new Set<string>())].sort();
  const miurayaSlugs = slugList("三浦屋");
  const kirakuSlugs = slugList("ホテル喜らく");

  // Market verified-target additions: competitor properties that appear as market
  // targets, are NOT already verified, and have a booking slug in history.
  const recommendedMarket = [...candidateMarket.entries()]
    .filter(([name]) => !verifiedNames.has(name) && marketEvidenceEligible(name) && slugMap.has(name))
    .map(([name, v]) => ({ canonical_property_name: name, booking_slug_candidates: slugList(name), market_target_rows: v.count, is_own_property: false, market_evidence_eligible: true, target_scope: "market_evidence_recrawl" }))
    .sort((a, b) => b.market_target_rows - a.market_target_rows);

  // Own monitoring additions: own properties with a booking slug in history.
  const ownNamesWithSlug = [...new Set([...candidateOwn.keys()].filter((nm) => slugMap.has(nm)))];
  const recommendedOwn = ownNamesWithSlug.map((name) => ({ canonical_property_name: name, booking_slug_candidates: slugList(name), is_own_property: true, market_evidence_eligible: false, target_scope: "own_property_monitoring" }));

  // cannot_verify: own properties with NO Booking slug in history (e.g. 喜らく /
  // ホテル喜らく appears only on Jalan, never Booking → cannot be Booking-verified).
  const ownCanonical = [...new Set((OWN_PROPERTIES as readonly string[]).map((nm) => canonicalizeName(nm)))];
  const cannotVerify = ownCanonical.filter((nm) => !slugMap.has(nm)).map((nm) => ({ canonical_property_name: nm, reason: "no_booking_slug_in_history_evidence_jalan_only" }));

  const review = {
    generated_at_jst: jstNow(),
    today_jst: today,
    verified_targets_before: VERIFIED_BOOKING_TARGETS.length,
    verified_targets: VERIFIED_BOOKING_TARGETS.map((t) => ({ canonical_property_name: t.canonicalPropertyName, slug: t.slug })),
    priority_a_total_raw: marketA + ownWouldBeA,
    market_priority_a_count: marketA,
    market_priority_b_count: marketB,
    market_priority_c_count: marketC,
    own_property_target_count: ownTargets,
    own_property_monitoring_count: ownMonitoringTotal,
    excluded_own_from_market_gain_count: ownWouldBeA,
    market_expected_high_gain_candidates: marketA,
    own_property_high_gain_candidates_excluded: ownWouldBeA,
    market_priority_a_recrawlable_before: marketARecrawlable,
    market_priority_a_not_recrawlable: marketANotRecrawlable,
    own_property_recrawlable_before: ownRecrawlable,
    candidate_market_properties: [...candidateMarket.entries()].map(([name, v]) => ({ canonical_property_name: name, market_target_rows: v.count, recrawlable_via_verified_target: v.recrawlable })).sort((a, b) => b.market_target_rows - a.market_target_rows),
    candidate_own_properties: [...candidateOwn.entries()].map(([name, count]) => ({ canonical_property_name: name, monitoring_target_rows: count })),
    miuraya_booking_slug_candidates: miurayaSlugs,
    kiraku_booking_slug_candidates: kirakuSlugs,
    recommended_market_verified_target_additions: recommendedMarket,
    recommended_own_monitoring_target_additions: recommendedOwn,
    cannot_verify: cannotVerify,
    invalid_rows: invalid,
    notes: [
      "Own properties (三浦屋 / 喜らく) are split out and excluded from market gain — they are own_property_monitoring only (circularity guard).",
      "recommended_market_verified_target_additions = competitor properties with Booking history slugs not yet in VERIFIED_BOOKING_TARGETS (the true market-evidence gap).",
      "Slug candidates come from .data/history evidence only; presence here is NOT an instruction to auto-verify — it is a reviewable candidate.",
      "喜らく has no Booking slug in history (Jalan-only), so it cannot be Booking-verified yet (cannot_verify)."
    ]
  };

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const jsonPath = resolve(OUT_DIR, "booking_verified_target_gap_review.json");
  const csvPath = resolve(OUT_DIR, "booking_verified_target_gap_review.csv");
  writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  const esc = (v: string): string => /[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v;
  const COLS = ["scope", "canonical_property_name", "booking_slug_candidates", "is_own_property", "market_evidence_eligible", "target_scope", "rows"];
  const csvRows: string[][] = [COLS];
  for (const m of recommendedMarket) csvRows.push(["market_verified_target_addition", m.canonical_property_name, m.booking_slug_candidates.join("|"), "false", "true", m.target_scope, String(m.market_target_rows)]);
  for (const o of recommendedOwn) csvRows.push(["own_monitoring_target_addition", o.canonical_property_name, o.booking_slug_candidates.join("|"), "true", "false", o.target_scope, ""]);
  for (const c of cannotVerify) csvRows.push(["cannot_verify", c.canonical_property_name, "", "", "", "", c.reason]);
  writeFileSync(csvPath, csvRows.map((row) => row.map(esc).join(",")).join("\n") + "\n", "utf8");

  console.log(`verified_targets_before=${review.verified_targets_before}`);
  console.log(`priority_a_total_raw=${review.priority_a_total_raw}`);
  console.log(`market_priority_a_count=${marketA} market_priority_b_count=${marketB} market_priority_c_count=${marketC}`);
  console.log(`own_property_target_count=${ownTargets} excluded_own_from_market_gain_count=${ownWouldBeA}`);
  console.log(`market_priority_a_recrawlable_before=${marketARecrawlable} market_priority_a_not_recrawlable=${marketANotRecrawlable}`);
  console.log(`own_property_recrawlable_before=${ownRecrawlable}`);
  console.log(`miuraya_booking_slug_candidates=${JSON.stringify(miurayaSlugs)}`);
  console.log(`kiraku_booking_slug_candidates=${JSON.stringify(kirakuSlugs)}`);
  console.log(`recommended_market_verified_target_additions=${recommendedMarket.length}`);
  console.log(`recommended_own_monitoring_target_additions=${recommendedOwn.length}`);
  console.log(`cannot_verify=${JSON.stringify(cannotVerify.map((c) => c.canonical_property_name))}`);
  console.log(`invalid_rows=${invalid}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
}

run();

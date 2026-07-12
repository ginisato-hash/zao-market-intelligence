// Phase AUTO-RUNNER16X — rotating 2-hourly collection scope planner (pure).
//
// Builds a per-slot target plan over verified live Booking/Jalan targets:
//  - 2-hour slots (00,02,...,22 JST), slot_index 0..11
//  - 24h cooldown per (source, property, stay_date)
//  - deterministic slot rotation so different slots cover different targets
//  - short/mid/long(+winter) bucket balance and tier balance
//  - strict per-run caps (total 12, booking 6, jalan 6, rakuten 0, google 0)
//
// No I/O, no network, no DB. Rakuten/Google are never collected (cap 0).

import { type MarketRefreshPropertyTarget, type TargetTier } from "./marketRefreshTargetUniverse";
import { DEFAULT_NEAR_TERM_DENSE_DAYS, scaleCap } from "./crawlVolumeConfig";
import { epochDay, roundRobinByGroup } from "./priorityRefreshTiers";

export type RotatingBucket = "short" | "mid" | "long";

export interface RotatingCaps {
  total_pages_per_run: number;
  booking_pages_per_run: number;
  jalan_pages_per_run: number;
  rakuten_pages_per_run: number;
  google_hotels_pages_per_run: number;
}

// Phase AUTO-RUNNER16X-F — per-run caps expanded to 24 (Booking 12 / Jalan 12)
// to cover the enlarged verified universe. Rakuten/Google remain 0 (never live).
export const ROTATING_CAPS: RotatingCaps = {
  total_pages_per_run: 24,
  booking_pages_per_run: 12,
  jalan_pages_per_run: 12,
  rakuten_pages_per_run: 0,
  google_hotels_pages_per_run: 0
};

// Phase AUTO-RUNNER16X — scale the enabled-source rotating caps by the crawl
// volume multiplier (cadence unchanged). Rakuten/Google always stay at 0.
export function scaledRotatingCaps(multiplier: number): RotatingCaps {
  return {
    total_pages_per_run: scaleCap(ROTATING_CAPS.total_pages_per_run, multiplier),
    booking_pages_per_run: scaleCap(ROTATING_CAPS.booking_pages_per_run, multiplier),
    jalan_pages_per_run: scaleCap(ROTATING_CAPS.jalan_pages_per_run, multiplier),
    rakuten_pages_per_run: 0,
    google_hotels_pages_per_run: 0
  };
}

export const SLOT_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22] as const;

// Theoretical daily page capacity = per-run cap x number of 2-hourly slots.
// Reported for ops visibility; actual volume is bounded further by cooldown,
// diversity caps, and the size of the verified universe.
export const DAILY_PAGE_CAPACITY = {
  theoretical_daily_page_capacity: ROTATING_CAPS.total_pages_per_run * SLOT_HOURS.length,
  booking_daily_capacity: ROTATING_CAPS.booking_pages_per_run * SLOT_HOURS.length,
  jalan_daily_capacity: ROTATING_CAPS.jalan_pages_per_run * SLOT_HOURS.length
} as const;

const BUCKET_RANGES = { short: [1, 14], mid: [15, 90], long: [91, 240] } as const;
const WINTER_RANGE = ["2026-12-19", "2027-03-15"] as const;
const COOLDOWN_HOURS = 24;

export interface RotatingDemandConfig {
  public_holidays: Record<string, string>;
  long_weekend_dates: ReadonlySet<string>;
  peak_periods: { code: string; from: string; to: string; saturday_only?: boolean }[];
}

export interface RotatingSlot {
  slot_key: string;
  slot_index: number;
  hour: number;
}

export interface RotatingTarget {
  source: "booking" | "jalan";
  property_slug: string;
  canonical_property_name: string;
  stay_date: string;
  checkin: string;
  bucket: RotatingBucket;
  tier: TargetTier;
  priority_score: number;
  reason_codes: string[];
  estimated_page_count: number;
}

export const MAX_TARGETS_PER_PROPERTY_PER_RUN = 2;
// Per-run per-stay_date cap forces date spread (so the per-property cap does not
// collapse all properties onto the same few top-scoring dates). 1 maximizes
// distinct dates per run; relaxed in later passes if needed to fill the cap.
export const MAX_TARGETS_PER_STAY_DATE_PER_RUN = 1;

export interface RotatingPlan {
  slot_key: string;
  slot_index: number;
  caps: RotatingCaps;
  selected: RotatingTarget[];
  excluded_by_cooldown: { source: string; property_slug: string; stay_date: string }[];
  excluded_by_cap: number;
  excluded_by_property_diversity_cap: number;
  candidate_count: number;
  selected_by_source: Record<string, number>;
  selected_by_bucket: Record<string, number>;
  selected_by_tier: Record<string, number>;
  selected_distinct_properties_by_source: Record<string, number>;
  selected_distinct_stay_dates: number;
  selected_targets_by_property: Record<string, number>;
  property_diversity_warning: string[];
  estimated_total_pages: number;
  // Phase AUTO-RUNNER17X near-term-dense / forced-date diagnostics.
  near_term_dense_candidate_count: number;
  near_term_dense_selected_count: number;
  ordinary_weekday_near_term_candidate_count: number;
  ordinary_weekday_near_term_selected_count: number;
  forced_checkin_candidate_count: number;
  forced_checkin_selected_count: number;
}

function parseYmd(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) throw new Error(`expected YYYY-MM-DD: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}
function toYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function addDays(iso: string, n: number): string {
  const d = parseYmd(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toYmd(d);
}

export function buildSlot(runDateIso: string, hourJst: number): RotatingSlot {
  const hour = SLOT_HOURS.includes(hourJst as (typeof SLOT_HOURS)[number]) ? hourJst : Math.floor(hourJst / 2) * 2;
  return { slot_key: `${runDateIso}-${String(hour).padStart(2, "0")}`, slot_index: hour / 2, hour };
}

export function bucketForOffset(offset: number): RotatingBucket | null {
  if (offset >= BUCKET_RANGES.short[0] && offset <= BUCKET_RANGES.short[1]) return "short";
  if (offset >= BUCKET_RANGES.mid[0] && offset <= BUCKET_RANGES.mid[1]) return "mid";
  if (offset >= BUCKET_RANGES.long[0] && offset <= BUCKET_RANGES.long[1]) return "long";
  return null;
}

function inWinter(iso: string): boolean {
  return iso >= WINTER_RANGE[0] && iso <= WINTER_RANGE[1];
}

function inPeak(iso: string, config: RotatingDemandConfig): string[] {
  const dow = parseYmd(iso).getUTCDay();
  const codes: string[] = [];
  for (const p of config.peak_periods) {
    if (iso >= p.from && iso <= p.to && (!p.saturday_only || dow === 6)) codes.push(p.code);
  }
  return codes;
}

// §7.5 deterministic scoring. options carry the near-term-dense offset and the
// forced-spot-check flag (Phase AUTO-RUNNER17X) so recent ordinary weekdays and
// operator-forced dates rank to the top instead of being out-competed.
export function scoreTarget(
  stayDate: string,
  bucket: RotatingBucket,
  tier: TargetTier,
  config: RotatingDemandConfig,
  collectedRecently: boolean,
  options?: { offset?: number; forced?: boolean; nearTermDenseDays?: number }
): { score: number; reasons: string[] } {
  const dow = parseYmd(stayDate).getUTCDay();
  const winter = inWinter(stayDate);
  const reasons: string[] = [bucket];
  let score = winter ? 50 : ({ short: 80, mid: 60, long: 40 } as const)[bucket];
  if (winter) reasons.push("winter");

  if (dow === 6) { score += 25; reasons.push("saturday"); }
  else if (dow === 5) { score += 10; reasons.push("friday"); }
  else if (dow === 0) { score += 10; reasons.push("sunday"); }
  else reasons.push("ordinary_weekday");

  if (config.public_holidays[stayDate] !== undefined) { score += 30; reasons.push("public_holiday"); }
  if (config.long_weekend_dates.has(stayDate)) { score += 30; reasons.push("long_weekend"); }

  for (const code of inPeak(stayDate, config)) {
    reasons.push(code);
    if (code === "obon") score += 35;
    else if (code === "autumn_foliage" || code === "autumn_foliage_saturday") score += 30;
    else if (code === "ski_season" || code === "ski_season_saturday") { score += 35; if (dow === 6) reasons.push("ski_season_saturday"); }
    else if (code === "year_end_peak") score += 45;
  }

  if (dow !== 0 && dow !== 5 && dow !== 6 && config.public_holidays[stayDate] === undefined) { score += 5; reasons.push("ordinary_weekday_backfill"); }
  if (!collectedRecently) { score += 15; reasons.push("not_collected_recently"); }

  if (tier === "tier_direct_mid") { score += 15; reasons.push("direct_competitor_tier"); }
  else if (tier === "tier_budget_small") { score += 10; reasons.push("budget_small_tier"); }
  else if (tier === "tier_anchor_high") { score += 5; reasons.push("anchor_high_tier"); }

  // Near-term dense boost: keep recent dates (esp. ordinary weekdays) competitive.
  const offset = options?.offset;
  const denseDays = options?.nearTermDenseDays ?? DEFAULT_NEAR_TERM_DENSE_DAYS;
  if (offset !== undefined && offset >= 1 && offset <= denseDays) {
    reasons.push("near_term_dense");
    if (offset <= 7) score += 35;
    else if (offset <= 14) score += 30;
    else score += 20;
  }
  // Forced spot-check dates rank above everything else.
  if (options?.forced === true) { score += 50; reasons.push("forced_checkin_date"); }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function offsetDays(fromIso: string, toIso: string): number {
  return Math.round((parseYmd(toIso).getTime() - parseYmd(fromIso).getTime()) / (24 * 60 * 60 * 1000));
}

// Candidate stay dates (Phase AUTO-RUNNER17X):
//  - offset 1..nearTermDenseDays: EVERY day (so recent ordinary weekdays like
//    6/25 are always candidates, not just Fri/Sat/Sun/holiday/peak),
//  - offset (dense+1)..90: Fri/Sat/Sun + holidays + long-weekends + peak + winter
//    + an ordinary-weekday every 3 days,
//  - offset 91..240: the original logic (interesting + sparse %9 backfill).
//  Forced spot-check dates within the horizon are always added.
export function candidateStayDates(
  runDateIso: string,
  config: RotatingDemandConfig,
  options?: { nearTermDenseDays?: number; forcedDates?: readonly string[] }
): { stayDate: string; bucket: RotatingBucket; forced: boolean }[] {
  const denseDays = options?.nearTermDenseDays ?? DEFAULT_NEAR_TERM_DENSE_DAYS;
  const forced = new Set(options?.forcedDates ?? []);
  const out: { stayDate: string; bucket: RotatingBucket; forced: boolean }[] = [];
  const seen = new Set<string>();
  for (let offset = 1; offset <= BUCKET_RANGES.long[1]; offset += 1) {
    const stayDate = addDays(runDateIso, offset);
    const bucket = bucketForOffset(offset);
    if (bucket === null) continue;
    const dow = parseYmd(stayDate).getUTCDay();
    const interesting =
      dow === 5 || dow === 6 || dow === 0 ||
      config.public_holidays[stayDate] !== undefined ||
      config.long_weekend_dates.has(stayDate) ||
      inPeak(stayDate, config).length > 0 ||
      inWinter(stayDate);
    let include: boolean;
    if (offset <= denseDays) include = true; // near-term: every day
    else if (offset <= BUCKET_RANGES.mid[1]) include = interesting || offset % 3 === 0; // mid: + weekday every 3 days
    else include = interesting || offset % 9 === 0; // long: sparse ordinary-weekday backfill (unchanged)
    if (include) {
      out.push({ stayDate, bucket, forced: forced.has(stayDate) });
      seen.add(stayDate);
    }
  }
  // Forced spot-check dates within the horizon the rules didn't already include.
  for (const f of forced) {
    if (seen.has(f)) continue;
    const off = offsetDays(runDateIso, f);
    if (off < 1 || off > BUCKET_RANGES.long[1]) continue;
    const bucket = bucketForOffset(off);
    if (bucket === null) continue;
    out.push({ stayDate: f, bucket, forced: true });
  }
  return out;
}

function cooldownKey(source: string, slug: string, stayDate: string): string {
  return `${source}|${slug}|${stayDate}`;
}

// lastCollectedAt: key `${source}|${slug}|${stayDate}` -> ISO collected_at timestamp (most recent).
export function buildRotatingPlan(input: {
  runDateIso: string;
  nowIso: string;
  slotHourJst: number;
  liveTargets: readonly MarketRefreshPropertyTarget[];
  config: RotatingDemandConfig;
  lastCollectedAt: ReadonlyMap<string, string>;
  caps?: RotatingCaps;
  nearTermDenseDays?: number;
  forcedDates?: readonly string[];
}): RotatingPlan {
  const caps = input.caps ?? ROTATING_CAPS;
  const denseDays = input.nearTermDenseDays ?? DEFAULT_NEAR_TERM_DENSE_DAYS;
  const slot = buildSlot(input.runDateIso, input.slotHourJst);
  const dates = candidateStayDates(input.runDateIso, input.config, { nearTermDenseDays: denseDays, forcedDates: input.forcedDates ?? [] });

  const excludedCooldown: RotatingPlan["excluded_by_cooldown"] = [];
  const candidates: RotatingTarget[] = [];

  for (const target of input.liveTargets) {
    if (target.source !== "booking" && target.source !== "jalan") continue; // Rakuten/Google never
    if (!target.enabled_for_live || !target.verified_mapping) continue;
    for (const { stayDate, bucket, forced } of dates) {
      const key = cooldownKey(target.source, target.property_slug, stayDate);
      const lastIso = input.lastCollectedAt.get(key);
      const collectedRecently = lastIso !== undefined && withinHours(lastIso, input.nowIso, COOLDOWN_HOURS);
      if (collectedRecently) {
        excludedCooldown.push({ source: target.source, property_slug: target.property_slug, stay_date: stayDate });
        continue;
      }
      const offset = offsetDays(input.runDateIso, stayDate);
      const { score, reasons } = scoreTarget(stayDate, bucket, target.tier, input.config, false, { offset, forced, nearTermDenseDays: denseDays });
      candidates.push({
        source: target.source,
        property_slug: target.property_slug,
        canonical_property_name: target.canonical_property_name,
        stay_date: stayDate,
        checkin: stayDate,
        bucket,
        tier: target.tier,
        priority_score: score,
        reason_codes: reasons,
        estimated_page_count: 1
      });
    }
  }

  // Sort by score desc, stable tiebreak by key.
  candidates.sort((a, b) => b.priority_score - a.priority_score || keyOf(a).localeCompare(keyOf(b)));

  // KIRAKU-BOOKING-FIX01 (2026-07-13): interleave by property BEFORE rotating,
  // SEPARATELY per source, with a rotation offset that also advances by
  // calendar day (not just intraday slot). Two compounding problems, found by
  // live verification that 喜らく/Kiraku's Booking slug "xi-raku" was selected
  // in ZERO of the 12 daily slots despite being a correctly registered,
  // verified live target:
  //   1. A flat score-sorted candidate pool can hold thousands of entries
  //      (many dates x many properties across BOTH sources combined), while
  //      slot_index only ranges 0..11 (12 slots/day) — rotating that flat
  //      array shifts the start by at most 11 positions out of thousands,
  //      negligible: the same handful of top-scoring properties wins the
  //      per-run cap on every slot, every day. Interleaving one candidate per
  //      property (round-robin, each property's own list still internally
  //      score-sorted) collapses the rotation unit from "candidate count" to
  //      "distinct property count" (~24 for Booking) — small enough for an
  //      11-position rotation to matter. Interleaving booking+jalan SEPARATELY
  //      (not mixed together) avoids halving that already-small cycle length.
  //   2. Even with a clean per-source ~24-group cycle, an 11-position rotation
  //      spans only 12 of 24 groups on any single day — the group ranked
  //      dead-last would still never rotate into range, forever. Folding
  //      epochDay(runDateIso) into the offset (mod group count) means the
  //      OTHER 12 groups get their turn as the calendar date advances,
  //      matching the same self-healing, no-stored-state design already
  //      proven in priorityRefreshTiers.ts's isSelectedToday.
  // General fix: no property-specific exception, same mechanism (and the same
  // roundRobinByGroup helper) proven in priorityRefreshTiers.ts's own
  // starvation fix.
  function interleaveAndRotate(source: "booking" | "jalan"): RotatingTarget[] {
    const sourceCandidates = candidates.filter((c) => c.source === source);
    const interleaved = roundRobinByGroup(sourceCandidates, (c) => c.property_slug);
    const groupCount = new Set(sourceCandidates.map((c) => c.property_slug)).size;
    if (groupCount === 0) return interleaved;
    const dayOffset = epochDay(input.runDateIso) % groupCount;
    const offsetInGroups = (dayOffset + slot.slot_index) % groupCount;
    // roundRobinByGroup lays out one item per group per "round" (index 0 of
    // every group, then index 1 of every group, ...), so the first groupCount
    // entries are each group's own first item, in group order — rotating the
    // interleaved array by offsetInGroups positions (< groupCount) directly
    // shifts which group's turn comes first, without needing any conversion.
    return rotate(interleaved, offsetInGroups);
  }
  const rotated = [...interleaveAndRotate("booking"), ...interleaveAndRotate("jalan")];

  // Bucket soft targets: short 35% / mid 40% / long(+winter) 25% of total cap.
  const bucketSoftMax: Record<RotatingBucket, number> = {
    short: Math.ceil(caps.total_pages_per_run * 0.35) + 1,
    mid: Math.ceil(caps.total_pages_per_run * 0.40) + 1,
    long: Math.ceil(caps.total_pages_per_run * 0.25) + 1
  };
  // Tier soft max to avoid all-anchor selection.
  const tierSoftMax = Math.ceil(caps.total_pages_per_run * 0.7);

  const selected: RotatingTarget[] = [];
  const bySource: Record<string, number> = { booking: 0, jalan: 0 };
  const byBucket: Record<string, number> = { short: 0, mid: 0, long: 0 };
  const byTier: Record<string, number> = {};
  const byProperty: Record<string, number> = {};
  const byStayDate: Record<string, number> = {};
  const seenPair = new Set<string>();
  let excludedByCap = 0;
  let excludedByDiversity = 0;
  const diversityCounted = new Set<string>();

  // Passes (selection order §7.6), progressively relaxing soft constraints only
  // as far as needed to fill the cap:
  //  1. balance + property cap + date cap (preferred — max facility & date spread)
  //  2. relax bucket/tier balance, keep property + date caps
  //  3. relax date cap (allow same-date cross-source), keep property cap
  //  4. relax property cap too (only if verified properties are too few)
  const passes = [
    { balance: true, propCap: true, dateCap: true },
    { balance: false, propCap: true, dateCap: true },
    { balance: false, propCap: true, dateCap: false },
    { balance: false, propCap: false, dateCap: false }
  ];
  for (const pass of passes) {
    for (const c of rotated) {
      if (selected.length >= caps.total_pages_per_run) break;
      const pairKey = keyOf(c);
      if (seenPair.has(pairKey)) continue;
      const srcCap = c.source === "booking" ? caps.booking_pages_per_run : caps.jalan_pages_per_run;
      if ((bySource[c.source] ?? 0) >= srcCap) { if (pass.balance) excludedByCap += 1; continue; }
      const propKey = `${c.source}|${c.property_slug}`;
      if (pass.propCap && (byProperty[propKey] ?? 0) >= MAX_TARGETS_PER_PROPERTY_PER_RUN) {
        if (!diversityCounted.has(pairKey)) { excludedByDiversity += 1; diversityCounted.add(pairKey); }
        continue;
      }
      if (pass.dateCap && (byStayDate[c.stay_date] ?? 0) >= MAX_TARGETS_PER_STAY_DATE_PER_RUN) continue;
      if (pass.balance) {
        if ((byBucket[c.bucket] ?? 0) >= bucketSoftMax[c.bucket]) continue;
        if ((byTier[c.tier] ?? 0) >= tierSoftMax) continue;
      }
      selected.push(c);
      seenPair.add(pairKey);
      bySource[c.source] = (bySource[c.source] ?? 0) + 1;
      byBucket[c.bucket] = (byBucket[c.bucket] ?? 0) + 1;
      byTier[c.tier] = (byTier[c.tier] ?? 0) + 1;
      byProperty[propKey] = (byProperty[propKey] ?? 0) + 1;
      byStayDate[c.stay_date] = (byStayDate[c.stay_date] ?? 0) + 1;
    }
    if (selected.length >= caps.total_pages_per_run) break;
  }

  // Diversity metrics.
  const distinctPropBySource: Record<string, number> = {};
  for (const src of ["booking", "jalan"]) {
    distinctPropBySource[src] = new Set(selected.filter((t) => t.source === src).map((t) => t.property_slug)).size;
  }
  const byPropertyOut: Record<string, number> = {};
  for (const t of selected) byPropertyOut[`${t.source}|${t.property_slug}`] = (byPropertyOut[`${t.source}|${t.property_slug}`] ?? 0) + 1;
  const warnings: string[] = [];
  if ((distinctPropBySource["booking"] ?? 0) > 0 && (distinctPropBySource["booking"] ?? 0) < 3) warnings.push(`booking_distinct_properties_lt_3:${distinctPropBySource["booking"]}`);
  if ((distinctPropBySource["jalan"] ?? 0) > 0 && (distinctPropBySource["jalan"] ?? 0) < 3) warnings.push(`jalan_distinct_properties_lt_3:${distinctPropBySource["jalan"]}`);
  for (const [k, v] of Object.entries(byPropertyOut)) if (v > MAX_TARGETS_PER_PROPERTY_PER_RUN) warnings.push(`property_over_cap:${k}=${v}`);

  // Phase AUTO-RUNNER17X diagnostics (derived from reason_codes).
  const isNearTerm = (t: RotatingTarget): boolean => t.reason_codes.includes("near_term_dense");
  const isForced = (t: RotatingTarget): boolean => t.reason_codes.includes("forced_checkin_date");
  const isOrdinaryWeekdayNearTerm = (t: RotatingTarget): boolean => isNearTerm(t) && t.reason_codes.includes("ordinary_weekday");

  return {
    slot_key: slot.slot_key,
    slot_index: slot.slot_index,
    caps,
    selected,
    excluded_by_cooldown: excludedCooldown,
    excluded_by_cap: excludedByCap,
    excluded_by_property_diversity_cap: excludedByDiversity,
    candidate_count: candidates.length,
    selected_by_source: bySource,
    selected_by_bucket: byBucket,
    selected_by_tier: byTier,
    selected_distinct_properties_by_source: distinctPropBySource,
    selected_distinct_stay_dates: new Set(selected.map((t) => t.stay_date)).size,
    selected_targets_by_property: byPropertyOut,
    property_diversity_warning: warnings,
    estimated_total_pages: selected.reduce((n, t) => n + t.estimated_page_count, 0),
    near_term_dense_candidate_count: candidates.filter(isNearTerm).length,
    near_term_dense_selected_count: selected.filter(isNearTerm).length,
    ordinary_weekday_near_term_candidate_count: candidates.filter(isOrdinaryWeekdayNearTerm).length,
    ordinary_weekday_near_term_selected_count: selected.filter(isOrdinaryWeekdayNearTerm).length,
    forced_checkin_candidate_count: candidates.filter(isForced).length,
    forced_checkin_selected_count: selected.filter(isForced).length
  };
}

function keyOf(t: RotatingTarget): string {
  return `${t.source}|${t.property_slug}|${t.stay_date}`;
}

function rotate<T>(arr: readonly T[], by: number): T[] {
  if (arr.length === 0) return [];
  const offset = ((by % arr.length) + arr.length) % arr.length;
  return [...arr.slice(offset), ...arr.slice(0, offset)];
}

function hourMs(iso: string): number {
  const m = /T(\d{2}):(\d{2})/u.exec(iso);
  if (!m) return 0;
  return Number(m[1]) * 60 * 60 * 1000 + Number(m[2]) * 60 * 1000;
}

function withinHours(pastIso: string, nowIso: string, hours: number): boolean {
  const past = parseYmd(pastIso.slice(0, 10)).getTime() + hourMs(pastIso);
  const now = parseYmd(nowIso.slice(0, 10)).getTime() + hourMs(nowIso);
  return now - past < hours * 60 * 60 * 1000 && now - past >= 0;
}

// Phase AUTO-RUNNER14X - time-bucketed collection scope planner (pure, dry-run).
//
// This module contains NO I/O, no browser, no DB, no network. It produces a
// deterministic dry-run plan of future collection targets by time bucket and
// demand priority. It runs no collectors, appends no history, syncs no DB,
// refreshes no AI context, writes no property master, and emits no pricing/PMS
// output. Rakuten and Google Hotels remain live-disabled (can_collect=false).

export type Bucket = "short" | "mid" | "long";
export type PlannerSource = "booking" | "jalan" | "rakuten" | "google_hotels";

export const ENABLED_SOURCES: ReadonlySet<PlannerSource> = new Set(["booking", "jalan"]);

export const PAGE_CAPS = {
  total_daily_cap: 60,
  booking_daily_cap: 30,
  jalan_daily_cap: 30,
  rakuten_daily_cap: 0,
  google_hotels_daily_cap: 0
} as const;

export const BUCKET_RANGES = {
  short: { from: 0, to: 14 },
  mid: { from: 15, to: 90 },
  long: { from: 91, to: 180 }
} as const;

export const BUCKET_BASE_SCORE: Record<Bucket, number> = { short: 80, mid: 50, long: 30 };

export interface PlannerProperty {
  source: PlannerSource;
  property_slug: string;
  canonical_property_name: string;
}

export interface DemandConfig {
  // ISO date -> holiday name
  public_holidays: Record<string, string>;
  long_weekend_dates: ReadonlySet<string>;
  peak_periods: Array<{ code: string; from: string; to: string; saturday_only?: boolean }>;
}

export interface PlannerTarget {
  run_date_jst: string;
  stay_date: string;
  bucket: Bucket;
  source: PlannerSource;
  property_slug: string;
  canonical_property_name: string;
  priority_score: number;
  reason_codes: string[];
  estimated_page_count: number;
  can_collect: boolean;
  exclusion_reason: string;
}

export interface ScopePlan {
  run_date_jst: string;
  total_candidates: number;
  selected: PlannerTarget[];
  excluded_by_cap: PlannerTarget[];
  excluded_by_disabled_source: PlannerTarget[];
  estimated_total_pages: number;
  selected_pages_by_source: Record<string, number>;
  selected_pages_by_bucket: Record<string, number>;
  page_caps: typeof PAGE_CAPS;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function bucketForOffset(offsetDays: number): Bucket | null {
  if (offsetDays >= BUCKET_RANGES.short.from && offsetDays <= BUCKET_RANGES.short.to) return "short";
  if (offsetDays >= BUCKET_RANGES.mid.from && offsetDays <= BUCKET_RANGES.mid.to) return "mid";
  if (offsetDays >= BUCKET_RANGES.long.from && offsetDays <= BUCKET_RANGES.long.to) return "long";
  return null;
}

function parseYmd(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) throw new Error(`expected YYYY-MM-DD: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function toYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function dayOffset(runDateIso: string, stayDateIso: string): number {
  return Math.round((parseYmd(stayDateIso).getTime() - parseYmd(runDateIso).getTime()) / ONE_DAY_MS);
}

// Deterministic per-stay-date scoring. Modifiers stack and the result is clamped
// to [0, 100]. Reason codes explain every applied modifier plus the bucket.
export function scoreStayDate(stayDateIso: string, bucket: Bucket, config: DemandConfig): { score: number; reasonCodes: string[] } {
  const date = parseYmd(stayDateIso);
  const dow = date.getUTCDay(); // 0=Sun ... 6=Sat
  const reasons: string[] = [bucket];
  let score = BUCKET_BASE_SCORE[bucket];

  if (dow === 6) { score += 20; reasons.push("saturday"); }
  else if (dow === 5) { score += 10; reasons.push("friday"); }
  else if (dow === 0) { score += 10; reasons.push("sunday"); }

  const holidayName = config.public_holidays[stayDateIso];
  if (holidayName !== undefined) {
    if (dow !== 0) { score += 10; reasons.push("day_off"); }
    score += 20;
    reasons.push("public_holiday");
  }
  if (config.long_weekend_dates.has(stayDateIso)) { score += 25; reasons.push("long_weekend"); }

  for (const peak of config.peak_periods) {
    if (stayDateIso >= peak.from && stayDateIso <= peak.to) {
      if (peak.saturday_only && dow !== 6) continue;
      const points = peakPoints(peak.code);
      score += points;
      reasons.push(peak.code);
    }
  }

  if (reasons.length === 1) reasons.push("ordinary_weekday");
  return { score: clamp(score), reasonCodes: reasons };
}

function peakPoints(code: string): number {
  switch (code) {
    case "year_end_peak":
    case "new_year_peak":
      return 40;
    case "ski_season_saturday":
      return 30;
    case "obon":
      return 30;
    case "autumn_foliage_saturday":
      return 25;
    case "golden_week":
      return 25;
    default:
      return 25; // generic known peak season
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// Candidate stay-dates per bucket. Short = every day; mid/long = only
// weekend/holiday/peak dates (rotation intent), to avoid scheduling ordinary
// weekdays in the far future.
export function candidateStayDates(runDateIso: string, config: DemandConfig): { stayDate: string; bucket: Bucket }[] {
  const out: { stayDate: string; bucket: Bucket }[] = [];
  const run = parseYmd(runDateIso);
  for (let offset = 1; offset <= BUCKET_RANGES.long.to; offset += 1) {
    const date = new Date(run.getTime() + offset * ONE_DAY_MS);
    const stayDate = toYmd(date);
    const bucket = bucketForOffset(offset);
    if (bucket === null) continue;
    if (bucket === "short") { out.push({ stayDate, bucket }); continue; }
    const dow = date.getUTCDay();
    const isWeekendish = dow === 5 || dow === 6 || dow === 0;
    const isHoliday = config.public_holidays[stayDate] !== undefined || config.long_weekend_dates.has(stayDate);
    const inPeak = config.peak_periods.some((p) => stayDate >= p.from && stayDate <= p.to && (!p.saturday_only || dow === 6));
    if (bucket === "mid" && (isWeekendish || isHoliday || inPeak)) out.push({ stayDate, bucket });
    if (bucket === "long" && (dow === 6 || isHoliday || inPeak)) out.push({ stayDate, bucket });
  }
  return out;
}

export function buildCandidateTargets(input: {
  runDateIso: string;
  properties: readonly PlannerProperty[];
  config: DemandConfig;
}): PlannerTarget[] {
  const dates = candidateStayDates(input.runDateIso, input.config);
  const targets: PlannerTarget[] = [];
  for (const { stayDate, bucket } of dates) {
    const { score, reasonCodes } = scoreStayDate(stayDate, bucket, input.config);
    for (const property of input.properties) {
      const enabled = ENABLED_SOURCES.has(property.source);
      targets.push({
        run_date_jst: input.runDateIso,
        stay_date: stayDate,
        bucket,
        source: property.source,
        property_slug: property.property_slug,
        canonical_property_name: property.canonical_property_name,
        priority_score: score,
        reason_codes: reasonCodes,
        estimated_page_count: 1,
        can_collect: enabled,
        exclusion_reason: enabled ? "" : `source_live_disabled:${property.source}`
      });
    }
  }
  return targets;
}

const BUCKET_ORDER: Record<Bucket, number> = { short: 0, mid: 1, long: 2 };

// Selection order: priority desc, then short<mid<long, then Saturday/holiday
// first, then round-robin source balance (stable by index for determinism).
export function selectWithinCaps(candidates: readonly PlannerTarget[]): ScopePlan {
  const runDate = candidates[0]?.run_date_jst ?? "";
  const collectable = candidates.filter((t) => t.can_collect);
  const disabled = candidates.filter((t) => !t.can_collect);

  const ranked = [...collectable]
    .map((t, idx) => ({ t, idx }))
    .sort((a, b) => {
      if (b.t.priority_score !== a.t.priority_score) return b.t.priority_score - a.t.priority_score;
      if (BUCKET_ORDER[a.t.bucket] !== BUCKET_ORDER[b.t.bucket]) return BUCKET_ORDER[a.t.bucket] - BUCKET_ORDER[b.t.bucket];
      const aPref = a.t.reason_codes.includes("saturday") || a.t.reason_codes.includes("public_holiday") ? 0 : 1;
      const bPref = b.t.reason_codes.includes("saturday") || b.t.reason_codes.includes("public_holiday") ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return a.idx - b.idx;
    })
    .map((x) => x.t);

  const perSourceCap: Record<string, number> = {
    booking: PAGE_CAPS.booking_daily_cap,
    jalan: PAGE_CAPS.jalan_daily_cap,
    rakuten: PAGE_CAPS.rakuten_daily_cap,
    google_hotels: PAGE_CAPS.google_hotels_daily_cap
  };
  const usedBySource: Record<string, number> = { booking: 0, jalan: 0, rakuten: 0, google_hotels: 0 };
  const selected: PlannerTarget[] = [];
  const excludedByCap: PlannerTarget[] = [];
  let total = 0;
  for (const t of ranked) {
    const pages = t.estimated_page_count;
    if (total + pages > PAGE_CAPS.total_daily_cap || usedBySource[t.source]! + pages > (perSourceCap[t.source] ?? 0)) {
      excludedByCap.push(t);
      continue;
    }
    selected.push(t);
    usedBySource[t.source] = usedBySource[t.source]! + pages;
    total += pages;
  }

  return {
    run_date_jst: runDate,
    total_candidates: candidates.length,
    selected,
    excluded_by_cap: excludedByCap,
    excluded_by_disabled_source: disabled,
    estimated_total_pages: total,
    selected_pages_by_source: countPages(selected, (t) => t.source),
    selected_pages_by_bucket: countPages(selected, (t) => t.bucket),
    page_caps: PAGE_CAPS
  };
}

export function buildScopePlan(input: {
  runDateIso: string;
  properties: readonly PlannerProperty[];
  config: DemandConfig;
}): ScopePlan {
  return selectWithinCaps(buildCandidateTargets(input));
}

function countPages(targets: readonly PlannerTarget[], key: (t: PlannerTarget) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of targets) out[key(t)] = (out[key(t)] ?? 0) + t.estimated_page_count;
  return out;
}

export const PLAN_CSV_HEADERS = [
  "run_date_jst", "stay_date", "bucket", "source", "property_slug",
  "canonical_property_name", "priority_score", "reason_codes",
  "estimated_page_count", "can_collect", "exclusion_reason"
] as const;

export function renderPlanCsv(targets: readonly PlannerTarget[]): string {
  const body = targets.map((t) =>
    [
      t.run_date_jst, t.stay_date, t.bucket, t.source, t.property_slug,
      t.canonical_property_name, String(t.priority_score), t.reason_codes.join("|"),
      String(t.estimated_page_count), String(t.can_collect), t.exclusion_reason
    ].map(csvCell).join(",")
  );
  return [PLAN_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderPlanReport(plan: ScopePlan, generatedAtJst: string): string {
  return `# Collection Scope Plan (AUTO-RUNNER14X, dry-run)

Generated at JST: ${generatedAtJst}
Run date: ${plan.run_date_jst}

## 1. Caps

${JSON.stringify(plan.page_caps, null, 2)}

## 2. Totals

- total_candidates: ${plan.total_candidates}
- selected: ${plan.selected.length}
- excluded_by_cap: ${plan.excluded_by_cap.length}
- excluded_by_disabled_source: ${plan.excluded_by_disabled_source.length}
- estimated_total_pages: ${plan.estimated_total_pages}
- selected_pages_by_source: ${JSON.stringify(plan.selected_pages_by_source)}
- selected_pages_by_bucket: ${JSON.stringify(plan.selected_pages_by_bucket)}

## 3. Top selected targets

${plan.selected.slice(0, 25).map((t) => `- [${t.priority_score}] ${t.bucket} ${t.source} ${t.canonical_property_name} ${t.stay_date} (${t.reason_codes.join("|")})`).join("\n") || "- (none)"}

## 4. Safety

- dry-run only; no live collection, no append, no DB sync, no AI context, no pricing/PMS output.
- Rakuten/Google live disabled (rakuten_daily_cap=0, google_hotels_daily_cap=0).
`;
}

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

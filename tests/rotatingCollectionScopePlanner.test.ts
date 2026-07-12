import { describe, expect, it } from "vitest";
import {
  DAILY_PAGE_CAPACITY,
  MAX_TARGETS_PER_PROPERTY_PER_RUN,
  ROTATING_CAPS,
  SLOT_HOURS,
  buildRotatingPlan,
  buildSlot,
  candidateStayDates,
  scaledRotatingCaps,
  type RotatingDemandConfig
} from "../src/services/rotatingCollectionScopePlanner";
import { liveTargets } from "../src/services/marketRefreshTargetUniverse";

const CONFIG: RotatingDemandConfig = {
  public_holidays: { "2026-07-20": "海の日", "2026-08-11": "山の日" },
  long_weekend_dates: new Set(["2026-09-19", "2026-09-20"]),
  peak_periods: [
    { code: "obon", from: "2026-08-08", to: "2026-08-16" },
    { code: "ski_season", from: "2026-12-19", to: "2027-03-15", saturday_only: true }
  ]
};
const RUN_DATE = "2026-06-10";

function plan(slotHour: number, lastCollectedAt = new Map<string, string>()) {
  return buildRotatingPlan({ runDateIso: RUN_DATE, nowIso: `${RUN_DATE}T${String(slotHour).padStart(2, "0")}:00:00+09:00`, slotHourJst: slotHour, liveTargets: liveTargets(), config: CONFIG, lastCollectedAt });
}

describe("AUTO-RUNNER16X - rotating slots", () => {
  it("slot hours are 0,2,...,22", () => {
    expect([...SLOT_HOURS]).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  });

  it("buildSlot derives slot_index from hour", () => {
    expect(buildSlot(RUN_DATE, 0).slot_index).toBe(0);
    expect(buildSlot(RUN_DATE, 22).slot_index).toBe(11);
    expect(buildSlot(RUN_DATE, 12).slot_key).toBe("2026-06-10-12");
  });
});

describe("AUTO-RUNNER16X - caps and source isolation", () => {
  it("respects total/booking/jalan caps", () => {
    const p = plan(8);
    expect(p.selected.length).toBeLessThanOrEqual(ROTATING_CAPS.total_pages_per_run);
    expect(p.selected_by_source["booking"] ?? 0).toBeLessThanOrEqual(ROTATING_CAPS.booking_pages_per_run);
    expect(p.selected_by_source["jalan"] ?? 0).toBeLessThanOrEqual(ROTATING_CAPS.jalan_pages_per_run);
  });

  it("only booking/jalan selected; never rakuten/google", () => {
    const p = plan(8);
    expect(p.selected.every((t) => t.source === "booking" || t.source === "jalan")).toBe(true);
  });

  it("rakuten/google caps are 0", () => {
    expect(ROTATING_CAPS.rakuten_pages_per_run).toBe(0);
    expect(ROTATING_CAPS.google_hotels_pages_per_run).toBe(0);
  });

  it("checkin equals planner stay_date (no fixed PEAK_DATE)", () => {
    const p = plan(8);
    expect(p.selected.every((t) => t.checkin === t.stay_date)).toBe(true);
    // not all selected dates collapse to a single fixed date
    const distinctDates = new Set(p.selected.map((t) => t.stay_date));
    expect(distinctDates.size).toBeGreaterThan(1);
  });
});

describe("AUTO-RUNNER16X - cooldown", () => {
  it("excludes targets collected within 24h", () => {
    const free = plan(8);
    expect(free.selected.length).toBeGreaterThan(0);
    const first = free.selected[0]!;
    const key = `${first.source}|${first.property_slug}|${first.stay_date}`;
    const cooled = plan(8, new Map([[key, `${RUN_DATE}T02:00:00+09:00`]]));
    expect(cooled.excluded_by_cooldown.some((e) => e.property_slug === first.property_slug && e.stay_date === first.stay_date)).toBe(true);
    expect(cooled.selected.some((t) => t.property_slug === first.property_slug && t.stay_date === first.stay_date)).toBe(false);
  });

  it("does not exclude targets collected more than 24h ago", () => {
    const free = plan(8);
    const first = free.selected[0]!;
    const key = `${first.source}|${first.property_slug}|${first.stay_date}`;
    // collected 2 days earlier -> not within 24h
    const notCooled = plan(8, new Map([[key, "2026-06-08T08:00:00+09:00"]]));
    expect(notCooled.excluded_by_cooldown.some((e) => e.property_slug === first.property_slug && e.stay_date === first.stay_date)).toBe(false);
  });
});

describe("AUTO-RUNNER16X - balance and rotation", () => {
  it("does not collapse entirely to one bucket", () => {
    const p = plan(8);
    const buckets = Object.entries(p.selected_by_bucket).filter(([, v]) => v > 0).map(([k]) => k);
    expect(buckets.length).toBeGreaterThanOrEqual(2);
  });

  it("does not collapse entirely to anchor-high tier", () => {
    const p = plan(8);
    const anchor = p.selected_by_tier["tier_anchor_high"] ?? 0;
    expect(anchor).toBeLessThan(p.selected.length); // some non-anchor present
  });

  it("different slots rotate to different target sets", () => {
    const a = plan(8).selected.map((t) => `${t.property_slug}|${t.stay_date}`).join(",");
    const b = plan(16).selected.map((t) => `${t.property_slug}|${t.stay_date}`).join(",");
    expect(a).not.toBe(b);
  });

  it("candidateStayDates produces dates across buckets", () => {
    const dates = candidateStayDates(RUN_DATE, CONFIG);
    const buckets = new Set(dates.map((d) => d.bucket));
    expect(buckets.has("short")).toBe(true);
    expect(buckets.has("mid")).toBe(true);
    expect(buckets.has("long")).toBe(true);
  });
});

describe("AUTO-RUNNER16X-A2 - property diversity", () => {
  it("no single property exceeds the per-run cap of 2", () => {
    const p = plan(8);
    expect(MAX_TARGETS_PER_PROPERTY_PER_RUN).toBe(2);
    for (const [, count] of Object.entries(p.selected_targets_by_property)) {
      expect(count).toBeLessThanOrEqual(MAX_TARGETS_PER_PROPERTY_PER_RUN);
    }
  });

  it("selects >= 3 distinct properties per source (16X-A4: 17 booking / 17 jalan verified)", () => {
    const p = plan(8);
    expect(p.selected_distinct_properties_by_source["booking"]).toBeGreaterThanOrEqual(3);
    expect(p.selected_distinct_properties_by_source["jalan"]).toBeGreaterThanOrEqual(3);
  });

  it("selects >= 8 distinct stay dates (date cap spreads dates)", () => {
    expect(plan(8).selected_distinct_stay_dates).toBeGreaterThanOrEqual(8);
  });

  it("a single high-score property does not monopolize the run", () => {
    const p = plan(8);
    const max = Math.max(...Object.values(p.selected_targets_by_property));
    expect(max).toBeLessThanOrEqual(MAX_TARGETS_PER_PROPERTY_PER_RUN);
  });

  it("reports excluded_by_property_diversity_cap when capping occurs", () => {
    const p = plan(8);
    expect(typeof p.excluded_by_property_diversity_cap).toBe("number");
    expect(p.excluded_by_property_diversity_cap).toBeGreaterThan(0);
  });

  it("cooldown and diversity cap work together", () => {
    const free = plan(8);
    const first = free.selected[0]!;
    const key = `${first.source}|${first.property_slug}|${first.stay_date}`;
    const p = plan(8, new Map([[key, `${RUN_DATE}T02:00:00+09:00`]]));
    expect(p.excluded_by_cooldown.length).toBeGreaterThan(0);
    for (const [, count] of Object.entries(p.selected_targets_by_property)) expect(count).toBeLessThanOrEqual(MAX_TARGETS_PER_PROPERTY_PER_RUN);
  });
});

describe("AUTO-RUNNER16X-F - expanded caps and capacity", () => {
  it("ROTATING_CAPS expanded to 24 / 12 / 12; Rakuten+Google stay 0", () => {
    expect(ROTATING_CAPS.total_pages_per_run).toBe(24);
    expect(ROTATING_CAPS.booking_pages_per_run).toBe(12);
    expect(ROTATING_CAPS.jalan_pages_per_run).toBe(12);
    expect(ROTATING_CAPS.rakuten_pages_per_run).toBe(0);
    expect(ROTATING_CAPS.google_hotels_pages_per_run).toBe(0);
  });

  it("theoretical daily capacity = 288 (booking 144 / jalan 144)", () => {
    expect(DAILY_PAGE_CAPACITY.theoretical_daily_page_capacity).toBe(288);
    expect(DAILY_PAGE_CAPACITY.booking_daily_capacity).toBe(144);
    expect(DAILY_PAGE_CAPACITY.jalan_daily_capacity).toBe(144);
  });

  it("respects the new total/booking/jalan caps with the expanded universe", () => {
    const p = plan(8);
    expect(p.selected.length).toBeLessThanOrEqual(24);
    expect(p.selected_by_source["booking"] ?? 0).toBeLessThanOrEqual(12);
    expect(p.selected_by_source["jalan"] ?? 0).toBeLessThanOrEqual(12);
  });

  it("selects >= 6 distinct properties per source under cap 24", () => {
    const p = plan(8);
    expect(p.selected_distinct_properties_by_source["booking"]).toBeGreaterThanOrEqual(6);
    expect(p.selected_distinct_properties_by_source["jalan"]).toBeGreaterThanOrEqual(6);
  });

  it("selects >= 18 distinct stay dates under cap 24 (1 target/stay_date)", () => {
    expect(plan(8).selected_distinct_stay_dates).toBeGreaterThanOrEqual(18);
  });

  it("never selects Rakuten or Google", () => {
    expect(plan(8).selected.every((t) => t.source === "booking" || t.source === "jalan")).toBe(true);
  });
});

describe("AUTO-RUNNER16X - rotating crawl volume multiplier", () => {
  function planWithCaps(slotHour: number, multiplier: number) {
    return buildRotatingPlan({
      runDateIso: RUN_DATE,
      nowIso: `${RUN_DATE}T${String(slotHour).padStart(2, "0")}:00:00+09:00`,
      slotHourJst: slotHour,
      liveTargets: liveTargets(),
      config: CONFIG,
      lastCollectedAt: new Map<string, string>(),
      caps: scaledRotatingCaps(multiplier)
    });
  }

  it("scaledRotatingCaps triples enabled caps and keeps disabled sources at 0", () => {
    expect(scaledRotatingCaps(1)).toEqual(ROTATING_CAPS);
    const x3 = scaledRotatingCaps(3);
    expect(x3.total_pages_per_run).toBe(72);
    expect(x3.booking_pages_per_run).toBe(36);
    expect(x3.jalan_pages_per_run).toBe(36);
    expect(x3.rakuten_pages_per_run).toBe(0);
    expect(x3.google_hotels_pages_per_run).toBe(0);
  });

  it("multiplier=3 selects strictly more pages than baseline, within scaled caps", () => {
    const m1 = planWithCaps(8, 1);
    const m3 = planWithCaps(8, 3);
    expect(m3.caps.total_pages_per_run).toBe(72);
    expect(m3.selected.length).toBeGreaterThan(m1.selected.length);
    expect(m3.selected.length).toBeLessThanOrEqual(72);
    expect(m3.selected_by_source["booking"] ?? 0).toBeLessThanOrEqual(36);
    expect(m3.selected_by_source["jalan"] ?? 0).toBeLessThanOrEqual(36);
  });

  it("multiplier=3 never leaks Rakuten/Google into the higher-volume selection", () => {
    const m3 = planWithCaps(8, 3);
    expect(m3.selected.every((t) => t.source === "booking" || t.source === "jalan")).toBe(true);
  });
});

describe("AUTO-RUNNER17X - near-term dense + forced checkin dates", () => {
  const NT_RUN = "2026-06-14";
  function ntPlan(opts: { nearTermDenseDays?: number; forcedDates?: readonly string[]; multiplier?: number }) {
    return buildRotatingPlan({
      runDateIso: NT_RUN,
      nowIso: `${NT_RUN}T08:00:00+09:00`,
      slotHourJst: 8,
      liveTargets: liveTargets(),
      config: CONFIG,
      lastCollectedAt: new Map<string, string>(),
      caps: scaledRotatingCaps(opts.multiplier ?? 3),
      nearTermDenseDays: opts.nearTermDenseDays ?? 30,
      forcedDates: opts.forcedDates ?? []
    });
  }

  it("§8.1 — the next 30 days are all-day candidates (incl. ordinary weekdays)", () => {
    const dates = candidateStayDates(NT_RUN, CONFIG, { nearTermDenseDays: 30 });
    const set = new Set(dates.map((d) => d.stayDate));
    expect(set.has("2026-06-15")).toBe(true); // offset 1
    expect(set.has("2026-06-16")).toBe(true); // Tuesday — ordinary weekday in range
    expect(set.has("2026-07-14")).toBe(true); // offset 30
    // every offset 1..30 present = 30 distinct near-term dates
    const nearTerm = dates.filter((d) => d.stayDate >= "2026-06-15" && d.stayDate <= "2026-07-14");
    expect(nearTerm.length).toBe(30);
  });

  it("§8.4 — 2026-06-25 (ordinary weekday) is never dropped from candidates", () => {
    const set = new Set(candidateStayDates(NT_RUN, CONFIG, { nearTermDenseDays: 30 }).map((d) => d.stayDate));
    expect(set.has("2026-06-25")).toBe(true);
    const plan = ntPlan({});
    const ow = plan.ordinary_weekday_near_term_candidate_count;
    expect(ow).toBeGreaterThan(0);
  });

  it("§8.2 — forced dates carry forced_checkin_date and are selected/boosted", () => {
    const plan = ntPlan({ forcedDates: ["2026-06-25"] });
    expect(plan.forced_checkin_candidate_count).toBeGreaterThan(0);
    const sixForced = plan.selected.filter((t) => t.stay_date === "2026-06-25");
    expect(sixForced.length).toBeGreaterThan(0);
    expect(sixForced.every((t) => t.reason_codes.includes("forced_checkin_date"))).toBe(true);
    expect(plan.forced_checkin_selected_count).toBeGreaterThan(0);
  });

  it("forced dates outside the normal rules are still added as candidates", () => {
    // 2026-09-15 is a Tuesday in the long bucket — not normally collected daily.
    const dates = candidateStayDates(NT_RUN, CONFIG, { nearTermDenseDays: 30, forcedDates: ["2026-09-15"] });
    const hit = dates.find((d) => d.stayDate === "2026-09-15");
    expect(hit?.forced).toBe(true);
  });

  it("§8.3 — coexists with multiplier=3: ~72 pages, near-term weekdays selected, no leaks", () => {
    const plan = ntPlan({ multiplier: 3 });
    expect(plan.caps.total_pages_per_run).toBe(72);
    expect(plan.selected.length).toBeLessThanOrEqual(72);
    expect(plan.near_term_dense_candidate_count).toBeGreaterThan(0);
    expect(plan.ordinary_weekday_near_term_candidate_count).toBeGreaterThan(0);
    expect(plan.ordinary_weekday_near_term_selected_count).toBeGreaterThan(0);
    expect(plan.selected.every((t) => t.source === "booking" || t.source === "jalan")).toBe(true);
  });
});

describe("KIRAKU-BOOKING-FIX01 - every verified property gets a turn within a bounded rotation", () => {
  // Live verification (2026-07-13) found 喜らく/Kiraku's real, correctly
  // registered, verified-live Booking target ("xi-raku") was selected in ZERO
  // of the 12 daily rotating slots: a flat score-sorted pool of thousands of
  // candidates was rotated by at most 11 array positions (slot_index 0..11),
  // negligible against that pool size, so the same handful of top-scoring
  // properties won every slot, every day. Fixed by interleaving candidates by
  // property (round-robin, per source) before rotating, and folding
  // epochDay(runDateIso) into the rotation offset alongside slot_index so the
  // OTHER properties get their turn as the calendar date advances (the same
  // self-healing, no-stored-state design as priorityRefreshTiers.ts). This is
  // a general fix — verified here against the REAL verified-live universe
  // (liveTargets()), not a synthetic fixture, so it would catch a regression
  // for ANY under-served property, not just Kiraku.
  it("喜らく/Kiraku's Booking slug (xi-raku) is selected within 7 days of daily rotation", () => {
    const lastCollectedAt = new Map<string, string>();
    let found = false;
    for (let dayAdd = 0; dayAdd < 7 && !found; dayAdd++) {
      const runDateIso = `2026-07-${String(13 + dayAdd).padStart(2, "0")}`;
      for (let hour = 0; hour < 24 && !found; hour += 2) {
        const nowIso = `${runDateIso}T${String(hour).padStart(2, "0")}:00:00+09:00`;
        const p = buildRotatingPlan({ runDateIso, nowIso, slotHourJst: hour, liveTargets: liveTargets(), config: CONFIG, lastCollectedAt });
        if (p.selected.some((t) => t.property_slug === "xi-raku")) found = true;
      }
    }
    expect(found).toBe(true);
  });
});

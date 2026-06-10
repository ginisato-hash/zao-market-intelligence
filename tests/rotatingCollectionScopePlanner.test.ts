import { describe, expect, it } from "vitest";
import {
  ROTATING_CAPS,
  SLOT_HOURS,
  buildRotatingPlan,
  buildSlot,
  candidateStayDates,
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

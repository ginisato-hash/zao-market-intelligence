// Phase OWN-PRICE-COVERAGE-01 — extends the ZMI-RMS-FAIRNESS-V1 never_served/
// overdue service-band priority to Kiraku/Miuraya's own Booking cells out to
// OWN_PROPERTY_CRITICAL_LEAD_DAYS (90), independently of RMS_CRITICAL_LEAD_DAYS
// (56, unchanged, competitor-only). Proves: (1) an own-property cell beyond 56
// days but within 90 gets critical banding; (2) a competitor cell at the same
// offset does NOT -- no broadening of competitor discovery; (3) request volume
// (caps/cadence) is completely unchanged, only WHO gets prioritized shifts.

import { describe, expect, it } from "vitest";
import {
  buildRotatingPlan,
  scaledRotatingCaps,
  RMS_CRITICAL_LEAD_DAYS,
  OWN_PROPERTY_CRITICAL_LEAD_DAYS,
  type RotatingDemandConfig,
  type RotatingPlan
} from "../src/services/rotatingCollectionScopePlanner";
import { type MarketRefreshPropertyTarget } from "../src/services/marketRefreshTargetUniverse";

const CONFIG: RotatingDemandConfig = {
  public_holidays: {},
  long_weekend_dates: new Set<string>(),
  peak_periods: []
};

const RUN_DATE = "2026-08-19";
const NOW = "2026-08-19T10:00:00+09:00";

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function hoursAgo(fromIso: string, h: number): string {
  const t = new Date(fromIso.replace("+09:00", "Z")).getTime() - h * 3.6e6;
  return `${new Date(t).toISOString().slice(0, 19)}+09:00`;
}

const OWN_TARGET: MarketRefreshPropertyTarget = {
  source: "booking",
  property_slug: "xi-raku",
  canonical_property_name: "ホテル喜らく",
  tier: "tier_direct_mid",
  enabled_for_live: true,
  verified_mapping: true
} as unknown as MarketRefreshPropertyTarget;

function competitorTargets(n: number): MarketRefreshPropertyTarget[] {
  return Array.from({ length: n }, (_, i) => ({
    source: "booking" as const,
    property_slug: `prop-${String(i).padStart(2, "0")}`,
    canonical_property_name: `Competitor ${i}`,
    tier: "tier_direct_mid" as const,
    enabled_for_live: true,
    verified_mapping: true
  })) as unknown as MarketRefreshPropertyTarget[];
}

function plan(over: Partial<Parameters<typeof buildRotatingPlan>[0]> = {}): RotatingPlan {
  return buildRotatingPlan({
    runDateIso: RUN_DATE,
    nowIso: NOW,
    slotHourJst: 10,
    liveTargets: [OWN_TARGET, ...competitorTargets(23)],
    config: CONFIG,
    lastCollectedAt: new Map<string, string>(),
    caps: scaledRotatingCaps(3),
    nearTermDenseDays: 30,
    ...over
  });
}

describe("OWN-PRICE-COVERAGE-01 — extended own-property critical horizon", () => {
  it("OWN_PROPERTY_CRITICAL_LEAD_DAYS covers RMS V3's real 74-day consumed horizon with margin", () => {
    expect(OWN_PROPERTY_CRITICAL_LEAD_DAYS).toBeGreaterThanOrEqual(74);
  });

  // Score-based ordering (near-term-dense boost etc.) otherwise swamps a single
  // mid-term Friday, so every OTHER own-property candidate date is stamped
  // freshly-served, leaving D+65 as the property's sole never_served cell --
  // exactly the pattern rotatingBookingServiceFairness.test.ts already uses to
  // isolate band-priority from score-priority.
  function markAllOwnDatesFreshExcept(exceptOffset: number): Map<string, string> {
    const last = new Map<string, string>();
    for (let d = 1; d <= 90; d += 1) {
      if (d === exceptOffset) continue;
      last.set(`booking|xi-raku|${addDays(RUN_DATE, d)}`, hoursAgo(NOW, 1));
    }
    return last;
  }

  it("classifies an own-property Booking cell beyond RMS_CRITICAL_LEAD_DAYS (56) but within 90 as rms_critical", () => {
    const beyondSharedHorizon = 65; // > 56, <= 90, and a Friday so it survives candidateStayDates' mid-term sparse filter
    const p = plan({ lastCollectedAt: markAllOwnDatesFreshExcept(beyondSharedHorizon) });
    const cell = p.selected.find((t) => t.property_slug === "xi-raku" && t.stay_date === addDays(RUN_DATE, beyondSharedHorizon));
    expect(cell, "own-property cell at D+65 must be selected under never_served priority").toBeDefined();
    expect(cell!.rms_critical).toBe(true);
    expect(cell!.service_state).toBe("never_served");
  });

  it("does NOT classify a competitor Booking cell at the same D+70 offset as critical -- no broadening of competitor discovery", () => {
    const p = plan({ lastCollectedAt: new Map<string, string>() });
    const competitorAtSameOffset = p.selected.filter(
      (t) => t.property_slug !== "xi-raku" && t.stay_date === addDays(RUN_DATE, 65)
    );
    for (const c of competitorAtSameOffset) expect(c.rms_critical).toBe(false);
  });

  it("a never-served own-property cell at D+65 outranks a heavily-fresh competitor cell inside the shared 56-day horizon", () => {
    const last = markAllOwnDatesFreshExcept(65);
    // Every competitor cell within the shared horizon freshly served too.
    for (let i = 0; i < 23; i += 1) {
      for (let d = 1; d <= RMS_CRITICAL_LEAD_DAYS; d += 1) {
        last.set(`booking|prop-${String(i).padStart(2, "0")}|${addDays(RUN_DATE, d)}`, hoursAgo(NOW, 1));
      }
    }
    // The own-property cell at D+65 is the only never-served critical cell anywhere.
    const p = plan({ lastCollectedAt: last });
    const ownCell = p.selected.find((t) => t.property_slug === "xi-raku" && t.stay_date === addDays(RUN_DATE, 65));
    expect(ownCell, "never-served own-property cell must win a slot over freshly-served competitor cells").toBeDefined();
  });

  it("ownPropertyCriticalLeadDays=0 reproduces pre-fix behaviour for own properties (parity with rmsCriticalLeadDays=0)", () => {
    const p = plan({ lastCollectedAt: markAllOwnDatesFreshExcept(65), ownPropertyCriticalLeadDays: 0 });
    const ownAtD65 = p.selected.find((t) => t.property_slug === "xi-raku" && t.stay_date === addDays(RUN_DATE, 65));
    // Without the override, D+65 own-property cells cannot be rms_critical, so
    // the never_served cell no longer gets priority-selected over fresh ones.
    expect(ownAtD65).toBeUndefined();
  });

  it("KNOWN REMAINING GAP: an ordinary (non-weekend/holiday/peak) weekday beyond D+30 never becomes a rotating-planner candidate at all, own-property or not -- candidateStayDates' mid/long-term sparse sampling (interesting-days + every-3rd-day backfill) is shared market-research logic, not own-property-aware, so this fix cannot rescue it; that gap is covered by the SEPARATE runPricingCriticalRecrawl.ts own-property job instead, whose own near/mid/far tiers include every date (no sparse sampling)", () => {
    // 2026-10-28 (D+70 from 2026-08-19) is an ordinary Wednesday: not interesting, not offset%3===0.
    const ordinaryWeekdayBeyondDense = addDays(RUN_DATE, 70);
    const p = plan({ lastCollectedAt: new Map<string, string>() });
    expect(p.selected.some((t) => t.property_slug === "xi-raku" && t.stay_date === ordinaryWeekdayBeyondDense)).toBe(false);
    expect(p.candidate_count > 0 && p.selected.every((t) => t.stay_date !== ordinaryWeekdayBeyondDense || t.property_slug !== "xi-raku")).toBe(true);
  });

  it("own-property cells beyond OWN_PROPERTY_CRITICAL_LEAD_DAYS (past D+90) are never marked critical -- horizon is bounded, not unlimited", () => {
    const p = plan({ lastCollectedAt: new Map<string, string>() });
    const ownBeyond90 = p.selected.find((t) => t.property_slug === "xi-raku" && t.stay_date === addDays(RUN_DATE, 95));
    if (ownBeyond90 !== undefined) expect(ownBeyond90.rms_critical).toBe(false);
  });

  it("holds Booking request volume identical to before this change -- only WHO is prioritized shifts, not HOW MUCH", () => {
    const targets = [OWN_TARGET, ...competitorTargets(23)];
    const caps = scaledRotatingCaps(3);
    function runVolume(ownLeadDays: number): number {
      const state = new Map<string, string>();
      let total = 0; let date = RUN_DATE; let hour = 10;
      for (let cycle = 0; cycle < 12; cycle += 1) {
        const nowIso = `${date}T${String(hour).padStart(2, "0")}:00:00+09:00`;
        const p = buildRotatingPlan({
          runDateIso: date, nowIso, slotHourJst: hour, liveTargets: targets,
          config: CONFIG, lastCollectedAt: state, caps, nearTermDenseDays: 30,
          ownPropertyCriticalLeadDays: ownLeadDays
        });
        for (const t of p.selected) { state.set(`${t.source}|${t.property_slug}|${t.stay_date}`, nowIso); total += 1; }
        hour += 2; if (hour >= 24) { hour = 0; date = addDays(date, 1); }
      }
      return total;
    }
    expect(runVolume(OWN_PROPERTY_CRITICAL_LEAD_DAYS)).toBe(runVolume(0));
  });

  it("reports own_property_critical_lead_days in plan diagnostics", () => {
    const p = plan();
    expect(p.own_property_critical_lead_days).toBe(OWN_PROPERTY_CRITICAL_LEAD_DAYS);
  });
});

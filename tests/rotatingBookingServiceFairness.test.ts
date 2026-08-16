// Phase ZMI-RMS-FAIRNESS-V1 — Booking RMS-critical anti-starvation tests.
//
// Reproduces the measured production failure (33% of RMS-critical Booking cells
// never served in 7 days while others were served >=4 times) and proves the
// banded service-state scheduler fixes WHO gets served without changing HOW
// MUCH work is done: caps, source split, cadence and cooldown are untouched.

import { describe, expect, it } from "vitest";
import {
  buildRotatingPlan,
  classifyServiceState,
  scaledRotatingCaps,
  ROTATING_CAPS,
  RMS_CRITICAL_LEAD_DAYS,
  DEFAULT_SERVICE_DEADLINE_HOURS,
  SERVICE_BAND_RANK,
  NON_CRITICAL_BAND_RANK,
  SLOT_HOURS,
  type RotatingDemandConfig,
  type RotatingPlan
} from "../src/services/rotatingCollectionScopePlanner";
import { type MarketRefreshPropertyTarget } from "../src/services/marketRefreshTargetUniverse";

const CONFIG: RotatingDemandConfig = {
  public_holidays: {},
  long_weekend_dates: new Set<string>(),
  peak_periods: []
};

const RUN_DATE = "2026-08-17";
const NOW = "2026-08-17T10:00:00+09:00";

function bookingTargets(n: number): MarketRefreshPropertyTarget[] {
  return Array.from({ length: n }, (_, i) => ({
    source: "booking" as const,
    property_slug: `prop-${String(i).padStart(2, "0")}`,
    canonical_property_name: `Property ${i}`,
    tier: "tier_direct_mid" as const,
    enabled_for_live: true,
    verified_mapping: true
  })) as unknown as MarketRefreshPropertyTarget[];
}
function jalanTargets(n: number): MarketRefreshPropertyTarget[] {
  return Array.from({ length: n }, (_, i) => ({
    source: "jalan" as const,
    property_slug: `jprop-${String(i).padStart(2, "0")}`,
    canonical_property_name: `J Property ${i}`,
    tier: "tier_budget_small" as const,
    enabled_for_live: true,
    verified_mapping: true
  })) as unknown as MarketRefreshPropertyTarget[];
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function hoursAgo(fromIso: string, h: number): string {
  const t = new Date(fromIso.replace("+09:00", "Z")).getTime() - h * 3.6e6;
  return `${new Date(t).toISOString().slice(0, 19)}+09:00`;
}

function plan(over: Partial<Parameters<typeof buildRotatingPlan>[0]> = {}): RotatingPlan {
  return buildRotatingPlan({
    runDateIso: RUN_DATE,
    nowIso: NOW,
    slotHourJst: 10,
    liveTargets: [...bookingTargets(24), ...jalanTargets(23)],
    config: CONFIG,
    lastCollectedAt: new Map<string, string>(),
    caps: scaledRotatingCaps(3),
    nearTermDenseDays: 30,
    ...over
  });
}

describe("ZMI-RMS-FAIRNESS-V1 — service state classification", () => {
  it("missing last-observed time is NEVER_SERVED, never fresh (no missing-means-zero)", () => {
    expect(classifyServiceState(undefined, NOW, 84)).toBe("never_served");
    expect(classifyServiceState("", NOW, 84)).toBe("never_served");
  });

  it("classifies overdue / due_soon / fresh against the deadline", () => {
    expect(classifyServiceState(hoursAgo(NOW, 100), NOW, 84)).toBe("overdue");
    expect(classifyServiceState(hoursAgo(NOW, 84), NOW, 84)).toBe("overdue");
    expect(classifyServiceState(hoursAgo(NOW, 70), NOW, 84)).toBe("due_soon");
    expect(classifyServiceState(hoursAgo(NOW, 10), NOW, 84)).toBe("fresh");
  });

  it("band ranks order never_served < overdue < due_soon < fresh < non-critical", () => {
    expect(SERVICE_BAND_RANK.never_served).toBeLessThan(SERVICE_BAND_RANK.overdue);
    expect(SERVICE_BAND_RANK.overdue).toBeLessThan(SERVICE_BAND_RANK.due_soon);
    expect(SERVICE_BAND_RANK.due_soon).toBeLessThan(SERVICE_BAND_RANK.fresh);
    expect(SERVICE_BAND_RANK.fresh).toBeLessThan(NON_CRITICAL_BAND_RANK);
  });
});

describe("ZMI-RMS-FAIRNESS-V1 — starvation priority (req 1, 2, 15)", () => {
  // The exact production failure pattern: one cell heavily served, one starved.
  it("never-served RMS-critical cell outranks a repeatedly-served fresh cell", () => {
    const last = new Map<string, string>();
    // Every cell recently served EXCEPT prop-23 on a mid-horizon date.
    for (let i = 0; i < 24; i += 1) {
      for (let d = 1; d <= RMS_CRITICAL_LEAD_DAYS; d += 1) {
        if (i === 23 && d === 40) continue; // the starved cell
        last.set(`booking|prop-${String(i).padStart(2, "0")}|${addDays(RUN_DATE, d)}`, hoursAgo(NOW, 25));
      }
    }
    const p = plan({ lastCollectedAt: last });
    const starved = p.selected.find((t) => t.property_slug === "prop-23" && t.stay_date === addDays(RUN_DATE, 40));
    expect(starved, "never-served cell must be selected").toBeDefined();
    expect(starved!.service_state).toBe("never_served");
    expect(starved!.rms_critical).toBe(true);
  });

  it("overdue cell outranks a fresh cell", () => {
    const last = new Map<string, string>();
    for (let i = 0; i < 24; i += 1) {
      for (let d = 1; d <= RMS_CRITICAL_LEAD_DAYS; d += 1) {
        const age = i === 5 && d === 30 ? 200 : 25; // one badly overdue cell
        last.set(`booking|prop-${String(i).padStart(2, "0")}|${addDays(RUN_DATE, d)}`, hoursAgo(NOW, age));
      }
    }
    const p = plan({ lastCollectedAt: last });
    const overdue = p.selected.find((t) => t.property_slug === "prop-05" && t.stay_date === addDays(RUN_DATE, 30));
    expect(overdue, "overdue cell must be selected ahead of fresh cells").toBeDefined();
    expect(overdue!.service_state).toBe("overdue");
  });

  it("selected critical cells are never worse-banded than unselected ones", () => {
    const last = new Map<string, string>();
    for (let i = 0; i < 24; i += 1) {
      for (let d = 1; d <= RMS_CRITICAL_LEAD_DAYS; d += 1) {
        if ((i + d) % 7 === 0) continue; // ~1/7 never served
        last.set(`booking|prop-${String(i).padStart(2, "0")}|${addDays(RUN_DATE, d)}`, hoursAgo(NOW, 25));
      }
    }
    const p = plan({ lastCollectedAt: last });
    const criticalSelected = p.selected.filter((t) => t.rms_critical);
    expect(criticalSelected.length).toBeGreaterThan(0);
    // With never-served cells available, the scheduler must spend its critical
    // capacity on them rather than on fresh cells.
    expect(p.selected_by_service_state.never_served).toBeGreaterThan(0);
    expect(p.selected_by_service_state.fresh).toBe(0);
  });
});

describe("ZMI-RMS-FAIRNESS-V1 — invariants (req 3, 7, 8, 9, 10, 11, 13, 14)", () => {
  it("respects the unchanged Booking and Jalan caps and total envelope", () => {
    const p = plan();
    const caps = scaledRotatingCaps(3);
    expect(caps.booking_pages_per_run).toBe(36);
    expect(caps.jalan_pages_per_run).toBe(36);
    expect(p.selected.filter((t) => t.source === "booking").length).toBeLessThanOrEqual(caps.booking_pages_per_run);
    expect(p.selected.filter((t) => t.source === "jalan").length).toBeLessThanOrEqual(caps.jalan_pages_per_run);
    expect(p.selected.length).toBeLessThanOrEqual(caps.total_pages_per_run);
  });

  it("base cap constants are unchanged by this milestone (no source-split change)", () => {
    expect(ROTATING_CAPS.total_pages_per_run).toBe(24);
    expect(ROTATING_CAPS.booking_pages_per_run).toBe(12);
    expect(ROTATING_CAPS.jalan_pages_per_run).toBe(12);
    expect(ROTATING_CAPS.rakuten_pages_per_run).toBe(0);
    expect(ROTATING_CAPS.google_hotels_pages_per_run).toBe(0);
  });

  it("never selects the same cell twice in one run", () => {
    const p = plan();
    const keys = p.selected.map((t) => `${t.source}|${t.property_slug}|${t.stay_date}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is deterministic under identical state", () => {
    const a = plan(); const b = plan();
    expect(a.selected.map((t) => `${t.source}|${t.property_slug}|${t.stay_date}`))
      .toEqual(b.selected.map((t) => `${t.source}|${t.property_slug}|${t.stay_date}`));
  });

  it("keeps the cooldown contract: a cell inside 24h is never selected", () => {
    const last = new Map<string, string>();
    last.set(`booking|prop-00|${addDays(RUN_DATE, 3)}`, hoursAgo(NOW, 2));
    const p = plan({ lastCollectedAt: last });
    expect(p.selected.some((t) => t.property_slug === "prop-00" && t.stay_date === addDays(RUN_DATE, 3))).toBe(false);
  });

  it("prioritizes the RMS lead-time horizon and still leaves research capacity", () => {
    const p = plan();
    expect(p.rms_critical_selected_count).toBeGreaterThan(0);
    // Jalan (never RMS-critical) still receives its own leftover budget.
    expect(p.selected.filter((t) => t.source === "jalan").length).toBeGreaterThan(0);
    expect(p.service_deadline_hours).toBe(DEFAULT_SERVICE_DEADLINE_HOURS);
    expect(p.rms_critical_lead_days).toBe(RMS_CRITICAL_LEAD_DAYS);
  });

  it("marks only Booking cells inside the horizon as RMS-critical", () => {
    const p = plan();
    for (const t of p.selected) {
      if (t.rms_critical) expect(t.source).toBe("booking");
      if (t.source === "jalan") expect(t.rms_critical).toBe(false);
    }
  });

  it("rmsCriticalLeadDays=0 reproduces pre-change behaviour (no critical band)", () => {
    const p = plan({ rmsCriticalLeadDays: 0 });
    expect(p.rms_critical_candidate_count).toBe(0);
    expect(p.rms_critical_selected_count).toBe(0);
    expect(p.selected.length).toBeGreaterThan(0);
  });
});

describe("ZMI-RMS-FAIRNESS-V1 — failure does not become starvation (req 6)", () => {
  // A selected-but-failed cell still writes a history row, so it takes a
  // cooldown stamp like any other observation and cannot monopolize slots.
  it("a repeatedly-failing cell does not consume every future slot", () => {
    const last = new Map<string, string>();
    // Cell was just attempted (failed attempts still stamp collected_at).
    last.set(`booking|prop-00|${addDays(RUN_DATE, 5)}`, hoursAgo(NOW, 1));
    const p = plan({ lastCollectedAt: last });
    const picks = p.selected.filter((t) => t.property_slug === "prop-00" && t.stay_date === addDays(RUN_DATE, 5));
    expect(picks.length).toBe(0);
    expect(p.selected.length).toBeGreaterThan(1);
  });
});

describe("ZMI-RMS-FAIRNESS-V1 — service distribution converges (req 4, 5, §24)", () => {
  // Higher-level test: start from a deliberately skewed history resembling
  // production (~1/3 never served, some heavily served) and run many cycles.
  // Prove the skew collapses instead of being preserved.
  it("collapses a production-like starvation skew over repeated cycles", () => {
    const targets = [...bookingTargets(24), ...jalanTargets(23)];
    const caps = scaledRotatingCaps(3);
    const state = new Map<string, string>();
    const served = new Map<string, number>();
    const criticalKeys: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      for (let d = 1; d <= RMS_CRITICAL_LEAD_DAYS; d += 1) {
        const k = `booking|prop-${String(i).padStart(2, "0")}|${addDays(RUN_DATE, d)}`;
        criticalKeys.push(k);
        if ((i + d) % 3 !== 0) state.set(k, hoursAgo(NOW, 30)); // ~2/3 served, 1/3 never
      }
    }
    const zeroBefore = criticalKeys.filter((k) => !state.has(k)).length;
    expect(zeroBefore / criticalKeys.length).toBeGreaterThan(0.3); // production-like

    let date = RUN_DATE; let hour = 10;
    for (let cycle = 0; cycle < 24; cycle += 1) { // 48h of slots
      const nowIso = `${date}T${String(hour).padStart(2, "0")}:00:00+09:00`;
      const p = buildRotatingPlan({
        runDateIso: date, nowIso, slotHourJst: hour, liveTargets: targets,
        config: CONFIG, lastCollectedAt: state, caps, nearTermDenseDays: 30
      });
      for (const t of p.selected) {
        const k = `${t.source}|${t.property_slug}|${t.stay_date}`;
        state.set(k, nowIso);
        served.set(k, (served.get(k) ?? 0) + 1);
      }
      hour += 2;
      if (hour >= 24) { hour = 0; date = addDays(date, 1); }
    }
    const zeroAfter = criticalKeys.filter((k) => !state.has(k)).length;
    expect(zeroAfter, "starvation tail must shrink materially").toBeLessThan(zeroBefore * 0.6);
    // No single critical cell may monopolize while others starve.
    const maxServed = Math.max(...[...served.values()]);
    expect(maxServed).toBeLessThanOrEqual(3);
  });

  it("holds Booking request volume identical to the pre-change scheduler", () => {
    const targets = [...bookingTargets(24), ...jalanTargets(23)];
    const caps = scaledRotatingCaps(3);
    function runVolume(leadDays: number): number {
      const state = new Map<string, string>();
      let total = 0; let date = RUN_DATE; let hour = 10;
      for (let cycle = 0; cycle < 12; cycle += 1) {
        const nowIso = `${date}T${String(hour).padStart(2, "0")}:00:00+09:00`;
        const p = buildRotatingPlan({
          runDateIso: date, nowIso, slotHourJst: hour, liveTargets: targets,
          config: CONFIG, lastCollectedAt: state, caps, nearTermDenseDays: 30,
          rmsCriticalLeadDays: leadDays
        });
        for (const t of p.selected) { state.set(`${t.source}|${t.property_slug}|${t.stay_date}`, nowIso); total += 1; }
        hour += 2; if (hour >= 24) { hour = 0; date = addDays(date, 1); }
      }
      return total;
    }
    // Same number of requests; only WHICH cells differ.
    expect(runVolume(RMS_CRITICAL_LEAD_DAYS)).toBe(runVolume(0));
  });

  it("uses all 12 daily slots (cadence unchanged)", () => {
    expect(SLOT_HOURS.length).toBe(12);
  });
});

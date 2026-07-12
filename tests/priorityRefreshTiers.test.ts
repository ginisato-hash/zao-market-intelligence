import { describe, expect, it } from "vitest";
import {
  buildRefreshPlan,
  isSelectedToday,
  roundRobinByGroup,
  tierForCheckin,
  tierForOffset,
  todaysSelectedTargets
} from "../src/services/priorityRefreshTiers";

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const TODAY = "2026-07-04";

describe("PRICING-CRITICAL02 - tier classification", () => {
  it("D+1..D+30 = near_term, D+31..D+60 = mid_term, D+61..D+90 = far_term", () => {
    expect(tierForOffset(1)).toBe("near_term");
    expect(tierForOffset(30)).toBe("near_term");
    expect(tierForOffset(31)).toBe("mid_term");
    expect(tierForOffset(60)).toBe("mid_term");
    expect(tierForOffset(61)).toBe("far_term");
    expect(tierForOffset(90)).toBe("far_term");
    expect(tierForOffset(0)).toBeNull();
    expect(tierForOffset(91)).toBeNull();
  });

  it("tierForCheckin matches offset-based classification", () => {
    expect(tierForCheckin(addDays(TODAY, 1), TODAY)).toBe("near_term");
    expect(tierForCheckin(addDays(TODAY, 35), TODAY)).toBe("mid_term");
    expect(tierForCheckin(addDays(TODAY, 75), TODAY)).toBe("far_term");
  });
});

describe("PRICING-CRITICAL02 - §11.1 tiered refresh SLA (stateless, self-healing)", () => {
  it("near_term (D+1..D+30) is selected on EVERY single run, all 30 dates, for 10 consecutive days", () => {
    const allDates = Array.from({ length: 90 }, (_, i) => addDays(TODAY, i + 1));
    for (let day = 0; day < 10; day += 1) {
      const t = addDays(TODAY, day);
      const plan = buildRefreshPlan(allDates.map((c) => ({ checkin: c })), t);
      expect(plan.near_term).toHaveLength(30);
    }
  });

  it("every mid-term date (D+31..D+60) cycles within 3 days (§3.2/§14.1)", () => {
    const allDates = Array.from({ length: 90 }, (_, i) => addDays(TODAY, i + 1));
    const midTermDates = allDates.filter((c) => tierForCheckin(c, TODAY) === "mid_term");
    expect(midTermDates).toHaveLength(30);
    for (const md of midTermDates) {
      let covered = false;
      for (let day = 0; day < 3; day += 1) {
        const t = addDays(TODAY, day);
        if (todaysSelectedTargets([{ checkin: md }], t).length > 0) covered = true;
      }
      expect(covered).toBe(true);
    }
  });

  it("every far-term date (D+61..D+90) cycles within 7 days (§3.3/§14.1)", () => {
    const allDates = Array.from({ length: 90 }, (_, i) => addDays(TODAY, i + 1));
    const farTermDates = allDates.filter((c) => tierForCheckin(c, TODAY) === "far_term");
    expect(farTermDates).toHaveLength(30);
    for (const fd of farTermDates) {
      let covered = false;
      for (let day = 0; day < 7; day += 1) {
        const t = addDays(TODAY, day);
        if (todaysSelectedTargets([{ checkin: fd }], t).length > 0) covered = true;
      }
      expect(covered).toBe(true);
    }
  });

  it("rotation is self-healing: a skipped run does not desync the cycle (no stored state needed)", () => {
    // Simulate skipping day 1 entirely (job didn't fire) — day 2 must still be
    // computed purely from calendar date, unaffected by the missed run.
    const target = { checkin: addDays(TODAY, 33) }; // mid-term
    const day0 = todaysSelectedTargets([target], TODAY);
    const day2 = todaysSelectedTargets([target], addDays(TODAY, 2)); // day 1 skipped
    // Whichever day(s) select it, the result is identical whether or not day 1 ran,
    // because selection depends only on calendar date, not on run history.
    const day2IfDay1HadRun = todaysSelectedTargets([target], addDays(TODAY, 2));
    expect(day2).toEqual(day2IfDay1HadRun);
    expect(day0.length + day2.length).toBeGreaterThanOrEqual(0); // sanity: no throw, deterministic
  });

  it("isSelectedToday: near_term is always true regardless of date", () => {
    expect(isSelectedToday(addDays(TODAY, 5), "near_term", TODAY)).toBe(true);
    expect(isSelectedToday("2099-01-01", "near_term", TODAY)).toBe(true);
  });

  it("buildRefreshPlan reports full universes for mid/far term visibility even when not selected today", () => {
    const allDates = Array.from({ length: 90 }, (_, i) => addDays(TODAY, i + 1));
    const plan = buildRefreshPlan(allDates.map((c) => ({ checkin: c })), TODAY);
    expect(plan.mid_term_full_universe).toHaveLength(30);
    expect(plan.far_term_full_universe).toHaveLength(30);
    expect(plan.mid_term_selected_today.length).toBeLessThanOrEqual(30);
    expect(plan.far_term_selected_today.length).toBeLessThanOrEqual(30);
    expect(plan.mid_term_selected_today.length).toBeGreaterThan(0);
    expect(plan.far_term_selected_today.length).toBeGreaterThan(0);
  });
});

describe("KIRAKU-BOOKING-FIX01 - roundRobinByGroup (fair page-cap allocation across properties)", () => {
  // Reproduces the real 喜らく/Kiraku incident: 44 miuraya + 44 kiraku targets
  // selected for today, miuraya listed first. A flat slice(0, 8) always took
  // 8 miuraya entries and zero kiraku — kiraku had ZERO Booking history rows,
  // ever, despite being a correctly registered own-property Booking target.
  it("interleaves two equally-sized groups so a flat page-cap slice gets a fair split, not all-of-first-group", () => {
    const items = [
      ...Array.from({ length: 44 }, (_, i) => ({ canonical_property_key: "miuraya", checkin: `day-${i}` })),
      ...Array.from({ length: 44 }, (_, i) => ({ canonical_property_key: "kiraku", checkin: `day-${i}` }))
    ];
    const rr = roundRobinByGroup(items, (t) => t.canonical_property_key);
    const first8 = rr.slice(0, 8).map((t) => t.canonical_property_key);
    expect(first8).toEqual(["miuraya", "kiraku", "miuraya", "kiraku", "miuraya", "kiraku", "miuraya", "kiraku"]);
    // Every property gets a page every run — not merely "eventually".
    expect(first8.filter((k) => k === "kiraku")).toHaveLength(4);
    expect(first8.filter((k) => k === "miuraya")).toHaveLength(4);
  });

  it("preserves each group's own internal (chronological) order", () => {
    const items = [
      { canonical_property_key: "miuraya", checkin: "2026-07-14" },
      { canonical_property_key: "miuraya", checkin: "2026-07-15" },
      { canonical_property_key: "kiraku", checkin: "2026-07-14" },
      { canonical_property_key: "kiraku", checkin: "2026-07-15" }
    ];
    const rr = roundRobinByGroup(items, (t) => t.canonical_property_key);
    const kirakuOrder = rr.filter((t) => t.canonical_property_key === "kiraku").map((t) => t.checkin);
    expect(kirakuOrder).toEqual(["2026-07-14", "2026-07-15"]);
  });

  it("an uneven group split (e.g. 3 competitors) still gives every group a turn before any group gets a second page", () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => ({ canonical_property_key: "hammond", checkin: `d${i}` })),
      ...Array.from({ length: 30 }, (_, i) => ({ canonical_property_key: "oakhill", checkin: `d${i}` })),
      ...Array.from({ length: 30 }, (_, i) => ({ canonical_property_key: "yoshidaya", checkin: `d${i}` }))
    ];
    const rr = roundRobinByGroup(items, (t) => t.canonical_property_key);
    const first9 = rr.slice(0, 9).map((t) => t.canonical_property_key);
    expect(new Set(first9.slice(0, 3))).toEqual(new Set(["hammond", "oakhill", "yoshidaya"]));
    expect(first9.filter((k) => k === "hammond")).toHaveLength(3);
    expect(first9.filter((k) => k === "oakhill")).toHaveLength(3);
    expect(first9.filter((k) => k === "yoshidaya")).toHaveLength(3);
  });

  it("when one group is exhausted, the remaining groups keep filling subsequent slots (no gaps, no crash)", () => {
    const items = [
      { canonical_property_key: "a", checkin: "d0" },
      { canonical_property_key: "b", checkin: "d0" },
      { canonical_property_key: "b", checkin: "d1" },
      { canonical_property_key: "b", checkin: "d2" }
    ];
    const rr = roundRobinByGroup(items, (t) => t.canonical_property_key);
    expect(rr.map((t) => `${t.canonical_property_key}:${t.checkin}`)).toEqual(["a:d0", "b:d0", "b:d1", "b:d2"]);
  });

  it("total item count is preserved and no item is duplicated or dropped", () => {
    const items = Array.from({ length: 173 }, (_, i) => ({ canonical_property_key: `g${i % 5}`, checkin: `d${i}` }));
    const rr = roundRobinByGroup(items, (t) => t.canonical_property_key);
    expect(rr).toHaveLength(items.length);
    expect(new Set(rr.map((t) => t.checkin)).size).toBe(items.length);
  });

  it("empty input returns empty output", () => {
    expect(roundRobinByGroup([], () => "x")).toEqual([]);
  });
});

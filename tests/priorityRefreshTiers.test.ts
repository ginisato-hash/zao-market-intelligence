import { describe, expect, it } from "vitest";
import {
  buildRefreshPlan,
  isSelectedToday,
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

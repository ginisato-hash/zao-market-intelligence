// Phase OWN-PRICE-COVERAGE-01 — rotateWithinGroup tests.
//
// Reproduces and fixes the real defect: runPricingCriticalRecrawl.ts's own-
// property queue concatenates each property's FULL selected-today list
// (near_term ALL 30 dates + mid/far selected-today, ~44 total) in fixed
// date-ascending order, then a flat page cap (MAX_PAGES_PER_BATCH, split
// across properties by roundRobinByGroup) truncates it -- every single day,
// forever, to the same first ~4 dates per property (D+1..D+4), because
// near_term itself never rotates (unlike mid/far_term's isSelectedToday
// cycling). rotateWithinGroup fixes this by rotating each property's own list
// by a calendar-day-based offset before the interleave+cap, so the surviving
// prefix advances with the date instead of staying fixed forever.

import { describe, expect, it } from "vitest";
import {
  buildRefreshPlan,
  epochDay,
  roundRobinByGroup,
  rotateWithinGroup,
  todaysSelectedTargets
} from "../src/services/priorityRefreshTiers";

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const TODAY = "2026-08-19";

describe("OWN-PRICE-COVERAGE-01 — rotateWithinGroup", () => {
  it("preserves total item count -- nothing dropped or duplicated", () => {
    const items = Array.from({ length: 44 }, (_, i) => ({ canonical_property_key: "kiraku", checkin: `d${i}` }));
    const rotated = rotateWithinGroup(items, (t) => t.canonical_property_key, TODAY);
    expect(rotated).toHaveLength(44);
    expect(new Set(rotated.map((t) => t.checkin)).size).toBe(44);
  });

  it("rotates by epochDay(today) % group length -- deterministic, self-healing (no stored state)", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ canonical_property_key: "kiraku", checkin: `d${i}` }));
    const offset = ((epochDay(TODAY) % 10) + 10) % 10;
    const rotated = rotateWithinGroup(items, (t) => t.canonical_property_key, TODAY);
    expect(rotated[0]!.checkin).toBe(`d${offset}`);
    // Determinism: same day, same result.
    expect(rotateWithinGroup(items, (t) => t.canonical_property_key, TODAY)).toEqual(rotated);
  });

  it("advancing the calendar day advances the front of the list, not resetting it", () => {
    const items = Array.from({ length: 44 }, (_, i) => ({ canonical_property_key: "kiraku", checkin: `d${i}` }));
    const front: string[] = [];
    for (let day = 0; day < 44; day += 1) {
      const rotated = rotateWithinGroup(items, (t) => t.canonical_property_key, addDays(TODAY, day));
      front.push(rotated[0]!.checkin);
    }
    // Over one full cycle (44 days = group length), every item is at the front
    // exactly once -- proof the same prefix is never stuck forever.
    expect(new Set(front).size).toBe(44);
  });

  it("preserves each group's own internal (chronological) order after rotation, just shifted", () => {
    const items = [
      { canonical_property_key: "kiraku", checkin: "d0" },
      { canonical_property_key: "kiraku", checkin: "d1" },
      { canonical_property_key: "kiraku", checkin: "d2" }
    ];
    const rotated = rotateWithinGroup(items, (t) => t.canonical_property_key, addDays(TODAY, 1)); // epochDay%3 offset
    // Whatever the offset, the rotated array is still a cyclic shift of d0,d1,d2 -- never reordered arbitrarily.
    const idx = rotated.findIndex((t) => t.checkin === "d0");
    expect(rotated.map((t) => t.checkin)).toEqual(["d0", "d1", "d2"].slice(idx).concat(["d0", "d1", "d2"].slice(0, idx)));
  });

  it("rotates each group independently -- one property's rotation never touches another's items", () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => ({ canonical_property_key: "kiraku", checkin: `k${i}` })),
      ...Array.from({ length: 7 }, (_, i) => ({ canonical_property_key: "miuraya", checkin: `m${i}` }))
    ];
    const rotated = rotateWithinGroup(items, (t) => t.canonical_property_key, TODAY);
    expect(rotated.filter((t) => t.canonical_property_key === "kiraku").map((t) => t.checkin).sort())
      .toEqual(["k0", "k1", "k2", "k3", "k4"]);
    expect(rotated.filter((t) => t.canonical_property_key === "miuraya").map((t) => t.checkin).sort())
      .toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("empty input returns empty output", () => {
    expect(rotateWithinGroup([], () => "x", TODAY)).toEqual([]);
  });

  it("a lone group of length 1 is unaffected by any rotation", () => {
    const items = [{ canonical_property_key: "kiraku", checkin: "only" }];
    expect(rotateWithinGroup(items, (t) => t.canonical_property_key, addDays(TODAY, 999))).toEqual(items);
  });

  it("composes with roundRobinByGroup afterward: cross-property fair-share is unaffected by within-group rotation", () => {
    const items = [
      ...Array.from({ length: 44 }, (_, i) => ({ canonical_property_key: "kiraku", checkin: `k${i}` })),
      ...Array.from({ length: 44 }, (_, i) => ({ canonical_property_key: "miuraya", checkin: `m${i}` }))
    ];
    const rotated = rotateWithinGroup(items, (t) => t.canonical_property_key, TODAY);
    const interleaved = roundRobinByGroup(rotated, (t) => t.canonical_property_key);
    const first8 = interleaved.slice(0, 8).map((t) => t.canonical_property_key);
    expect(first8.filter((k) => k === "kiraku")).toHaveLength(4);
    expect(first8.filter((k) => k === "miuraya")).toHaveLength(4);
  });
});

describe("OWN-PRICE-COVERAGE-01 — reproduces and fixes the real D+1..D+4-forever starvation", () => {
  const MAX_PAGES_PER_BATCH = 8;

  function ownQueueForDay(dayOffset: number, useRotation: boolean): string[] {
    const runToday = addDays(TODAY, dayOffset);
    const allDates = Array.from({ length: 90 }, (_, i) => addDays(runToday, i + 1));
    const kiraku = allDates.map((checkin) => ({ canonical_property_key: "kiraku", checkin }));
    const miuraya = allDates.map((checkin) => ({ canonical_property_key: "miuraya", checkin }));
    const selectedKiraku = todaysSelectedTargets(kiraku, runToday);
    const selectedMiuraya = todaysSelectedTargets(miuraya, runToday);
    const selected = [...selectedKiraku, ...selectedMiuraya];
    const prepared = useRotation ? rotateWithinGroup(selected, (t) => t.canonical_property_key, runToday) : selected;
    const queue = roundRobinByGroup(prepared, (t) => t.canonical_property_key);
    return queue.slice(0, MAX_PAGES_PER_BATCH).map((t) => t.checkin);
  }

  it("WITHOUT rotation (the pre-fix bug): the same D+1..D+4 checkins are selected for kiraku every single day, forever", () => {
    // Two identically-dated properties interleave 1:1, so each of D+1..D+4 appears twice (once per property).
    const expectedFor = (runToday: string): string[] =>
      [1, 1, 2, 2, 3, 3, 4, 4].map((n) => addDays(runToday, n));
    const day0 = ownQueueForDay(0, false);
    const day10 = ownQueueForDay(10, false);
    const day30 = ownQueueForDay(30, false);
    // Relative offsets D+1..D+4 from whichever day it is -- literally never advances past D+4.
    expect(day0).toEqual(expectedFor(addDays(TODAY, 0)));
    expect(day10).toEqual(expectedFor(addDays(TODAY, 10)));
    expect(day30).toEqual(expectedFor(addDays(TODAY, 30)));
    // A date more than 4 days out from "today" NEVER appears in the selected batch on any of these days.
    expect(day0.every((d) => d !== addDays(TODAY, 50))).toBe(true);
    expect(day10.every((d) => d !== addDays(TODAY, 60))).toBe(true);
    expect(day30.every((d) => d !== addDays(TODAY, 80))).toBe(true);
  });

  it("WITH rotation (the fix): over a multi-week span, dates well beyond D+4 DO get selected -- starvation is broken", () => {
    const selectedAcrossDays = new Set<string>();
    for (let day = 0; day < 44; day += 1) {
      for (const checkin of ownQueueForDay(day, true)) selectedAcrossDays.add(checkin);
    }
    // With rotation, the absolute set of covered checkins over 44 days must include
    // dates far beyond a fixed D+1..D+4 window relative to any single day in the run.
    const midOrFarTermExample = addDays(TODAY, 50); // would be mid/far-term on day 0, near-term by day ~20+
    expect(selectedAcrossDays.has(midOrFarTermExample)).toBe(true);
    // And it covers meaningfully more distinct dates than the frozen 4-per-day pre-fix pattern would.
    expect(selectedAcrossDays.size).toBeGreaterThan(8);
  });

  it("rotation does not change the page volume selected per run (same MAX_PAGES_PER_BATCH, same cadence)", () => {
    expect(ownQueueForDay(5, true)).toHaveLength(MAX_PAGES_PER_BATCH);
    expect(ownQueueForDay(5, false)).toHaveLength(MAX_PAGES_PER_BATCH);
  });
});

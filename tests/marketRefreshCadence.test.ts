import { describe, expect, it } from "vitest";
import {
  getRefreshCadenceHours,
  isJobDueForRefresh,
  type TargetDatePriority
} from "../src/services/marketRefreshCadence";

describe("getRefreshCadenceHours", () => {
  it("maps each priority to its cadence", () => {
    expect(getRefreshCadenceHours("S")).toBe(24);
    expect(getRefreshCadenceHours("A")).toBe(72);
    expect(getRefreshCadenceHours("B")).toBe(168);
    expect(getRefreshCadenceHours("C")).toBe(336);
  });
});

describe("isJobDueForRefresh", () => {
  const now = "2026-05-29T00:00:00+09:00";

  it("is due when there is no previous attempt", () => {
    expect(isJobDueForRefresh({ priority: "S", lastAttemptedAtJst: null, nowJst: now })).toBe(true);
    expect(isJobDueForRefresh({ priority: "C", lastAttemptedAtJst: "", nowJst: now })).toBe(true);
  });

  it("is due when the last attempt is older than cadence", () => {
    // S cadence = 24h; 25h ago → due
    expect(
      isJobDueForRefresh({ priority: "S", lastAttemptedAtJst: "2026-05-27T23:00:00+09:00", nowJst: now })
    ).toBe(true);
  });

  it("is not due when the last attempt is newer than cadence", () => {
    // S cadence = 24h; 1h ago → fresh
    expect(
      isJobDueForRefresh({ priority: "S", lastAttemptedAtJst: "2026-05-28T23:00:00+09:00", nowJst: now })
    ).toBe(false);
  });

  it("treats exactly-at-cadence as due", () => {
    expect(
      isJobDueForRefresh({ priority: "S", lastAttemptedAtJst: "2026-05-28T00:00:00+09:00", nowJst: now })
    ).toBe(true);
  });

  it("applies the longer cadence for lower priorities", () => {
    // 4 days ago: due for A (72h) and S (24h), but not B (168h) or C (336h)
    const fourDaysAgo = "2026-05-25T00:00:00+09:00";
    const cases: Array<[TargetDatePriority, boolean]> = [
      ["S", true],
      ["A", true],
      ["B", false],
      ["C", false]
    ];
    for (const [priority, expected] of cases) {
      expect(isJobDueForRefresh({ priority, lastAttemptedAtJst: fourDaysAgo, nowJst: now })).toBe(expected);
    }
  });

  it("respects cadence regardless of whether the attempt failed (no aggressive retry)", () => {
    // A failed attempt 1h ago is still fresh for an S job; we do not retry early.
    expect(
      isJobDueForRefresh({ priority: "S", lastAttemptedAtJst: "2026-05-28T23:00:00+09:00", nowJst: now })
    ).toBe(false);
  });
});

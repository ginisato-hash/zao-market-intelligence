import { describe, expect, it } from "vitest";
import {
  buildJstDateRange,
  buildOwnPropertyTargets,
  buildPriorityCompetitorTargets
} from "../src/services/priorityRecrawlTargets";
import { isOwnPropertyName } from "../src/services/ownPropertyTargets";
import { isPriorityCompetitorName } from "../src/services/priorityCompetitors";

const TODAY = "2026-07-04"; // fixed for deterministic tests

describe("PRICING-CRITICAL01 - JST date range generation (§12.3)", () => {
  it("D+1 .. D+90 inclusive, YYYY-MM-DD, excludes D+0 and D+91", () => {
    const range = buildJstDateRange(90, 1, TODAY);
    expect(range).toHaveLength(90);
    expect(range[0]).toBe("2026-07-05"); // D+1
    expect(range[89]).toBe("2026-10-02"); // D+90
    expect(range).not.toContain(TODAY); // D+0 excluded
    expect(range).not.toContain("2026-10-03"); // D+91 excluded
    for (const d of range) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("supports a custom horizon and start offset", () => {
    const range = buildJstDateRange(7, 1, TODAY);
    expect(range).toHaveLength(7);
    expect(range[0]).toBe("2026-07-05");
    expect(range[6]).toBe("2026-07-11");
  });

  it("crosses a month boundary correctly", () => {
    const range = buildJstDateRange(90, 1, "2026-07-04");
    expect(range.some((d) => d.startsWith("2026-08"))).toBe(true);
    expect(range.some((d) => d.startsWith("2026-09"))).toBe(true);
    expect(range.some((d) => d.startsWith("2026-10"))).toBe(true);
  });
});

describe("PRICING-CRITICAL01 - priority competitor target generation (§12.4)", () => {
  it("3 competitors x 90 days x 2 verified sources (booking+jalan) = 540 targets", () => {
    const { targets, skipped_no_verified_source } = buildPriorityCompetitorTargets({ todayIso: TODAY });
    expect(skipped_no_verified_source).toEqual([]);
    expect(targets).toHaveLength(540); // LOCKED: 3 * 90 * 2, computed from real verified targets
    const byProp: Record<string, number> = {};
    for (const t of targets) byProp[t.canonical_property_key] = (byProp[t.canonical_property_key] ?? 0) + 1;
    expect(byProp).toEqual({ hammond: 180, oakhill: 180, yoshidaya: 180 }); // 90 days * 2 sources each
    const bySource: Record<string, number> = {};
    for (const t of targets) bySource[t.source] = (bySource[t.source] ?? 0) + 1;
    expect(bySource).toEqual({ booking: 270, jalan: 270 });
  });

  it("every target carries a real (non-empty) property_slug from verified targets", () => {
    const { targets } = buildPriorityCompetitorTargets({ todayIso: TODAY });
    expect(targets.every((t) => t.property_slug.length > 0)).toBe(true);
    expect(targets.every((t) => t.reason === "priority_competitor_90d_horizon")).toBe(true);
    expect(targets.every((t) => t.target_type === "competitor")).toBe(true);
    expect(targets.every((t) => t.priority === "critical")).toBe(true);
  });

  it("8月上旬 (early August) is present for every priority competitor", () => {
    const { targets } = buildPriorityCompetitorTargets({ todayIso: TODAY });
    for (const key of ["hammond", "oakhill", "yoshidaya"]) {
      const augEarly = targets.filter((t) => t.canonical_property_key === key && t.checkin >= "2026-08-01" && t.checkin <= "2026-08-10");
      expect(augEarly.length).toBeGreaterThan(0);
    }
  });

  it("competitor self-guard: no own property ever appears as a competitor target (§12.6)", () => {
    const { targets } = buildPriorityCompetitorTargets({ todayIso: TODAY });
    expect(targets.some((t) => isOwnPropertyName(t.canonical_property_name))).toBe(false);
    expect(targets.map((t) => t.canonical_property_name)).not.toContain("三浦屋");
    expect(targets.map((t) => t.canonical_property_name)).not.toContain("ホテル喜らく");
  });

  it("supports filtering to a subset of keys", () => {
    const { targets } = buildPriorityCompetitorTargets({ todayIso: TODAY, keys: ["hammond"] });
    expect(targets.every((t) => t.canonical_property_key === "hammond")).toBe(true);
    expect(targets).toHaveLength(180);
  });
});

describe("PRICING-CRITICAL01 - own property target generation (§12.5)", () => {
  it("2 own properties x 90 days x 2 verified sources (booking+jalan) = 360 targets", () => {
    const { targets, skipped_no_verified_source } = buildOwnPropertyTargets({ todayIso: TODAY });
    expect(skipped_no_verified_source).toEqual([]);
    expect(targets).toHaveLength(360); // LOCKED: 2 * 90 * 2, computed from real verified targets
    const byProp: Record<string, number> = {};
    for (const t of targets) byProp[t.canonical_property_key] = (byProp[t.canonical_property_key] ?? 0) + 1;
    expect(byProp).toEqual({ miuraya: 180, kiraku: 180 });
  });

  it("own-property include: 三浦屋 and 喜らく both present as own_property targets (§12.7)", () => {
    const { targets } = buildOwnPropertyTargets({ todayIso: TODAY });
    expect(targets.map((t) => t.canonical_property_name)).toContain("三浦屋");
    expect(targets.map((t) => t.canonical_property_name)).toContain("ホテル喜らく");
    expect(targets.every((t) => t.target_type === "own_property")).toBe(true);
    expect(targets.every((t) => t.reason === "own_property_90d_price_tracking")).toBe(true);
    expect(targets.every((t) => isOwnPropertyName(t.canonical_property_name))).toBe(true);
  });

  it("own-property targets never include a priority competitor", () => {
    const { targets } = buildOwnPropertyTargets({ todayIso: TODAY });
    expect(targets.some((t) => isPriorityCompetitorName(t.canonical_property_name))).toBe(false);
  });
});

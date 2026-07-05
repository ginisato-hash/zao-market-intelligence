import { describe, expect, it } from "vitest";
import {
  OWN_PROPERTY_THRESHOLDS,
  PRIORITY_COMPETITOR_THRESHOLDS,
  computePropertyCoverage
} from "../src/services/priorityCoverageReport";
import type { PriceHistoryInputRow } from "../src/services/priceHistorySignals";

function row(over: Partial<PriceHistoryInputRow> = {}): PriceHistoryInputRow {
  return {
    property_id: "hammond-takamiya",
    property_name: "HAMMOND",
    source: "booking",
    checkin_date: "2026-08-01",
    observed_at: "2026-07-04T10:00:00+09:00",
    occupancy_basis: "2_adults_1_rooms",
    availability_status_raw: "available",
    normalized_total_price: 20000,
    basis_confidence: "B",
    warning_flags: "",
    source_classification: "",
    dp_exclusion_reason: "",
    is_price_excluded_from_dp: false,
    is_price_usable_for_dp_directional: true,
    basis_note: "",
    room_type_key: "",
    ...over
  };
}

const PROPERTY = { canonical_property_key: "hammond", display_name: "HAMMOND / ハモンド", canonical_property_name: "HAMMOND", verified_sources: ["booking", "jalan"] };
const NOW_MS = Date.parse("2026-07-04T12:00:00+09:00");
const TODAY = "2026-07-04";
const BOOKING_ONLY = new Set(["booking"]);
const ALL_SOURCES = new Set(["booking", "jalan", "rakuten"]);

function dateRange(n: number, startIso = "2026-07-05"): string[] {
  const out: string[] = [];
  const [y, m, d] = startIso.split("-").map(Number);
  for (let i = 0; i < n; i += 1) {
    const dt = new Date(Date.UTC(y!, m! - 1, d! + i));
    out.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

describe("PRICING-CRITICAL02 - per-source + tiered SLA coverage", () => {
  const range90 = dateRange(90);

  it("competitor: coverage_30d below 0.90 => critical (stricter than v1's 0.80)", () => {
    const rows = range90.slice(0, 28).map((checkin) => row({ checkin_date: checkin, observed_at: "2026-07-04T10:00:00+09:00" })); // 28/30=0.933... use fewer
    const fewer = range90.slice(0, 25).map((checkin) => row({ checkin_date: checkin, observed_at: "2026-07-04T10:00:00+09:00" })); // 25/30=0.833<0.90
    const result = computePropertyCoverage({ rows: fewer, property: PROPERTY, dateRange90d: range90, thresholds: PRIORITY_COMPETITOR_THRESHOLDS, liveCollectSources: BOOKING_ONLY, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.coverage_30d).toBeCloseTo(25 / 30, 4);
    expect(result.status).toBe("critical");
    expect(result.reasons.some((r) => r.includes("coverage_30d"))).toBe(true);
    void rows;
  });

  it("competitor: near-term (D+1..D+30) missing date => critical even if 30d ratio would pass", () => {
    // Full mid+far coverage but ONE near-term date missing.
    const nearMostly = range90.slice(0, 29); // 29 of 30 near-term dates
    const midFar = range90.slice(30);
    const rows = [...nearMostly, ...midFar].map((checkin) => row({ checkin_date: checkin, observed_at: "2026-07-04T10:00:00+09:00" }));
    const result = computePropertyCoverage({ rows, property: PROPERTY, dateRange90d: range90, thresholds: PRIORITY_COMPETITOR_THRESHOLDS, liveCollectSources: BOOKING_ONLY, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.missing_dates_30d).toHaveLength(1);
    expect(result.reasons).toContain("near_term_missing_dates");
    expect(result.status).toBe("critical");
  });

  it("competitor: near-term observation stale >48h => critical", () => {
    const rows = range90.map((checkin) => row({ checkin_date: checkin, observed_at: "2026-07-01T10:00:00+09:00" })); // 3+ days old
    const result = computePropertyCoverage({ rows, property: PROPERTY, dateRange90d: range90, thresholds: PRIORITY_COMPETITOR_THRESHOLDS, liveCollectSources: BOOKING_ONLY, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.status).toBe("critical");
    expect(result.reasons.some((r) => r.includes("near_term_stale"))).toBe(true);
  });

  it("competitor: mid-term stale >3d => warning (not critical) when near-term is fresh/complete", () => {
    const near = range90.slice(0, 30).map((checkin) => row({ checkin_date: checkin, observed_at: "2026-07-04T10:00:00+09:00" }));
    const mid = range90.slice(30, 60).map((checkin) => row({ checkin_date: checkin, observed_at: "2026-06-28T10:00:00+09:00" })); // 6 days old
    const far = range90.slice(60).map((checkin) => row({ checkin_date: checkin, observed_at: "2026-07-01T10:00:00+09:00" })); // 3 days old, within 7d
    const result = computePropertyCoverage({ rows: [...near, ...mid, ...far], property: PROPERTY, dateRange90d: range90, thresholds: PRIORITY_COMPETITOR_THRESHOLDS, liveCollectSources: BOOKING_ONLY, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.status).toBe("warning");
    expect(result.warnings.some((w) => w.includes("mid_term_stale"))).toBe(true);
  });

  it("competitor: jalan verified but not live-collected => warning note, never counted as coverage success", () => {
    const rows = range90.map((checkin) => row({ checkin_date: checkin, observed_at: "2026-07-04T10:00:00+09:00", source: "booking" }));
    const result = computePropertyCoverage({ rows, property: PROPERTY, dateRange90d: range90, thresholds: PRIORITY_COMPETITOR_THRESHOLDS, liveCollectSources: BOOKING_ONLY, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.coverage["jalan"]!.live_supported).toBe(false);
    expect(result.coverage["jalan"]!.coverage_30d).toBe(0); // no jalan rows at all -> 0, never faked as success
    expect(result.warnings).toContain("jalan_live_collection_not_connected");
    expect(result.coverage["booking"]!.live_supported).toBe(true);
    expect(result.coverage["booking"]!.coverage_30d).toBe(1);
  });

  it("competitor: full fresh coverage, all verified sources live => ok, no warnings", () => {
    const rows = range90.flatMap((checkin) => [row({ checkin_date: checkin, observed_at: "2026-07-04T10:00:00+09:00", source: "booking" }), row({ checkin_date: checkin, observed_at: "2026-07-04T10:00:00+09:00", source: "jalan" })]);
    const result = computePropertyCoverage({ rows, property: PROPERTY, dateRange90d: range90, thresholds: PRIORITY_COMPETITOR_THRESHOLDS, liveCollectSources: ALL_SOURCES, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.status).toBe("ok");
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  // Own property: stricter (§7.2) — 95/90, hard presence requirement, 90d warning at 0.80.
  it("own property: coverage_30d below 0.95 => critical (stricter than competitor)", () => {
    const ownProp = { canonical_property_key: "kiraku", display_name: "喜らく / ZAO SPA HOTEL Kiraku", canonical_property_name: "ホテル喜らく", verified_sources: ["booking", "jalan"] };
    const rows = range90.slice(0, 28).map((checkin) => row({ checkin_date: checkin, property_name: "ホテル喜らく", observed_at: "2026-07-04T10:00:00+09:00" })); // 28/30=0.933<0.95
    const result = computePropertyCoverage({ rows, property: ownProp, dateRange90d: range90, thresholds: OWN_PROPERTY_THRESHOLDS, liveCollectSources: BOOKING_ONLY, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.coverage_30d).toBeCloseTo(28 / 30, 4);
    expect(result.status).toBe("critical");
  });

  it("own property: not present at all (no available+priced row) => critical presence failure", () => {
    const ownProp = { canonical_property_key: "kiraku", display_name: "喜らく / ZAO SPA HOTEL Kiraku", canonical_property_name: "ホテル喜らく", verified_sources: ["booking", "jalan"] };
    const result = computePropertyCoverage({ rows: [], property: ownProp, dateRange90d: range90, thresholds: OWN_PROPERTY_THRESHOLDS, liveCollectSources: BOOKING_ONLY, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.reasons).toContain("not_present_in_own_property_prices");
    expect(result.status).toBe("critical");
  });

  it("own property: coverage_90d below 0.80 => warning (competitor has no such explicit 90d rule)", () => {
    const ownProp = { canonical_property_key: "miuraya", display_name: "三浦屋 / Miuraya", canonical_property_name: "三浦屋", verified_sources: ["booking", "jalan"] };
    const near = range90.slice(0, 30).map((checkin) => row({ checkin_date: checkin, property_name: "三浦屋", observed_at: "2026-07-04T10:00:00+09:00" }));
    const mid = range90.slice(30, 45).map((checkin) => row({ checkin_date: checkin, property_name: "三浦屋", observed_at: "2026-07-04T10:00:00+09:00" })); // 45d full
    // far term left mostly empty -> 90d = 45/90 = 0.5 < 0.80
    const result = computePropertyCoverage({ rows: [...near, ...mid], property: ownProp, dateRange90d: range90, thresholds: OWN_PROPERTY_THRESHOLDS, liveCollectSources: BOOKING_ONLY, nowMs: NOW_MS, todayIso: TODAY });
    expect(result.coverage_90d).toBeCloseTo(45 / 90, 4);
    // far term has zero rows -> also triggers far_term_stale warning; both are fine, but must NOT be critical from 90d alone.
    expect(result.warnings.some((w) => w.includes("coverage_90d_below_0.8"))).toBe(true);
  });
});

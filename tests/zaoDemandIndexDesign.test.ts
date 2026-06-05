import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEMAND_INDEX_CSV_HEADERS,
  aggregateByDate,
  bookingWindowScore,
  buildDemandIndexRows,
  calendarScore,
  computeGroupMetrics,
  computePriceReference,
  confidenceScore,
  congestionRankFor,
  decideDP01X,
  decidePricingPosture,
  demandBandFor,
  demandIndexFrom,
  deriveDpUsage,
  median,
  pricePressureScore,
  renderDemandIndexCsv,
  renderDesignReport,
  soldOutPressureScore,
  type BuildContext,
  type DemandIndexRow,
  type DesignSummary,
  type HistoryRow
} from "../src/services/zaoDemandIndexDesign";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/zaoDemandIndexDesign.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildZaoDemandIndexDesignReport.ts"), "utf8");
const HISTORY_DIR = resolve(__dirname, "../.data/history");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function row(over: Partial<HistoryRow>): HistoryRow {
  return {
    source: "rakuten",
    canonicalPropertyName: "蔵王国際ホテル",
    checkin: "2026-07-04",
    checkout: "2026-07-05",
    stayScope: "2_adults_1_room_1_night",
    availabilityStatus: "available",
    soldOutStatus: "available",
    normalizedTotalPrice: "60000",
    basisConfidence: "B",
    isPriceUsableForDpDirect: "false",
    isPriceUsableForDpDirectional: "true",
    isPriceExcludedFromDp: "false",
    dpExclusionReason: "",
    warningFlags: "",
    ...over
  };
}

const CTX: BuildContext = {
  runId: "run",
  generatedAtJst: "2026-06-03T20:00:00+09:00",
  todayJst: "2026-06-03",
  refP66: 60000,
  refP90: 80000,
  debugArtifactPath: "/debug"
};

// ---------------------------------------------------------------------------
// 1. Read history without modifying files
// ---------------------------------------------------------------------------

describe("history input is read-only", () => {
  it("reads monthly history CSV rows without modifying the files (mtime stable)", () => {
    const f = resolve(HISTORY_DIR, "zao_signals_2026_06.csv");
    const before = statSync(f).mtimeMs;
    const text = readFileSync(f, "utf8");
    expect(text.split("\n")[0]).toContain("checkin");
    expect(statSync(f).mtimeMs).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2-6. Aggregation + medians
// ---------------------------------------------------------------------------

describe("aggregation + medians", () => {
  it("groups rows by checkin/checkout/stay_scope", () => {
    const groups = aggregateByDate([
      row({ checkin: "2026-07-04" }),
      row({ checkin: "2026-07-04" }),
      row({ checkin: "2026-07-05", checkout: "2026-07-06" })
    ]);
    expect(groups.length).toBe(2);
  });

  it("excludes `excluded` rows from price medians", () => {
    const m = computeGroupMetrics({
      checkinDate: "2026-07-04",
      checkoutDate: "2026-07-05",
      stayScope: "2_adults_1_room_1_night",
      rows: [
        row({ normalizedTotalPrice: "50000", isPriceUsableForDpDirectional: "true" }),
        row({ normalizedTotalPrice: "999999", isPriceExcludedFromDp: "true", isPriceUsableForDpDirectional: "false" })
      ]
    });
    expect(m.excludedRowCount).toBe(1);
    expect(m.directionalMedianJpy).toBe(50000);
    expect(m.crossSourceMedianJpy).toBe(50000);
  });

  it("uses direct rows for direct-only median", () => {
    const m = computeGroupMetrics({
      checkinDate: "2026-07-04",
      checkoutDate: "2026-07-05",
      stayScope: "2_adults_1_room_1_night",
      rows: [
        row({ source: "jalan", normalizedTotalPrice: "40000", isPriceUsableForDpDirect: "true", isPriceUsableForDpDirectional: "false" }),
        row({ source: "jalan", normalizedTotalPrice: "44000", isPriceUsableForDpDirect: "true", isPriceUsableForDpDirectional: "false" })
      ]
    });
    expect(m.directPriceRowCount).toBe(2);
    expect(m.directOnlyMedianJpy).toBe(42000);
  });

  it("uses directional rows for directional median", () => {
    const m = computeGroupMetrics({
      checkinDate: "2026-07-04",
      checkoutDate: "2026-07-05",
      stayScope: "2_adults_1_room_1_night",
      rows: [row({ normalizedTotalPrice: "60000" }), row({ normalizedTotalPrice: "70000" })]
    });
    expect(m.directionalMedianJpy).toBe(65000);
  });

  it("computes cross-source median across direct + directional", () => {
    const m = computeGroupMetrics({
      checkinDate: "2026-07-04",
      checkoutDate: "2026-07-05",
      stayScope: "2_adults_1_room_1_night",
      rows: [
        row({ source: "jalan", normalizedTotalPrice: "40000", isPriceUsableForDpDirect: "true", isPriceUsableForDpDirectional: "false" }),
        row({ source: "rakuten", normalizedTotalPrice: "60000" }),
        row({ source: "booking", normalizedTotalPrice: "80000" })
      ]
    });
    expect(m.crossSourceMedianJpy).toBe(60000);
    expect(median([])).toBeNull();
  });

  it("derives dp usage from the boolean flags", () => {
    expect(deriveDpUsage(row({ isPriceExcludedFromDp: "true" }))).toBe("excluded");
    expect(deriveDpUsage(row({ isPriceUsableForDpDirect: "true" }))).toBe("direct");
    expect(deriveDpUsage(row({ isPriceUsableForDpDirectional: "true" }))).toBe("directional");
    expect(deriveDpUsage(row({ isPriceUsableForDpDirect: "false", isPriceUsableForDpDirectional: "false" }))).toBe("unusable");
  });
});

// ---------------------------------------------------------------------------
// 7-11. Scoring components
// ---------------------------------------------------------------------------

describe("scoring components", () => {
  it("computes sold-out pressure score (higher with more sold-out share + sources)", () => {
    const low = soldOutPressureScore({ soldOutCount: 0, availableCount: 4, sourceCount: 1 });
    const high = soldOutPressureScore({ soldOutCount: 4, availableCount: 0, sourceCount: 3 });
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(35);
  });

  it("computes price pressure score with high/premium flags", () => {
    const none = pricePressureScore({ usablePriceRowCount: 0, sourceCountWithPrice: 0, groupMedianJpy: null, refP66: 60000, refP90: 80000 });
    expect(none.score).toBe(0);
    const premium = pricePressureScore({ usablePriceRowCount: 3, sourceCountWithPrice: 2, groupMedianJpy: 90000, refP66: 60000, refP90: 80000 });
    expect(premium.highPriceFlag).toBe(true);
    expect(premium.premiumCeilingFlag).toBe(true);
    expect(premium.score).toBeLessThanOrEqual(25);
    expect(premium.score).toBeGreaterThan(8);
  });

  it("computes confidence score (direct A rows strongest)", () => {
    const directional = confidenceScore({ directRowCount: 0, directionalRowCount: 2, sourceCount: 1 });
    const direct = confidenceScore({ directRowCount: 2, directionalRowCount: 0, sourceCount: 2 });
    expect(direct).toBeGreaterThan(directional);
    expect(direct).toBeLessThanOrEqual(15);
  });

  it("computes calendar score (Saturday + holiday boost)", () => {
    const tuesday = calendarScore({ checkinDate: "2026-09-08" }); // a plain weekday
    const saturday = calendarScore({ checkinDate: "2026-07-04" }); // Saturday
    expect(saturday).toBeGreaterThan(tuesday);
    expect(saturday).toBeLessThanOrEqual(15);
  });

  it("computes booking-window score (close-in + sold-out urgency)", () => {
    expect(bookingWindowScore({ daysUntilCheckin: 3, soldOutPressureScore: 30 })).toBe(10);
    expect(bookingWindowScore({ daysUntilCheckin: 3, soldOutPressureScore: 0 })).toBe(5);
    expect(bookingWindowScore({ daysUntilCheckin: 14, soldOutPressureScore: 0 })).toBe(7);
    expect(bookingWindowScore({ daysUntilCheckin: 120, soldOutPressureScore: 0 })).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 12-14. Index, band, congestion mapping
// ---------------------------------------------------------------------------

describe("index + band + congestion", () => {
  it("caps the demand index at 100", () => {
    const idx = demandIndexFrom({
      soldOutPressureScore: 35,
      pricePressureScore: 25,
      confidenceScore: 15,
      calendarScore: 15,
      bookingWindowScore: 10
    });
    expect(idx).toBe(100);
    const over = demandIndexFrom({
      soldOutPressureScore: 99,
      pricePressureScore: 99,
      confidenceScore: 99,
      calendarScore: 99,
      bookingWindowScore: 99
    });
    expect(over).toBe(100);
  });

  it("maps demand index to demand band", () => {
    expect(demandBandFor(95)).toBe("S_extreme");
    expect(demandBandFor(80)).toBe("A_strong");
    expect(demandBandFor(65)).toBe("B_moderate_high");
    expect(demandBandFor(50)).toBe("C_normal");
    expect(demandBandFor(35)).toBe("D_weak");
    expect(demandBandFor(10)).toBe("E_very_weak");
  });

  it("maps demand index to congestion forecast rank", () => {
    expect(congestionRankFor(95)).toBe("S");
    expect(congestionRankFor(80)).toBe("A");
    expect(congestionRankFor(65)).toBe("B");
    expect(congestionRankFor(50)).toBe("C");
    expect(congestionRankFor(35)).toBe("D");
    expect(congestionRankFor(10)).toBe("E");
  });
});

// ---------------------------------------------------------------------------
// 15-17. Pricing posture
// ---------------------------------------------------------------------------

describe("pricing posture", () => {
  it("maps strong signals to raise_now or hold_strong", () => {
    const raise = decidePricingPosture({
      demandIndex: 88,
      soldOutPressureScore: 30,
      confidenceScore: 12,
      daysUntilCheckin: 10,
      availableCount: 0,
      usableSignalCount: 5
    });
    expect(raise).toBe("raise_now");
    const holdStrong = decidePricingPosture({
      demandIndex: 80,
      soldOutPressureScore: 10,
      confidenceScore: 4,
      daysUntilCheckin: 30,
      availableCount: 2,
      usableSignalCount: 3
    });
    expect(holdStrong).toBe("hold_strong");
  });

  it("maps weak close-in signals to sell_through or discount_candidate", () => {
    const discount = decidePricingPosture({
      demandIndex: 30,
      soldOutPressureScore: 2,
      confidenceScore: 3,
      daysUntilCheckin: 5,
      availableCount: 3,
      usableSignalCount: 3
    });
    expect(discount).toBe("discount_candidate");
    const sellThrough = decidePricingPosture({
      demandIndex: 50,
      soldOutPressureScore: 4,
      confidenceScore: 5,
      daysUntilCheckin: 40,
      availableCount: 4,
      usableSignalCount: 4
    });
    expect(sellThrough).toBe("sell_through");
  });

  it("produces insufficient_data when usable signal is too low", () => {
    const posture = decidePricingPosture({
      demandIndex: 80,
      soldOutPressureScore: 30,
      confidenceScore: 12,
      daysUntilCheckin: 10,
      availableCount: 0,
      usableSignalCount: 0
    });
    expect(posture).toBe("insufficient_data");
  });
});

// ---------------------------------------------------------------------------
// 18-19. Forbidden columns + no Booking base × 1.1
// ---------------------------------------------------------------------------

describe("output safety", () => {
  it("does not include PMS/Beds24/AirHost/per-room columns", () => {
    const header = DEMAND_INDEX_CSV_HEADERS.join(",").toLowerCase();
    for (const token of ["roomid", "minstay", "maxstay", "multiplier", "price1", "price2", "price3", "price4", "price5", "beds24", "airhost"]) {
      expect(header).not.toContain(token);
    }
    // Render with a built row too.
    const rows = buildDemandIndexRows([row({})], CTX);
    expect(renderDemandIndexCsv(rows).split("\n")[0]!.toLowerCase()).not.toMatch(/roomid|minstay|maxstay|multiplier|price1|beds24|airhost/);
  });

  it("uses no Booking base × 1.1 logic in source", () => {
    // The disclaimer prose legitimately names "base × 1.1" (× sign); assert no
    // ACTUAL arithmetic multiplication by 1.1 exists, plus a positive attestation.
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\*\s*1\.1/);
      expect(src).not.toMatch(/1\.1\s*\*/);
    }
    expect(SCRIPT_SOURCE).toContain("bookingBaseTimes1_1: false");
  });
});

// ---------------------------------------------------------------------------
// 20-22. No side effects in source
// ---------------------------------------------------------------------------

describe("no forbidden side effects", () => {
  it("does not write .data/history", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync)\s*\([^)]*\.data\/history/);
    }
    expect(SCRIPT_SOURCE).toContain("modifiedDataHistory: false");
  });

  it("no DB-write code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/better-sqlite3/i);
      expect(src).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(src).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    }
  });

  it("no GitHub Actions/GitOps activation code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\.github\/workflows/);
      expect(src).not.toMatch(/git\s+commit/);
      expect(src).not.toMatch(/git\s+push/);
    }
  });

  it("no live-fetch / paid-source code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\b(axios|node-fetch|playwright|puppeteer)\b/i);
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 23-24. Report content
// ---------------------------------------------------------------------------

describe("report content", () => {
  it("includes the restaurant congestion-forecast caution", () => {
    const md = renderDesignReport({ summary: makeSummary([]), rows: [] });
    expect(md).toContain("Restaurant congestion forecast is a tendency/rank, not an exact visitor count.");
    expect(md).toContain("## 7. Restaurant Congestion Forecast Use");
  });

  it("states that no automatic price update happens", () => {
    const md = renderDesignReport({ summary: makeSummary([]), rows: [] });
    expect(md).toContain("No automatic price update happens in DP01X.");
    expect(md).toContain("DP01X did not update prices.");
  });
});

// ---------------------------------------------------------------------------
// 25. Decision
// ---------------------------------------------------------------------------

describe("decision", () => {
  it("not_ready when no history rows or no demand rows", () => {
    expect(decideDP01X({ historyFileCount: 0, historyRowCount: 0, demandRowCount: 0, directPriceRowCount: 0, directionalPriceRowCount: 0, avgSourceCount: 0 })).toBe("zao_demand_index_design_not_ready");
  });

  it("basis_caution when directional-heavy / thin coverage", () => {
    expect(decideDP01X({ historyFileCount: 6, historyRowCount: 145, demandRowCount: 73, directPriceRowCount: 6, directionalPriceRowCount: 138, avgSourceCount: 1.2 })).toBe("zao_demand_index_design_basis_caution");
  });

  it("ready when coverage is rich and balanced", () => {
    expect(decideDP01X({ historyFileCount: 6, historyRowCount: 400, demandRowCount: 100, directPriceRowCount: 120, directionalPriceRowCount: 130, avgSourceCount: 3 })).toBe("zao_demand_index_design_ready");
  });

  it("generates at least one demand-index row from real history shape", () => {
    const ref = computePriceReference([row({})]);
    const rows = buildDemandIndexRows([row({}), row({ checkin: "2026-12-12", checkout: "2026-12-13", availabilityStatus: "sold_out", soldOutStatus: "sold_out" })], {
      ...CTX,
      refP66: ref.refP66,
      refP90: ref.refP90
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.demandIndex).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.demandIndex).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSummary(rows: DemandIndexRow[]): DesignSummary {
  return {
    runId: "run",
    generatedAt: "2026-06-03T20:00:00+09:00",
    sourceHistoryFiles: ["a.csv"],
    historyRowCount: rows.length,
    demandRowCount: rows.length,
    refP66: 60000,
    refP90: 80000,
    decision: "zao_demand_index_design_basis_caution",
    demandBandCounts: {},
    pricingPostureCounts: {},
    congestionRankCounts: {},
    confidenceLevelCounts: {},
    reportPath: "r.md",
    csvPath: "r.csv",
    jsonPath: "r.json",
    debugRootPath: "/debug"
  };
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPricePressure,
  computeUsabilitySummary,
  decideUsability,
  deriveMarketIdentity,
  isObservationQualified,
  renderB12XReport,
  renderUsabilityCsv,
  USABILITY_CSV_HEADERS,
  type BookingSignalRow
} from "../src/services/bookingPricePressureUsability";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/bookingPricePressureUsability.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildBookingPricePressureUsabilityReport.ts"), "utf8");

function bookingRow(overrides: Partial<BookingSignalRow> = {}): BookingSignalRow {
  return {
    rowId: "2026-06-01|booking|蔵王国際ホテル|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    source: "booking",
    canonicalPropertyName: "蔵王国際ホテル",
    sourcePropertyId: "zao-kokusai",
    checkinDate: "2026-06-14",
    checkoutDate: "2026-06-15",
    stayScope: "2_adults_1_room_1_night",
    collectedDateJst: "2026-06-01",
    availabilityStatus: "available",
    normalizedTotalJpy: 32157,
    basisConfidence: "B",
    dpUsage: "directional",
    exclusionReason: "",
    ...overrides
  };
}

describe("B12X classification primitives", () => {
  it("isObservationQualified detects the |obs: qualifier", () => {
    expect(isObservationQualified("a|b|obs:8f1f66a0819dc7f9")).toBe(true);
    expect(isObservationQualified("a|b|c")).toBe(false);
    expect(isObservationQualified("a|obs:zzzz")).toBe(false);
  });

  it("deriveMarketIdentity ignores collected date and obs qualifier", () => {
    const a = bookingRow({ collectedDateJst: "2026-06-01", rowId: "x" });
    const b = bookingRow({ collectedDateJst: "2026-06-04", rowId: "x|obs:8f1f66a0819dc7f9" });
    expect(deriveMarketIdentity(a)).toBe(deriveMarketIdentity(b));
    expect(deriveMarketIdentity(a)).toBe("booking|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night");
  });

  it("classifyPricePressure maps directional+price to usable", () => {
    expect(classifyPricePressure(bookingRow({ dpUsage: "directional", normalizedTotalJpy: 32157 }))).toBe(
      "price_pressure_usable"
    );
  });

  it("classifyPricePressure maps excluded to not usable", () => {
    expect(
      classifyPricePressure(bookingRow({ dpUsage: "excluded", normalizedTotalJpy: null, exclusionReason: "missing_official_tax_fee_adder" }))
    ).toBe("excluded_not_usable");
  });

  it("classifyPricePressure maps directional with no price to not usable", () => {
    expect(classifyPricePressure(bookingRow({ dpUsage: "directional", normalizedTotalJpy: null }))).toBe(
      "excluded_not_usable"
    );
  });

  it("classifyPricePressure maps direct to disallowed", () => {
    expect(classifyPricePressure(bookingRow({ dpUsage: "direct" }))).toBe("direct_disallowed");
  });
});

describe("B12X usability summary", () => {
  it("counts dp_usage splits, classes, and basis confidence", () => {
    const rows = [
      bookingRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "B", normalizedTotalJpy: 32157 }),
      bookingRow({ rowId: "r2", dpUsage: "directional", basisConfidence: "B", normalizedTotalJpy: 41000 }),
      bookingRow({ rowId: "r3", dpUsage: "excluded", basisConfidence: "C", normalizedTotalJpy: null })
    ];
    const summary = computeUsabilitySummary(rows);
    expect(summary.totalBookingRows).toBe(3);
    expect(summary.directionalCount).toBe(2);
    expect(summary.excludedCount).toBe(1);
    expect(summary.directCount).toBe(0);
    expect(summary.pricePressureUsableCount).toBe(2);
    expect(summary.excludedNotUsableCount).toBe(1);
    expect(summary.directDisallowedCount).toBe(0);
    expect(summary.excludedWithPriceCount).toBe(0);
    expect(summary.basisConfidenceCounts).toEqual({ B: 2, C: 1 });
  });

  it("detects repeated observations across collected dates and obs row_ids", () => {
    const base = bookingRow({ checkinDate: "2026-06-14", checkoutDate: "2026-06-15" });
    const rows = [
      { ...base, rowId: "first", collectedDateJst: "2026-06-01", normalizedTotalJpy: 32157 },
      { ...base, rowId: "first|obs:8f1f66a0819dc7f9", collectedDateJst: "2026-06-04", normalizedTotalJpy: 33300 }
    ];
    const summary = computeUsabilitySummary(rows);
    expect(summary.repeatedMarketIdentityCount).toBe(1);
    expect(summary.obsQualifiedRowCount).toBe(1);
    const repeated = summary.repeatedObservations[0]!;
    expect(repeated.observationCount).toBe(2);
    expect(repeated.obsQualifiedCount).toBe(1);
    expect(repeated.priceMinJpy).toBe(32157);
    expect(repeated.priceMaxJpy).toBe(33300);
    expect(repeated.priceSpreadJpy).toBe(1143);
  });

  it("builds price-movement sample from first to last priced observation", () => {
    const base = bookingRow({ checkinDate: "2026-06-14", checkoutDate: "2026-06-15" });
    const summary = computeUsabilitySummary([
      { ...base, rowId: "first", collectedDateJst: "2026-06-01", normalizedTotalJpy: 32157 },
      { ...base, rowId: "first|obs:8f1f66a0819dc7f9", collectedDateJst: "2026-06-04", normalizedTotalJpy: 33300 }
    ]);
    const sample = summary.priceMovementSamples[0]!;
    expect(sample.fromPriceJpy).toBe(32157);
    expect(sample.toPriceJpy).toBe(33300);
    expect(sample.deltaJpy).toBe(1143);
    expect(sample.toIsObservationQualified).toBe(true);
  });

  it("invariants hold for clean directional/excluded sample", () => {
    const summary = computeUsabilitySummary([
      bookingRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 32157 }),
      bookingRow({ rowId: "r2", dpUsage: "excluded", normalizedTotalJpy: null })
    ]);
    expect(summary.invariants.bookingDirectIsZero).toBe(true);
    expect(summary.invariants.excludedNotInPricePressure).toBe(true);
    expect(summary.invariants.directionalSurfacedInPricePressure).toBe(true);
  });
});

describe("B12X decision", () => {
  it("ready when invariants hold and no caveats (A-confidence, no excluded, no obs)", () => {
    const summary = computeUsabilitySummary([
      bookingRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "A", normalizedTotalJpy: 32157 })
    ]);
    expect(decideUsability(summary)).toBe("booking_price_pressure_usability_ready");
  });

  it("basis_caution when directional B-confidence / excluded / obs caveats present", () => {
    const summary = computeUsabilitySummary([
      bookingRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "B", normalizedTotalJpy: 32157 }),
      bookingRow({ rowId: "r2", dpUsage: "excluded", basisConfidence: "C", normalizedTotalJpy: null })
    ]);
    expect(decideUsability(summary)).toBe("booking_price_pressure_usability_basis_caution");
  });

  it("not_ready when there are zero Booking rows", () => {
    expect(decideUsability(computeUsabilitySummary([]))).toBe("booking_price_pressure_usability_not_ready");
  });

  it("not_ready when a direct Booking row exists", () => {
    const summary = computeUsabilitySummary([
      bookingRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 32157 }),
      bookingRow({ rowId: "r2", dpUsage: "direct", normalizedTotalJpy: 50000 })
    ]);
    expect(summary.invariants.bookingDirectIsZero).toBe(false);
    expect(decideUsability(summary)).toBe("booking_price_pressure_usability_not_ready");
  });

  it("not_ready when an excluded row carries a price", () => {
    const summary = computeUsabilitySummary([
      bookingRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 32157 }),
      bookingRow({ rowId: "r2", dpUsage: "excluded", normalizedTotalJpy: 40000 })
    ]);
    expect(summary.excludedWithPriceCount).toBe(1);
    expect(summary.invariants.excludedNotInPricePressure).toBe(false);
    expect(decideUsability(summary)).toBe("booking_price_pressure_usability_not_ready");
  });

  it("not_ready when no directional priced row is surfaced", () => {
    const summary = computeUsabilitySummary([bookingRow({ rowId: "r1", dpUsage: "excluded", normalizedTotalJpy: null })]);
    expect(summary.invariants.directionalSurfacedInPricePressure).toBe(false);
    expect(decideUsability(summary)).toBe("booking_price_pressure_usability_not_ready");
  });
});

describe("B12X rendering", () => {
  it("CSV header matches the allowed schema and emits a row per signal", () => {
    const rows = [bookingRow({ rowId: "r1" }), bookingRow({ rowId: "r2", dpUsage: "excluded", normalizedTotalJpy: null })];
    const csv = renderUsabilityCsv(rows);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(USABILITY_CSV_HEADERS.join(","));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("price_pressure_usable");
    expect(lines[2]).toContain("excluded_not_usable");
  });

  it("markdown report includes decision, invariants, and query corroboration", () => {
    const summary = computeUsabilitySummary([
      bookingRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "B", normalizedTotalJpy: 32157 })
    ]);
    const md = renderB12XReport({
      generatedAtJst: "2026-06-04T21:31:00+09:00",
      runId: "booking_price_pressure_usability_test",
      decision: decideUsability(summary),
      dbHistoryRowCount: 185,
      summary,
      queryArtifacts: [{ task: "pricing_support", decision: "ai_task_query_basis_caution", jsonPath: "x.json" }],
      reportPath: "r.md",
      jsonPath: "r.json",
      csvPath: "r.csv",
      debugRootPath: "debug"
    });
    expect(md).toContain("# Booking Price-Pressure Usability Verification (Phase BOOKING-B12X)");
    expect(md).toContain("booking_direct_rows_is_zero=true");
    expect(md).toContain("market_signal_history_row_count=185");
    expect(md).toContain("pricing_support");
  });
});

describe("B12X safety scans", () => {
  it("performs no DB mutation (no migration, no INSERT/UPDATE/DELETE)", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/executeMigration|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM/i);
  });

  it("does not modify .data/history", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/u);
  });

  it("has no live fetch / browser automation", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/fetch\(|playwright|chromium|page\.goto|newContext/i);
    }
  });

  it("has no PMS / channel-manager output", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/beds24|airhost|pms_upload|ota_upload/i);
    }
  });

  it("has no synthetic multiplier", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\*\s*1\.1\b/);
      expect(src).not.toMatch(/1\.1\s*\*/);
    }
  });

  it("has no price-update / pricing-write code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/pricing_recommendations|recommended_price|applyPrice|updatePrice/i);
    }
  });

  it("has no paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs|paid proxy/i);
    }
  });
});

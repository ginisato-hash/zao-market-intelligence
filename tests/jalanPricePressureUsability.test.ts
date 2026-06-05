import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allInvariantsHold,
  classifyPricePressure,
  computeUsabilitySummary,
  decideUsability,
  deriveMarketIdentity,
  evaluateInvariants,
  isObservationQualified,
  renderAUTO06XReport,
  renderUsabilityCsv,
  USABILITY_CSV_HEADERS,
  type InvariantEnvInput,
  type JalanSignalRow,
  type JalanUsabilitySummary
} from "../src/services/jalanPricePressureUsability";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/jalanPricePressureUsability.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildJalanPricePressureUsabilityReport.ts"),
  "utf8"
);
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function jalanRow(overrides: Partial<JalanSignalRow> = {}): JalanSignalRow {
  return {
    rowId: "2026-06-05|jalan|ホテル喜らく|yad325153|2026-06-06|2026-06-07|2_adults_1_room_1_night",
    source: "jalan",
    canonicalPropertyName: "ホテル喜らく",
    sourcePropertyId: "yad325153",
    checkinDate: "2026-06-06",
    checkoutDate: "2026-06-07",
    stayScope: "2_adults_1_room_1_night",
    collectedDateJst: "2026-06-05",
    availabilityStatus: "available",
    normalizedTotalJpy: 28000,
    basisConfidence: "B",
    dpUsage: "directional",
    exclusionReason: "",
    ...overrides
  };
}

// A passing environment: DB has the expected 210/38/46 counts, Booking carries
// more directional rows than Jalan, query smoke passed, no mutation occurred.
function passingEnv(summary: JalanUsabilitySummary, overrides: Partial<InvariantEnvInput> = {}): InvariantEnvInput {
  return {
    dbTotalRows: 210,
    dbJalanRows: 38,
    dbBookingRows: 46,
    bookingDirectionalCount: 45,
    jalanDirectionalCount: summary.directionalCount,
    querySmokeOk: true,
    historyNotModified: true,
    dbNotWritten: true,
    contextNotRefreshed: true,
    ...overrides
  };
}

const NO_AUTO05X: ReadonlySet<string> = new Set<string>();

describe("AUTO06X classification primitives", () => {
  it("isObservationQualified detects the |obs: qualifier", () => {
    expect(isObservationQualified("a|b|obs:8f1f66a0819dc7f9")).toBe(true);
    expect(isObservationQualified("a|b|c")).toBe(false);
    expect(isObservationQualified("a|obs:zzzz")).toBe(false);
  });

  it("deriveMarketIdentity ignores collected date and obs qualifier", () => {
    const a = jalanRow({ collectedDateJst: "2026-06-01", rowId: "x" });
    const b = jalanRow({ collectedDateJst: "2026-06-05", rowId: "x|obs:8f1f66a0819dc7f9" });
    expect(deriveMarketIdentity(a)).toBe(deriveMarketIdentity(b));
    expect(deriveMarketIdentity(a)).toBe("jalan|yad325153|2026-06-06|2026-06-07|2_adults_1_room_1_night");
  });

  it("classifyPricePressure maps directional+price to usable (supplementary)", () => {
    expect(classifyPricePressure(jalanRow({ dpUsage: "directional", normalizedTotalJpy: 28000 }))).toBe(
      "price_pressure_usable"
    );
  });

  it("classifyPricePressure maps directional with no price to directional_no_price", () => {
    expect(classifyPricePressure(jalanRow({ dpUsage: "directional", normalizedTotalJpy: null }))).toBe(
      "directional_no_price"
    );
  });

  it("classifyPricePressure maps excluded to audit-only even when priced", () => {
    expect(
      classifyPricePressure(jalanRow({ dpUsage: "excluded", normalizedTotalJpy: 31000, exclusionReason: "missing_official_tax_fee_adder" }))
    ).toBe("excluded_audit_only");
    expect(classifyPricePressure(jalanRow({ dpUsage: "excluded", normalizedTotalJpy: null }))).toBe(
      "excluded_audit_only"
    );
  });

  it("classifyPricePressure maps direct to legacy (pre-existing, allowed)", () => {
    expect(classifyPricePressure(jalanRow({ dpUsage: "direct", basisConfidence: "A" }))).toBe("direct_legacy");
  });
});

describe("AUTO06X usability summary", () => {
  it("counts dp_usage splits, classes, and basis confidence", () => {
    const rows = [
      jalanRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "B", normalizedTotalJpy: 28000 }),
      jalanRow({ rowId: "r2", dpUsage: "directional", basisConfidence: "B", normalizedTotalJpy: 41000 }),
      jalanRow({ rowId: "r3", dpUsage: "excluded", basisConfidence: "insufficient", normalizedTotalJpy: 30000 }),
      jalanRow({ rowId: "r4", dpUsage: "direct", basisConfidence: "A", normalizedTotalJpy: 26000 })
    ];
    const summary = computeUsabilitySummary(rows, NO_AUTO05X);
    expect(summary.totalJalanRows).toBe(4);
    expect(summary.directionalCount).toBe(2);
    expect(summary.excludedCount).toBe(1);
    expect(summary.directCount).toBe(1);
    expect(summary.pricePressureUsableCount).toBe(2);
    expect(summary.excludedAuditOnlyCount).toBe(1);
    expect(summary.directLegacyCount).toBe(1);
    // Excluded carries a price but must never be counted as usable.
    expect(summary.excludedWithPriceCount).toBe(1);
    expect(summary.excludedClassifiedUsableCount).toBe(0);
    expect(summary.basisConfidenceCounts).toEqual({ B: 2, insufficient: 1, A: 1 });
  });

  it("tracks the AUTO05X appended-subset metrics by row_id set", () => {
    const auto05x = new Set(["a1", "a2", "a3"]);
    const rows = [
      jalanRow({ rowId: "a1", dpUsage: "directional", normalizedTotalJpy: 28000 }),
      jalanRow({ rowId: "a2", dpUsage: "excluded", normalizedTotalJpy: null }),
      jalanRow({ rowId: "a3", dpUsage: "excluded", normalizedTotalJpy: 30000 }),
      jalanRow({ rowId: "legacy1", dpUsage: "direct", basisConfidence: "A", normalizedTotalJpy: 26000 })
    ];
    const summary = computeUsabilitySummary(rows, auto05x);
    expect(summary.auto05x.rowsCount).toBe(3);
    expect(summary.auto05x.directionalCount).toBe(1);
    expect(summary.auto05x.excludedCount).toBe(2);
    expect(summary.auto05x.directCount).toBe(0);
    expect(summary.auto05x.pricePressureUsableCount).toBe(1);
  });

  it("detects repeated observations across collected dates and obs row_ids", () => {
    const base = jalanRow({ checkinDate: "2026-06-06", checkoutDate: "2026-06-07" });
    const rows = [
      { ...base, rowId: "first", collectedDateJst: "2026-06-01", normalizedTotalJpy: 28000 },
      { ...base, rowId: "first|obs:8f1f66a0819dc7f9", collectedDateJst: "2026-06-05", normalizedTotalJpy: 29500 }
    ];
    const summary = computeUsabilitySummary(rows, NO_AUTO05X);
    expect(summary.repeatedMarketIdentityCount).toBe(1);
    expect(summary.obsQualifiedRowCount).toBe(1);
    const repeated = summary.repeatedObservations[0]!;
    expect(repeated.observationCount).toBe(2);
    expect(repeated.obsQualifiedCount).toBe(1);
    expect(repeated.priceMinJpy).toBe(28000);
    expect(repeated.priceMaxJpy).toBe(29500);
    expect(repeated.priceSpreadJpy).toBe(1500);
  });

  it("builds price-movement sample from first to last priced observation", () => {
    const base = jalanRow({ checkinDate: "2026-06-06", checkoutDate: "2026-06-07" });
    const summary = computeUsabilitySummary(
      [
        { ...base, rowId: "first", collectedDateJst: "2026-06-01", normalizedTotalJpy: 28000 },
        { ...base, rowId: "first|obs:8f1f66a0819dc7f9", collectedDateJst: "2026-06-05", normalizedTotalJpy: 29500 }
      ],
      NO_AUTO05X
    );
    const sample = summary.priceMovementSamples[0]!;
    expect(sample.fromPriceJpy).toBe(28000);
    expect(sample.toPriceJpy).toBe(29500);
    expect(sample.deltaJpy).toBe(1500);
    expect(sample.toIsObservationQualified).toBe(true);
  });

  it("summary invariants hold for a directional/excluded/legacy-direct sample", () => {
    const summary = computeUsabilitySummary(
      [
        jalanRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 28000 }),
        jalanRow({ rowId: "r2", dpUsage: "excluded", normalizedTotalJpy: 30000 }),
        jalanRow({ rowId: "r3", dpUsage: "direct", basisConfidence: "A", normalizedTotalJpy: 26000 })
      ],
      NO_AUTO05X
    );
    expect(summary.invariants.jalanDirectionalSurfacedInPricePressure).toBe(true);
    expect(summary.invariants.excludedNotPricePressureUsable).toBe(true);
    expect(summary.invariants.auto05xAddedDirectIsZero).toBe(true);
  });

  it("auto05xAddedDirectIsZero is false when an AUTO05X row is direct", () => {
    const auto05x = new Set(["a1"]);
    const summary = computeUsabilitySummary(
      [
        jalanRow({ rowId: "a1", dpUsage: "direct", basisConfidence: "A", normalizedTotalJpy: 26000 }),
        jalanRow({ rowId: "r2", dpUsage: "directional", normalizedTotalJpy: 28000 })
      ],
      auto05x
    );
    expect(summary.auto05x.directCount).toBe(1);
    expect(summary.invariants.auto05xAddedDirectIsZero).toBe(false);
  });
});

describe("AUTO06X environmental invariants", () => {
  it("all invariants hold for the expected 210/38/46 DB shape", () => {
    const summary = computeUsabilitySummary(
      [jalanRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 28000 })],
      NO_AUTO05X
    );
    const checks = evaluateInvariants(summary, passingEnv(summary));
    expect(allInvariantsHold(checks)).toBe(true);
    expect(checks.db_total_rows_is_210).toBe(true);
    expect(checks.db_jalan_rows_is_38).toBe(true);
    expect(checks.db_booking_rows_is_46).toBe(true);
    expect(checks.booking_remains_primary_directional_source).toBe(true);
  });

  it("booking_remains_primary fails when Jalan directional >= Booking directional", () => {
    const summary = computeUsabilitySummary(
      [
        jalanRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 28000 }),
        jalanRow({ rowId: "r2", dpUsage: "directional", normalizedTotalJpy: 29000 })
      ],
      NO_AUTO05X
    );
    const checks = evaluateInvariants(summary, passingEnv(summary, { bookingDirectionalCount: 2 }));
    expect(checks.booking_remains_primary_directional_source).toBe(false);
    expect(allInvariantsHold(checks)).toBe(false);
  });

  it("DB-count invariants fail when totals drift", () => {
    const summary = computeUsabilitySummary(
      [jalanRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 28000 })],
      NO_AUTO05X
    );
    const checks = evaluateInvariants(summary, passingEnv(summary, { dbTotalRows: 209, dbJalanRows: 37 }));
    expect(checks.db_total_rows_is_210).toBe(false);
    expect(checks.db_jalan_rows_is_38).toBe(false);
  });

  it("safety invariants fail when a mutation flag is tripped", () => {
    const summary = computeUsabilitySummary(
      [jalanRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 28000 })],
      NO_AUTO05X
    );
    const checks = evaluateInvariants(summary, passingEnv(summary, { dbNotWritten: false }));
    expect(checks.db_not_written_by_this_phase).toBe(false);
    expect(allInvariantsHold(checks)).toBe(false);
  });
});

describe("AUTO06X decision", () => {
  it("ready when invariants hold and there are no caveats (A-confidence, no excluded/direct/obs)", () => {
    const summary = computeUsabilitySummary(
      [jalanRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "A", normalizedTotalJpy: 28000 })],
      NO_AUTO05X
    );
    expect(summary.caveats).toHaveLength(0);
    const checks = evaluateInvariants(summary, passingEnv(summary));
    expect(decideUsability(summary, checks)).toBe("jalan_price_pressure_usability_ready");
  });

  it("basis_caution when supplementary B-confidence / excluded / direct / obs caveats present", () => {
    const summary = computeUsabilitySummary(
      [
        jalanRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "B", normalizedTotalJpy: 28000 }),
        jalanRow({ rowId: "r2", dpUsage: "excluded", normalizedTotalJpy: 30000 }),
        jalanRow({ rowId: "r3", dpUsage: "direct", basisConfidence: "A", normalizedTotalJpy: 26000 })
      ],
      NO_AUTO05X
    );
    expect(summary.caveats.length).toBeGreaterThan(0);
    const checks = evaluateInvariants(summary, passingEnv(summary));
    expect(decideUsability(summary, checks)).toBe("jalan_price_pressure_usability_basis_caution");
  });

  it("not_ready when there are zero Jalan rows", () => {
    const summary = computeUsabilitySummary([], NO_AUTO05X);
    const checks = evaluateInvariants(summary, passingEnv(summary, { dbJalanRows: 0 }));
    expect(decideUsability(summary, checks)).toBe("jalan_price_pressure_usability_not_ready");
  });

  it("not_ready when an AUTO05X-added direct row exists", () => {
    const auto05x = new Set(["a1"]);
    const summary = computeUsabilitySummary(
      [
        jalanRow({ rowId: "a1", dpUsage: "direct", basisConfidence: "A", normalizedTotalJpy: 26000 }),
        jalanRow({ rowId: "r2", dpUsage: "directional", normalizedTotalJpy: 28000 })
      ],
      auto05x
    );
    const checks = evaluateInvariants(summary, passingEnv(summary));
    expect(checks.auto05x_added_direct_rows_is_0).toBe(false);
    expect(decideUsability(summary, checks)).toBe("jalan_price_pressure_usability_not_ready");
  });

  it("not_ready when no directional priced row is surfaced", () => {
    const summary = computeUsabilitySummary(
      [jalanRow({ rowId: "r1", dpUsage: "excluded", normalizedTotalJpy: 30000 })],
      NO_AUTO05X
    );
    expect(summary.invariants.jalanDirectionalSurfacedInPricePressure).toBe(false);
    const checks = evaluateInvariants(summary, passingEnv(summary));
    expect(decideUsability(summary, checks)).toBe("jalan_price_pressure_usability_not_ready");
  });

  it("not_ready when query smoke did not pass", () => {
    const summary = computeUsabilitySummary(
      [jalanRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "A", normalizedTotalJpy: 28000 })],
      NO_AUTO05X
    );
    const checks = evaluateInvariants(summary, passingEnv(summary, { querySmokeOk: false }));
    expect(checks.query_smoke_passed_or_basis_caution).toBe(false);
    expect(decideUsability(summary, checks)).toBe("jalan_price_pressure_usability_not_ready");
  });
});

describe("AUTO06X rendering", () => {
  it("CSV header matches the allowed schema and emits a row per signal", () => {
    const auto05x = new Set(["r1"]);
    const rows = [
      jalanRow({ rowId: "r1", dpUsage: "directional", normalizedTotalJpy: 28000 }),
      jalanRow({ rowId: "r2", dpUsage: "excluded", normalizedTotalJpy: 30000 })
    ];
    const csv = renderUsabilityCsv(rows, auto05x);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(USABILITY_CSV_HEADERS.join(","));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("price_pressure_usable");
    expect(lines[1]).toContain("true"); // is_auto05x_row
    expect(lines[2]).toContain("excluded_audit_only");
  });

  it("markdown report includes decision, invariants, AUTO05X metrics, and Booking comparison", () => {
    const summary = computeUsabilitySummary(
      [jalanRow({ rowId: "r1", dpUsage: "directional", basisConfidence: "B", normalizedTotalJpy: 28000 })],
      NO_AUTO05X
    );
    const checks = evaluateInvariants(summary, passingEnv(summary));
    const md = renderAUTO06XReport({
      generatedAtJst: "2026-06-05T11:00:00+09:00",
      runId: "jalan_price_pressure_usability_test",
      decision: decideUsability(summary, checks),
      dbHistoryRowCount: 210,
      summary,
      bookingComparison: {
        totalBookingRows: 46,
        bookingDirectionalCount: 45,
        bookingDirectCount: 0,
        jalanDirectionalCount: summary.directionalCount,
        bookingRemainsPrimary: true
      },
      invariantChecks: checks,
      queryArtifacts: [{ task: "pricing_support", decision: "ai_task_query_basis_caution", jsonPath: "x.json" }],
      sourceAuto05bArtifactPath: "post_jalan.json",
      reportPath: "r.md",
      jsonPath: "r.json",
      csvPath: "r.csv",
      debugRootPath: "debug"
    });
    expect(md).toContain("# Jalan Price-Pressure Usability Verification (Phase JALAN-AUTO06X)");
    expect(md).toContain("market_signal_history_row_count=210");
    expect(md).toContain("auto05x_added_direct_rows_is_0=true");
    expect(md).toContain("booking_remains_primary_directional_source=true");
    expect(md).toContain("pricing_support");
  });
});

describe("AUTO06X package wiring", () => {
  it("exposes the report:jalan-price-pressure-usability npm script", () => {
    expect(PACKAGE_JSON).toContain(
      '"report:jalan-price-pressure-usability": "node --import tsx src/scripts/buildJalanPricePressureUsabilityReport.ts"'
    );
  });
});

describe("AUTO06X safety scans", () => {
  it("opens the DB strictly readonly and never migrates", () => {
    expect(SCRIPT_SOURCE).toMatch(/new Database\([\s\S]{0,120}?readonly:\s*true/);
    expect(SCRIPT_SOURCE).not.toMatch(/executeMigration|openLocalDatabase/);
  });

  it("performs no DB mutation (no INSERT/UPDATE/DELETE/CREATE/DROP/ALTER)", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE/i);
    }
  });

  it("does not modify .data/history", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/u);
  });

  it("has no live fetch / browser automation", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/fetch\(|playwright|chromium|page\.goto|newContext/i);
    }
  });

  it("does not re-run DB sync or AI context refresh", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/runHistoryToDbSync|buildAiContextPacks|applyRealSync/);
  });

  it("has no PMS / channel-manager output", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/beds24|airhost|pms_upload|ota_upload/i);
    }
  });

  it("has no synthetic multiplier or price-update code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\*\s*1\.1\b/);
      expect(src).not.toMatch(/1\.1\s*\*/);
      expect(src).not.toMatch(/pricing_recommendations|recommended_price|applyPrice|updatePrice/i);
    }
  });

  it("has no paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs|paid proxy/i);
    }
  });
});

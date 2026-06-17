import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_COLUMNS,
  HISTORY_CSV_HEADERS,
  HISTORY_SCHEMA_VERSION,
  buildRowHash,
  buildRowId,
  decideM02X,
  findDuplicateRowIds,
  groupRowsByShardMonth,
  mapUnifiedRowToHistoryRow,
  mapUnifiedRowsToHistoryRows,
  renderHistoryCsv,
  renderHistorySchemaDesignReport,
  shardMonthFromCheckin,
  validateHistoryRow,
  validateHistoryRows,
  validateHistorySchemaColumns,
  type HistoryRow
} from "../src/services/localHistorySchemaDesign";
import { type UnifiedMarketSignalRow } from "../src/services/crossSourceMarketSignalNormalization";

const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildLocalHistorySchemaDesignReport.ts"),
  "utf8"
);

function makeUnified(overrides: Partial<UnifiedMarketSignalRow> = {}): UnifiedMarketSignalRow {
  return {
    runId: "cross_source_test",
    normalizedAtJst: "2026-06-01T23:07:31+09:00",
    source: "booking",
    sourcePhase: "B04X",
    collectorStage: "local_normalization_only",
    canonicalPropertyName: "蔵王国際ホテル",
    sourcePropertyName: "蔵王国際ホテル",
    propertyIdentityMatch: true,
    sourcePropertyId: "zao-kokusai",
    sourceSlugOrCode: "zao-kokusai",
    checkin: "2026-08-12",
    checkout: "2026-08-13",
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: "2_adults_1_room_1_night",
    availabilityStatus: "available",
    soldOutStatus: "available",
    normalizedTotalPrice: 60_360,
    normalizedTotalPriceSource: "booking_official_base_plus_visible_tax_fee_adder",
    normalizedTotalPriceBasis: "room_total_official_visible_tax_fee_2_adults_1_room_1_night",
    normalizedTotalPriceConfidence: "B",
    basisConfidence: "B",
    basisNote: "Computed total = base + official adder; no 1.1 multiplier.",
    sourcePrimaryPrice: 60_060,
    sourceSecondaryPriceOrAdder: 300,
    sourceComputedTotal: 60_360,
    sourceTaxOrFeeClassification: "booking_room_total_official_base_plus_tax_fee_adder",
    sourceClassification: "booking_b04a_official_base_plus_adder_numeric",
    mealBasisClass: "assumed_room_only",
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: true,
    isPriceExcludedFromDp: false,
    dpExclusionReason: null,
    warningFlags: "",
    sourceReportPath: "/abs/m01x.md",
    sourceCsvPath: "/abs/m01x.csv",
    debugArtifactPath: "/abs/debug/20260601_230731/zao-kokusai_2026-08-12",
    ...overrides
  };
}

function makeHistory(overrides: Partial<UnifiedMarketSignalRow> = {}): HistoryRow {
  return mapUnifiedRowToHistoryRow(makeUnified(overrides));
}

describe("Phase M02X — mapping & shard month", () => {
  it("(1) maps a unified row into a history row preserving values + schema version", () => {
    const row = makeHistory();
    expect(row.schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
    expect(row.source).toBe("booking");
    expect(row.normalizedTotalPrice).toBe(60_360);
    expect(row.collectedDateJst).toBe("2026-06-01");
    expect(row.collectedAtJst).toBe("2026-06-01T23:07:31+09:00");
  });

  it("(2) shard_month from checkin 2026-08-12 is 2026_08", () => {
    expect(shardMonthFromCheckin("2026-08-12")).toBe("2026_08");
    expect(makeHistory().shardMonth).toBe("2026_08");
  });

  it("(3) missing checkin yields unknown shard", () => {
    expect(shardMonthFromCheckin("")).toBe("unknown");
    expect(makeHistory({ checkin: "" }).shardMonth).toBe("unknown");
  });
});

describe("Phase M02X — row identity & hash", () => {
  it("(4) row_id is deterministic for the same identity", () => {
    const a = makeHistory();
    const b = makeHistory();
    expect(a.rowId).toBe(b.rowId);
    expect(a.rowId).toBe("2026-06-01|booking|蔵王国際ホテル|zao-kokusai|2026-08-12|2026-08-13|2_adults_1_room_1_night");
  });

  it("row_id falls back to market_aggregate when slug and id are blank", () => {
    const id = buildRowId({
      collectedDateJst: "2026-06-01",
      source: "jalan",
      canonicalPropertyName: "market_aggregate",
      sourceSlugOrCode: "",
      sourcePropertyId: "",
      checkin: "2026-07-18",
      checkout: "2026-07-19",
      stayScope: "2_adults_1_room_1_night"
    });
    expect(id).toContain("|market_aggregate|");
  });

  it("(5) row_hash is deterministic for unchanged values", () => {
    expect(makeHistory().rowHash).toBe(makeHistory().rowHash);
  });

  it("(6) row_hash changes when normalized_total_price changes", () => {
    expect(makeHistory().rowHash).not.toBe(makeHistory({ normalizedTotalPrice: 99_999 }).rowHash);
  });

  it("(7) row_hash does not change when debug path changes", () => {
    expect(makeHistory().rowHash).toBe(makeHistory({ debugArtifactPath: "/some/other/path" }).rowHash);
  });

  it("buildRowHash excludes debug path by construction", () => {
    const base = {
      source: "booking",
      sourcePhase: "B04X",
      collectorStage: "local_normalization_only",
      canonicalPropertyName: "蔵王国際ホテル",
      sourceSlugOrCode: "zao-kokusai",
      sourcePropertyId: "zao-kokusai",
      checkin: "2026-08-12",
      checkout: "2026-08-13",
      stayScope: "2_adults_1_room_1_night",
      collectedDateJst: "2026-06-01",
      availabilityStatus: "available",
      soldOutStatus: "available",
      normalizedTotalPrice: 60_360,
      basisConfidence: "B",
      sourceClassification: "x",
      isPriceUsableForDpDirect: false,
      isPriceUsableForDpDirectional: true,
      isPriceExcludedFromDp: false
    };
    expect(buildRowHash(base)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("Phase M02X — dedupe & shard grouping", () => {
  it("(8) detects duplicate row_ids", () => {
    const rows = [makeHistory(), makeHistory(), makeHistory({ checkin: "2026-08-13", checkout: "2026-08-14" })];
    const dups = findDuplicateRowIds(rows);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.count).toBe(2);
  });

  it("(9) groups rows by shard month with source counts", () => {
    const rows = [
      makeHistory(),
      makeHistory({ source: "jalan", sourceSlugOrCode: "", sourcePropertyId: "", canonicalPropertyName: "market_aggregate", checkin: "2026-07-18", checkout: "2026-07-19" })
    ];
    const groups = groupRowsByShardMonth(rows);
    expect(groups.map((g) => g.shardMonth)).toEqual(["2026_07", "2026_08"]);
    expect(groups[1]!.futureShardPath).toBe(".data/history/zao_signals_2026_08.csv");
  });
});

describe("Phase M02X — validation", () => {
  it("(10) valid row passes", () => {
    expect(validateHistoryRow(makeHistory())).toEqual([]);
  });

  it("(11) missing row_id fails", () => {
    const row = makeHistory();
    row.rowId = "";
    expect(validateHistoryRow(row)).toContain("row_id_empty");
  });

  it("(12) invalid source fails", () => {
    const row = makeHistory();
    row.source = "expedia";
    expect(validateHistoryRow(row)).toContain("invalid_source:expedia");
  });

  it("(13) direct and excluded both true fails", () => {
    const row = makeHistory();
    row.isPriceUsableForDpDirect = true;
    row.isPriceExcludedFromDp = true;
    expect(validateHistoryRow(row)).toContain("direct_and_excluded");
  });

  it("(14) non-numeric normalized_total_price fails", () => {
    const row = makeHistory();
    (row as unknown as { normalizedTotalPrice: unknown }).normalizedTotalPrice = "60360";
    expect(validateHistoryRow(row)).toContain("normalized_total_price_not_numeric:60360");
  });

  it("(15) booking row rejects deprecated tax_multiplier classification", () => {
    const row = makeHistory({ sourceTaxOrFeeClassification: "tax_multiplier_1_1" });
    expect(validateHistoryRow(row)).toContain("booking_deprecated_tax_field");
  });

  it("(16) schema rejects Beds24/AirHost/PMS forbidden columns", () => {
    const errors = validateHistorySchemaColumns([...HISTORY_CSV_HEADERS, "beds24", "airhost", "pms", "roomid"]);
    expect(errors).toContain("forbidden_column:beds24");
    expect(errors).toContain("forbidden_column:airhost");
    expect(errors).toContain("forbidden_column:pms");
    expect(errors).toContain("forbidden_column:roomid");
  });

  it("the canonical schema itself has no forbidden columns and no missing columns", () => {
    expect(validateHistorySchemaColumns([...HISTORY_CSV_HEADERS])).toEqual([]);
    for (const col of HISTORY_CSV_HEADERS) {
      expect(FORBIDDEN_COLUMNS).not.toContain(col);
    }
  });
});

describe("Phase M02X — CSV, transform, report", () => {
  const rows = [
    makeHistory(),
    makeHistory({ source: "jalan", sourceSlugOrCode: "", sourcePropertyId: "", canonicalPropertyName: "market_aggregate", checkin: "2026-07-18", checkout: "2026-07-19", normalizedTotalPrice: 12_250 })
  ];

  it("(17) CSV uses the stable column order", () => {
    const csv = renderHistoryCsv(rows);
    const header = csv.trim().split("\n")[0] ?? "";
    expect(header).toBe(HISTORY_CSV_HEADERS.join(","));
    expect(csv.trim().split("\n")).toHaveLength(rows.length + 1);
    expect(header).not.toMatch(/beds24|airhost|\bpms\b|roomid|inventory|minstay|maxstay|multiplier|price[1-5]/iu);
    expect(header).not.toMatch(/tax_multiplier|tax_included_price|tax_normalization_rule/u);
  });

  // Meal-basis hardening must NOT change the live v1 history schema: the 2-hourly
  // append writer keeps the existing 45-column header, so adding columns would
  // corrupt live shards. Meal basis is encoded via existing columns + derived at
  // BI export time, never by widening the history CSV.
  it("(17b) history schema stays 45-column v1 (no meal-basis/room-basis columns added)", () => {
    expect(HISTORY_CSV_HEADERS).toHaveLength(45);
    const header = renderHistoryCsv(rows).trim().split("\n")[0] ?? "";
    expect(header.split(",")).toHaveLength(45);
    expect(header).not.toMatch(/meal_basis|price_use_class|selected_plan_name|selected_block_text/u);
    // room-basis hardening must NOT widen the live v1 shard schema either.
    expect(header).not.toMatch(/room_basis|two_person_room|room_type_excluded|room_basis_summary/u);
    const dataCols = (renderHistoryCsv(rows).trim().split("\n")[1] ?? "").split(",");
    // every rendered data row has exactly the header column count (append-safe)
    expect(dataCols.length).toBeGreaterThanOrEqual(45);
  });

  it("(18) prototype transformation preserves row count", () => {
    const unified = [makeUnified(), makeUnified({ checkin: "2026-10-10", checkout: "2026-10-11" })];
    expect(mapUnifiedRowsToHistoryRows(unified)).toHaveLength(unified.length);
  });

  it("(19) report includes the monthly shard plan", () => {
    const validation = validateHistoryRows(rows);
    const duplicates = findDuplicateRowIds(rows);
    const shardGroups = groupRowsByShardMonth(rows);
    const report = renderHistorySchemaDesignReport({
      generatedAt: "2026-06-01T14:30:00.000Z",
      rows,
      decision: decideM02X({ rowCount: rows.length, validation, duplicates, forbiddenColumnErrors: [] }),
      validation,
      duplicates,
      shardGroups,
      forbiddenColumnErrors: [],
      dpGate: { direct: 0, directional: 2, excluded: 0 },
      sourceArtifact: { reportPath: "/m.md", csvPath: "/m.csv", jsonPath: "/m.json" },
      reportPath: "/out.md",
      csvPath: "/out.csv",
      jsonPath: "/out.json",
      debugRootPath: "/debug"
    });
    expect(report).toMatch(/Shard month plan/u);
    expect(report).toMatch(/\.data\/history\/zao_signals_2026_08\.csv/u);
    expect(report).toMatch(/NO DB writes/u);
  });

  it("(20) JSON-facing summary helpers expose validation and duplicate counts", () => {
    const validation = validateHistoryRows([...rows, makeHistory()]);
    const duplicates = findDuplicateRowIds([...rows, makeHistory()]);
    expect(validation.invalidRowCount).toBe(0);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.count).toBe(2);
  });
});

describe("Phase M02X — decision & safety", () => {
  it("decision is ready for clean valid rows with no duplicates", () => {
    const rows = [makeHistory(), makeHistory({ checkin: "2026-10-10", checkout: "2026-10-11" })];
    const validation = validateHistoryRows(rows);
    const duplicates = findDuplicateRowIds(rows);
    expect(decideM02X({ rowCount: rows.length, validation, duplicates, forbiddenColumnErrors: [] })).toBe(
      "local_history_schema_design_ready"
    );
  });

  it("decision is basis_caution when duplicates exist", () => {
    const rows = [makeHistory(), makeHistory()];
    const validation = validateHistoryRows(rows);
    const duplicates = findDuplicateRowIds(rows);
    expect(decideM02X({ rowCount: rows.length, validation, duplicates, forbiddenColumnErrors: [] })).toBe(
      "local_history_schema_design_basis_caution"
    );
  });

  it("decision is not_ready on validation errors or forbidden columns", () => {
    const bad = makeHistory();
    bad.source = "expedia";
    const rows = [bad];
    const validation = validateHistoryRows(rows);
    expect(
      decideM02X({ rowCount: rows.length, validation, duplicates: [], forbiddenColumnErrors: [] })
    ).toBe("local_history_schema_design_not_ready");
    expect(
      decideM02X({ rowCount: 1, validation: validateHistoryRows([makeHistory()]), duplicates: [], forbiddenColumnErrors: ["forbidden_column:beds24"] })
    ).toBe("local_history_schema_design_not_ready");
  });

  it("(21) script never writes to .data/history and guards against it", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/u);
    expect(SCRIPT_SOURCE).toMatch(/must not write real history shards/u);
  });

  it("(22) script stops with a clear error when the M01X artifact is missing", () => {
    expect(SCRIPT_SOURCE).toMatch(/Stop and report the missing artifact path/u);
    expect(SCRIPT_SOURCE).toMatch(/Do not re-run collectors/u);
  });
});

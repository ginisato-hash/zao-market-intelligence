import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSafetyConfirmation,
  computeAppendPreflight,
  decideBeforeWrite,
  evaluateGate,
  groupRowsToSourceShards,
  renderAppendActionCsv,
  renderReport,
  selectApprovedRows,
  validateAfterAppend,
  validateCanonicalIdentity,
  type ExistingHistoryKey,
  type HistoryInventory
} from "../src/services/bookingPreviewHistoryAppendRealRun";
import { buildRowHash, buildRowId, type HistoryRow } from "../src/services/localHistorySchemaDesign";
import { type BookingPreviewReviewRow } from "../src/services/bookingPreviewAppendProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/bookingPreviewHistoryAppendRealRun.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runBookingPreviewHistoryAppendRealRun.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function historyRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  const base = {
    collectedDateJst: "2026-06-06",
    source: "booking",
    sourcePhase: "AUTO-RUNNER08X",
    collectorStage: "booking_preview_gated_live",
    canonicalPropertyName: "蔵王国際ホテル",
    sourceSlugOrCode: "zao-kokusai",
    sourcePropertyId: "zao-kokusai",
    checkin: "2026-06-13",
    checkout: "2026-06-14",
    stayScope: "2_adults_1_room_1_night",
    availabilityStatus: "available_price_basis",
    soldOutStatus: "not_sold_out",
    normalizedTotalPrice: 30155,
    basisConfidence: "B",
    sourceClassification: "booking_directional_visible_price_only",
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: true,
    isPriceExcludedFromDp: false
  };
  const rowId = buildRowId({
    collectedDateJst: base.collectedDateJst,
    source: base.source,
    canonicalPropertyName: base.canonicalPropertyName,
    sourceSlugOrCode: base.sourceSlugOrCode,
    sourcePropertyId: base.sourcePropertyId,
    checkin: base.checkin,
    checkout: base.checkout,
    stayScope: base.stayScope
  });
  const rowHash = buildRowHash(base);
  return {
    rowId,
    rowHash,
    shardMonth: "2026_06",
    collectedDateJst: base.collectedDateJst,
    collectedAtJst: "2026-06-06T13:01:49+09:00",
    normalizedAtJst: "2026-06-06T13:01:49+09:00",
    source: base.source,
    sourcePhase: base.sourcePhase,
    collectorStage: base.collectorStage,
    canonicalPropertyName: base.canonicalPropertyName,
    sourcePropertyName: base.canonicalPropertyName,
    propertyIdentityMatch: true,
    sourcePropertyId: base.sourcePropertyId,
    sourceSlugOrCode: base.sourceSlugOrCode,
    checkin: base.checkin,
    checkout: base.checkout,
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: base.stayScope,
    availabilityStatus: base.availabilityStatus,
    soldOutStatus: base.soldOutStatus,
    normalizedTotalPrice: base.normalizedTotalPrice,
    normalizedTotalPriceSource: "booking_visible_price_candidate",
    normalizedTotalPriceBasis: "visible_booking_price_directional_only",
    normalizedTotalPriceConfidence: "B",
    basisConfidence: base.basisConfidence,
    basisNote: "directional visible price signal; not all-in official total",
    sourcePrimaryPrice: 30155,
    sourceSecondaryPriceOrAdder: null,
    sourceComputedTotal: null,
    sourceTaxOrFeeClassification: "official_visible_adder_not_available",
    sourceClassification: base.sourceClassification,
    isPriceUsableForDpDirect: base.isPriceUsableForDpDirect,
    isPriceUsableForDpDirectional: base.isPriceUsableForDpDirectional,
    isPriceExcludedFromDp: base.isPriceExcludedFromDp,
    dpExclusionReason: null,
    warningFlags: "preview",
    sourceReportPath: "preview.md",
    sourceCsvPath: "preview.csv",
    debugArtifactPath: "debug",
    schemaVersion: "zao_local_history_v1",
    ...overrides
  };
}

function reviewRow(overrides: Partial<BookingPreviewReviewRow> = {}): BookingPreviewReviewRow {
  const row = historyRow();
  return {
    source: "booking",
    property_slug: "zao-kokusai",
    canonical_property_name: "蔵王国際ホテル",
    checkin: row.checkin,
    checkout: row.checkout,
    stay_scope: row.stayScope,
    preview_classification: "directional",
    append_action: "append_directional",
    price_policy: "booking_directional_visible_price_only",
    dp_usage: "directional",
    price_pressure_usable: true,
    direct_pricing_usable: false,
    basis_confidence: "B",
    basis_note: row.basisNote,
    normalized_total_price: row.normalizedTotalPrice,
    source_primary_price: row.sourcePrimaryPrice,
    official_tax_fee_adder_numeric: null,
    computed_total_with_tax_fee: null,
    screenshot_path: "screenshot.png",
    debug_path: "debug",
    row_id: row.rowId,
    row_hash: row.rowHash,
    shard_month: row.shardMonth,
    existing_row_hash: "",
    manual_review_reasons: [],
    reason: "ok",
    proposed_history_row: row,
    ...overrides
  };
}

function inventory(overrides: Partial<HistoryInventory> = {}): HistoryInventory {
  return {
    total_rows: 210,
    booking_rows: 46,
    jalan_rows: 38,
    rakuten_rows: 126,
    duplicate_row_id_count: 0,
    empty_row_hash_count: 0,
    shard_month_mismatch_count: 0,
    rows_by_shard: { "2026_06": 87, "2026_08": 27 },
    source_files: [".data/history/zao_signals_2026_06.csv"],
    ...overrides
  };
}

describe("AUTO-RUNNER08Z - gate and row selection", () => {
  it("1. no-env run fails closed", () => {
    expect(evaluateGate({ approvalSentencePresent: true, envFlag: undefined }).allowed).toBe(false);
    expect(
      decideBeforeWrite({
        gateAllowed: false,
        selection: selectApprovedRows([reviewRow()]),
        preflight: computeAppendPreflight([historyRow()], [], 210),
        expectedApprovedRows: 1
      })
    ).toBe("booking_preview_history_append_ready_not_run");
  });

  it("2. env gate required", () => {
    expect(evaluateGate({ approvalSentencePresent: true, envFlag: "1" }).allowed).toBe(true);
    expect(evaluateGate({ approvalSentencePresent: false, envFlag: "1" }).allowed).toBe(false);
  });

  it("3. approved rows count = 9", () => {
    const rows = Array.from({ length: 9 }, (_, i) => reviewRow({ row_id: `id-${i}`, proposed_history_row: historyRow({ rowId: `id-${i}` }) }));
    expect(selectApprovedRows(rows).approved_rows).toHaveLength(9);
  });

  it("4. rejects non-append_directional rows", () => {
    const selected = selectApprovedRows([reviewRow({ append_action: "manual_review" })]);
    expect(selected.approved_rows).toHaveLength(0);
    expect(selected.validation_errors[0]).toContain("append_action_not_append_directional");
  });

  it("5. rejects direct Booking rows", () => {
    const direct = historyRow({ isPriceUsableForDpDirect: true });
    const selected = selectApprovedRows([reviewRow({ direct_pricing_usable: true as false, proposed_history_row: direct })]);
    expect(selected.validation_errors.join("\n")).toContain("direct_pricing_detected");
  });

  it("6. rejects source != booking", () => {
    const bad = historyRow({ source: "jalan" });
    const selected = selectApprovedRows([reviewRow({ source: "jalan", proposed_history_row: bad })]);
    expect(selected.validation_errors.join("\n")).toContain("source_not_booking");
  });

  it("7. rejects conflicts", () => {
    const row = historyRow();
    const existing: ExistingHistoryKey[] = [{ row_id: row.rowId, row_hash: "different", shard_month: row.shardMonth }];
    const preflight = computeAppendPreflight([row], existing, 210);
    expect(preflight.conflict_count).toBe(1);
    expect(decideBeforeWrite({ gateAllowed: true, selection: selectApprovedRows([reviewRow()]), preflight, expectedApprovedRows: 1 })).toBe(
      "booking_preview_history_append_not_ready"
    );
  });

  it("8. uses canonical row_id / row_hash", () => {
    expect(validateCanonicalIdentity(historyRow())).toEqual([]);
  });
});

describe("AUTO-RUNNER08Z - shard validation and safety", () => {
  it("9. appends only touched shards 2026_06 and 2026_08", () => {
    const june = historyRow();
    const august = historyRow({ checkin: "2026-08-10", checkout: "2026-08-11", shardMonth: "2026_08" });
    const shards = groupRowsToSourceShards([june, august]).map((s) => s.shardMonth);
    expect(shards).toEqual(["2026_06", "2026_08"]);
  });

  it("10. detects duplicate row_id", () => {
    const row = historyRow();
    const preflight = computeAppendPreflight([row], [{ row_id: row.rowId, row_hash: row.rowHash, shard_month: row.shardMonth }], 210);
    expect(preflight.skip_identical_count).toBe(1);
    expect(preflight.new_row_count).toBe(0);
  });

  it("11. does not write DB", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/INSERT INTO|UPDATE market_signal_history|DELETE FROM market_signal_history|DROP TABLE/iu);
  });

  it("12. does not sync DB", () => {
    expect(SCRIPT_SOURCE + SERVICE_SOURCE).not.toMatch(/sync:history-to-db:fresh|HISTORY_TO_DB_SYNC=1/iu);
  });

  it("13. does not refresh AI context", () => {
    expect(SCRIPT_SOURCE + SERVICE_SOURCE).not.toMatch(/build:ai-context-packs|BUILD_AI_CONTEXT=1/iu);
  });

  it("14. does not run live collection", () => {
    expect(SCRIPT_SOURCE + SERVICE_SOURCE).not.toMatch(/COLLECT_BOOKING=1|chromium\.launch|page\.goto|auto-runner:booking-preview/iu);
  });

  it("15. does not generate pricing/PMS output", () => {
    expect(SCRIPT_SOURCE + SERVICE_SOURCE).not.toMatch(/GENERATE_PRICE_CSV=1|Beds24 CSV|AirHost CSV|PMS upload/iu);
  });

  it("16. report includes DB/context intentionally stale", () => {
    const report = renderReport({
      generatedAtJst: "2026-06-06T13:30:00+09:00",
      runId: "run",
      decision: "booking_preview_history_append_success",
      gate: evaluateGate({ approvalSentencePresent: true, envFlag: "1" }),
      sourceProposalPath: "proposal.json",
      preflight: computeAppendPreflight([historyRow()], [], 210),
      selection: selectApprovedRows([reviewRow()]),
      before: inventory(),
      after: inventory({ total_rows: 211, booking_rows: 47 }),
      rowsWritten: 1,
      filesUpdated: 1,
      backupsCreated: 1,
      rollbackPerformed: false,
      postValidation: null,
      dbRowsBefore: 210,
      dbRowsAfter: 210,
      aiContextRowsBefore: 210,
      aiContextRowsAfter: 210,
      reportPath: "r.md",
      jsonPath: "r.json",
      csvPath: "r.csv",
      debugPath: "debug"
    });
    expect(report).toContain("intentionally remain stale");
  });

  it("17. JSON includes required top-level keys via safety/report primitives", () => {
    expect(buildSafetyConfirmation({ appended: true, envFlagSet: true, approvalSentencePresent: true })).toMatchObject({
      history_appended: true,
      db_synced: false,
      ai_context_refreshed: false,
      pricing_csv_generated: false
    });
    expect(renderAppendActionCsv([historyRow()])).toContain("row_id");
  });

  it("18. decision ready_not_run / success / not_ready", () => {
    const selection = selectApprovedRows([reviewRow()]);
    const preflight = computeAppendPreflight([historyRow()], [], 210);
    expect(decideBeforeWrite({ gateAllowed: false, selection, preflight, expectedApprovedRows: 1 })).toBe(
      "booking_preview_history_append_ready_not_run"
    );
    expect(decideBeforeWrite({ gateAllowed: true, selection, preflight, expectedApprovedRows: 1 })).toBe(
      "booking_preview_history_append_success"
    );
    expect(decideBeforeWrite({ gateAllowed: true, selection, preflight, expectedApprovedRows: 9 })).toBe(
      "booking_preview_history_append_not_ready"
    );
    expect(PACKAGE_JSON).toContain("real-run:booking-preview-history-append");
  });

  it("validates post-append inventory invariants", () => {
    const row = historyRow();
    const result = validateAfterAppend({
      before: inventory(),
      after: inventory({ total_rows: 211, booking_rows: 47 }),
      approvedRows: [row],
      expectedTouchedShards: ["2026_06"]
    });
    expect(result.ok).toBe(true);
    expect(result.new_rows_directional).toBe(1);
    expect(result.new_rows_direct).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProposedHistoryRow,
  buildReviewRows,
  buildSafetyConfirmation,
  buildTouchedShardPlan,
  decideBookingPreviewAppendProposal,
  isDirectionalAppendable,
  manualReviewReasons,
  renderProposalCsv,
  renderReport,
  summarizeAppendActions,
  type CurrentHistorySummary,
  type ExistingHistoryKey
} from "../src/services/bookingPreviewAppendProposal";
import {
  buildRowHash,
  buildRowId,
  shardMonthFromCheckin
} from "../src/services/localHistorySchemaDesign";
import { type PreviewRow } from "../src/services/autoRunnerBookingPreview";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/bookingPreviewAppendProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildBookingPreviewAppendProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function previewRow(overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    source: "booking",
    property_slug: "zao-kokusai",
    canonical_property_name: "蔵王国際ホテル",
    checkin: "2026-06-13",
    checkout: "2026-06-14",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available_price_basis",
    primary_price_numeric: 30155,
    official_tax_fee_adder_numeric: null,
    computed_total_with_tax_fee: null,
    basis_confidence: "directional_candidate_basis",
    dp_usage: "directional_only",
    classification: "directional",
    screenshot_path: "/tmp/shot.png",
    debug_path: "/tmp/debug",
    warning_flags: [],
    collected_at_jst: "2026-06-06T13:01:49+09:00",
    source_phase: "AUTO-RUNNER08X",
    ...overrides
  };
}

function historySummary(overrides: Partial<CurrentHistorySummary> = {}): CurrentHistorySummary {
  return {
    total_rows: 210,
    booking_rows: 46,
    jalan_rows: 38,
    rakuten_rows: 126,
    duplicate_row_id_count: 0,
    rows_by_shard: { "2026_06": 87 },
    source_files: [".data/history/zao_signals_2026_06.csv"],
    ...overrides
  };
}

describe("AUTO-RUNNER08Y - preview review gates", () => {
  it("1. reads Booking preview rows", () => {
    const row = previewRow();
    expect(row.source).toBe("booking");
    expect(row.property_slug).toBe("zao-kokusai");
  });

  it("2. rejects non-Booking rows", () => {
    const row = previewRow({ source: "jalan" as PreviewRow["source"] });
    expect(manualReviewReasons(row)).toContain("source_not_booking");
    const [out] = buildReviewRows({ previewRows: [row], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    expect(out!.append_action).toBe("manual_review");
  });

  it("3. Booking rows can never be direct", () => {
    const [out] = buildReviewRows({ previewRows: [previewRow()], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    expect(out!.direct_pricing_usable).toBe(false);
    expect(out!.proposed_history_row.isPriceUsableForDpDirect).toBe(false);
  });

  it("4. directional rows require visible price", () => {
    const row = previewRow({ primary_price_numeric: null });
    expect(isDirectionalAppendable(row)).toBe(false);
    expect(manualReviewReasons(row)).toContain("directional_missing_price");
  });

  it("5. missing screenshot routes to manual_review", () => {
    const row = previewRow({ screenshot_path: "" });
    const [out] = buildReviewRows({ previewRows: [row], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    expect(out!.append_action).toBe("manual_review");
    expect(out!.manual_review_reasons).toContain("missing_screenshot");
  });

  it("6. missing debug routes to manual_review", () => {
    const row = previewRow({ debug_path: "" });
    const [out] = buildReviewRows({ previewRows: [row], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    expect(out!.append_action).toBe("manual_review");
    expect(out!.manual_review_reasons).toContain("missing_debug");
  });

  it("7. synthetic tax multiplier is forbidden", () => {
    const executableSources = SERVICE_SOURCE + SCRIPT_SOURCE;
    expect(executableSources).not.toMatch(/primary_price_numeric\s*\*\s*1\.1|sourcePrimaryPrice\s*\*\s*1\.1|0\.1\s*\*\s*sourcePrimaryPrice/u);
  });

  it("8. official_tax_fee_adder null does not block directional proposal", () => {
    expect(isDirectionalAppendable(previewRow({ official_tax_fee_adder_numeric: null }))).toBe(true);
  });

  it("9. computed_total_with_tax_fee null does not block directional proposal", () => {
    expect(isDirectionalAppendable(previewRow({ computed_total_with_tax_fee: null }))).toBe(true);
  });
});

describe("AUTO-RUNNER08Y - identity and conflicts", () => {
  it("10. builds canonical row_id / row_hash", () => {
    const row = previewRow();
    const history = buildProposedHistoryRow({ row, sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    const expectedId = buildRowId({
      collectedDateJst: row.collected_at_jst.slice(0, 10),
      source: "booking",
      canonicalPropertyName: row.canonical_property_name,
      sourceSlugOrCode: row.property_slug,
      sourcePropertyId: row.property_slug,
      checkin: row.checkin,
      checkout: row.checkout,
      stayScope: row.stay_scope
    });
    const expectedHash = buildRowHash({
      source: "booking",
      sourcePhase: row.source_phase,
      collectorStage: "booking_preview_gated_live",
      canonicalPropertyName: row.canonical_property_name,
      sourceSlugOrCode: row.property_slug,
      sourcePropertyId: row.property_slug,
      checkin: row.checkin,
      checkout: row.checkout,
      stayScope: row.stay_scope,
      collectedDateJst: row.collected_at_jst.slice(0, 10),
      availabilityStatus: row.availability_status,
      soldOutStatus: "not_sold_out",
      normalizedTotalPrice: row.primary_price_numeric,
      basisConfidence: "B",
      sourceClassification: "booking_directional_visible_price_only",
      isPriceUsableForDpDirect: false,
      isPriceUsableForDpDirectional: true,
      isPriceExcludedFromDp: false
    });
    expect(history.rowId).toBe(expectedId);
    expect(history.rowHash).toBe(expectedHash);
    expect(history.shardMonth).toBe(shardMonthFromCheckin(row.checkin));
  });

  it("11. detects skip_identical", () => {
    const row = previewRow();
    const history = buildProposedHistoryRow({ row, sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    const existing: ExistingHistoryKey[] = [{ row_id: history.rowId, row_hash: history.rowHash, shard_month: history.shardMonth }];
    const [out] = buildReviewRows({ previewRows: [row], existingKeys: existing, sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    expect(out!.append_action).toBe("skip_identical");
  });

  it("12. detects block_conflict", () => {
    const row = previewRow();
    const history = buildProposedHistoryRow({ row, sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    const existing: ExistingHistoryKey[] = [{ row_id: history.rowId, row_hash: "different", shard_month: history.shardMonth }];
    const [out] = buildReviewRows({ previewRows: [row], existingKeys: existing, sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    expect(out!.append_action).toBe("block_conflict");
  });

  it("13. proposes append_directional for valid B-confidence rows", () => {
    const [out] = buildReviewRows({ previewRows: [previewRow()], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    expect(out!.append_action).toBe("append_directional");
    expect(out!.basis_confidence).toBe("B");
    expect(out!.price_policy).toBe("booking_directional_visible_price_only");
  });
});

describe("AUTO-RUNNER08Y - safety and outputs", () => {
  it("14. does not write .data/history", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history|appendFileSync|createWriteStream\([^)]*history/u);
  });

  it("15. does not write DB", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/better-sqlite3|sqlite|INSERT INTO|UPDATE market|DELETE FROM/iu);
  });

  it("16. does not run live collection", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/COLLECT_BOOKING=1|chromium\.launch|page\.goto|auto-runner:booking-preview/iu);
  });

  it("17. does not run sync/context/pricing", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/sync:history-to-db:fresh|build:ai-context-packs|GENERATE_PRICE_CSV=1|pricing csv/iu);
  });

  it("18. JSON includes required top-level keys", () => {
    const rows = buildReviewRows({ previewRows: [previewRow()], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    const summary = summarizeAppendActions([previewRow()], rows, historySummary());
    expect(summary).toMatchObject({
      total_preview_rows: 1,
      append_directional: 1,
      direct_rows: 0,
      conflicts: 0
    });
    expect(buildTouchedShardPlan(rows, historySummary())[0]!.future_shard_path).toContain(".data/history/");
  });

  it("19. report includes basis caution", () => {
    const rows = buildReviewRows({ previewRows: [previewRow()], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    const summary = summarizeAppendActions([previewRow()], rows, historySummary());
    const report = renderReport({
      generatedAtJst: "2026-06-06T13:30:00+09:00",
      decision: "booking_preview_append_proposal_basis_caution",
      sourcePreviewArtifact: "preview.json",
      historySummary: historySummary(),
      appendSummary: summary,
      touchedShards: buildTouchedShardPlan(rows, historySummary()),
      reviewRows: rows,
      safetyConfirmation: buildSafetyConfirmation(),
      reportPath: "r.md",
      jsonPath: "r.json",
      csvPath: "r.csv",
      debugPath: "debug"
    });
    expect(report).toContain("Price Basis Caution");
    expect(report).toContain("not all-in official total");
  });

  it("20. safety confirmation is present", () => {
    expect(buildSafetyConfirmation()).toMatchObject({
      history_appended: false,
      db_synced: false,
      ai_context_refreshed: false,
      pricing_csv_generated: false,
      synthetic_tax_multiplier: false
    });
    expect(renderProposalCsv(buildReviewRows({ previewRows: [previewRow()], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" }))).toContain("append_action");
    expect(PACKAGE_JSON).toContain("proposal:booking-preview-append");
  });

  it("decides basis_caution for clean visible-price directional proposals", () => {
    const rows = buildReviewRows({ previewRows: [previewRow()], existingKeys: [], sourceReportPath: "r.md", sourceCsvPath: "r.csv" });
    const summary = summarizeAppendActions([previewRow()], rows, historySummary());
    expect(decideBookingPreviewAppendProposal({ sourceLoaded: true, historyParsed: true, summary })).toBe(
      "booking_preview_append_proposal_basis_caution"
    );
  });
});

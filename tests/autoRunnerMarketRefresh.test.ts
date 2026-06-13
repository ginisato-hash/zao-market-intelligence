import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOKING_PRICE_SANITY_FLOOR_JPY,
  MAX_BOOKING_PAGES,
  MAX_JALAN_PAGES,
  MAX_TOTAL_LIVE_PAGES,
  VERIFIED_JALAN_TARGETS,
  appendHistoryRowsAtomic,
  buildAppendPlan,
  buildBookingPlan,
  buildBookingSourceLevelCheck,
  buildJalanMatrixFromPlannerTargets,
  buildJalanSourceLevelCheck,
  buildSourceBlockReport,
  buildJalanTargetMatrix,
  buildPlannerDrivenBookingPlan,
  buildPlannerDrivenJalanMatrix,
  buildSafetyConfirmation,
  decideMarketRefresh,
  evaluateMarketRefreshGates,
  jalanLiveUniverseTargets,
  renderMarketRefreshCsv,
  selectMarketRefreshDates,
  totalPageCapRespected,
  type ExistingHistoryKey
} from "../src/services/autoRunnerMarketRefresh";
import { liveJalanTargets } from "../src/services/marketRefreshTargetUniverse";
import { VERIFIED_BOOKING_TARGETS } from "../src/services/autoRunnerBookingPreview";
import { renderHistoryCsv, type HistoryRow } from "../src/services/localHistorySchemaDesign";
import type { PreviewRow } from "../src/services/autoRunnerBookingPreview";
import type { JalanImprovedPreviewRow } from "../src/services/jalanBoundedCollectionProbeImproved";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerMarketRefresh.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerMarketRefresh.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

describe("AUTO-RUNNER10X - gates and caps", () => {
  it("1. Default no-env run is ready_not_run", () => {
    const gates = evaluateMarketRefreshGates({});
    expect(gates.live_mode_authorized).toBe(false);
    expect(decideMarketRefresh({
      liveMode: false,
      preflightOk: true,
      appendConflict: false,
      appendAttempted: false,
      appendSucceeded: false,
      dbSyncSucceeded: false,
      contextSucceeded: false,
      postCountsAligned: true,
      sourceCaution: false
    })).toBe("auto_runner_market_refresh_ready_not_run");
  });

  it("2. All live/write gates are required", () => {
    expect(evaluateMarketRefreshGates({ ZMI_AUTORUN_ENABLED: "1", COLLECT_BOOKING: "1" }).live_mode_authorized).toBe(false);
    expect(evaluateMarketRefreshGates({
      ZMI_AUTORUN_ENABLED: "1",
      COLLECT_BOOKING: "1",
      COLLECT_JALAN: "1",
      ALLOW_HISTORY_APPEND: "1",
      HISTORY_TO_DB_SYNC: "1",
      BUILD_AI_CONTEXT: "1"
    }).live_mode_authorized).toBe(true);
  });

  it("3. Booking cap enforced", () => {
    const plan = buildBookingPlan("2026-06-06");
    expect(plan.selected_targets.length).toBeLessThanOrEqual(MAX_BOOKING_PAGES);
    expect(plan.selected_targets.every((target) => target.source === "booking")).toBe(true);
  });

  it("4. Jalan cap enforced", () => {
    const targets = buildJalanTargetMatrix("2026-06-06");
    expect(targets.length).toBeLessThanOrEqual(MAX_JALAN_PAGES);
    expect(new Set(targets.map((target) => target.jalan_yad_id)).size).toBeLessThanOrEqual(5);
  });

  it("5. Combined page cap enforced", () => {
    expect(totalPageCapRespected({ bookingPages: MAX_BOOKING_PAGES, jalanPages: MAX_JALAN_PAGES })).toBe(true);
    expect(MAX_BOOKING_PAGES + MAX_JALAN_PAGES).toBeLessThanOrEqual(MAX_TOTAL_LIVE_PAGES);
  });

  it("6. Deterministic dates are small", () => {
    expect(selectMarketRefreshDates("2026-06-06")).toHaveLength(3);
  });
});

describe("AUTO-RUNNER10X - row policy", () => {
  it("7. Booking rows cannot be direct", () => {
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [] }));
    expect(plan.approved_rows[0]?.isPriceUsableForDpDirect).toBe(false);
  });

  it("8. Jalan direct rows are not expanded", () => {
    const plan = buildAppendPlan(basePlan({ bookingRows: [], jalanRows: [jalanRow({ dp_usage: "direct", is_price_usable_for_dp_direct: true })] }));
    expect(plan.approved_rows).toHaveLength(0);
    expect(plan.rejected_rows.map((row) => row.reason).join(";")).toContain("direct_rows_proposed");
  });

  it("9. Directional rows require price and screenshot/debug", () => {
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow({ primary_price_numeric: null })], jalanRows: [] }));
    expect(plan.approved_rows).toHaveLength(0);
    expect(plan.rejected_rows[0]?.reason).toContain("directional_missing_price");
  });

  it("10. Excluded audit rows are not price-pressure usable", () => {
    const plan = buildAppendPlan(basePlan({ bookingRows: [], jalanRows: [jalanRow({ dp_usage: "excluded", is_price_usable_for_dp_directional: true })] }));
    expect(plan.approved_rows).toHaveLength(0);
    expect(plan.rejected_rows[0]?.reason).toBe("excluded_price_pressure_true");
  });

  it("11. Conflict blocks append", () => {
    const row = bookingRow();
    const first = buildAppendPlan(basePlan({ bookingRows: [row], jalanRows: [] }));
    const existing: ExistingHistoryKey[] = [{ row_id: first.approved_rows[0]!.rowId, row_hash: "different", shard_month: first.approved_rows[0]!.shardMonth }];
    const second = buildAppendPlan(basePlan({ bookingRows: [row], jalanRows: [], existingKeys: existing }));
    expect(second.conflict_rows).toHaveLength(1);
    expect(second.append_allowed).toBe(false);
  });

  it("12. Duplicate identical row_id skips identical", () => {
    const first = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [] }));
    const existing: ExistingHistoryKey[] = [{ row_id: first.approved_rows[0]!.rowId, row_hash: first.approved_rows[0]!.rowHash, shard_month: first.approved_rows[0]!.shardMonth }];
    const second = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: existing }));
    expect(second.skipped_identical_rows).toBe(1);
    expect(second.approved_rows).toHaveLength(0);
  });

  it("13. Source-level failure blocks append for that source", () => {
    const failed = buildBookingSourceLevelCheck([bookingRow({ screenshot_path: "" })]);
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], bookingCheck: failed }));
    expect(plan.approved_rows).toHaveLength(0);
  });

  it("14. One source can proceed if the other source fails safely", () => {
    const badJalan = buildJalanSourceLevelCheck([jalanRow({ screenshot_path: "" })]);
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [jalanRow()], jalanCheck: badJalan }));
    expect(plan.approved_rows.map((row) => row.source)).toEqual(["booking"]);
  });
});

describe("AUTO-RUNNER16X-C - Booking price sanity floor", () => {
  it("floor is a positive JPY constant", () => {
    expect(BOOKING_PRICE_SANITY_FLOOR_JPY).toBeGreaterThan(0);
    expect(BOOKING_PRICE_SANITY_FLOOR_JPY).toBe(3000);
  });

  it("excludes a ¥100-class hammond-takamiya directional row from append", () => {
    const row = bookingRow({ property_slug: "hammond-takamiya", canonical_property_name: "HAMMOND", primary_price_numeric: 100 });
    const plan = buildAppendPlan(basePlan({ bookingRows: [row], jalanRows: [] }));
    expect(plan.approved_rows).toHaveLength(0);
    expect(plan.price_sanity_excluded_records).toHaveLength(1);
    const rec = plan.price_sanity_excluded_records[0]!;
    expect(rec).toMatchObject({ source: "booking", property_slug: "hammond-takamiya", raw_price: 100, floor: BOOKING_PRICE_SANITY_FLOOR_JPY, reason: "excluded_price_sanity_floor" });
    expect(plan.rejected_rows.some((r) => r.reason === "excluded_price_sanity_floor")).toBe(true);
  });

  it("admits a normal price at/above the floor", () => {
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow({ primary_price_numeric: 33000 })], jalanRows: [] }));
    expect(plan.approved_rows).toHaveLength(1);
    expect(plan.price_sanity_excluded_records).toHaveLength(0);
  });

  it("excludes exactly below the floor and admits exactly at the floor", () => {
    const below = buildAppendPlan(basePlan({ bookingRows: [bookingRow({ primary_price_numeric: BOOKING_PRICE_SANITY_FLOOR_JPY - 1 })], jalanRows: [] }));
    expect(below.approved_rows).toHaveLength(0);
    expect(below.price_sanity_excluded_records).toHaveLength(1);
    const atFloor = buildAppendPlan(basePlan({ bookingRows: [bookingRow({ primary_price_numeric: BOOKING_PRICE_SANITY_FLOOR_JPY })], jalanRows: [] }));
    expect(atFloor.approved_rows).toHaveLength(1);
    expect(atFloor.price_sanity_excluded_records).toHaveLength(0);
  });

  it("does not affect sold_out / not_listed (no directional price) classifications", () => {
    // A jalan sold_out row carries no directional price; the booking floor must not touch it.
    const soldOut = jalanRow({ dp_usage: "excluded", availability_status: "sold_out", normalized_total_price: null, source_primary_price: null, is_price_usable_for_dp_directional: false });
    const plan = buildAppendPlan(basePlan({ bookingRows: [], jalanRows: [soldOut] }));
    expect(plan.price_sanity_excluded_records).toHaveLength(0);
  });

  it("only excludes the low-priced row, not other valid rows in the same run", () => {
    const plan = buildAppendPlan(basePlan({
      bookingRows: [
        bookingRow({ property_slug: "hammond-takamiya", canonical_property_name: "HAMMOND", checkin: "2026-07-18", primary_price_numeric: 100 }),
        bookingRow({ property_slug: "zao-kokusai", canonical_property_name: "蔵王国際ホテル", checkin: "2026-07-19", primary_price_numeric: 33000 })
      ],
      jalanRows: []
    }));
    expect(plan.approved_rows).toHaveLength(1);
    expect(plan.approved_rows[0]!.canonicalPropertyName).toBe("蔵王国際ホテル");
    expect(plan.price_sanity_excluded_records).toHaveLength(1);
  });
});

describe("AUTO-RUNNER16X-F - source-level check respects an expanded page cap", () => {
  it("12 booking rows pass when maxPages=12 but fail at the legacy default", () => {
    const rows = Array.from({ length: 12 }, (_, i) => bookingRow({ property_slug: `slug-${i}`, checkin: `2026-07-${String(i + 1).padStart(2, "0")}` }));
    const atDefault = buildBookingSourceLevelCheck(rows); // legacy MAX_BOOKING_PAGES (9)
    expect(atDefault.page_cap_respected).toBe(false);
    expect(atDefault.failure_reasons).toContain("page_cap_exceeded");
    const atRotating = buildBookingSourceLevelCheck(rows, 12);
    expect(atRotating.page_cap_respected).toBe(true);
    expect(atRotating.append_allowed).toBe(true);
  });

  it("12 jalan rows pass when maxPages=12", () => {
    const rows = Array.from({ length: 12 }, (_, i) => jalanRow({ source_slug_or_code: `yad${100000 + i}`, checkin: `2026-07-${String(i + 1).padStart(2, "0")}` }));
    const check = buildJalanSourceLevelCheck(rows, 12);
    expect(check.page_cap_respected).toBe(true);
    expect(check.append_allowed).toBe(true);
  });
});

describe("AUTO-RUNNER16X-E0 - real source block/captcha reporting", () => {
  const clean = { source_level_captcha_or_block: false };
  const blocked = { source_level_captcha_or_block: true };

  it("flags true when Booking source-level captcha/block is detected", () => {
    const r = buildSourceBlockReport({ bookingSourceCheck: blocked, jalanSourceCheck: clean, rejectedRows: [] });
    expect(r.source_block_or_captcha_detected).toBe(true);
    expect(r.booking_source_level_captcha_or_block).toBe(true);
    expect(r.jalan_source_level_captcha_or_block).toBe(false);
  });

  it("flags true when Jalan source-level captcha/block is detected", () => {
    const r = buildSourceBlockReport({ bookingSourceCheck: clean, jalanSourceCheck: blocked, rejectedRows: [] });
    expect(r.source_block_or_captcha_detected).toBe(true);
    expect(r.jalan_source_level_captcha_or_block).toBe(true);
  });

  it("flags true when a rejected row reason names block/captcha/login/security", () => {
    for (const reason of ["blocked_or_login_warning", "captcha_or_block_detected", "login_required", "blocked_or_captcha_warning"]) {
      const r = buildSourceBlockReport({ bookingSourceCheck: clean, jalanSourceCheck: clean, rejectedRows: [{ reason }] });
      expect(r.source_block_or_captcha_detected, reason).toBe(true);
      expect(r.blocked_or_captcha_rejected_rows_count).toBe(1);
    }
  });

  it("stays false for clean rows and non-block rejection reasons", () => {
    const r = buildSourceBlockReport({
      bookingSourceCheck: clean,
      jalanSourceCheck: clean,
      rejectedRows: [{ reason: "excluded_price_sanity_floor" }, { reason: "directional_missing_price" }, { reason: "metadata_only_diff_no_append" }]
    });
    expect(r.source_block_or_captcha_detected).toBe(false);
    expect(r.blocked_or_captcha_rejected_rows_count).toBe(0);
    expect(r.booking_source_level_captcha_or_block).toBe(false);
    expect(r.jalan_source_level_captcha_or_block).toBe(false);
  });

  it("does not mistake price-sanity exclusions for blocks", () => {
    // 'excluded_price_sanity_floor' must NOT match the block regex.
    const r = buildSourceBlockReport({ bookingSourceCheck: clean, jalanSourceCheck: clean, rejectedRows: [{ reason: "excluded_price_sanity_floor" }] });
    expect(r.source_block_or_captcha_detected).toBe(false);
  });
});

describe("AUTO-RUNNER16X-C - Jalan live universe direct resolution", () => {
  it("resolves verified Jalan targets from the live universe (>= 10, all yad ids with urls)", () => {
    const targets = jalanLiveUniverseTargets();
    expect(targets.length).toBeGreaterThanOrEqual(10);
    expect(targets.every((t) => /^yad\d+$/u.test(t.jalanYadId))).toBe(true);
    expect(targets.every((t) => t.sourceUrl.startsWith("https://www.jalan.net/"))).toBe(true);
  });

  it("matches the live universe count exactly (no legacy-list dependency)", () => {
    expect(jalanLiveUniverseTargets().length).toBe(liveJalanTargets().length);
  });

  it("includes 16X-A4-promoted yad ids that the legacy fixed list lacks", () => {
    const universeIds = new Set<string>(jalanLiveUniverseTargets().map((t) => t.jalanYadId));
    const legacyIds = new Set<string>(VERIFIED_JALAN_TARGETS.map((t) => t.jalanYadId));
    // 蔵王国際ホテル yad309590 and 深山荘 高見屋 yad321744 were promoted in 16X-A4.
    expect(universeIds.has("yad309590")).toBe(true);
    expect(universeIds.has("yad321744")).toBe(true);
    expect(legacyIds.has("yad309590")).toBe(false);
    expect(universeIds.size).toBeGreaterThan(legacyIds.size);
  });

  it("produces no duplicate yad ids", () => {
    const ids = jalanLiveUniverseTargets().map((t) => t.jalanYadId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("buildJalanMatrixFromPlannerTargets resolves a newly promoted yad id (was excluded under the legacy list)", () => {
    const matrix = buildJalanMatrixFromPlannerTargets([
      { source: "jalan", property_slug: "yad309590", canonical_property_name: "蔵王国際ホテル", stay_date: "2026-07-18" }
    ]);
    expect(matrix.excluded_missing_mapping).toHaveLength(0);
    expect(matrix.targets).toHaveLength(1);
    expect(matrix.targets[0]!.jalan_yad_id).toBe("yad309590");
  });

  it("buildJalanMatrixFromPlannerTargets still excludes an unknown / candidate-only yad id", () => {
    const matrix = buildJalanMatrixFromPlannerTargets([
      { source: "jalan", property_slug: "yad000000", canonical_property_name: "ghost", stay_date: "2026-07-18" },
      { source: "jalan", property_slug: "", canonical_property_name: "candidate only", stay_date: "2026-07-18" }
    ]);
    expect(matrix.targets).toHaveLength(0);
    expect(matrix.excluded_missing_mapping).toHaveLength(2);
  });
});

describe("AUTO-RUNNER10X - sequencing and artifacts", () => {
  it("15. DB sync only runs after append success", () => {
    expect(decideMarketRefresh({
      liveMode: true,
      preflightOk: true,
      appendConflict: false,
      appendAttempted: true,
      appendSucceeded: true,
      dbSyncSucceeded: false,
      contextSucceeded: false,
      postCountsAligned: false,
      sourceCaution: false
    })).toBe("auto_runner_market_refresh_db_sync_failed");
  });

  it("16. AI context refresh only runs after DB sync success", () => {
    expect(decideMarketRefresh({
      liveMode: true,
      preflightOk: true,
      appendConflict: false,
      appendAttempted: true,
      appendSucceeded: true,
      dbSyncSucceeded: true,
      contextSucceeded: false,
      postCountsAligned: false,
      sourceCaution: false
    })).toBe("auto_runner_market_refresh_context_failed");
  });

  it("17. JSON report has required keys", () => {
    const safety = buildSafetyConfirmation({ liveBooking: true, liveJalan: true, historyAppended: true, dbSynced: true, aiContextRefreshed: true });
    expect(Object.keys(safety)).toContain("pricing_csv_generated");
    expect(Object.keys(safety)).toContain("pms_output_generated");
  });

  it("18. Basis caution is allowed for B-confidence rows", () => {
    expect(decideMarketRefresh({
      liveMode: true,
      preflightOk: true,
      appendConflict: false,
      appendAttempted: true,
      appendSucceeded: true,
      dbSyncSucceeded: true,
      contextSucceeded: true,
      postCountsAligned: true,
      sourceCaution: true
    })).toBe("auto_runner_market_refresh_basis_caution");
  });

  it("19. Atomic append writes only approved history rows", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zmi-10x-"));
    try {
      const historyDir = join(tmp, "history");
      const backupDir = join(tmp, "backup");
      const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [] }));
      const result = appendHistoryRowsAtomic({ rows: plan.approved_rows, historyDir, backupDir, historyBefore: 0 });
      expect(result.rows_written).toBe(1);
      expect(readFileSync(join(historyDir, `zao_signals_${plan.approved_rows[0]!.shardMonth}.csv`), "utf8")).toContain(plan.approved_rows[0]!.rowId);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("20. CSV output contains append rows", () => {
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [] }));
    expect(renderMarketRefreshCsv(plan.approved_rows)).toContain("booking");
  });
});

describe("AUTO-RUNNER10X-PATCH - intraday price changes", () => {
  function bookingHistoryRow(overrides: Partial<PreviewRow> = {}): HistoryRow {
    return buildAppendPlan(basePlan({ bookingRows: [bookingRow(overrides)], jalanRows: [] })).approved_rows[0]!;
  }
  function existingFrom(row: HistoryRow, overrides: Partial<ExistingHistoryKey> = {}): ExistingHistoryKey {
    return {
      row_id: row.rowId,
      row_hash: "OLD_HASH_DIFFERENT",
      shard_month: row.shardMonth,
      normalized_total_price: row.normalizedTotalPrice,
      availability_status: row.availabilityStatus,
      basis_confidence: row.basisConfidence,
      dp_directional: row.isPriceUsableForDpDirectional,
      dp_excluded: row.isPriceExcludedFromDp,
      ...overrides
    };
  }

  it("P1. same row_id + same row_hash => skip_identical", () => {
    const h = bookingHistoryRow();
    const existing: ExistingHistoryKey[] = [{ row_id: h.rowId, row_hash: h.rowHash, shard_month: h.shardMonth }];
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: existing }));
    expect(plan.skipped_identical_rows).toBe(1);
    expect(plan.approved_rows).toHaveLength(0);
    expect(plan.intraday_rows).toHaveLength(0);
  });

  it("P2. same row_id + different row_hash + different price => intraday_price_change appended", () => {
    const h = bookingHistoryRow();
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: [existingFrom(h, { normalized_total_price: 30000 })] }));
    expect(plan.intraday_rows).toHaveLength(1);
    expect(plan.approved_rows).toHaveLength(1);
    expect(plan.conflict_rows).toHaveLength(0);
    expect(plan.append_allowed).toBe(true);
    const d = plan.intraday_rows[0]!;
    expect(d.existing_price).toBe(30000);
    expect(d.new_price).toBe(33000);
    expect(d.price_delta).toBe(3000);
    expect(d.price_delta_pct).toBe(10);
    expect(d.changed_fields).toContain("normalized_total_price");
  });

  it("P3. intraday row gets a unique row_id distinct from but traceable to base", () => {
    const h = bookingHistoryRow();
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: [existingFrom(h, { normalized_total_price: 30000 })] }));
    const appended = plan.approved_rows[0]!;
    expect(appended.rowId).not.toBe(h.rowId);
    expect(appended.rowId.startsWith(h.rowId)).toBe(true);
    expect(appended.rowId).toContain("::intraday::");
  });

  it("P4. intraday preserves base_row_id reference in detail and row basis_note", () => {
    const h = bookingHistoryRow();
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: [existingFrom(h, { normalized_total_price: 30000 })] }));
    expect(plan.intraday_rows[0]!.base_row_id).toBe(h.rowId);
    expect(plan.approved_rows[0]!.basisNote).toContain(`intraday_price_change base_row_id=${h.rowId}`);
    expect(plan.approved_rows[0]!.basisNote).toContain("price_delta=3000");
  });

  it("P5. metadata-only diff does not append", () => {
    const h = bookingHistoryRow();
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: [existingFrom(h)] }));
    expect(plan.metadata_only_diffs).toHaveLength(1);
    expect(plan.approved_rows).toHaveLength(0);
    expect(plan.rejected_rows.some((r) => r.reason === "metadata_only_diff_no_append")).toBe(true);
  });

  it("P6. basis/classification diff goes to manual_review (no append)", () => {
    const h = bookingHistoryRow();
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: [existingFrom(h, { availability_status: "sold_out_or_unavailable" })] }));
    expect(plan.basis_or_classification_diffs).toHaveLength(1);
    expect(plan.approved_rows).toHaveLength(0);
    expect(plan.rejected_rows.some((r) => r.reason === "basis_or_classification_diff_manual_review")).toBe(true);
  });

  it("P7. hard conflict (unknown existing price) blocks only that source", () => {
    const h = bookingHistoryRow();
    const existing: ExistingHistoryKey[] = [{ row_id: h.rowId, row_hash: "different", shard_month: h.shardMonth }];
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [jalanRow()], existingKeys: existing }));
    expect(plan.hard_conflicts).toHaveLength(1);
    expect(plan.approved_rows.map((r) => r.source)).toEqual(["jalan"]);
  });

  it("P8. Booking intraday rows remain directional, never direct", () => {
    const h = bookingHistoryRow();
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: [existingFrom(h, { normalized_total_price: 30000 })] }));
    const appended = plan.approved_rows[0]!;
    expect(appended.isPriceUsableForDpDirect).toBe(false);
    expect(appended.isPriceUsableForDpDirectional).toBe(true);
  });

  it("P9. Jalan intraday rows remain directional, never direct", () => {
    const jh = buildAppendPlan(basePlan({ bookingRows: [], jalanRows: [jalanRow()] })).approved_rows[0]!;
    const existing: ExistingHistoryKey[] = [{
      row_id: jh.rowId,
      row_hash: "different",
      shard_month: jh.shardMonth,
      normalized_total_price: 22000,
      availability_status: jh.availabilityStatus,
      basis_confidence: jh.basisConfidence,
      dp_directional: true,
      dp_excluded: false
    }];
    const plan = buildAppendPlan(basePlan({ bookingRows: [], jalanRows: [jalanRow()], existingKeys: existing }));
    expect(plan.intraday_rows).toHaveLength(1);
    const appended = plan.approved_rows[0]!;
    expect(appended.isPriceUsableForDpDirect).toBe(false);
    expect(appended.isPriceUsableForDpDirectional).toBe(true);
  });

  it("P10. intraday requires screenshot/debug (missing => no candidate, no intraday)", () => {
    const h = bookingHistoryRow();
    const failed = buildBookingSourceLevelCheck([bookingRow({ screenshot_path: "" })]);
    const plan = buildAppendPlan(basePlan({
      bookingRows: [bookingRow({ screenshot_path: "" })],
      jalanRows: [],
      existingKeys: [existingFrom(h, { normalized_total_price: 30000 })],
      bookingCheck: failed
    }));
    expect(plan.intraday_rows).toHaveLength(0);
    expect(plan.approved_rows).toHaveLength(0);
  });

  it("P11. intraday requires a visible price (excluded new row is not intraday)", () => {
    const h = bookingHistoryRow();
    const plan = buildAppendPlan(basePlan({
      bookingRows: [bookingRow({ classification: "excluded", primary_price_numeric: null, dp_usage: "audit_only" })],
      jalanRows: [],
      existingKeys: [existingFrom(h, { normalized_total_price: 30000 })]
    }));
    expect(plan.intraday_rows).toHaveLength(0);
    expect(plan.basis_or_classification_diffs).toHaveLength(1);
  });

  it("P12. no base*1.1 / synthetic tax multiplier in patched code", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b|normalized_total_price\s*\*\s*1/u);
  });

  it("P13. Booking hard conflict does not block safe Jalan append (source isolation)", () => {
    const h = bookingHistoryRow();
    const existing: ExistingHistoryKey[] = [{ row_id: h.rowId, row_hash: "different", shard_month: h.shardMonth }];
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [jalanRow()], existingKeys: existing }));
    expect(plan.approved_rows.map((r) => r.source)).toEqual(["jalan"]);
  });

  it("P14. Jalan hard conflict does not block safe Booking append (source isolation)", () => {
    const jh = buildAppendPlan(basePlan({ bookingRows: [], jalanRows: [jalanRow()] })).approved_rows[0]!;
    const existing: ExistingHistoryKey[] = [{ row_id: jh.rowId, row_hash: "different", shard_month: jh.shardMonth }];
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [jalanRow()], existingKeys: existing }));
    expect(plan.hard_conflicts).toHaveLength(1);
    expect(plan.approved_rows.map((r) => r.source)).toEqual(["booking"]);
  });

  it("P15. no-env mode mutates nothing (decision ready_not_run)", () => {
    expect(evaluateMarketRefreshGates({}).live_mode_authorized).toBe(false);
    expect(decideMarketRefresh({
      liveMode: false, preflightOk: true, appendConflict: false, appendAttempted: false,
      appendSucceeded: false, dbSyncSucceeded: false, contextSucceeded: false, postCountsAligned: true, sourceCaution: false
    })).toBe("auto_runner_market_refresh_ready_not_run");
  });

  it("P16. pricing/PMS output remains impossible", () => {
    const safety = buildSafetyConfirmation({ liveBooking: true, liveJalan: true, historyAppended: true, dbSynced: true, aiContextRefreshed: true });
    expect(safety.pricing_csv_generated).toBe(false);
    expect(safety.pms_output_generated).toBe(false);
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*(beds24|airhost|pricing_recommendation|price_update)/iu);
  });

  it("P17. intraday id stays unique against an existing intraday id at the same time", () => {
    const h = bookingHistoryRow();
    const collidingIntradayId = `${h.rowId}::intraday::1300`; // bookingRow collected_at 13:00
    const existing: ExistingHistoryKey[] = [
      existingFrom(h, { normalized_total_price: 30000 }),
      { row_id: collidingIntradayId, row_hash: "x", shard_month: h.shardMonth }
    ];
    const plan = buildAppendPlan(basePlan({ bookingRows: [bookingRow()], jalanRows: [], existingKeys: existing }));
    expect(plan.approved_rows[0]!.rowId).not.toBe(collidingIntradayId);
    expect(plan.approved_rows[0]!.rowId.startsWith(`${h.rowId}::intraday::1300`)).toBe(true);
  });
});

describe("AUTO-RUNNER10X - executable safety scans", () => {
  it("21. Pricing/PMS output is impossible", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/PMS_UPLOAD|OTA_UPLOAD|GENERATE_PRICE_CSV=1|writeFileSync\([^)]*(beds24|airhost|pricing_recommendation|price_update)/iu);
  });

  it("22. No Rakuten/Google source selected", () => {
    expect(SERVICE_SOURCE).not.toMatch(/source:\s*["']rakuten|source:\s*["']google|googleHotels|google-hotels/u);
  });

  it("23. No paid proxy/CAPTCHA/stealth/login code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/proxy:\s*\{|stealth:\s*true|captcha_bypass:\s*true|storageState|cookies?:\s*\[/iu);
  });

  it("24. Package contains market refresh script", () => {
    expect(PACKAGE_JSON).toContain("auto-runner:market-refresh");
  });
});

describe("AUTO-RUNNER15X-B - planner-driven target builder", () => {
  const ALL_BOOKING_SLUGS = VERIFIED_BOOKING_TARGETS.map((t) => t.slug);
  const ALL_JALAN_YADS = VERIFIED_JALAN_TARGETS.map((t) => t.jalanYadId);

  it("builds planner-driven booking plan from slugs with cap respected", () => {
    const plan = buildPlannerDrivenBookingPlan(ALL_BOOKING_SLUGS, "2026-06-08");
    expect(plan.planner_driven).toBe(true);
    expect(plan.selected_targets.length).toBeLessThanOrEqual(MAX_BOOKING_PAGES);
    expect(plan.selected_targets.every((t) => t.source === "booking")).toBe(true);
  });

  it("builds planner-driven jalan matrix from yadIds with cap respected", () => {
    const matrix = buildPlannerDrivenJalanMatrix(ALL_JALAN_YADS, "2026-06-08");
    expect(matrix.planner_driven).toBe(true);
    expect(matrix.targets.length).toBeLessThanOrEqual(MAX_JALAN_PAGES);
  });

  it("rejects unknown booking slugs from planner", () => {
    const plan = buildPlannerDrivenBookingPlan(["unknown-ghost-hotel", "zao-kokusai"], "2026-06-08");
    expect(plan.selected_targets.every((t) => (t as unknown as { slug?: string }).slug !== "unknown-ghost-hotel")).toBe(true);
  });

  it("rejects unknown jalan yadIds from planner", () => {
    const matrix = buildPlannerDrivenJalanMatrix(["yad999999", ALL_JALAN_YADS[0]!], "2026-06-08");
    expect(matrix.targets.every((t) => t.jalan_yad_id !== "yad999999")).toBe(true);
  });

  it("existing fixed behavior unchanged without PLANNER_DRIVEN_MARKET_REFRESH=1", () => {
    // buildBookingPlan and buildJalanTargetMatrix still work exactly as before.
    const fixed = buildBookingPlan("2026-06-08");
    expect(fixed.selected_targets.length).toBeLessThanOrEqual(MAX_BOOKING_PAGES);
    expect((fixed as unknown as Record<string, unknown>)["planner_driven"]).toBeUndefined();
  });

  it("Rakuten and Google remain disabled in planner-driven mode", () => {
    // The planner only produces booking/jalan; rakuten/google have cap 0.
    const matrix = buildPlannerDrivenJalanMatrix([], "2026-06-08");
    expect(matrix.targets.every((t) => (t as unknown as Record<string,unknown>)["source"] !== "rakuten")).toBe(true);
  });
});

function basePlan(input: {
  bookingRows: PreviewRow[];
  jalanRows: JalanImprovedPreviewRow[];
  existingKeys?: ExistingHistoryKey[];
  bookingCheck?: ReturnType<typeof buildBookingSourceLevelCheck>;
  jalanCheck?: ReturnType<typeof buildJalanSourceLevelCheck>;
}) {
  return {
    bookingRows: input.bookingRows,
    jalanRows: input.jalanRows,
    existingKeys: input.existingKeys ?? [],
    bookingSourceCheck: input.bookingCheck ?? buildBookingSourceLevelCheck(input.bookingRows),
    jalanSourceCheck: input.jalanCheck ?? buildJalanSourceLevelCheck(input.jalanRows),
    bookingReportPath: ".data/reports/source-discovery/booking.md",
    bookingCsvPath: ".data/reports/source-discovery/booking.csv"
  };
}

function bookingRow(overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    source: "booking",
    property_slug: "zao-kokusai",
    canonical_property_name: "蔵王国際ホテル",
    checkin: "2026-07-18",
    checkout: "2026-07-19",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available_price_basis",
    primary_price_numeric: 33000,
    official_tax_fee_adder_numeric: null,
    computed_total_with_tax_fee: null,
    basis_confidence: "directional_candidate_basis",
    dp_usage: "directional_only",
    classification: "directional",
    screenshot_path: ".data/debug/booking/s.png",
    debug_path: ".data/debug/booking",
    warning_flags: [],
    collected_at_jst: "2026-06-06T13:00:00+09:00",
    source_phase: "AUTO-RUNNER08X",
    ...overrides
  };
}

function jalanRow(overrides: Partial<JalanImprovedPreviewRow> = {}): JalanImprovedPreviewRow {
  const base = {
    run_id: "jalan_test",
    checked_at: "2026-06-06T13:00:00+09:00",
    collected_date_jst: "2026-06-06",
    collected_at_jst: "2026-06-06T13:00:00+09:00",
    normalized_at_jst: "2026-06-06T13:00:00+09:00",
    source: "jalan" as const,
    source_phase: "JALAN-AUTO03B" as const,
    collector_stage: "improved_coupon_aware_bounded_preview" as const,
    canonical_property_name: "ル・ベール蔵王",
    source_property_name: "ル・ベール蔵王",
    property_identity_match: "verified_target_url",
    source_property_id: "yad328232",
    source_slug_or_code: "yad328232",
    source_url: "https://www.jalan.net/yad328232/",
    checkin: "2026-07-18",
    checkout: "2026-07-19",
    stay_nights: 1 as const,
    group_adults: 2 as const,
    no_rooms: 1 as const,
    group_children: 0 as const,
    currency: "JPY" as const,
    language: "ja" as const,
    stay_scope: "2_adults_1_room_1_night",
    room_or_plan_name: "",
    room_name: "",
    plan_name: "",
    meal_condition: "",
    availability_status: "available" as const,
    sold_out_status: "not_sold_out_confirmed",
    normalized_total_price: 25000,
    normalized_total_price_source: "jalan_visible_total_tax_included",
    normalized_total_price_basis: "tax_included_total",
    normalized_total_price_confidence: "B" as const,
    basis_confidence: "B" as const,
    basis_note: "Visible tax-included total usable as same-property directional price-pressure evidence.",
    source_primary_price: 25000,
    source_secondary_price_or_adder: null,
    source_computed_total: 25000,
    source_tax_or_fee_classification: "tax_included_total",
    source_classification: "jalan_directional_tax_included_total",
    dp_usage: "directional" as const,
    is_price_usable_for_dp_direct: false,
    is_price_usable_for_dp_directional: true,
    is_price_excluded_from_dp: false,
    dp_exclusion_reason: "",
    hard_exclusion_reason: "",
    direct_downgrade_reason: "",
    directional_downgrade_reason: "",
    evidence_flags: {
      tax_included_total_visible: true,
      date_condition_confirmed: true,
      stay_scope_confirmed: true,
      property_identity_confirmed: true,
      screenshot_saved: true,
      selected_plan_name_visible: false,
      room_name_visible: false,
      meal_condition_visible: false,
      selected_plan_coupon_or_discount_evidence: false,
      selected_plan_member_or_point_evidence: false,
      page_chrome_coupon_or_discount_evidence: false,
      page_chrome_member_or_point_evidence: false,
      suspicious_price_evidence: false,
      price_inferred: false as const
    },
    warning_flags: "",
    error_reason: "",
    screenshot_path: ".data/debug/jalan/s.png",
    source_report_path: ".data/reports/automation/market.md",
    source_csv_path: ".data/reports/automation/market.csv",
    debug_artifact_path: ".data/debug/jalan/r.json",
    schema_version: "zao_local_history_v1" as const,
    raw_text_excerpt: "",
    raw_json: "{}"
  };
  return { ...base, ...overrides };
}

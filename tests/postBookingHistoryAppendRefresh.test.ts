import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  B07X_SUCCESS_DECISION,
  buildDataQualityNote,
  decidePostBookingHistoryAppendRefresh,
  diffSnapshots,
  isContextRefreshOk,
  isDbSyncOk,
  recommendedNextAction,
  renderPostBookingRefreshCsv,
  renderPostBookingRefreshReport,
  validateBookingRefresh,
  type BookingAppendSummary,
  type BookingContextSummary,
  type BookingDbSyncSummary,
  type BookingRowState,
  type DbStateSnapshot,
  type PostBookingRefreshReport,
  type RefreshSafetyState,
  type RefreshValidationInput,
  type TaskQuerySmokeSummary
} from "../src/services/postBookingHistoryAppendRefresh";

const SERVICE_SOURCE = readFileSync(resolve("src/services/postBookingHistoryAppendRefresh.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/runPostBookingHistoryAppendRefresh.ts"), "utf8");

const goodAppend: BookingAppendSummary = {
  decision: B07X_SUCCESS_DECISION,
  appended_row_count: 15,
  directional_appended: 14,
  excluded_appended: 1,
  direct_appended: 0,
  conflict_rows: 0
};

const goodSync: BookingDbSyncSummary = {
  canonical_decision: "history_to_db_sync_success",
  canonical_inserted_rows: 15,
  canonical_skipped_identical_rows: 145,
  canonical_conflict_rows: 0,
  canonical_post_sync_passed: true,
  canonical_all_source_row_ids_exist: true,
  canonical_all_row_hashes_match: true,
  canonical_duplicate_row_id_count: 0,
  canonical_sync_run_record_exists: true,
  canonical_market_signal_history_count: 160,
  canonical_collector_baseline_unchanged: true,
  canonical_history_mtimes_unchanged: true,
  canonical_artifact_path: ".data/reports/automation/history_to_db_sync_real_run_20260604_151812.json",
  recheck_decision: "not_rerun_existing_artifact_used",
  recheck_inserted_rows: 0,
  recheck_skipped_identical_rows: 160,
  recheck_conflict_rows: 0,
  recheck_artifact_path: "not_rerun"
};

const goodBookingRows: BookingRowState = {
  total_in_db: 21,
  directional_in_db: 19,
  excluded_in_db: 2,
  direct_in_db: 0,
  excluded_leaked_to_usable: 0
};

const goodContext: BookingContextSummary = {
  decision: "ai_context_packs_basis_caution",
  context_packs_regenerated: true,
  context_packs_are_real_files: true,
  regenerated_files: [
    ".data/ai-context/latest_market_snapshot.json",
    ".data/ai-context/latest_demand_context.json",
    ".data/ai-context/latest_property_signal_context.json",
    ".data/ai-context/latest_caveats_and_guardrails.json",
    ".data/ai-context/latest_ai_task_entrypoint.json"
  ],
  context_history_row_count: 160,
  context_booking_source_count: 21,
  context_booking_direct_count: 0
};

const goodSmoke: TaskQuerySmokeSummary = {
  bootstrap_decision: "ai_task_query_basis_caution",
  bootstrap_ok: true,
  optional_tasks: [
    { task: "market_report", decision: "ai_task_query_basis_caution", ok: true },
    { task: "pricing_support", decision: "ai_task_query_basis_caution", ok: true },
    { task: "data_quality", decision: "ai_task_query_basis_caution", ok: true }
  ]
};

const goodSafety: RefreshSafetyState = {
  collector_baseline_unchanged: true,
  history_unchanged_during_refresh: true,
  property_master_unchanged: true,
  live_collector_run: false,
  external_or_live_booking_fetch: false,
  playwright_used: false,
  history_append_during_refresh: false,
  property_master_mutation: false,
  pms_or_ota_output: false,
  price_update: false,
  booking_times_1_1: false,
  github_actions_or_gitops_or_cron: false,
  git_commit_or_push: false,
  paid_sources: false,
  started_next_phase: false
};

const goodInput: RefreshValidationInput = {
  history_unique_row_id_count: 160,
  db_history_row_count_after: 160,
  booking_append: goodAppend,
  db_sync: goodSync,
  booking_rows: goodBookingRows,
  context_refresh: goodContext,
  task_smoke: goodSmoke,
  safety: goodSafety
};

const dbBefore: DbStateSnapshot = {
  market_signal_history_rows: 145,
  market_signal_sync_runs: 4,
  sold_out_rows: 66,
  priced_rows: 134,
  source_counts: { rakuten: 126, jalan: 13, booking: 6 },
  basis_confidence_counts: { B: 134, A: 6, C: 2, insufficient: 3 },
  dp_usage_counts: { directional: 132, direct: 6, excluded: 7 }
};

const dbAfter: DbStateSnapshot = {
  market_signal_history_rows: 160,
  market_signal_sync_runs: 5,
  sold_out_rows: 66,
  priced_rows: 148,
  source_counts: { rakuten: 126, jalan: 13, booking: 21 },
  basis_confidence_counts: { B: 148, A: 6, C: 3, insufficient: 3 },
  dp_usage_counts: { directional: 146, direct: 6, excluded: 8 }
};

describe("postBookingHistoryAppendRefresh validation", () => {
  it("loads B07X artifact semantics through the append summary shape", () => {
    expect(goodAppend.decision).toBe("booking_history_append_success");
    expect(goodAppend.appended_row_count).toBe(15);
  });

  it("requires B07X decision = booking_history_append_success", () => {
    const result = validateBookingRefresh({
      ...goodInput,
      booking_append: { ...goodAppend, decision: "booking_history_append_not_ready" }
    });
    expect(result.failed_checks).toContain("b07x_append_was_success");
  });

  it("validates history row count = 160", () => {
    expect(validateBookingRefresh(goodInput).checks.history_unique_row_id_is_160).toBe(true);
  });

  it("validates dry-run mapped row count = 160 through the script pointer", () => {
    expect(SCRIPT_SOURCE).toContain("history_to_db_sync_dry_run_20260604_150909.json");
    expect(SCRIPT_SOURCE).toMatch(/mapped_row_count[\s\S]{0,80}160/);
  });

  it("validates DB sync artifact inserted = 15 / skipped = 145", () => {
    const result = validateBookingRefresh(goodInput);
    expect(result.checks.canonical_inserted_15).toBe(true);
    expect(result.checks.canonical_skipped_145).toBe(true);
  });

  it("validates DB market_signal_history = 160", () => {
    expect(validateBookingRefresh(goodInput).checks.db_row_count_is_160).toBe(true);
  });

  it("validates DB duplicate row_id count = 0", () => {
    expect(validateBookingRefresh(goodInput).checks.canonical_duplicate_row_id_zero).toBe(true);
  });

  it("validates Booking rows in DB = 21", () => {
    expect(validateBookingRefresh(goodInput).checks.booking_total_is_21).toBe(true);
  });

  it("validates 19 Booking directional rows", () => {
    expect(validateBookingRefresh(goodInput).checks.booking_directional_is_19).toBe(true);
  });

  it("validates 2 Booking excluded rows", () => {
    expect(validateBookingRefresh(goodInput).checks.booking_excluded_is_2).toBe(true);
  });

  it("validates no Booking direct rows", () => {
    expect(validateBookingRefresh(goodInput).checks.booking_no_direct).toBe(true);
  });

  it("validates AI context row count = 160", () => {
    expect(validateBookingRefresh(goodInput).checks.context_row_count_is_160).toBe(true);
  });

  it("validates Booking appears in AI context source counts", () => {
    expect(validateBookingRefresh(goodInput).checks.context_booking_source_present).toBe(true);
  });

  it("validates excluded Booking rows do not affect price pressure", () => {
    expect(validateBookingRefresh(goodInput).checks.excluded_not_in_price_pressure).toBe(true);
  });

  it("validates query smoke summary", () => {
    expect(validateBookingRefresh(goodInput).checks.bootstrap_query_succeeded).toBe(true);
  });

  it("validates .data/history is not modified", () => {
    const result = validateBookingRefresh({ ...goodInput, safety: { ...goodSafety, history_unchanged_during_refresh: false } });
    expect(result.failed_checks).toContain("history_unchanged_during_refresh");
  });

  it("decides basis_caution when all mechanics pass but context is caution", () => {
    expect(
      decidePostBookingHistoryAppendRefresh({
        db_sync_ok: true,
        context_refresh_ok: true,
        validation_ok: true,
        context_decision_is_caution: true
      })
    ).toBe("post_booking_history_append_refresh_basis_caution");
  });
});

describe("postBookingHistoryAppendRefresh reporting", () => {
  const report: PostBookingRefreshReport = {
    run_id: "post_booking_history_append_refresh_20260604_153000",
    generated_at_jst: "2026-06-04T15:30:00+09:00",
    decision: "post_booking_history_append_refresh_basis_caution",
    source_b07x_artifact: ".data/reports/automation/booking_history_append_real_run_20260604_150250.json",
    history_unique_row_id_count: 160,
    db_before: dbBefore,
    db_after: dbAfter,
    snapshot_diff: diffSnapshots(dbBefore, dbAfter),
    booking_append: goodAppend,
    db_sync: goodSync,
    booking_rows: goodBookingRows,
    context_refresh: goodContext,
    task_smoke: goodSmoke,
    validation: validateBookingRefresh(goodInput),
    data_quality_note: buildDataQualityNote(goodBookingRows, goodAppend),
    safety: goodSafety,
    commands_run: ["npm run refresh:post-booking-history-append"],
    report_path: "r.md",
    json_path: "r.json",
    csv_path: "r.csv",
    debug_artifact_path: "debug",
    next_phase: recommendedNextAction("post_booking_history_append_refresh_basis_caution")
  };

  it("renders the B07B report with Booking row validation", () => {
    const md = renderPostBookingRefreshReport(report);
    expect(md).toContain("Phase BOOKING-B07B");
    expect(md).toContain("inserted 15");
    expect(md).toContain("Booking rows in DB: 21");
    expect(md).toContain("never base × 1.1");
  });

  it("renders csv deltas for the 145 to 160 transition", () => {
    const csv = renderPostBookingRefreshCsv(report);
    expect(csv).toContain("market_signal_history_rows,145,160,15");
    expect(csv).toContain("booking_rows,6,21,15");
  });

  it("states Booking rows are directional and not automated-pricing direct", () => {
    const note = buildDataQualityNote(goodBookingRows, goodAppend);
    expect(note.statements.join(" ")).toMatch(/directional rows are usable/i);
    expect(note.statements.join(" ")).toMatch(/NOT for direct price-setting/);
  });

  it("recognizes sync and context decisions", () => {
    expect(isDbSyncOk("history_to_db_sync_success")).toBe(true);
    expect(isContextRefreshOk("ai_context_packs_basis_caution")).toBe(true);
  });
});

describe("postBookingHistoryAppendRefresh safety scans", () => {
  it("does not run a live Booking probe or collector", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/probe:booking|booking-broader|real-run:booking-history-append/i);
    expect(SCRIPT_SOURCE).not.toMatch(/execFileSync|spawnSync|fetch\s*\(|chromium\.launch|(import|require)[^;\n]*playwright/i);
  });

  it("does not modify .data/history", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(appendFileSync|renameSync|copyFileSync|symlinkSync|rmSync|unlinkSync)\s*\([^)]*history/i);
  });

  it("does not write DB or use read-write DB openings", () => {
    expect(SCRIPT_SOURCE).toMatch(/new Database\([\s\S]{0,120}?readonly:\s*true/);
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE/i);
    expect(SCRIPT_SOURCE).not.toMatch(/openLocalDatabase|executeMigration|runInTransaction/);
  });

  it("does not produce PMS/Beds24/AirHost output or Booking base times 1.1", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(writeFileSync|appendFileSync)\s*\([^)]*(Beds24|AirHost|PMS|OTA)/i);
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/base\s*[*]\s*1\.1|1\.1\s*[*]\s*base/i);
  });

  it("does not include paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/serpapi|dataforseo|apify|bright data|brightdata|oxylabs|paid proxy/i);
  });
});

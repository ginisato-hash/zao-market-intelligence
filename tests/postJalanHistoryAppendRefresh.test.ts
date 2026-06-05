import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTO05X_SUCCESS_DECISION,
  buildPricePressureNote,
  decidePostJalanHistoryAppendRefresh,
  diffSnapshots,
  isContextRefreshOk,
  isDbSyncOk,
  recommendedNextAction,
  renderPostJalanRefreshCsv,
  renderPostJalanRefreshReport,
  validateJalanRefresh,
  type DbStateSnapshot,
  type JalanAppendSummary,
  type JalanContextSummary,
  type JalanDbSyncSummary,
  type JalanRowState,
  type PostJalanRefreshReport,
  type RefreshSafetyState,
  type RefreshValidationInput,
  type TaskQuerySmokeSummary
} from "../src/services/postJalanHistoryAppendRefresh";

const SERVICE_SOURCE = readFileSync(resolve("src/services/postJalanHistoryAppendRefresh.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/runPostJalanHistoryAppendRefresh.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve("package.json"), "utf8");

const goodAppend: JalanAppendSummary = {
  decision: AUTO05X_SUCCESS_DECISION,
  appended_row_count: 25,
  directional_appended: 5,
  excluded_appended: 20,
  direct_appended: 0,
  conflict_rows: 0
};

const goodSync: JalanDbSyncSummary = {
  decision: "history_to_db_sync_success",
  inserted_rows: 25,
  skipped_identical_rows: 185,
  conflict_rows: 0,
  post_sync_passed: true,
  all_source_row_ids_exist: true,
  all_row_hashes_match: true,
  duplicate_row_id_count: 0,
  sync_run_record_exists: true,
  market_signal_history_count: 210,
  collector_baseline_unchanged: true,
  history_mtimes_unchanged: true,
  artifact_path: ".data/reports/automation/history_to_db_sync_real_run_20260605_104320.json"
};

const goodJalanRows: JalanRowState = {
  total_in_db: 38,
  directional_in_db: 8,
  excluded_in_db: 24,
  direct_in_db: 6,
  excluded_leaked_to_usable: 0
};

const goodContext: JalanContextSummary = {
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
  context_history_row_count: 210,
  context_jalan_source_count: 38,
  context_booking_source_count: 46
};

const goodSmoke: TaskQuerySmokeSummary = {
  bootstrap_decision: "ai_task_query_basis_caution",
  bootstrap_ok: true,
  optional_tasks: [
    { task: "data_quality", decision: "ai_task_query_basis_caution", ok: true },
    { task: "market_report", decision: "ai_task_query_basis_caution", ok: true },
    { task: "pricing_support", decision: "ai_task_query_basis_caution", ok: true }
  ]
};

const goodSafety: RefreshSafetyState = {
  history_modified: false,
  history_appended: false,
  db_mirror_synced: true,
  ai_context_refreshed: true,
  query_smoke_run: true,
  collector_baseline_unchanged: true,
  live_jalan_collection: false,
  browser_automation: false,
  external_fetch: false,
  pricing_csv: false,
  pms_output: false,
  price_update: false,
  base_times_1_1: false,
  paid_source_tooling: false,
  github_actions_or_cron: false,
  auto06x_started: false
};

const goodInput: RefreshValidationInput = {
  history_unique_row_id_count: 210,
  jalan_history_row_count: 38,
  booking_history_row_count: 46,
  db_history_row_count_after: 210,
  jalan_append: goodAppend,
  db_sync: goodSync,
  jalan_rows: goodJalanRows,
  context_refresh: goodContext,
  task_smoke: goodSmoke,
  dry_run_ok: true,
  safety: goodSafety
};

const dbBefore: DbStateSnapshot = {
  market_signal_history_rows: 185,
  market_signal_sync_runs: 5,
  source_counts: { rakuten: 126, jalan: 13, booking: 46 },
  dp_usage_counts: { directional: 169, direct: 6, excluded: 10 }
};

const dbAfter: DbStateSnapshot = {
  market_signal_history_rows: 210,
  market_signal_sync_runs: 6,
  source_counts: { rakuten: 126, jalan: 38, booking: 46 },
  dp_usage_counts: { directional: 174, direct: 6, excluded: 30 }
};

describe("postJalanHistoryAppendRefresh validation", () => {
  it("passes the full happy-path validation", () => {
    expect(validateJalanRefresh(goodInput).ok).toBe(true);
  });

  it("requires AUTO05X decision = jalan_history_append_success", () => {
    const result = validateJalanRefresh({
      ...goodInput,
      jalan_append: { ...goodAppend, decision: "jalan_history_append_ready_not_run" }
    });
    expect(result.failed_checks).toContain("auto05x_append_was_success");
  });

  it("validates AUTO05X appended 25 (5 directional + 20 excluded + 0 direct)", () => {
    const c = validateJalanRefresh(goodInput).checks;
    expect(c.auto05x_appended_25).toBe(true);
    expect(c.auto05x_directional_5).toBe(true);
    expect(c.auto05x_excluded_20).toBe(true);
    expect(c.auto05x_no_direct).toBe(true);
  });

  it("validates history stays at 210 / jalan 38 / booking 46", () => {
    const c = validateJalanRefresh(goodInput).checks;
    expect(c.history_unique_row_id_is_210).toBe(true);
    expect(c.history_jalan_is_38).toBe(true);
    expect(c.history_booking_is_46).toBe(true);
  });

  it("validates DB sync inserted = 25 / skipped = 185 / conflicts = 0", () => {
    const c = validateJalanRefresh(goodInput).checks;
    expect(c.db_sync_inserted_25).toBe(true);
    expect(c.db_sync_skipped_185).toBe(true);
    expect(c.db_sync_conflicts_zero).toBe(true);
  });

  it("validates DB market_signal_history = 210 and duplicate row_id = 0", () => {
    const c = validateJalanRefresh(goodInput).checks;
    expect(c.db_row_count_is_210).toBe(true);
    expect(c.duplicate_row_id_zero).toBe(true);
  });

  it("validates Jalan composition in DB (38/8/24/6)", () => {
    const c = validateJalanRefresh(goodInput).checks;
    expect(c.jalan_total_is_38).toBe(true);
    expect(c.jalan_directional_is_8).toBe(true);
    expect(c.jalan_excluded_is_24).toBe(true);
    expect(c.jalan_direct_is_6).toBe(true);
  });

  it("fails if a Jalan excluded row leaks into a usable dp_usage", () => {
    const result = validateJalanRefresh({
      ...goodInput,
      jalan_rows: { ...goodJalanRows, excluded_leaked_to_usable: 1 }
    });
    expect(result.failed_checks).toContain("jalan_excluded_not_price_pressure");
  });

  it("validates AI context reflects 210 rows / jalan 38 / booking 46", () => {
    const c = validateJalanRefresh(goodInput).checks;
    expect(c.context_row_count_is_210).toBe(true);
    expect(c.context_jalan_source_is_38).toBe(true);
    expect(c.context_booking_source_is_46).toBe(true);
  });

  it("fails when the dry-run did not map 210 with zero conflicts", () => {
    const result = validateJalanRefresh({ ...goodInput, dry_run_ok: false });
    expect(result.failed_checks).toContain("dry_run_maps_210_zero_conflicts");
  });

  it("fails if .data/history was modified during the refresh", () => {
    const result = validateJalanRefresh({ ...goodInput, safety: { ...goodSafety, history_modified: true } });
    expect(result.failed_checks).toContain("history_not_modified");
  });

  it("fails if the AUTO06X next phase was started", () => {
    const result = validateJalanRefresh({ ...goodInput, safety: { ...goodSafety, auto06x_started: true } });
    expect(result.failed_checks).toContain("did_not_start_auto06x");
  });

  it("decides basis_caution when all mechanics pass but context is caution", () => {
    expect(
      decidePostJalanHistoryAppendRefresh({
        db_sync_ok: true,
        context_refresh_ok: true,
        validation_ok: true,
        context_decision_is_caution: true
      })
    ).toBe("post_jalan_history_append_refresh_basis_caution");
  });

  it("decides not_ready when DB sync did not succeed", () => {
    expect(
      decidePostJalanHistoryAppendRefresh({
        db_sync_ok: false,
        context_refresh_ok: true,
        validation_ok: true,
        context_decision_is_caution: true
      })
    ).toBe("post_jalan_history_append_refresh_not_ready");
  });

  it("recognizes sync and context decisions", () => {
    expect(isDbSyncOk("history_to_db_sync_success")).toBe(true);
    expect(isContextRefreshOk("ai_context_packs_basis_caution")).toBe(true);
    expect(isContextRefreshOk("ai_context_packs_failed")).toBe(false);
  });
});

describe("postJalanHistoryAppendRefresh reporting", () => {
  const report: PostJalanRefreshReport = {
    run_id: "post_jalan_history_append_refresh_20260605_110000",
    generated_at_jst: "2026-06-05T11:00:00+09:00",
    decision: "post_jalan_history_append_refresh_basis_caution",
    source_auto05x_artifact: ".data/reports/automation/jalan_history_append_real_run_20260605_103629.json",
    history_unique_row_id_count: 210,
    jalan_history_row_count: 38,
    booking_history_row_count: 46,
    db_before: dbBefore,
    db_after: dbAfter,
    snapshot_diff: diffSnapshots(dbBefore, dbAfter),
    jalan_append: goodAppend,
    db_sync: goodSync,
    jalan_rows: goodJalanRows,
    context_refresh: goodContext,
    task_smoke: goodSmoke,
    validation: validateJalanRefresh(goodInput),
    price_pressure_note: buildPricePressureNote(goodJalanRows, goodAppend),
    safety: goodSafety,
    commands_run: ["npm run refresh:post-jalan-history-append"],
    report_path: "r.md",
    json_path: "r.json",
    csv_path: "r.csv",
    debug_artifact_path: "debug",
    next_phase: recommendedNextAction("post_jalan_history_append_refresh_basis_caution")
  };

  it("renders the AUTO05B report with Jalan row validation", () => {
    const md = renderPostJalanRefreshReport(report);
    expect(md).toContain("Phase JALAN-AUTO05B");
    expect(md).toContain("inserted 25");
    expect(md).toContain("Jalan rows in DB: 38");
    expect(md).toContain("Do not start JALAN-AUTO06X without explicit instruction");
  });

  it("renders csv deltas for the 185 to 210 transition", () => {
    const csv = renderPostJalanRefreshCsv(report);
    expect(csv).toContain("market_signal_history_rows,185,210,25");
    expect(csv).toContain("jalan_rows,13,38,25");
    expect(csv).toContain("booking_rows,46,46,0");
  });

  it("states Jalan directional rows are usable but not direct, and excluded stays audit-only", () => {
    const note = buildPricePressureNote(goodJalanRows, goodAppend);
    const joined = note.statements.join(" ");
    expect(joined).toMatch(/directional rows are usable/i);
    expect(joined).toMatch(/NOT for direct automatic price-setting/);
    expect(joined).toMatch(/never enter price-pressure/i);
  });

  it("recommends JALAN-AUTO06X but guards against auto-starting it", () => {
    expect(recommendedNextAction("post_jalan_history_append_refresh_success")).toMatch(/JALAN-AUTO06X/);
    expect(recommendedNextAction("post_jalan_history_append_refresh_success")).toMatch(/Do not start/);
  });
});

describe("postJalanHistoryAppendRefresh safety scans", () => {
  it("registers the refresh:post-jalan-history-append npm script", () => {
    expect(PACKAGE_JSON).toContain("refresh:post-jalan-history-append");
  });

  it("does not run a live Jalan probe, collector, or append", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/probe:jalan|real-run:jalan-history-append|proposal:jalan/i);
    expect(SCRIPT_SOURCE).not.toMatch(/execFileSync|spawnSync|fetch\s*\(|chromium\.launch|(import|require)[^;\n]*playwright/i);
  });

  it("does not modify .data/history", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(appendFileSync|renameSync|copyFileSync|symlinkSync|rmSync|unlinkSync)\s*\([^)]*history/i);
  });

  it("opens the DB read-only and never writes it", () => {
    expect(SCRIPT_SOURCE).toMatch(/new Database\([\s\S]{0,120}?readonly:\s*true/);
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE/i);
    expect(SCRIPT_SOURCE).not.toMatch(/openLocalDatabase|executeMigration|runInTransaction/);
  });

  it("produces no pricing CSV / PMS output and applies no synthetic tax multiplier", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(writeFileSync|appendFileSync)\s*\([^)]*(Beds24|AirHost|pmsCsv|pricing:recommend|pricing:approve)/);
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/base\s*[*]\s*1\.1|1\.1\s*[*]\s*base/i);
  });

  it("includes no paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/serpapi|dataforseo|apify|bright data|brightdata|oxylabs|paid proxy/i);
  });
});

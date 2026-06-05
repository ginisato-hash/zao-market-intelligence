import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDataQualityNote,
  decidePostAutoHistoryAppendRefresh,
  diffSnapshots,
  isContextRefreshOk,
  isDbSyncOk,
  recommendedNextAction,
  renderPostRefreshCsv,
  renderPostRefreshReport,
  validateRefresh,
  type ContextRefreshSummary,
  type DbStateSnapshot,
  type DbSyncSummary,
  type PostRefreshReport,
  type RefreshSafetyState,
  type RefreshValidationInput,
  type TaskQuerySmokeSummary
} from "../src/services/postAutoHistoryAppendRefresh";

const SERVICE_SOURCE = readFileSync(resolve("src/services/postAutoHistoryAppendRefresh.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/runPostAutoHistoryAppendRefresh.ts"), "utf8");

const goodSync: DbSyncSummary = {
  decision: "history_to_db_sync_success",
  inserted_rows: 116,
  skipped_identical_rows: 145,
  conflict_rows: 0,
  post_sync_passed: true,
  all_source_row_ids_exist: true,
  all_row_hashes_match: true,
  duplicate_row_id_count: 0,
  sync_run_record_exists: true,
  market_signal_history_count: 261,
  collector_baseline_unchanged: true,
  history_mtimes_unchanged: true
};

const goodContext: ContextRefreshSummary = {
  decision: "ai_context_packs_basis_caution",
  context_packs_regenerated: true,
  context_packs_are_real_files: true,
  regenerated_files: ["a", "b", "c", "d", "e"]
};

const goodSmoke: TaskQuerySmokeSummary = {
  bootstrap_decision: "ai_task_query_basis_caution",
  bootstrap_ok: true,
  optional_tasks: []
};

const goodSafety: RefreshSafetyState = {
  collector_baseline_unchanged: true,
  history_unchanged_during_refresh: true,
  property_master_unchanged: true,
  live_collector_run: false,
  external_fetch: false,
  history_append_during_refresh: false,
  property_master_mutation: false,
  pms_or_ota_output: false,
  github_actions_or_gitops_or_cron: false,
  git_commit_or_push: false,
  paid_sources: false,
  started_auto09x: false
};

const goodValidationInput: RefreshValidationInput = {
  history_unique_row_id_count: 261,
  db_history_row_count_after: 261,
  db_sync: goodSync,
  context_refresh: goodContext,
  task_smoke: goodSmoke,
  safety: goodSafety
};

const beforeSnap: DbStateSnapshot = {
  market_signal_history_rows: 145,
  market_signal_sync_runs: 2,
  sold_out_rows: 66,
  priced_rows: 134,
  availability_counts: { available: 74, sold_out: 66, unavailable_or_unknown: 5 },
  basis_confidence_counts: { A: 6, B: 134, C: 2, insufficient: 3 },
  dp_usage_counts: { direct: 6, directional: 134, excluded: 5 }
};

const afterSnap: DbStateSnapshot = {
  market_signal_history_rows: 261,
  market_signal_sync_runs: 3,
  sold_out_rows: 182,
  priced_rows: 134,
  availability_counts: { available: 74, sold_out: 182, unavailable_or_unknown: 5 },
  basis_confidence_counts: { A: 6, B: 134, C: 2, insufficient: 119 },
  dp_usage_counts: { direct: 6, directional: 134, excluded: 121 }
};

describe("decidePostAutoHistoryAppendRefresh", () => {
  it("returns success when everything passes and context is not caution", () => {
    expect(
      decidePostAutoHistoryAppendRefresh({ db_sync_ok: true, context_refresh_ok: true, validation_ok: true, context_decision_is_caution: false })
    ).toBe("post_auto_history_append_refresh_success");
  });

  it("returns basis_caution when context decision is caution", () => {
    expect(
      decidePostAutoHistoryAppendRefresh({ db_sync_ok: true, context_refresh_ok: true, validation_ok: true, context_decision_is_caution: true })
    ).toBe("post_auto_history_append_refresh_basis_caution");
  });

  it("fails db sync first", () => {
    expect(
      decidePostAutoHistoryAppendRefresh({ db_sync_ok: false, context_refresh_ok: false, validation_ok: false, context_decision_is_caution: true })
    ).toBe("post_auto_history_append_refresh_failed_db_sync");
  });

  it("fails context refresh when sync ok but context not ok", () => {
    expect(
      decidePostAutoHistoryAppendRefresh({ db_sync_ok: true, context_refresh_ok: false, validation_ok: false, context_decision_is_caution: false })
    ).toBe("post_auto_history_append_refresh_failed_context_refresh");
  });

  it("fails validation when sync+context ok but validation fails", () => {
    expect(
      decidePostAutoHistoryAppendRefresh({ db_sync_ok: true, context_refresh_ok: true, validation_ok: false, context_decision_is_caution: false })
    ).toBe("post_auto_history_append_refresh_failed_validation");
  });
});

describe("isDbSyncOk / isContextRefreshOk", () => {
  it("recognizes the sync success decision", () => {
    expect(isDbSyncOk("history_to_db_sync_success")).toBe(true);
    expect(isDbSyncOk("history_to_db_sync_ready_not_run")).toBe(false);
  });

  it("treats ready and basis_caution context decisions as ok", () => {
    expect(isContextRefreshOk("ai_context_packs_ready")).toBe(true);
    expect(isContextRefreshOk("ai_context_packs_basis_caution")).toBe(true);
    expect(isContextRefreshOk("ai_context_packs_not_ready")).toBe(false);
  });
});

describe("validateRefresh", () => {
  it("passes for a clean refresh", () => {
    const result = validateRefresh(goodValidationInput);
    expect(result.ok).toBe(true);
    expect(result.failed_checks).toEqual([]);
  });

  it("fails when DB row count does not match history unique count", () => {
    const result = validateRefresh({ ...goodValidationInput, db_history_row_count_after: 260 });
    expect(result.ok).toBe(false);
    expect(result.failed_checks).toContain("db_row_count_matches_history");
  });

  it("fails on conflicts", () => {
    const result = validateRefresh({ ...goodValidationInput, db_sync: { ...goodSync, conflict_rows: 1 } });
    expect(result.ok).toBe(false);
    expect(result.failed_checks).toContain("conflicts_zero");
  });

  it("fails when row hashes do not all match", () => {
    const result = validateRefresh({ ...goodValidationInput, db_sync: { ...goodSync, all_row_hashes_match: false } });
    expect(result.failed_checks).toContain("row_hash_equality");
  });

  it("fails when context packs were not regenerated", () => {
    const result = validateRefresh({ ...goodValidationInput, context_refresh: { ...goodContext, context_packs_regenerated: false } });
    expect(result.failed_checks).toContain("context_packs_regenerated");
  });

  it("fails when a context pack is a symlink", () => {
    const result = validateRefresh({ ...goodValidationInput, context_refresh: { ...goodContext, context_packs_are_real_files: false } });
    expect(result.failed_checks).toContain("context_packs_are_real_files");
  });

  it("fails when bootstrap query failed", () => {
    const result = validateRefresh({ ...goodValidationInput, task_smoke: { ...goodSmoke, bootstrap_ok: false } });
    expect(result.failed_checks).toContain("bootstrap_query_succeeded");
  });

  it("fails when history changed during refresh", () => {
    const result = validateRefresh({ ...goodValidationInput, safety: { ...goodSafety, history_unchanged_during_refresh: false } });
    expect(result.failed_checks).toContain("history_unchanged_during_refresh");
  });

  it("fails when the collector baseline changed", () => {
    const result = validateRefresh({ ...goodValidationInput, db_sync: { ...goodSync, collector_baseline_unchanged: false } });
    expect(result.failed_checks).toContain("collector_baseline_unchanged");
  });
});

describe("diffSnapshots", () => {
  it("computes deltas including sold-out and insufficient growth", () => {
    const diff = diffSnapshots(beforeSnap, afterSnap);
    expect(diff.market_signal_history_rows).toEqual({ before: 145, after: 261, delta: 116 });
    expect(diff.sold_out_rows.delta).toBe(116);
    expect(diff.insufficient_confidence_rows.delta).toBe(116);
    expect(diff.priced_rows.delta).toBe(0);
    expect(diff.market_signal_sync_runs.delta).toBe(1);
  });
});

describe("buildDataQualityNote", () => {
  it("states the rows are sold-out pressure, not priced/occupancy data", () => {
    const note = buildDataQualityNote(diffSnapshots(beforeSnap, afterSnap));
    expect(note.headline).toMatch(/sold-out pressure/i);
    const joined = note.statements.join(" ");
    expect(joined).toMatch(/[Nn]ot sufficient for direct price-setting/);
    expect(joined).toMatch(/not treat sold-out pressure as actual occupancy/i);
  });
});

describe("rendering", () => {
  const report: PostRefreshReport = {
    run_id: "post_auto_history_append_refresh_20260604_100000",
    generated_at_jst: "2026-06-04T10:00:00+09:00",
    decision: "post_auto_history_append_refresh_basis_caution",
    source_auto08x_artifact: ".data/reports/automation/auto_history_append_20260604_094714.json",
    history_unique_row_id_count: 261,
    db_before: beforeSnap,
    db_after: afterSnap,
    snapshot_diff: diffSnapshots(beforeSnap, afterSnap),
    db_sync: goodSync,
    context_refresh: goodContext,
    task_smoke: goodSmoke,
    validation: validateRefresh(goodValidationInput),
    data_quality_note: buildDataQualityNote(diffSnapshots(beforeSnap, afterSnap)),
    safety: goodSafety,
    commands_run: ["HISTORY_TO_DB_SYNC=1 npm run real-run:history-to-db-sync"],
    report_path: "r.md",
    json_path: "r.json",
    csv_path: "r.csv",
    debug_artifact_path: "debug",
    next_phase: "AUTO09X"
  };

  it("renders a markdown report with the key sections", () => {
    const md = renderPostRefreshReport(report);
    expect(md).toMatch(/Phase AUTO08B/);
    expect(md).toMatch(/post_auto_history_append_refresh_basis_caution/);
    expect(md).toMatch(/Data-quality note/);
    expect(md).toMatch(/145 → 261/);
  });

  it("renders a csv with metric/before/after/delta rows", () => {
    const csv = renderPostRefreshCsv(report);
    expect(csv.split("\n")[0]).toBe("metric,before,after,delta");
    expect(csv).toMatch(/market_signal_history_rows,145,261,116/);
    expect(csv).toMatch(/sold_out_rows,66,182,116/);
  });

  it("recommends AUTO09X (gated) on success/caution", () => {
    expect(recommendedNextAction("post_auto_history_append_refresh_success")).toMatch(/AUTO09X/);
    expect(recommendedNextAction("post_auto_history_append_refresh_basis_caution")).toMatch(/AUTO09X/);
    expect(recommendedNextAction("post_auto_history_append_refresh_failed_db_sync")).not.toMatch(/AUTO09X/);
  });
});

describe("behavioral safety scans", () => {
  it("never imports paid sources / proxies in the service or script", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(
      /(import|require)[^;\n]*(serpapi|dataforseo|apify|brightdata|oxylabs|proxy)/i
    );
  });

  it("never runs a collector, appends history, or opens a browser", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(import|require)[^;\n]*playwright|chromium\.launch/i);
    // No write/append into .data/history from this phase.
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(
      /(appendFileSync|renameSync|copyFileSync|symlinkSync)\s*\([^)]*history/i
    );
  });

  it("opens its own DB connections read-only", () => {
    expect(SCRIPT_SOURCE).toMatch(/new Database\([\s\S]{0,80}?readonly:\s*true/);
    expect(SCRIPT_SOURCE).not.toMatch(/new Database\([\s\S]{0,80}?readonly:\s*false/);
  });

  it("does not write to the property master or produce OTA/PMS output", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(
      /(writeFileSync|appendFileSync)\s*\([^)]*(zao_universe_properties|beds24|airhost|pms)/i
    );
  });
});

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildImprovedPreviewRow,
  buildJalanProbeTarget,
  type JalanImprovedExtractionCandidate,
  type JalanImprovedPreviewRow,
  type JalanProbeTarget
} from "../src/services/jalanBoundedCollectionProbeImproved";
import {
  buildProposalRows,
  type JalanAppendProposalRow
} from "../src/services/jalanHistoryAppendProposal";
import {
  AUTO05X_APPROVAL_SENTENCE,
  AUTO05X_ENV_FLAG,
  computeAppendPreflight,
  decideBeforeWrite,
  evaluateGate,
  groupRowsToSourceShards,
  reconstructHistoryRow,
  renderAppendActionCsv,
  renderReport,
  selectApprovedRowIds,
  validateApprovedHistoryRows,
  type ApprovedRowRecord,
  type ExistingHistoryKey
} from "../src/services/jalanHistoryAppendRealRun";
import {
  renderHistoryCsv,
  type HistoryRow
} from "../src/services/localHistorySchemaDesign";
import { runRealAppend, validatePostWriteShards } from "../src/services/localHistoryRealAppend";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/jalanHistoryAppendRealRun.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runJalanHistoryAppendRealRun.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const CTX = { sourceReportPath: "auto03b.md", sourceCsvPath: "auto03b.csv" };

// ---------------------------------------------------------------------------
// Fixtures — genuine AUTO03B preview rows via the AUTO03B builder, classified
// into AUTO04X proposal rows via the real AUTO04X proposal logic.
// ---------------------------------------------------------------------------

function target(checkin: string, yad: string): JalanProbeTarget {
  return buildJalanProbeTarget({
    canonicalPropertyName: "ル・ベール蔵王",
    facilityTier: "tier_1",
    jalanYadId: yad,
    sourceUrl: `https://www.jalan.net/${yad}/`,
    checkin
  });
}

function candidate(overrides: Partial<JalanImprovedExtractionCandidate> = {}): JalanImprovedExtractionCandidate {
  return {
    facility_name: "ル・ベール蔵王",
    room_or_plan_name: "【素泊まり】ツイン 蔵王満喫プラン",
    room_name: "禁煙ツインルーム",
    plan_name: "【素泊まり】ツイン 蔵王満喫プラン",
    meal_condition: "素泊まり",
    availability_status: "available",
    price_total_tax_included: 25000,
    price_per_person: null,
    price_basis_text: "合計(税込) 25,000円",
    tax_included_evidence: true,
    stay_scope_evidence: true,
    date_condition_evidence: true,
    property_identity_confirmed: true,
    screenshot_path: "/tmp/shot.png",
    source_url: "https://www.jalan.net/yad328232/plan/",
    selected_block_text: "【素泊まり】ツイン 蔵王満喫プラン 合計(税込) 25,000円 素泊まり",
    page_text_excerpt: "ル・ベール蔵王 【素泊まり】ツイン 蔵王満喫プラン 合計(税込) 25,000円",
    error_reason: null,
    extraction_confidence: "high",
    ...overrides
  };
}

function previewRow(c: JalanImprovedExtractionCandidate, checkin: string, yad: string): JalanImprovedPreviewRow {
  return buildImprovedPreviewRow({
    runId: "run",
    checkedAt: "2026-06-05T00:29:41+09:00",
    target: target(checkin, yad),
    candidate: c,
    reportPath: "report.md",
    csvPath: "rows.csv",
    debugPath: "debug.json"
  });
}

function directionalRow(checkin = "2026-07-18", yad = "yad328232"): JalanImprovedPreviewRow {
  return previewRow(candidate({ extraction_confidence: "medium" }), checkin, yad);
}

function soldOutRow(checkin = "2026-06-06", yad = "yad327282"): JalanImprovedPreviewRow {
  return previewRow(
    candidate({ availability_status: "sold_out", price_total_tax_included: null, error_reason: "sold_out" }),
    checkin,
    yad
  );
}

// Build the {historyRow, proposal, preview} records the engine validates.
function buildRecords(previews: JalanImprovedPreviewRow[]): {
  records: ApprovedRowRecord[];
  proposals: JalanAppendProposalRow[];
  historyRows: HistoryRow[];
} {
  const proposals = buildProposalRows(previews, []);
  const proposalByRowId = new Map(proposals.map((p) => [p.row_id, p] as const));
  const records: ApprovedRowRecord[] = [];
  const historyRows: HistoryRow[] = [];
  for (const preview of previews) {
    const historyRow = reconstructHistoryRow(preview, CTX);
    const proposal = proposalByRowId.get(historyRow.rowId);
    if (!proposal || !selectApprovedRowIds([proposal]).approvedRowIds.length) continue;
    records.push({ historyRow, proposal, preview });
    historyRows.push(historyRow);
  }
  return { records, proposals, historyRows };
}

// ---------------------------------------------------------------------------
// 1. Approval gate (§8) — fail-closed unless approval sentence + env flag
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - approval gate", () => {
  it("fails closed when the approval sentence is absent (even with the env flag)", () => {
    const gate = evaluateGate({ approvalSentencePresent: false, envFlag: "1" });
    expect(gate.allowed).toBe(false);
    expect(gate.failedConditions).toContain("approval_sentence_absent");
  });

  it("fails closed when the env flag is missing (even with the approval sentence)", () => {
    const gate = evaluateGate({ approvalSentencePresent: true, envFlag: undefined });
    expect(gate.allowed).toBe(false);
    expect(gate.failedConditions).toContain(`${AUTO05X_ENV_FLAG}!=1`);
  });

  it("fails closed when the env flag is set to something other than 1", () => {
    expect(evaluateGate({ approvalSentencePresent: true, envFlag: "0" }).allowed).toBe(false);
    expect(evaluateGate({ approvalSentencePresent: true, envFlag: "true" }).allowed).toBe(false);
  });

  it("allows only when both gates pass", () => {
    const gate = evaluateGate({ approvalSentencePresent: true, envFlag: "1" });
    expect(gate.allowed).toBe(true);
    expect(gate.failedConditions).toEqual([]);
    expect(gate.envFlagPresent).toBe(true);
  });

  it("exposes the exact approval sentence the spec requires", () => {
    expect(AUTO05X_APPROVAL_SENTENCE).toBe(
      "Approve Phase JALAN-AUTO05X append approved Jalan AUTO03B rows. You may append the approved Jalan rows to .data/history."
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Row selection (§9) — only append_directional / append_excluded_audit
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - row selection", () => {
  it("selects only approved history actions and blocks the rest", () => {
    const directional: JalanAppendProposalRow = buildProposalRows([directionalRow()], [])[0]!;
    const excluded: JalanAppendProposalRow = buildProposalRows([soldOutRow()], [])[0]!;
    const skip: JalanAppendProposalRow = { ...directional, row_id: "skip-id", history_action: "skip_identical" };
    const conflict: JalanAppendProposalRow = { ...directional, row_id: "conflict-id", history_action: "block_conflict" };
    const review: JalanAppendProposalRow = { ...directional, row_id: "review-id", history_action: "manual_review" };

    const { approvedRowIds, blockedRowIds } = selectApprovedRowIds([directional, excluded, skip, conflict, review]);
    expect(approvedRowIds).toContain(directional.row_id);
    expect(approvedRowIds).toContain(excluded.row_id);
    expect(approvedRowIds).toHaveLength(2);
    expect(blockedRowIds).toEqual(["skip-id", "conflict-id", "review-id"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Reconstruction — full 45-col history row whose hash re-derives
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - reconstruction", () => {
  it("reconstructs a directional history row matching the AUTO04X proposal identity", () => {
    const preview = directionalRow();
    const proposal = buildProposalRows([preview], [])[0]!;
    const row = reconstructHistoryRow(preview, CTX);
    expect(row.source).toBe("jalan");
    expect(row.rowId).toBe(proposal.row_id);
    expect(row.rowHash).toBe(proposal.row_hash);
    expect(row.shardMonth).toBe(proposal.shard_month);
    expect(row.isPriceUsableForDpDirect).toBe(false);
    expect(row.isPriceUsableForDpDirectional).toBe(true);
    expect(row.isPriceExcludedFromDp).toBe(false);
    expect(row.schemaVersion).toBe("zao_local_history_v1");
  });

  it("reconstructs an excluded-audit history row that is excluded and not directional", () => {
    const preview = soldOutRow();
    const row = reconstructHistoryRow(preview, CTX);
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.isPriceUsableForDpDirectional).toBe(false);
    expect(row.isPriceUsableForDpDirect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Row policy validation (§10)
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - row policy validation", () => {
  it("passes clean directional + excluded rows and counts them", () => {
    const { records } = buildRecords([directionalRow(), soldOutRow()]);
    const v = validateApprovedHistoryRows(records);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.directCount).toBe(0);
    expect(v.directionalCount).toBe(1);
    expect(v.excludedCount).toBe(1);
  });

  it("rejects any direct-usable row", () => {
    const { records } = buildRecords([directionalRow()]);
    const tampered = records.map((r) => ({
      ...r,
      historyRow: { ...r.historyRow, isPriceUsableForDpDirect: true }
    }));
    const v = validateApprovedHistoryRows(tampered);
    expect(v.ok).toBe(false);
    expect(v.directCount).toBe(1);
    expect(v.errors.some((e) => e.includes("dp_direct_true"))).toBe(true);
  });

  it("rejects a directional row whose carried row_hash no longer re-derives", () => {
    const { records } = buildRecords([directionalRow()]);
    const tampered = records.map((r) => ({
      ...r,
      historyRow: { ...r.historyRow, rowHash: "deadbeef" }
    }));
    const v = validateApprovedHistoryRows(tampered);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("row_hash_mismatch"))).toBe(true);
  });

  it("rejects a shard_month that does not match the checkin", () => {
    const { records } = buildRecords([directionalRow("2026-07-18")]);
    const tampered = records.map((r) => ({
      ...r,
      historyRow: { ...r.historyRow, shardMonth: "2026_01" }
    }));
    const v = validateApprovedHistoryRows(tampered);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("shard_month_mismatch"))).toBe(true);
  });

  it("rejects a directional row missing its screenshot", () => {
    const preview = { ...directionalRow(), screenshot_path: "" } as JalanImprovedPreviewRow;
    const proposal = buildProposalRows([preview], [])[0]!;
    // buildProposalRows downgrades a screenshot-less directional row; force the
    // approved-directional path to prove validation also rejects it.
    const records: ApprovedRowRecord[] = [
      { historyRow: reconstructHistoryRow(preview, CTX), proposal: { ...proposal, history_action: "append_directional" }, preview }
    ];
    const v = validateApprovedHistoryRows(records);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("directional_missing_screenshot"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Preflight (§11) — existing / new / conflict / touched shards
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - preflight", () => {
  it("counts new rows, no conflicts, and the touched shards against fresh history", () => {
    const { historyRows } = buildRecords([directionalRow("2026-07-18"), soldOutRow("2026-06-06")]);
    const pre = computeAppendPreflight(historyRows, [], 185);
    expect(pre.existing_history_row_count).toBe(185);
    expect(pre.approved_append_row_count).toBe(2);
    expect(pre.new_row_count).toBe(2);
    expect(pre.conflict_count).toBe(0);
    expect(pre.skip_identical_count).toBe(0);
    expect(pre.touched_shards).toEqual(["2026_06", "2026_07"]);
    expect(pre.expected_total_after_append).toBe(187);
  });

  it("detects an identical existing row as skip (not new)", () => {
    const { historyRows } = buildRecords([directionalRow()]);
    const r = historyRows[0]!;
    const existing: ExistingHistoryKey[] = [{ row_id: r.rowId, row_hash: r.rowHash, shard_month: r.shardMonth }];
    const pre = computeAppendPreflight(historyRows, existing, 1);
    expect(pre.skip_identical_count).toBe(1);
    expect(pre.new_row_count).toBe(0);
    expect(pre.expected_total_after_append).toBe(1);
  });

  it("detects a row_id collision with a different hash as a conflict", () => {
    const { historyRows } = buildRecords([directionalRow()]);
    const r = historyRows[0]!;
    const existing: ExistingHistoryKey[] = [{ row_id: r.rowId, row_hash: "different", shard_month: r.shardMonth }];
    const pre = computeAppendPreflight(historyRows, existing, 1);
    expect(pre.conflict_count).toBe(1);
    expect(pre.new_row_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Decision labels
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - decision before write", () => {
  it("ready_not_run when the gate is closed", () => {
    expect(decideBeforeWrite({ gateAllowed: false, validationOk: true, conflictCount: 0 })).toBe(
      "jalan_history_append_ready_not_run"
    );
  });
  it("failed_validation when validation fails", () => {
    expect(decideBeforeWrite({ gateAllowed: true, validationOk: false, conflictCount: 0 })).toBe(
      "jalan_history_append_failed_validation"
    );
  });
  it("failed_conflicts when conflicts exist", () => {
    expect(decideBeforeWrite({ gateAllowed: true, validationOk: true, conflictCount: 2 })).toBe(
      "jalan_history_append_failed_conflicts"
    );
  });
  it("success (provisional) when the gate is open, validation ok, and no conflicts", () => {
    expect(decideBeforeWrite({ gateAllowed: true, validationOk: true, conflictCount: 0 })).toBe(
      "jalan_history_append_success"
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Write engine integration (§12, §13) — temp dir, backup/temp/atomic
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - real append via the M06X write engine (temp dir)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("appends approved rows, backs up the touched shard, and post-validates 185->187 style growth", () => {
    dir = mkdtempSync(join(tmpdir(), "auto05x-"));
    const { historyRows } = buildRecords([directionalRow("2026-07-18"), soldOutRow("2026-06-06")]);

    // Seed an existing 2026_07 shard with one unrelated row to prove backup+update.
    const seedJul = reconstructHistoryRow(directionalRow("2026-07-25", "yad999999"), CTX);
    writeFileSync(join(dir, "zao_signals_2026_07.csv"), renderHistoryCsv([seedJul]), "utf8");

    const sourceShards = groupRowsToSourceShards(historyRows);
    const result = runRealAppend({ historyDir: dir, runId: "test", backupTimestamp: "ts1", sourceShards });

    expect(result.decision).toBe("local_history_real_append_success");
    expect(result.rowsWritten).toBe(2);
    expect(result.rowsConflict).toBe(0);
    expect(result.filesCreated).toBe(1); // 2026_06 created
    expect(result.filesUpdated).toBe(1); // 2026_07 updated
    expect(result.backupsCreated).toBe(1); // 2026_07 backed up before update
    expect(result.rollbackPerformed).toBe(false);
    expect(result.lockRemoved).toBe(true);

    const julCsv = readFileSync(join(dir, "zao_signals_2026_07.csv"), "utf8");
    const junCsv = readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8");
    const post = validatePostWriteShards([
      { fileName: "zao_signals_2026_07.csv", csv: julCsv, expectedRowCount: 2 },
      { fileName: "zao_signals_2026_06.csv", csv: junCsv, expectedRowCount: 1 }
    ]);
    expect(post.ok).toBe(true);

    // No duplicate row_ids in the written shards.
    for (const r of post.results) expect(r.duplicateRowIds).toEqual([]);
    // backup directory exists.
    expect(readdirSync(join(dir, ".backup", "ts1"))).toContain("zao_signals_2026_07.csv.bak");
  });

  it("rolls back (restores backup, deletes created files) on an injected write failure", () => {
    dir = mkdtempSync(join(tmpdir(), "auto05x-"));
    const { historyRows } = buildRecords([directionalRow("2026-07-18"), soldOutRow("2026-06-06")]);
    const seedJul = reconstructHistoryRow(directionalRow("2026-07-25", "yad999999"), CTX);
    const originalJul = renderHistoryCsv([seedJul]);
    writeFileSync(join(dir, "zao_signals_2026_07.csv"), originalJul, "utf8");

    const sourceShards = groupRowsToSourceShards(historyRows);
    const result = runRealAppend({
      historyDir: dir,
      runId: "test",
      backupTimestamp: "ts2",
      sourceShards,
      failWriteForShard: "2026_07"
    });

    expect(result.rollbackPerformed).toBe(true);
    expect(result.decision).toBe("local_history_real_append_failed_rolled_back");
    // 2026_07 restored to original; 2026_06 (would-be created) removed.
    expect(readFileSync(join(dir, "zao_signals_2026_07.csv"), "utf8")).toBe(originalJul);
    expect(readdirSync(dir)).not.toContain("zao_signals_2026_06.csv");
  });
});

// ---------------------------------------------------------------------------
// 8. Rendering
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - rendering", () => {
  it("renders the append-action CSV with the expected headers", () => {
    const csv = renderAppendActionCsv([
      {
        row_id: "id1",
        canonical_property_name: "ル・ベール蔵王",
        checkin: "2026-07-18",
        shard_month: "2026_07",
        normalized_total_price: 25000,
        basis_confidence: "B",
        dp_usage: "directional",
        history_action: "append_directional",
        price_pressure_usable: true
      }
    ]);
    expect(csv).toContain("history_action");
    expect(csv).toContain("price_pressure_usable");
    expect(csv).toContain("append_directional");
  });

  it("report includes a DB/AI staleness notice and the AUTO05B next-phase guard", () => {
    const md = renderReport({
      generatedAtJst: "2026-06-05T02:00:00+09:00",
      runId: "jalan_auto05x_test",
      decision: "jalan_history_append_success",
      gate: { allowed: true, approvalSentencePresent: true, envFlagPresent: true, failedConditions: [] },
      sourceAuto04xJsonPath: "auto04x.json",
      sourceAuto03bJsonPath: "auto03b.json",
      selectionSummary: { approved: 25, blocked: 0, missingSourceRows: [] },
      preflight: {
        existing_history_row_count: 185,
        approved_append_row_count: 25,
        new_row_count: 25,
        skip_identical_count: 0,
        conflict_count: 0,
        touched_shards: ["2026_06", "2026_07", "2026_08", "2026_10"],
        expected_total_after_append: 210
      },
      validation: { ok: true, errors: [], directCount: 0, directionalCount: 5, excludedCount: 20 },
      appendActions: [],
      backupDir: ".data/history/.backup/ts",
      backupsCreated: 4,
      filesUpdated: 4,
      filesCreated: 0,
      rowsWritten: 25,
      rowsSkippedDuplicate: 0,
      rollbackPerformed: false,
      postWriteOk: true,
      historyRowCountBefore: 185,
      historyRowCountAfter: 210,
      jalanRowsBefore: 13,
      jalanRowsAfter: 38,
      reportPath: "r.md",
      jsonPath: "r.json",
      csvPath: "r.csv",
      debugRootPath: "debug"
    });
    expect(md).toContain("## 9. DB / AI Context Staleness Notice");
    expect(md).toContain("LOCAL HISTORY ONLY");
    expect(md).toContain("JALAN-AUTO05B");
    expect(md).toContain("Do not start JALAN-AUTO05B without explicit instruction");
    expect(md).toContain("jalan_history_append_success");
    expect(md).toContain("## 11. Safety Confirmation");
  });
});

// ---------------------------------------------------------------------------
// 9. Executable safety scans (§5, §15) — behavioral patterns, not prose
// ---------------------------------------------------------------------------

describe("JALAN-AUTO05X - executable safety scans", () => {
  it("script has no DB write or DB sync code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/better-sqlite3|prepare\(["'`]\s*(?:INSERT|UPDATE|DELETE)|\b(?:db|database)\.exec\(/iu);
    expect(SCRIPT_SOURCE).not.toContain("real-run:history-to-db-sync");
    expect(SERVICE_SOURCE).not.toMatch(/better-sqlite3/iu);
  });

  it("script has no AI context refresh or query-smoke code", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
    expect(SCRIPT_SOURCE).not.toMatch(/query:ai-task/u);
  });

  it("script runs no live collector, browser automation, or external fetch", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch|page\.goto|browser\./u);
    expect(SCRIPT_SOURCE).not.toMatch(/probe:jalan-bounded-collection|proposal:jalan-history-append/u);
    expect(SCRIPT_SOURCE).not.toMatch(/\bfetch\(|axios|got\(|https?:\/\/[a-z]/u);
    expect(SERVICE_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch|page\.goto/u);
  });

  it("emits no pricing / PMS output and invokes no other-source collector", () => {
    // Case-sensitive: real invocations use CamelCase module/script tokens. The
    // snake_case safety-confirmation flag `pms_beds24_airhost_output` is a
    // declaration of what was NOT done and must not trip this scan.
    expect(SCRIPT_SOURCE).not.toMatch(/pricing:recommend|pricing:approve|Beds24|AirHost|pmsCsv|exportApproved/u);
    expect(SCRIPT_SOURCE).not.toMatch(/bookingBounded|runBooking|booking_history_append|rakutenBounded|runRakuten|googleHotels/u);
    expect(SERVICE_SOURCE).not.toMatch(/bookingBounded|runBooking|booking_history_append|rakutenBounded|runRakuten|googleHotels/u);
  });

  it("applies no synthetic tax multiplier (no base x 1.1)", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/u);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/u);
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1\b/u);
  });

  it("appends via the M06X write engine (backup/temp/atomic/rollback), not ad-hoc writes", () => {
    expect(SCRIPT_SOURCE).toContain("runRealAppend");
    expect(SCRIPT_SOURCE).toContain("validatePostWriteShards");
    // The script must not hand-roll rename/copy file ops; the engine owns those.
    expect(SCRIPT_SOURCE).not.toMatch(/renameSync|copyFileSync|appendFileSync/u);
  });

  it("writes only to reports/automation, the debug dir, and .data/history (via the engine)", () => {
    expect(SCRIPT_SOURCE).toContain(".data/reports/automation");
    expect(SCRIPT_SOURCE).toContain(".data/debug/jalan-history-append-real-run");
    expect(SCRIPT_SOURCE).toContain(".data/history");
  });

  it("package.json exposes the real-run script and wires the AUTO04X proposal source", () => {
    expect(PACKAGE_JSON).toContain("\"real-run:jalan-history-append\"");
    expect(SCRIPT_SOURCE).toContain("jalan_history_append_proposal_");
  });

  it("script JSON report exposes the required top-level keys (§18)", () => {
    for (const key of [
      "run_id",
      "generated_at_jst",
      "decision",
      "approval_gate",
      "source_auto04x_proposal",
      "selection_summary",
      "row_policy_validation",
      "preflight_summary",
      "history_before_summary",
      "write_result",
      "post_write_validation",
      "rollback_result",
      "safety_confirmation",
      "next_phase"
    ]) {
      expect(SCRIPT_SOURCE).toContain(`${key}:`);
    }
  });

  it("script fails closed by default: APPROVAL_SENTENCE_PRESENT requires the runtime env flag too", () => {
    // The script still gates on process.env[AUTO05X_ENV_FLAG]; approval alone is insufficient.
    expect(SCRIPT_SOURCE).toContain("process.env[AUTO05X_ENV_FLAG]");
    expect(SCRIPT_SOURCE).toContain("evaluateGate");
  });
});

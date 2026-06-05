// Phase JALAN-AUTO04X — build the Jalan history append proposal (proposal-only).
//
// READ-ONLY: it reads the JALAN-AUTO03B improved preview artifact and the
// current .data/history identity snapshot, then writes a report/json/csv +
// debug artifacts under reports/ and debug/. It never appends history, never
// writes or syncs the DB, never refreshes AI context, never makes a live Jalan
// request, never runs browser automation or a collector, and applies no
// synthetic tax multiplier. Conflicts are reported, not resolved.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildFutureAuto05xPlan,
  buildProposalRows,
  buildSafetyConfirmation,
  buildTouchedShards,
  decideAppendProposal,
  renderProposalCsv,
  renderReport,
  summarizeProposal,
  type CurrentHistorySummary,
  type ExistingHistoryKey,
  type JalanAppendDecision,
  type JalanAppendProposalRow
} from "../services/jalanHistoryAppendProposal";
import { type JalanImprovedPreviewRow } from "../services/jalanBoundedCollectionProbeImproved";

const AUTO03B_ARTIFACT =
  ".data/reports/source-discovery/jalan_bounded_collection_probe_improved_20260605_002941.json";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/jalan-history-append-proposal";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function readExistingHistory(): { keys: ExistingHistoryKey[]; summary: CurrentHistorySummary; parsed: boolean } {
  try {
    const dir = resolve(HISTORY_DIR);
    const files = readdirSync(dir)
      .filter((file) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(file))
      .sort();
    const keys: ExistingHistoryKey[] = [];
    const rowsByShard: Record<string, number> = {};
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
      const shardMonth = /^zao_signals_(\d{4}_\d{2})\.csv$/u.exec(file)?.[1] ?? "unknown";
      let rowCount = 0;
      for (const line of lines.slice(1)) {
        const [row_id = "", row_hash = ""] = line.split(",");
        if (!row_id) continue;
        keys.push({ row_id, row_hash, shard_month: shardMonth });
        rowCount += 1;
      }
      rowsByShard[shardMonth] = rowCount;
    }
    return {
      keys,
      summary: {
        total_rows: keys.length,
        rows_by_shard: rowsByShard,
        source_files: files.map((file) => join(HISTORY_DIR, file))
      },
      parsed: true
    };
  } catch {
    return { keys: [], summary: { total_rows: 0, rows_by_shard: {}, source_files: [] }, parsed: false };
  }
}

function main(): void {
  const ts = timestamp();
  const runId = `jalan_history_append_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const sourceLoaded = existsSync(resolve(AUTO03B_ARTIFACT));
  const auto03b = sourceLoaded ? readJson<Record<string, unknown>>(AUTO03B_ARTIFACT) : null;
  const previewRows = ((auto03b?.["normalized_preview_rows"] ?? []) as JalanImprovedPreviewRow[]) ?? [];

  const sourceAuto03bSummary = {
    artifact_decision: auto03b?.["decision"] ?? null,
    preview_rows: previewRows.length,
    direct_directional_excluded_summary: auto03b?.["direct_directional_excluded_summary"] ?? null,
    availability_summary: auto03b?.["availability_summary"] ?? null
  };

  const { keys, summary: currentHistorySummary, parsed: historyParsed } = readExistingHistory();

  const proposalRows = buildProposalRows(previewRows, keys);
  const summary = summarizeProposal(previewRows, proposalRows, currentHistorySummary);
  const touchedShards = buildTouchedShards(proposalRows, currentHistorySummary);
  const futureAuto05xPlan = buildFutureAuto05xPlan(summary);
  const safety = buildSafetyConfirmation();
  const safetyAllClean = Object.values(safety).every((v) => v === false);

  const decision: JalanAppendDecision = decideAppendProposal({
    sourceLoaded: sourceLoaded && previewRows.length > 0,
    historyParsed,
    summary
  });

  const filterByAction = (action: JalanAppendProposalRow["history_action"]): JalanAppendProposalRow[] =>
    proposalRows.filter((r) => r.history_action === action);
  const directionalAppendRows = filterByAction("append_directional");
  const excludedAuditRows = filterByAction("append_excluded_audit");
  const manualReviewRows = filterByAction("manual_review");
  const conflictRows = filterByAction("block_conflict");

  const nextPhase =
    decision === "jalan_history_append_proposal_not_ready"
      ? "Resolve blockers (no directional rows / conflicts / missing source); do not start JALAN-AUTO05X."
      : "JALAN-AUTO05X — approved Jalan bounded history append (do not start without explicit instruction). DB sync + AI context remain a separate JALAN-AUTO05B phase.";

  const report = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto03b_artifact: AUTO03B_ARTIFACT,
    source_auto03b_summary: sourceAuto03bSummary,
    proposal_summary: summary,
    preflight_summary: summary,
    touched_shards: touchedShards,
    current_history_summary: currentHistorySummary,
    proposal_rows: proposalRows,
    directional_append_rows: directionalAppendRows,
    excluded_audit_rows: excludedAuditRows,
    manual_review_rows: manualReviewRows,
    conflict_rows: conflictRows,
    future_auto05x_plan: futureAuto05xPlan,
    safety_confirmation: { ...safety, safety_all_clean: safetyAllClean },
    next_phase: nextPhase,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  const reportMd = renderReport({
    generatedAtJst,
    decision,
    sourceAuto03bArtifact: AUTO03B_ARTIFACT,
    sourceAuto03bSummary,
    summary,
    touchedShards,
    proposalRows,
    futureAuto05xPlan,
    safetyConfirmation: safety,
    nextPhase
  });

  writeFileSync(reportPath, reportMd, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderProposalCsv(proposalRows), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_auto03b_artifact.json", {
    path: AUTO03B_ARTIFACT,
    loaded: sourceLoaded,
    summary: sourceAuto03bSummary
  });
  writeDebug("existing_history_summary.json", { summary: currentHistorySummary, key_count: keys.length });
  writeDebug("proposal_rows.json", proposalRows);
  writeDebug("preflight_summary.json", summary);
  writeDebug("touched_shards.json", touchedShards);
  writeDebug("directional_append_rows.json", directionalAppendRows);
  writeDebug("excluded_audit_rows.json", excludedAuditRows);
  writeDebug("manual_review_rows.json", manualReviewRows);
  writeDebug("conflict_rows.json", conflictRows);
  writeDebug("future_auto05x_plan.json", futureAuto05xPlan);
  writeDebug("safety_confirmation.json", { ...safety, safety_all_clean: safetyAllClean });

  console.log(`decision=${decision}`);
  console.log(`preview_rows=${summary.total_preview_rows}`);
  console.log(`directional_append=${summary.selected_for_directional_append}`);
  console.log(`excluded_audit_append=${summary.selected_for_excluded_audit_append}`);
  console.log(`skip_identical=${summary.skip_identical_count} conflict=${summary.conflict_count} manual_review=${summary.manual_review_count}`);
  console.log(`total_appendable=${summary.total_appendable_count} expected_total_after_append=${summary.expected_total_after_append_if_no_conflicts}`);
  console.log(`touched_shards=${summary.touched_shards.join(",")}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);

  const acceptable = new Set<JalanAppendDecision>([
    "jalan_history_append_proposal_ready",
    "jalan_history_append_proposal_basis_caution"
  ]);
  if (!acceptable.has(decision)) process.exitCode = 1;
}

main();

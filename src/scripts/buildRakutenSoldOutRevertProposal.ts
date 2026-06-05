// Phase AUTO08X-FIX02-P — build approved revert proposal.
//
// Proposal/preflight only. Reads FIX01 audit artifacts and history shards,
// then writes proposal report/debug artifacts. It never mutates .data/history,
// never writes DB rows, never runs DB sync, never rebuilds AI context, never
// runs collectors, never uses Playwright, and never fetches live pages.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvTable } from "../services/historyToDbSyncDryRun";
import {
  FIX01_AUDIT_JSON,
  buildRakutenSoldOutRevertProposal,
  renderRakutenSoldOutRevertProposalCsv,
  renderRakutenSoldOutRevertProposalMarkdown,
  type LoadedHistoryRowForRevert
} from "../services/rakutenSoldOutRevertProposal";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/rakuten-sold-out-revert-proposal";
const HISTORY_DIR = ".data/history";
const TOUCHED_HISTORY_FILES = [
  ".data/history/zao_signals_2026_06.csv",
  ".data/history/zao_signals_2026_07.csv"
];
const FIX01_CSV = ".data/reports/automation/rakuten_sold_out_semantics_audit_20260604_103811.csv";
const FIX01_DEBUG_DIR = ".data/debug/rakuten-sold-out-semantics-audit/20260604_103811";
const AUTO08X_REPORT = ".data/reports/automation/auto_history_append_20260604_094714.json";
const POST_REFRESH_REPORT = ".data/reports/automation/post_auto_history_append_refresh_20260604_100452.json";

interface Fix01AuditLike {
  decision?: string;
  affected_history_rows?: { count?: number };
}

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

function loadHistoryRows(): LoadedHistoryRowForRevert[] {
  const historyFiles = readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort()
    .map((name) => `${HISTORY_DIR}/${name}`);
  const rows: LoadedHistoryRowForRevert[] = [];
  for (const file of historyFiles) {
    const table = parseCsvTable(readFileSync(resolve(file), "utf8"));
    for (const row of table.rows) rows.push({ ...row, __source_file: file });
  }
  return rows;
}

function inspectInput(path: string): { path: string; exists: boolean; bytes: number } {
  const full = resolve(path);
  if (!existsSync(full)) return { path, exists: false, bytes: 0 };
  const stat = statSync(full);
  if (stat.isDirectory()) return { path, exists: true, bytes: 0 };
  return { path, exists: true, bytes: readFileSync(full, "utf8").length };
}

function main(): void {
  const ts = timestamp();
  const runId = `rakuten_sold_out_revert_proposal_${ts}`;
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);

  const fix01 = readJson<Fix01AuditLike>(FIX01_AUDIT_JSON);
  const proposal = buildRakutenSoldOutRevertProposal({
    runId,
    generatedAtJst: jstIso(),
    sourceFix01Artifact: FIX01_AUDIT_JSON,
    fix01Decision: fix01.decision ?? "",
    fix01AffectedHistoryRows: fix01.affected_history_rows?.count ?? 0,
    historyRows: loadHistoryRows()
  });

  writeFileSync(reportPath, renderRakutenSoldOutRevertProposalMarkdown(proposal), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderRakutenSoldOutRevertProposalCsv(proposal), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_fix01_audit.json", {
    artifact: inspectInput(FIX01_AUDIT_JSON),
    csv: inspectInput(FIX01_CSV),
    debug_dir: inspectInput(FIX01_DEBUG_DIR),
    history_dir: inspectInput(HISTORY_DIR),
    touched_history_files: TOUCHED_HISTORY_FILES.map(inspectInput),
    decision: fix01.decision,
    affected_history_rows: fix01.affected_history_rows?.count
  });
  writeDebug("affected_row_ids.json", proposal.affected_row_ids);
  writeDebug("affected_shards_before_counts.json", proposal.shard_count_plan.map((plan) => ({
    shard_month: plan.shard_month,
    source_file: plan.source_file,
    before_rows: plan.before_rows,
    affected_rows: plan.affected_rows
  })));
  writeDebug("proposed_shards_after_counts.json", proposal.shard_count_plan.map((plan) => ({
    shard_month: plan.shard_month,
    source_file: plan.source_file,
    after_rows: plan.after_rows
  })));
  writeDebug("db_context_expected_after.json", {
    db_resync_plan: proposal.db_resync_plan,
    ai_context_rebuild_plan: proposal.ai_context_rebuild_plan,
    post_refresh_report: inspectInput(POST_REFRESH_REPORT)
  });
  writeDebug("revert_steps.json", {
    backup_rollback_plan: proposal.backup_rollback_plan,
    write_plan: proposal.write_plan
  });
  writeDebug("approval_gate_template.json", proposal.approval_gate_template);
  writeDebug("safety_confirmation.json", {
    ...proposal.safety_confirmation,
    auto08x_report: inspectInput(AUTO08X_REPORT),
    reportPath,
    jsonPath,
    csvPath
  });

  console.log(`decision=${proposal.decision}`);
  console.log(`affected_history_rows=${proposal.affected_history_rows}`);
  console.log(`touched_shards=${proposal.touched_shards.join(",")}`);
  console.log(`total_history_rows_before=${proposal.total_history_rows_before}`);
  console.log(`total_history_rows_after=${proposal.total_history_rows_after}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

main();

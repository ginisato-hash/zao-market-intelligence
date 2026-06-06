// Phase AUTO-RUNNER08Y - build Booking preview append proposal (proposal-only).
//
// READ-ONLY with respect to history/DB/context: reads AUTO-RUNNER08X preview
// artifacts and .data/history identity keys, then writes report/debug proposal
// artifacts only. It never runs Booking collection, appends history, syncs DB,
// refreshes AI context, or generates pricing/PMS output.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildReviewRows,
  buildSafetyConfirmation,
  buildTouchedShardPlan,
  decideBookingPreviewAppendProposal,
  renderProposalCsv,
  renderReport,
  summarizeAppendActions,
  type CurrentHistorySummary,
  type ExistingHistoryKey,
  type PreviewArtifactLike
} from "../services/bookingPreviewAppendProposal";
import { type PreviewRow } from "../services/autoRunnerBookingPreview";

const SOURCE_PREVIEW_ARTIFACT =
  ".data/reports/source-discovery/auto_runner_booking_preview_20260606_130149.json";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-preview-append-proposal";

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
    const sourceCounts: Record<string, number> = {};
    const rowIdCounts = new Map<string, number>();

    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
      const shardMonth = /^zao_signals_(\d{4}_\d{2})\.csv$/u.exec(file)?.[1] ?? "unknown";
      let rowCount = 0;
      for (const line of lines.slice(1)) {
        const cells = line.split(",");
        const row_id = cells[0] ?? "";
        const row_hash = cells[1] ?? "";
        const shard_month = cells[2] ?? shardMonth;
        const source = cells[6] ?? "";
        if (!row_id) continue;
        keys.push({ row_id, row_hash, shard_month, source });
        sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
        rowIdCounts.set(row_id, (rowIdCounts.get(row_id) ?? 0) + 1);
        rowCount += 1;
      }
      rowsByShard[shardMonth] = rowCount;
    }

    return {
      keys,
      summary: {
        total_rows: keys.length,
        booking_rows: sourceCounts["booking"] ?? 0,
        jalan_rows: sourceCounts["jalan"] ?? 0,
        rakuten_rows: sourceCounts["rakuten"] ?? 0,
        duplicate_row_id_count: [...rowIdCounts.values()].filter((count) => count > 1).length,
        rows_by_shard: rowsByShard,
        source_files: files.map((file) => join(HISTORY_DIR, file))
      },
      parsed: true
    };
  } catch {
    return {
      keys: [],
      summary: {
        total_rows: 0,
        booking_rows: 0,
        jalan_rows: 0,
        rakuten_rows: 0,
        duplicate_row_id_count: 0,
        rows_by_shard: {},
        source_files: []
      },
      parsed: false
    };
  }
}

function main(): void {
  const ts = timestamp();
  const runId = `booking_preview_append_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const sourceLoaded = existsSync(resolve(SOURCE_PREVIEW_ARTIFACT));
  const sourceArtifact = sourceLoaded ? readJson<PreviewArtifactLike>(SOURCE_PREVIEW_ARTIFACT) : null;
  const previewRows: PreviewRow[] = sourceArtifact?.preview_rows ?? [];
  const sourceReportPath = sourceArtifact?.report_path ?? SOURCE_PREVIEW_ARTIFACT.replace(/\.json$/u, ".md");
  const sourceCsvPath = sourceArtifact?.csv_path ?? SOURCE_PREVIEW_ARTIFACT.replace(/\.json$/u, ".csv");

  const { keys, summary: historySummary, parsed: historyParsed } = readExistingHistory();
  const reviewRows = buildReviewRows({
    previewRows,
    existingKeys: keys,
    sourceReportPath,
    sourceCsvPath
  });
  const appendSummary = summarizeAppendActions(previewRows, reviewRows, historySummary);
  const touchedShards = buildTouchedShardPlan(reviewRows, historySummary);
  const safety = buildSafetyConfirmation();
  const safetyAllClean = Object.values(safety).every((v) => v === false);
  const decision = decideBookingPreviewAppendProposal({
    sourceLoaded,
    historyParsed,
    summary: appendSummary
  });

  const proposedHistoryRows = reviewRows
    .filter((row) => row.append_action === "append_directional")
    .map((row) => row.proposed_history_row);
  const conflictRows = reviewRows.filter((row) => row.append_action === "block_conflict");
  const manualReviewRows = reviewRows.filter((row) => row.append_action === "manual_review");

  const reportMd = renderReport({
    generatedAtJst,
    decision,
    sourcePreviewArtifact: SOURCE_PREVIEW_ARTIFACT,
    historySummary,
    appendSummary,
    touchedShards,
    reviewRows,
    safetyConfirmation: safety,
    reportPath,
    jsonPath,
    csvPath,
    debugPath
  });

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_preview_artifact: SOURCE_PREVIEW_ARTIFACT,
    source_preview_summary: {
      decision: sourceArtifact?.decision ?? null,
      preview_rows: previewRows.length,
      classification_summary: sourceArtifact?.classification_summary ?? null,
      safety_confirmation: sourceArtifact?.safety_confirmation ?? null
    },
    existing_history_preflight: historySummary,
    append_action_summary: appendSummary,
    touched_shards: touchedShards,
    preview_rows_review: reviewRows,
    proposed_history_rows: proposedHistoryRows,
    conflict_rows: conflictRows,
    manual_review_rows: manualReviewRows,
    price_basis_policy: {
      basis_confidence: "B",
      price_policy: "booking_directional_visible_price_only",
      dp_usage: "directional",
      price_pressure_usable: true,
      direct_pricing_usable: false,
      basis_note: "directional visible price signal; not all-in official total",
      official_tax_fee_adder_numeric: null,
      computed_total_with_tax_fee: null,
      synthetic_tax_multiplier_used: false
    },
    safety_confirmation: { ...safety, safety_all_clean: safetyAllClean },
    next_phase:
      "AUTO-RUNNER08Z — approved append of Booking preview rows to history. Do not start without explicit instruction.",
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(reportPath, reportMd, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderProposalCsv(reviewRows), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_preview_artifact.json", { path: SOURCE_PREVIEW_ARTIFACT, loaded: sourceLoaded, artifact: sourceArtifact });
  writeDebug("preview_rows_review.json", reviewRows);
  writeDebug("history_identity_preflight.json", { keys, summary: historySummary, history_parsed: historyParsed });
  writeDebug("proposed_history_rows.json", proposedHistoryRows);
  writeDebug("append_action_summary.json", appendSummary);
  writeDebug("conflict_check.json", { conflict_count: conflictRows.length, conflict_rows: conflictRows });
  writeDebug("safety_confirmation.json", { ...safety, safety_all_clean: safetyAllClean });

  console.log(`decision=${decision}`);
  console.log(`preview_rows=${appendSummary.total_preview_rows}`);
  console.log(`append_directional=${appendSummary.append_directional}`);
  console.log(`skip_identical=${appendSummary.skip_identical}`);
  console.log(`block_conflict=${appendSummary.block_conflict}`);
  console.log(`manual_review=${appendSummary.manual_review}`);
  console.log(`exclude_audit=${appendSummary.exclude_audit}`);
  console.log(`history_total_rows=${historySummary.total_rows}`);
  console.log(`booking_rows=${historySummary.booking_rows}`);
  console.log(`jalan_rows=${historySummary.jalan_rows}`);
  console.log(`rakuten_rows=${historySummary.rakuten_rows}`);
  console.log(`duplicate_row_id_count=${historySummary.duplicate_row_id_count}`);
  console.log(`expected_total_after_append_if_approved=${appendSummary.expected_total_after_append_if_approved}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);

  if (decision === "booking_preview_append_proposal_not_ready") process.exitCode = 1;
}

main();

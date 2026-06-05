// Phase BOOKING-B10X — build Booking bounded history append proposal.
//
// Reads B09X preview rows + current .data/history identities, runs an in-memory
// append preflight, and writes proposal artifacts. No history append, DB write,
// DB sync, AI context refresh, live Booking fetch, or Playwright.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildFutureB11XPlan,
  buildPricePressurePolicy,
  buildProposalRows,
  buildSafetyConfirmation,
  computePreflight,
  computeTouchedShards,
  decideB10X,
  renderProposalCsv,
  renderProposalReport,
  validateB09XArtifact,
  type B09XArtifactLike,
  type CurrentHistorySummary,
  type ExistingHistoryKey
} from "../services/bookingBoundedHistoryAppendProposal";

const SOURCE_B09X_ARTIFACT_PATH =
  ".data/reports/source-discovery/booking_bounded_expanded_collection_20260604_161623.json";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-bounded-history-append-proposal";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function readExistingHistory(): { keys: ExistingHistoryKey[]; summary: CurrentHistorySummary } {
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
      const [row_id = "", row_hash = "", shard_month = shardMonth] = line.split(",");
      if (!row_id) continue;
      keys.push({ row_id, row_hash, shard_month });
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
    }
  };
}

async function run(): Promise<{ reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string }> {
  const ts = timestamp();
  const runId = `booking_bounded_history_append_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugPath, { recursive: true });

  const sourceB09xArtifactPath = resolve(SOURCE_B09X_ARTIFACT_PATH);
  const b09x = JSON.parse(readFileSync(sourceB09xArtifactPath, "utf8")) as B09XArtifactLike;
  const artifactValidation = validateB09XArtifact(b09x);
  const { keys, summary: currentHistorySummary } = readExistingHistory();
  const proposalRows = buildProposalRows(b09x.normalized_rows_preview ?? [], keys);
  const preflightSummary = computePreflight(proposalRows, currentHistorySummary);
  const touchedShards = computeTouchedShards(proposalRows, currentHistorySummary);
  const pricePressurePolicy = buildPricePressurePolicy();
  const futureB11xPlan = buildFutureB11XPlan();
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideB10X({
    artifactValid: artifactValidation.valid,
    preflight: preflightSummary,
    proposalRows
  });

  const reportPath = resolve(REPORT_DIR, `booking_bounded_history_append_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `booking_bounded_history_append_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `booking_bounded_history_append_proposal_${ts}.csv`);

  writeFileSync(csvPath, renderProposalCsv(proposalRows), "utf8");
  writeFileSync(
    reportPath,
    renderProposalReport({
      generatedAtJst,
      runId,
      decision,
      sourceB09xArtifactPath,
      currentHistorySummary,
      proposalRows,
      preflightSummary,
      touchedShards,
      reportPath,
      jsonPath,
      csvPath,
      debugPath
    }),
    "utf8"
  );

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_b09x_artifact_path: sourceB09xArtifactPath,
    current_history_summary: currentHistorySummary,
    proposal_rows: proposalRows,
    preflight_summary: preflightSummary,
    touched_shards: touchedShards,
    price_pressure_policy: pricePressurePolicy,
    future_b11x_plan: futureB11xPlan,
    safety_confirmation: safetyConfirmation,
    artifact_validation: artifactValidation,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };
  writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");

  await writeFile(join(debugPath, "source_b09x_artifact.json"), JSON.stringify(b09x, null, 2), "utf8");
  await writeFile(join(debugPath, "existing_history_summary.json"), JSON.stringify(currentHistorySummary, null, 2), "utf8");
  await writeFile(join(debugPath, "proposal_rows.json"), JSON.stringify(proposalRows, null, 2), "utf8");
  await writeFile(join(debugPath, "preflight_summary.json"), JSON.stringify(preflightSummary, null, 2), "utf8");
  await writeFile(join(debugPath, "touched_shards.json"), JSON.stringify(touchedShards, null, 2), "utf8");
  await writeFile(join(debugPath, "price_pressure_policy.json"), JSON.stringify(pricePressurePolicy, null, 2), "utf8");
  await writeFile(join(debugPath, "future_b11x_plan.json"), JSON.stringify(futureB11xPlan, null, 2), "utf8");
  await writeFile(join(debugPath, "safety_confirmation.json"), JSON.stringify(safetyConfirmation, null, 2), "utf8");

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

run()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`json_path=${result.jsonPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`debug_artifact_path=${result.debugPath}`);
    console.log(`decision=${result.decision}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

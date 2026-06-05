// Phase AI-READ01X — build the AI-readable market manifest.
//
// Reads local artifacts only. Writes manifest/report files under
// .data/reports/market-update and debug summaries under .data/debug. It never
// mutates .data/history, property universe exports, DB, workflows, or prices.

import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEMAND_INDEX_ENTRYPOINTS,
  HISTORY_SHARD_ENTRYPOINTS,
  buildAiReadableManifest,
  buildDemandIndexStatus,
  buildHistorySummary,
  renderAiReadableManifestCsv,
  renderAiReadableManifestMarkdown
} from "../services/aiReadableMarketManifest";

const REPORT_DIR = ".data/reports/market-update";
const DEBUG_ROOT = ".data/debug/ai-readable-market-manifest";

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

function main(): void {
  const ts = timestamp();
  const runId = `ai_readable_market_manifest_${ts}`;
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);
  const latestMarkdownPath = resolve(reportDir, "ai_readable_market_manifest_latest.md");
  const latestJsonPath = resolve(reportDir, "ai_readable_market_manifest_latest.json");

  const historyShards = HISTORY_SHARD_ENTRYPOINTS.map((path) => ({
    path,
    csv: readFileSync(resolve(path), "utf8")
  }));
  const historySummary = buildHistorySummary(historyShards);
  const demandJson = readFileSync(resolve(DEMAND_INDEX_ENTRYPOINTS[2]), "utf8");
  const demandIndexStatus = buildDemandIndexStatus(demandJson);
  const manifest = buildAiReadableManifest({
    runId,
    generatedAtJst: jstIso(),
    historySummary,
    demandIndexStatus
  });

  const markdown = renderAiReadableManifestMarkdown(manifest);
  const csv = renderAiReadableManifestCsv(manifest);

  writeFileSync(reportPath, markdown, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, csv, "utf8");
  copyFileSync(reportPath, latestMarkdownPath);
  copyFileSync(jsonPath, latestJsonPath);

  const latestMarkdownIsSymlink = lstatSync(latestMarkdownPath).isSymbolicLink();
  const latestJsonIsSymlink = lstatSync(latestJsonPath).isSymbolicLink();

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("history_summary.json", historySummary);
  writeDebug("demand_index_status.json", demandIndexStatus);
  writeDebug("latest_pointer_status.json", {
    latestMarkdownPath,
    latestJsonPath,
    latestMarkdownIsSymlink,
    latestJsonIsSymlink
  });
  writeDebug("safety_confirmation.json", manifest.safety_confirmation);

  console.log(`decision=${manifest.decision}`);
  console.log(`history_file_count=${historySummary.historyFileCount}`);
  console.log(`total_history_rows=${historySummary.totalHistoryRows}`);
  console.log(`demand_row_count=${demandIndexStatus.demandRowCount}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`latest_markdown_path=${latestMarkdownPath}`);
  console.log(`latest_json_path=${latestJsonPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

main();

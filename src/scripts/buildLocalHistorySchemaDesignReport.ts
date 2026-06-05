// Phase M02X — build the local history schema design report.
//
// Reads the latest Phase M01X cross-source unified artifact (JSON .rows),
// maps each unified row into a history-ready row, previews monthly shard
// grouping + dedupe + validation, and writes a prototype MD/CSV/JSON plus
// debug artifacts under reports/. DESIGN / PROTOTYPE ONLY.
//
// NO DB writes. NO actual .data/history append. No collector re-runs.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HISTORY_CSV_HEADERS,
  HISTORY_SCHEMA_VERSION,
  decideM02X,
  findDuplicateRowIds,
  groupRowsByShardMonth,
  mapUnifiedRowsToHistoryRows,
  renderHistoryCsv,
  renderHistorySchemaDesignReport,
  validateHistoryRows,
  validateHistorySchemaColumns,
  type HistoryRow
} from "../services/localHistorySchemaDesign";
import { type UnifiedMarketSignalRow } from "../services/crossSourceMarketSignalNormalization";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/history-schema-design";
const HISTORY_DIR = ".data/history";
const SOURCE_PREFIX = "cross_source_market_signals_";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function resolveLatestSource(): { jsonPath: string; reportPath: string; csvPath: string } {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing M01X artifact directory: ${reportDir}. Do not re-run collectors; produce the M01X artifact first.`);
  }
  const jsonFiles = entries.filter((name) => name.startsWith(SOURCE_PREFIX) && name.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(
      `Missing M01X source JSON (expected ${SOURCE_PREFIX}*.json in ${reportDir}). Do not re-run collectors; stop and report the missing artifact path.`
    );
  }
  const base = latest.slice(0, -".json".length);
  return {
    jsonPath: resolve(reportDir, latest),
    reportPath: resolve(reportDir, `${base}.md`),
    csvPath: resolve(reportDir, `${base}.csv`)
  };
}

function loadUnifiedRows(jsonPath: string): UnifiedMarketSignalRow[] {
  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch {
    throw new Error(`Missing M01X source JSON: ${jsonPath}. Stop and report the missing artifact path.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Malformed M01X source JSON ${jsonPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`M01X source JSON ${jsonPath} has no rows[]. Stop and report the malformed artifact.`);
  }
  return rows as UnifiedMarketSignalRow[];
}

function dpGateCounts(rows: HistoryRow[]): { direct: number; directional: number; excluded: number } {
  return {
    direct: rows.filter((r) => r.isPriceUsableForDpDirect).length,
    directional: rows.filter((r) => r.isPriceUsableForDpDirectional).length,
    excluded: rows.filter((r) => r.isPriceExcludedFromDp).length
  };
}

function dedupeKeyPreview(rows: HistoryRow[]): { rowId: string; rowHash: string }[] {
  return rows.slice(0, 10).map((r) => ({ rowId: r.rowId, rowHash: r.rowHash }));
}

function build(): {
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
  rows: HistoryRow[];
  decision: string;
} {
  // Safety guard: this phase must never create real history shard files.
  const historyDir = resolve(HISTORY_DIR);
  const historyBefore = existsSync(historyDir) ? readdirSync(historyDir) : [];

  const ts = timestamp();
  const source = resolveLatestSource();
  const unifiedRows = loadUnifiedRows(source.jsonPath);

  const rows = mapUnifiedRowsToHistoryRows(unifiedRows);
  const forbiddenColumnErrors = validateHistorySchemaColumns([...HISTORY_CSV_HEADERS]);
  const validation = validateHistoryRows(rows);
  const duplicates = findDuplicateRowIds(rows);
  const shardGroups = groupRowsByShardMonth(rows);
  const dpGate = dpGateCounts(rows);
  const decision = decideM02X({ rowCount: rows.length, validation, duplicates, forbiddenColumnErrors });

  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `local_history_schema_design_${ts}.md`);
  const csvPath = resolve(reportDir, `local_history_schema_design_${ts}.csv`);
  const jsonPath = resolve(reportDir, `local_history_schema_design_${ts}.json`);

  const summary = {
    decision,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    rowCount: rows.length,
    sourceCounts: countBy(rows.map((r) => r.source)),
    shardGroups,
    duplicateRowIdCount: duplicates.length,
    validation: {
      validRowCount: validation.validRowCount,
      invalidRowCount: validation.invalidRowCount,
      errorCounts: validation.errorCounts
    },
    forbiddenColumnErrors,
    dpGate,
    sourceArtifact: { reportPath: source.reportPath, csvPath: source.csvPath, jsonPath: source.jsonPath }
  };

  writeFileSync(csvPath, renderHistoryCsv(rows), "utf8");
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(
    reportPath,
    renderHistorySchemaDesignReport({
      generatedAt: new Date().toISOString(),
      rows,
      decision,
      validation,
      duplicates,
      shardGroups,
      forbiddenColumnErrors,
      dpGate,
      sourceArtifact: summary.sourceArtifact,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );

  // Debug artifacts.
  writeFileSync(resolve(debugRootPath, "source_m01x_artifact.json"), JSON.stringify(summary.sourceArtifact, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "history_schema_columns.json"), JSON.stringify(HISTORY_CSV_HEADERS, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "history_rows_prototype.json"), JSON.stringify(rows, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "shard_grouping_preview.json"), JSON.stringify(shardGroups, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "dedupe_key_preview.json"), JSON.stringify(dedupeKeyPreview(rows), null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "validation_summary.json"), JSON.stringify(validation, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "duplicate_row_ids.json"), JSON.stringify(duplicates, null, 2), "utf8");
  writeFileSync(
    resolve(debugRootPath, "forbidden_column_check.json"),
    JSON.stringify({ forbiddenColumnErrors, checkedColumns: HISTORY_CSV_HEADERS }, null, 2),
    "utf8"
  );

  // Safety guard: confirm no real history shard was written.
  const historyAfter = existsSync(historyDir) ? readdirSync(historyDir) : [];
  if (historyAfter.length !== historyBefore.length) {
    throw new Error(
      `Safety violation: ${HISTORY_DIR} changed during M02X (before=${historyBefore.length}, after=${historyAfter.length}). This phase must not write real history shards.`
    );
  }

  return { reportPath, csvPath, jsonPath, debugRootPath, rows, decision };
}

try {
  const result = build();
  console.log(`report_path=${result.reportPath}`);
  console.log(`csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`schema_version=${HISTORY_SCHEMA_VERSION}`);
  console.log(`row_count=${result.rows.length}`);
  console.log(`source_counts=${JSON.stringify(countBy(result.rows.map((r) => r.source)))}`);
  console.log(`shard_groups=${JSON.stringify(groupRowsByShardMonth(result.rows).map((g) => ({ [g.shardMonth]: g.rowCount })))}`);
  console.log(`duplicate_row_id_count=${findDuplicateRowIds(result.rows).length}`);
  console.log(`validation_invalid_rows=${validateHistoryRows(result.rows).invalidRowCount}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

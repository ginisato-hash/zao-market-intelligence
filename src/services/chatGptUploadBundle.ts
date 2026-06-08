// AUTO-RUNNER-CHATGPT-UPLOAD01 — ChatGPT DB/history upload bundle helpers (pure).
//
// This module is pure: no I/O, no zip, no process spawn, no DB writes. The
// companion script does all filesystem/zip work and calls these functions for
// manifest rendering, decision logic, and path building. It never mutates DB,
// history, AI context, or emits pricing/PMS output.

import { createHash } from "node:crypto";

export type UploadBundleDecision =
  | "chatgpt_upload_bundle_ready"
  | "chatgpt_upload_bundle_ready_history_only"
  | "chatgpt_upload_bundle_ready_with_warning"
  | "chatgpt_upload_bundle_not_ready";

export type SourceOfTruth =
  | "history_csv_canonical"
  | "sqlite_mirror_verified"
  | "sqlite_missing_history_only"
  | "sqlite_history_mismatch";

export interface HistoryStats {
  file_count: number;
  row_count: number;
  duplicate_row_id_count: number;
  by_source: Record<string, number>;
  latest_collected_date: string | null;
  latest_stay_date: string | null;
  sha256_by_file: Record<string, string>;
}

export interface SqliteStats {
  included: boolean;
  path: string;
  size_bytes: number;
  row_count: number | null;
  sha256: string;
}

export interface BundleManifestInput {
  generated_at_jst: string;
  git_head: string;
  git_branch: string;
  package_filename: string;
  source_repo_path: string;
  upload_folder_path: string;
  history: HistoryStats;
  sqlite: SqliteStats | null;
  warnings: string[];
}

export interface ManifestData {
  generated_at_jst: string;
  git_head: string;
  git_branch: string;
  package_filename: string;
  package_mode: "db_history_upload_bundle";
  source_repo_path: string;
  upload_folder_path: string;
  sqlite: { included: boolean; path: string; size_bytes: number; row_count: number | null; sha256: string } | { included: false; path: null; size_bytes: 0; row_count: null; sha256: "" };
  history: { included: boolean; directory: string; file_count: number; row_count: number; sha256_by_file: Record<string, string> };
  counts: { by_source: Record<string, number>; duplicate_row_id: number };
  latest: { latest_collected_date: string | null; latest_stay_date: string | null };
  source_of_truth: SourceOfTruth;
  warnings: string[];
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function decideBundle(input: { historyRowCount: number; sqlitePresent: boolean; sqliteRowCount: number | null; warnings: string[] }): UploadBundleDecision {
  if (input.historyRowCount === 0) return "chatgpt_upload_bundle_not_ready";
  if (!input.sqlitePresent) return "chatgpt_upload_bundle_ready_history_only";
  if (input.warnings.length > 0) return "chatgpt_upload_bundle_ready_with_warning";
  return "chatgpt_upload_bundle_ready";
}

export function computeSourceOfTruth(input: { sqlitePresent: boolean; sqliteRowCount: number | null; historyRowCount: number }): SourceOfTruth {
  if (!input.sqlitePresent) return "sqlite_missing_history_only";
  if (input.sqliteRowCount === null) return "history_csv_canonical";
  if (input.sqliteRowCount === input.historyRowCount) return "sqlite_mirror_verified";
  return "sqlite_history_mismatch";
}

export function buildManifestData(input: BundleManifestInput): ManifestData {
  const sqliteRowCount = input.sqlite?.row_count ?? null;
  const hasMismatch = input.sqlite !== null && sqliteRowCount !== null && sqliteRowCount !== input.history.row_count;
  const warnings = [...input.warnings];
  if (hasMismatch) warnings.push(`sqlite_history_row_count_mismatch: sqlite=${String(sqliteRowCount)} history=${input.history.row_count}`);
  return {
    generated_at_jst: input.generated_at_jst,
    git_head: input.git_head,
    git_branch: input.git_branch,
    package_filename: input.package_filename,
    package_mode: "db_history_upload_bundle",
    source_repo_path: input.source_repo_path,
    upload_folder_path: input.upload_folder_path,
    sqlite: input.sqlite !== null
      ? { included: true, path: "zao-market-intelligence.sqlite", size_bytes: input.sqlite.size_bytes, row_count: input.sqlite.row_count, sha256: input.sqlite.sha256 }
      : { included: false, path: null, size_bytes: 0, row_count: null, sha256: "" },
    history: { included: true, directory: "history/", file_count: input.history.file_count, row_count: input.history.row_count, sha256_by_file: input.history.sha256_by_file },
    counts: { by_source: input.history.by_source, duplicate_row_id: input.history.duplicate_row_id_count },
    latest: { latest_collected_date: input.history.latest_collected_date, latest_stay_date: input.history.latest_stay_date },
    source_of_truth: computeSourceOfTruth({ sqlitePresent: input.sqlite !== null, sqliteRowCount, historyRowCount: input.history.row_count }),
    warnings
  };
}

export function renderManifestMd(data: ManifestData): string {
  const hist = data.history;
  const sq = data.sqlite;
  const bySrc = Object.entries(data.counts.by_source).map(([k, v]) => `  - ${k}: ${v}`).join("\n") || "  - (none)";
  return `# ZMI ChatGPT Upload Manifest

## 1. Bundle metadata

- generated_at_jst: ${data.generated_at_jst}
- source_repo_path: ${data.source_repo_path}
- git_head: ${data.git_head}
- git_branch: ${data.git_branch}
- package_filename: ${data.package_filename}
- package_mode: ${data.package_mode}
- upload_folder_path: ${data.upload_folder_path}

## 2. Included files

- manifest.md (this file)
- manifest.json
- ${sq.included ? `zao-market-intelligence.sqlite (${sq.size_bytes} bytes)` : "SQLite DB: NOT INCLUDED"}
- history/ (${hist.file_count} CSV files)
${Object.keys(hist.sha256_by_file).map((f) => `  - ${f}`).join("\n") || "  - (none)"}

## 3. Data status

- sqlite_present: ${String(sq.included)}
- sqlite_size_bytes: ${String(sq.size_bytes)}
- sqlite_row_count: ${sq.row_count !== null ? String(sq.row_count) : "unknown"}
- history_csv_file_count: ${hist.file_count}
- history_row_count: ${hist.row_count}
- source_counts:
${bySrc}
- duplicate_row_id_count: ${data.counts.duplicate_row_id}
- latest_collected_date: ${data.latest.latest_collected_date ?? "unknown"}
- latest_stay_date: ${data.latest.latest_stay_date ?? "unknown"}
- source_of_truth: ${data.source_of_truth}
${data.warnings.length > 0 ? `\n**Warnings:**\n${data.warnings.map((w) => `- ${w}`).join("\n")}` : ""}

## 4. How ChatGPT should use this bundle

- **Prefer history CSV as canonical** if SQLite and history disagree.
- Use SQLite for convenient querying if readable.
- Do not infer unavailable data.
- Treat basis_caution / manual_review / hard_conflict rows carefully; do not promote excluded rows to directional.
- Do not generate PMS CSV, Beds24 output, or price-update files unless explicitly requested.
- For pricing decisions, use market signals, sold_out/not_listed/available, source basis, and recent price changes.
- Do not use own price as the sole pricing driver.
- Intraday price changes (row_id contains \`::intraday::\`) represent same-day price movements — use the most recent.

## 5. Suggested ChatGPT prompt

添付されたZMI upload bundleを読み、対象施設【施設名】・対象期間【YYYY-MM-DD〜YYYY-MM-DD】について、価格判断レポートと必要なCSVを生成してください。取得不可データは推測補完せず、A/B/C取得ステータスを明記してください。
`;
}

// Parse history CSVs without full CSV library (handles quoted fields for row_id and source).
export function parseHistoryCsvStats(input: { filename: string; content: string }[]): HistoryStats {
  const ids = new Map<string, number>();
  const sources: Record<string, number> = {};
  let totalRows = 0;
  const sha256_by_file: Record<string, string> = {};
  let latestCollected: string | null = null;
  let latestStay: string | null = null;

  for (const { filename, content } of input) {
    sha256_by_file[`history/${filename}`] = createHash("sha256").update(Buffer.from(content)).digest("hex");
    const lines = content.split(/\r?\n/u).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const headers = parseCsvLine(lines[0] ?? "");
    const rowIdIdx = headers.indexOf("row_id");
    const sourceIdx = headers.indexOf("source");
    const collectedIdx = headers.indexOf("collected_date_jst");
    const checkinIdx = headers.indexOf("checkin");
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      totalRows += 1;
      const id = cells[rowIdIdx] ?? "";
      ids.set(id, (ids.get(id) ?? 0) + 1);
      const src = cells[sourceIdx] ?? "unknown";
      sources[src] = (sources[src] ?? 0) + 1;
      const col = cells[collectedIdx] ?? "";
      if (col.length === 10 && (latestCollected === null || col > latestCollected)) latestCollected = col;
      const stay = cells[checkinIdx] ?? "";
      if (stay.length === 10 && (latestStay === null || stay > latestStay)) latestStay = stay;
    }
  }
  const dupCount = [...ids.values()].filter((n) => n > 1).length;
  return {
    file_count: input.length,
    row_count: totalRows,
    duplicate_row_id_count: dupCount,
    by_source: sources,
    latest_collected_date: latestCollected,
    latest_stay_date: latestStay,
    sha256_by_file
  };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur);
  return cells;
}

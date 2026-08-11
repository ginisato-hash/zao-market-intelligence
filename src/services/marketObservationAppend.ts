// Phase ZMI-MKT-OBS01 — market observation append-only store (write engine). §6/§11/§25.
//
// Additive, SEPARATE from .data/history: writes ONLY to
// .data/market-observations/mkt_obs_YYYY_MM.csv (+ .backup/.tmp/.append.lock
// under that same directory). Never touches .data/history or any existing
// BI export file — the existing price-history pipeline is completely
// unaffected by this module's existence (§25).
//
// Safety model mirrors the proven localHistoryRealAppend.ts pattern: append
// lock (stale after 30 min), backup of any pre-existing shard before it is
// modified, temp-file write + atomic rename, and a hard block on any
// observation_id hash conflict (never overwrite an existing observation — a
// conflict aborts the WHOLE write, nothing partial).

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MARKET_OBSERVATION_CSV_HEADERS,
  MARKET_OBSERVATION_SCHEMA_VERSION,
  shardMonthFromStayDate,
  toObservationCsvRow,
  type MarketObservationRow
} from "./marketObservationSchema";

const APPEND_LOCK_FILENAME = ".append.lock";
const BACKUP_DIRNAME = ".backup";
const TMP_DIRNAME = ".tmp";
export const STALE_LOCK_THRESHOLD_MINUTES = 30;

function esc(v: string): string {
  return /[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v;
}

export function renderObservationCsv(rows: readonly MarketObservationRow[]): string {
  const lines = [MARKET_OBSERVATION_CSV_HEADERS.join(","), ...rows.map((r) => toObservationCsvRow(r).map(esc).join(","))];
  return `${lines.join("\n")}\n`;
}

function parseObservationCsv(csv: string): Map<string, string> {
  // observation_id -> observation_hash, the only fields needed for conflict
  // detection; full row parsing is unnecessary for the append path.
  const lines = csv.split(/\r?\n/u).filter((l) => l.length > 0);
  if (lines.length < 1) return new Map();
  const header = lines[0]!.split(",");
  const idIdx = header.indexOf("observation_id");
  const hashIdx = header.indexOf("observation_hash");
  const out = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const id = cols[idIdx];
    const hash = cols[hashIdx];
    if (id !== undefined && hash !== undefined) out.set(id, hash);
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function shardFileName(shardMonth: string): string {
  return `mkt_obs_${shardMonth}.csv`;
}

export function isLockStale(ageMs: number, thresholdMinutes: number = STALE_LOCK_THRESHOLD_MINUTES): boolean {
  return ageMs > thresholdMinutes * 60_000;
}

export interface AppendMarketObservationsResult {
  decision: "market_observation_append_success" | "market_observation_append_blocked_lock" | "market_observation_append_blocked_conflict";
  rowsWritten: number;
  rowsSkippedDuplicate: number;
  rowsConflict: number;
  shardsWritten: string[];
  message: string;
}

// Existing rows for the SAME observation_id with a DIFFERENT hash are a hard
// conflict (something about that exact observation cell changed after the
// fact — never happens under correct collector_run_id uniqueness, but
// checked anyway, matching the existing history append's own defense in
// depth). Existing rows with the SAME hash are silently skipped (idempotent
// re-append of identical data, not an error).
export function appendMarketObservations(input: {
  observationsDir: string;
  runId: string;
  nowMs?: number;
  rows: readonly MarketObservationRow[];
}): AppendMarketObservationsResult {
  const dir = input.observationsDir;
  const nowMs = input.nowMs ?? Date.now();
  mkdirSync(dir, { recursive: true });

  const lockPath = join(dir, APPEND_LOCK_FILENAME);
  if (existsSync(lockPath)) {
    const ageMs = nowMs - statSync(lockPath).mtimeMs;
    if (!isLockStale(ageMs)) {
      return {
        decision: "market_observation_append_blocked_lock",
        rowsWritten: 0,
        rowsSkippedDuplicate: 0,
        rowsConflict: 0,
        shardsWritten: [],
        message: `Fresh append lock present (age ${Math.round(ageMs / 1000)}s). Aborting; another append may be in progress.`
      };
    }
    rmSync(lockPath, { force: true });
  }
  writeFileSync(lockPath, `${input.runId}\n${new Date(nowMs).toISOString()}\n`, "utf8");

  try {
    const byShard = new Map<string, MarketObservationRow[]>();
    for (const row of input.rows) {
      const shard = shardMonthFromStayDate(row.stayDate);
      const bucket = byShard.get(shard);
      if (bucket === undefined) byShard.set(shard, [row]);
      else bucket.push(row);
    }

    let rowsWritten = 0;
    let rowsSkippedDuplicate = 0;
    let rowsConflict = 0;
    const shardsWritten: string[] = [];
    const backupDir = join(dir, BACKUP_DIRNAME, String(nowMs));
    const tmpDir = join(dir, TMP_DIRNAME);
    mkdirSync(tmpDir, { recursive: true });

    // Pass 1: detect conflicts across ALL shards before writing anything —
    // a single conflict aborts the whole append, nothing partial.
    for (const [shardMonth, newRows] of byShard) {
      const targetPath = join(dir, shardFileName(shardMonth));
      const existingIndex = existsSync(targetPath) ? parseObservationCsv(readFileSync(targetPath, "utf8")) : new Map<string, string>();
      for (const row of newRows) {
        const existingHash = existingIndex.get(row.observationId);
        if (existingHash !== undefined && existingHash !== row.observationHash) rowsConflict += 1;
      }
    }
    if (rowsConflict > 0) {
      rmSync(lockPath, { force: true });
      return {
        decision: "market_observation_append_blocked_conflict",
        rowsWritten: 0,
        rowsSkippedDuplicate: 0,
        rowsConflict,
        shardsWritten: [],
        message: `${rowsConflict} observation_id hash conflict(s) detected — aborting, no rows written.`
      };
    }

    // Pass 2: write. Backup any pre-existing shard first, then atomic rename.
    for (const [shardMonth, newRows] of byShard) {
      const targetPath = join(dir, shardFileName(shardMonth));
      const existed = existsSync(targetPath);
      const existingIndex = existed ? parseObservationCsv(readFileSync(targetPath, "utf8")) : new Map<string, string>();
      const toAppend = newRows.filter((row) => {
        if (existingIndex.has(row.observationId)) {
          rowsSkippedDuplicate += 1;
          return false;
        }
        return true;
      });
      if (toAppend.length === 0) continue;

      if (existed) {
        mkdirSync(backupDir, { recursive: true });
        copyFileSync(targetPath, join(backupDir, shardFileName(shardMonth)));
      }

      const existingCsv = existed ? readFileSync(targetPath, "utf8").trimEnd() : MARKET_OBSERVATION_CSV_HEADERS.join(",");
      const newLines = toAppend.map((r) => toObservationCsvRow(r).map(esc).join(","));
      const finalCsv = `${[existingCsv, ...newLines].join("\n")}\n`;

      const tmpPath = join(tmpDir, `${shardFileName(shardMonth)}.${nowMs}.tmp`);
      writeFileSync(tmpPath, finalCsv, "utf8");
      renameSync(tmpPath, targetPath);
      rowsWritten += toAppend.length;
      shardsWritten.push(shardMonth);
    }

    return {
      decision: "market_observation_append_success",
      rowsWritten,
      rowsSkippedDuplicate,
      rowsConflict: 0,
      shardsWritten,
      message: `Wrote ${rowsWritten} row(s) across ${shardsWritten.length} shard(s); skipped ${rowsSkippedDuplicate} exact duplicate(s). Schema ${MARKET_OBSERVATION_SCHEMA_VERSION}.`
    };
  } finally {
    rmSync(lockPath, { force: true });
  }
}

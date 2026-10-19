// Quote-aware helpers for reading .data/history shards.
//
// History shards can contain quoted fields with embedded newlines (e.g. a
// Playwright error message in warning_flags). Splitting on raw newlines counts
// such a row as several rows and invents phantom row_ids from the continuation
// lines, which breaks every history-vs-DB row-count comparison.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Split CSV text into logical records. Newlines inside quoted fields are treated
// as field content (not record boundaries), so quoted multi-line values count as
// ONE row. Quote characters are preserved so parseCsvLine can re-parse each record.
export function splitCsvRecords(content: string): string[] {
  const records: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '"') { q = !q; cur += ch; continue; }
    if ((ch === "\n" || ch === "\r") && !q) {
      if (ch === "\r" && content[i + 1] === "\n") i += 1;
      records.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur !== "") records.push(cur);
  return records.filter((r) => r.length > 0);
}

export function parseCsvLine(line: string): string[] {
  const cells: string[] = []; let cur = ""; let q = false;
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

export interface HistoryShard { file: string; header: string[]; rows: string[][] }

// Every zao_signals_*.csv shard in historyDir, parsed into logical records.
export function readHistoryShards(historyDir: string): HistoryShard[] {
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir)
    .filter((x) => /^zao_signals_.*\.csv$/u.test(x))
    .sort()
    .map((file) => {
      const records = splitCsvRecords(readFileSync(join(historyDir, file), "utf8"));
      return { file, header: parseCsvLine(records[0] ?? ""), rows: records.slice(1).map(parseCsvLine) };
    });
}

export function summarizeHistoryRows(historyDir: string): { history_rows: number; duplicate_row_id_count: number } {
  let historyRows = 0; const ids = new Map<string, number>();
  for (const shard of readHistoryShards(historyDir)) {
    const ri = shard.header.indexOf("row_id");
    for (const c of shard.rows) { historyRows += 1; const id = c[ri] ?? ""; ids.set(id, (ids.get(id) ?? 0) + 1); }
  }
  return { history_rows: historyRows, duplicate_row_id_count: [...ids.values()].filter((n) => n > 1).length };
}

// Collapse a multi-line message (Playwright appends a "Call log:" block) onto one
// line so it can never introduce an embedded newline into a history CSV field.
export function toSingleLine(message: string): string {
  return message.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0).join(" | ");
}

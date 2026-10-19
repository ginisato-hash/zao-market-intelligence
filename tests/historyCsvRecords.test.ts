import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readHistoryShards, splitCsvRecords, summarizeHistoryRows, toSingleLine } from "../src/services/historyCsvRecords";

// Shape of the 2026-06-16 Booking navigation failure that broke the rotating
// runner's history/DB row-count comparison: Playwright's "Call log:" block
// written verbatim into a quoted warning_flags field.
const PLAYWRIGHT_ERROR = 'navigation_failed;page.goto: net::ERR_NETWORK_CHANGED at https://www.booking.com/hotel/jp/x.ja.html\nCall log:\n  - navigating to "https://www.booking.com/hotel/jp/x.ja.html", waiting until "domcontentloaded"\n';
const quote = (v: string): string => `"${v.replace(/"/gu, '""')}"`;
const HEADER = "row_id,source,source_slug_or_code,checkin,collected_at_jst,warning_flags";
const row = (id: string, flags: string): string => `${id},booking,x,2026-07-01,2026-06-16T12:00:05+09:00,${quote(flags)}`;

function writeShards(shards: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "zmi-history-"));
  for (const [name, rows] of Object.entries(shards)) writeFileSync(join(dir, name), `${[HEADER, ...rows].join("\n")}\n`, "utf8");
  return dir;
}

describe("historyCsvRecords", () => {
  it("counts a quoted multi-line field as one record", () => {
    const csv = `${HEADER}\n${row("a", PLAYWRIGHT_ERROR)}\n${row("b", "ok")}\n`;
    expect(csv.split(/\r?\n/u).filter((l) => l.length > 0)).toHaveLength(6); // what the old line split saw
    expect(splitCsvRecords(csv)).toHaveLength(3);
  });

  it("handles CRLF and escaped quotes", () => {
    expect(splitCsvRecords('h\r\n"a ""q""\r\nb",1\r\nc,2\r\n')).toEqual(['h', '"a ""q""\r\nb",1', "c,2"]);
  });

  it("reports logical row count and no phantom duplicate row_ids", () => {
    // Two multi-line rows reproduce the production symptom: the old split produced
    // two "Call log:" continuation lines -> duplicate_row_id_count=1.
    const dir = writeShards({
      "zao_signals_2026_07.csv": [row("a", PLAYWRIGHT_ERROR), row("b", "ok")],
      "zao_signals_2026_08.csv": [row("c", PLAYWRIGHT_ERROR)],
      "not_history.csv": [row("z", "ignored")]
    });
    expect(summarizeHistoryRows(dir)).toEqual({ history_rows: 3, duplicate_row_id_count: 0 });
    const shards = readHistoryShards(dir);
    expect(shards.map((s) => s.file)).toEqual(["zao_signals_2026_07.csv", "zao_signals_2026_08.csv"]);
    expect(shards[0]!.rows[0]![5]).toBe(PLAYWRIGHT_ERROR);
  });

  it("still detects a real duplicate row_id", () => {
    const dir = writeShards({ "zao_signals_2026_07.csv": [row("a", "ok")], "zao_signals_2026_08.csv": [row("a", "ok")] });
    expect(summarizeHistoryRows(dir)).toEqual({ history_rows: 2, duplicate_row_id_count: 1 });
  });

  it("returns zero for a missing history dir", () => {
    expect(summarizeHistoryRows(join(tmpdir(), "zmi-history-does-not-exist"))).toEqual({ history_rows: 0, duplicate_row_id_count: 0 });
  });

  it("collapses Playwright errors onto one line", () => {
    const one = toSingleLine(PLAYWRIGHT_ERROR);
    expect(one).not.toMatch(/[\r\n]/u);
    expect(one).toContain("ERR_NETWORK_CHANGED");
    expect(one).toContain("Call log:");
  });
});

describe("rotating runner reads history as logical CSV records", () => {
  const RUNNER = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerMarketRefreshRotating.ts"), "utf8");
  it("does not split history shards on raw newlines", () => {
    expect(RUNNER).not.toMatch(/readFileSync\(join\(HISTORY_DIR[^)]*\), "utf8"\)\.split\(/u);
    expect(RUNNER).toContain("summarizeHistoryRows(HISTORY_DIR)");
  });
  it("collapses the Booking navigation error before it reaches warning_flags", () => {
    expect(RUNNER).toContain("error = toSingleLine(");
  });
});

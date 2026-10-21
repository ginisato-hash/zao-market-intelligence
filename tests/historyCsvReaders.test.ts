import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHistoryForPriceHistory } from "../src/services/priceHistorySignals";

// Readers of .data/history must treat a quoted multi-line warning_flags value
// (the 2026-06-16 Playwright "Call log:" error) as ONE record. Splitting on raw
// newlines produced phantom rows and truncated the real row at the newline.
const PLAYWRIGHT_ERROR = 'navigation_failed;page.goto: net::ERR_NETWORK_CHANGED at https://www.booking.com/hotel/jp/x.ja.html\nCall log:\n  - navigating to "https://www.booking.com/hotel/jp/x.ja.html", waiting until "domcontentloaded"\n';
const quote = (v: string): string => `"${v.replace(/"/gu, '""')}"`;
const HEADER = "row_id,source,source_property_id,canonical_property_name,checkin,collected_at_jst,availability_status,normalized_total_price,warning_flags,source_classification,is_price_usable_for_dp_directional";
const row = (id: string, flags: string, price = "30000"): string =>
  `${id},booking,zao-kokusai,蔵王国際ホテル,2026-07-01,2026-06-16T12:00:05+09:00,failed,${price},${quote(flags)},navigation_failed,false`;

describe("parseHistoryForPriceHistory with multi-line warning_flags", () => {
  const content = `${HEADER}\n${row("a", PLAYWRIGHT_ERROR, "")}\n${row("b", "ok")}\n`;

  it("yields one row per logical record and no garbage rows", () => {
    const parsed = parseHistoryForPriceHistory([{ filename: "zao_signals_2026_07.csv", content }]);
    expect(content.split(/\r?\n/u).filter((l) => l.length > 0).length - 1).toBe(5); // what the old split saw
    expect(parsed.totalRawRows).toBe(2);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.every((r) => r.source === "booking" && r.checkin_date === "2026-07-01")).toBe(true);
  });

  it("keeps the fields after the multi-line value on the same row", () => {
    const [first] = parseHistoryForPriceHistory([{ filename: "zao_signals_2026_07.csv", content }]).rows;
    expect(first!.warning_flags).toBe(PLAYWRIGHT_ERROR);
    expect(first!.source_classification).toBe("navigation_failed");
    expect(first!.is_price_usable_for_dp_directional).toBe(false);
    expect(first!.normalized_total_price).toBeNull();
  });
});

// The scripts below run on import, so guard their history readers at the source level.
const HISTORY_READERS = [
  "src/scripts/runAutoRunnerOpsSummary.ts",
  "src/scripts/runCollectionCoverageReport.ts",
  "src/scripts/runInventoryPressureReport.ts",
  "src/scripts/runAutoRunnerMarketRefresh.ts",
  "src/scripts/buildAutoRunnerFreshDbSyncProposal.ts",
  "src/scripts/simulateWinterCoverage.ts",
  "src/scripts/runAutoRunner16xBManualLivePilot.ts",
  "src/services/priceHistorySignals.ts"
];

describe("history readers use quote-aware record splitting", () => {
  it.each(HISTORY_READERS)("%s", (path) => {
    const src = readFileSync(resolve(path), "utf8");
    expect(src).toMatch(/import \{ splitCsvRecords \} from "\.\.?\/(services\/)?historyCsvRecords";/u);
    // No history shard (file read or `content`) split on raw newlines.
    expect(src).not.toMatch(/(readFileSync\([^)]*(HISTORY_DIR|\.data\/history)[^)]*\)[^;\n]*|content)\.(trim\(\)\.)?split\(\/\\r\?\\n\//u);
  });
});

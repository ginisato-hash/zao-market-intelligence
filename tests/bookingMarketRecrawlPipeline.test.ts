import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runBookingMarketRecrawlPipeline.ts"), "utf8");
const PLIST_TEMPLATE = readFileSync(resolve(__dirname, "../ops/launchd/com.yuge.zmi.booking-market-recrawl.plist.template"), "utf8");

describe("Booking market recrawl pipeline safety", () => {
  it("fails closed when tracked history or BI data is dirty before the run", () => {
    expect(SCRIPT_SOURCE).toContain("aborted_preexisting_history_dirty");
    expect(SCRIPT_SOURCE).toContain("aborted_preexisting_bi_data_dirty");
    expect(SCRIPT_SOURCE).toContain("trackedDirtyFiles");
  });

  it("does not stage broad history, BI folders, or the whole repo", () => {
    expect(SCRIPT_SOURCE).not.toContain('["add", "--", ".data/history"');
    expect(SCRIPT_SOURCE).not.toContain('["add", "--", "apps/zmi-bi-web/data"');
    expect(SCRIPT_SOURCE).not.toMatch(/git",\s*\["add",\s*"\."\]/u);
    expect(SCRIPT_SOURCE).toContain("history_files_to_update");
    expect(SCRIPT_SOURCE).toContain("assertCachedScope");
  });

  it("aborts if cached files include unexpected generated artifacts", () => {
    for (const forbidden of [".data/reports/", ".data/debug/", ".data/backups/", ".data/state/", ".data/logs/"]) {
      expect(SCRIPT_SOURCE).toContain(forbidden);
    }
    expect(SCRIPT_SOURCE).toContain("aborted_unexpected_cached_files");
  });

  it("reports own-property guard fields explicitly", () => {
    expect(SCRIPT_SOURCE).toContain("own_property_rows");
    expect(SCRIPT_SOURCE).toContain("own_property_guard_passed");
    expect(SCRIPT_SOURCE).toContain("own_property_names_detected");
  });

  it("reports the scheduled run summary fields needed for ops review", () => {
    for (const key of [
      "batch_index",
      "selected_properties",
      "selected_checkins",
      "preview_pages",
      "candidate_total",
      "rows_appended",
      "duplicate_skipped",
      "conflict_skipped",
      "history_append_performed",
      "bi_export_check_ok",
      "commit_sha",
      "push_ok",
      "publish_ok",
      "publish_url",
      "state_next_batch_index"
    ]) {
      expect(SCRIPT_SOURCE).toContain(key);
    }
  });

  it("launchd template runs only the booking market recrawl pipeline on Tuesday and Friday 14:35", () => {
    expect(PLIST_TEMPLATE).toContain("com.yuge.zmi.booking-market-recrawl");
    expect(PLIST_TEMPLATE).toContain("npm run ops:booking-market-recrawl");
    expect(PLIST_TEMPLATE).toContain("<integer>2</integer>");
    expect(PLIST_TEMPLATE).toContain("<integer>5</integer>");
    expect(PLIST_TEMPLATE).toContain("<key>Hour</key><integer>14</integer><key>Minute</key><integer>35</integer>");
  });
});

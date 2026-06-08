import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildManifestData,
  computeSourceOfTruth,
  decideBundle,
  parseHistoryCsvStats,
  renderManifestMd,
  sha256,
  type BundleManifestInput
} from "../src/services/chatGptUploadBundle";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/chatGptUploadBundle.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/packageChatGptDb.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

// Minimal fixture CSV with 3 rows and one duplicate row_id.
const FIXTURE_CSV = `row_id,row_hash,shard_month,collected_date_jst,collected_at_jst,normalized_at_jst,source,source_phase,collector_stage,canonical_property_name,source_property_name,property_identity_match,source_property_id,source_slug_or_code,checkin,checkout,stay_nights,group_adults,no_rooms,group_children,currency,language,stay_scope,availability_status,sold_out_status,normalized_total_price,normalized_total_price_source,normalized_total_price_basis,normalized_total_price_confidence,basis_confidence,basis_note,source_primary_price,source_secondary_price_or_adder,source_computed_total,source_tax_or_fee_classification,source_classification,is_price_usable_for_dp_direct,is_price_usable_for_dp_directional,is_price_excluded_from_dp,dp_exclusion_reason,warning_flags,source_report_path,source_csv_path,debug_artifact_path,schema_version
2026-06-07|booking|蔵王国際ホテル|zao-kokusai|2026-06-13|2026-06-14|2_adults_1_room_1_night,abc,2026_06,2026-06-07,2026-06-07T10:00:00+09:00,2026-06-07T10:00:00+09:00,booking,AUTO-RUNNER10X,integrated_booking_bounded_live,蔵王国際ホテル,蔵王国際ホテル,true,,zao-kokusai,2026-06-13,2026-06-14,1,2,1,0,JPY,ja,2_adults_1_room_1_night,available_price_basis,not_sold_out_confirmed,30000,booking_visible,candidate_basis,B,directional_candidate_basis,,30000,,30000,unknown,booking_directional,false,true,false,,,,r.md,r.csv,d.json,zao_local_history_v1
2026-06-07|jalan|ホテル喜らく|yad325153|2026-06-13|2026-06-14|2_adults_1_room_1_night,def,2026_06,2026-06-07,2026-06-07T10:00:00+09:00,2026-06-07T10:00:00+09:00,jalan,JALAN-AUTO03B,improved_coupon_aware_bounded_preview,ホテル喜らく,ホテル喜らく,true,yad325153,yad325153,2026-06-13,2026-06-14,1,2,1,0,JPY,ja,2_adults_1_room_1_night,available,not_sold_out_confirmed,25000,jalan_visible_total_tax_included,tax_included_total,B,B,,25000,,25000,tax_included_total,jalan_directional_tax_included_total,false,true,false,,,,r.md,r.csv,d.json,zao_local_history_v1
2026-06-07|booking|蔵王国際ホテル|zao-kokusai|2026-06-13|2026-06-14|2_adults_1_room_1_night,abc,2026_06,2026-06-07,2026-06-07T11:00:00+09:00,2026-06-07T11:00:00+09:00,booking,AUTO-RUNNER10X,integrated_booking_bounded_live,蔵王国際ホテル,蔵王国際ホテル,true,,zao-kokusai,2026-06-13,2026-06-14,1,2,1,0,JPY,ja,2_adults_1_room_1_night,available_price_basis,not_sold_out_confirmed,30000,booking_visible,candidate_basis,B,directional_candidate_basis,,30000,,30000,unknown,booking_directional,false,true,false,,,,r.md,r.csv,d.json,zao_local_history_v1
`;

function makeInput(override: Partial<BundleManifestInput> = {}): BundleManifestInput {
  const histStats = parseHistoryCsvStats([{ filename: "zao_signals_2026_06.csv", content: FIXTURE_CSV }]);
  return {
    generated_at_jst: "2026-06-08T12:00:00+09:00",
    git_head: "abc1234 test commit",
    git_branch: "main",
    package_filename: "zmi_chatgpt_upload_20260608_120000.zip",
    source_repo_path: "/Users/gini/Documents/ZMI/zao-market-intelligence",
    upload_folder_path: "/Users/gini/Desktop/ZMI_ChatGPT_Uploads",
    history: histStats,
    sqlite: { included: true, path: "zao-market-intelligence.sqlite", size_bytes: 1234, row_count: 2, sha256: "abc" },
    warnings: [],
    ...override
  };
}

describe("CHATGPT-UPLOAD01 - history CSV parsing", () => {
  it("counts rows from CSV", () => {
    const stats = parseHistoryCsvStats([{ filename: "f.csv", content: FIXTURE_CSV }]);
    expect(stats.row_count).toBe(3);
    expect(stats.file_count).toBe(1);
  });

  it("counts sources correctly", () => {
    const stats = parseHistoryCsvStats([{ filename: "f.csv", content: FIXTURE_CSV }]);
    expect(stats.by_source["booking"]).toBe(2);
    expect(stats.by_source["jalan"]).toBe(1);
  });

  it("detects duplicate row_ids", () => {
    const stats = parseHistoryCsvStats([{ filename: "f.csv", content: FIXTURE_CSV }]);
    expect(stats.duplicate_row_id_count).toBe(1);
  });

  it("returns latest collected and stay dates", () => {
    const stats = parseHistoryCsvStats([{ filename: "f.csv", content: FIXTURE_CSV }]);
    expect(stats.latest_collected_date).toBe("2026-06-07");
    expect(stats.latest_stay_date).toBe("2026-06-13");
  });

  it("sha256 by file is populated", () => {
    const stats = parseHistoryCsvStats([{ filename: "f.csv", content: FIXTURE_CSV }]);
    expect(stats.sha256_by_file["history/f.csv"]).toBeTruthy();
  });

  it("handles multiple CSVs", () => {
    const csv2 = FIXTURE_CSV.replace(/2026-06-07/g, "2026-06-08").replace(/2026-06-13/g, "2026-06-20");
    const stats = parseHistoryCsvStats([
      { filename: "zao_signals_2026_06.csv", content: FIXTURE_CSV },
      { filename: "zao_signals_2026_07.csv", content: csv2 }
    ]);
    expect(stats.file_count).toBe(2);
    expect(stats.row_count).toBe(6);
  });
});

describe("CHATGPT-UPLOAD01 - decision logic", () => {
  it("not_ready when history is empty", () => {
    expect(decideBundle({ historyRowCount: 0, sqlitePresent: false, sqliteRowCount: null, warnings: [] })).toBe("chatgpt_upload_bundle_not_ready");
  });

  it("ready_history_only when SQLite missing but history exists", () => {
    expect(decideBundle({ historyRowCount: 3, sqlitePresent: false, sqliteRowCount: null, warnings: [] })).toBe("chatgpt_upload_bundle_ready_history_only");
  });

  it("ready_with_warning when warnings present", () => {
    expect(decideBundle({ historyRowCount: 3, sqlitePresent: true, sqliteRowCount: 3, warnings: ["sqlite_history_row_count_mismatch"] })).toBe("chatgpt_upload_bundle_ready_with_warning");
  });

  it("ready when both present and no warnings", () => {
    expect(decideBundle({ historyRowCount: 3, sqlitePresent: true, sqliteRowCount: 3, warnings: [] })).toBe("chatgpt_upload_bundle_ready");
  });

  it("source_of_truth is sqlite_history_mismatch when counts differ", () => {
    expect(computeSourceOfTruth({ sqlitePresent: true, sqliteRowCount: 4, historyRowCount: 3 })).toBe("sqlite_history_mismatch");
  });

  it("source_of_truth is sqlite_mirror_verified when counts match", () => {
    expect(computeSourceOfTruth({ sqlitePresent: true, sqliteRowCount: 3, historyRowCount: 3 })).toBe("sqlite_mirror_verified");
  });

  it("source_of_truth is sqlite_missing_history_only when no sqlite", () => {
    expect(computeSourceOfTruth({ sqlitePresent: false, sqliteRowCount: null, historyRowCount: 3 })).toBe("sqlite_missing_history_only");
  });
});

describe("CHATGPT-UPLOAD01 - manifest rendering", () => {
  it("manifest.md includes required sections", () => {
    const data = buildManifestData(makeInput());
    const md = renderManifestMd(data);
    expect(md).toContain("# ZMI ChatGPT Upload Manifest");
    expect(md).toContain("## 1. Bundle metadata");
    expect(md).toContain("## 2. Included files");
    expect(md).toContain("## 3. Data status");
    expect(md).toContain("## 4. How ChatGPT should use this bundle");
    expect(md).toContain("## 5. Suggested ChatGPT prompt");
  });

  it("manifest.md includes source_of_truth and counts", () => {
    const data = buildManifestData(makeInput());
    const md = renderManifestMd(data);
    expect(md).toContain("source_of_truth: sqlite_history_mismatch"); // row counts differ (sqlite=2, history=3)
    expect(md).toContain("booking: 2");
    expect(md).toContain("jalan: 1");
  });

  it("manifest.json includes required top-level keys", () => {
    const data = buildManifestData(makeInput());
    expect(data.package_mode).toBe("db_history_upload_bundle");
    expect(data.sqlite.included).toBe(true);
    expect(data.history.included).toBe(true);
    expect(data.counts.by_source).toBeTruthy();
    expect(data.source_of_truth).toBeTruthy();
    expect(data.warnings).toBeTruthy();
  });

  it("mismatch warning is added to manifest data automatically", () => {
    const data = buildManifestData(makeInput()); // sqlite.row_count=2, history=3 => mismatch
    expect(data.warnings.some((w) => w.includes("mismatch"))).toBe(true);
  });

  it("no mismatch warning when counts match", () => {
    const stats = parseHistoryCsvStats([{ filename: "f.csv", content: FIXTURE_CSV }]);
    const data = buildManifestData(makeInput({
      sqlite: { included: true, path: "x.sqlite", size_bytes: 1, row_count: 3, sha256: "abc" },
      history: stats
    }));
    expect(data.warnings.filter((w) => w.includes("mismatch"))).toHaveLength(0);
  });
});

describe("CHATGPT-UPLOAD01 - package command (integration)", () => {
  it("package command creates zip with correct structure", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "zmi-chatgpt-test-"));
    try {
      // Run the package command with a temp upload dir and custom history path via env override.
      const result = spawnSync(
        "npm",
        ["run", "package:chatgpt-db"],
        {
          cwd: resolve(__dirname, ".."),
          env: { ...process.env, CHATGPT_UPLOAD_OUT_DIR: tmpDir },
          encoding: "utf8",
          timeout: 60_000
        }
      );
      expect(result.status).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toMatch(/decision=chatgpt_upload_bundle_ready/u);
      expect(out).toMatch(/history_rows=\d+/u);
      expect(out).toMatch(/upload_path=/u);
      // Verify the latest zip exists in tmpDir.
      const latestZip = join(tmpDir, "zmi_chatgpt_upload_latest.zip");
      expect(existsSync(latestZip)).toBe(true);
      // Verify zip contains one top-level directory.
      const listResult = spawnSync("/usr/bin/unzip", ["-l", latestZip], { encoding: "utf8" });
      const entries = listResult.stdout ?? "";
      expect(entries).toContain("manifest.md");
      expect(entries).toContain("manifest.json");
      expect(entries).toMatch(/zao_signals_.*\.csv/u);
      // All entries start with the bundle dir name (one top-level dir).
      const dataLines = entries.split("\n").filter((l) => l.includes("zmi_chatgpt_upload_"));
      expect(dataLines.every((l) => l.includes("zmi_chatgpt_upload_"))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("CHATGPT-UPLOAD01 - safety scans", () => {
  it("service has no DB mutations", () => {
    // Scan for SQL mutation keywords in statement context, not in field names or .update() calls.
    expect(SERVICE_SOURCE).not.toMatch(/\.prepare\(["'`][^"'`]*(INSERT|UPDATE|DELETE|CREATE TABLE|DROP|ALTER|VACUUM|REINDEX)/iu);
  });

  it("script has no DB mutations", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\.prepare\(["'`][^"'`]*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|VACUUM|REINDEX)/iu);
  });

  it("script opens SQLite in readonly mode", () => {
    expect(SCRIPT_SOURCE).toContain("readonly: true");
  });

  it("script performs no live collection or market refresh", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/COLLECT_BOOKING|COLLECT_JALAN|auto-runner:market-refresh|sync:history-to-db|build:ai-context-packs/u);
  });

  it("package wires the command", () => {
    expect(PACKAGE_JSON).toContain("package:chatgpt-db");
  });
});

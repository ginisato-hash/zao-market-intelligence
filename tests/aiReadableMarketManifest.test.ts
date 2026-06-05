import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_WITHOUT_APPROVAL,
  HISTORY_SHARD_ENTRYPOINTS,
  buildAiReadableManifest,
  buildDemandIndexStatus,
  buildHistorySummary,
  decideAiReadableManifest,
  renderAiReadableManifestCsv,
  renderAiReadableManifestMarkdown
} from "../src/services/aiReadableMarketManifest";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/aiReadableMarketManifest.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAiReadableMarketManifest.ts"), "utf8");

const HISTORY_CSV = [
  "source,canonical_property_name,checkin,availability_status,sold_out_status,basis_confidence,is_price_usable_for_dp_direct,is_price_usable_for_dp_directional,is_price_excluded_from_dp",
  "jalan,蔵王国際ホテル,2026-08-10,available,available,A,true,false,false",
  "rakuten,ホテル松金屋アネックス,2026-08-10,sold_out,sold_out,B,false,true,false",
  "booking,深山荘 高見屋,2026-10-10,available,available,B,false,true,false",
  "booking,蔵王温泉とは,2026-10-11,not_listed,not_listed,none,false,false,true"
].join("\n") + "\n";

const DEMAND_JSON = JSON.stringify({
  summary: {
    decision: "zao_demand_index_design_basis_caution",
    demandRowCount: 3,
    demandBandCounts: { E_very_weak: 1, D_weak: 1, C_normal: 1 },
    pricingPostureCounts: { hold: 2, insufficient_data: 1 },
    congestionRankCounts: { E: 1, D: 1, C: 1 }
  },
  rows: [
    { checkinDate: "2026-08-10", demandBand: "C_normal" },
    { checkinDate: "2026-10-10", demandBand: "D_weak" },
    { checkinDate: "2026-12-01", demandBand: "E_very_weak" }
  ]
});

function manifest() {
  const historySummary = buildHistorySummary([
    { path: ".data/history/zao_signals_2026_08.csv", csv: HISTORY_CSV },
    { path: ".data/history/zao_signals_2026_10.csv", csv: HISTORY_CSV }
  ]);
  return buildAiReadableManifest({
    runId: "ai_readable_market_manifest_test",
    generatedAtJst: "2026-06-03T22:00:00+09:00",
    historySummary,
    demandIndexStatus: buildDemandIndexStatus(DEMAND_JSON)
  });
}

describe("AI-readable market manifest", () => {
  it("includes stable entrypoints and history shard list", () => {
    const m = manifest();
    expect(m.latest_entrypoints.aiManifest).toContain(".data/reports/market-update/ai_readable_market_manifest_latest.md");
    for (const shard of HISTORY_SHARD_ENTRYPOINTS) expect(m.latest_entrypoints.historyShards).toContain(shard);
    expect(m.latest_entrypoints.propertyUniverse).toContain(".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv");
  });

  it("summarizes history rows, sources, DP usage, confidence, availability, and shards", () => {
    const h = manifest().history_summary;
    expect(h.historyFileCount).toBe(2);
    expect(h.totalHistoryRows).toBe(8);
    expect(h.sourceCounts).toMatchObject({ jalan: 2, rakuten: 2, booking: 4 });
    expect(h.dpUsageCounts).toMatchObject({ direct: 2, directional: 4, excluded: 2 });
    expect(h.basisConfidenceCounts).toMatchObject({ A: 2, B: 4, none: 2 });
    expect(h.availabilityCounts).toMatchObject({ available: 4, sold_out: 2, not_listed: 2 });
    expect(h.propertyCount).toBe(4);
    expect(h.shardRowCounts).toHaveLength(2);
  });

  it("includes source status for Jalan, Rakuten, Booking, and Property Discovery", () => {
    const status = manifest().source_status;
    expect(status.Jalan?.status).toContain("strongest");
    expect(status.Rakuten?.notes).toContain("CHARGE_PER_HUMAN");
    expect(status.Booking?.notes).toContain("no synthetic Booking.com base");
    expect(status.PropertyDiscovery?.status).toContain("D01X-D05X complete");
  });

  it("represents Matsukaneya as resolved, not an unresolved caveat", () => {
    const m = manifest();
    expect(m.matsukaneya_merge_status.status).toBe("resolved");
    expect(m.resolved_issues.join("\n")).toContain("Matsukaneya duplicate canonical merge completed");
    expect(m.known_caveats.join("\n")).not.toContain("Matsukaneya");
  });

  it("includes DP01X summary and says no automated price update from DP01X", () => {
    const m = manifest();
    expect(m.demand_index_status.decision).toBe("zao_demand_index_design_basis_caution");
    expect(m.demand_index_status.demandRowCount).toBe(3);
    expect(m.known_caveats.join("\n")).toContain("No automated price update is allowed from DP01X.");
  });

  it("marks DP03X and R01X paused unless explicitly requested", () => {
    const text = renderAiReadableManifestMarkdown(manifest());
    expect(text).toContain("DP03X");
    expect(text).toContain("R01X");
    expect(text).toContain("paused unless");
  });

  it("states GitHub Actions and data repo push are not enabled", () => {
    const caveats = manifest().known_caveats.join("\n");
    expect(caveats).toContain("GitHub Actions automation is not enabled.");
    expect(caveats).toContain("Data repo push is not enabled.");
  });

  it("lists files not to modify without approval", () => {
    const m = manifest();
    for (const item of FORBIDDEN_WITHOUT_APPROVAL) expect(m.forbidden_without_approval).toContain(item);
  });

  it("JSON manifest includes required top-level keys", () => {
    const m = manifest();
    for (const key of [
      "run_id",
      "generated_at_jst",
      "project_status",
      "latest_entrypoints",
      "history_summary",
      "source_status",
      "property_discovery_status",
      "matsukaneya_merge_status",
      "demand_index_status",
      "known_caveats",
      "resolved_issues",
      "recommended_next_tasks",
      "paused_tasks",
      "forbidden_without_approval",
      "safe_readonly_commands",
      "safety_confirmation"
    ]) {
      expect(Object.prototype.hasOwnProperty.call(m, key)).toBe(true);
    }
  });

  it("latest pointer files are written as copies, not symlinks", () => {
    expect(SCRIPT_SOURCE).toContain("copyFileSync(reportPath, latestMarkdownPath)");
    expect(SCRIPT_SOURCE).toContain("copyFileSync(jsonPath, latestJsonPath)");
    expect(SCRIPT_SOURCE).not.toMatch(/symlinkSync/);
  });

  it("does not modify history or property master artifacts", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.data\/history/);
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.data\/exports\/zao-universe-review/);
    }
  });

  it("has no DB-write, GitHub Actions/GitOps activation, or Booking multiplier logic", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i);
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.github\/workflows/);
      expect(src).not.toMatch(/git\s+commit|git\s+push/);
      expect(src).not.toMatch(/\*\s*1\.1/);
    }
  });

  it("CSV has no PMS/upload columns and decision is basis_caution", () => {
    const m = manifest();
    const csv = renderAiReadableManifestCsv(m);
    expect(csv.split("\n")[0]).toBe("key,value");
    expect(csv.toLowerCase()).not.toMatch(/roomid|beds24|airhost|pms|price1/);
    expect(decideAiReadableManifest({ historyFileCount: 2, historyRowCount: 8, demandDecision: "zao_demand_index_design_basis_caution" })).toBe("ai_readable_market_manifest_basis_caution");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDryRunSummary,
  buildMappingIndex,
  renderDryRunCsv,
  renderDryRunReport,
  type PlannedTarget
} from "../src/services/plannedMarketRefresh";
import { buildScopePlan, type DemandConfig, type PlannerProperty, type ScopePlan } from "../src/services/collectionScopePlanner";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/plannedMarketRefresh.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runPlannedMarketRefreshDryRun.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const RUN_DATE = "2026-06-07";
const CONFIG: DemandConfig = {
  public_holidays: { "2026-07-20": "海の日" },
  long_weekend_dates: new Set(["2026-07-18"]),
  peak_periods: [{ code: "obon", from: "2026-08-13", to: "2026-08-16" }]
};

const BOOKING_PROPS: PlannerProperty[] = [
  { source: "booking", property_slug: "zao-kokusai", canonical_property_name: "蔵王国際ホテル" },
  { source: "booking", property_slug: "zao-shiki-no", canonical_property_name: "蔵王四季のホテル" },
  { source: "booking", property_slug: "shinzanso-takamiya", canonical_property_name: "深山荘 高見屋" }
];
const JALAN_PROPS: PlannerProperty[] = [
  { source: "jalan", property_slug: "yad325153", canonical_property_name: "ホテル喜らく" },
  { source: "jalan", property_slug: "yad328232", canonical_property_name: "ル・ベール蔵王" }
];
const DISABLED_PROPS: PlannerProperty[] = [
  { source: "rakuten", property_slug: "rk1", canonical_property_name: "楽天施設" }
];
const ALL_PROPS: PlannerProperty[] = [...BOOKING_PROPS, ...JALAN_PROPS, ...DISABLED_PROPS];

function plan(props = ALL_PROPS): ScopePlan {
  return buildScopePlan({ runDateIso: RUN_DATE, properties: props, config: CONFIG });
}

describe("AUTO-RUNNER15X-A - mapping", () => {
  it("builds mapping index from verified targets", () => {
    const idx = buildMappingIndex();
    expect(idx.booking.has("zao-kokusai")).toBe(true);
    expect(idx.jalan.has("yad325153")).toBe(true);
    expect(idx.booking.has("unknown-slug")).toBe(false);
  });

  it("converts planner selected targets to planned targets", () => {
    const p = plan();
    const summary = buildDryRunSummary(p, buildMappingIndex());
    expect(summary.mode).toBe("planner_driven_dry_run");
    const wouldCollect = summary.selected.filter((t) => t.dry_run_action === "would_collect");
    expect(wouldCollect.length).toBeGreaterThan(0);
    expect(wouldCollect.every((t) => t.source === "booking" || t.source === "jalan")).toBe(true);
  });

  it("excludes disabled sources as excluded_disabled_source", () => {
    const p = plan();
    const summary = buildDryRunSummary(p, buildMappingIndex());
    expect(summary.excluded_disabled_source.every((t) => t.dry_run_action === "excluded_disabled_source")).toBe(true);
    expect(summary.excluded_disabled_source.length).toBeGreaterThan(0);
  });

  it("classifies missing collector mapping safely", () => {
    const unknownProp: PlannerProperty = { source: "booking", property_slug: "no-such-hotel", canonical_property_name: "未知ホテル" };
    const p = buildScopePlan({ runDateIso: RUN_DATE, properties: [unknownProp], config: CONFIG });
    const summary = buildDryRunSummary(p, buildMappingIndex());
    const missing = summary.selected.filter((t) => t.dry_run_action === "excluded_missing_collector_mapping");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((t) => t.source === "booking")).toBe(true);
  });

  it("status is mapping_incomplete when some missing and some valid", () => {
    const unknownProp: PlannerProperty = { source: "booking", property_slug: "ghost-hotel", canonical_property_name: "幽霊ホテル" };
    const p = buildScopePlan({ runDateIso: RUN_DATE, properties: [...BOOKING_PROPS, unknownProp], config: CONFIG });
    const summary = buildDryRunSummary(p, buildMappingIndex());
    expect(summary.status).toBe("planned_market_refresh_mapping_incomplete");
  });

  it("status is ready when all selected targets have valid mappings", () => {
    const p = plan([...BOOKING_PROPS, ...JALAN_PROPS]);
    const summary = buildDryRunSummary(p, buildMappingIndex());
    const wouldCollect = summary.selected.filter((t) => t.dry_run_action === "would_collect");
    expect(wouldCollect.length).toBeGreaterThan(0);
    expect(summary.status).toBe("planned_market_refresh_dry_run_ready");
  });
});

describe("AUTO-RUNNER15X-A - dry-run enforcement", () => {
  it("summary has all false mutation flags", () => {
    const summary = buildDryRunSummary(plan(), buildMappingIndex());
    expect(summary.live_collection_executed).toBe(false);
    expect(summary.history_append_executed).toBe(false);
    expect(summary.db_sync_executed).toBe(false);
    expect(summary.ai_context_refresh_executed).toBe(false);
    expect(summary.pricing_output_executed).toBe(false);
  });

  it("page caps are preserved in output", () => {
    const summary = buildDryRunSummary(plan(), buildMappingIndex());
    const bookingPages = summary.pages_by_source["booking"] ?? 0;
    const jalanPages = summary.pages_by_source["jalan"] ?? 0;
    expect(bookingPages).toBeLessThanOrEqual(summary.page_caps.booking_daily_cap);
    expect(jalanPages).toBeLessThanOrEqual(summary.page_caps.jalan_daily_cap);
    expect(summary.estimated_total_pages).toBeLessThanOrEqual(summary.page_caps.total_daily_cap);
    expect(summary.page_caps.rakuten_daily_cap).toBe(0);
    expect(summary.page_caps.google_hotels_daily_cap).toBe(0);
  });

  it("Rakuten and Google are not in would_collect", () => {
    const summary = buildDryRunSummary(plan(), buildMappingIndex());
    const wouldCollect = summary.selected.filter((t) => t.dry_run_action === "would_collect");
    expect(wouldCollect.every((t) => t.source !== "rakuten" && t.source !== "google_hotels")).toBe(true);
  });
});

describe("AUTO-RUNNER15X-A - rendering", () => {
  it("CSV has the required header", () => {
    const summary = buildDryRunSummary(plan(), buildMappingIndex());
    const csv = renderDryRunCsv(summary.selected);
    expect(csv.split("\n")[0]).toContain("source,canonical_property_name,collector_property_key");
    expect(csv).toContain("would_collect");
  });

  it("report includes safety confirmation, scope, caps, roadmap", () => {
    const summary = buildDryRunSummary(plan(), buildMappingIndex());
    const text = renderDryRunReport(summary, "2026-06-07T11:00:00+09:00");
    expect(text).toContain("live_collection_executed: false");
    expect(text).toContain("history_append_executed: false");
    expect(text).toContain("rakuten_daily_cap");
    expect(text).toContain("15X-A complete");
    expect(text).toContain("12X scheduled run verification");
  });
});

describe("AUTO-RUNNER15X-A - safety scans", () => {
  it("service is pure (no I/O, browser, collector spawning)", () => {
    expect(SERVICE_SOURCE).not.toMatch(/child_process|execSync|readFileSync|writeFileSync|playwright|chromium/u);
  });

  it("script performs no live collection / mutation calls", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/COLLECT_BOOKING|COLLECT_JALAN|ZMI_AUTORUN_ENABLED=1|kickstart|bootstrap|sync:history-to-db|build:ai-context-packs|chromium/u);
  });

  it("package wires the planned dry-run script", () => {
    expect(PACKAGE_JSON).toContain("auto-runner:market-refresh:planned-dry-run");
  });
});

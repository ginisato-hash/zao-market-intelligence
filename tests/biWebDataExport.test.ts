import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BI_CSV_HEADERS,
  applyPeriodRetention,
  buildBiMetadata,
  getCurrentPeriodKeyJst,
  halfOf,
  latestObservations,
  normalizeAvailability,
  periodKey,
  periodLabel,
  pickDefaultPeriodKey,
  sortPeriodKeys,
  unifyByPropertyCheckin,
  renderUnifiedCsv,
  type BiHistoryRow,
  type UnifiedRow
} from "../src/services/biWebDataExport";

const INDEX_HTML = readFileSync(resolve(__dirname, "../apps/zmi-bi-web/index.html"), "utf8");
const APP_JS = readFileSync(resolve(__dirname, "../apps/zmi-bi-web/assets/app.js"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/exportBiWebData.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function row(over: Partial<BiHistoryRow>): BiHistoryRow {
  return {
    source: "jalan",
    canonical_property_name: "三浦屋",
    source_slug_or_code: "yad302145",
    checkin: "2026-07-18",
    checkout: "2026-07-19",
    availability_status: "available",
    normalized_total_price: 20000,
    is_price_usable_for_dp_directional: true,
    collected_at_jst: "2026-06-14T10:00:00+09:00",
    tier: "tier_budget_small",
    ...over
  };
}

describe("ZMI BI export - availability unification", () => {
  it("normalizes statuses", () => {
    expect(normalizeAvailability("available")).toBe("available");
    expect(normalizeAvailability("available_price_basis")).toBe("available");
    expect(normalizeAvailability("sold_out")).toBe("sold_out");
    expect(normalizeAvailability("not_found")).toBe("not_found");
    expect(normalizeAvailability("failed")).toBe("excluded");
    expect(normalizeAvailability("unavailable_or_unknown")).toBe("excluded");
  });

  it("available if any source available", () => {
    const u = unifyByPropertyCheckin([
      row({ source: "booking", availability_status: "sold_out", normalized_total_price: null, is_price_usable_for_dp_directional: false }),
      row({ source: "jalan", availability_status: "available", normalized_total_price: 20000, is_price_usable_for_dp_directional: true })
    ]);
    expect(u).toHaveLength(1);
    expect(u[0]!.unified_availability_status).toBe("available");
    expect(u[0]!.available_source_count).toBe(1);
    expect(u[0]!.sold_out_source_count).toBe(1);
    expect(u[0]!.source_count).toBe(2);
  });

  it("sold_out if no available but some sold_out", () => {
    const u = unifyByPropertyCheckin([
      row({ source: "booking", availability_status: "sold_out", normalized_total_price: null, is_price_usable_for_dp_directional: false }),
      row({ source: "rakuten", availability_status: "sold_out", normalized_total_price: null, is_price_usable_for_dp_directional: false })
    ]);
    expect(u[0]!.unified_availability_status).toBe("sold_out");
  });

  it("not_found when only not_found", () => {
    const u = unifyByPropertyCheckin([row({ availability_status: "not_found", normalized_total_price: null, is_price_usable_for_dp_directional: false })]);
    expect(u[0]!.unified_availability_status).toBe("not_found");
  });

  it("excluded when only failed/excluded", () => {
    const u = unifyByPropertyCheckin([row({ availability_status: "failed", normalized_total_price: null, is_price_usable_for_dp_directional: false })]);
    expect(u[0]!.unified_availability_status).toBe("excluded");
  });
});

describe("ZMI BI export - latest observation", () => {
  it("keeps latest per (source, property, checkin)", () => {
    const latest = latestObservations([
      row({ source: "jalan", availability_status: "available", collected_at_jst: "2026-06-13T09:00:00+09:00" }),
      row({ source: "jalan", availability_status: "sold_out", collected_at_jst: "2026-06-14T09:00:00+09:00" })
    ]);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.availability_status).toBe("sold_out");
  });
});

describe("ZMI BI export - price aggregation & confidence", () => {
  it("median/avg from usable directional prices only, when available", () => {
    const u = unifyByPropertyCheckin([
      row({ source: "booking", normalized_total_price: 30000, is_price_usable_for_dp_directional: true }),
      row({ source: "jalan", normalized_total_price: 20000, is_price_usable_for_dp_directional: true }),
      row({ source: "rakuten", normalized_total_price: 99999, is_price_usable_for_dp_directional: false })
    ]);
    expect(u[0]!.price_sample_count).toBe(2);
    expect(u[0]!.median_directional_price).toBe(25000);
    expect(u[0]!.avg_directional_price).toBe(25000);
    expect(u[0]!.price_confidence).toBe("high");
  });

  it("price_confidence medium for single sample, low for none", () => {
    const one = unifyByPropertyCheckin([row({ normalized_total_price: 20000, is_price_usable_for_dp_directional: true })]);
    expect(one[0]!.price_confidence).toBe("medium");
    const none = unifyByPropertyCheckin([row({ availability_status: "sold_out", normalized_total_price: null, is_price_usable_for_dp_directional: false })]);
    expect(none[0]!.price_confidence).toBe("low");
  });

  it("inventory_confidence from source_count", () => {
    const two = unifyByPropertyCheckin([row({ source: "booking" }), row({ source: "jalan" })]);
    expect(two[0]!.inventory_confidence).toBe("high");
    const one = unifyByPropertyCheckin([row({ source: "jalan" })]);
    expect(one[0]!.inventory_confidence).toBe("medium");
  });

  it("no price when not available (sold_out) even if a stale price exists", () => {
    const u = unifyByPropertyCheckin([
      row({ source: "booking", availability_status: "sold_out", normalized_total_price: 30000, is_price_usable_for_dp_directional: true }),
      row({ source: "jalan", availability_status: "sold_out", normalized_total_price: null, is_price_usable_for_dp_directional: false })
    ]);
    expect(u[0]!.unified_availability_status).toBe("sold_out");
    expect(u[0]!.price_sample_count).toBe(0);
    expect(u[0]!.median_directional_price).toBeNull();
  });
});

describe("ZMI BI export - period selector", () => {
  it("early/late split at day 15", () => {
    expect(halfOf("2026-06-15")).toBe("early");
    expect(halfOf("2026-06-16")).toBe("late");
    expect(periodKey("2026-06-03")).toBe("2026-06_early");
    expect(periodKey("2026-06-20")).toBe("2026-06_late");
  });
  it("period label", () => {
    expect(periodLabel("2026-06_early")).toBe("2026年6月 上旬（1〜15日）");
    expect(periodLabel("2026-07_late")).toBe("2026年7月 下旬（16〜末日）");
  });
});

describe("ZMI BI export - flags, csv, metadata", () => {
  it("flags room-only comps and own properties", () => {
    const u = unifyByPropertyCheckin([
      row({ canonical_property_name: "HAMMOND", source: "jalan" }),
      row({ canonical_property_name: "三浦屋", source: "jalan" }),
      row({ canonical_property_name: "蔵王国際ホテル", source: "jalan" })
    ]);
    const byName = (n: string) => u.find((r) => r.canonical_property_name === n)!;
    expect(byName("HAMMOND").is_room_only_comp).toBe(true);
    expect(byName("HAMMOND").is_own_property).toBe(false);
    expect(byName("三浦屋").is_own_property).toBe(true);
    expect(byName("蔵王国際ホテル").is_room_only_comp).toBe(false);
  });

  it("csv header matches the required schema exactly", () => {
    const csv = renderUnifiedCsv(unifyByPropertyCheckin([row({})]));
    const header = csv.split("\n")[0];
    expect(header).toBe("period_key,period_label,checkin,canonical_property_name,unified_availability_status,source_count,available_source_count,sold_out_source_count,no_data_source_count,median_directional_price,avg_directional_price,price_sample_count,price_confidence,inventory_confidence,latest_collected_at_jst,is_room_only_comp,is_own_property,tier");
    expect(BI_CSV_HEADERS.length).toBe(18);
  });

  it("metadata contains latest_collected_at_jst and policy, no external data", () => {
    const latest = latestObservations([row({ source: "jalan", collected_at_jst: "2026-06-14T12:00:00+09:00" }), row({ source: "booking", collected_at_jst: "2026-06-14T08:00:00+09:00" })]);
    const unified = unifyByPropertyCheckin(latest);
    const retention = applyPeriodRetention(unified, new Date("2026-06-14T04:00:00Z"));
    const meta = buildBiMetadata({ generatedAtJst: "2026-06-14T13:00:00+09:00", historyRowsTotal: 2, latest, unifiedBeforeRetention: unified, retention });
    expect(meta.latest_collected_at_jst).toBe("2026-06-14T12:00:00+09:00");
    expect(meta.sources_included).toEqual(["booking", "jalan"]);
    expect(meta.data_policy).toContain("All sources unified");
    expect(meta.unified_rows).toBe(1);
  });

  it("export script is read-only (no append/sync/refresh/publish/pricing/pms)", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/appendHistoryRowsAtomic|sync:history-to-db|build:ai-context-packs|publish:chatgpt-db|beds24|airhost|pricing_recommendation/iu);
  });
});

describe("ZMI BI export - period retention", () => {
  function uRow(period_key: string, checkin: string): UnifiedRow {
    return {
      period_key, period_label: period_key, checkin, canonical_property_name: "X",
      unified_availability_status: "available", source_count: 1, available_source_count: 1,
      sold_out_source_count: 0, no_data_source_count: 0, median_directional_price: 10000,
      avg_directional_price: 10000, price_sample_count: 1, price_confidence: "medium",
      inventory_confidence: "medium", latest_collected_at_jst: "2026-06-14T12:00:00+09:00",
      is_room_only_comp: false, is_own_property: false, tier: "tier_budget_small"
    };
  }
  // synthetic universe spanning many periods
  const rows: UnifiedRow[] = [
    "2026-04_early", "2026-04_late", "2026-05_early", "2026-05_late",
    "2026-06_early", "2026-06_late", "2026-07_early", "2026-08_early"
  ].map((k) => uRow(k, k.endsWith("early") ? `${k.slice(0, 7)}-05` : `${k.slice(0, 7)}-20`));

  it("getCurrentPeriodKeyJst maps a JST date to its period", () => {
    expect(getCurrentPeriodKeyJst(new Date("2026-06-14T01:00:00Z"))).toBe("2026-06_early"); // 10:00 JST 14th
    expect(getCurrentPeriodKeyJst(new Date("2026-06-16T01:00:00Z"))).toBe("2026-06_late");
  });

  it("sortPeriodKeys orders chronologically", () => {
    expect(sortPeriodKeys(["2026-07_early", "2026-06_late", "2026-06_early"])).toEqual(["2026-06_early", "2026-06_late", "2026-07_early"]);
  });

  it("pickDefaultPeriodKey prefers current, else next future, else latest", () => {
    const keys = sortPeriodKeys(rows.map((r) => r.period_key));
    expect(pickDefaultPeriodKey(keys, "2026-06_late")).toBe("2026-06_late");
    expect(pickDefaultPeriodKey(keys, "2026-05_15_missing")).not.toBe(""); // falls to next/latest
    expect(pickDefaultPeriodKey(keys, "2026-09_early")).toBe("2026-08_early"); // no future → latest
    expect(pickDefaultPeriodKey(["2026-06_early", "2026-08_early"], "2026-07_early")).toBe("2026-08_early"); // next future
  });

  it("retains default + 3 previous + all future; drops older", () => {
    // current period 2026-06_late (16th)
    const r = applyPeriodRetention(rows, new Date("2026-06-16T01:00:00Z"));
    expect(r.current_period_key_jst).toBe("2026-06_late");
    expect(r.default_period_key).toBe("2026-06_late");
    // default index (2026-06_late) - 3 = 2026-05_early; keep from there + all future
    expect(r.retained_period_keys.sort()).toEqual(
      ["2026-05_early", "2026-05_late", "2026-06_early", "2026-06_late", "2026-07_early", "2026-08_early"].sort()
    );
    expect(r.dropped_past_period_keys).toEqual(["2026-04_early", "2026-04_late"]);
    expect(r.retainedRows.every((x) => x.period_key >= "2026-05")).toBe(true);
    // no retained row is from a dropped period
    expect(r.retainedRows.some((x) => x.period_key.startsWith("2026-04"))).toBe(false);
  });

  it("retains all when fewer than 3 past periods exist", () => {
    const few = [uRow("2026-06_early", "2026-06-05"), uRow("2026-06_late", "2026-06-20")];
    const r = applyPeriodRetention(few, new Date("2026-06-16T01:00:00Z"));
    expect(r.dropped_past_period_keys).toEqual([]);
    expect(r.retainedRows).toHaveLength(2);
  });

  it("metadata exposes retention fields", () => {
    const latest = [{ source: "jalan", canonical_property_name: "X", source_slug_or_code: "x", checkin: "2026-06-20", checkout: "", availability_status: "available", normalized_total_price: 10000, is_price_usable_for_dp_directional: true, collected_at_jst: "2026-06-14T12:00:00+09:00", tier: "t" }];
    const retention = applyPeriodRetention(rows, new Date("2026-06-16T01:00:00Z"));
    const meta = buildBiMetadata({ generatedAtJst: "g", historyRowsTotal: 1, latest, unifiedBeforeRetention: rows, retention });
    expect(meta.current_period_key_jst).toBe("2026-06_late");
    expect(meta.default_period_key).toBe("2026-06_late");
    expect(meta.retention_previous_periods).toBe(3);
    expect(meta.retained_period_keys.length).toBeGreaterThan(0);
    expect(meta.dropped_past_period_keys_count).toBe(2);
    expect(meta.unified_rows_before_retention).toBe(rows.length);
    expect(meta.period_retention_policy).toContain("3_previous_periods");
  });
});

describe("ZMI BI web - HTML static checks (no source selector)", () => {
  it("index.html does not contain a data-source selector (sourceSelect)", () => {
    expect(INDEX_HTML).not.toContain("sourceSelect");
    expect(INDEX_HTML).not.toMatch(/<option>\s*booking\s*<\/option>/u);
  });
  it("index.html shows 全ソース統合", () => {
    expect(INDEX_HTML).toContain("全ソース統合");
  });
  it("app.js does not expose a data source selector", () => {
    expect(APP_JS).not.toContain("sourceSelect");
    expect(APP_JS).not.toMatch(/source:\s*document\.querySelector/u);
  });
  it("package wires bi:web scripts", () => {
    expect(PACKAGE_JSON).toContain('"bi:web:export"');
    expect(PACKAGE_JSON).toContain('"bi:web:publish"');
    expect(PACKAGE_JSON).toContain('"bi:web:serve"');
    expect(PACKAGE_JSON).toContain('"bi:web:check"');
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROOM_ONLY_COMPETITORS,
  buildDateInventoryRow,
  buildInventoryKpiReport,
  buildPricePressureRows,
  classifyAvailability,
  competitorStatus,
  judgeInventoryPressure,
  latestObservations,
  renderInventoryCsv,
  renderInventoryReport,
  type InventoryHistoryRow
} from "../src/services/inventoryPressureKpi";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/inventoryPressureKpi.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runInventoryPressureReport.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function row(over: Partial<InventoryHistoryRow>): InventoryHistoryRow {
  return {
    source: "jalan",
    canonical_property_name: "蔵王国際ホテル",
    checkin: "2026-07-18",
    availability_status: "available",
    collected_at_jst: "2026-06-14T01:00:00+09:00",
    normalized_total_price: null,
    is_price_usable_for_dp_directional: false,
    ...over
  };
}

describe("ZMI Inventory KPI - availability classification", () => {
  it("maps statuses to inventory buckets", () => {
    expect(classifyAvailability("available")).toBe("available");
    expect(classifyAvailability("available_price_basis")).toBe("available");
    expect(classifyAvailability("sold_out")).toBe("sold_out");
    expect(classifyAvailability("not_found")).toBe("not_found");
    expect(classifyAvailability("failed")).toBe("excluded");
    expect(classifyAvailability("unavailable_or_unknown")).toBe("excluded");
    expect(classifyAvailability("")).toBe("excluded");
  });

  it("keeps only the latest observation per (source, property, checkin)", () => {
    const rows = [
      row({ source: "jalan", canonical_property_name: "X", checkin: "2026-07-18", availability_status: "available", collected_at_jst: "2026-06-13T09:00:00+09:00" }),
      row({ source: "jalan", canonical_property_name: "X", checkin: "2026-07-18", availability_status: "sold_out", collected_at_jst: "2026-06-14T09:00:00+09:00" })
    ];
    const latest = latestObservations(rows);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.availability_status).toBe("sold_out");
  });

  it("collapses competitor source rows: available wins, else sold_out, else no_data", () => {
    expect(competitorStatus([row({ availability_status: "sold_out" }), row({ source: "booking", availability_status: "available_price_basis" })])).toBe("available");
    expect(competitorStatus([row({ availability_status: "sold_out" }), row({ source: "booking", availability_status: "sold_out" })])).toBe("sold_out");
    expect(competitorStatus([row({ availability_status: "failed" })])).toBe("no_data");
    expect(competitorStatus([])).toBe("no_data");
  });
});

describe("ZMI Inventory KPI - pressure judgment", () => {
  it("strong when area sold-out rate >= 40%", () => {
    expect(judgeInventoryPressure({ areaSoldOutRate: 0.4, competitorStatuses: ["available", "available", "available"] })).toBe("strong_inventory_pressure");
  });

  it("strong when >= 2 competitors sold out (even if area rate low)", () => {
    expect(judgeInventoryPressure({ areaSoldOutRate: 0.05, competitorStatuses: ["sold_out", "sold_out", "available"] })).toBe("strong_inventory_pressure");
  });

  it("medium when area rate in [20%,40%)", () => {
    expect(judgeInventoryPressure({ areaSoldOutRate: 0.2, competitorStatuses: ["available", "available", "available"] })).toBe("medium_inventory_pressure");
    expect(judgeInventoryPressure({ areaSoldOutRate: 0.39, competitorStatuses: ["available", "available", "available"] })).toBe("medium_inventory_pressure");
  });

  it("medium when exactly 1 competitor sold out", () => {
    expect(judgeInventoryPressure({ areaSoldOutRate: 0.0, competitorStatuses: ["sold_out", "available", "available"] })).toBe("medium_inventory_pressure");
  });

  it("weak when area rate < 20% and all comps available", () => {
    expect(judgeInventoryPressure({ areaSoldOutRate: 0.1, competitorStatuses: ["available", "available", "available"] })).toBe("weak_inventory_pressure");
  });

  it("weak (not medium) when low area rate, no comp sold out, but some comp has no data", () => {
    expect(judgeInventoryPressure({ areaSoldOutRate: 0.1, competitorStatuses: ["available", "no_data", "no_data"] })).toBe("weak_inventory_pressure");
  });

  it("comp sold-out count overrides a weak area rate up to strong", () => {
    // 1 sold out -> medium; 2 sold out -> strong, regardless of area rate
    expect(judgeInventoryPressure({ areaSoldOutRate: 0.0, competitorStatuses: ["sold_out", "no_data", "no_data"] })).toBe("medium_inventory_pressure");
  });
});

describe("ZMI Inventory KPI - date row + KPIs", () => {
  it("computes area counts, sold-out rate, and comp counts", () => {
    const rows = [
      row({ canonical_property_name: "A", availability_status: "available" }),
      row({ canonical_property_name: "B", availability_status: "available" }),
      row({ canonical_property_name: "C", availability_status: "sold_out" }),
      row({ canonical_property_name: "D", availability_status: "not_found" }),
      row({ canonical_property_name: "E", availability_status: "failed" }),
      row({ canonical_property_name: "HAMMOND", availability_status: "sold_out" }),
      row({ canonical_property_name: "吉田屋", availability_status: "available" })
    ];
    const d = buildDateInventoryRow("2026-07-18", rows);
    expect(d.area_available_count).toBe(3); // A,B,吉田屋
    expect(d.area_sold_out_count).toBe(2); // C, HAMMOND
    expect(d.area_not_found_count).toBe(1);
    expect(d.area_excluded_count).toBe(1);
    expect(d.area_sold_out_rate).toBeCloseTo(2 / 5, 4);
    expect(d.competitor_status["HAMMOND"]).toBe("sold_out");
    expect(d.competitor_status["吉田屋"]).toBe("available");
    expect(d.competitor_status["ONSEN & STAY OAKHILL"]).toBe("no_data");
    expect(d.room_only_comp_sold_out_count).toBe(1);
    expect(d.room_only_comp_available_count).toBe(1);
  });

  it("sold-out rate is 0 when no bookable inventory (avoids divide-by-zero)", () => {
    const d = buildDateInventoryRow("2026-07-18", [row({ availability_status: "not_found" })]);
    expect(d.area_sold_out_rate).toBe(0);
  });

  it("emits inventory-first recommended actions per level", () => {
    const strong = buildDateInventoryRow("2026-07-18", [row({ canonical_property_name: "HAMMOND", availability_status: "sold_out" }), row({ canonical_property_name: "吉田屋", availability_status: "sold_out" })]);
    expect(strong.inventory_pressure_level).toBe("strong_inventory_pressure");
    expect(strong.recommended_action_for_kiraku).toMatch(/hold_or_raise/);
    expect(strong.recommended_action_for_miuraya).toMatch(/raise_or_hold/);
  });
});

describe("ZMI Inventory KPI - report assembly", () => {
  const rows = [
    // 2026-07-18: strong (2 comps sold out)
    row({ canonical_property_name: "HAMMOND", checkin: "2026-07-18", availability_status: "sold_out" }),
    row({ canonical_property_name: "吉田屋", checkin: "2026-07-18", availability_status: "sold_out" }),
    row({ canonical_property_name: "蔵王国際ホテル", checkin: "2026-07-18", availability_status: "available" }),
    // 2026-08-10: weak (all available, low area rate)
    row({ canonical_property_name: "HAMMOND", checkin: "2026-08-10", availability_status: "available" }),
    row({ canonical_property_name: "吉田屋", checkin: "2026-08-10", availability_status: "available" }),
    row({ canonical_property_name: "ONSEN & STAY OAKHILL", checkin: "2026-08-10", availability_status: "available" }),
    row({ canonical_property_name: "蔵王四季のホテル", checkin: "2026-08-10", availability_status: "available", is_price_usable_for_dp_directional: true, normalized_total_price: 30000 })
  ];

  it("builds a report with one row per checkin, sorted", () => {
    const report = buildInventoryKpiReport({ rows, generatedAtJst: "2026-06-14T02:00:00+09:00" });
    expect(report.rows.map((r) => r.checkin)).toEqual(["2026-07-18", "2026-08-10"]);
    expect(report.rows[0]!.inventory_pressure_level).toBe("strong_inventory_pressure");
    expect(report.rows[1]!.inventory_pressure_level).toBe("weak_inventory_pressure");
    expect(report.summary.distinct_checkins).toBe(2);
    expect(report.summary.room_only_comp_sold_out_observations).toBe(2);
    expect(report.summary.level_counts.strong_inventory_pressure).toBe(1);
  });

  it("price pressure is computed only from usable directional rows", () => {
    const pp = buildPricePressureRows(rows);
    const aug = pp.find((p) => p.checkin === "2026-08-10");
    expect(aug?.directional_sample_count).toBe(1);
    expect(aug?.median_directional_price).toBe(30000);
    expect(pp.find((p) => p.checkin === "2026-07-18")).toBeUndefined();
  });

  it("report renders inventory sections BEFORE price (inventory-first order)", () => {
    const report = buildInventoryKpiReport({ rows, generatedAtJst: "2026-06-14T02:00:00+09:00" });
    const md = renderInventoryReport({ report, pricePressure: buildPricePressureRows(rows) });
    const iInvSummary = md.indexOf("## 1. Inventory KPI Summary");
    const iDateTable = md.indexOf("## 2. Date-level Inventory Pressure Table");
    const iComp = md.indexOf("## 3. Room-only Competitor Inventory");
    const iPrice = md.indexOf("## 4. Price Pressure");
    const iKiraku = md.indexOf("## 5. 喜らく判断");
    const iMiuraya = md.indexOf("## 6. 三浦屋判断");
    expect(iInvSummary).toBeGreaterThan(-1);
    expect(iInvSummary).toBeLessThan(iDateTable);
    expect(iDateTable).toBeLessThan(iComp);
    expect(iComp).toBeLessThan(iPrice); // inventory before price
    expect(iPrice).toBeLessThan(iKiraku);
    expect(iKiraku).toBeLessThan(iMiuraya);
  });

  it("csv has the specified inventory headers and one row per checkin", () => {
    const report = buildInventoryKpiReport({ rows, generatedAtJst: "2026-06-14T02:00:00+09:00" });
    const csv = renderInventoryCsv(report);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("checkin,area_available_count,area_sold_out_count,area_sold_out_rate");
    expect(lines[0]).toContain("HAMMOND_status,OAKHILL_status,吉田屋_status,inventory_pressure_level,recommended_action_for_kiraku,recommended_action_for_miuraya");
    expect(lines).toHaveLength(3); // header + 2 checkins
  });
});

describe("ZMI Inventory KPI - constants & safety", () => {
  it("room-only competitors are HAMMOND / OAKHILL / 吉田屋", () => {
    expect([...ROOM_ONLY_COMPETITORS]).toEqual(["HAMMOND", "ONSEN & STAY OAKHILL", "吉田屋"]);
  });

  it("report runner is read-only: no append/sync/refresh/publish/pricing/pms", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/appendHistoryRowsAtomic|sync:history-to-db|build:ai-context-packs|publish:chatgpt-db|spawnSync|beds24|airhost|pricing_recommendation/iu);
    expect(SERVICE_SOURCE).not.toMatch(/beds24|airhost|pricing_recommendation|price_update/iu);
  });

  it("package wires report:inventory-kpi", () => {
    expect(PACKAGE_JSON).toContain('"report:inventory-kpi"');
  });
});

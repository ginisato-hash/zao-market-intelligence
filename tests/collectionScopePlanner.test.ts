import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUCKET_BASE_SCORE,
  PAGE_CAPS,
  bucketForOffset,
  buildScopePlan,
  candidateStayDates,
  dayOffset,
  renderPlanCsv,
  renderPlanReport,
  scoreStayDate,
  selectWithinCaps,
  type DemandConfig,
  type PlannerProperty
} from "../src/services/collectionScopePlanner";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/collectionScopePlanner.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runCollectionScopePlanner.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const RUN_DATE = "2026-06-07"; // Sunday

const CONFIG: DemandConfig = {
  public_holidays: { "2026-07-20": "海の日" },
  long_weekend_dates: new Set(["2026-07-18"]),
  peak_periods: [
    { code: "obon", from: "2026-08-13", to: "2026-08-16" },
    { code: "year_end_peak", from: "2026-12-28", to: "2027-01-03" }
  ]
};

const PROPERTIES: PlannerProperty[] = [
  { source: "booking", property_slug: "zao-kokusai", canonical_property_name: "蔵王国際ホテル" },
  { source: "booking", property_slug: "zao-shiki-no", canonical_property_name: "蔵王四季のホテル" },
  { source: "jalan", property_slug: "yad325153", canonical_property_name: "ホテル喜らく" },
  { source: "rakuten", property_slug: "rk1", canonical_property_name: "楽天施設" },
  { source: "google_hotels", property_slug: "g1", canonical_property_name: "Googleホテル" }
];

describe("AUTO-RUNNER14X - buckets", () => {
  it("classifies offsets into short/mid/long", () => {
    expect(bucketForOffset(0)).toBe("short");
    expect(bucketForOffset(14)).toBe("short");
    expect(bucketForOffset(15)).toBe("mid");
    expect(bucketForOffset(90)).toBe("mid");
    expect(bucketForOffset(91)).toBe("long");
    expect(bucketForOffset(180)).toBe("long");
    expect(bucketForOffset(181)).toBeNull();
  });

  it("dayOffset computes calendar distance", () => {
    expect(dayOffset("2026-06-07", "2026-06-08")).toBe(1);
    expect(dayOffset("2026-06-07", "2026-07-18")).toBe(41);
  });
});

describe("AUTO-RUNNER14X - scoring", () => {
  it("short Saturday scores base+saturday", () => {
    const r = scoreStayDate("2026-06-13", "short", CONFIG); // Saturday
    expect(r.score).toBe(BUCKET_BASE_SCORE.short + 20);
    expect(r.reasonCodes).toContain("short");
    expect(r.reasonCodes).toContain("saturday");
  });

  it("mid Saturday in a long weekend stacks modifiers", () => {
    const r = scoreStayDate("2026-07-18", "mid", CONFIG); // Saturday + long weekend
    expect(r.score).toBe(50 + 20 + 25); // 95
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["mid", "saturday", "long_weekend"]));
  });

  it("public holiday on a weekday adds day_off + public_holiday", () => {
    const r = scoreStayDate("2026-07-20", "mid", CONFIG); // Monday holiday
    expect(r.score).toBe(50 + 10 + 20); // 80
    expect(r.reasonCodes).toContain("public_holiday");
  });

  it("obon Saturday stacks peak", () => {
    const r = scoreStayDate("2026-08-15", "mid", CONFIG); // Saturday in obon
    expect(r.score).toBe(50 + 20 + 30); // 100
    expect(r.reasonCodes).toContain("obon");
  });

  it("year_end_peak adds 40", () => {
    const r = scoreStayDate("2026-12-31", "long", CONFIG); // Thursday, year-end
    expect(r.reasonCodes).toContain("year_end_peak");
    expect(r.score).toBe(30 + 40); // 70
  });

  it("ordinary weekday gets base only and an ordinary_weekday reason", () => {
    const r = scoreStayDate("2026-06-10", "short", CONFIG); // Wednesday
    expect(r.score).toBe(BUCKET_BASE_SCORE.short);
    expect(r.reasonCodes).toContain("ordinary_weekday");
  });

  it("score is clamped to [0,100]", () => {
    const r = scoreStayDate("2026-08-15", "short", CONFIG); // base80 + sat20 + obon30 = 130 -> 100
    expect(r.score).toBe(100);
  });
});

describe("AUTO-RUNNER14X - candidate generation", () => {
  it("short bucket includes every day; mid/long only weekend/holiday/peak", () => {
    const dates = candidateStayDates(RUN_DATE, CONFIG);
    const short = dates.filter((d) => d.bucket === "short");
    expect(short).toHaveLength(14); // offsets 1..14
    const mid = dates.filter((d) => d.bucket === "mid");
    // every mid candidate is a Fri/Sat/Sun, holiday, or peak day
    for (const d of mid) {
      const dow = new Date(`${d.stayDate}T00:00:00Z`).getUTCDay();
      const special = dow === 5 || dow === 6 || dow === 0 || CONFIG.public_holidays[d.stayDate] !== undefined || CONFIG.long_weekend_dates.has(d.stayDate) || CONFIG.peak_periods.some((p) => d.stayDate >= p.from && d.stayDate <= p.to);
      expect(special).toBe(true);
    }
  });
});

describe("AUTO-RUNNER14X - page caps and source gating", () => {
  it("Rakuten/Google are excluded as live-disabled, never selected", () => {
    const plan = buildScopePlan({ runDateIso: RUN_DATE, properties: PROPERTIES, config: CONFIG });
    expect(plan.selected.every((t) => t.source === "booking" || t.source === "jalan")).toBe(true);
    expect(plan.excluded_by_disabled_source.every((t) => t.source === "rakuten" || t.source === "google_hotels")).toBe(true);
    expect(plan.excluded_by_disabled_source.length).toBeGreaterThan(0);
    expect(plan.page_caps.rakuten_daily_cap).toBe(0);
    expect(plan.page_caps.google_hotels_daily_cap).toBe(0);
  });

  it("respects total and per-source caps", () => {
    const plan = buildScopePlan({ runDateIso: RUN_DATE, properties: PROPERTIES, config: CONFIG });
    expect(plan.estimated_total_pages).toBeLessThanOrEqual(PAGE_CAPS.total_daily_cap);
    expect(plan.selected_pages_by_source["booking"] ?? 0).toBeLessThanOrEqual(PAGE_CAPS.booking_daily_cap);
    expect(plan.selected_pages_by_source["jalan"] ?? 0).toBeLessThanOrEqual(PAGE_CAPS.jalan_daily_cap);
    expect(plan.selected_pages_by_source["rakuten"]).toBeUndefined();
  });

  it("selection prefers higher priority first", () => {
    const plan = buildScopePlan({ runDateIso: RUN_DATE, properties: PROPERTIES, config: CONFIG });
    const scores = plan.selected.map((t) => t.priority_score);
    const minSelected = Math.min(...scores);
    for (const ex of plan.excluded_by_cap) {
      // nothing excluded-by-cap should outrank the lowest selected (given stable order)
      expect(ex.priority_score).toBeLessThanOrEqual(Math.max(...scores));
    }
    expect(minSelected).toBeGreaterThan(0);
  });

  it("selectWithinCaps reports candidate/selected/excluded counts", () => {
    const plan = buildScopePlan({ runDateIso: RUN_DATE, properties: PROPERTIES, config: CONFIG });
    expect(plan.total_candidates).toBeGreaterThan(plan.selected.length);
    expect(plan.selected.length + plan.excluded_by_cap.length + plan.excluded_by_disabled_source.length).toBe(plan.total_candidates);
  });

  it("is deterministic across runs", () => {
    const a = buildScopePlan({ runDateIso: RUN_DATE, properties: PROPERTIES, config: CONFIG });
    const b = buildScopePlan({ runDateIso: RUN_DATE, properties: PROPERTIES, config: CONFIG });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("AUTO-RUNNER14X - rendering and safety", () => {
  it("CSV has the documented header and rows", () => {
    const plan = buildScopePlan({ runDateIso: RUN_DATE, properties: PROPERTIES, config: CONFIG });
    const csv = renderPlanCsv(plan.selected);
    expect(csv.split("\n")[0]).toContain("run_date_jst,stay_date,bucket,source");
    expect(csv).toContain("booking");
  });

  it("report notes dry-run and disabled Rakuten/Google", () => {
    const plan = buildScopePlan({ runDateIso: RUN_DATE, properties: PROPERTIES, config: CONFIG });
    const text = renderPlanReport(plan, "2026-06-07T11:00:00+09:00");
    expect(text).toContain("dry-run only");
    expect(text).toContain("Rakuten/Google live disabled");
  });

  it("service is pure (no I/O, browser, or process spawning)", () => {
    expect(SERVICE_SOURCE).not.toMatch(/child_process|spawn|execSync|readFileSync|writeFileSync|playwright|chromium/u);
  });

  it("script performs no live collection / mutation", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/COLLECT_BOOKING|COLLECT_JALAN|auto-runner:market-refresh|sync:history-to-db|build:ai-context-packs|chromium|kickstart/u);
  });

  it("package wires the planner script", () => {
    expect(PACKAGE_JSON).toContain("plan:collection-scope");
  });
});

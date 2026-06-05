import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AiTaskEntrypoint,
  CaveatsPack,
  DemandContextRow,
  MarketSnapshot,
  MirrorRow,
  PropertySignalRow
} from "../src/services/aiContextPackGenerator";
import {
  TASK_NAMES,
  TASK_RECIPES,
  decideAiTaskQuery,
  parseArgs,
  renderTaskCsv,
  renderTaskReport,
  runRecipe,
  type ContextBundle,
  type TaskQueryReport
} from "../src/services/aiTaskQueryRecipes";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/aiTaskQueryRecipes.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAiTaskQuery.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function demand(over: Partial<DemandContextRow>): DemandContextRow {
  return {
    checkin_date: "2026-06-10",
    stay_scope: "2_adults_1_room_1_night",
    source_count: 2,
    property_count: 3,
    available_count: 2,
    sold_out_count: 1,
    sold_out_ratio: 0.33,
    direct_price_row_count: 0,
    directional_price_row_count: 2,
    median_total_jpy: 20000,
    basis_confidence_summary: { B: 2 },
    dp_usage_summary: { directional: 2 },
    demand_signal_level: "directional",
    confidence_level: "low",
    human_readable_note: "note",
    ...over
  };
}

function property(over: Partial<PropertySignalRow>): PropertySignalRow {
  return {
    canonical_property_name: "ホテル松金屋アネックス",
    source: "rakuten",
    source_property_id: "5097",
    latest_collected_at_jst: "2026-06-01T10:00:00+09:00",
    date_count: 5,
    available_count: 3,
    sold_out_count: 2,
    price_row_count: 4,
    median_total_jpy: 20000,
    basis_confidence_summary: { B: 4 },
    dp_usage_summary: { directional: 4 },
    recommended_ai_use: "Directional reference only; brief a human before pricing.",
    caution: "Rakuten totals are computed from per-person CHARGE_PER_HUMAN; not raw room totals.",
    ...over
  };
}

function mirror(over: Partial<MirrorRow>): MirrorRow {
  return {
    row_id: Math.random().toString(36).slice(2),
    source: "rakuten",
    canonical_property_name: "ホテル松金屋アネックス",
    source_property_id: "5097",
    source_url: "https://travel.rakuten.co.jp/HOTEL/5097/",
    checkin_date: "2026-06-10",
    checkout_date: "2026-06-11",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_flag: 0,
    normalized_total_jpy: 20000,
    price_basis: "CHARGE_PER_HUMAN",
    basis_confidence: "B",
    dp_usage: "directional",
    classification: "ota_listing",
    exclusion_reason: "",
    collected_at_jst: "2026-06-01T10:00:00+09:00",
    ...over
  };
}

const SNAPSHOT: MarketSnapshot = {
  generated_at_jst: "2026-06-04T12:00:00+09:00",
  source: "db_mirror",
  market_signal_history_row_count: 145,
  sync_run_count: 2,
  date_range: { min: "2026-05-31", max: "2026-12-12" },
  source_counts: { rakuten: 126, jalan: 13, booking: 6 },
  dp_usage_counts: { directional: 132, direct: 6, excluded: 7 },
  basis_confidence_counts: { B: 134, A: 6, C: 2, insufficient: 3 },
  availability_counts: { available: 74, sold_out: 66, unavailable_or_unknown: 5 },
  property_count: 5,
  direct_row_count: 6,
  directional_row_count: 132,
  excluded_row_count: 7,
  sold_out_row_count: 66,
  available_row_count: 74,
  top_sold_out_pressure_dates: [],
  top_price_pressure_dates: [],
  data_quality_summary: "Thin DB mirror.",
  recommended_use: ["Directional only."],
  do_not_use_for: ["Automated price updates without human approval."]
};

const CAVEATS: CaveatsPack = {
  generated_at_jst: "2026-06-04T12:00:00+09:00",
  purpose: "guard",
  caveats: ["B-confidence rows are directional only and are NOT automated-pricing safe."],
  guardrails: ["Do not update PMS/OTA/Beds24/AirHost without explicit approval."]
};

const ENTRYPOINT: AiTaskEntrypoint = {
  generated_at_jst: "2026-06-04T12:00:00+09:00",
  read_order: ["a", "b"],
  task_routes: { market_report: ["x"] },
  safe_commands: ["npm run db:verify"],
  forbidden_without_approval: ["DB writes"],
  recommended_next_phases: ["AUTO07X"]
};

const BUNDLE: ContextBundle = {
  snapshot: SNAPSHOT,
  demandRows: [
    demand({ checkin_date: "2026-06-01", sold_out_count: 3, sold_out_ratio: 0.9, demand_signal_level: "directional", median_total_jpy: 30000, confidence_level: "low" }),
    demand({ checkin_date: "2026-06-15", sold_out_count: 1, sold_out_ratio: 0.4, demand_signal_level: "weak", median_total_jpy: 18000, confidence_level: "insufficient" }),
    demand({ checkin_date: "2026-07-20", sold_out_count: 2, sold_out_ratio: 0.6, demand_signal_level: "directional", median_total_jpy: 25000, confidence_level: "medium" })
  ],
  propertyRows: [
    property({ canonical_property_name: "ホテル松金屋アネックス", source: "rakuten" }),
    property({ canonical_property_name: "おおみや旅館", source: "jalan", caution: "Jalan is strongest/direct-capable only when basis_confidence is A." })
  ],
  caveats: CAVEATS,
  entrypoint: ENTRYPOINT,
  manifest: { known_caveats: ["mirror is thin"], recommended_next_tasks: [], safe_readonly_commands: ["npm run db:verify"], forbidden_without_approval: ["DB writes"], paused_tasks: [] },
  dictionary: { known_misread_risks: [], future_ai_usage_rules: [] },
  mirrorRows: [
    mirror({ checkin_date: "2026-06-01", source: "rakuten", basis_confidence: "B", dp_usage: "directional" }),
    mirror({ checkin_date: "2026-07-20", source: "jalan", basis_confidence: "A", dp_usage: "direct" }),
    mirror({ checkin_date: "2026-09-01", source: "booking", basis_confidence: "C", dp_usage: "excluded" })
  ]
};

// ---------------------------------------------------------------------------
// 1. all required recipes
// ---------------------------------------------------------------------------

describe("recipe registry", () => {
  it("defines all six required task recipes", () => {
    expect(TASK_NAMES.sort()).toEqual(
      ["bootstrap", "data_quality", "market_report", "pricing_support", "property_signal", "sold_out_pressure"]
    );
    for (const name of TASK_NAMES) {
      expect(TASK_RECIPES[name].purpose.length).toBeGreaterThan(0);
      expect(TASK_RECIPES[name].forbidden_actions.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. bootstrap
// ---------------------------------------------------------------------------

describe("bootstrap", () => {
  it("uses entrypoint + caveats + manifest and surfaces data limitations", () => {
    const out = runRecipe("bootstrap", BUNDLE, {});
    expect(out.data_sources_used).toEqual(TASK_RECIPES.bootstrap.data_sources);
    expect(out.result["read_order"]).toEqual(ENTRYPOINT.read_order);
    expect(out.result["safe_commands"]).toEqual(ENTRYPOINT.safe_commands);
    const limits = out.result["current_data_limitations"] as string[];
    expect(limits.some((l) => l.includes("mirror is thin"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3–4. market_report
// ---------------------------------------------------------------------------

describe("market_report", () => {
  it("filters demand rows by date range", () => {
    const out = runRecipe("market_report", BUNDLE, { start_date: "2026-06-01", end_date: "2026-06-30" });
    const rows = out.result["demand_rows"] as DemandContextRow[];
    expect(rows.map((r) => r.checkin_date)).toEqual(["2026-06-01", "2026-06-15"]);
  });

  it("includes high/weak/sold-out/price-pressure dates", () => {
    const out = runRecipe("market_report", BUNDLE, { start_date: "2026-06-01", end_date: "2026-12-31" });
    expect(out.result).toHaveProperty("high_demand_dates");
    expect(out.result).toHaveProperty("weak_demand_dates");
    expect(out.result).toHaveProperty("sold_out_pressure_dates");
    expect(out.result).toHaveProperty("price_pressure_dates");
    const high = out.result["high_demand_dates"] as { checkin_date: string }[];
    expect(high[0]!.checkin_date).toBe("2026-06-01"); // highest sold_out_ratio
  });

  it("excludes directional rows when include_directional=false", () => {
    const out = runRecipe("market_report", BUNDLE, { include_directional: false });
    const rows = out.result["demand_rows"] as DemandContextRow[];
    expect(rows.every((r) => r.demand_signal_level !== "directional")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5–6. pricing_support
// ---------------------------------------------------------------------------

describe("pricing_support", () => {
  it("includes the forbidden PMS/OTA action warning", () => {
    const out = runRecipe("pricing_support", BUNDLE, { start_date: "2026-06-01", end_date: "2026-12-31" });
    const forbidden = out.result["forbidden_actions"] as string[];
    expect(forbidden.some((f) => /No PMS\/OTA\/Beds24\/AirHost update is allowed/.test(f))).toBe(true);
    expect(out.result["human_review_required"]).toBe(true);
  });

  it("treats B-confidence as directional only", () => {
    const out = runRecipe("pricing_support", BUNDLE, { start_date: "2026-06-01", end_date: "2026-12-31" });
    const warnings = out.result["confidence_warnings"] as string[];
    expect(warnings.some((w) => /B-confidence is directional only/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. sold_out_pressure
// ---------------------------------------------------------------------------

describe("sold_out_pressure", () => {
  it("ranks dates by sold_out_ratio descending", () => {
    const out = runRecipe("sold_out_pressure", BUNDLE, { limit: 10 });
    const ranked = out.result["ranked_dates"] as { checkin_date: string; sold_out_ratio: number }[];
    expect(ranked.map((r) => r.checkin_date)).toEqual(["2026-06-01", "2026-07-20", "2026-06-15"]);
    expect(ranked[0]!.sold_out_ratio).toBeGreaterThanOrEqual(ranked[1]!.sold_out_ratio);
  });
});

// ---------------------------------------------------------------------------
// 8–9. property_signal
// ---------------------------------------------------------------------------

describe("property_signal", () => {
  it("filters by property name", () => {
    const out = runRecipe("property_signal", BUNDLE, { property_name: "おおみや" });
    const rows = out.result["property_rows"] as PropertySignalRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canonical_property_name).toBe("おおみや旅館");
  });

  it("filters by source", () => {
    const out = runRecipe("property_signal", BUNDLE, { source: "jalan" });
    const rows = out.result["property_rows"] as PropertySignalRow[];
    expect(rows.every((r) => r.source === "jalan")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. data_quality
// ---------------------------------------------------------------------------

describe("data_quality", () => {
  it("includes row counts, confidence distribution, and source coverage", () => {
    const out = runRecipe("data_quality", BUNDLE, {});
    const counts = out.result["row_counts"] as Record<string, number>;
    expect(counts["market_signal_history_row_count"]).toBe(145);
    expect(out.result["confidence_distribution"]).toEqual(SNAPSHOT.basis_confidence_counts);
    expect(out.result["source_coverage"]).toEqual(SNAPSHOT.source_counts);
    expect(out.result).toHaveProperty("safe_use");
    expect(out.result).toHaveProperty("unsafe_use");
  });
});

// ---------------------------------------------------------------------------
// 11. arg parsing
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses task/start/end/property/source/limit", () => {
    const { task, inputs } = parseArgs([
      "--task", "market_report",
      "--start", "2026-06-01",
      "--end", "2026-06-30",
      "--property", "三浦屋",
      "--source", "rakuten",
      "--limit", "5"
    ]);
    expect(task).toBe("market_report");
    expect(inputs).toMatchObject({ start_date: "2026-06-01", end_date: "2026-06-30", property_name: "三浦屋", source: "rakuten", limit: 5 });
  });

  it("defaults to bootstrap and rejects unknown tasks", () => {
    expect(parseArgs([]).task).toBe("bootstrap");
    expect(() => parseArgs(["--task", "nope"])).toThrow(/Unknown task/);
  });
});

// ---------------------------------------------------------------------------
// 12–13. output JSON keys & report renderer
// ---------------------------------------------------------------------------

function makeReport(): TaskQueryReport {
  const result = runRecipe("bootstrap", BUNDLE, {});
  return {
    run_id: "ai_task_query_test",
    generated_at_jst: "2026-06-04T12:00:00+09:00",
    task: "bootstrap",
    inputs: {},
    data_sources_used: result.data_sources_used,
    result: result.result,
    caveats: result.caveats,
    forbidden_actions: result.forbidden_actions,
    safety_confirmation: { dbWrites: false },
    decision: "ai_task_query_basis_caution"
  };
}

describe("output shape", () => {
  it("report object includes all required top-level keys", () => {
    const r = makeReport();
    for (const key of ["run_id", "generated_at_jst", "task", "inputs", "data_sources_used", "result", "caveats", "forbidden_actions", "safety_confirmation", "decision"]) {
      expect(r).toHaveProperty(key);
    }
  });

  it("report renderer includes caveats and forbidden actions", () => {
    const md = renderTaskReport(makeReport());
    expect(md).toContain("## 5. Caveats");
    expect(md).toContain("## 6. Forbidden Actions");
    expect(md).toContain("No PMS/OTA/Beds24/AirHost update is allowed");
    expect(md).toContain("Decision: ai_task_query_basis_caution");
  });

  it("csv renderer emits ranked rows for sold_out_pressure", () => {
    const out = runRecipe("sold_out_pressure", BUNDLE, {});
    const csv = renderTaskCsv(out);
    expect(csv.split("\n")[0]).toContain("checkin_date");
  });
});

// ---------------------------------------------------------------------------
// 14. decision
// ---------------------------------------------------------------------------

describe("decideAiTaskQuery", () => {
  it("is basis_caution for the thin real-data mirror", () => {
    expect(
      decideAiTaskQuery({ historyRowCount: 145, directRowCount: 6, directionalRowCount: 132, bConfidenceCount: 134, distinctSourceCount: 3, propertyCount: 5 })
    ).toBe("ai_task_query_basis_caution");
  });

  it("is not_ready for an empty mirror", () => {
    expect(
      decideAiTaskQuery({ historyRowCount: 0, directRowCount: 0, directionalRowCount: 0, bConfidenceCount: 0, distinctSourceCount: 0, propertyCount: 0 })
    ).toBe("ai_task_query_not_ready");
  });
});

// ---------------------------------------------------------------------------
// 15–24. Safety scans
// ---------------------------------------------------------------------------

describe("safety — service is pure (no DB / no writes / no fetch)", () => {
  it("the service performs no DB access", () => {
    expect(SERVICE_SOURCE).not.toMatch(/better-sqlite3|new Database/);
  });

  it("the service performs no filesystem writes", () => {
    expect(SERVICE_SOURCE).not.toMatch(/writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync|mkdirSync/);
  });

  it("the service performs no live fetch or shell-out", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\bfetch\s*\(|axios|child_process|execSync|spawn/);
  });
});

describe("safety — script is read-only and side-effect free", () => {
  it("opens the DB read-only and never writes/migrates it", () => {
    expect(SCRIPT_SOURCE).toMatch(/readonly:\s*true/);
    expect(SCRIPT_SOURCE).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE|executeMigration|runInTransaction|openLocalDatabase/i);
  });

  it("does no collector re-run, live fetch, or paid-source tooling", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\bfetch\s*\(|axios|puppeteer|playwright|SerpAPI|DataForSEO|Apify|BrightData|Oxylabs/i);
  });

  it("contains no Booking base × 1.1 arithmetic", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1|1\.1\s*\*/);
    expect(SCRIPT_SOURCE).toContain("bookingBaseTimes1_1: false");
  });

  it("never mutates .data/ai-context/latest_* (reads only)", () => {
    // the only writes target REPORT_DIR / DEBUG_ROOT, never AI_CONTEXT_DIR
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*AI_CONTEXT_DIR/);
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*latest_/);
    expect(SCRIPT_SOURCE).toContain("aiContextLatestMutated: false");
  });

  it("never modifies the property master or .data/history", () => {
    // Behavioral: no write/rename/copy/rm targeting the property master or history
    // (the header disclaimer legitimately names them in prose).
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync|symlinkSync)\s*\([^)]*(zao_universe_properties|history)/i);
    expect(SCRIPT_SOURCE).toContain("propertyMasterModified: false");
    expect(SCRIPT_SOURCE).toContain("dataHistoryModified: false");
  });

  it("generates no PMS/Beds24/AirHost/OTA output", () => {
    expect(SCRIPT_SOURCE).toContain("pmsOutput: false");
    expect(SCRIPT_SOURCE).toContain("beds24Output: false");
    expect(SCRIPT_SOURCE).toContain("airhostOutput: false");
    expect(SCRIPT_SOURCE).toContain("otaUpload: false");
  });

  it("performs no GitHub Actions / GitOps / git activation", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/git\s+commit|git\s+push|gh\s+workflow|crontab/i);
    expect(SCRIPT_SOURCE).toContain("githubActionsOrGitOps: false");
    expect(SCRIPT_SOURCE).toContain("cronActivated: false");
  });

  it("does not start DP03X or R01X", () => {
    expect(SCRIPT_SOURCE).toContain("startedDp03x: false");
    expect(SCRIPT_SOURCE).toContain("startedR01x: false");
  });
});

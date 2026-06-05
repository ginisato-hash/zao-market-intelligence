import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_PACK_FILES,
  buildAiTaskEntrypoint,
  buildCaveats,
  buildDemandContext,
  buildMarketSnapshot,
  buildPropertySignalContext,
  confidenceLevelFor,
  decideAiContextPacks,
  demandSignalLevel,
  median,
  renderContextPackReport,
  renderDemandContextCsv,
  signalLevelCounts,
  type ContextPackReport,
  type MirrorRow
} from "../src/services/aiContextPackGenerator";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/aiContextPackGenerator.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAiContextPacks.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures — mirror the shape of the real DB mirror (rakuten-heavy,
// directional/B-confidence-dominated, thin property coverage).
// ---------------------------------------------------------------------------

function row(over: Partial<MirrorRow>): MirrorRow {
  return {
    row_id: Math.random().toString(36).slice(2),
    source: "rakuten",
    canonical_property_name: "ホテル松金屋アネックス",
    source_property_id: "5097",
    source_url: "https://travel.rakuten.co.jp/HOTEL/5097/",
    checkin_date: "2026-07-01",
    checkout_date: "2026-07-02",
    stay_scope: "1night_2adults",
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

// Representative thin mirror: 3 sources, 2 properties, directional+B heavy.
const ROWS: MirrorRow[] = [
  row({ source: "rakuten", checkin_date: "2026-07-01", dp_usage: "directional", basis_confidence: "B", normalized_total_jpy: 18000, sold_out_flag: 0, availability_status: "available" }),
  row({ source: "rakuten", checkin_date: "2026-07-01", dp_usage: "directional", basis_confidence: "B", normalized_total_jpy: 22000, sold_out_flag: 1, availability_status: "sold_out" }),
  row({ source: "jalan", canonical_property_name: "おおみや旅館", source_property_id: "335940", checkin_date: "2026-07-01", dp_usage: "direct", basis_confidence: "A", normalized_total_jpy: 25000, sold_out_flag: 0, availability_status: "available" }),
  row({ source: "booking", canonical_property_name: "おおみや旅館", source_property_id: "bk1", checkin_date: "2026-07-01", dp_usage: "excluded", basis_confidence: "C", normalized_total_jpy: null, sold_out_flag: 0, availability_status: "unavailable_or_unknown", exclusion_reason: "low_confidence" }),
  row({ source: "rakuten", checkin_date: "2026-07-02", dp_usage: "directional", basis_confidence: "B", normalized_total_jpy: 30000, sold_out_flag: 1, availability_status: "sold_out" })
];

const CTX = { generatedAtJst: "2026-06-04T12:00:00+09:00", syncRunCount: 2 };

// ---------------------------------------------------------------------------
// 1–3. median / countBy basics
// ---------------------------------------------------------------------------

describe("aggregation helpers", () => {
  it("median returns null for empty input", () => {
    expect(median([])).toBeNull();
  });

  it("median of odd-length set is the middle value", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("median of even-length set is the rounded average of the two middles", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// 4–6. buildMarketSnapshot
// ---------------------------------------------------------------------------

describe("buildMarketSnapshot", () => {
  it("reports source=db_mirror and row/sync counts", () => {
    const snap = buildMarketSnapshot(ROWS, CTX);
    expect(snap.source).toBe("db_mirror");
    expect(snap.market_signal_history_row_count).toBe(ROWS.length);
    expect(snap.sync_run_count).toBe(2);
  });

  it("computes the check-in date range and property count", () => {
    const snap = buildMarketSnapshot(ROWS, CTX);
    expect(snap.date_range).toEqual({ min: "2026-07-01", max: "2026-07-02" });
    expect(snap.property_count).toBe(2);
  });

  it("only uses direct/directional priceable rows for top price pressure", () => {
    const snap = buildMarketSnapshot(ROWS, CTX);
    // The excluded null-price booking row must never contribute a price.
    for (const dp of snap.top_price_pressure_dates) {
      expect(dp.median_total_jpy).toBeGreaterThan(0);
    }
    expect(snap.do_not_use_for.some((s) => s.includes("Automated price updates"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7–10. demandSignalLevel / confidenceLevelFor
// ---------------------------------------------------------------------------

describe("demandSignalLevel", () => {
  it("is insufficient when there are no usable rows", () => {
    expect(
      demandSignalLevel({ usableRowCount: 0, excludedRowCount: 3, soldOutRatio: 1, sourceCount: 0, propertyCount: 0, directRowCount: 0 })
    ).toBe("insufficient");
  });

  it("is weak when usable rows are dominated by exclusions", () => {
    expect(
      demandSignalLevel({ usableRowCount: 2, excludedRowCount: 5, soldOutRatio: 0.2, sourceCount: 2, propertyCount: 3, directRowCount: 0 })
    ).toBe("weak");
  });

  it("is directional for B-confidence-dominated coverage without strong pressure", () => {
    expect(
      demandSignalLevel({ usableRowCount: 4, excludedRowCount: 0, soldOutRatio: 0.3, sourceCount: 2, propertyCount: 3, directRowCount: 0 })
    ).toBe("directional");
  });

  it("is strong only with high pressure AND breadth", () => {
    expect(
      demandSignalLevel({ usableRowCount: 4, excludedRowCount: 0, soldOutRatio: 0.8, sourceCount: 2, propertyCount: 3, directRowCount: 1 })
    ).toBe("strong");
  });
});

describe("confidenceLevelFor", () => {
  it("is high only with a direct row and multi-source coverage", () => {
    expect(confidenceLevelFor({ usableRowCount: 4, directRowCount: 1, sourceCount: 2 })).toBe("high");
  });

  it("is low for single-source directional-only coverage", () => {
    expect(confidenceLevelFor({ usableRowCount: 2, directRowCount: 0, sourceCount: 1 })).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// 11–13. buildDemandContext / buildPropertySignalContext
// ---------------------------------------------------------------------------

describe("buildDemandContext", () => {
  it("produces one row per non-empty check-in date, sorted ascending", () => {
    const ctxRows = buildDemandContext(ROWS);
    expect(ctxRows.map((r) => r.checkin_date)).toEqual(["2026-07-01", "2026-07-02"]);
  });

  it("never derives a price median from excluded null-price rows", () => {
    const ctxRows = buildDemandContext(ROWS);
    const d1 = ctxRows.find((r) => r.checkin_date === "2026-07-01")!;
    // priceable: 18000, 22000 (rakuten directional) + 25000 (jalan direct) → 22000
    expect(d1.median_total_jpy).toBe(22000);
  });

  it("emits a human_readable_note for each row", () => {
    const ctxRows = buildDemandContext(ROWS);
    for (const r of ctxRows) expect(r.human_readable_note.length).toBeGreaterThan(0);
  });
});

describe("buildPropertySignalContext", () => {
  it("groups by canonical property + source with source-specific caution", () => {
    const rows = buildPropertySignalContext(ROWS);
    const rakuten = rows.find((r) => r.source === "rakuten")!;
    expect(rakuten.caution).toContain("CHARGE_PER_HUMAN");
    const booking = rows.find((r) => r.source === "booking")!;
    expect(booking.caution).toContain("never synthetic base");
  });
});

// ---------------------------------------------------------------------------
// 14–16. caveats / entrypoint
// ---------------------------------------------------------------------------

describe("buildCaveats", () => {
  it("warns that B-confidence is directional and NOT automated-pricing safe", () => {
    const c = buildCaveats(CTX.generatedAtJst);
    expect(c.caveats.some((x) => /B-confidence.*NOT automated-pricing safe/i.test(x))).toBe(true);
  });

  it("includes the Booking base × 1.1 prohibition as a caveat", () => {
    const c = buildCaveats(CTX.generatedAtJst);
    expect(c.caveats.some((x) => x.includes("base × 1.1"))).toBe(true);
  });

  it("guardrails forbid PMS/OTA/Beds24/AirHost updates and pause DP03X/R01X", () => {
    const c = buildCaveats(CTX.generatedAtJst);
    expect(c.guardrails.some((g) => /Beds24\/AirHost/.test(g))).toBe(true);
    expect(c.guardrails.some((g) => /DP03X and R01X are paused/.test(g))).toBe(true);
  });
});

describe("buildAiTaskEntrypoint", () => {
  it("routes the 4 task types and recommends AUTO06X next", () => {
    const e = buildAiTaskEntrypoint(CTX.generatedAtJst);
    expect(Object.keys(e.task_routes).sort()).toEqual(["bootstrap", "market_report", "pricing_support", "property_data_quality"]);
    expect(e.recommended_next_phases[0]).toContain("AUTO06X");
    expect(e.forbidden_without_approval.some((x) => x.includes("Booking base × 1.1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. decision
// ---------------------------------------------------------------------------

describe("decideAiContextPacks", () => {
  it("is not_ready when the mirror is empty", () => {
    expect(
      decideAiContextPacks({ historyRowCount: 0, syncRunCount: 0, directRowCount: 0, directionalRowCount: 0, excludedRowCount: 0, bConfidenceCount: 0, distinctSourceCount: 0, propertyCount: 0 })
    ).toBe("ai_context_packs_not_ready");
  });

  it("is basis_caution for a thin directional/B-heavy mirror (the real-data case)", () => {
    expect(
      decideAiContextPacks({ historyRowCount: 145, syncRunCount: 2, directRowCount: 6, directionalRowCount: 132, excludedRowCount: 7, bConfidenceCount: 134, distinctSourceCount: 3, propertyCount: 5 })
    ).toBe("ai_context_packs_basis_caution");
  });

  it("is ready only for a broad, direct-rich, low-B mirror", () => {
    expect(
      decideAiContextPacks({ historyRowCount: 100, syncRunCount: 5, directRowCount: 60, directionalRowCount: 40, excludedRowCount: 0, bConfidenceCount: 10, distinctSourceCount: 3, propertyCount: 8 })
    ).toBe("ai_context_packs_ready");
  });
});

// ---------------------------------------------------------------------------
// 18. rendering
// ---------------------------------------------------------------------------

describe("rendering", () => {
  it("renders a 12-column demand-context CSV header", () => {
    const csv = renderDemandContextCsv(buildDemandContext(ROWS));
    expect(csv.split("\n")[0]!.split(",")).toHaveLength(12);
  });

  it("renders a markdown report containing the decision and caveats", () => {
    const demand = buildDemandContext(ROWS);
    const snap = buildMarketSnapshot(ROWS, CTX);
    const caveats = buildCaveats(CTX.generatedAtJst);
    const entrypoint = buildAiTaskEntrypoint(CTX.generatedAtJst);
    const report: ContextPackReport = {
      run_id: "ai_context_packs_test",
      generated_at_jst: CTX.generatedAtJst,
      decision: "ai_context_packs_basis_caution",
      db_mirror_summary: {
        market_signal_history_row_count: ROWS.length,
        market_signal_sync_runs_count: 2,
        source_counts: {},
        dp_usage_counts: {},
        basis_confidence_counts: {}
      },
      context_pack_paths: Object.values(CONTEXT_PACK_FILES),
      market_snapshot_summary: snap,
      demand_context_summary: { row_count: demand.length, signal_level_counts: signalLevelCounts(demand) },
      property_signal_context_summary: { row_count: 0 },
      caveats_summary: { caveat_count: caveats.caveats.length, guardrail_count: caveats.guardrails.length },
      ai_task_entrypoint_summary: { task_route_count: 4 },
      safety_confirmation: { dbWrites: false },
      report_path: "r.md",
      json_path: "r.json",
      csv_path: "r.csv",
      debug_artifact_path: "d",
      next_phase: "AUTO06X"
    };
    const md = renderContextPackReport(report, caveats, entrypoint);
    expect(md).toContain("Decision: ai_context_packs_basis_caution");
    expect(md).toContain("OTA stock/availability is not actual occupancy");
  });
});

// ---------------------------------------------------------------------------
// 19–24. Safety: service is pure & read-only; script is read-only; no forbidden ops.
// ---------------------------------------------------------------------------

describe("safety — service is pure (no DB / no writes / no fetch)", () => {
  it("the service imports no DB driver and performs no DB access", () => {
    expect(SERVICE_SOURCE).not.toMatch(/better-sqlite3/);
    expect(SERVICE_SOURCE).not.toMatch(/new Database/);
  });

  it("the service performs no filesystem writes", () => {
    expect(SERVICE_SOURCE).not.toMatch(/writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync|mkdirSync/);
  });

  it("the service performs no live fetch and no shell-out", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\bfetch\s*\(|axios|child_process|execSync|spawn/);
  });
});

describe("safety — script opens the DB read-only and never writes/migrates it", () => {
  it("opens the DB with readonly:true", () => {
    expect(SCRIPT_SOURCE).toMatch(/readonly:\s*true/);
  });

  it("contains no SQL write / DDL statements", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE|executeMigration|runInTransaction/i);
  });

  it("never invokes openLocalDatabase (which opens read-write and migrates)", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/openLocalDatabase/);
  });
});

describe("safety — script does no forbidden side-effects", () => {
  it("no collector re-run, no live fetch, no paid sources, no Booking base × 1.1 arithmetic", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\bfetch\s*\(|axios|puppeteer|playwright|SerpAPI|DataForSEO|Apify|BrightData|Oxylabs/i);
    // actual arithmetic on 1.1 (the × char in prose must not trip this)
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1|1\.1\s*\*/);
    // affirms the Booking guard in the safety_confirmation
    expect(SCRIPT_SOURCE).toContain("bookingBaseTimes1_1: false");
  });

  it("never modifies .data/history or the property master, and writes context packs as real files", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/symlinkSync/);
    expect(SCRIPT_SOURCE).toContain("contextPacksAreRealFiles");
    expect(SCRIPT_SOURCE).toContain("isSymbolicLink");
  });

  it("does not start DP03X or R01X and performs no git/workflow activation", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/git\s+commit|git\s+push|gh\s+workflow|crontab|GitHub Actions enable/i);
    expect(SCRIPT_SOURCE).toContain("startedDp03x: false");
    expect(SCRIPT_SOURCE).toContain("startedR01x: false");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NORMALIZED_ROW_COLUMNS,
  buildApprovalGates,
  buildCollectionMethodComparison,
  buildCollectorInventory,
  buildDateWindowPlan,
  buildDownstreamPipelinePlan,
  buildMicroBatchConstraints,
  buildNormalizedRowContract,
  buildRecommendedStrategy,
  buildSourceStrategies,
  decideCollectorOrchestration,
  renderInventoryCsv
} from "../src/services/collectorOrchestrationDryRun";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/collectorOrchestrationDryRun.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runCollectorOrchestrationDryRun.ts"), "utf8");

const METHODS = buildCollectionMethodComparison();
const INVENTORY = buildCollectorInventory();
const STRATEGIES = buildSourceStrategies();

// ---------------------------------------------------------------------------
// 1–6. Collection method comparison
// ---------------------------------------------------------------------------

describe("collection method comparison", () => {
  it("compares at least six methods (A–F)", () => {
    expect(METHODS.length).toBeGreaterThanOrEqual(6);
    expect(METHODS.map((m) => m.id).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("rejects paid APIs / proxies / CAPTCHA / stealth (Method F is forbidden)", () => {
    const f = METHODS.find((m) => m.id === "F")!;
    expect(f.status).toBe("forbidden");
    expect(f.bot_risk).toBe("forbidden");
    expect(f.cost).toBe("not_free");
  });

  it("recommends artifact/DB reuse first (Method A)", () => {
    const order = buildRecommendedStrategy();
    expect(order[0]).toMatch(/Method A/);
    const a = METHODS.find((m) => m.id === "A")!;
    expect(a.status).toBe("preferred");
    expect(a.bot_risk).toBe("none");
  });

  it("prefers static/public endpoint (B) before Playwright (C)", () => {
    const order = buildRecommendedStrategy().join("\n");
    expect(order).toMatch(/Method B before C|static HTML \/ public endpoint/);
    const b = METHODS.find((m) => m.id === "B")!;
    const c = METHODS.find((m) => m.id === "C")!;
    expect(b.status).toBe("preferred");
    expect(c.status).toBe("conditional");
  });

  it("recommends local/manual bounded runner (D) before scheduled GitHub Actions (E)", () => {
    const order = buildRecommendedStrategy();
    const dIdx = order.findIndex((s) => /local\/manual/.test(s));
    const eIdx = order.findIndex((s) => /smoke test/.test(s));
    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(eIdx).toBeGreaterThan(dIdx);
  });

  it("includes cloud / GitHub Actions WAF risk", () => {
    const e = METHODS.find((m) => m.id === "E")!;
    expect(e.bot_risk).toBe("high");
    expect(e.expected_role).toMatch(/smoke test/);
  });
});

// ---------------------------------------------------------------------------
// 7–13. Collector inventory
// ---------------------------------------------------------------------------

describe("collector inventory", () => {
  it("builds a non-empty inventory", () => {
    expect(INVENTORY.length).toBeGreaterThan(0);
  });

  it("classifies Jalan scripts", () => {
    expect(INVENTORY.some((r) => r.source === "jalan")).toBe(true);
  });

  it("classifies Rakuten scripts", () => {
    expect(INVENTORY.some((r) => r.source === "rakuten")).toBe(true);
  });

  it("classifies Booking scripts", () => {
    expect(INVENTORY.some((r) => r.source === "booking")).toBe(true);
  });

  it("classifies Property Discovery scripts", () => {
    expect(INVENTORY.some((r) => r.category === "property_discovery")).toBe(true);
  });

  it("includes normalizer / history append / db sync / context refresh / query layers", () => {
    const categories = new Set(INVENTORY.map((r) => r.category));
    for (const cat of ["normalizer", "history_append", "db_sync", "ai_context_refresh", "ai_query"]) {
      expect(categories.has(cat as never)).toBe(true);
    }
  });

  it("does not mark any externally-fetching/writing collector as automation-ready", () => {
    for (const r of INVENTORY) {
      if (r.reads_external_network || r.writes_db || r.writes_history) {
        expect(r.safe_for_scheduled_automation_now).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 14–16. Date window plan
// ---------------------------------------------------------------------------

describe("date window plan", () => {
  const plan = buildDateWindowPlan("2026-06-04");

  it("includes a near-term daily window (today → +14)", () => {
    expect(plan.near_term_daily.start).toBe("2026-06-04");
    expect(plan.near_term_daily.end).toBe("2026-06-18");
    expect(plan.near_term_daily.dates).toHaveLength(15);
  });

  it("includes a peak/weekly window (Fri/Sat over 90 days)", () => {
    expect(plan.peak_weekly.horizon_days).toBe(90);
    expect(plan.peak_weekly.dates.length).toBeGreaterThan(0);
    // every date is a Friday or Saturday
    for (const d of plan.peak_weekly.dates) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      expect(dow === 5 || dow === 6).toBe(true);
    }
  });

  it("includes a far baseline window (90 → 180 days, weekly)", () => {
    expect(plan.far_baseline.start).toBe("2026-09-02");
    expect(plan.far_baseline.end).toBe("2026-12-01");
    expect(plan.far_baseline.dates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 17–19. Micro-batch constraints
// ---------------------------------------------------------------------------

describe("micro-batch constraints", () => {
  const caps = buildMicroBatchConstraints();

  it("includes conservative micro-batch caps with justifications", () => {
    expect(caps.max_sources_per_run).toBe(1);
    expect(caps.max_properties_per_source).toBeLessThanOrEqual(5);
    expect(Object.keys(caps.justification).length).toBeGreaterThan(0);
  });

  it("caps max_requests_per_run <= 50", () => {
    expect(caps.max_requests_per_run).toBeLessThanOrEqual(50);
  });

  it("caps max_browser_pages_per_run <= 10", () => {
    expect(caps.max_browser_pages_per_run).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// 20–21. Normalized row contract
// ---------------------------------------------------------------------------

describe("normalized row contract", () => {
  it("defines the normalized row contract aligned with history/DB schema", () => {
    const contract = buildNormalizedRowContract();
    expect(contract.schema_version).toBe("zao_local_history_v1");
    for (const col of ["source", "canonical_property_name", "checkin_date", "normalized_total_jpy", "basis_confidence", "dp_usage", "raw_json"]) {
      expect(contract.columns).toContain(col);
    }
  });

  it("normalized row contract includes row_id and row_hash", () => {
    expect(NORMALIZED_ROW_COLUMNS).toContain("row_id");
    expect(NORMALIZED_ROW_COLUMNS).toContain("row_hash");
  });
});

// ---------------------------------------------------------------------------
// 22–25. Downstream pipeline + approval gates
// ---------------------------------------------------------------------------

describe("downstream pipeline and approval gates", () => {
  const pipeline = buildDownstreamPipelinePlan().join("\n");

  it("downstream pipeline includes a history append dry-run", () => {
    expect(pipeline).toMatch(/history append dry-run/);
  });

  it("downstream pipeline includes DB sync", () => {
    expect(pipeline).toMatch(/DB mirror sync|history-to-db/);
  });

  it("downstream pipeline includes AI context refresh", () => {
    expect(pipeline).toMatch(/AI context pack refresh/);
  });

  it("approval gates include scheduled activation", () => {
    const gates = buildApprovalGates();
    expect(gates.some((g) => /Scheduled activation/.test(g.gate))).toBe(true);
    expect(gates.some((g) => g.phase === "AUTO11X" && g.requires_explicit_approval)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 32. Decision
// ---------------------------------------------------------------------------

describe("decision", () => {
  it("is basis_caution when the plan is generated but no live collectors ran", () => {
    expect(
      decideCollectorOrchestration({ methodCount: 6, paidRejected: true, inventoryCount: INVENTORY.length, liveCollectorsExecuted: false })
    ).toBe("collector_orchestration_dry_run_basis_caution");
  });

  it("is not_ready if paid methods are not rejected or fewer than six methods", () => {
    expect(
      decideCollectorOrchestration({ methodCount: 5, paidRejected: true, inventoryCount: 10, liveCollectorsExecuted: false })
    ).toBe("collector_orchestration_dry_run_not_ready");
    expect(
      decideCollectorOrchestration({ methodCount: 6, paidRejected: false, inventoryCount: 10, liveCollectorsExecuted: false })
    ).toBe("collector_orchestration_dry_run_not_ready");
  });
});

// ---------------------------------------------------------------------------
// CSV rendering
// ---------------------------------------------------------------------------

describe("rendering", () => {
  it("renders an inventory CSV header", () => {
    const csv = renderInventoryCsv(INVENTORY);
    expect(csv.split("\n")[0]).toContain("safe_for_scheduled_automation_now");
  });

  it("source strategies cover jalan/rakuten/booking/property_discovery", () => {
    const sources = STRATEGIES.map((s) => s.source).sort();
    expect(sources).toEqual(["booking", "jalan", "property_discovery", "rakuten"]);
  });
});

// ---------------------------------------------------------------------------
// 26–31. Safety scans
// ---------------------------------------------------------------------------

describe("safety — service is pure (no execution / no writes / no fetch)", () => {
  it("the service performs no DB access, no fs writes, and no live fetch", () => {
    expect(SERVICE_SOURCE).not.toMatch(/better-sqlite3|new Database/);
    expect(SERVICE_SOURCE).not.toMatch(/writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync|mkdirSync/);
    expect(SERVICE_SOURCE).not.toMatch(/\bfetch\s*\(|axios|playwright|chromium|child_process|execSync|spawn/);
  });
});

describe("safety — script runs no collectors and writes only reports/debug", () => {
  it("runs no live collector / external fetch / browser", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\bfetch\s*\(|axios|playwright|chromium|puppeteer/);
    expect(SCRIPT_SOURCE).not.toMatch(/jalanCollector|rakutenCollector|bookingRenderedDomProbe/);
  });

  it("performs no DB writes (optional read is readonly:true)", () => {
    expect(SCRIPT_SOURCE).toMatch(/readonly:\s*true/);
    expect(SCRIPT_SOURCE).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|executeMigration|runInTransaction|openLocalDatabase/i);
  });

  it("does not append to .data/history (no write targets history)", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync)\s*\([^)]*history/i);
    expect(SCRIPT_SOURCE).toContain("historyAppended: false");
  });

  it("does not mutate .data/ai-context/latest", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync)\s*\([^)]*latest_/i);
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync)\s*\([^)]*ai-context/i);
    expect(SCRIPT_SOURCE).toContain("aiContextLatestMutated: false");
  });

  it("activates no GitHub Actions / cron / GitOps and contains no Booking base × 1.1", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/git\s+commit|git\s+push|gh\s+workflow|crontab/i);
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1|1\.1\s*\*/);
    expect(SCRIPT_SOURCE).toContain("githubActionsActivated: false");
  });

  it("uses no paid-source tooling (the service only names them to reject them)", () => {
    // Behavioral: no import/require of paid tools (prose rejection is allowed).
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(import|require)[^;\n]*(serpapi|dataforseo|apify|brightdata|oxylabs|proxy)/i);
    // The comparison must explicitly mark Method F (paid) as forbidden.
    const f = METHODS.find((m) => m.id === "F")!;
    expect(f.status).toBe("forbidden");
    expect(SCRIPT_SOURCE).toContain("paidSources: false");
  });
});

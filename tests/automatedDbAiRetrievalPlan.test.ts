import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROADMAP_PHASES,
  architectureOptions,
  buildAutomatedDbAiRetrievalPlan,
  renderAutomatedDbAiRetrievalReport,
  type CurrentState
} from "../src/services/automatedDbAiRetrievalPlan";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/automatedDbAiRetrievalPlan.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutomatedDbAiRetrievalPlan.ts"), "utf8");

const STATE: CurrentState = {
  aiManifestDecision: "ai_readable_market_manifest_basis_caution",
  dataDictionaryDecision: "market_data_dictionary_ready",
  gitopsDesignDecision: "gitops_data_repo_design_ready",
  localHistoryRealAppendDecision: "local_history_real_append_success",
  localHistoryValidationPolicyDecision: "local_history_append_validation_policy_ready",
  historyFileCount: 6,
  historyRowCount: 145,
  dbRelatedScriptCount: 5,
  dbBaseline: {
    collectorRunsCount: 42,
    rateSnapshotsCount: 210,
    inventorySnapshotsCount: 210,
    collectionJobAttemptsCount: 166
  }
};

function plan() {
  return buildAutomatedDbAiRetrievalPlan({
    runId: "run",
    generatedAtJst: "2026-06-03T22:00:00+09:00",
    currentState: STATE,
    packageScripts: {
      "report:ai-readable-market-manifest": "x",
      "report:market-data-dictionary": "x",
      "real-run:local-history-append": "x",
      "report:gitops-data-repo-design": "x",
      "db:verify": "x",
      "market:compute": "x",
      "probe:booking-rendered-dom": "x",
      "collect:jalan:auto-update": "x"
    }
  });
}

describe("automated DB + AI retrieval plan", () => {
  it("final goal includes AI completing user-requested tasks from DB/context", () => {
    expect(plan().final_goal).toContain("future AI agents");
    expect(plan().final_goal).toContain("complete the user-requested task");
  });

  it("compares at least four architecture options", () => {
    expect(architectureOptions()).toHaveLength(4);
    expect(plan().option_comparison.map((o) => o.option)).toEqual(["A", "B", "C", "D"]);
  });

  it("recommends a DB + AI retrieval path without starting with direct raw collector DB writes", () => {
    const p = plan();
    expect(p.recommended_architecture.summary).toContain("DB mirror");
    expect(p.recommended_architecture.summary).toContain("AI retrieval");
    expect(p.recommended_architecture.firstStepsNotAllowed.join("\n")).toContain("direct raw collector DB writes");
  });

  it("keeps history shards as canonical append log and includes DB mirror/query datastore", () => {
    const p = plan();
    expect(p.recommended_architecture.canonicalStore).toContain(".data/history");
    expect(p.recommended_architecture.queryStore).toContain("DB mirror");
  });

  it("includes AI-readable views and context packs", () => {
    const p = plan();
    expect(p.ai_readable_views.map((v) => v.name)).toContain("v_ai_market_daily_summary");
    expect(p.ai_readable_views.map((v) => v.name)).toContain("v_ai_task_context_latest");
    expect(p.context_packs.map((c) => c.path)).toContain(".data/ai-context/latest_market_snapshot.json");
  });

  it("includes task-specific query recipes", () => {
    const names = plan().task_query_recipes.map((r) => r.name);
    expect(names).toContain("market_report_task");
    expect(names).toContain("pricing_support_task");
    expect(names).toContain("data_quality_task");
    expect(names).toContain("ai_context_bootstrap_task");
  });

  it("includes DB auto-update as final target", () => {
    expect(plan().db_auto_update_target_state).toContain("DB mirror syncs from history");
    expect(plan().db_auto_update_target_state).toContain("future AI reads");
  });

  it("includes history-to-DB sync before collector-to-DB direct writes", () => {
    const text = renderAutomatedDbAiRetrievalReport(plan());
    expect(text).toContain("Use history-to-DB sync before any direct collector-to-DB write.");
    expect(text).toContain("DB mirror sync from validated history before any direct collector-to-DB write.");
  });

  it("includes DB sync dry-run before real DB sync", () => {
    const phases = ROADMAP_PHASES.map((r) => r.phase);
    expect(phases.indexOf("AUTO03X")).toBeLessThan(phases.indexOf("AUTO04X"));
    expect(ROADMAP_PHASES.find((r) => r.phase === "AUTO03X")?.goal).toContain("dry-run");
  });

  it("includes WAF smoke test before schedule activation", () => {
    const phases = ROADMAP_PHASES.map((r) => r.phase);
    expect(phases.indexOf("AUTO09X")).toBeLessThan(phases.indexOf("AUTO11X"));
    expect(plan().safety_gates.join("\n")).toContain("WAF smoke test before scheduled cloud activation");
  });

  it("includes approval gates and rollback considerations", () => {
    const p = plan();
    expect(p.approval_points.length).toBeGreaterThan(3);
    expect(p.safety_gates.join("\n")).toContain("Backups and rollback path");
  });

  it("includes Git growth, cloud-run WAF, and direct DB corruption risks", () => {
    const risks = plan().risks.join("\n");
    expect(risks).toContain("Git growth risk");
    expect(risks).toContain("Cloud-run WAF risk");
    expect(risks).toContain("Direct DB corruption risk");
  });

  it("includes current history and AI manifest/data dictionary assets", () => {
    const p = plan();
    expect(p.current_state.historyFileCount).toBe(6);
    expect(p.existing_assets.aiManifestAndDictionary).toContain("report:ai-readable-market-manifest");
    expect(p.existing_assets.aiManifestAndDictionary).toContain("report:market-data-dictionary");
  });

  it("does not create workflow files or DB write scripts", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\.github\/workflows/);
    expect(SERVICE_SOURCE).not.toMatch(/writeTargetsAtomically|openLocalDatabase|runInTransaction/);
  });

  it("does not modify history or property master", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.data\/history/);
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.data\/exports\/zao-universe-review/);
    }
  });

  it("has no DB-write code, GitHub Actions activation, or paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i);
      expect(src).not.toMatch(/git\s+commit|git\s+push/);
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs/i);
    }
  });

  it("decision is ready when report can be generated", () => {
    expect(plan().decision).toBe("automated_db_ai_retrieval_plan_ready");
  });
});

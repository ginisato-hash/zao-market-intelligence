import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_APPROVAL_SENTENCE,
  DATA_REPO_NAME,
  DRAFT_WORKFLOW_FILENAME,
  SECRET_NAMES,
  buildActionsArchitecture,
  buildActivationGate,
  buildCommitStrategy,
  buildConcurrencyPlan,
  buildCostModel,
  buildDataRepoLayout,
  buildDesignComponents,
  buildFailureModes,
  buildRepoSeparationModel,
  buildRollbackPlan,
  buildSecretModel,
  decideM07X,
  renderDesignComponentCsv,
  renderDesignReport,
  renderDraftWorkflowYaml,
  DESIGN_COMPONENT_CSV_HEADERS,
  type DesignReportInput
} from "../src/services/gitopsDataRepoSeparationDesign";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/gitopsDataRepoSeparationDesign.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildGitopsDataRepoSeparationDesignReport.ts"), "utf8");

function reportInput(over: Partial<DesignReportInput> = {}): DesignReportInput {
  return {
    designId: "gitops_data_repo_design_20260602_120000",
    generatedAtJst: "2026-06-02T12:00:00+09:00",
    decision: "gitops_data_repo_design_ready",
    m06xArtifact: "/abs/.data/reports/source-discovery/local_history_real_append_20260602_092853.json",
    historyDirExists: true,
    historyFiles: ["zao_signals_2026_05.csv"],
    repoSeparation: buildRepoSeparationModel(),
    dataRepoLayout: buildDataRepoLayout(),
    actions: buildActionsArchitecture(),
    secretModel: buildSecretModel(),
    concurrency: buildConcurrencyPlan(),
    commitStrategy: buildCommitStrategy(),
    rollback: buildRollbackPlan(),
    costModel: buildCostModel(),
    failureModes: buildFailureModes(),
    activationGate: buildActivationGate(),
    draftWorkflowPath: "/abs/.data/debug/gitops-data-repo-design/20260602_120000/draft_daily_collection.workflow.yml.disabled",
    reportPath: "/abs/report.md",
    csvPath: "/abs/report.csv",
    jsonPath: "/abs/report.json",
    debugRootPath: "/abs/.data/debug/gitops-data-repo-design/20260602_120000",
    ...over
  };
}

describe("M07X GitOps data-repo separation design", () => {
  // 1. layout includes history shard path
  it("data repo layout includes the history shard path", () => {
    const paths = buildDataRepoLayout().map((e) => e.path);
    expect(paths).toContain("data/history/zao_signals_YYYY_MM.csv");
  });

  // 2. excludes dev source
  it("data repo excludes application source (src/)", () => {
    const dataRepo = buildRepoSeparationModel().find((r) => r.repo === DATA_REPO_NAME);
    expect(dataRepo).toBeDefined();
    expect(dataRepo!.excludes.join(" ")).toMatch(/src\//u);
  });

  // 3. draft disabled
  it("draft workflow filename is disabled (.yml.disabled)", () => {
    expect(DRAFT_WORKFLOW_FILENAME.endsWith(".yml.disabled")).toBe(true);
    expect(renderDraftWorkflowYaml()).toMatch(/DISABLED/u);
  });

  // 4. draft path under debug not .github/workflows
  it("script writes the draft only under .data/debug, never .github/workflows", () => {
    expect(SCRIPT_SOURCE).toContain(".data/debug/gitops-data-repo-design");
    expect(SCRIPT_SOURCE).not.toContain(".github/workflows");
  });

  // 5. schedule design not active
  it("actions architecture is designed but not active", () => {
    const a = buildActionsArchitecture();
    expect(a.active).toBe(false);
    expect(a.triggers).toContain("schedule");
    expect(a.triggers).toContain("workflow_dispatch");
  });

  // 6. secret placeholders only
  it("secret model exposes names + placeholders only", () => {
    const model = buildSecretModel();
    expect(model.map((s) => s.name).sort()).toEqual([...SECRET_NAMES].sort());
    for (const s of model) {
      expect(s.placeholder).toMatch(/^\$\{\{ secrets\.[A-Z_]+ \}\}$/u);
    }
  });

  // 7. no token values
  it("no token values appear in service, script, or draft workflow", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE, renderDraftWorkflowYaml()]) {
      expect(src).not.toMatch(/ghp_[A-Za-z0-9]/u);
      expect(src).not.toMatch(/github_pat_[A-Za-z0-9]/u);
    }
  });

  // 8. commit only on change
  it("commit strategy commits only when there are changes", () => {
    const c = buildCommitStrategy();
    expect(c.commitOnlyIfChanged).toBe(true);
    expect(c.changeDetection).toMatch(/porcelain|status/u);
  });

  // 9. concurrency disables overlap
  it("concurrency plan disables overlap via cancel-in-progress=false", () => {
    const c = buildConcurrencyPlan();
    expect(c.cancelInProgress).toBe(false);
    expect(c.group).toBe("zao-market-intelligence-daily-collection");
  });

  // 10. rollback includes git revert
  it("rollback plan includes git revert", () => {
    expect(buildRollbackPlan().some((r) => /git revert/u.test(r.action))).toBe(true);
  });

  // 11. failure list includes hash conflict
  it("failure modes include hash conflict", () => {
    expect(buildFailureModes().some((f) => /hash conflict/u.test(f.mode))).toBe(true);
  });

  // 12. activation gate requires approval
  it("activation gate requires the explicit approval sentence and is closed", () => {
    const g = buildActivationGate();
    expect(g.currentlyActive).toBe(false);
    expect(g.requiresExplicitApproval).toBe(true);
    expect(g.approvalSentence).toBe(ACTIVATION_APPROVAL_SENTENCE);
  });

  // 13. report states no Actions activation
  it("report states no GitHub Actions activation", () => {
    const md = renderDesignReport(reportInput());
    expect(md).toMatch(/No GitHub Actions activation/u);
    expect(md).toMatch(/DESIGN ONLY/u);
  });

  // 14. JSON includes M06X artifact path (script wires it into json output)
  it("script writes the M06X artifact path into the JSON summary", () => {
    expect(SCRIPT_SOURCE).toContain("m06xArtifact");
    expect(SCRIPT_SOURCE).toContain("source_m06x_artifact.json");
  });

  // 15. no .github/workflows created
  it("neither service nor script creates a .github/workflows file", () => {
    // The service is pure — it performs no file IO at all.
    expect(SERVICE_SOURCE).not.toMatch(/from "node:fs"/u);
    // The script writes only under .data; it never references .github.
    expect(SCRIPT_SOURCE).not.toContain(".github");
  });

  // 16. no commit/push command in script
  it("script contains no git commit or git push command", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/git commit/u);
    expect(SCRIPT_SOURCE).not.toMatch(/git push/u);
  });

  // 17. no paid refs
  it("no paid data-source references in service or script", () => {
    for (const src of [SERVICE_SOURCE.toLowerCase(), SCRIPT_SOURCE.toLowerCase()]) {
      for (const name of ["serpapi", "dataforseo", "apify", "brightdata", "oxylabs"]) {
        expect(src).not.toContain(name);
      }
    }
  });

  // 18. .data/history read-only
  it("script does not write to .data/history and guards against it", () => {
    expect(SCRIPT_SOURCE).toContain("assertNotRealHistoryPath");
    expect(SCRIPT_SOURCE).toMatch(/READ-ONLY|must not touch real history/u);
  });

  // 19. CSV outputs design components not market rows
  it("CSV header describes design components, not market signal rows", () => {
    expect(DESIGN_COMPONENT_CSV_HEADERS).toEqual([
      "component",
      "status",
      "description",
      "activation_required",
      "risk_level",
      "notes"
    ]);
    const csv = renderDesignComponentCsv(buildDesignComponents());
    const header = csv.split("\n")[0];
    expect(header).toBe("component,status,description,activation_required,risk_level,notes");
    expect(csv).not.toMatch(/row_id|row_hash|checkin/u);
  });

  // 20. decision ready when all components exist
  it("decision is ready when all components exist and everything is safe", () => {
    const components = buildDesignComponents();
    expect(
      decideM07X({
        componentCount: components.length,
        expectedComponentCount: 11,
        draftWorkflowDisabled: true,
        draftUnderDebugNotWorkflows: true,
        actionsActive: false,
        activationGateClosed: true,
        secretValuesAbsent: true,
        m06xArtifactPresent: true
      })
    ).toBe("gitops_data_repo_design_ready");
  });

  // extra: decision degrades when M06X artifact missing / unsafe inputs
  it("decision is basis_caution when the M06X artifact is missing", () => {
    expect(
      decideM07X({
        componentCount: 11,
        expectedComponentCount: 11,
        draftWorkflowDisabled: true,
        draftUnderDebugNotWorkflows: true,
        actionsActive: false,
        activationGateClosed: true,
        secretValuesAbsent: true,
        m06xArtifactPresent: false
      })
    ).toBe("gitops_data_repo_design_basis_caution");
  });

  it("decision is not_ready when Actions is marked active", () => {
    expect(
      decideM07X({
        componentCount: 11,
        expectedComponentCount: 11,
        draftWorkflowDisabled: true,
        draftUnderDebugNotWorkflows: true,
        actionsActive: true,
        activationGateClosed: true,
        secretValuesAbsent: true,
        m06xArtifactPresent: true
      })
    ).toBe("gitops_data_repo_design_not_ready");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAlwaysOnMacRestorePlan,
  buildArtifactCategoryMatrix,
  buildGithubTransferOptions,
  buildGitStatusSummary,
  buildGitignoreRecommendations,
  buildIntegrityChecks,
  buildRecommendedTransferStrategy,
  buildReleaseArchivePolicy,
  buildSafetyConfirmation,
  decideAutoRunnerArtifactSync,
  renderCategoryCsv,
  renderReport
} from "../src/services/autoRunnerArtifactSyncProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerArtifactSyncProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerArtifactSyncProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function categoryExamples(category: string): string[] {
  return buildArtifactCategoryMatrix().find((item) => item.category === category)!.examples;
}

describe("AUTO-RUNNER06X - artifact categories", () => {
  it("classifies source code as commit_to_git", () => {
    expect(categoryExamples("commit_to_git")).toContain("src/**");
  });

  it("classifies tests as commit_to_git", () => {
    expect(categoryExamples("commit_to_git")).toContain("tests/**");
  });

  it("classifies .data/history CSV shards as commit_or_policy_approval", () => {
    expect(categoryExamples("commit_or_policy_approval")).toContain(".data/history/zao_signals_*.csv");
  });

  it("classifies SQLite DB as regenerate_not_commit", () => {
    expect(categoryExamples("regenerate_not_commit")).toContain(".data/zao-market-intelligence.sqlite");
  });

  it("classifies AI context as regenerate_not_commit", () => {
    expect(categoryExamples("regenerate_not_commit")).toContain(".data/ai-context/**");
  });

  it("classifies debug/screenshots as archive_or_ignore", () => {
    const examples = categoryExamples("archive_or_ignore");
    expect(examples).toContain(".data/debug/**");
    expect(examples).toContain(".data/screenshots/**");
  });

  it("classifies .env as never_commit", () => {
    expect(categoryExamples("never_commit")).toContain(".env");
  });
});

describe("AUTO-RUNNER06X - transfer strategy", () => {
  it("includes Git-only minimal option", () => {
    expect(buildGithubTransferOptions().some((option) => option.option_id === "A" && option.name.includes("Git only"))).toBe(true);
  });

  it("includes Git + release archive option", () => {
    expect(buildGithubTransferOptions().some((option) => option.option_id === "B" && option.name.includes("release archive"))).toBe(true);
  });

  it("includes manual artifact zip option", () => {
    expect(buildGithubTransferOptions().some((option) => option.option_id === "C" && option.name.includes("manual artifact"))).toBe(true);
  });

  it("includes Git LFS option with caution", () => {
    const option = buildGithubTransferOptions().find((item) => item.option_id === "D")!;
    expect(option.name).toContain("Git LFS");
    expect(option.recommendation).toBe("caution_only");
  });

  it("recommends Option A primary", () => {
    expect(buildGithubTransferOptions().find((item) => item.option_id === "A")!.recommendation).toBe("primary");
    expect(buildRecommendedTransferStrategy()).toContain("Option A");
  });

  it("includes future .gitignore negation rules for .data/history", () => {
    const rules = buildGitignoreRecommendations().future_rules;
    expect(rules).toContain("!.data/history/");
    expect(rules).toContain("!.data/history/zao_signals_*.csv");
  });

  it("does not modify .gitignore", () => {
    expect(buildGitignoreRecommendations().do_not_apply_in_this_phase).toBe(true);
  });

  it("includes release archive naming", () => {
    expect(buildReleaseArchivePolicy().normal_archive_name).toContain("zmi-artifact-snapshot");
  });

  it("excludes screenshots by default from normal archive", () => {
    expect(buildReleaseArchivePolicy().normal_archive_excludes.join("\n")).toContain("screenshots by default");
  });

  it("includes restore plan for always-on Mac", () => {
    expect(buildAlwaysOnMacRestorePlan().steps.join("\n")).toContain("always-on Mac");
  });

  it("includes integrity checks", () => {
    expect(buildIntegrityChecks().checks).toContain("sha256 hash for each history shard");
  });

  it("includes sha256/manifest proposal", () => {
    expect(buildIntegrityChecks().future_manifest_path_pattern).toContain("zmi_manifest");
  });
});

describe("AUTO-RUNNER06X - report and decision", () => {
  it("summarizes Git status without mutating it", () => {
    const summary = buildGitStatusSummary({ trackedFiles: [".gitignore", "README.md"], statusLines: [" M README.md", "?? src/"], gitignoreText: ".data/\n*.sqlite\n" });
    expect(summary.tracked_file_count).toBe(2);
    expect(summary.gitignore_blanket_ignores_data).toBe(true);
    expect(summary.gitignore_ignores_sqlite).toBe(true);
  });

  it("Decision ready/basis_caution/not_ready", () => {
    expect(decideAutoRunnerArtifactSync({ sourcePresent: false, gitignoreBlanketIgnoresData: true, broadUncommittedTree: true })).toBe(
      "auto_runner_artifact_sync_proposal_not_ready"
    );
    expect(decideAutoRunnerArtifactSync({ sourcePresent: true, gitignoreBlanketIgnoresData: true, broadUncommittedTree: true })).toBe(
      "auto_runner_artifact_sync_proposal_basis_caution"
    );
    expect(decideAutoRunnerArtifactSync({ sourcePresent: true, gitignoreBlanketIgnoresData: false, broadUncommittedTree: false })).toBe(
      "auto_runner_artifact_sync_proposal_ready"
    );
  });

  it("renders CSV and report", () => {
    const csv = renderCategoryCsv(buildArtifactCategoryMatrix());
    expect(csv).toContain("commit_to_git");
    const report = renderReport({
      generatedAtJst: "2026-06-05T16:00:00+09:00",
      decision: "auto_runner_artifact_sync_proposal_basis_caution",
      sourceArtifactPath: "auto05x.json",
      current: {
        history_rows: 210,
        db_rows: 210,
        ai_context_rows: 210,
        booking: { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary" },
        jalan: { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary" },
        rakuten: { rows: 126, role: "frozen" }
      },
      git: buildGitStatusSummary({ trackedFiles: [".gitignore"], statusLines: [], gitignoreText: ".data/\n*.sqlite\n" }),
      sizes: { data_total: "1.2G", history: "1.5M", sqlite: "3.1M", ai_context: "72K", reports: "12M", debug: "419M", screenshots: "751M" },
      categories: buildArtifactCategoryMatrix(),
      options: buildGithubTransferOptions(),
      recommendedStrategy: buildRecommendedTransferStrategy(),
      gitignore: buildGitignoreRecommendations(),
      release: buildReleaseArchivePolicy(),
      restore: buildAlwaysOnMacRestorePlan(),
      integrity: buildIntegrityChecks(),
      risks: [],
      safety: buildSafetyConfirmation()
    });
    expect(report).toContain("GitHub Artifact Sync / Release Archive Proposal");
  });

  it("package contains proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-artifact-sync");
  });
});

describe("AUTO-RUNNER06X - executable safety scans", () => {
  it("No git add/commit/push/tag/remote code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execFileSync\(["']git["'],\s*\[\s*["'](?:add|commit|push|tag|remote)/u);
  });

  it("No gh release command exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/execFileSync\(["']gh["']|spawn\(["']gh["']|gh release/u);
  });

  it("No archive creation command executes", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execFileSync\(["'](?:zip|tar)["']|spawn\(["'](?:zip|tar)["']/u);
  });

  it("No history write code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*\.data\/history|appendHistory|realHistoryAppend/u);
  });

  it("No DB sync/write code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|real-run:history-to-db-sync|INSERT INTO|DELETE FROM|UPDATE market_signal/iu);
  });

  it("No AI context refresh code exists", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("No collector/Playwright code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/npm run probe:|npm run collect:|from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("No pricing/PMS output code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/pricing_recommendation|beds24|airhost|GENERATE_PRICE_CSV/iu);
  });
});

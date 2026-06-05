import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAiContextRegenerationPlan,
  buildBootstrapPreconditions,
  buildCanonicalHistoryVerificationPlan,
  buildCurrentStateSummary,
  buildDbRegenerationPlan,
  buildDependencyInstallationPlan,
  buildEnvironmentSetupPlan,
  buildFailureHandlingPlan,
  buildFutureBootstrapScriptOutline,
  buildLocalDirectoryLayout,
  buildLoggingBackupPolicy,
  buildRepositoryAcquisitionPlan,
  buildRisks,
  buildSafetyConfirmation,
  decideAutoRunnerBootstrapProposal,
  renderBootstrapCsv,
  renderReport,
  type AutoRunner01xArtifactLike
} from "../src/services/autoRunnerBootstrapProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerBootstrapProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerBootstrapProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function artifact(): AutoRunner01xArtifactLike {
  return {
    decision: "auto_runner_migration_proposal_basis_caution",
    current_repo_state: {
      trackedFileCount: 2,
      uncommittedEntryCount: 17,
      gitignoreIgnoresDataDir: true,
      gitignoreIgnoresSqlite: true,
      envExamplePresent: true
    },
    canonical_data_inventory: {
      historyRows: 210,
      dbRows: 210,
      aiContextRows: 210,
      bookingRows: 46,
      jalanRows: 38,
      rakutenRows: 126
    }
  };
}

function current() {
  return buildCurrentStateSummary({
    autoRunner01x: artifact(),
    historyRows: 210,
    sourceCounts: { booking: 46, jalan: 38, rakuten: 126 },
    aiContextRows: 210
  });
}

describe("AUTO-RUNNER02X - bootstrap content", () => {
  it("includes always-on Mac preconditions", () => {
    expect(buildBootstrapPreconditions().checklist.join("\n").toLowerCase()).toContain("stable power");
  });

  it("includes repository clone/pull plan", () => {
    expect(buildRepositoryAcquisitionPlan().commands).toContain("git clone <repo-url>");
  });

  it("includes npm install / typecheck / test plan", () => {
    const commands = buildDependencyInstallationPlan().commands;
    expect(commands).toContain("npm install");
    expect(commands).toContain("npm run typecheck");
    expect(commands).toContain("npm run test");
  });

  it("includes no-paid guard", () => {
    expect(buildDependencyInstallationPlan().commands).toContain("npm run check:no-paid-sources");
  });

  it("includes Playwright install as setup-only, not live launch", () => {
    const plan = buildDependencyInstallationPlan();
    expect(plan.commands).toContain("npx playwright install");
    expect(plan.notes.join("\n")).toContain("setup-only");
  });

  it("includes .env never committed policy", () => {
    expect(buildEnvironmentSetupPlan(true).notes.join("\n")).toContain("must never be committed");
  });

  it("includes canonical .data/history verification", () => {
    expect(buildCanonicalHistoryVerificationPlan().required_checks.join("\n")).toContain(".data/history exists");
  });

  it("includes expected history row count 210", () => {
    expect(buildCanonicalHistoryVerificationPlan().expected_history_rows).toBe(210);
  });

  it("includes expected Booking/Jalan/Rakuten counts", () => {
    expect(buildCanonicalHistoryVerificationPlan().expected_source_counts).toEqual({ booking: 46, jalan: 38, rakuten: 126 });
  });

  it("includes DB regeneration from history", () => {
    expect(buildDbRegenerationPlan().recommended_future_sequence).toContain("npm run dry-run:history-to-db-sync");
  });

  it("includes AI context regeneration", () => {
    expect(buildAiContextRegenerationPlan().recommended_future_sequence).toContain("npm run build:ai-context-packs");
  });

  it("includes query smoke plan", () => {
    expect(buildAiContextRegenerationPlan().recommended_future_sequence.join("\n")).toContain("query:ai-task");
  });
});

describe("AUTO-RUNNER02X - fail closed and layout", () => {
  it("includes failure handling for row count mismatch", () => {
    expect(buildFailureHandlingPlan().fail_closed_rules.join("\n")).toContain("history row count mismatch");
  });

  it("includes failure handling for duplicate row_id", () => {
    expect(buildFailureHandlingPlan().fail_closed_rules.join("\n")).toContain("duplicate row_id");
  });

  it("includes failure handling for DB conflict", () => {
    expect(buildFailureHandlingPlan().fail_closed_rules.join("\n")).toContain("DB dry-run conflicts");
  });

  it("includes future bootstrap script outline", () => {
    expect(buildFutureBootstrapScriptOutline().proposed_file).toBe("scripts/bootstrapAlwaysOnMac.sh");
  });

  it("includes logs/backups/run-state layout", () => {
    const layout = buildLocalDirectoryLayout();
    expect(layout.preferred_external_layout.join("\n")).toContain("logs");
    expect(layout.preferred_external_layout.join("\n")).toContain("backups");
    expect(layout.preferred_external_layout.join("\n")).toContain("run-state");
    expect(buildLoggingBackupPolicy().backups.join("\n")).toContain("history shards");
  });

  it("renders CSV and report", () => {
    expect(renderBootstrapCsv({ preconditions: buildBootstrapPreconditions(), failureHandling: buildFailureHandlingPlan(), risks: buildRisks(current()) })).toContain("precondition");
    expect(
      renderReport({
        generatedAtJst: "2026-06-05T12:30:00+09:00",
        decision: "auto_runner_bootstrap_proposal_basis_caution",
        sourceArtifactPath: "auto01x.json",
        current: current(),
        preconditions: buildBootstrapPreconditions(),
        repository: buildRepositoryAcquisitionPlan(),
        dependencies: buildDependencyInstallationPlan(),
        environment: buildEnvironmentSetupPlan(true),
        history: buildCanonicalHistoryVerificationPlan(),
        db: buildDbRegenerationPlan(),
        ai: buildAiContextRegenerationPlan(),
        layout: buildLocalDirectoryLayout(),
        logging: buildLoggingBackupPolicy(),
        failure: buildFailureHandlingPlan(),
        outline: buildFutureBootstrapScriptOutline(),
        risks: buildRisks(current()),
        safety: buildSafetyConfirmation()
      })
    ).toContain("Always-On Mac Bootstrap Proposal");
  });

  it("decision ready/basis_caution/not_ready", () => {
    expect(decideAutoRunnerBootstrapProposal({ autoRunner01xPresent: true, current: current() })).toBe("auto_runner_bootstrap_proposal_basis_caution");
    expect(decideAutoRunnerBootstrapProposal({ autoRunner01xPresent: false, current: current() })).toBe("auto_runner_bootstrap_proposal_not_ready");
    expect(
      decideAutoRunnerBootstrapProposal({
        autoRunner01xPresent: true,
        current: { ...current(), current_blockers: [], uncommitted_entries: 0, gitignore_ignores_data: false }
      })
    ).toBe("auto_runner_bootstrap_proposal_ready");
  });
});

describe("AUTO-RUNNER02X - executable safety scans", () => {
  it("does not create launchd/cron files", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/LaunchAgents|launchctl|crontab|plist/u);
  });

  it("does not create GitHub Actions workflow", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\.github\/workflows|workflow_dispatch/u);
  });

  it("does not run live collector", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/child_process|execSync|spawn\(|collect:jalan|probe:booking|probe:jalan-bounded/u);
  });

  it("does not run Playwright/browser automation", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("does not modify history", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*\.data\/history|appendHistory|realHistoryAppend/u);
  });

  it("does not write/sync DB", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/real-run:history-to-db-sync|HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE market_signal/iu);
  });

  it("does not refresh AI context", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("does not generate pricing CSV/PMS output", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execSync\(.*pricing|spawn\(.*pricing|writeFileSync\(.*pricing_recommendation|writeFileSync\(.*beds24|writeFileSync\(.*airhost/iu);
  });

  it("package contains proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-bootstrap");
  });
});

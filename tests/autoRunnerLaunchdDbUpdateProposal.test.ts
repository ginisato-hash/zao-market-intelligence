import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DB_UPDATE_LABEL,
  HEALTH_CHECK_LABEL,
  PREDECESSOR_SCHEDULE,
  buildDbUpdateManualResult,
  buildFutureInstallCommands,
  buildFutureRollbackCommands,
  buildHealthCheckManualResult,
  buildLaunchdDbUpdateTemplate,
  buildSafetyConfirmation,
  decideAutoRunnerLaunchdDbUpdateProposal,
  renderPlistXml,
  renderProposalCsv,
  renderReport,
  type DbUpdateArtifactLike
} from "../src/services/autoRunnerLaunchdDbUpdateProposal";

const REPO_DIR = "/Users/gini/Documents/ZMI/zao-market-intelligence";
const TEMPLATE_PATH = resolve(__dirname, "../ops/launchd/com.yuge.zmi.db-update-dry-run.plist.template");
const TEMPLATE_TEXT = existsSync(TEMPLATE_PATH) ? readFileSync(TEMPLATE_PATH, "utf8") : "";
const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerLaunchdDbUpdateProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerLaunchdDbUpdateProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

// Only the <dict> body (the part launchd actually parses), excluding the leading
// explanatory comment block whose negations may mention disabled gates.
const TEMPLATE_BODY = TEMPLATE_TEXT.slice(TEMPLATE_TEXT.indexOf("<plist"));

function dbUpdateArtifact(): DbUpdateArtifactLike {
  return {
    decision: "auto_runner_db_update_stub_ready_not_run",
    current_state_summary: { history_rows: 210, db_rows: 210, ai_context_rows: 210 },
    gate_evaluation: [
      { gate: "ZMI_AUTORUN_ENABLED", enabled: false },
      { gate: "COLLECT_BOOKING", enabled: false }
    ],
    stage_plan: [{ actual_executed: false }, { actual_executed: false }]
  };
}

function readyDbUpdate() {
  return buildDbUpdateManualResult({ artifact: dbUpdateArtifact(), sourceArtifactPath: "db.json", sourcePresent: true });
}

function readyHealth() {
  return buildHealthCheckManualResult({
    artifact: { decision: "auto_runner_health_check_ready", mutation_check: { mutation_detected: false } },
    sourcePresent: true
  });
}

describe("AUTO-RUNNER07J - plist template file", () => {
  it("1. plist template exists", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
    expect(TEMPLATE_TEXT.length).toBeGreaterThan(0);
  });

  it("2. label is com.yuge.zmi.db-update-dry-run", () => {
    expect(DB_UPDATE_LABEL).toBe("com.yuge.zmi.db-update-dry-run");
    expect(TEMPLATE_TEXT).toContain("<string>com.yuge.zmi.db-update-dry-run</string>");
  });

  it("3. command is npm run auto-runner:db-update", () => {
    expect(TEMPLATE_TEXT).toContain("npm run auto-runner:db-update");
  });

  it("4. WorkingDirectory is the always-on Mac repo path", () => {
    expect(TEMPLATE_TEXT).toContain(`<key>WorkingDirectory</key>\n\t<string>${REPO_DIR}</string>`);
  });

  it("5. schedule is daily 08:45", () => {
    expect(TEMPLATE_TEXT).toMatch(/<key>StartCalendarInterval<\/key>/u);
    expect(TEMPLATE_TEXT).toMatch(/<key>Hour<\/key>\s*<integer>8<\/integer>/u);
    expect(TEMPLATE_TEXT).toMatch(/<key>Minute<\/key>\s*<integer>45<\/integer>/u);
  });

  it("6. RunAtLoad is false", () => {
    expect(TEMPLATE_TEXT).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/u);
  });

  it("7. KeepAlive is false", () => {
    expect(TEMPLATE_TEXT).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/u);
  });

  it("8. stdout/stderr paths are inside repo .logs", () => {
    expect(TEMPLATE_TEXT).toContain(`${REPO_DIR}/.logs/launchd-db-update-dry-run.out.log`);
    expect(TEMPLATE_TEXT).toContain(`${REPO_DIR}/.logs/launchd-db-update-dry-run.err.log`);
  });

  it("rendered plist XML matches the on-disk template body", () => {
    const rendered = renderPlistXml(buildLaunchdDbUpdateTemplate(REPO_DIR));
    expect(TEMPLATE_TEXT).toContain(rendered.slice(rendered.indexOf("<plist")));
  });
});

describe("AUTO-RUNNER07J - executable command safety (plist <dict> body)", () => {
  it("9. no risky gates are present in executable plist body", () => {
    expect(TEMPLATE_BODY).not.toMatch(/COLLECT_BOOKING=1|COLLECT_JALAN=1|BOOKING_HISTORY_APPEND=1|JALAN_HISTORY_APPEND=1|ALLOW_HISTORY_APPEND=1|HISTORY_TO_DB_SYNC=1|BUILD_AI_CONTEXT=1|GENERATE_PRICE_REPORT=1|GENERATE_PRICE_CSV=1/u);
  });

  it("10. no collector command in executable plist body", () => {
    expect(TEMPLATE_BODY).not.toMatch(/probe:booking|probe:jalan|collect:/u);
  });

  it("11. no DB sync command in executable plist body", () => {
    expect(TEMPLATE_BODY).not.toMatch(/sync:history-to-db/u);
  });

  it("12. no AI context refresh command in executable plist body", () => {
    expect(TEMPLATE_BODY).not.toContain("build:ai-context-packs");
  });

  it("13. no pricing/PMS output command in executable plist body", () => {
    expect(TEMPLATE_BODY).not.toMatch(/pricing|Beds24|AirHost|\bPMS\b/u);
  });

  it("the only executable command is npm run auto-runner:db-update", () => {
    const t = buildLaunchdDbUpdateTemplate(REPO_DIR);
    expect(t.program_arguments[2]).toContain("npm run auto-runner:db-update");
    expect(t.program_arguments[2]).not.toMatch(/&&\s*npm run (?!auto-runner:db-update)/u);
  });
});

describe("AUTO-RUNNER07J - report content and scheduling", () => {
  function report() {
    return renderReport({
      generatedAtJst: "2026-06-06T12:45:00+09:00",
      decision: "auto_runner_launchd_db_update_proposal_basis_caution",
      repoDir: REPO_DIR,
      dbUpdate: readyDbUpdate(),
      health: readyHealth(),
      template: buildLaunchdDbUpdateTemplate(REPO_DIR),
      templatePath: TEMPLATE_PATH,
      futureInstallCommands: buildFutureInstallCommands(REPO_DIR),
      futureRollbackCommands: buildFutureRollbackCommands(),
      safety: buildSafetyConfirmation()
    });
  }

  it("14. future install commands are present in report", () => {
    const text = report();
    expect(text).toContain("launchctl bootstrap gui/$(id -u)");
    expect(text).toContain("~/Library/LaunchAgents/com.yuge.zmi.db-update-dry-run.plist");
  });

  it("15. future install commands are marked NOT EXECUTED", () => {
    expect(report()).toMatch(/NOT EXECUTED/u);
  });

  it("includes rollback commands", () => {
    expect(report()).toContain("launchctl bootout gui/$(id -u)");
  });

  it("18. health-check schedule is referenced as predecessor at 08:30", () => {
    expect(PREDECESSOR_SCHEDULE.label).toBe(HEALTH_CHECK_LABEL);
    expect(PREDECESSOR_SCHEDULE.minute).toBe(30);
    expect(report()).toContain("08:30");
    expect(report()).toContain(HEALTH_CHECK_LABEL);
  });

  it("19. db-update dry-run schedule is after health-check", () => {
    const t = buildLaunchdDbUpdateTemplate(REPO_DIR);
    expect(t.start_calendar_interval.Minute).toBeGreaterThan(PREDECESSOR_SCHEDULE.minute);
    expect(t.runs_after_label).toBe(HEALTH_CHECK_LABEL);
  });

  it("renders CSV with installed=false and runs_after", () => {
    const csv = renderProposalCsv(buildLaunchdDbUpdateTemplate(REPO_DIR));
    expect(csv).toContain("runs_after");
    expect(csv.trim().split("\n")[1]).toContain("false");
    expect(csv).toContain(HEALTH_CHECK_LABEL);
  });
});

describe("AUTO-RUNNER07J - executable safety scans", () => {
  // §10: distinguish inert report text from executable command calls. The
  // service intentionally contains launchctl strings as report DATA; the proof
  // they cannot run is that no process-spawning mechanism exists anywhere.
  it("16. no launchctl is ever executed (no child_process/exec/spawn anywhere)", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/child_process|execSync|execFileSync|spawnSync|spawn\(|\bexec\(/u);
  });

  it("no copy to ~/Library/LaunchAgents is executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/copyFileSync|cpSync|\bcp\s+-/u);
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,)]*LaunchAgents/u);
  });

  it("no DB sync / context refresh executed by the script", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/sync:history-to-db|HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM/iu);
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("no pricing/PMS output written by the script", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*(?:pricing_recommendation|beds24|airhost|price[_-]csv)/iu);
  });

  it("no Playwright/browser automation code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("package contains the proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-launchd-db-update");
  });
});

describe("AUTO-RUNNER07J - decision", () => {
  it("17. decision is basis_caution when template proposed and inputs safe", () => {
    expect(
      decideAutoRunnerLaunchdDbUpdateProposal({
        dbUpdate: readyDbUpdate(),
        health: readyHealth(),
        template: buildLaunchdDbUpdateTemplate(REPO_DIR),
        templateFileExists: true
      })
    ).toBe("auto_runner_launchd_db_update_proposal_basis_caution");
  });

  it("not_ready when db-update mutated", () => {
    const mutated = buildDbUpdateManualResult({
      artifact: { ...dbUpdateArtifact(), stage_plan: [{ actual_executed: true }] },
      sourceArtifactPath: "db.json",
      sourcePresent: true
    });
    expect(
      decideAutoRunnerLaunchdDbUpdateProposal({ dbUpdate: mutated, health: readyHealth(), template: buildLaunchdDbUpdateTemplate(REPO_DIR), templateFileExists: true })
    ).toBe("auto_runner_launchd_db_update_proposal_not_ready");
  });

  it("not_ready when a risky gate is enabled", () => {
    const risky = buildDbUpdateManualResult({
      artifact: { ...dbUpdateArtifact(), gate_evaluation: [{ gate: "COLLECT_BOOKING", enabled: true }] },
      sourceArtifactPath: "db.json",
      sourcePresent: true
    });
    expect(
      decideAutoRunnerLaunchdDbUpdateProposal({ dbUpdate: risky, health: readyHealth(), template: buildLaunchdDbUpdateTemplate(REPO_DIR), templateFileExists: true })
    ).toBe("auto_runner_launchd_db_update_proposal_not_ready");
  });

  it("not_ready when template file missing", () => {
    expect(
      decideAutoRunnerLaunchdDbUpdateProposal({ dbUpdate: readyDbUpdate(), health: readyHealth(), template: buildLaunchdDbUpdateTemplate(REPO_DIR), templateFileExists: false })
    ).toBe("auto_runner_launchd_db_update_proposal_not_ready");
  });

  it("safety confirmation is all-false", () => {
    expect(Object.values(buildSafetyConfirmation()).every((v) => v === false)).toBe(true);
  });
});

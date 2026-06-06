import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEALTH_CHECK_LABEL,
  buildFutureInstallCommands,
  buildFutureRollbackCommands,
  buildHealthCheckManualResult,
  buildLaunchdHealthCheckTemplate,
  buildSafetyConfirmation,
  decideAutoRunnerLaunchdHealthCheckProposal,
  renderPlistXml,
  renderProposalCsv,
  renderReport,
  type HealthCheckArtifactLike
} from "../src/services/autoRunnerLaunchdHealthCheckProposal";

const REPO_DIR = "/Users/gini/Documents/ZMI/zao-market-intelligence";
const TEMPLATE_PATH = resolve(__dirname, "../ops/launchd/com.yuge.zmi.health-check.plist.template");
const TEMPLATE_TEXT = existsSync(TEMPLATE_PATH) ? readFileSync(TEMPLATE_PATH, "utf8") : "";
const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerLaunchdHealthCheckProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerLaunchdHealthCheckProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function healthArtifact(): HealthCheckArtifactLike {
  return {
    decision: "auto_runner_health_check_ready",
    current_state_before: { current_state_summary: { history_rows: 210, db_rows: 210, ai_context_rows: 210 } },
    runner_stub_summary: { decision: "auto_runner_db_update_stub_ready_not_run", risky_stages_enabled: 0 },
    mutation_check: { mutation_detected: false }
  };
}

function readyHealth() {
  return buildHealthCheckManualResult({ artifact: healthArtifact(), sourceArtifactPath: "hc.json", sourcePresent: true });
}

describe("AUTO-RUNNER07G - plist template file", () => {
  it("1. plist template exists", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
    expect(TEMPLATE_TEXT.length).toBeGreaterThan(0);
  });

  it("2. plist label is com.yuge.zmi.health-check", () => {
    expect(HEALTH_CHECK_LABEL).toBe("com.yuge.zmi.health-check");
    expect(TEMPLATE_TEXT).toContain("<string>com.yuge.zmi.health-check</string>");
  });

  it("3. plist command uses npm run auto-runner:health-check", () => {
    expect(TEMPLATE_TEXT).toContain("npm run auto-runner:health-check");
  });

  it("4. plist WorkingDirectory is the always-on Mac repo path", () => {
    expect(TEMPLATE_TEXT).toContain(`<key>WorkingDirectory</key>\n\t<string>${REPO_DIR}</string>`);
  });

  it("5. schedule is daily 08:30", () => {
    expect(TEMPLATE_TEXT).toMatch(/<key>StartCalendarInterval<\/key>/u);
    expect(TEMPLATE_TEXT).toMatch(/<key>Hour<\/key>\s*<integer>8<\/integer>/u);
    expect(TEMPLATE_TEXT).toMatch(/<key>Minute<\/key>\s*<integer>30<\/integer>/u);
  });

  it("6. RunAtLoad is false", () => {
    expect(TEMPLATE_TEXT).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/u);
  });

  it("7. KeepAlive is false", () => {
    expect(TEMPLATE_TEXT).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/u);
  });

  it("8. StandardOutPath and StandardErrorPath are inside repo .logs", () => {
    expect(TEMPLATE_TEXT).toContain(`${REPO_DIR}/.logs/launchd-health-check.out.log`);
    expect(TEMPLATE_TEXT).toContain(`${REPO_DIR}/.logs/launchd-health-check.err.log`);
  });

  it("rendered plist XML matches the on-disk template", () => {
    const rendered = renderPlistXml(buildLaunchdHealthCheckTemplate(REPO_DIR));
    // Compare the <dict> body (ignoring the leading comment block in the file).
    expect(TEMPLATE_TEXT).toContain(rendered.slice(rendered.indexOf("<plist")));
  });
});

describe("AUTO-RUNNER07G - template builder", () => {
  it("builds inert template with run_at_load=false and keep_alive=false", () => {
    const t = buildLaunchdHealthCheckTemplate(REPO_DIR);
    expect(t.run_at_load).toBe(false);
    expect(t.keep_alive).toBe(false);
    expect(t.start_calendar_interval).toEqual({ Hour: 8, Minute: 30 });
    expect(t.program_arguments.join(" ")).toContain("npm run auto-runner:health-check");
    expect(t.working_directory).toBe(REPO_DIR);
  });
});

describe("AUTO-RUNNER07G - report content", () => {
  function report() {
    return renderReport({
      generatedAtJst: "2026-06-06T12:00:00+09:00",
      decision: "auto_runner_launchd_health_check_proposal_basis_caution",
      repoDir: REPO_DIR,
      health: readyHealth(),
      template: buildLaunchdHealthCheckTemplate(REPO_DIR),
      templatePath: TEMPLATE_PATH,
      futureInstallCommands: buildFutureInstallCommands(REPO_DIR),
      futureRollbackCommands: buildFutureRollbackCommands(),
      safety: buildSafetyConfirmation()
    });
  }

  it("9. report includes future install commands", () => {
    const text = report();
    expect(text).toContain("launchctl bootstrap gui/$(id -u)");
    expect(text).toContain("~/Library/LaunchAgents/com.yuge.zmi.health-check.plist");
  });

  it("10. report marks install commands as NOT EXECUTED", () => {
    expect(report()).toMatch(/NOT EXECUTED/u);
  });

  it("11. report includes rollback commands", () => {
    expect(report()).toContain("launchctl bootout gui/$(id -u)");
  });

  it("renders CSV with installed=false", () => {
    const csv = renderProposalCsv(buildLaunchdHealthCheckTemplate(REPO_DIR));
    expect(csv).toContain("label");
    expect(csv.trim().split("\n")[1]).toContain("false");
  });
});

describe("AUTO-RUNNER07G - executable safety scans", () => {
  // §9: distinguish inert report text from executable command calls. The
  // service intentionally contains launchctl strings as report DATA; the proof
  // they cannot run is that no process-spawning mechanism exists anywhere.
  it("12. no launchctl is ever executed (no child_process/exec/spawn anywhere)", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/child_process|execSync|execFileSync|spawnSync|spawn\(|\bexec\(/u);
  });

  it("13. no copy to ~/Library/LaunchAgents is executed", () => {
    // No filesystem copy primitive is used at all, so the inert `cp ...` text
    // in the report cannot be performed.
    expect(SCRIPT_SOURCE).not.toMatch(/copyFileSync|cpSync|\bcp\s+-/u);
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,)]*LaunchAgents/u);
  });

  it("14. no collector command is executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/probe:|collect:|manual-run:market-workflow/u);
  });

  it("15. no DB sync command is executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/sync:history-to-db|HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM/iu);
  });

  it("16. no AI context refresh command is executed", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("17. no pricing/PMS output command is executed", () => {
    // Descriptive safety-confirmation field names (e.g. pms_beds24_airhost_output)
    // are inert data. The only way to emit pricing/PMS output without exec (see
    // test 12) is a file write, so scan for writes to such paths.
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*(?:pricing_recommendation|beds24|airhost|price[_-]csv)/iu);
  });

  it("no Playwright/browser automation code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("package contains the proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-launchd-health-check");
  });
});

describe("AUTO-RUNNER07G - decision", () => {
  it("18. decision is basis_caution when template proposed and health ready", () => {
    const decision = decideAutoRunnerLaunchdHealthCheckProposal({
      health: readyHealth(),
      template: buildLaunchdHealthCheckTemplate(REPO_DIR),
      templateFileExists: true
    });
    expect(decision).toBe("auto_runner_launchd_health_check_proposal_basis_caution");
  });

  it("not_ready when health-check mutated state", () => {
    const mutated = buildHealthCheckManualResult({
      artifact: { ...healthArtifact(), mutation_check: { mutation_detected: true } },
      sourceArtifactPath: "hc.json",
      sourcePresent: true
    });
    expect(
      decideAutoRunnerLaunchdHealthCheckProposal({ health: mutated, template: buildLaunchdHealthCheckTemplate(REPO_DIR), templateFileExists: true })
    ).toBe("auto_runner_launchd_health_check_proposal_not_ready");
  });

  it("not_ready when template file missing", () => {
    expect(
      decideAutoRunnerLaunchdHealthCheckProposal({ health: readyHealth(), template: buildLaunchdHealthCheckTemplate(REPO_DIR), templateFileExists: false })
    ).toBe("auto_runner_launchd_health_check_proposal_not_ready");
  });

  it("safety confirmation is all-false", () => {
    const safety = buildSafetyConfirmation();
    expect(Object.values(safety).every((v) => v === false)).toBe(true);
  });
});

// Phase AUTO-RUNNER07G - build launchd dry-run health-check installation proposal.
//
// Writes proposal/debug artifacts only. It installs no plist, calls no launchctl
// command, copies nothing into ~/Library/LaunchAgents, runs no collectors, syncs
// no DB, refreshes no context, runs no query smoke, and generates no pricing/PMS
// output. It is fresh-clone safe: if no prior health-check artifact exists it
// falls back to documented defaults rather than crashing.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
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
} from "../services/autoRunnerLaunchdHealthCheckProposal";

const REPO_DIR = "/Users/gini/Documents/ZMI/zao-market-intelligence";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-launchd-health-check-proposal";
const TEMPLATE_REL_PATH = "ops/launchd/com.yuge.zmi.health-check.plist.template";
const HEALTH_CHECK_ARTIFACT_PREFIX = "auto_runner_health_check_";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// Fresh-clone safe: returns the newest health-check JSON artifact path, or null.
function findLatestHealthCheckArtifact(): string | null {
  const dir = resolve(REPORT_DIR);
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((name) => name.startsWith(HEALTH_CHECK_ARTIFACT_PREFIX) && name.endsWith(".json"))
    .sort();
  if (matches.length === 0) return null;
  return resolve(dir, matches[matches.length - 1]!);
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_launchd_health_check_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const latestHealthCheckPath = findLatestHealthCheckArtifact();
  const sourcePresent = latestHealthCheckPath !== null;
  const healthArtifact: HealthCheckArtifactLike | undefined = sourcePresent
    ? (JSON.parse(readFileSync(latestHealthCheckPath, "utf8")) as HealthCheckArtifactLike)
    : undefined;

  const health = buildHealthCheckManualResult({
    artifact: healthArtifact,
    sourceArtifactPath: latestHealthCheckPath ?? "(none — fresh clone fallback)",
    sourcePresent
  });
  const template = buildLaunchdHealthCheckTemplate(REPO_DIR);
  const templatePath = resolve(TEMPLATE_REL_PATH);
  const templateFileExists = existsSync(templatePath);
  const futureInstallCommands = buildFutureInstallCommands(REPO_DIR);
  const futureRollbackCommands = buildFutureRollbackCommands();
  const safety = buildSafetyConfirmation();
  const decision = decideAutoRunnerLaunchdHealthCheckProposal({ health, template, templateFileExists });
  const plistXml = renderPlistXml(template);

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    repo_dir: REPO_DIR,
    health_check_manual_result: health,
    launchd_template: template,
    launchd_template_path: templatePath,
    launchd_template_file_exists: templateFileExists,
    future_install_commands: futureInstallCommands,
    future_install_commands_executed: false,
    future_rollback_commands: futureRollbackCommands,
    future_rollback_commands_executed: false,
    safety_confirmation: safety,
    next_phase: "AUTO-RUNNER07H — install launchd health-check only, no collectors",
    report_path: "",
    json_path: "",
    csv_path: "",
    debug_artifact_path: debugPath
  };

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  output.report_path = reportPath;
  output.json_path = jsonPath;
  output.csv_path = csvPath;

  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      repoDir: REPO_DIR,
      health,
      template,
      templatePath,
      futureInstallCommands,
      futureRollbackCommands,
      safety
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderProposalCsv(template), "utf8");

  // Debug artifacts (repo-internal only).
  writeJson(resolve(debugPath, "health_check_manual_result.json"), health);
  writeFileSync(resolve(debugPath, "launchd_template_snapshot.xml"), plistXml, "utf8");
  writeJson(resolve(debugPath, "safety_confirmation.json"), safety);
  writeFileSync(resolve(debugPath, "future_install_commands.txt"), `# NOT EXECUTED\n${futureInstallCommands.join("\n")}\n`, "utf8");
  writeFileSync(resolve(debugPath, "future_rollback_commands.txt"), `# NOT EXECUTED\n${futureRollbackCommands.join("\n")}\n`, "utf8");

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
console.log(`decision=${result.decision}`);

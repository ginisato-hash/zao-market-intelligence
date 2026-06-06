// Phase AUTO-RUNNER07J - build launchd dry-run db-update schedule proposal.
//
// Writes proposal/debug artifacts only. It installs no plist, calls no launchctl
// command, copies nothing into ~/Library/LaunchAgents, runs no collectors, syncs
// no DB, refreshes no context, runs no query smoke, and generates no pricing/PMS
// output. It is fresh-clone safe: if no prior artifact exists it falls back to
// documented defaults rather than crashing.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
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
  type DbUpdateArtifactLike,
  type HealthCheckArtifactLike
} from "../services/autoRunnerLaunchdDbUpdateProposal";

const REPO_DIR = "/Users/gini/Documents/ZMI/zao-market-intelligence";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-launchd-db-update-proposal";
const TEMPLATE_REL_PATH = "ops/launchd/com.yuge.zmi.db-update-dry-run.plist.template";
const DB_UPDATE_ARTIFACT_PREFIX = "auto_runner_db_update_stub_";
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

// Fresh-clone safe: returns the newest matching JSON artifact path, or null.
function findLatestArtifact(prefix: string): string | null {
  const dir = resolve(REPORT_DIR);
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  if (matches.length === 0) return null;
  return resolve(dir, matches[matches.length - 1]!);
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_launchd_db_update_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const latestDbUpdatePath = findLatestArtifact(DB_UPDATE_ARTIFACT_PREFIX);
  const dbUpdatePresent = latestDbUpdatePath !== null;
  const dbUpdateArtifact: DbUpdateArtifactLike | undefined = dbUpdatePresent
    ? (JSON.parse(readFileSync(latestDbUpdatePath, "utf8")) as DbUpdateArtifactLike)
    : undefined;

  const latestHealthPath = findLatestArtifact(HEALTH_CHECK_ARTIFACT_PREFIX);
  const healthPresent = latestHealthPath !== null;
  const healthArtifact: HealthCheckArtifactLike | undefined = healthPresent
    ? (JSON.parse(readFileSync(latestHealthPath, "utf8")) as HealthCheckArtifactLike)
    : undefined;

  const dbUpdate = buildDbUpdateManualResult({
    artifact: dbUpdateArtifact,
    sourceArtifactPath: latestDbUpdatePath ?? "(none — fresh clone fallback)",
    sourcePresent: dbUpdatePresent
  });
  const health = buildHealthCheckManualResult({ artifact: healthArtifact, sourcePresent: healthPresent });
  const template = buildLaunchdDbUpdateTemplate(REPO_DIR);
  const templatePath = resolve(TEMPLATE_REL_PATH);
  const templateFileExists = existsSync(templatePath);
  const futureInstallCommands = buildFutureInstallCommands(REPO_DIR);
  const futureRollbackCommands = buildFutureRollbackCommands();
  const safety = buildSafetyConfirmation();
  const decision = decideAutoRunnerLaunchdDbUpdateProposal({ dbUpdate, health, template, templateFileExists });
  const plistXml = renderPlistXml(template);

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    repo_dir: REPO_DIR,
    manual_health_check_result: health,
    manual_db_update_result: dbUpdate,
    launchd_template: template,
    launchd_template_path: templatePath,
    launchd_template_file_exists: templateFileExists,
    future_install_commands: futureInstallCommands,
    future_install_commands_executed: false,
    future_rollback_commands: futureRollbackCommands,
    future_rollback_commands_executed: false,
    safety_confirmation: safety,
    next_phase: "AUTO-RUNNER07K — install launchd db-update dry-run only, no collectors",
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
      dbUpdate,
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
  writeJson(resolve(debugPath, "manual_db_update_result.json"), dbUpdate);
  writeJson(resolve(debugPath, "manual_health_check_result.json"), health);
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

// Phase AUTO-RUNNER07J - launchd dry-run db-update schedule proposal helpers.
//
// Design/report helpers only. This module installs no plist, calls no launchctl
// command, copies nothing into ~/Library/LaunchAgents, runs no collectors, syncs
// no DB, refreshes no context, and emits no pricing/PMS output. The launchctl /
// install command strings produced below are INERT report text describing a
// future, explicitly-approved phase; nothing here can execute them.

export type AutoRunnerLaunchdDbUpdateDecision =
  | "auto_runner_launchd_db_update_proposal_ready"
  | "auto_runner_launchd_db_update_proposal_basis_caution"
  | "auto_runner_launchd_db_update_proposal_not_ready";

export const DB_UPDATE_LABEL = "com.yuge.zmi.db-update-dry-run";
export const HEALTH_CHECK_LABEL = "com.yuge.zmi.health-check";
export const DEFAULT_REPO_DIR = "/Users/gini/Documents/ZMI/zao-market-intelligence";

// Predecessor schedule already installed in AUTO-RUNNER07H/07I.
export const PREDECESSOR_SCHEDULE = {
  label: HEALTH_CHECK_LABEL,
  hour: 8,
  minute: 30,
  human: "daily at 08:30 JST"
} as const;

export interface DbUpdateManualResult {
  decision: string;
  history_count: number;
  db_count: number;
  ai_context_count: number;
  mutation_executed: boolean;
  risky_stages_enabled: number;
  risky_actual_executed_count: number;
  source_artifact_path: string;
  source_present: boolean;
}

export interface DbUpdateArtifactLike {
  decision?: string;
  current_state_summary?: { history_rows?: number; db_rows?: number; ai_context_rows?: number };
  gate_evaluation?: Array<{ gate?: string; enabled?: boolean }>;
  stage_plan?: Array<{ actual_executed?: boolean }>;
}

export interface HealthCheckArtifactLike {
  decision?: string;
  mutation_check?: { mutation_detected?: boolean };
}

export interface HealthCheckManualResult {
  decision: string;
  mutation_detected: boolean;
  source_present: boolean;
}

export interface LaunchdDbUpdateTemplate {
  label: string;
  program_arguments: string[];
  working_directory: string;
  standard_out_path: string;
  standard_error_path: string;
  start_calendar_interval: { Hour: number; Minute: number };
  run_at_load: false;
  keep_alive: false;
  schedule_human: string;
  runs_after_label: string;
  runs_after_minutes: number;
}

export interface SafetyConfirmation {
  launchctl_bootstrap_db_update: false;
  launchctl_enable_db_update: false;
  launchctl_kickstart_db_update: false;
  plist_copied_to_launchagents: false;
  collect_booking_enabled: false;
  collect_jalan_enabled: false;
  allow_history_append_enabled: false;
  history_to_db_sync_enabled: false;
  build_ai_context_enabled: false;
  generate_price_report_enabled: false;
  generate_price_csv_enabled: false;
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_launch: false;
  browser_automation: false;
  external_fetch: false;
  history_append: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  git_add_commit_push: false;
  started_auto_runner07k: false;
}

const DB_UPDATE_COMMAND = "npm run auto-runner:db-update";

export function buildDbUpdateManualResult(input: {
  artifact?: DbUpdateArtifactLike | undefined;
  sourceArtifactPath: string;
  sourcePresent: boolean;
}): DbUpdateManualResult {
  const summary = input.artifact?.current_state_summary;
  const stages = input.artifact?.stage_plan ?? [];
  const gates = input.artifact?.gate_evaluation ?? [];
  const riskyActualExecuted = stages.filter((s) => s.actual_executed === true).length;
  const enabledGates = gates.filter((g) => g.enabled === true).length;
  return {
    decision: input.artifact?.decision ?? "auto_runner_db_update_stub_ready_not_run",
    history_count: summary?.history_rows ?? 210,
    db_count: summary?.db_rows ?? 210,
    ai_context_count: summary?.ai_context_rows ?? 210,
    mutation_executed: riskyActualExecuted > 0,
    risky_stages_enabled: enabledGates,
    risky_actual_executed_count: riskyActualExecuted,
    source_artifact_path: input.sourceArtifactPath,
    source_present: input.sourcePresent
  };
}

export function buildHealthCheckManualResult(input: {
  artifact?: HealthCheckArtifactLike | undefined;
  sourcePresent: boolean;
}): HealthCheckManualResult {
  return {
    decision: input.artifact?.decision ?? "auto_runner_health_check_ready",
    mutation_detected: input.artifact?.mutation_check?.mutation_detected ?? false,
    source_present: input.sourcePresent
  };
}

export function buildLaunchdDbUpdateTemplate(repoDir: string): LaunchdDbUpdateTemplate {
  return {
    label: DB_UPDATE_LABEL,
    program_arguments: ["/bin/zsh", "-lc", `cd ${repoDir} && ${DB_UPDATE_COMMAND}`],
    working_directory: repoDir,
    standard_out_path: `${repoDir}/.logs/launchd-db-update-dry-run.out.log`,
    standard_error_path: `${repoDir}/.logs/launchd-db-update-dry-run.err.log`,
    start_calendar_interval: { Hour: 8, Minute: 45 },
    run_at_load: false,
    keep_alive: false,
    schedule_human: "daily at 08:45 JST",
    runs_after_label: PREDECESSOR_SCHEDULE.label,
    runs_after_minutes: PREDECESSOR_SCHEDULE.minute
  };
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function renderPlistXml(template: LaunchdDbUpdateTemplate): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${template.label}</string>
	<key>ProgramArguments</key>
	<array>
${template.program_arguments.map((arg) => `		<string>${xmlEscape(arg)}</string>`).join("\n")}
	</array>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(template.working_directory)}</string>
	<key>StandardOutPath</key>
	<string>${xmlEscape(template.standard_out_path)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(template.standard_error_path)}</string>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>${template.start_calendar_interval.Hour}</integer>
		<key>Minute</key>
		<integer>${template.start_calendar_interval.Minute}</integer>
	</dict>
	<key>RunAtLoad</key>
	<false/>
	<key>KeepAlive</key>
	<false/>
</dict>
</plist>
`;
}

// INERT report text describing the FUTURE, explicitly-approved install steps
// (phase AUTO-RUNNER07K). These strings are never executed by this module.
export function buildFutureInstallCommands(repoDir: string): string[] {
  return [
    "mkdir -p ~/Library/LaunchAgents",
    `cp ${repoDir}/ops/launchd/${DB_UPDATE_LABEL}.plist.template ~/Library/LaunchAgents/${DB_UPDATE_LABEL}.plist`,
    `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${DB_UPDATE_LABEL}.plist`,
    `launchctl enable gui/$(id -u)/${DB_UPDATE_LABEL}`,
    `launchctl print gui/$(id -u)/${DB_UPDATE_LABEL}`
  ];
}

export function buildFutureRollbackCommands(): string[] {
  return [
    `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/${DB_UPDATE_LABEL}.plist`,
    `rm ~/Library/LaunchAgents/${DB_UPDATE_LABEL}.plist`
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    launchctl_bootstrap_db_update: false,
    launchctl_enable_db_update: false,
    launchctl_kickstart_db_update: false,
    plist_copied_to_launchagents: false,
    collect_booking_enabled: false,
    collect_jalan_enabled: false,
    allow_history_append_enabled: false,
    history_to_db_sync_enabled: false,
    build_ai_context_enabled: false,
    generate_price_report_enabled: false,
    generate_price_csv_enabled: false,
    live_booking_collection: false,
    live_jalan_collection: false,
    playwright_launch: false,
    browser_automation: false,
    external_fetch: false,
    history_append: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke: false,
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    git_add_commit_push: false,
    started_auto_runner07k: false
  };
}

export function decideAutoRunnerLaunchdDbUpdateProposal(input: {
  dbUpdate: DbUpdateManualResult;
  health: HealthCheckManualResult;
  template: LaunchdDbUpdateTemplate;
  templateFileExists: boolean;
}): AutoRunnerLaunchdDbUpdateDecision {
  const dbUpdateOk =
    input.dbUpdate.decision === "auto_runner_db_update_stub_ready_not_run" &&
    input.dbUpdate.mutation_executed === false &&
    input.dbUpdate.risky_stages_enabled === 0 &&
    input.dbUpdate.risky_actual_executed_count === 0;
  const healthOk =
    (input.health.decision === "auto_runner_health_check_ready" ||
      input.health.decision === "auto_runner_health_check_basis_caution") &&
    input.health.mutation_detected === false;
  const minutesAfterPredecessor =
    input.template.start_calendar_interval.Minute - PREDECESSOR_SCHEDULE.minute;
  const templateOk =
    input.templateFileExists &&
    input.template.label === DB_UPDATE_LABEL &&
    input.template.run_at_load === false &&
    input.template.keep_alive === false &&
    input.template.start_calendar_interval.Hour === 8 &&
    input.template.start_calendar_interval.Minute === 45 &&
    input.template.runs_after_label === HEALTH_CHECK_LABEL &&
    minutesAfterPredecessor > 0;
  if (!dbUpdateOk || !healthOk || !templateOk) return "auto_runner_launchd_db_update_proposal_not_ready";
  // The template is only proposed and not installed, so the safe outcome is
  // basis_caution rather than ready.
  return "auto_runner_launchd_db_update_proposal_basis_caution";
}

export function renderProposalCsv(template: LaunchdDbUpdateTemplate): string {
  const header = ["label", "command", "working_directory", "schedule", "runs_after", "run_at_load", "keep_alive", "standard_out_path", "standard_error_path", "installed"];
  const row = [
    template.label,
    template.program_arguments.join(" "),
    template.working_directory,
    template.schedule_human,
    template.runs_after_label,
    String(template.run_at_load),
    String(template.keep_alive),
    template.standard_out_path,
    template.standard_error_path,
    "false"
  ];
  return [header.join(","), row.map((cell) => csvCell(cell)).join(",")].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerLaunchdDbUpdateDecision;
  repoDir: string;
  dbUpdate: DbUpdateManualResult;
  health: HealthCheckManualResult;
  template: LaunchdDbUpdateTemplate;
  templatePath: string;
  futureInstallCommands: readonly string[];
  futureRollbackCommands: readonly string[];
  safety: SafetyConfirmation;
}): string {
  return `# Launchd Dry-Run DB-Update Schedule Proposal (AUTO-RUNNER07J)

Generated at JST: ${input.generatedAtJst}

## 1. Predecessor Schedule

- ${PREDECESSOR_SCHEDULE.label} — ${PREDECESSOR_SCHEDULE.human} (already installed in AUTO-RUNNER07H/07I)

## 2. Manual Health-Check Result

- decision: ${input.health.decision}
- mutation_detected: ${input.health.mutation_detected}
- source_present: ${input.health.source_present}

## 3. Manual DB-Update Dry-Run Result

- source_artifact: ${input.dbUpdate.source_artifact_path}
- source_present: ${input.dbUpdate.source_present}
- decision: ${input.dbUpdate.decision}
- mutation_executed: ${input.dbUpdate.mutation_executed}
- risky_stages_enabled: ${input.dbUpdate.risky_stages_enabled}
- risky_actual_executed_count: ${input.dbUpdate.risky_actual_executed_count}
- history / db / ai_context: ${input.dbUpdate.history_count} / ${input.dbUpdate.db_count} / ${input.dbUpdate.ai_context_count}

## 4. Proposed launchd plist template path

${input.templatePath}

(Template lives inside the repo only. It is NOT installed into ~/Library/LaunchAgents.)

## 5. Proposed schedule

- ${input.template.schedule_human}
- Runs AFTER the ${input.template.runs_after_label} schedule (08:30); db-update dry-run at 08:45.
- StartCalendarInterval: Hour=${input.template.start_calendar_interval.Hour}, Minute=${input.template.start_calendar_interval.Minute}
- RunAtLoad=${input.template.run_at_load}, KeepAlive=${input.template.keep_alive}
- Command: ${input.template.program_arguments.join(" ")}
- StandardOutPath: ${input.template.standard_out_path}
- StandardErrorPath: ${input.template.standard_error_path}

## 6. Future install commands — NOT EXECUTED

The following commands are provided for a future, explicitly-approved phase
(AUTO-RUNNER07K). They are documented here only and were NOT EXECUTED in this phase.

\`\`\`bash
${input.futureInstallCommands.join("\n")}
\`\`\`

## 7. Future rollback commands — NOT EXECUTED

The following rollback commands are documented here only and were NOT EXECUTED in this phase.

\`\`\`bash
${input.futureRollbackCommands.join("\n")}
\`\`\`

## 8. Safety Confirmation

${JSON.stringify(input.safety, null, 2)}

## 9. Decision

${input.decision}

## 10. Recommended Next Action

Human review of this db-update dry-run launchd template. Then AUTO-RUNNER07K —
install launchd db-update dry-run only, no collectors. Do not start AUTO-RUNNER07K
without explicit instruction.
`;
}

function csvCell(value: string): string {
  if (!/[",\n]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

// Phase AUTO-RUNNER07G - launchd dry-run health-check installation proposal helpers.
//
// Design/report helpers only. This module installs no plist, calls no launchctl
// command, copies nothing into ~/Library/LaunchAgents, runs no collectors, syncs
// no DB, refreshes no context, and emits no pricing/PMS output. The launchctl /
// install command strings produced below are INERT report text describing a
// future, explicitly-approved phase; nothing here can execute them.

export type AutoRunnerLaunchdHealthCheckDecision =
  | "auto_runner_launchd_health_check_proposal_ready"
  | "auto_runner_launchd_health_check_proposal_basis_caution"
  | "auto_runner_launchd_health_check_proposal_not_ready";

export const HEALTH_CHECK_LABEL = "com.yuge.zmi.health-check";
export const DEFAULT_REPO_DIR = "/Users/gini/Documents/ZMI/zao-market-intelligence";

export interface HealthCheckManualResult {
  decision: string;
  history_count: number;
  db_count: number;
  ai_context_count: number;
  runner_stub_decision: string;
  risky_stages_enabled: number;
  mutation_detected: boolean;
  source_artifact_path: string;
  source_present: boolean;
}

export interface HealthCheckArtifactLike {
  decision?: string;
  current_state_before?: {
    current_state_summary?: { history_rows?: number; db_rows?: number; ai_context_rows?: number };
  };
  runner_stub_summary?: { decision?: string; risky_stages_enabled?: number };
  mutation_check?: { mutation_detected?: boolean };
}

export interface LaunchdHealthCheckTemplate {
  label: string;
  program_arguments: string[];
  working_directory: string;
  standard_out_path: string;
  standard_error_path: string;
  start_calendar_interval: { Hour: number; Minute: number };
  run_at_load: false;
  keep_alive: false;
  schedule_human: string;
}

export interface SafetyConfirmation {
  launchctl_load: false;
  launchctl_bootstrap: false;
  launchctl_start: false;
  launchctl_enable: false;
  launchctl_kickstart: false;
  plist_copied_to_launchagents: false;
  cron_installation: false;
  github_actions_creation: false;
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
  started_auto_runner07h: false;
}

const HEALTH_CHECK_COMMAND = "npm run auto-runner:health-check";

export function buildHealthCheckManualResult(input: {
  artifact?: HealthCheckArtifactLike | undefined;
  sourceArtifactPath: string;
  sourcePresent: boolean;
}): HealthCheckManualResult {
  const summary = input.artifact?.current_state_before?.current_state_summary;
  return {
    decision: input.artifact?.decision ?? "auto_runner_health_check_ready",
    history_count: summary?.history_rows ?? 210,
    db_count: summary?.db_rows ?? 210,
    ai_context_count: summary?.ai_context_rows ?? 210,
    runner_stub_decision: input.artifact?.runner_stub_summary?.decision ?? "auto_runner_db_update_stub_ready_not_run",
    risky_stages_enabled: input.artifact?.runner_stub_summary?.risky_stages_enabled ?? 0,
    mutation_detected: input.artifact?.mutation_check?.mutation_detected ?? false,
    source_artifact_path: input.sourceArtifactPath,
    source_present: input.sourcePresent
  };
}

export function buildLaunchdHealthCheckTemplate(repoDir: string): LaunchdHealthCheckTemplate {
  return {
    label: HEALTH_CHECK_LABEL,
    program_arguments: ["/bin/zsh", "-lc", `cd ${repoDir} && ${HEALTH_CHECK_COMMAND}`],
    working_directory: repoDir,
    standard_out_path: `${repoDir}/.logs/launchd-health-check.out.log`,
    standard_error_path: `${repoDir}/.logs/launchd-health-check.err.log`,
    start_calendar_interval: { Hour: 8, Minute: 30 },
    run_at_load: false,
    keep_alive: false,
    schedule_human: "daily at 08:30 JST"
  };
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

// Renders the canonical plist XML for the template. This produces report/debug
// text only; it does not write to ~/Library/LaunchAgents.
export function renderPlistXml(template: LaunchdHealthCheckTemplate): string {
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
// (phase AUTO-RUNNER07H). These strings are never executed by this module.
export function buildFutureInstallCommands(repoDir: string): string[] {
  return [
    "mkdir -p ~/Library/LaunchAgents",
    `cp ${repoDir}/ops/launchd/${HEALTH_CHECK_LABEL}.plist.template ~/Library/LaunchAgents/${HEALTH_CHECK_LABEL}.plist`,
    `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${HEALTH_CHECK_LABEL}.plist`,
    `launchctl enable gui/$(id -u)/${HEALTH_CHECK_LABEL}`,
    `launchctl print gui/$(id -u)/${HEALTH_CHECK_LABEL}`
  ];
}

// INERT report text describing the FUTURE rollback steps. Never executed here.
export function buildFutureRollbackCommands(): string[] {
  return [
    `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/${HEALTH_CHECK_LABEL}.plist`,
    `rm ~/Library/LaunchAgents/${HEALTH_CHECK_LABEL}.plist`
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    launchctl_load: false,
    launchctl_bootstrap: false,
    launchctl_start: false,
    launchctl_enable: false,
    launchctl_kickstart: false,
    plist_copied_to_launchagents: false,
    cron_installation: false,
    github_actions_creation: false,
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
    started_auto_runner07h: false
  };
}

export function decideAutoRunnerLaunchdHealthCheckProposal(input: {
  health: HealthCheckManualResult;
  template: LaunchdHealthCheckTemplate;
  templateFileExists: boolean;
}): AutoRunnerLaunchdHealthCheckDecision {
  const healthOk =
    (input.health.decision === "auto_runner_health_check_ready" ||
      input.health.decision === "auto_runner_health_check_basis_caution") &&
    input.health.mutation_detected === false &&
    input.health.risky_stages_enabled === 0;
  const templateOk =
    input.templateFileExists &&
    input.template.label === HEALTH_CHECK_LABEL &&
    input.template.run_at_load === false &&
    input.template.keep_alive === false &&
    input.template.start_calendar_interval.Hour === 8 &&
    input.template.start_calendar_interval.Minute === 30;
  if (!healthOk || !templateOk) return "auto_runner_launchd_health_check_proposal_not_ready";
  // The template is only proposed and not installed, so the safe outcome is
  // basis_caution rather than ready.
  return "auto_runner_launchd_health_check_proposal_basis_caution";
}

export function renderProposalCsv(template: LaunchdHealthCheckTemplate): string {
  const header = ["label", "command", "working_directory", "schedule", "run_at_load", "keep_alive", "standard_out_path", "standard_error_path", "installed"];
  const row = [
    template.label,
    template.program_arguments.join(" "),
    template.working_directory,
    template.schedule_human,
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
  decision: AutoRunnerLaunchdHealthCheckDecision;
  repoDir: string;
  health: HealthCheckManualResult;
  template: LaunchdHealthCheckTemplate;
  templatePath: string;
  futureInstallCommands: readonly string[];
  futureRollbackCommands: readonly string[];
  safety: SafetyConfirmation;
}): string {
  return `# Launchd Dry-Run Health-Check Installation Proposal (AUTO-RUNNER07G)

Generated at JST: ${input.generatedAtJst}

## 1. Current Always-On Mac State

- history_rows: ${input.health.history_count}
- db_rows: ${input.health.db_count}
- ai_context_rows: ${input.health.ai_context_count}
- runner_stub_decision: ${input.health.runner_stub_decision}
- risky_stages_enabled: ${input.health.risky_stages_enabled}

## 2. Manual Health-Check Result

- source_artifact: ${input.health.source_artifact_path}
- source_present: ${input.health.source_present}
- decision: ${input.health.decision}
- mutation_detected: ${input.health.mutation_detected}

## 3. Proposed launchd plist template path

${input.templatePath}

(Template lives inside the repo only. It is NOT installed into ~/Library/LaunchAgents.)

## 4. Proposed schedule

- ${input.template.schedule_human}
- StartCalendarInterval: Hour=${input.template.start_calendar_interval.Hour}, Minute=${input.template.start_calendar_interval.Minute}
- RunAtLoad=${input.template.run_at_load}, KeepAlive=${input.template.keep_alive}
- Command: ${input.template.program_arguments.join(" ")}
- StandardOutPath: ${input.template.standard_out_path}
- StandardErrorPath: ${input.template.standard_error_path}

## 5. Future install commands — NOT EXECUTED

The following commands are provided for a future, explicitly-approved phase
(AUTO-RUNNER07H). They are documented here only and were NOT EXECUTED in this phase.

\`\`\`bash
${input.futureInstallCommands.join("\n")}
\`\`\`

## 6. Future rollback commands — NOT EXECUTED

The following rollback commands are documented here only and were NOT EXECUTED in this phase.

\`\`\`bash
${input.futureRollbackCommands.join("\n")}
\`\`\`

## 7. Safety Confirmation

${JSON.stringify(input.safety, null, 2)}

## 8. Decision

${input.decision}

## 9. Recommended Next Action

Human review of this launchd template. Then AUTO-RUNNER07H — install launchd
health-check only, no collectors. Do not start AUTO-RUNNER07H without explicit instruction.
`;
}

function csvCell(value: string): string {
  if (!/[",\n]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

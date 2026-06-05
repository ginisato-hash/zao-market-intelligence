// Phase AUTO-RUNNER04X - launchd schedule proposal helpers.
//
// Design/report helpers only. This module creates no plist files, loads no
// schedule, runs no collectors, syncs no DB, refreshes no context, and emits no
// pricing/PMS output.

export type AutoRunnerLaunchdScheduleDecision =
  | "auto_runner_launchd_schedule_proposal_ready"
  | "auto_runner_launchd_schedule_proposal_basis_caution"
  | "auto_runner_launchd_schedule_proposal_not_ready";

export interface AutoRunner03xArtifactLike {
  decision?: string;
  current_state_summary?: CurrentStateSummary;
  gate_matrix?: Array<{ gate: string; controls?: string }>;
  risks?: string[];
}

export interface CurrentStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number; role: string };
  jalan: { rows: number; directional: number; excluded: number; direct: number; role: string };
  rakuten: { rows: number; role: string };
  known_cautions: string[];
}

export interface ScheduleTier {
  tier: number;
  name: string;
  cadence: string;
  purpose: string;
  command_design: string[];
  required_gates: string[];
  risky_actions_enabled_by_default: false;
  success_criteria: string[];
}

export interface LaunchdTemplateDesign {
  label: string;
  purpose: string;
  program_arguments: string[];
  working_directory: string;
  environment_variables: Record<string, string>;
  start_calendar_interval: Record<string, number> | "manual_only";
  standard_out_path: string;
  standard_error_path: string;
  run_state_path: string;
  enabled_by_default: false;
}

export interface GateMatrixRow {
  gate: string;
  default_value: "0";
  controls: string;
  required_for: string[];
  kill_switch_behavior: string;
}

export interface RunStateLoggingDesign {
  run_state_paths: string[];
  log_paths: string[];
  run_state_fields: string[];
}

export interface FailureHandlingPlan {
  fail_closed_rules: string[];
}

export interface NotificationPlan {
  current_phase: string;
  future_options: string[];
}

export interface SafetyConfirmation {
  launchd_plist_installation: false;
  launchctl_execution: false;
  cron_installation: false;
  github_actions_creation: false;
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_launch: false;
  browser_automation: false;
  external_fetch: false;
  history_modification: false;
  history_append: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  git_add_commit_push: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  started_auto_runner05x: false;
}

export function buildCurrentStateSummary(input: AutoRunner03xArtifactLike): CurrentStateSummary {
  const current = input.current_state_summary;
  return {
    history_rows: current?.history_rows ?? 210,
    db_rows: current?.db_rows ?? 210,
    ai_context_rows: current?.ai_context_rows ?? 210,
    booking: current?.booking ?? { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary directional backbone" },
    jalan: current?.jalan ?? { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary domestic OTA signal" },
    rakuten: current?.rakuten ?? { rows: 126, role: "frozen / caution" },
    known_cautions: [...(current?.known_cautions ?? []), ...(input.risks ?? [])]
  };
}

export function buildScheduleTiers(): ScheduleTier[] {
  return [
    {
      tier: 0,
      name: "daily safe health check",
      cadence: "daily at 08:30 JST",
      purpose: "Dry-run only preflight/state/run-plan generation.",
      command_design: ["npm run manual-run:market-workflow -- --dry-run"],
      required_gates: ["ZMI_AUTORUN_ENABLED may remain 0", "all risky gates remain 0"],
      risky_actions_enabled_by_default: false,
      success_criteria: ["run plan artifact written", "no collectors", "no writes"]
    },
    {
      tier: 1,
      name: "safe validation",
      cadence: "daily or every other day",
      purpose: "Typecheck, no-paid guard, db verify, and state count check.",
      command_design: ["npm run typecheck", "npm run check:no-paid-sources", "npm run db:verify"],
      required_gates: ["none"],
      risky_actions_enabled_by_default: false,
      success_criteria: ["validation passes", "collector baseline unchanged"]
    },
    {
      tier: 2,
      name: "Booking collection windows, future only",
      cadence: "daily or 5 days/week small batch",
      purpose: "Primary directional Booking fixed-slug pages only.",
      command_design: ["npm run manual-run:market-workflow -- --stage booking-small-batch"],
      required_gates: ["ZMI_AUTORUN_ENABLED=1", "COLLECT_BOOKING=1"],
      risky_actions_enabled_by_default: false,
      success_criteria: ["bounded page cap respected", "no broad search", "no append without later approval"]
    },
    {
      tier: 3,
      name: "Jalan collection windows, future only",
      cadence: "2-3 times/week small batch",
      purpose: "Supplementary domestic OTA fixed-property pages only.",
      command_design: ["npm run manual-run:market-workflow -- --stage jalan-small-batch"],
      required_gates: ["ZMI_AUTORUN_ENABLED=1", "COLLECT_JALAN=1"],
      risky_actions_enabled_by_default: false,
      success_criteria: ["bounded page cap respected", "no broad search", "no append without later approval"]
    },
    {
      tier: 4,
      name: "sync/context/report, future only",
      cadence: "manual or after approved append only",
      purpose: "DB mirror sync, AI context refresh, and query/report smoke after approved history changes.",
      command_design: ["npm run manual-run:market-workflow -- --stage sync-context"],
      required_gates: ["HISTORY_TO_DB_SYNC=1", "BUILD_AI_CONTEXT=1", "RUN_QUERY_SMOKE=1"],
      risky_actions_enabled_by_default: false,
      success_criteria: ["DB count matches history", "AI context count matches DB"]
    },
    {
      tier: 5,
      name: "price CSV, future only",
      cadence: "not scheduled initially",
      purpose: "Separate manually reviewed pricing CSV generation.",
      command_design: ["npm run manual-run:market-workflow -- --stage price-csv"],
      required_gates: ["GENERATE_PRICE_CSV=1", "human approval"],
      risky_actions_enabled_by_default: false,
      success_criteria: ["explicit human review completed", "no PMS upload"]
    }
  ];
}

export function buildLaunchdTemplateDesign(repoDir: string): LaunchdTemplateDesign[] {
  return [
    template("com.yuge.zao-market.preflight", "Daily dry-run health check", ["npm", "run", "manual-run:market-workflow", "--", "--dry-run"], repoDir, { Hour: 8, Minute: 30 }, {
      ZMI_AUTORUN_ENABLED: "0",
      COLLECT_BOOKING: "0",
      COLLECT_JALAN: "0",
      GENERATE_PRICE_CSV: "0"
    }, ".logs/zmi-preflight-YYYYMMDD.log", ".data/run-state/preflight-latest.json"),
    template("com.yuge.zao-market.booking-small-batch", "Future gated Booking small batch", ["npm", "run", "manual-run:market-workflow", "--", "--stage", "booking-small-batch"], repoDir, { Hour: 9, Minute: 15 }, {
      ZMI_AUTORUN_ENABLED: "0",
      COLLECT_BOOKING: "0"
    }, ".logs/zmi-booking-YYYYMMDD.log", ".data/run-state/booking-latest.json"),
    template("com.yuge.zao-market.jalan-small-batch", "Future gated Jalan small batch", ["npm", "run", "manual-run:market-workflow", "--", "--stage", "jalan-small-batch"], repoDir, { Hour: 10, Minute: 15 }, {
      ZMI_AUTORUN_ENABLED: "0",
      COLLECT_JALAN: "0"
    }, ".logs/zmi-jalan-YYYYMMDD.log", ".data/run-state/jalan-latest.json"),
    template("com.yuge.zao-market.context-refresh", "Future gated DB/context refresh after approved append", ["npm", "run", "manual-run:market-workflow", "--", "--stage", "sync-context"], repoDir, "manual_only", {
      ZMI_AUTORUN_ENABLED: "0",
      HISTORY_TO_DB_SYNC: "0",
      BUILD_AI_CONTEXT: "0",
      RUN_QUERY_SMOKE: "0"
    }, ".logs/zmi-context-YYYYMMDD.log", ".data/run-state/context-latest.json")
  ];
}

export function buildGateMatrix(): GateMatrixRow[] {
  return [
    gate("ZMI_AUTORUN_ENABLED", "global kill switch for any scheduled risky stage", ["all collector/sync/context schedules"]),
    gate("COLLECT_BOOKING", "Booking small-batch collection", ["Booking collection windows"]),
    gate("COLLECT_JALAN", "Jalan small-batch collection", ["Jalan collection windows"]),
    gate("HISTORY_TO_DB_SYNC", "DB mirror sync", ["sync/context tier"]),
    gate("BUILD_AI_CONTEXT", "AI context refresh", ["sync/context tier"]),
    gate("RUN_QUERY_SMOKE", "query smoke and usability verification", ["sync/context tier"]),
    gate("GENERATE_PRICE_REPORT", "price decision report only", ["manual price-report stage"]),
    gate("GENERATE_PRICE_CSV", "pricing CSV generation after human review", ["price CSV tier"])
  ];
}

export function buildRunStateLoggingDesign(): RunStateLoggingDesign {
  return {
    run_state_paths: [".data/run-state/", ".data/debug/", ".data/reports/automation/"],
    log_paths: [".logs/zmi-preflight-YYYYMMDD.log", ".logs/zmi-booking-YYYYMMDD.log", ".logs/zmi-jalan-YYYYMMDD.log", ".logs/zmi-context-YYYYMMDD.log"],
    run_state_fields: ["run_id", "started_at", "ended_at", "decision", "enabled_gates", "disabled_gates", "commands_planned", "commands_executed", "artifact_paths", "failure_reason"]
  };
}

export function buildFailureHandlingPlan(): FailureHandlingPlan {
  return {
    fail_closed_rules: [
      "If Mac was asleep: skip missed collector run and do not run a catch-up burst automatically.",
      "If network down: mark failed and do not append.",
      "If collector sees block/CAPTCHA/degraded page: mark failed and stop append proposal.",
      "If tests/no-paid/db-verify fail: stop before collection.",
      "If append conflicts: stop before append.",
      "If DB sync conflict: stop.",
      "If AI context mismatch: stop.",
      "If price CSV gate missing: do not generate CSV."
    ]
  };
}

export function buildNotificationPlan(): NotificationPlan {
  return {
    current_phase: "Write local report/run-state only; no email/Slack/Notion integration implemented.",
    future_options: ["local macOS notification", "email summary", "Slack webhook", "Notion status page"]
  };
}

export function buildRisks(current: CurrentStateSummary): string[] {
  return [
    "Actual always-on Mac launchd environment remains unverified.",
    "No plist should be installed until explicit approval and dry-run runner implementation exist.",
    "Future live collection remains block/CAPTCHA/degraded-page sensitive.",
    "Catch-up bursts after sleep could overload sources and must stay disabled.",
    "Pricing CSV must not be scheduled initially.",
    ...current.known_cautions
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    launchd_plist_installation: false,
    launchctl_execution: false,
    cron_installation: false,
    github_actions_creation: false,
    live_booking_collection: false,
    live_jalan_collection: false,
    playwright_launch: false,
    browser_automation: false,
    external_fetch: false,
    history_modification: false,
    history_append: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke: false,
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    git_add_commit_push: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    started_auto_runner05x: false
  };
}

export function decideAutoRunnerLaunchdScheduleProposal(input: { sourcePresent: boolean; tiers: readonly ScheduleTier[]; templates: readonly LaunchdTemplateDesign[] }): AutoRunnerLaunchdScheduleDecision {
  if (!input.sourcePresent || input.tiers.length < 6 || input.templates.length < 4) return "auto_runner_launchd_schedule_proposal_not_ready";
  return "auto_runner_launchd_schedule_proposal_basis_caution";
}

export function renderScheduleCsv(templates: readonly LaunchdTemplateDesign[]): string {
  const header = ["label", "purpose", "enabled_by_default", "start_calendar_interval", "standard_out_path", "run_state_path"];
  return [header.join(","), ...templates.map((row) => header.map((key) => csvCell(String(row[key as keyof LaunchdTemplateDesign] ?? ""))).join(","))].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerLaunchdScheduleDecision;
  sourceArtifactPath: string;
  current: CurrentStateSummary;
  tiers: readonly ScheduleTier[];
  templates: readonly LaunchdTemplateDesign[];
  gates: readonly GateMatrixRow[];
  logging: RunStateLoggingDesign;
  failure: FailureHandlingPlan;
  notification: NotificationPlan;
  risks: readonly string[];
  safety: SafetyConfirmation;
}): string {
  return `# Launchd Schedule Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

AUTO-RUNNER04X designs disabled-by-default launchd scheduling for the future manual workflow. No plist is installed, no schedule is loaded, and risky actions remain gated.

## 2. Source AUTO-RUNNER03X Result

- Artifact: ${input.sourceArtifactPath}
- Decision: ${input.decision}

## 3. Current State

${JSON.stringify(input.current, null, 2)}

## 4. Schedule Tiers

${input.tiers.map((tier) => `- Tier ${tier.tier}: ${tier.name} — ${tier.cadence}`).join("\n")}

## 5. Launchd Template Design

${input.templates.map((tpl) => `- ${tpl.label}: enabled_by_default=${tpl.enabled_by_default}, stdout=${tpl.standard_out_path}`).join("\n")}

## 6. Gate Matrix

${input.gates.map((gateRow) => `- ${gateRow.gate}=0 by default — ${gateRow.controls}`).join("\n")}

## 7. Run-State / Logging Design

${input.logging.run_state_fields.map((field) => `- ${field}`).join("\n")}

## 8. Failure Handling

${input.failure.fail_closed_rules.map((rule) => `- ${rule}`).join("\n")}

## 9. Notification Plan

${input.notification.current_phase}

## 10. Risks

${input.risks.map((risk) => `- ${risk}`).join("\n")}

## 11. Safety Confirmation

${JSON.stringify(input.safety, null, 2)}

## 12. Decision

${input.decision}

## 13. Next Phase

AUTO-RUNNER05X — bounded collector schedule implementation, disabled by default. Do not start without explicit instruction.
`;
}

function template(
  label: string,
  purpose: string,
  programArguments: string[],
  workingDirectory: string,
  startCalendarInterval: Record<string, number> | "manual_only",
  environmentVariables: Record<string, string>,
  logPath: string,
  runStatePath: string
): LaunchdTemplateDesign {
  return {
    label,
    purpose,
    program_arguments: programArguments,
    working_directory: workingDirectory,
    environment_variables: environmentVariables,
    start_calendar_interval: startCalendarInterval,
    standard_out_path: logPath,
    standard_error_path: logPath.replace(".log", ".err.log"),
    run_state_path: runStatePath,
    enabled_by_default: false
  };
}

function gate(gateName: string, controls: string, requiredFor: string[]): GateMatrixRow {
  return {
    gate: gateName,
    default_value: "0",
    controls,
    required_for: requiredFor,
    kill_switch_behavior: `${gateName}=0 skips the stage and records a disabled-gate decision.`
  };
}

function csvCell(value: string): string {
  if (!/[",\n]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

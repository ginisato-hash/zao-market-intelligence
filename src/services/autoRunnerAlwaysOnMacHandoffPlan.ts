// Phase AUTO-RUNNER-HANDOFF01X - always-on Mac handoff plan.
//
// Pure planning/report helpers only. This module does not mutate Git,
// .gitignore, history, DB, AI context, schedules, collectors, or pricing/PMS
// outputs.

export type AutoRunnerAlwaysOnMacHandoffDecision =
  | "auto_runner_always_on_mac_handoff_plan_ready"
  | "auto_runner_always_on_mac_handoff_plan_basis_caution"
  | "auto_runner_always_on_mac_handoff_plan_not_ready";

export interface CurrentStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number };
  jalan: { rows: number; directional: number; excluded: number; direct: number };
  rakuten: { rows: number; role: string };
}

export interface GitStatusSummary {
  tracked_file_count: number;
  status_entries: string[];
  modified_count: number;
  untracked_count: number;
  gitignore_blanket_ignores_data: boolean;
  gitignore_ignores_sqlite: boolean;
}

export interface GitignoreSummary {
  blanket_data_ignore: boolean;
  sqlite_ignore: boolean;
  env_ignore: boolean;
  history_exception_present: boolean;
}

export interface HandoffFileMatrixItem {
  path_or_pattern: string;
  category: "transfer_through_github" | "canonical_transfer_with_approval" | "regenerate_on_always_on_mac" | "archive_or_ignore" | "never_transfer";
  action: string;
  reason: string;
}

export interface ChecklistItem {
  step: number;
  command_or_action: string;
  execution_location: "future_always_on_mac";
  execute_in_this_phase: false;
  purpose: string;
}

export interface AcceptanceCriteria {
  required_counts: {
    history: 210;
    db: 210;
    ai_context: 210;
    booking: 46;
    jalan: 38;
    rakuten: 126;
  };
  runner_expectations: string[];
}

export interface SafetyConfirmation {
  execution_location_current_implementation_mac: true;
  always_on_mac_commands_executed: false;
  git_mutation: false;
  gitignore_modified: false;
  archive_created: false;
  history_modified: false;
  history_appended: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_launch: false;
  browser_automation: false;
  external_fetch: false;
  launchd_cron_activation: false;
  github_actions_creation: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  started_auto_runner07g: false;
}

export interface Source07fLike {
  decision?: string;
  current_state_after?: { current_state_summary?: Partial<CurrentStateSummary> };
}

export function buildCurrentStateSummary(source07f: Source07fLike): CurrentStateSummary {
  const state = source07f.current_state_after?.current_state_summary;
  return {
    history_rows: state?.history_rows ?? 210,
    db_rows: state?.db_rows ?? 210,
    ai_context_rows: state?.ai_context_rows ?? 210,
    booking: state?.booking ?? { rows: 46, directional: 42, excluded: 4, direct: 0 },
    jalan: state?.jalan ?? { rows: 38, directional: 8, excluded: 24, direct: 6 },
    rakuten: state?.rakuten ?? { rows: 126, role: "frozen / caution" }
  };
}

export function buildGitStatusSummary(input: { statusEntries: string[]; trackedFiles: string[]; gitignoreText: string }): GitStatusSummary {
  return {
    tracked_file_count: input.trackedFiles.length,
    status_entries: input.statusEntries,
    modified_count: input.statusEntries.filter((entry) => entry.startsWith(" M") || entry.startsWith("M ")).length,
    untracked_count: input.statusEntries.filter((entry) => entry.startsWith("??")).length,
    gitignore_blanket_ignores_data: /^\s*\.data\/(?:\*)?\s*$/mu.test(input.gitignoreText),
    gitignore_ignores_sqlite: /^\s*\*\.sqlite\s*$/mu.test(input.gitignoreText)
  };
}

export function buildGitignoreSummary(gitignoreText: string): GitignoreSummary {
  return {
    blanket_data_ignore: /^\s*\.data\/(?:\*)?\s*$/mu.test(gitignoreText),
    sqlite_ignore: /^\s*\*\.sqlite\s*$/mu.test(gitignoreText),
    env_ignore: /^\s*\.env\s*$/mu.test(gitignoreText) && /^\s*\.env\.\*\s*$/mu.test(gitignoreText),
    history_exception_present: /!\.data\/history\/zao_signals_\*\.csv/u.test(gitignoreText)
  };
}

export function buildHandoffFileMatrix(): HandoffFileMatrixItem[] {
  return [
    item("src/**", "transfer_through_github", "commit after explicit human approval", "Source code is required on the always-on Mac."),
    item("tests/**", "transfer_through_github", "commit after explicit human approval", "Tests verify the handoff and runner safety."),
    item("package.json / package-lock.json", "transfer_through_github", "commit after explicit human approval", "Dependency and script manifests are required for bootstrap."),
    item("tsconfig/config files / README / docs", "transfer_through_github", "commit after explicit human approval", "Project configuration and operator docs are required."),
    item(".data/history/zao_signals_*.csv", "canonical_transfer_with_approval", "commit only after Git policy approval", "Canonical history is the source of truth for DB and AI context regeneration."),
    item(".data/zao-market-intelligence.sqlite", "regenerate_on_always_on_mac", "do not commit; regenerate", "SQLite mirror is regenerated from canonical history."),
    item(".data/ai-context/**", "regenerate_on_always_on_mac", "do not commit; regenerate", "AI context is rebuilt from history/DB on the target Mac."),
    item(".data/debug/** / .data/screenshots/** / .data/reports/** / .logs/**", "archive_or_ignore", "archive externally or ignore", "Debug, screenshots, reports, and logs are noisy or large audit artifacts."),
    item(".env / .env.* / secrets / cookies / paid proxy keys / PMS credentials", "never_transfer", "never commit or archive in normal bundle", "Secrets and session state must be installed manually if ever needed.")
  ];
}

export function buildFutureGitignoreRecommendation(): string[] {
  return [
    ".data/*",
    "!.data/history/",
    "!.data/history/zao_signals_*.csv",
    ".data/history/.backup/",
    ".data/debug/",
    ".data/screenshots/",
    ".data/reports/",
    ".data/ai-context/",
    ".data/run-state/",
    ".logs/",
    "*.sqlite",
    ".env",
    ".env.*"
  ];
}

export function buildAlwaysOnMacBootstrapChecklist(): ChecklistItem[] {
  const commands: Array<[string, string]> = [
    ["git clone <repo-url>", "Clone the approved repository on the always-on Mac."],
    ["cd zao-market-intelligence", "Enter the cloned repository."],
    ["npm install", "Install dependencies on the always-on Mac."],
    ["npm run typecheck", "Verify TypeScript."],
    ["npm run test", "Verify full test suite."],
    ["npm run check:no-paid-sources", "Verify paid-source guard."],
    ["npm run db:verify", "Verify read-only DB baseline if DB exists."],
    ["EXPECTED_HISTORY_ROW_COUNT=210 npm run sync:history-to-db:fresh", "Confirm fresh sync helper fails closed without DB write gate."],
    ["HISTORY_TO_DB_SYNC=1 EXPECTED_HISTORY_ROW_COUNT=210 npm run sync:history-to-db:fresh", "Regenerate/sync DB from canonical history after approval."],
    ["npm run build:ai-context-packs", "Regenerate AI context from history/DB."],
    ["npm run auto-runner:health-check", "Verify runner readiness on the always-on Mac."],
    ["npm run auto-runner:db-update", "Verify planner-only DB update stub remains ready_not_run."]
  ];
  return commands.map(([command, purpose], index) => ({
    step: index + 1,
    command_or_action: command,
    execution_location: "future_always_on_mac",
    execute_in_this_phase: false,
    purpose
  }));
}

export function buildAcceptanceCriteria(): AcceptanceCriteria {
  return {
    required_counts: { history: 210, db: 210, ai_context: 210, booking: 46, jalan: 38, rakuten: 126 },
    runner_expectations: [
      "auto-runner:health-check returns ready or acceptable basis_caution",
      "auto-runner:db-update returns ready_not_run",
      "risky_stages_enabled = 0",
      "mutation_detected = false",
      "no live collector has run"
    ]
  };
}

export function buildFailureHandling(): string[] {
  return [
    "git clone fails: stop; check repo access and SSH/HTTPS credentials.",
    "npm install fails: stop; check Node/npm version and lockfile.",
    "history row count != 210: stop; do not run DB sync; verify .data/history transfer.",
    "duplicate row_id detected: stop; do not run DB sync; manual review.",
    "sync:history-to-db:fresh no-env does not fail closed: stop; helper safety regression.",
    "HISTORY_TO_DB_SYNC=1 sync fails: stop; do not build AI context; inspect sync artifact.",
    "AI context row count != 210: stop; do not run launchd; inspect context build.",
    "health-check not ready: stop; inspect run-state/log/debug.",
    "auto-runner:db-update mutation_detected=true: stop; do not schedule."
  ];
}

export function buildRisks(): string[] {
  return [
    "GitHub commit/push is not performed in this phase and requires human approval.",
    ".gitignore currently blanket-ignores .data/, so canonical history transfer needs a future policy change.",
    "The always-on Mac environment has not been verified yet.",
    "DB and AI context regeneration are future target-Mac actions, not current implementation-Mac actions."
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    execution_location_current_implementation_mac: true,
    always_on_mac_commands_executed: false,
    git_mutation: false,
    gitignore_modified: false,
    archive_created: false,
    history_modified: false,
    history_appended: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke: false,
    live_booking_collection: false,
    live_jalan_collection: false,
    playwright_launch: false,
    browser_automation: false,
    external_fetch: false,
    launchd_cron_activation: false,
    github_actions_creation: false,
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    started_auto_runner07g: false
  };
}

export function decideHandoffPlan(input: { source07fPresent: boolean; currentStateReady: boolean; handoffMatrixReady: boolean; futureManualActionsRemain: boolean }): AutoRunnerAlwaysOnMacHandoffDecision {
  if (!input.source07fPresent || !input.currentStateReady || !input.handoffMatrixReady) return "auto_runner_always_on_mac_handoff_plan_not_ready";
  if (input.futureManualActionsRemain) return "auto_runner_always_on_mac_handoff_plan_basis_caution";
  return "auto_runner_always_on_mac_handoff_plan_ready";
}

export function renderMatrixCsv(matrix: readonly HandoffFileMatrixItem[]): string {
  const rows = [["path_or_pattern", "category", "action", "reason"]];
  for (const entry of matrix) rows.push([entry.path_or_pattern, entry.category, entry.action, entry.reason]);
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerAlwaysOnMacHandoffDecision;
  source07fPath: string;
  current: CurrentStateSummary;
  gitStatus: GitStatusSummary;
  gitignore: GitignoreSummary;
  matrix: HandoffFileMatrixItem[];
  gitignoreRecommendation: string[];
  checklist: ChecklistItem[];
  acceptance: AcceptanceCriteria;
  failureHandling: string[];
  risks: string[];
  safety: SafetyConfirmation;
  nextPhase: string;
}): string {
  return `# Always-On Mac Handoff Plan

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary
AUTO-RUNNER-HANDOFF01X is executed on the current implementation Mac. It prepares a future always-on Mac handoff checklist only; no Git mutation, sync, AI context refresh, collector, schedule, pricing CSV, or PMS output is executed in this phase.

## 2. Source AUTO-RUNNER07F Result
- Source artifact: ${input.source07fPath}
- Latest health decision: ${input.decision}

## 3. Current State
- History rows: ${input.current.history_rows}
- DB rows: ${input.current.db_rows}
- AI context rows: ${input.current.ai_context_rows}
- Booking: ${input.current.booking.rows} rows (${input.current.booking.directional} directional, ${input.current.booking.excluded} excluded, ${input.current.booking.direct} direct)
- Jalan: ${input.current.jalan.rows} rows (${input.current.jalan.directional} directional, ${input.current.jalan.excluded} excluded, ${input.current.jalan.direct} direct)
- Rakuten: ${input.current.rakuten.rows} rows, ${input.current.rakuten.role}

## 4. Git / .gitignore State
- Tracked files: ${input.gitStatus.tracked_file_count}
- Modified entries: ${input.gitStatus.modified_count}
- Untracked entries: ${input.gitStatus.untracked_count}
- .data blanket ignored: ${input.gitignore.blanket_data_ignore}
- SQLite ignored: ${input.gitignore.sqlite_ignore}
- History exception present: ${input.gitignore.history_exception_present}

## 5. Handoff File Matrix
${input.matrix.map((entry) => `- ${entry.path_or_pattern}: ${entry.category}; ${entry.action}; ${entry.reason}`).join("\n")}

## 6. Future .gitignore Recommendation
Do not apply this in this phase. Future proposed rules:
\`\`\`gitignore
${input.gitignoreRecommendation.join("\n")}
\`\`\`

## 7. Always-On Mac Bootstrap Checklist
This is a future always-on Mac checklist. Do not execute in this phase.
${input.checklist.map((entry) => `${entry.step}. ${entry.command_or_action} — ${entry.purpose}`).join("\n")}

Do not run live collectors yet. Do not run launchd yet. Do not run pricing CSV. Do not run PMS/Beds24/AirHost outputs.

## 8. Acceptance Criteria
- history = ${input.acceptance.required_counts.history}
- DB = ${input.acceptance.required_counts.db}
- AI context = ${input.acceptance.required_counts.ai_context}
- Booking = ${input.acceptance.required_counts.booking}
- Jalan = ${input.acceptance.required_counts.jalan}
- Rakuten = ${input.acceptance.required_counts.rakuten}
${input.acceptance.runner_expectations.map((item) => `- ${item}`).join("\n")}

## 9. Failure Handling
${input.failureHandling.map((item) => `- ${item}`).join("\n")}

## 10. Risks
${input.risks.map((item) => `- ${item}`).join("\n")}

## 11. Safety Confirmation
${Object.entries(input.safety).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## 12. Decision
${input.decision}

## 13. Next Phase
${input.nextPhase}
`;
}

function item(path_or_pattern: string, category: HandoffFileMatrixItem["category"], action: string, reason: string): HandoffFileMatrixItem {
  return { path_or_pattern, category, action, reason };
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

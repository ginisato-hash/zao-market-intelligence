// Phase AUTO-RUNNER02X - always-on Mac bootstrap proposal helpers.
//
// Proposal/report helpers only. This module does not modify history, write or
// sync DB rows, refresh AI context, launch collectors, install launchd/cron, or
// generate pricing/PMS output.

export type AutoRunnerBootstrapDecision =
  | "auto_runner_bootstrap_proposal_ready"
  | "auto_runner_bootstrap_proposal_basis_caution"
  | "auto_runner_bootstrap_proposal_not_ready";

export interface AutoRunner01xArtifactLike {
  decision?: string;
  current_repo_state?: {
    trackedFileCount?: number;
    uncommittedEntryCount?: number;
    gitignoreIgnoresDataDir?: boolean;
    gitignoreIgnoresSqlite?: boolean;
    envExamplePresent?: boolean;
  };
  canonical_data_inventory?: {
    historyRows?: number;
    dbRows?: number;
    aiContextRows?: number;
    bookingRows?: number;
    jalanRows?: number;
    rakutenRows?: number;
  };
  gitignore_recommendations?: Record<string, unknown>;
  risks?: string[];
}

export interface CurrentStateSummary {
  auto_runner01x_decision: string;
  tracked_files: number;
  uncommitted_entries: number;
  gitignore_ignores_data: boolean;
  gitignore_ignores_sqlite: boolean;
  env_example_present: boolean;
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  source_counts: Record<"booking" | "jalan" | "rakuten", number>;
  current_blockers: string[];
}

export interface PlanSection {
  title: string;
  commands: string[];
  notes: string[];
}

export interface BootstrapPreconditions {
  checklist: string[];
  prohibited_inputs: string[];
}

export interface CanonicalHistoryVerificationPlan {
  expected_history_rows: 210;
  expected_source_counts: Record<"booking" | "jalan" | "rakuten", number>;
  expected_schema_version: "zao_local_history_v1";
  required_checks: string[];
  fail_closed_if: string[];
}

export interface DbRegenerationPlan {
  recommended_future_sequence: string[];
  prerequisites: string[];
  fail_closed_if: string[];
  safer_future_command: string;
}

export interface AiContextRegenerationPlan {
  recommended_future_sequence: string[];
  expected_result: string;
  fail_closed_if: string[];
}

export interface LocalDirectoryLayout {
  preferred_external_layout: string[];
  repo_internal_layout: string[];
  recommendation: string;
}

export interface LoggingBackupPolicy {
  logs: string[];
  backups: string[];
  artifact_retention: string[];
}

export interface FailureHandlingPlan {
  fail_closed_rules: string[];
}

export interface FutureBootstrapScriptOutline {
  proposed_file: string;
  shell_outline: string[];
  executable_in_this_phase: false;
}

export interface SafetyConfirmation {
  git_add_commit_push: false;
  git_remote_changes: false;
  github_actions_file_creation: false;
  launchd_file_creation: false;
  cron_file_creation: false;
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_browser_launch: false;
  external_fetch: false;
  history_modification: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  started_auto_runner03x: false;
}

export function buildCurrentStateSummary(input: {
  autoRunner01x: AutoRunner01xArtifactLike;
  historyRows: number;
  sourceCounts: Partial<Record<"booking" | "jalan" | "rakuten", number>>;
  aiContextRows: number;
}): CurrentStateSummary {
  const repo = input.autoRunner01x.current_repo_state ?? {};
  const inv = input.autoRunner01x.canonical_data_inventory ?? {};
  const blockers: string[] = [];
  if (repo.gitignoreIgnoresDataDir) blockers.push("blanket_data_gitignore_blocks_history_transfer_until_policy_is_approved");
  if ((repo.uncommittedEntryCount ?? 0) > 0) blockers.push("working_tree_has_uncommitted_entries_requiring_manual_review");
  return {
    auto_runner01x_decision: input.autoRunner01x.decision ?? "unknown",
    tracked_files: repo.trackedFileCount ?? 0,
    uncommitted_entries: repo.uncommittedEntryCount ?? 0,
    gitignore_ignores_data: repo.gitignoreIgnoresDataDir === true,
    gitignore_ignores_sqlite: repo.gitignoreIgnoresSqlite === true,
    env_example_present: repo.envExamplePresent === true,
    history_rows: input.historyRows || inv.historyRows || 0,
    db_rows: inv.dbRows ?? input.aiContextRows,
    ai_context_rows: input.aiContextRows || inv.aiContextRows || 0,
    source_counts: {
      booking: input.sourceCounts.booking ?? inv.bookingRows ?? 0,
      jalan: input.sourceCounts.jalan ?? inv.jalanRows ?? 0,
      rakuten: input.sourceCounts.rakuten ?? inv.rakutenRows ?? 0
    },
    current_blockers: blockers
  };
}

export function buildBootstrapPreconditions(): BootstrapPreconditions {
  return {
    checklist: [
      "Dedicated macOS user account for the runner if possible.",
      "Stable power and sleep disabled or keep-awake configured in a later approved phase.",
      "Stable network.",
      "Sufficient disk space for repo, browser cache, screenshots, debug archives, and backups.",
      "Xcode Command Line Tools available if native npm dependencies require them.",
      "Node.js version compatible with package.json engines.",
      "npm available.",
      "Git available.",
      "Repo access / GitHub credentials configured.",
      "Playwright browser dependencies available for later setup-only install.",
      "No paid proxy, CAPTCHA service, or stealth plugin installed for this workflow.",
      "No Booking/Jalan login cookies or OTA account sessions used."
    ],
    prohibited_inputs: ["paid proxy keys", "CAPTCHA bypass keys", "stealth plugins", "Booking/Jalan login cookies", "PMS/Beds24/AirHost upload credentials"]
  };
}

export function buildRepositoryAcquisitionPlan(): PlanSection {
  return {
    title: "Repository acquisition",
    commands: ["git clone <repo-url>", "cd zao-market-intelligence", "git status --short"],
    notes: [
      "Use main or a protected stable branch for runner operation.",
      "Use a feature branch for runner/bootstrap script changes.",
      "Manual review is required before merge.",
      "If .data/history is committed later, verify .data/history/zao_signals_*.csv exists after clone.",
      "If history is transferred as an archive, unpack only canonical history shards into .data/history and verify row count."
    ]
  };
}

export function buildDependencyInstallationPlan(): PlanSection {
  return {
    title: "Dependency installation",
    commands: ["npm install", "npm run typecheck", "npm run test", "npm run check:no-paid-sources", "npx playwright install"],
    notes: [
      "Playwright install is setup-only and must not launch live collectors during bootstrap.",
      "Do not run live Booking, Jalan, Rakuten, or Google collection commands during bootstrap validation.",
      "If Playwright install fails, stop and do not run collectors."
    ]
  };
}

export function buildEnvironmentSetupPlan(envExamplePresent: boolean): PlanSection {
  return {
    title: "Environment and secrets setup",
    commands: envExamplePresent ? ["cp .env.example .env", "$EDITOR .env"] : ["# create .env manually from future documented template"],
    notes: [
      ".env must be created manually on the always-on Mac and must never be committed.",
      ".env.example should document expected non-secret configuration.",
      "No PMS/Beds24/AirHost upload credentials are needed for collector-only bootstrap.",
      "No paid proxy keys, CAPTCHA keys, Booking/Jalan cookies, login credentials, or stealth configuration should be present."
    ]
  };
}

export function buildCanonicalHistoryVerificationPlan(): CanonicalHistoryVerificationPlan {
  return {
    expected_history_rows: 210,
    expected_source_counts: { booking: 46, jalan: 38, rakuten: 126 },
    expected_schema_version: "zao_local_history_v1",
    required_checks: [
      ".data/history exists.",
      "Expected .data/history/zao_signals_*.csv shard files exist.",
      "Total row count equals 210.",
      "Source counts equal Booking=46, Jalan=38, Rakuten=126.",
      "duplicate row_id count equals 0.",
      "Every row has schema_version=zao_local_history_v1."
    ],
    fail_closed_if: ["history row count mismatch", "source count mismatch", "duplicate row_id detected", "schema_version invalid", "required shard files missing"]
  };
}

export function buildDbRegenerationPlan(): DbRegenerationPlan {
  return {
    recommended_future_sequence: ["npm run dry-run:history-to-db-sync", "HISTORY_TO_DB_SYNC=1 npm run real-run:history-to-db-sync", "npm run db:verify"],
    prerequisites: [
      "Canonical history verification passes first.",
      "Fresh dry-run artifact maps 210 rows with zero conflicts.",
      "real-run script artifact pointer and APPROVED_MAPPED_ROW_COUNT match the fresh 210-row dry-run, unless a generic bootstrap sync command exists."
    ],
    fail_closed_if: ["dry-run conflicts exist", "mapped row count is not 210", "DB row count after sync is not 210", "collector baseline changes unexpectedly"],
    safer_future_command: "AUTO-RUNNER03X should create a dedicated bootstrap DB regeneration command with no stale artifact pointer edits."
  };
}

export function buildAiContextRegenerationPlan(): AiContextRegenerationPlan {
  return {
    recommended_future_sequence: [
      "npm run build:ai-context-packs",
      "npm run query:ai-task -- --task bootstrap",
      "npm run query:ai-task -- --task data_quality",
      "npm run query:ai-task -- --task pricing_support --start 2026-06-01 --end 2026-12-31"
    ],
    expected_result: "AI context rebuilds to a 210-row basis; basis_caution is acceptable.",
    fail_closed_if: ["AI context row count is not 210", "query smoke fails", "caveats/guardrails are missing"]
  };
}

export function buildLocalDirectoryLayout(): LocalDirectoryLayout {
  return {
    preferred_external_layout: ["~/zao-market-intelligence/repo/", "~/zao-market-intelligence/logs/", "~/zao-market-intelligence/backups/", "~/zao-market-intelligence/artifacts/", "~/zao-market-intelligence/run-state/"],
    repo_internal_layout: [".data/history/", ".data/reports/", ".data/debug/", ".data/ai-context/", ".data/run-state/", ".logs/"],
    recommendation: "Keep canonical history in repo .data/history; keep large debug/screenshots rotated or archived outside Git."
  };
}

export function buildLoggingBackupPolicy(): LoggingBackupPolicy {
  return {
    logs: ["Timestamp every bootstrap/runner invocation.", "Store logs under local logs/ or .logs/ with retention limits.", "Never log secrets."],
    backups: ["Back up touched history shards before any future real append.", "Keep .data/history/.backup machine-local and out of Git.", "Retain rollback metadata with each write phase."],
    artifact_retention: ["Commit canonical history only if approved.", "Regenerate DB and AI context.", "Archive large debug/screenshots separately with rotation."]
  };
}

export function buildFailureHandlingPlan(): FailureHandlingPlan {
  return {
    fail_closed_rules: [
      "If history row count mismatch: stop.",
      "If duplicate row_id: stop.",
      "If schema invalid: stop.",
      "If DB dry-run conflicts: stop.",
      "If DB sync count mismatch: stop.",
      "If AI context row count mismatch: stop.",
      "If no-paid guard fails: stop.",
      "If tests fail: stop.",
      "If Playwright install fails: do not run collectors."
    ]
  };
}

export function buildFutureBootstrapScriptOutline(): FutureBootstrapScriptOutline {
  return {
    proposed_file: "scripts/bootstrapAlwaysOnMac.sh",
    executable_in_this_phase: false,
    shell_outline: [
      "set -euo pipefail",
      "check cwd is repo root",
      "check node/npm/git versions",
      "npm install",
      "npm run typecheck",
      "npm run test",
      "npm run check:no-paid-sources",
      "verify .data/history row count and schema",
      "npm run dry-run:history-to-db-sync",
      "run gated DB sync only with explicit env flag and fresh 210-row dry-run",
      "npm run build:ai-context-packs",
      "run read-only query smoke checks",
      "print final summary and next manual steps"
    ]
  };
}

export function buildRisks(current: CurrentStateSummary): string[] {
  const risks = [
    "Always-on Mac hardware/network/sleep configuration cannot be verified from this machine.",
    ".data/history transfer policy still requires approval because .gitignore blanket-ignores .data/.",
    "Current DB real-run sync path may require stale artifact pointer/count-pin handling before first bootstrap sync.",
    "Large debug/screenshots need archive/rotation policy before always-on operation."
  ];
  if (current.uncommitted_entries > 0) risks.push("Current working tree has uncommitted entries and needs manual review before cloning a stable runner branch.");
  return risks;
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    git_add_commit_push: false,
    git_remote_changes: false,
    github_actions_file_creation: false,
    launchd_file_creation: false,
    cron_file_creation: false,
    live_booking_collection: false,
    live_jalan_collection: false,
    playwright_browser_launch: false,
    external_fetch: false,
    history_modification: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    started_auto_runner03x: false
  };
}

export function decideAutoRunnerBootstrapProposal(input: { autoRunner01xPresent: boolean; current: CurrentStateSummary }): AutoRunnerBootstrapDecision {
  if (!input.autoRunner01xPresent || input.current.history_rows === 0) return "auto_runner_bootstrap_proposal_not_ready";
  if (input.current.current_blockers.length > 0) return "auto_runner_bootstrap_proposal_basis_caution";
  return "auto_runner_bootstrap_proposal_ready";
}

export function renderBootstrapCsv(input: {
  preconditions: BootstrapPreconditions;
  failureHandling: FailureHandlingPlan;
  risks: string[];
}): string {
  const rows = [
    ...input.preconditions.checklist.map((item) => ({ section: "precondition", item })),
    ...input.failureHandling.fail_closed_rules.map((item) => ({ section: "failure_handling", item })),
    ...input.risks.map((item) => ({ section: "risk", item }))
  ];
  return ["section,item", ...rows.map((row) => `${csvCell(row.section)},${csvCell(row.item)}`)].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerBootstrapDecision;
  sourceArtifactPath: string;
  current: CurrentStateSummary;
  preconditions: BootstrapPreconditions;
  repository: PlanSection;
  dependencies: PlanSection;
  environment: PlanSection;
  history: CanonicalHistoryVerificationPlan;
  db: DbRegenerationPlan;
  ai: AiContextRegenerationPlan;
  layout: LocalDirectoryLayout;
  logging: LoggingBackupPolicy;
  failure: FailureHandlingPlan;
  outline: FutureBootstrapScriptOutline;
  risks: string[];
  safety: SafetyConfirmation;
}): string {
  return `# Always-On Mac Bootstrap Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

AUTO-RUNNER02X proposes a fail-closed bootstrap flow for a fresh always-on Mac. It keeps .data/history CSV shards canonical, regenerates SQLite and AI context, and does not install schedules or run live collectors in this phase.

## 2. Source AUTO-RUNNER01X Result

- Artifact: ${input.sourceArtifactPath}
- Decision: ${input.current.auto_runner01x_decision}
- Current state: ${JSON.stringify(input.current)}

## 3. Preconditions

${input.preconditions.checklist.map((item) => `- ${item}`).join("\n")}

## 4. Repository Acquisition

Commands proposed for future use only:
${input.repository.commands.map((cmd) => `- \`${cmd}\``).join("\n")}

## 5. Dependency Installation

Commands proposed for future use only:
${input.dependencies.commands.map((cmd) => `- \`${cmd}\``).join("\n")}

## 6. Environment / Secrets Setup

${input.environment.notes.map((item) => `- ${item}`).join("\n")}

## 7. Canonical History Verification

${input.history.required_checks.map((item) => `- ${item}`).join("\n")}

## 8. DB Regeneration Plan

${input.db.recommended_future_sequence.map((cmd) => `- \`${cmd}\``).join("\n")}

## 9. AI Context Regeneration Plan

${input.ai.recommended_future_sequence.map((cmd) => `- \`${cmd}\``).join("\n")}

## 10. Local Directory Layout

${input.layout.preferred_external_layout.map((item) => `- ${item}`).join("\n")}

## 11. Logging / Backup Policy

${[...input.logging.logs, ...input.logging.backups, ...input.logging.artifact_retention].map((item) => `- ${item}`).join("\n")}

## 12. Failure Handling

${input.failure.fail_closed_rules.map((item) => `- ${item}`).join("\n")}

## 13. Future Bootstrap Script Outline

- Proposed file: ${input.outline.proposed_file}
${input.outline.shell_outline.map((item) => `- ${item}`).join("\n")}

## 14. Risks

${input.risks.map((item) => `- ${item}`).join("\n")}

## 15. Safety Confirmation

${JSON.stringify(input.safety, null, 2)}

## 16. Decision

${input.decision}

## 17. Next Phase

AUTO-RUNNER03X — Manual end-to-end runner script proposal, disabled collectors by default. Do not start without explicit instruction.
`;
}

function csvCell(value: string): string {
  if (!/[",\n]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

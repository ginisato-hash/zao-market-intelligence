// Phase AUTO-RUNNER00X — Always-on Mac / GitHub artifact transfer / scheduled
// execution architecture PROPOSAL (engine).
//
// PROPOSAL / DESIGN ONLY. This module assembles a static automation-architecture
// design from the verified current system state. It enables NO automation: it
// writes NO history, NO DB rows, runs NO live request / browser automation /
// collector, registers NO cron or launchd job, creates NO GitHub Actions
// workflow, emits NO property-management or channel-manager output, and performs
// NO price update. It only reads current state (supplied by the caller) and
// returns design documents to be rendered into a report.

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type AutoRunnerDecision =
  | "auto_runner_architecture_proposal_ready"
  | "auto_runner_architecture_proposal_basis_caution"
  | "auto_runner_architecture_proposal_not_ready";

// Expected canonical state at the time of this proposal.
export const EXPECTED_HISTORY_ROWS = 210;
export const EXPECTED_DB_ROWS = 210;
export const EXPECTED_BOOKING_ROWS = 46;
export const EXPECTED_JALAN_ROWS = 38;
export const EXPECTED_RAKUTEN_ROWS = 126;

// ---------------------------------------------------------------------------
// Source state
// ---------------------------------------------------------------------------

export type SourceRole = "primary_directional" | "supplementary_directional" | "frozen_caution" | "not_adopted";

export interface SourceRoleEntry {
  source: string;
  role: SourceRole;
  note: string;
}

export interface SourceStateSummary {
  historyRows: number;
  dbRows: number;
  bookingRows: number;
  jalanRows: number;
  rakutenRows: number;
  aiContextRows: number;
  inputArtifactsPresent: boolean;
  roles: SourceRoleEntry[];
}

export function buildSourceRoles(): SourceRoleEntry[] {
  return [
    {
      source: "booking",
      role: "primary_directional",
      note: "Primary directional market price-pressure backbone; directional only, never direct automatic-pricing input, no synthetic markup multiplier, official visible adder policy."
    },
    {
      source: "jalan",
      role: "supplementary_directional",
      note: "Supplementary domestic OTA / same-property trend signal; directional rows are supplemental price-pressure, excluded rows audit-only, direct rows are legacy A-confidence only."
    },
    { source: "rakuten", role: "frozen_caution", note: "Frozen / caution; not a collection target in this architecture." },
    { source: "google_hotels", role: "not_adopted", note: "Not adopted." }
  ];
}

// ---------------------------------------------------------------------------
// Architecture principles
// ---------------------------------------------------------------------------

export interface ArchitecturePrinciple {
  id: string;
  title: string;
  detail: string;
}

export function buildArchitecturePrinciples(): ArchitecturePrinciple[] {
  return [
    {
      id: "live_collection_on_local_mac",
      title: "Live OTA collection runs on the always-on Mac",
      detail:
        "Booking and Jalan live page rendering run on a residential/local always-on Mac, never from cloud IPs, to avoid bot-protection / WAF / 403 / silent degraded-page risk."
    },
    {
      id: "github_for_code_and_artifact_transfer",
      title: "GitHub is used for code and reviewed artifact transfer only",
      detail:
        "GitHub moves source code and reviewed artifacts between the implementation Mac and the always-on Mac. Pull-only deployment and manual PR review; no unguarded auto-push of data."
    },
    {
      id: "no_live_browsers_in_cloud_actions",
      title: "GitHub Actions never runs live OTA browsers",
      detail:
        "Cloud Actions are limited to safe static tasks (typecheck, tests, schema/report/artifact validation, no-paid-sources guard). No Playwright collection in cloud."
    },
    {
      id: "separate_collection_from_pricing",
      title: "Data collection and price decision stay separated",
      detail:
        "The runner may collect/append/sync/refresh signals, but must not auto-generate or auto-upload price-change CSVs. Pricing stays behind explicit later-phase approval gates."
    },
    {
      id: "fail_closed_everywhere",
      title: "Every automated step is fail-closed",
      detail:
        "Blocked / CAPTCHA / degraded pages are recorded as failed rows, never inferred. Append/sync/pricing require explicit env-flag gates that default off."
    }
  ];
}

// ---------------------------------------------------------------------------
// Manual-to-automated workflow (stages 0-10)
// ---------------------------------------------------------------------------

export type RunnerKind = "manual" | "manual_then_automatable" | "automatic_after_approval";

export interface WorkflowStage {
  stage: number;
  name: string;
  trigger: string;
  inputs: string;
  outputs: string;
  successCriteria: string;
  failureBehavior: string;
  runner: RunnerKind;
  gate: string;
}

export function buildManualWorkflowDesign(): WorkflowStage[] {
  return [
    {
      stage: 0,
      name: "Code/artifact transfer to always-on Mac",
      trigger: "New reviewed commit / release tag on GitHub",
      inputs: "Source code, tests, package config, optionally .data/history shards",
      outputs: "Synced repo on always-on Mac",
      successCriteria: "git pull clean, npm install ok, typecheck+test green",
      failureBehavior: "Stop; do not run later stages until repo is healthy",
      runner: "manual",
      gate: "none (pull-only, manual review)"
    },
    {
      stage: 1,
      name: "Local environment health check",
      trigger: "Before any collection run",
      inputs: "Node version, Playwright browsers, .env, data dir permissions",
      outputs: "Health report",
      successCriteria: "typecheck/test/db:verify pass; baseline unchanged",
      failureBehavior: "Abort run",
      runner: "manual_then_automatable",
      gate: "none"
    },
    {
      stage: 2,
      name: "Bounded live collection",
      trigger: "Scheduled small batch (later launchd)",
      inputs: "Fixed verified URLs, small date batch",
      outputs: "Raw collection artifacts + screenshots",
      successCriteria: "Pages rendered fully; no 403/CAPTCHA/degraded",
      failureBehavior: "Mark failed rows; no aggressive retry; no append",
      runner: "automatic_after_approval",
      gate: "COLLECT_BOOKING=1 / COLLECT_JALAN=1"
    },
    {
      stage: 3,
      name: "Preview row artifact generation",
      trigger: "After successful collection",
      inputs: "Raw collection artifacts",
      outputs: "Normalized preview rows (no history write)",
      successCriteria: "Rows normalized with basis/dp_usage classification",
      failureBehavior: "Stop; manual inspection",
      runner: "manual_then_automatable",
      gate: "none"
    },
    {
      stage: 4,
      name: "Append proposal generation",
      trigger: "After preview rows exist",
      inputs: "Preview rows + existing history",
      outputs: "Bounded append proposal artifact",
      successCriteria: "Conflicts=0, deltas explained",
      failureBehavior: "Stop; manual review",
      runner: "manual_then_automatable",
      gate: "none"
    },
    {
      stage: 5,
      name: "Approved append gate",
      trigger: "Human approval sentence + env flag",
      inputs: "Approved proposal",
      outputs: "Appended .data/history rows",
      successCriteria: "Two-gate satisfied; rollback=false",
      failureBehavior: "Block append; no write",
      runner: "automatic_after_approval",
      gate: "BOOKING_HISTORY_APPEND=1 / JALAN_HISTORY_APPEND=1"
    },
    {
      stage: 6,
      name: "DB mirror sync",
      trigger: "After approved append",
      inputs: ".data/history",
      outputs: "Updated SQLite market_signal_history",
      successCriteria: "Inserted/skipped counts match; 0 dups",
      failureBehavior: "Abort; DB untouched",
      runner: "automatic_after_approval",
      gate: "HISTORY_TO_DB_SYNC=1"
    },
    {
      stage: 7,
      name: "AI context refresh",
      trigger: "After successful DB sync",
      inputs: "DB mirror",
      outputs: "Rebuilt AI context packs",
      successCriteria: "Row basis matches DB; caveats present",
      failureBehavior: "Abort; keep prior context",
      runner: "automatic_after_approval",
      gate: "BUILD_AI_CONTEXT=1"
    },
    {
      stage: 8,
      name: "Price-pressure usability / report verification",
      trigger: "After context refresh",
      inputs: "DB mirror (read-only)",
      outputs: "Usability + verification reports",
      successCriteria: "Invariants hold; Booking primary; no leakage",
      failureBehavior: "Flag not_ready; halt automation",
      runner: "manual_then_automatable",
      gate: "none (read-only)"
    },
    {
      stage: 9,
      name: "Human review",
      trigger: "After verification reports",
      inputs: "All reports",
      outputs: "Go/no-go decision",
      successCriteria: "Reviewer approves",
      failureBehavior: "Stop pipeline",
      runner: "manual",
      gate: "none"
    },
    {
      stage: 10,
      name: "Optional Miuraya pricing CSV generation (separate approved phase)",
      trigger: "Explicit separate gated phase only",
      inputs: "Approved signals",
      outputs: "Pricing review CSV (no PMS upload)",
      successCriteria: "CSV produced for manual review only",
      failureBehavior: "No CSV; no upload",
      runner: "automatic_after_approval",
      gate: "GENERATE_PRICE_CSV=1 (off by default; no PMS/Beds24/AirHost upload)"
    }
  ];
}

// ---------------------------------------------------------------------------
// Scheduling strategy
// ---------------------------------------------------------------------------

export interface ScheduleBatch {
  name: string;
  scope: string;
  cadence: string;
  perRunCap: string;
}

export interface ScheduleDesign {
  nearTermCoverage: ScheduleBatch;
  majorDateCoverage: ScheduleBatch[];
  bookingCadence: ScheduleBatch;
  jalanCadence: ScheduleBatch;
  syncCadence: string;
  principles: string[];
}

export function buildScheduleDesign(): ScheduleDesign {
  return {
    nearTermCoverage: {
      name: "near_term_60_day",
      scope: "Next 60 days, dense date windows for verified properties",
      cadence: "1-2 small batches per day, dates rotated slowly",
      perRunCap: "Small bounded batch per run; no huge single run"
    },
    majorDateCoverage: [
      {
        name: "major_date_batch_a",
        scope: "Saturdays + long weekends up to 1 year ahead",
        cadence: "Rotating, a few dates per run",
        perRunCap: "Small bounded batch"
      },
      {
        name: "major_date_batch_b",
        scope: "Obon + autumn foliage peak up to 1 year ahead",
        cadence: "Rotating, a few dates per run",
        perRunCap: "Small bounded batch"
      },
      {
        name: "major_date_batch_c",
        scope: "Early ski-start + New Year / peak winter up to 1 year ahead",
        cadence: "Rotating, a few dates per run",
        perRunCap: "Small bounded batch"
      }
    ],
    bookingCadence: {
      name: "booking_primary",
      scope: "3 verified properties x 5-10 dates, fixed slug direct pages + rotating major-date batches",
      cadence: "Daily small bounded batch",
      perRunCap: "Bounded; no search pagination"
    },
    jalanCadence: {
      name: "jalan_supplementary",
      scope: "5 verified properties x 5 dates (or smaller if risk appears)",
      cadence: "2-3 times per week",
      perRunCap: "Bounded; smaller than Booking"
    },
    syncCadence:
      "DB sync + AI context refresh only after a successful approved append, or daily if new history rows were appended.",
    principles: [
      "split_into_small_bounded_batches",
      "rotate_dates_slowly",
      "no_massive_single_run",
      "booking_more_frequent_than_jalan",
      "near_term_60_day_dense_then_major_dates_to_1_year"
    ]
  };
}

// ---------------------------------------------------------------------------
// Bot-risk assessment
// ---------------------------------------------------------------------------

export interface BotRiskAssessment {
  risks: string[];
  controls: string[];
  failureBehavior: string;
}

export function buildBotRiskAssessment(): BotRiskAssessment {
  return {
    risks: [
      "cloud_ip_bot_protection",
      "booking_403_or_degraded_page",
      "jalan_page_chrome_or_coupon_evidence_drift",
      "silent_data_poisoning_from_incomplete_pages"
    ],
    controls: [
      "run_live_collection_only_from_local_mac",
      "fixed_urls_only_no_search_pagination",
      "small_bounded_batches",
      "screenshot_every_collection",
      "retry_limits",
      "no_stealth_plugin",
      "no_captcha_bypass",
      "no_paid_proxies",
      "no_login_or_cookies",
      "failure_rows_instead_of_inferred_prices"
    ],
    failureBehavior:
      "If blocked / CAPTCHA / degraded page: mark failed, do not retry aggressively, do not append automatically, require manual review."
  };
}

// ---------------------------------------------------------------------------
// GitHub / machine transfer plan
// ---------------------------------------------------------------------------

export interface GithubTransferPlan {
  flow: string;
  commit: string[];
  doNotCommit: string[];
  regenerateOnTarget: string[];
  bootstrapSequence: string[];
  saferLaterApproaches: string[];
}

export function buildGithubTransferPlan(): GithubTransferPlan {
  return {
    flow: "current_implementation_mac -> github -> always_on_mac (pull-only, manual review)",
    commit: [
      "source code (src/)",
      "tests (tests/)",
      "package config (package.json, tsconfig, vitest config)",
      ".data/history CSV shards (if repository policy allows)"
    ],
    doNotCommit: [
      "large debug screenshots by default",
      "bulky .data/debug artifacts",
      "secrets / .env",
      "SQLite DB binary (prefer regeneration)"
    ],
    regenerateOnTarget: [
      "SQLite DB regenerated from .data/history via dry-run + gated real-run sync",
      "AI context packs rebuilt from DB"
    ],
    bootstrapSequence: [
      "git clone <repo>",
      "cd zao-market-intelligence",
      "npm install",
      "npm run typecheck",
      "npm run test",
      "npm run db:verify",
      "npm run dry-run:history-to-db-sync",
      "HISTORY_TO_DB_SYNC=1 npm run real-run:history-to-db-sync",
      "npm run build:ai-context-packs"
    ],
    saferLaterApproaches: [
      "git LFS or release-artifact archives for large reports/debug",
      "reviewed PR before any data commit",
      "release tags for reproducible handoff"
    ]
  };
}

// ---------------------------------------------------------------------------
// Local always-on Mac setup checklist
// ---------------------------------------------------------------------------

export function buildLocalMacSetupChecklist(): string[] {
  return [
    "dedicated macOS user account",
    "keep-awake / no-sleep settings (Energy Saver)",
    "connected to power adapter",
    "stable residential network",
    "Node >= 22 installed",
    "npm install completed",
    "Playwright browsers installed",
    "repo cloned",
    ".env configured if needed",
    "local data directory permissions verified",
    "backup directory created",
    "log directory created",
    "manual run smoke test passed",
    "no sleep / launchd scheduling deferred to a later phase"
  ];
}

// ---------------------------------------------------------------------------
// Data retention / artifact policy
// ---------------------------------------------------------------------------

export interface DataRetentionPolicy {
  versioned: string[];
  backedUp: string[];
  regenerable: string[];
  ephemeral: string[];
}

export function buildDataRetentionPolicy(): DataRetentionPolicy {
  return {
    versioned: [".data/history CSV shards (canonical source of truth)"],
    backedUp: [".data/history backups before each append", ".data/reports/automation key reports"],
    regenerable: ["SQLite market_signal_history (from history)", ".data/ai-context packs (from DB)"],
    ephemeral: [".data/debug screenshots and intermediate artifacts (archive or prune)"]
  };
}

// ---------------------------------------------------------------------------
// Fail-closed gates
// ---------------------------------------------------------------------------

export interface FailClosedGate {
  flag: string;
  controls: string;
  defaultOff: boolean;
}

export function buildFailClosedGates(): FailClosedGate[] {
  return [
    { flag: "COLLECT_BOOKING=1", controls: "Booking bounded live collection", defaultOff: true },
    { flag: "COLLECT_JALAN=1", controls: "Jalan bounded live collection", defaultOff: true },
    { flag: "BOOKING_HISTORY_APPEND=1", controls: "Approved Booking history append", defaultOff: true },
    { flag: "JALAN_HISTORY_APPEND=1", controls: "Approved Jalan history append", defaultOff: true },
    { flag: "HISTORY_TO_DB_SYNC=1", controls: "History -> DB mirror sync", defaultOff: true },
    { flag: "BUILD_AI_CONTEXT=1", controls: "AI context refresh", defaultOff: true },
    {
      flag: "GENERATE_PRICE_CSV=1",
      controls: "Pricing review CSV generation (NO PMS/Beds24/AirHost upload; off by default)",
      defaultOff: true
    }
  ];
}

// ---------------------------------------------------------------------------
// Future phase plan
// ---------------------------------------------------------------------------

export interface FuturePhase {
  id: string;
  objective: string;
  allowed: string;
  forbidden: string;
  gates: string;
  successCriteria: string;
}

export function buildFuturePhasePlan(): FuturePhase[] {
  return [
    {
      id: "AUTO-RUNNER01X",
      objective: "Repository / artifact migration plan implementation proposal",
      allowed: "Design migration steps; inventory committable vs regenerable files",
      forbidden: "No commit/push; no data mutation",
      gates: "none (proposal)",
      successCriteria: "Concrete migration plan + file inventory"
    },
    {
      id: "AUTO-RUNNER02X",
      objective: "Local Mac bootstrap script proposal",
      allowed: "Design bootstrap script content",
      forbidden: "No install; no execution",
      gates: "none (proposal)",
      successCriteria: "Bootstrap script draft + checklist"
    },
    {
      id: "AUTO-RUNNER03X",
      objective: "Manual end-to-end runner script, no schedule",
      allowed: "Design a manual orchestrator invoking existing gated steps",
      forbidden: "No schedule; no auto collection",
      gates: "existing per-step gates",
      successCriteria: "Manual runner runs stages on demand"
    },
    {
      id: "AUTO-RUNNER04X",
      objective: "launchd schedule proposal",
      allowed: "Design launchd plist content + cadence",
      forbidden: "No plist installation; no activation",
      gates: "none (proposal)",
      successCriteria: "Schedule design + plist draft"
    },
    {
      id: "AUTO-RUNNER05X",
      objective: "Bounded collector schedule implementation, disabled by default",
      allowed: "Implement scheduling wiring disabled by default",
      forbidden: "No enablement; no live run",
      gates: "COLLECT_* off by default",
      successCriteria: "Wiring present but inert"
    },
    {
      id: "AUTO-RUNNER06X",
      objective: "GitHub artifact sync proposal",
      allowed: "Design reviewed artifact sync flow",
      forbidden: "No auto-push of data",
      gates: "manual review gate",
      successCriteria: "Artifact sync plan"
    },
    {
      id: "AUTO-RUNNER07X",
      objective: "Price decision report runner, no CSV",
      allowed: "Design read-only price decision reporting",
      forbidden: "No CSV; no PMS output",
      gates: "none (read-only)",
      successCriteria: "Decision report design"
    },
    {
      id: "AUTO-RUNNER08X",
      objective: "Miuraya pricing CSV proposal, gated",
      allowed: "Design gated CSV generation for manual review",
      forbidden: "No PMS/Beds24/AirHost upload; no auto price update",
      gates: "GENERATE_PRICE_CSV=1 (off by default)",
      successCriteria: "Gated CSV proposal"
    }
  ];
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface DecisionInput {
  state: SourceStateSummary;
}

export function stateMatchesExpected(state: SourceStateSummary): boolean {
  return (
    state.historyRows === EXPECTED_HISTORY_ROWS &&
    state.dbRows === EXPECTED_DB_ROWS &&
    state.bookingRows === EXPECTED_BOOKING_ROWS &&
    state.jalanRows === EXPECTED_JALAN_ROWS &&
    state.rakutenRows === EXPECTED_RAKUTEN_ROWS &&
    state.aiContextRows === EXPECTED_DB_ROWS
  );
}

export function decideProposal(state: SourceStateSummary): AutoRunnerDecision {
  // not_ready: current state cannot be verified or essential artifacts missing.
  if (state.historyRows <= 0 || state.dbRows <= 0 || !state.inputArtifactsPresent) {
    return "auto_runner_architecture_proposal_not_ready";
  }
  // ready: state exactly matches the verified canonical baseline.
  if (stateMatchesExpected(state)) return "auto_runner_architecture_proposal_ready";
  // basis_caution: design is workable but state drifted from the expected baseline.
  return "auto_runner_architecture_proposal_basis_caution";
}

// ---------------------------------------------------------------------------
// Full proposal assembly
// ---------------------------------------------------------------------------

export interface AutoRunnerProposal {
  sourceState: SourceStateSummary;
  architecturePrinciples: ArchitecturePrinciple[];
  manualWorkflowDesign: WorkflowStage[];
  scheduleDesign: ScheduleDesign;
  botRiskAssessment: BotRiskAssessment;
  githubTransferPlan: GithubTransferPlan;
  localMacSetupChecklist: string[];
  dataRetentionPolicy: DataRetentionPolicy;
  failClosedGates: FailClosedGate[];
  futurePhasePlan: FuturePhase[];
  risks: string[];
}

export function buildProposal(state: SourceStateSummary): AutoRunnerProposal {
  const risks: string[] = [
    "always_on_mac_is_a_different_machine_requiring_careful_migration",
    "live_ota_collection_must_stay_off_cloud_ip_to_avoid_bot_protection",
    "auto_push_of_data_and_pricing_csv_must_remain_gated_and_manual",
    "screenshots_and_debug_artifacts_can_bloat_the_repo_if_committed"
  ];
  if (!stateMatchesExpected(state)) {
    risks.push("current_state_differs_from_expected_210_baseline_review_before_migration");
  }
  return {
    sourceState: state,
    architecturePrinciples: buildArchitecturePrinciples(),
    manualWorkflowDesign: buildManualWorkflowDesign(),
    scheduleDesign: buildScheduleDesign(),
    botRiskAssessment: buildBotRiskAssessment(),
    githubTransferPlan: buildGithubTransferPlan(),
    localMacSetupChecklist: buildLocalMacSetupChecklist(),
    dataRetentionPolicy: buildDataRetentionPolicy(),
    failClosedGates: buildFailClosedGates(),
    futurePhasePlan: buildFuturePhasePlan(),
    risks
  };
}

// ---------------------------------------------------------------------------
// CSV rendering (one row per workflow stage)
// ---------------------------------------------------------------------------

export const PROPOSAL_CSV_HEADERS = [
  "stage",
  "name",
  "trigger",
  "runner",
  "gate",
  "success_criteria",
  "failure_behavior"
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

export function renderProposalCsv(stages: readonly WorkflowStage[]): string {
  const body = stages.map((s) =>
    [s.stage.toString(), s.name, s.trigger, s.runner, s.gate, s.successCriteria, s.failureBehavior]
      .map(csvEscape)
      .join(",")
  );
  return [PROPOSAL_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export interface ProposalReportInput {
  generatedAtJst: string;
  runId: string;
  decision: AutoRunnerDecision;
  proposal: AutoRunnerProposal;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugRootPath: string;
}

export function renderProposalReport(input: ProposalReportInput): string {
  const p = input.proposal;
  const s = p.sourceState;
  const sched = p.scheduleDesign;
  return [
    "# Auto Runner Architecture Proposal",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Executive Summary",
    "",
    "- PROPOSAL / DESIGN ONLY. No automation is enabled by this phase.",
    "- Designs how the working Booking + Jalan DB workflow can run on an always-on Mac, with GitHub-based artifact transfer and fail-closed scheduling.",
    "- Live OTA collection runs on the always-on Mac; GitHub Actions never runs live browsers; data collection stays separated from price decisions.",
    `- decision=${input.decision}`,
    "",
    "## 2. Current System State",
    "",
    `- history_rows=${s.historyRows}`,
    `- db_rows=${s.dbRows}`,
    `- ai_context_rows=${s.aiContextRows}`,
    `- booking_rows=${s.bookingRows} (primary directional)`,
    `- jalan_rows=${s.jalanRows} (supplementary directional)`,
    `- rakuten_rows=${s.rakutenRows} (frozen / caution)`,
    `- input_artifacts_present=${s.inputArtifactsPresent}`,
    "",
    "Source roles:",
    "",
    "| source | role | note |",
    "|---|---|---|",
    ...s.roles.map((r) => `| ${r.source} | ${r.role} | ${r.note} |`),
    "",
    "## 3. Architecture Principles",
    "",
    ...p.architecturePrinciples.map((a) => `- **${a.title}** (${a.id}): ${a.detail}`),
    "",
    "## 4. Manual-to-Automated Workflow",
    "",
    "| stage | name | trigger | runner | gate |",
    "|---|---|---|---|---|",
    ...p.manualWorkflowDesign.map((w) => `| ${w.stage} | ${w.name} | ${w.trigger} | ${w.runner} | ${w.gate} |`),
    "",
    "## 5. Scheduling Strategy",
    "",
    `- near_term: ${sched.nearTermCoverage.scope} — ${sched.nearTermCoverage.cadence} (${sched.nearTermCoverage.perRunCap})`,
    ...sched.majorDateCoverage.map((b) => `- ${b.name}: ${b.scope} — ${b.cadence}`),
    `- booking: ${sched.bookingCadence.scope} — ${sched.bookingCadence.cadence}`,
    `- jalan: ${sched.jalanCadence.scope} — ${sched.jalanCadence.cadence}`,
    `- sync: ${sched.syncCadence}`,
    "",
    "Scheduling principles:",
    "",
    ...sched.principles.map((x) => `- ${x}`),
    "",
    "## 6. Bot-Risk Assessment",
    "",
    "Risks:",
    "",
    ...p.botRiskAssessment.risks.map((x) => `- ${x}`),
    "",
    "Controls:",
    "",
    ...p.botRiskAssessment.controls.map((x) => `- ${x}`),
    "",
    `Failure behavior: ${p.botRiskAssessment.failureBehavior}`,
    "",
    "## 7. GitHub / Machine Transfer Plan",
    "",
    `- flow: ${p.githubTransferPlan.flow}`,
    "- commit:",
    ...p.githubTransferPlan.commit.map((x) => `  - ${x}`),
    "- do NOT commit:",
    ...p.githubTransferPlan.doNotCommit.map((x) => `  - ${x}`),
    "- regenerate on target Mac:",
    ...p.githubTransferPlan.regenerateOnTarget.map((x) => `  - ${x}`),
    "- bootstrap sequence (run later on the always-on Mac, NOT in this phase):",
    ...p.githubTransferPlan.bootstrapSequence.map((x) => `  - \`${x}\``),
    "",
    "## 8. Local Always-On Mac Setup Checklist",
    "",
    ...p.localMacSetupChecklist.map((x) => `- [ ] ${x}`),
    "",
    "## 9. Data Retention / Artifact Policy",
    "",
    `- versioned: ${p.dataRetentionPolicy.versioned.join("; ")}`,
    `- backed_up: ${p.dataRetentionPolicy.backedUp.join("; ")}`,
    `- regenerable: ${p.dataRetentionPolicy.regenerable.join("; ")}`,
    `- ephemeral: ${p.dataRetentionPolicy.ephemeral.join("; ")}`,
    "",
    "## 10. Fail-Closed Gates",
    "",
    "| flag | controls | default_off |",
    "|---|---|---|",
    ...p.failClosedGates.map((g) => `| ${g.flag} | ${g.controls} | ${g.defaultOff} |`),
    "",
    "## 11. Future Phase Plan",
    "",
    "| phase | objective | gates | success |",
    "|---|---|---|---|",
    ...p.futurePhasePlan.map((f) => `| ${f.id} | ${f.objective} | ${f.gates} | ${f.successCriteria} |`),
    "",
    "## 12. Risks",
    "",
    ...p.risks.map((r) => `- ${r}`),
    "",
    "## 13. Safety Confirmation",
    "",
    "- No live collection, no Playwright, no external fetch, no history/DB/context mutation, no cron/launchd, no GitHub Actions activation, no commit/push, no pricing CSV, no PMS/Beds24/AirHost output, no paid sources.",
    "",
    "## 14. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 15. Next Phase",
    "",
    "- AUTO-RUNNER01X — Repository / artifact migration plan implementation proposal (do not start without explicit instruction).",
    "",
    "## Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    ""
  ].join("\n");
}

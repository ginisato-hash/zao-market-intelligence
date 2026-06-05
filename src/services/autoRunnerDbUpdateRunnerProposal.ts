// Phase AUTO-RUNNER07X - automated market signal DB update runner proposal.
//
// Pure design/report helpers only. This module does not run collectors,
// append history, sync DB, refresh AI context, run query smoke, or generate
// price report / CSV / PMS output.

export type AutoRunnerDbUpdateRunnerDecision =
  | "auto_runner_db_update_runner_proposal_ready"
  | "auto_runner_db_update_runner_proposal_basis_caution"
  | "auto_runner_db_update_runner_proposal_not_ready";

export interface CurrentStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number; role: string };
  jalan: { rows: number; directional: number; excluded: number; direct: number; role: string };
  rakuten: { rows: number; role: string };
}

export interface ScheduleConfigLike {
  decision?: string;
  booking_batch_plans?: Array<{ plan_id: string; max_pages_per_run: number; role: string }>;
  jalan_batch_plans?: Array<{ plan_id: string; max_pages_per_run: number; role: string }>;
  date_window_policy?: unknown;
}

export interface PipelineStage {
  stage_id: number;
  name: string;
  purpose: string;
  candidate_commands: string[];
  input_artifacts: string[];
  output_artifacts: string[];
  required_gates: string[];
  success_criteria: string[];
  failure_behavior: string;
  mutation_level: "none" | "preview_artifacts" | "history_write_gated" | "db_write_gated" | "context_write_gated" | "summary_artifact";
}

export interface GateMatrixRow {
  gate: string;
  default_value: "0";
  applies_to: string[];
  required_for: string;
  behavior_when_missing: string;
}

export interface BatchSelectionPolicy {
  booking: {
    role: string;
    fixed_targets_only: true;
    max_pages_per_run: number;
    date_windows: string[];
    due_batch_rule: string;
  };
  jalan: {
    role: string;
    fixed_targets_only: true;
    max_pages_per_run: number;
    date_windows: string[];
    due_batch_rule: string;
  };
  rakuten: { role: string; collect: false };
}

export interface AppendPolicy {
  rules: string[];
}

export interface DbSyncPolicy {
  rules: string[];
}

export interface AiContextPolicy {
  rules: string[];
}

export interface UsabilityIntegrityPolicy {
  checks: string[];
}

export interface PriceOutputSeparation {
  automated_db_runner_includes: string[];
  explicitly_excluded: string[];
  future_on_demand_phases: string[];
}

export interface FailureHandlingPlan {
  stop_conditions: string[];
}

export interface FutureRunnerCommandDesign {
  proposed_script: string;
  proposed_npm_script: string;
  default_behavior: string;
  run_summary_path_pattern: string;
}

export interface SafetyConfirmation {
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
  query_smoke_execution: false;
  price_decision_report_generation: false;
  beds24_csv_generation: false;
  airhost_csv_generation: false;
  pms_ota_channel_manager_output: false;
  price_update: false;
  launchd_or_cron_creation: false;
  github_actions_creation: false;
  git_add_commit_push: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  started_auto_runner08x: false;
}

export function buildCurrentStateSummary(input?: Partial<CurrentStateSummary>): CurrentStateSummary {
  return {
    history_rows: input?.history_rows ?? 210,
    db_rows: input?.db_rows ?? 210,
    ai_context_rows: input?.ai_context_rows ?? 210,
    booking: input?.booking ?? { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary directional backbone" },
    jalan: input?.jalan ?? { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary domestic OTA signal" },
    rakuten: input?.rakuten ?? { rows: 126, role: "frozen / caution" }
  };
}

export function buildDbUpdatePipelineStages(): PipelineStage[] {
  return [
    stage(0, "preflight / environment / gates", "Check cwd, Node/npm, package scripts, source policy, and disabled-by-default gates.", [], [], ["run-state preflight snapshot"], ["none"], ["unsafe gates default to 0"], "Stop before collection if preflight fails.", "none"),
    stage(1, "current state snapshot", "Capture history, DB, AI context, and source-count baseline.", [], [".data/history/zao_signals_*.csv", ".data/ai-context/latest_market_snapshot.json"], ["state snapshot JSON"], ["none"], ["history/DB/context counts are internally consistent"], "Stop if baseline is inconsistent.", "summary_artifact"),
    stage(2, "choose due bounded batches", "Select due Booking/Jalan batches from AUTO-RUNNER05X schedule config.", [], ["AUTO-RUNNER05X schedule config"], ["due batch plan JSON"], ["ZMI_AUTORUN_ENABLED=1"], ["only fixed verified targets are selected"], "Skip safely if no due or enabled batch exists.", "summary_artifact"),
    stage(3, "optional Booking collection, gated", "Collect bounded Booking preview rows only when explicitly enabled.", ["future: npm run probe:booking-bounded-expanded"], ["due Booking batch"], ["Booking preview report/JSON/CSV"], ["ZMI_AUTORUN_ENABLED=1", "COLLECT_BOOKING=1"], ["max 30 pages; fixed slugs only"], "Record failed batch and stop append on block/CAPTCHA/degraded page.", "preview_artifacts"),
    stage(4, "optional Jalan collection, gated", "Collect bounded Jalan preview rows only when explicitly enabled.", ["future: npm run probe:jalan-bounded-collection-improved"], ["due Jalan batch"], ["Jalan preview report/JSON/CSV"], ["ZMI_AUTORUN_ENABLED=1", "COLLECT_JALAN=1"], ["max 25 pages; fixed yad IDs only"], "Record failed batch and stop append on block/CAPTCHA/degraded page.", "preview_artifacts"),
    stage(5, "normalize preview rows", "Validate preview rows against local history-compatible schema.", [], ["collector preview rows"], ["normalized preview rows"], ["none"], ["no inferred prices; source policy preserved"], "Stop append if schema compatibility fails.", "preview_artifacts"),
    stage(6, "generate append proposals", "Build proposal-only append plans for new directional/excluded audit rows.", ["future: source-specific append proposal commands"], ["normalized preview rows", ".data/history/zao_signals_*.csv"], ["append proposal artifacts"], ["none"], ["conflicts classified; no direct Booking rows"], "Stop before append if conflicts are unresolved.", "summary_artifact"),
    stage(7, "append to .data/history, gated", "Append approved rows without overwriting existing rows.", ["future: approved real-run append command"], ["append proposal artifacts"], [".data/history shard update", "append real-run report"], ["ZMI_AUTORUN_ENABLED=1", "ALLOW_HISTORY_APPEND=1", "source-specific append gate"], ["atomic write; backup; 0 unresolved conflicts"], "Stop and roll back on validation failure.", "history_write_gated"),
    stage(8, "DB mirror sync, gated", "Sync DB mirror from canonical history after successful append.", ["future: stale-pointer-safe DB sync command"], [".data/history/zao_signals_*.csv", "fresh dry-run sync artifact"], ["DB sync report"], ["ZMI_AUTORUN_ENABLED=1", "HISTORY_TO_DB_SYNC=1"], ["mapped row count matches history count; conflicts 0"], "Stop on mapped-count mismatch or DB conflict.", "db_write_gated"),
    stage(9, "AI context refresh, gated", "Refresh AI context after DB/history are verified.", ["future: npm run build:ai-context-packs"], ["DB mirror", ".data/history/zao_signals_*.csv"], [".data/ai-context/latest_*.json"], ["ZMI_AUTORUN_ENABLED=1", "BUILD_AI_CONTEXT=1"], ["AI context row count matches history/DB"], "Stop on context count mismatch.", "context_write_gated"),
    stage(10, "usability/integrity verification", "Verify updated source counts, duplicate row_id, excluded leakage, and source usability artifacts.", ["future: source usability report commands"], ["history/DB/context summary"], ["integrity/usability summary JSON"], ["RUN_USABILITY_CHECK=1"], ["no duplicate row_id; no excluded leakage into price pressure"], "Stop before any price output if verification fails.", "summary_artifact"),
    stage(11, "write run summary", "Write machine-readable run summary for later human-facing commands.", [], ["all previous stage summaries"], [".data/reports/automation/auto_runner_db_update_run_summary_*.json"], ["none"], ["summary includes enabled gates, skipped gates, artifacts, and failures"], "Always write a terminal summary artifact when possible.", "summary_artifact"),
    stage(12, "stop before price report / CSV", "End DB update runner before any human-facing price output.", [], ["run summary"], ["no price output"], ["GENERATE_PRICE_REPORT=0", "GENERATE_PRICE_CSV=0"], ["no Notion report, Beds24 CSV, AirHost CSV, PMS output, or price update"], "Fail closed if any price-output gate is accidentally enabled in this runner.", "none")
  ];
}

export function buildGateMatrix(): GateMatrixRow[] {
  return [
    gate("ZMI_AUTORUN_ENABLED", ["all automated stages"], "any automated collector/write/context step"),
    gate("COLLECT_BOOKING", ["Booking collection"], "Booking bounded preview collection"),
    gate("COLLECT_JALAN", ["Jalan collection"], "Jalan bounded preview collection"),
    gate("ALLOW_HISTORY_APPEND", ["history append"], "any append to .data/history"),
    gate("BOOKING_HISTORY_APPEND", ["Booking history append"], "Booking source append real-run"),
    gate("JALAN_HISTORY_APPEND", ["Jalan history append"], "Jalan source append real-run"),
    gate("HISTORY_TO_DB_SYNC", ["DB mirror sync"], "DB sync after successful append"),
    gate("BUILD_AI_CONTEXT", ["AI context refresh"], "AI context rebuild after DB/history verification"),
    gate("RUN_USABILITY_CHECK", ["usability/integrity verification"], "source usability and leakage checks"),
    gate("GENERATE_PRICE_REPORT", ["price report"], "not used by DB update runner; must remain disabled"),
    gate("GENERATE_PRICE_CSV", ["pricing CSV"], "not used by DB update runner; must remain disabled")
  ];
}

export function buildBatchSelectionPolicy(schedule: ScheduleConfigLike): BatchSelectionPolicy {
  const bookingMax = Math.max(...(schedule.booking_batch_plans?.map((plan) => plan.max_pages_per_run) ?? [30]));
  const jalanMax = Math.max(...(schedule.jalan_batch_plans?.map((plan) => plan.max_pages_per_run) ?? [25]));
  return {
    booking: {
      role: "primary directional backbone",
      fixed_targets_only: true,
      max_pages_per_run: bookingMax,
      date_windows: ["near_term_60d", "major_dates_1y", "manual_override_dates"],
      due_batch_rule: "Select only due AUTO-RUNNER05X Booking plans; no search pages, pagination, or unverified slugs."
    },
    jalan: {
      role: "supplementary domestic OTA signal",
      fixed_targets_only: true,
      max_pages_per_run: jalanMax,
      date_windows: ["near_term_60d", "major_dates_1y", "manual_override_dates"],
      due_batch_rule: "Select only due AUTO-RUNNER05X Jalan plans; no broad search or unverified yad IDs."
    },
    rakuten: { role: "frozen / caution", collect: false }
  };
}

export function buildAppendPolicy(): AppendPolicy {
  return {
    rules: [
      "Collection creates preview rows first.",
      "Append proposal is generated before any write.",
      "Append proposal must have 0 unresolved conflicts or only explicitly resolvable benign duplicates.",
      "History append requires ALLOW_HISTORY_APPEND=1 plus BOOKING_HISTORY_APPEND=1 or JALAN_HISTORY_APPEND=1.",
      "Append must use approved real-run machinery with backups/temp files/atomic replace.",
      "Append must never overwrite existing rows.",
      "Append conflict stops the runner before any DB sync."
    ]
  };
}

export function buildDbSyncPolicy(): DbSyncPolicy {
  return {
    rules: [
      "DB sync can run only after successful append and HISTORY_TO_DB_SYNC=1.",
      "If no new rows were appended, skip DB sync or run read-only verification only.",
      "Each DB sync should use a fresh dry-run artifact.",
      "Mapped row count must match expected history count.",
      "Runner should not rely on manually edited stale artifact pointers or count pins long-term.",
      "Future AUTO-RUNNER07B should design a generic fresh DB sync helper if the stale-pointer risk remains."
    ]
  };
}

export function buildAiContextPolicy(): AiContextPolicy {
  return {
    rules: [
      "AI context refresh can run only after DB/history verification and BUILD_AI_CONTEXT=1.",
      "AI context row count must match history/DB row count.",
      "Basis caution is acceptable if source confidence remains directional-heavy.",
      "Context refresh is data freshness work, not price decision output."
    ]
  };
}

export function buildUsabilityIntegrityPolicy(): UsabilityIntegrityPolicy {
  return {
    checks: [
      "Booking usability check if Booking rows changed.",
      "Jalan usability check if Jalan rows changed.",
      "source count check",
      "duplicate row_id check",
      "excluded rows do not leak into price pressure",
      "Booking direct rows remain 0",
      "Jalan direct rows remain evidence-justified",
      "machine-readable run summary includes artifacts and decisions"
    ]
  };
}

export function buildPriceOutputSeparation(): PriceOutputSeparation {
  return {
    automated_db_runner_includes: ["market data collection", "preview rows", "append proposals", "gated append", "DB mirror sync", "AI context refresh", "usability/integrity checks", "machine-readable run summary"],
    explicitly_excluded: ["human-facing price decision report", "Notion market report", "Beds24 CSV", "AirHost CSV", "PMS/OTA/channel-manager output", "price update"],
    future_on_demand_phases: ["AUTO-RUNNER08A - on-demand price decision report command", "AUTO-RUNNER08B - gated Beds24 CSV generation", "AUTO-RUNNER08X - Miuraya pricing CSV generation proposal, gated"]
  };
}

export function buildFailureHandlingPlan(): FailureHandlingPlan {
  return {
    stop_conditions: [
      "preflight failure stops before collection",
      "block/CAPTCHA/degraded page stops append for that source batch",
      "schema compatibility failure stops append",
      "append conflicts stop before history write",
      "history append validation failure rolls back and stops",
      "DB dry-run mapped-count mismatch stops DB sync",
      "DB sync conflict stops AI context refresh",
      "AI context row-count mismatch stops usability completion",
      "price report or CSV request inside this runner stops as out of scope"
    ]
  };
}

export function buildFutureRunnerCommandDesign(): FutureRunnerCommandDesign {
  return {
    proposed_script: "src/scripts/runAutomatedMarketSignalDbUpdate.ts",
    proposed_npm_script: "auto-runner:db-update",
    default_behavior: "With all gates at 0, inspect state, list skipped stages, and write a dry run summary only.",
    run_summary_path_pattern: ".data/reports/automation/auto_runner_db_update_run_summary_YYYYMMDD_HHmmss.json"
  };
}

export function buildRisks(): string[] {
  return [
    "Live execution remains disabled in AUTO-RUNNER07X.",
    "Always-on Mac runtime, sleep, and network behavior remain unverified.",
    "DB sync still needs a stale-pointer-safe fresh dry-run helper before unattended use.",
    "Append gates must remain explicit to avoid silent history mutation.",
    "Price report / CSV generation must stay outside this DB update runner."
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
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
    query_smoke_execution: false,
    price_decision_report_generation: false,
    beds24_csv_generation: false,
    airhost_csv_generation: false,
    pms_ota_channel_manager_output: false,
    price_update: false,
    launchd_or_cron_creation: false,
    github_actions_creation: false,
    git_add_commit_push: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    started_auto_runner08x: false
  };
}

export function decideAutoRunnerDbUpdateRunner(input: { source06Present: boolean; schedulePresent: boolean; executionDisabled: boolean }): AutoRunnerDbUpdateRunnerDecision {
  if (!input.source06Present || !input.schedulePresent) {
    return "auto_runner_db_update_runner_proposal_not_ready";
  }
  if (input.executionDisabled) {
    return "auto_runner_db_update_runner_proposal_basis_caution";
  }
  return "auto_runner_db_update_runner_proposal_ready";
}

export function renderPipelineCsv(stages: readonly PipelineStage[]): string {
  const rows = [["stage_id", "name", "required_gates", "mutation_level", "failure_behavior"]];
  for (const stageItem of stages) {
    rows.push([String(stageItem.stage_id), stageItem.name, stageItem.required_gates.join("; "), stageItem.mutation_level, stageItem.failure_behavior]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerDbUpdateRunnerDecision;
  source06Path: string;
  source05Path: string;
  current: CurrentStateSummary;
  stages: PipelineStage[];
  gates: GateMatrixRow[];
  batchPolicy: BatchSelectionPolicy;
  appendPolicy: AppendPolicy;
  dbSyncPolicy: DbSyncPolicy;
  aiContextPolicy: AiContextPolicy;
  usabilityPolicy: UsabilityIntegrityPolicy;
  priceSeparation: PriceOutputSeparation;
  failure: FailureHandlingPlan;
  commandDesign: FutureRunnerCommandDesign;
  risks: string[];
  safety: SafetyConfirmation;
}): string {
  return `# Automated Market Signal DB Update Runner Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary
AUTO-RUNNER07X designs a disabled-by-default runner for market-signal data freshness: bounded preview collection, append proposal, gated append, DB mirror sync, AI context refresh, integrity verification, and machine-readable run summary. It explicitly stops before price reports, Notion reports, Beds24/AirHost CSV, PMS output, or price updates.

## 2. Source AUTO-RUNNER06X / 05X Results
- AUTO-RUNNER06X artifact: ${input.source06Path}
- AUTO-RUNNER05X schedule config: ${input.source05Path}

## 3. Current State
- History rows: ${input.current.history_rows}
- DB rows: ${input.current.db_rows}
- AI context rows: ${input.current.ai_context_rows}
- Booking: ${input.current.booking.rows} rows, role ${input.current.booking.role}
- Jalan: ${input.current.jalan.rows} rows, role ${input.current.jalan.role}
- Rakuten: ${input.current.rakuten.rows} rows, role ${input.current.rakuten.role}

## 4. DB Update Pipeline Stages
${input.stages.map((stageItem) => `- Stage ${stageItem.stage_id} - ${stageItem.name}: ${stageItem.purpose} Gates: ${stageItem.required_gates.join(", ") || "none"}.`).join("\n")}

## 5. Gate Matrix
${input.gates.map((gateItem) => `- ${gateItem.gate}: default ${gateItem.default_value}; required for ${gateItem.required_for}; missing => ${gateItem.behavior_when_missing}`).join("\n")}

## 6. Batch Selection Policy
- Booking: ${input.batchPolicy.booking.role}; fixed targets only; max pages ${input.batchPolicy.booking.max_pages_per_run}; windows ${input.batchPolicy.booking.date_windows.join(", ")}
- Jalan: ${input.batchPolicy.jalan.role}; fixed targets only; max pages ${input.batchPolicy.jalan.max_pages_per_run}; windows ${input.batchPolicy.jalan.date_windows.join(", ")}
- Rakuten: ${input.batchPolicy.rakuten.role}; collect ${input.batchPolicy.rakuten.collect}

## 7. Append Policy
${input.appendPolicy.rules.map((rule) => `- ${rule}`).join("\n")}

## 8. DB Sync Policy
${input.dbSyncPolicy.rules.map((rule) => `- ${rule}`).join("\n")}

## 9. AI Context Refresh Policy
${input.aiContextPolicy.rules.map((rule) => `- ${rule}`).join("\n")}

## 10. Usability / Integrity Verification
${input.usabilityPolicy.checks.map((check) => `- ${check}`).join("\n")}

## 11. Price Report / CSV Separation
- Automated runner includes: ${input.priceSeparation.automated_db_runner_includes.join("; ")}
- Explicitly excluded: ${input.priceSeparation.explicitly_excluded.join("; ")}
- Future on-demand phases: ${input.priceSeparation.future_on_demand_phases.join("; ")}

## 12. Failure Handling
${input.failure.stop_conditions.map((condition) => `- ${condition}`).join("\n")}

## 13. Future Runner Command Design
- Proposed script: ${input.commandDesign.proposed_script}
- Proposed npm script: ${input.commandDesign.proposed_npm_script}
- Default behavior: ${input.commandDesign.default_behavior}
- Run summary path: ${input.commandDesign.run_summary_path_pattern}

## 14. Risks
${input.risks.map((risk) => `- ${risk}`).join("\n")}

## 15. Safety Confirmation
${Object.entries(input.safety).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## 16. Decision
${input.decision}

## 17. Next Phase
AUTO-RUNNER08X - Miuraya pricing CSV generation proposal, gated, only if explicitly requested; alternatively AUTO-RUNNER07B for generic fresh DB sync helper.
`;
}

function stage(
  stage_id: number,
  name: string,
  purpose: string,
  candidate_commands: string[],
  input_artifacts: string[],
  output_artifacts: string[],
  required_gates: string[],
  success_criteria: string[],
  failure_behavior: string,
  mutation_level: PipelineStage["mutation_level"]
): PipelineStage {
  return { stage_id, name, purpose, candidate_commands, input_artifacts, output_artifacts, required_gates, success_criteria, failure_behavior, mutation_level };
}

function gate(gateName: string, appliesTo: string[], requiredFor: string): GateMatrixRow {
  return {
    gate: gateName,
    default_value: "0",
    applies_to: appliesTo,
    required_for: requiredFor,
    behavior_when_missing: gateName.startsWith("GENERATE_PRICE") ? "remain disabled; DB update runner stops before price output" : "skip gated stage safely"
  };
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

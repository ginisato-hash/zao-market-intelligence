// Phase AUTO-RUNNER07D - DB update runner integration proposal.
//
// Pure design/report helpers only. This module does not run sync commands,
// write DB, append history, refresh AI context, run collectors, or generate
// pricing/PMS output.

export type AutoRunnerDbUpdateIntegrationDecision =
  | "auto_runner_db_update_integration_proposal_ready"
  | "auto_runner_db_update_integration_proposal_basis_caution"
  | "auto_runner_db_update_integration_proposal_not_ready";

export interface CurrentStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number; role: string };
  jalan: { rows: number; directional: number; excluded: number; direct: number; role: string };
  rakuten: { rows: number; role: string };
}

export interface FreshSyncHelperSummary {
  command: string;
  no_env_behavior: string;
  gated_behavior: string;
  latest_decision: string;
  history_count: number;
  mapped_row_count: number;
  inserted_rows: number;
  skipped_identical_rows: number;
  conflict_rows: number;
  db_write_requires_gate: true;
  fresh_mapping_same_run: true;
  stale_pointer_used: false;
  hardcoded_count_pin_used: false;
}

export interface PipelineStage {
  stage_id: number;
  name: string;
  purpose: string;
  candidate_commands: string[];
  required_gates: string[];
  success_criteria: string[];
  failure_behavior: string;
  mutation_level: "none" | "preview_artifacts" | "history_write_gated" | "db_write_gated" | "context_write_gated" | "summary_artifact";
}

export interface GateMatrixRow {
  gate: string;
  default_value: "0";
  required_for: string;
  behavior_when_missing: string;
}

export interface DbSyncIntegrationPolicy {
  approved_automated_sync_path: string;
  rules: string[];
}

export interface AiContextFollowupPolicy {
  rules: string[];
}

export interface PriceOutputSeparation {
  default_gates: Record<"GENERATE_PRICE_REPORT" | "GENERATE_PRICE_CSV", "0">;
  excluded_outputs: string[];
  rule: string;
}

export interface FailureHandlingPlan {
  stop_conditions: string[];
  noop_behavior: string;
}

export interface CompatibilityPlan {
  rules: string[];
}

export interface SafetyConfirmation {
  sync_command_executed: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  history_modification: false;
  history_append: false;
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_launch: false;
  browser_automation: false;
  external_fetch: false;
  price_decision_report_generation: false;
  beds24_csv_generation: false;
  airhost_csv_generation: false;
  pms_ota_channel_manager_output: false;
  price_update: false;
  launchd_cron_github_actions_creation: false;
  git_add_commit_push: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  started_next_phase: false;
}

export interface Source07cLike {
  decision?: string;
  history_summary?: { row_count?: number };
  fresh_mapping_summary?: { mapped_row_count?: number };
  sync_result?: { inserted_rows?: number; skipped_identical_rows?: number; conflict_rows?: number };
}

export interface Source07xLike {
  decision?: string;
  current_state_summary?: Partial<CurrentStateSummary>;
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

export function buildFreshSyncHelperSummary(source07c: Source07cLike): FreshSyncHelperSummary {
  return {
    command: "sync:history-to-db:fresh",
    no_env_behavior: "Without HISTORY_TO_DB_SYNC=1 the helper validates fresh mapping, writes report artifacts, and returns ready_not_run with db_write_executed=false.",
    gated_behavior: "With HISTORY_TO_DB_SYNC=1 the helper applies DB mirror sync from fresh current-history mapping and validates post-state.",
    latest_decision: source07c.decision ?? "unknown",
    history_count: source07c.history_summary?.row_count ?? 210,
    mapped_row_count: source07c.fresh_mapping_summary?.mapped_row_count ?? 210,
    inserted_rows: source07c.sync_result?.inserted_rows ?? 0,
    skipped_identical_rows: source07c.sync_result?.skipped_identical_rows ?? 210,
    conflict_rows: source07c.sync_result?.conflict_rows ?? 0,
    db_write_requires_gate: true,
    fresh_mapping_same_run: true,
    stale_pointer_used: false,
    hardcoded_count_pin_used: false
  };
}

export function buildUpdatedPipelineStages(): PipelineStage[] {
  return [
    stage(0, "preflight / env / gates", "Check cwd, package scripts, source policy, and disabled-by-default gates.", [], ["none"], ["unsafe gates default to 0"], "Stop before collection or writes if preflight fails.", "none"),
    stage(1, "current state snapshot", "Capture history, DB, AI context, and source-count baseline.", [], ["none"], ["history/DB/context counts are internally consistent"], "Stop if current state is internally inconsistent.", "summary_artifact"),
    stage(2, "choose due bounded batches", "Select due fixed-target Booking/Jalan batches from the disabled schedule config.", [], ["ZMI_AUTORUN_ENABLED=1"], ["only verified fixed targets are selected"], "Skip safely if automation is disabled or no batch is due.", "summary_artifact"),
    stage(3, "optional Booking collection, gated", "Collect bounded Booking preview rows only when explicitly enabled.", ["future: Booking bounded preview command"], ["ZMI_AUTORUN_ENABLED=1", "COLLECT_BOOKING=1"], ["Booking remains primary directional backbone; max pages from schedule config"], "Record failed batch and stop append on block/CAPTCHA/degraded page.", "preview_artifacts"),
    stage(4, "optional Jalan collection, gated", "Collect bounded Jalan preview rows only when explicitly enabled.", ["future: Jalan bounded preview command"], ["ZMI_AUTORUN_ENABLED=1", "COLLECT_JALAN=1"], ["Jalan remains supplementary domestic OTA signal; max pages from schedule config"], "Record failed batch and stop append on block/CAPTCHA/degraded page.", "preview_artifacts"),
    stage(5, "normalize preview rows", "Normalize preview rows into history-compatible row candidates without inferring prices.", [], ["none"], ["source policies preserved; no inferred prices"], "Stop append if preview rows fail schema checks.", "preview_artifacts"),
    stage(6, "generate append proposals", "Build proposal-only append plans before any history write.", ["future: source append proposal commands"], ["none"], ["append proposal conflicts are classified"], "Stop before append if conflicts are unresolved.", "summary_artifact"),
    stage(7, "append to .data/history, gated", "Append approved rows without overwriting existing rows.", ["future: approved source append commands"], ["ZMI_AUTORUN_ENABLED=1", "ALLOW_HISTORY_APPEND=1", "BOOKING_HISTORY_APPEND=1 or JALAN_HISTORY_APPEND=1"], ["append validation passes; no overwrite"], "Stop and preserve prior history state on append validation failure.", "history_write_gated"),
    stage(8, "fresh DB sync via sync:history-to-db:fresh, gated", "Sync DB mirror from canonical history with fresh same-run mapping.", ["future: npm run sync:history-to-db:fresh"], ["ZMI_AUTORUN_ENABLED=1", "HISTORY_TO_DB_SYNC=1"], ["mapped count matches history; conflicts 0; DB post-state valid"], "Stop on gate missing, mapped-count mismatch, conflicts, post-state mismatch, or collector baseline drift.", "db_write_gated"),
    stage(9, "AI context refresh, gated", "Refresh AI context only after history and DB state are verified.", ["future: npm run build:ai-context-packs"], ["ZMI_AUTORUN_ENABLED=1", "BUILD_AI_CONTEXT=1"], ["AI context row count matches history/DB"], "Stop on AI context count mismatch.", "context_write_gated"),
    stage(10, "usability/integrity verification", "Verify source counts, duplicate row_id, excluded leakage, and source usability.", ["future: source usability check commands"], ["RUN_USABILITY_CHECK=1"], ["Booking direct remains 0; Jalan direct remains evidence-justified"], "Stop before any downstream output if integrity checks fail.", "summary_artifact"),
    stage(11, "write run summary", "Write machine-readable summary of enabled gates, skipped gates, artifacts, and failures.", [], ["none"], ["summary records no_new_rows/noop when applicable"], "Always write a terminal summary artifact when possible.", "summary_artifact"),
    stage(12, "stop before price report / CSV", "End the DB update runner before human-facing pricing output.", [], ["GENERATE_PRICE_REPORT=0", "GENERATE_PRICE_CSV=0"], ["no price report, CSV, PMS output, or price update"], "Fail closed if price output is requested inside this runner.", "none")
  ];
}

export function buildGateMatrix(): GateMatrixRow[] {
  return [
    gate("ZMI_AUTORUN_ENABLED", "any automated collection/write/context stage", "skip all risky stages"),
    gate("COLLECT_BOOKING", "Booking collection", "skip Booking collection"),
    gate("COLLECT_JALAN", "Jalan collection", "skip Jalan collection"),
    gate("ALLOW_HISTORY_APPEND", "any history append", "stop before history append"),
    gate("BOOKING_HISTORY_APPEND", "Booking history append", "stop before Booking append"),
    gate("JALAN_HISTORY_APPEND", "Jalan history append", "stop before Jalan append"),
    gate("HISTORY_TO_DB_SYNC", "fresh DB sync helper write", "fresh helper returns ready_not_run / no DB write"),
    gate("BUILD_AI_CONTEXT", "AI context refresh", "skip AI context refresh"),
    gate("RUN_USABILITY_CHECK", "usability/integrity verification", "skip or mark verification not run"),
    gate("EXPECTED_HISTORY_ROW_COUNT", "optional fresh sync row-count assertion", "derive count dynamically if omitted; fail closed if provided and mismatched"),
    gate("GENERATE_PRICE_REPORT", "not part of this runner", "remain disabled; runner stops before price report"),
    gate("GENERATE_PRICE_CSV", "not part of this runner", "remain disabled; runner stops before CSV")
  ];
}

export function buildDbSyncIntegrationPolicy(): DbSyncIntegrationPolicy {
  return {
    approved_automated_sync_path: "sync:history-to-db:fresh",
    rules: [
      "The future automated DB update runner should call sync:history-to-db:fresh for DB mirror sync.",
      "The fresh helper generates mapping from current history in the same run.",
      "HISTORY_TO_DB_SYNC=1 is required before any DB write.",
      "EXPECTED_HISTORY_ROW_COUNT may be supplied as an optional operator assertion.",
      "Mapped row count must equal current history row count and conflicts must be 0 before write.",
      "The old manually reviewed real-run flow remains available for emergency/manual use only.",
      "The automated runner must not use fixed timestamped dry-run inputs or manually edited count pins."
    ]
  };
}

export function buildAiContextFollowupPolicy(): AiContextFollowupPolicy {
  return {
    rules: [
      "AI context refresh remains behind BUILD_AI_CONTEXT=1.",
      "AI context refresh may run only after append and fresh DB sync succeed, or may be skipped when no new rows were appended.",
      "If fresh DB sync returns noop because no new history rows exist, run summary should record no_new_rows and context refresh can remain skipped unless explicitly configured.",
      "AI context row count must match history/DB row count after refresh."
    ]
  };
}

export function buildPriceOutputSeparation(): PriceOutputSeparation {
  return {
    default_gates: { GENERATE_PRICE_REPORT: "0", GENERATE_PRICE_CSV: "0" },
    excluded_outputs: ["price decision report", "Notion market report", "Beds24 CSV", "AirHost CSV", "PMS/OTA/channel-manager output", "price update"],
    rule: "The DB update runner automates data freshness only; human-facing pricing output is a separate on-demand layer."
  };
}

export function buildFailureHandlingPlan(): FailureHandlingPlan {
  return {
    stop_conditions: [
      "fresh sync no-env gate missing",
      "fresh sync mapped-count mismatch",
      "fresh sync conflicts > 0",
      "fresh sync DB post-state mismatch",
      "fresh sync collector baseline drift",
      "AI context count mismatch",
      "append conflicts",
      "collection block/CAPTCHA/degraded page",
      "price output requested inside DB update runner"
    ],
    noop_behavior: "If no new history rows were appended, sync:history-to-db:fresh may return noop; AI context refresh may be skipped or run only if configured, and run summary records no_new_rows."
  };
}

export function buildCompatibilityPlan(): CompatibilityPlan {
  return {
    rules: [
      "Keep the existing manually reviewed sync flow intact for emergency/manual use.",
      "Use sync:history-to-db:fresh as the only approved DB sync path for future automation.",
      "Do not require repointing scripts or editing mapped-count constants in the automated path.",
      "Retain source-specific append gates before the fresh sync stage.",
      "Integrate the fresh helper into a future disabled runner implementation only after explicit approval."
    ]
  };
}

export function buildRisks(): string[] {
  return [
    "Actual automated runner implementation remains future work.",
    "Always-on Mac runtime, schedule behavior, and operator gate management remain unverified.",
    "Append execution still needs source-specific gated approval before fresh DB sync can safely run.",
    "AI context refresh integration remains gated and unimplemented in this phase."
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    sync_command_executed: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke: false,
    history_modification: false,
    history_append: false,
    live_booking_collection: false,
    live_jalan_collection: false,
    playwright_launch: false,
    browser_automation: false,
    external_fetch: false,
    price_decision_report_generation: false,
    beds24_csv_generation: false,
    airhost_csv_generation: false,
    pms_ota_channel_manager_output: false,
    price_update: false,
    launchd_cron_github_actions_creation: false,
    git_add_commit_push: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    started_next_phase: false
  };
}

export function decideAutoRunnerDbUpdateIntegration(input: {
  source07cPresent: boolean;
  source07xPresent: boolean;
  executionDisabled: boolean;
}): AutoRunnerDbUpdateIntegrationDecision {
  if (!input.source07cPresent || !input.source07xPresent) return "auto_runner_db_update_integration_proposal_not_ready";
  if (input.executionDisabled) return "auto_runner_db_update_integration_proposal_basis_caution";
  return "auto_runner_db_update_integration_proposal_ready";
}

export function renderPipelineCsv(stages: readonly PipelineStage[]): string {
  const rows = [["stage_id", "name", "candidate_commands", "required_gates", "mutation_level", "failure_behavior"]];
  for (const item of stages) rows.push([String(item.stage_id), item.name, item.candidate_commands.join("; "), item.required_gates.join("; "), item.mutation_level, item.failure_behavior]);
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerDbUpdateIntegrationDecision;
  source07cPath: string;
  source07xPath: string;
  current: CurrentStateSummary;
  fresh: FreshSyncHelperSummary;
  stages: PipelineStage[];
  gates: GateMatrixRow[];
  dbSyncPolicy: DbSyncIntegrationPolicy;
  aiContextPolicy: AiContextFollowupPolicy;
  priceSeparation: PriceOutputSeparation;
  failure: FailureHandlingPlan;
  compatibility: CompatibilityPlan;
  risks: string[];
  safety: SafetyConfirmation;
}): string {
  return `# DB Update Runner Integration Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary
AUTO-RUNNER07D updates the disabled DB update runner plan so future automation uses ${input.fresh.command} for DB mirror sync. The runner remains data-freshness only: no collector, append, DB sync, context refresh, pricing report, CSV, or PMS output is executed in this phase.

## 2. Source AUTO-RUNNER07C / 07X Results
- AUTO-RUNNER07C artifact: ${input.source07cPath}
- AUTO-RUNNER07X artifact: ${input.source07xPath}
- AUTO-RUNNER07C latest decision: ${input.fresh.latest_decision}

## 3. Current State
- History rows: ${input.current.history_rows}
- DB rows: ${input.current.db_rows}
- AI context rows: ${input.current.ai_context_rows}
- Booking: ${input.current.booking.rows} rows, role ${input.current.booking.role}
- Jalan: ${input.current.jalan.rows} rows, role ${input.current.jalan.role}
- Rakuten: ${input.current.rakuten.rows} rows, role ${input.current.rakuten.role}

## 4. Fresh DB Sync Helper Summary
- Command: ${input.fresh.command}
- No-env behavior: ${input.fresh.no_env_behavior}
- Gated behavior: ${input.fresh.gated_behavior}
- Latest counts: history ${input.fresh.history_count}, mapped ${input.fresh.mapped_row_count}, inserted ${input.fresh.inserted_rows}, skipped identical ${input.fresh.skipped_identical_rows}, conflicts ${input.fresh.conflict_rows}
- Fresh same-run mapping: ${input.fresh.fresh_mapping_same_run}
- Stale pointer used: ${input.fresh.stale_pointer_used}
- Hardcoded count pin used: ${input.fresh.hardcoded_count_pin_used}

## 5. Updated Pipeline Stages
${input.stages.map((item) => `- Stage ${item.stage_id} - ${item.name}: ${item.purpose} Gates: ${item.required_gates.join(", ") || "none"}.`).join("\n")}

## 6. Gate Matrix
${input.gates.map((item) => `- ${item.gate}: default ${item.default_value}; required for ${item.required_for}; missing => ${item.behavior_when_missing}`).join("\n")}

## 7. DB Sync Integration Policy
- Approved automated sync path: ${input.dbSyncPolicy.approved_automated_sync_path}
${input.dbSyncPolicy.rules.map((rule) => `- ${rule}`).join("\n")}

## 8. AI Context Follow-Up Policy
${input.aiContextPolicy.rules.map((rule) => `- ${rule}`).join("\n")}

## 9. Price Output Separation
- Default price gates: GENERATE_PRICE_REPORT=${input.priceSeparation.default_gates.GENERATE_PRICE_REPORT}, GENERATE_PRICE_CSV=${input.priceSeparation.default_gates.GENERATE_PRICE_CSV}
- Excluded outputs: ${input.priceSeparation.excluded_outputs.join("; ")}
- Rule: ${input.priceSeparation.rule}

## 10. Failure Handling
${input.failure.stop_conditions.map((condition) => `- ${condition}`).join("\n")}
- Noop behavior: ${input.failure.noop_behavior}

## 11. Compatibility Plan
${input.compatibility.rules.map((rule) => `- ${rule}`).join("\n")}

## 12. Risks
${input.risks.map((risk) => `- ${risk}`).join("\n")}

## 13. Safety Confirmation
${Object.entries(input.safety).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## 14. Decision
${input.decision}

## 15. Next Phase
AUTO-RUNNER08X — Miuraya pricing CSV generation proposal, gated; or AUTO-RUNNER07E — disabled end-to-end DB update runner implementation stub. Do not start either without explicit instruction.
`;
}

function stage(
  stage_id: number,
  name: string,
  purpose: string,
  candidate_commands: string[],
  required_gates: string[],
  success_criteria: string[],
  failure_behavior: string,
  mutation_level: PipelineStage["mutation_level"]
): PipelineStage {
  return { stage_id, name, purpose, candidate_commands, required_gates, success_criteria, failure_behavior, mutation_level };
}

function gate(gateName: string, requiredFor: string, behaviorWhenMissing: string): GateMatrixRow {
  return { gate: gateName, default_value: "0", required_for: requiredFor, behavior_when_missing: behaviorWhenMissing };
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

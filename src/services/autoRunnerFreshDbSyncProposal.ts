// Phase AUTO-RUNNER07B - generic fresh DB sync helper proposal.
//
// Pure proposal helpers only. This module does not run dry-run sync, run real
// sync, write DB, refresh AI context, mutate history, run collectors, or produce
// pricing/PMS output.

export type AutoRunnerFreshDbSyncDecision =
  | "auto_runner_fresh_db_sync_proposal_ready"
  | "auto_runner_fresh_db_sync_proposal_basis_caution"
  | "auto_runner_fresh_db_sync_proposal_not_ready";

export interface CurrentStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number; role: string };
  jalan: { rows: number; directional: number; excluded: number; direct: number; role: string };
  rakuten: { rows: number; role: string };
}

export interface ExistingSyncFlowInventory {
  real_run_script: string;
  real_run_service: string;
  real_run_tests: string;
  dry_run_script: string;
  dry_run_service: string;
  latest_known_dry_run_artifacts: string[];
  latest_known_real_run_artifacts: string[];
  observed_risks: string[];
}

export interface SyncRiskAnalysis {
  risks: Array<{ risk_id: string; severity: "high" | "medium" | "low"; description: string; mitigation: string }>;
}

export interface FreshSyncWorkflowDesign {
  steps: Array<{ step_id: number; name: string; purpose: string; validation: string; mutation: "none" | "future_db_write_gated" }>;
}

export interface GateMatrixRow {
  gate: string;
  default_value: "0";
  required_for: string;
  behavior_when_missing: string;
}

export interface IdempotencyPolicy {
  cases: Array<{ case_id: string; condition: string; expected_behavior: string }>;
}

export interface FailureBehavior {
  stop_conditions: string[];
}

export interface FutureCommandDesign {
  proposed_command: string;
  proposed_script: string;
  behavior: string[];
  optional_env: string[];
  source_specific_hardcoding_allowed: false;
}

export interface CompatibilityPlan {
  rules: string[];
}

export interface SafetyConfirmation {
  dry_run_command_executed: false;
  real_sync_command_executed: false;
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
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  git_add_commit_push: false;
  launchd_cron_github_actions_activation: false;
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

export function buildExistingSyncFlowInventory(input: {
  dryRunArtifacts: string[];
  realRunArtifacts: string[];
  realRunScriptSource: string;
  realRunServiceSource: string;
  realRunTestSource: string;
}): ExistingSyncFlowInventory {
  const observedRisks: string[] = [];
  if (/AUTO03X_JSON\s*=/.test(input.realRunScriptSource)) observedRisks.push("hardcoded dry-run summary artifact pointer in real-run script");
  if (/AUTO03X_MAPPED_ROWS\s*=/.test(input.realRunScriptSource)) observedRisks.push("hardcoded mapped rows artifact pointer in real-run script");
  if (/APPROVED_MAPPED_ROW_COUNT\s*=/.test(input.realRunServiceSource)) observedRisks.push("stale APPROVED_MAPPED_ROW_COUNT safety pin risk");
  if (/mapped_row_count:\s*\d+/.test(input.realRunTestSource)) observedRisks.push("test fixture pins mapped row count and must be manually bumped");
  return {
    real_run_script: "src/scripts/runHistoryToDbSyncRealRun.ts",
    real_run_service: "src/services/historyToDbSyncRealRun.ts",
    real_run_tests: "tests/historyToDbSyncRealRun.test.ts",
    dry_run_script: "src/scripts/runHistoryToDbSyncDryRun.ts",
    dry_run_service: "src/services/historyToDbSyncDryRun.ts",
    latest_known_dry_run_artifacts: input.dryRunArtifacts,
    latest_known_real_run_artifacts: input.realRunArtifacts,
    observed_risks: observedRisks
  };
}

export function buildSyncRiskAnalysis(): SyncRiskAnalysis {
  return {
    risks: [
      {
        risk_id: "hardcoded_artifact_pointer",
        severity: "high",
        description: "The current real-run script points to timestamped dry-run artifacts, so automation can accidentally sync stale mapped rows.",
        mitigation: "Future helper must generate or load the dry-run produced in the same run and pass that fresh artifact path forward."
      },
      {
        risk_id: "approved_mapped_row_count_stale_pin",
        severity: "high",
        description: "APPROVED_MAPPED_ROW_COUNT is a reviewed safety pin, but it must currently be edited by hand after each history append.",
        mitigation: "Future helper should derive expected count from current .data/history and require dry_run.mapped_row_count === current_history_row_count."
      },
      {
        risk_id: "source_specific_timestamp_assumption",
        severity: "medium",
        description: "Names such as AUTO03X_JSON are historical and source/phase specific, making mixed-source automation brittle.",
        mitigation: "Use generic run IDs and source-agnostic input contracts."
      },
      {
        risk_id: "manual_test_fixture_bump",
        severity: "medium",
        description: "Tests pin expected mapped counts, which is useful for reviewed phases but too manual for always-on freshness.",
        mitigation: "Move generic helper tests to dynamic current-history-count validation."
      }
    ]
  };
}

export function buildFreshSyncWorkflowDesign(): FreshSyncWorkflowDesign {
  return {
    steps: [
      step(1, "count current history rows", "Read .data/history shards and validate row count > 0.", "expected_history_row_count is established before dry-run.", "none"),
      step(2, "validate history identity", "Check duplicate row_id and required schema columns before DB planning.", "duplicate row_id count = 0 and schema valid.", "none"),
      step(3, "create fresh dry-run in same run", "Invoke dry-run service in-process or through a controlled internal function in the future helper.", "dry-run artifact run_id belongs to current sync run.", "none"),
      step(4, "validate dry-run", "Compare dry-run mapped rows and conflict summary against current history.", "mapped_row_count === current_history_row_count and conflict count = 0.", "none"),
      step(5, "require write gate", "Fail closed unless explicit DB sync gate is present.", "HISTORY_TO_DB_SYNC=1; optional EXPECTED_HISTORY_ROW_COUNT matches current count.", "none"),
      step(6, "run real sync from fresh rows", "Future write-capable helper syncs from in-memory fresh mapped rows or fresh artifact path.", "no stale timestamp pointer and no source-specific artifact name.", "future_db_write_gated"),
      step(7, "validate post-state", "Check DB row count, row hashes, sync run record, collector baseline, and conflicts.", "DB rows match history; row_hashes match; sync_run record exists.", "none"),
      step(8, "write report/debug artifacts", "Write machine-readable sync report and safety evidence.", "report includes dry-run path, gate result, idempotency result, and validation.", "none")
    ]
  };
}

export function buildGateMatrix(): GateMatrixRow[] {
  return [
    { gate: "HISTORY_TO_DB_SYNC", default_value: "0", required_for: "future write-capable DB sync", behavior_when_missing: "fail closed after fresh dry-run validation; no DB write" },
    { gate: "EXPECTED_HISTORY_ROW_COUNT", default_value: "0", required_for: "optional operator assertion", behavior_when_missing: "derive dynamically from current history; if present, must match current history row count" },
    { gate: "COLLECTOR_TABLE_WRITE_MODE", default_value: "0", required_for: "not allowed", behavior_when_missing: "must remain disabled" },
    { gate: "LIVE_COLLECTOR_MODE", default_value: "0", required_for: "not allowed", behavior_when_missing: "must remain disabled" },
    { gate: "GITHUB_ACTIONS_MODE", default_value: "0", required_for: "not allowed", behavior_when_missing: "must remain disabled" }
  ];
}

export function buildIdempotencyPolicy(): IdempotencyPolicy {
  return {
    cases: [
      { case_id: "db_already_up_to_date", condition: "DB already has every row_id with the same row_hash.", expected_behavior: "inserted=0; skipped_identical=current_count; conflicts=0; decision=success_or_noop." },
      { case_id: "db_behind_history", condition: "DB is missing some history row_ids but existing hashes match.", expected_behavior: "insert missing rows; skip identical rows; conflicts=0." },
      { case_id: "hash_conflict", condition: "DB has same row_id with different row_hash.", expected_behavior: "stop; no overwrite; manual review required." },
      { case_id: "duplicate_history_row_id", condition: "Current history has duplicate row_id with different hashes.", expected_behavior: "stop before dry-run approval." }
    ]
  };
}

export function buildFailureBehavior(): FailureBehavior {
  return {
    stop_conditions: [
      "history files missing",
      "history row count = 0",
      "duplicate row_id in history",
      "schema invalid",
      "dry-run mapped count != history row count",
      "dry-run conflict count > 0",
      "HISTORY_TO_DB_SYNC != 1 for write-capable future command",
      "EXPECTED_HISTORY_ROW_COUNT provided but mismatched",
      "DB post-row-count mismatch",
      "row_hash mismatch",
      "sync_run record missing",
      "collector baseline unexpected"
    ]
  };
}

export function buildFutureCommandDesign(): FutureCommandDesign {
  return {
    proposed_command: "sync:history-to-db:fresh",
    proposed_script: "src/scripts/syncHistoryToDbFresh.ts",
    behavior: [
      "count current history rows",
      "run dry-run internally or call dry-run service in-process",
      "write fresh dry-run artifact",
      "validate mapped count equals current history count",
      "validate conflicts = 0",
      "require HISTORY_TO_DB_SYNC=1 before write",
      "run real sync from in-memory fresh mapped rows or fresh artifact path",
      "validate DB post-state",
      "write report/debug artifacts"
    ],
    optional_env: ["EXPECTED_HISTORY_ROW_COUNT=<current count>"],
    source_specific_hardcoding_allowed: false
  };
}

export function buildCompatibilityPlan(): CompatibilityPlan {
  return {
    rules: [
      "Keep existing manually reviewed real-run flow intact until the generic helper is approved.",
      "Add future command as a new path rather than replacing runHistoryToDbSyncRealRun.ts immediately.",
      "Reuse existing dry-run mapping, applyRealSync, and validatePostSync logic where possible.",
      "Do not remove APPROVED_MAPPED_ROW_COUNT from reviewed manual flow in this phase.",
      "Future write-capable helper tests should validate dynamic count behavior separately from legacy pinned tests."
    ]
  };
}

export function buildRisks(): string[] {
  return [
    "Write-capable helper remains future work.",
    "In-process dry-run reuse must be carefully factored to avoid duplicating mapping logic.",
    "Dynamic count validation must preserve fail-closed safety and not become a silent bypass.",
    "Existing manual sync flow still has stale-pointer risk until the future helper is implemented and adopted."
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    dry_run_command_executed: false,
    real_sync_command_executed: false,
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
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    git_add_commit_push: false,
    launchd_cron_github_actions_activation: false,
    started_auto_runner08x: false
  };
}

export function decideAutoRunnerFreshDbSync(input: { source07xPresent: boolean; inspectedExistingFlow: boolean; writeCapableImplementationDeferred: boolean }): AutoRunnerFreshDbSyncDecision {
  if (!input.source07xPresent || !input.inspectedExistingFlow) {
    return "auto_runner_fresh_db_sync_proposal_not_ready";
  }
  if (input.writeCapableImplementationDeferred) {
    return "auto_runner_fresh_db_sync_proposal_basis_caution";
  }
  return "auto_runner_fresh_db_sync_proposal_ready";
}

export function renderWorkflowCsv(workflow: FreshSyncWorkflowDesign): string {
  const rows = [["step_id", "name", "validation", "mutation"]];
  for (const item of workflow.steps) rows.push([String(item.step_id), item.name, item.validation, item.mutation]);
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerFreshDbSyncDecision;
  source07xPath: string;
  current: CurrentStateSummary;
  inventory: ExistingSyncFlowInventory;
  riskAnalysis: SyncRiskAnalysis;
  workflow: FreshSyncWorkflowDesign;
  gates: GateMatrixRow[];
  idempotency: IdempotencyPolicy;
  failure: FailureBehavior;
  futureCommand: FutureCommandDesign;
  compatibility: CompatibilityPlan;
  risks: string[];
  safety: SafetyConfirmation;
}): string {
  return `# Fresh History-to-DB Sync Helper Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary
AUTO-RUNNER07B designs a future generic history-to-DB sync helper that always uses a fresh dry-run from the same run, validates mapped count against current history, blocks conflicts, requires HISTORY_TO_DB_SYNC=1 for writes, and avoids stale artifact pointers or stale mapped-count pins.

## 2. Source AUTO-RUNNER07X Result
- Source artifact: ${input.source07xPath}

## 3. Current State
- History rows: ${input.current.history_rows}
- DB rows: ${input.current.db_rows}
- AI context rows: ${input.current.ai_context_rows}
- Booking: ${input.current.booking.rows} rows, ${input.current.booking.role}
- Jalan: ${input.current.jalan.rows} rows, ${input.current.jalan.role}
- Rakuten: ${input.current.rakuten.rows} rows, ${input.current.rakuten.role}

## 4. Existing Sync Flow Inventory
- Real-run script: ${input.inventory.real_run_script}
- Real-run service: ${input.inventory.real_run_service}
- Real-run tests: ${input.inventory.real_run_tests}
- Dry-run script: ${input.inventory.dry_run_script}
- Dry-run service: ${input.inventory.dry_run_service}
- Observed risks: ${input.inventory.observed_risks.join("; ")}

## 5. Sync Risk Analysis
${input.riskAnalysis.risks.map((risk) => `- ${risk.risk_id} (${risk.severity}): ${risk.description} Mitigation: ${risk.mitigation}`).join("\n")}

## 6. Fresh Sync Workflow Design
${input.workflow.steps.map((stepItem) => `${stepItem.step_id}. ${stepItem.name}: ${stepItem.purpose} Validation: ${stepItem.validation}`).join("\n")}

## 7. Gate Matrix
${input.gates.map((gate) => `- ${gate.gate}: default ${gate.default_value}; ${gate.required_for}; ${gate.behavior_when_missing}`).join("\n")}

## 8. Idempotency Policy
${input.idempotency.cases.map((item) => `- ${item.case_id}: ${item.condition} => ${item.expected_behavior}`).join("\n")}

## 9. Failure Behavior
${input.failure.stop_conditions.map((condition) => `- ${condition}`).join("\n")}

## 10. Future Command Design
- Command: ${input.futureCommand.proposed_command}
- Script: ${input.futureCommand.proposed_script}
- Behavior: ${input.futureCommand.behavior.join("; ")}
- Optional env: ${input.futureCommand.optional_env.join("; ")}
- Source-specific hardcoding allowed: ${input.futureCommand.source_specific_hardcoding_allowed}

## 11. Compatibility Plan
${input.compatibility.rules.map((rule) => `- ${rule}`).join("\n")}

## 12. Risks
${input.risks.map((risk) => `- ${risk}`).join("\n")}

## 13. Safety Confirmation
${Object.entries(input.safety).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## 14. Decision
${input.decision}

## 15. Next Phase
AUTO-RUNNER07C — Write-capable fresh DB sync helper implementation, gated, only with explicit approval.
`;
}

function step(step_id: number, name: string, purpose: string, validation: string, mutation: "none" | "future_db_write_gated"): FreshSyncWorkflowDesign["steps"][number] {
  return { step_id, name, purpose, validation, mutation };
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// Phase AUTO-RUNNER03X - manual workflow runner proposal helpers.
//
// Design/report helpers only. This module does not run collectors, launch
// browsers, append history, sync DB, refresh AI context, create schedules, or
// generate pricing/PMS output.

export type AutoRunnerManualWorkflowDecision =
  | "auto_runner_manual_workflow_proposal_ready"
  | "auto_runner_manual_workflow_proposal_basis_caution"
  | "auto_runner_manual_workflow_proposal_not_ready";

export type ScriptCategory =
  | "safe_validation"
  | "read_only_report"
  | "proposal_only"
  | "live_collector"
  | "history_append"
  | "db_sync"
  | "ai_context_refresh"
  | "pricing_output"
  | "unknown_review";

export interface AutoRunner02xArtifactLike {
  decision?: string;
  current_state_summary?: {
    history_rows?: number;
    db_rows?: number;
    ai_context_rows?: number;
    source_counts?: Record<string, number>;
    current_blockers?: string[];
  };
  risks?: string[];
}

export interface CurrentStateSummary {
  auto_runner02x_decision: string;
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number; role: string };
  jalan: { rows: number; directional: number; excluded: number; direct: number; role: string };
  rakuten: { rows: number; role: string };
  known_cautions: string[];
}

export interface ScriptInventoryRow {
  script_name: string;
  command: string;
  category: ScriptCategory;
  required_gate: string;
  future_runner_use: string;
}

export interface WorkflowStage {
  stage: number;
  name: string;
  trigger: string;
  command_candidates: string[];
  inputs: string[];
  outputs: string[];
  gate: string;
  success_criteria: string[];
  failure_behavior: string;
}

export interface GateMatrixRow {
  gate: string;
  default: "disabled";
  controls: string;
  required_for: string[];
  failure_if_missing: string;
}

export interface DryRunBehavior {
  future_command: string;
  behavior: string[];
}

export interface FailureHandlingPlan {
  fail_closed_rules: string[];
}

export interface FutureRunnerCommandDesign {
  proposed_script: string;
  proposed_npm_script: string;
  implementation_policy: string;
  dry_run_command: string;
}

export interface SafetyConfirmation {
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_browser_automation: false;
  external_fetch: false;
  history_modification: false;
  history_append: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke_execution: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  cron_launchd_github_actions_creation: false;
  git_add_commit_push: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  started_auto_runner04x: false;
}

export function buildCurrentStateSummary(input: AutoRunner02xArtifactLike): CurrentStateSummary {
  const current = input.current_state_summary ?? {};
  const sourceCounts = current.source_counts ?? {};
  return {
    auto_runner02x_decision: input.decision ?? "unknown",
    history_rows: current.history_rows ?? 210,
    db_rows: current.db_rows ?? 210,
    ai_context_rows: current.ai_context_rows ?? 210,
    booking: { rows: sourceCounts["booking"] ?? 46, directional: 42, excluded: 4, direct: 0, role: "primary directional backbone" },
    jalan: { rows: sourceCounts["jalan"] ?? 38, directional: 8, excluded: 24, direct: 6, role: "supplementary domestic OTA signal" },
    rakuten: { rows: sourceCounts["rakuten"] ?? 126, role: "frozen / caution" },
    known_cautions: [...(current.current_blockers ?? []), ...(input.risks ?? [])]
  };
}

export function classifyScript(scriptName: string, command: string): ScriptCategory {
  if (scriptName === "typecheck" || scriptName === "test" || scriptName === "check:no-paid-sources" || scriptName === "db:verify") return "safe_validation";
  if (scriptName.startsWith("proposal:") || scriptName.startsWith("plan:") || scriptName.startsWith("design:") || scriptName.startsWith("review:")) return "proposal_only";
  if (scriptName.startsWith("report:") || scriptName.startsWith("inspect:") || scriptName.startsWith("audit:") || scriptName.startsWith("checklist:")) return "read_only_report";
  if (scriptName.startsWith("probe:") || scriptName.startsWith("collect:")) return "live_collector";
  if (scriptName.startsWith("real-run:") && (scriptName.includes("append") || scriptName.includes("history"))) return "history_append";
  if (scriptName.includes("history-to-db-sync")) return "db_sync";
  if (scriptName === "build:ai-context-packs") return "ai_context_refresh";
  if (scriptName.startsWith("pricing:") || scriptName.startsWith("export:pricing")) return "pricing_output";
  return "unknown_review";
}

export function buildScriptInventoryClassification(scripts: Record<string, string>): ScriptInventoryRow[] {
  return Object.entries(scripts)
    .filter(([name]) => /(typecheck|test|check:no-paid-sources|db:verify|booking|jalan|history-to-db|ai-context|query:ai-task|pricing|proposal|report|probe|collect|real-run|refresh)/u.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scriptName, command]) => {
      const category = classifyScript(scriptName, command);
      return {
        script_name: scriptName,
        command,
        category,
        required_gate: gateForCategory(scriptName, category),
        future_runner_use: futureUseForCategory(category)
      };
    });
}

export function buildManualWorkflowStages(): WorkflowStage[] {
  return [
    stage(0, "preflight", "always", ["pwd", "git status --short", "node --version", "npm --version"], ["repo root", "package.json"], ["preflight status"], "none", ["cwd is repo root", "node/npm available"], "stop before any collector"),
    stage(1, "data state check", "after preflight", ["history row-count check", "read AI context latest snapshot", "npm run db:verify"], [".data/history", ".data/ai-context"], ["state summary"], "none", ["history/DB/context counts match expected baseline"], "stop unless reconciliation mode is explicitly designed"),
    stage(2, "safe validation", "after state check", ["npm run typecheck", "npm run test", "npm run check:no-paid-sources", "npm run db:verify"], ["source", "tests"], ["validation summary"], "none", ["all validation commands pass"], "stop"),
    stage(3, "optional Booking bounded collection", "operator request", ["npm run probe:booking-bounded-expanded"], ["verified Booking target matrix"], ["Booking preview rows"], "COLLECT_BOOKING=1", ["bounded page cap respected", "no block/CAPTCHA escalation"], "record failure and stop append"),
    stage(4, "optional Jalan bounded collection", "operator request", ["npm run probe:jalan-bounded-collection-improved"], ["approved Jalan target matrix"], ["Jalan preview rows"], "COLLECT_JALAN=1", ["bounded page cap respected", "no degraded page promoted"], "record failure and stop append"),
    stage(5, "append proposal generation", "after preview artifacts", ["npm run proposal:booking-bounded-append-with-identity", "npm run proposal:jalan-history-append"], ["preview rows", ".data/history"], ["append proposal"], "none", ["conflicts summarized", "no writes"], "stop on proposal conflicts"),
    stage(6, "approved append", "after human approval", ["npm run real-run:booking-bounded-append-with-identity", "npm run real-run:jalan-history-append"], ["approved proposal"], ["updated history"], "BOOKING_HISTORY_APPEND=1 or JALAN_HISTORY_APPEND=1", ["row count and backups valid"], "rollback or stop"),
    stage(7, "DB mirror sync", "after approved append", ["npm run dry-run:history-to-db-sync", "HISTORY_TO_DB_SYNC=1 npm run real-run:history-to-db-sync"], [".data/history"], ["DB mirror"], "HISTORY_TO_DB_SYNC=1", ["dry-run conflict-free", "DB count matches history"], "stop on DB conflicts"),
    stage(8, "AI context refresh", "after DB sync", ["BUILD_AI_CONTEXT=1 npm run build:ai-context-packs"], ["DB mirror"], ["AI context packs"], "BUILD_AI_CONTEXT=1", ["AI context row count matches DB"], "stop on count mismatch"),
    stage(9, "usability verification / price-pressure report", "after context refresh", ["npm run report:booking-price-pressure-usability", "npm run report:jalan-price-pressure-usability"], ["AI context", "history"], ["usability report"], "RUN_QUERY_SMOKE=1 for query smoke", ["human-readable basis/caveat report exists"], "stop before pricing decisions"),
    stage(10, "optional price decision report, no CSV", "operator request", ["npm run pricing:recommend"], ["AI context", "guardrails"], ["decision report"], "GENERATE_PRICE_REPORT=1", ["human review required"], "do not generate CSV"),
    stage(11, "optional pricing CSV generation", "separate operator approval", ["npm run export:pricing-review"], ["approved price decision"], ["pricing CSV / packet"], "GENERATE_PRICE_CSV=1", ["explicit approval captured"], "never upload automatically")
  ];
}

export function buildGateMatrix(): GateMatrixRow[] {
  return [
    gate("COLLECT_BOOKING=1", "Booking bounded collection", ["Stage 3"]),
    gate("COLLECT_JALAN=1", "Jalan bounded collection", ["Stage 4"]),
    gate("BOOKING_HISTORY_APPEND=1", "Booking history append", ["Stage 6"]),
    gate("JALAN_HISTORY_APPEND=1", "Jalan history append", ["Stage 6"]),
    gate("HISTORY_TO_DB_SYNC=1", "DB mirror sync", ["Stage 7"]),
    gate("BUILD_AI_CONTEXT=1", "AI context refresh", ["Stage 8"]),
    gate("RUN_QUERY_SMOKE=1", "query smoke / usability verification", ["Stage 9"]),
    gate("GENERATE_PRICE_REPORT=1", "price decision report only", ["Stage 10"]),
    gate("GENERATE_PRICE_CSV=1", "pricing CSV generation", ["Stage 11"])
  ];
}

export function buildDryRunBehavior(): DryRunBehavior {
  return {
    future_command: "npm run manual-run:market-workflow -- --dry-run",
    behavior: [
      "Inspect current state.",
      "List intended steps.",
      "Show which gates are disabled.",
      "Show commands that would run.",
      "Write a run plan artifact.",
      "Perform no mutation."
    ]
  };
}

export function buildFailureHandlingPlan(): FailureHandlingPlan {
  return {
    fail_closed_rules: [
      "If preflight fails: stop before any collector.",
      "If tests fail: stop.",
      "If no-paid guard fails: stop.",
      "If history/DB/context count mismatch: stop unless explicitly in reconciliation mode.",
      "If live collection detects block/CAPTCHA/degraded page: record failure and stop append.",
      "If append proposal has conflicts: stop before append.",
      "If DB sync conflicts: stop.",
      "If AI context count mismatch: stop.",
      "If price CSV gate missing: do not generate CSV.",
      "PMS/Beds24 upload must never happen automatically."
    ]
  };
}

export function buildFutureRunnerCommandDesign(): FutureRunnerCommandDesign {
  return {
    proposed_script: "src/scripts/runManualMarketIntelligenceWorkflow.ts",
    proposed_npm_script: "manual-run:market-workflow",
    implementation_policy: "AUTO-RUNNER03X designs this command only; AUTO-RUNNER04X or later may implement a dry-run-first orchestrator with all risky actions disabled by default.",
    dry_run_command: "npm run manual-run:market-workflow -- --dry-run"
  };
}

export function buildHumanReviewCheckpoints(): string[] {
  return [
    "After collection preview.",
    "After append proposal.",
    "Before approved append.",
    "After DB/context refresh.",
    "After price-pressure report.",
    "Before any pricing CSV generation."
  ];
}

export function buildRisks(current: CurrentStateSummary): string[] {
  return [
    "Actual always-on Mac environment remains unverified.",
    "Future runner implementation must not collapse collection into pricing output.",
    "DB regeneration still needs a stale-pointer-safe command.",
    "Live collection remains WAF/CAPTCHA/degraded-page sensitive.",
    ...current.known_cautions
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    live_booking_collection: false,
    live_jalan_collection: false,
    playwright_browser_automation: false,
    external_fetch: false,
    history_modification: false,
    history_append: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke_execution: false,
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    cron_launchd_github_actions_creation: false,
    git_add_commit_push: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    started_auto_runner04x: false
  };
}

export function decideAutoRunnerManualWorkflowProposal(input: { sourcePresent: boolean; stages: readonly WorkflowStage[]; gates: readonly GateMatrixRow[] }): AutoRunnerManualWorkflowDecision {
  if (!input.sourcePresent || input.stages.length < 12 || input.gates.length < 9) return "auto_runner_manual_workflow_proposal_not_ready";
  return "auto_runner_manual_workflow_proposal_basis_caution";
}

export function renderInventoryCsv(rows: readonly ScriptInventoryRow[]): string {
  const header = ["script_name", "category", "required_gate", "future_runner_use"];
  return [header.join(","), ...rows.map((row) => header.map((key) => csvCell(String(row[key as keyof ScriptInventoryRow] ?? ""))).join(","))].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerManualWorkflowDecision;
  sourceArtifactPath: string;
  current: CurrentStateSummary;
  inventory: readonly ScriptInventoryRow[];
  stages: readonly WorkflowStage[];
  gates: readonly GateMatrixRow[];
  dryRun: DryRunBehavior;
  failure: FailureHandlingPlan;
  review: readonly string[];
  commandDesign: FutureRunnerCommandDesign;
  risks: readonly string[];
  safety: SafetyConfirmation;
}): string {
  return `# Manual Market Intelligence Workflow Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

AUTO-RUNNER03X designs a future manual workflow runner with all collectors and write actions disabled by default. Collection, append, DB sync, AI context refresh, and pricing CSV generation are separate gated stages.

## 2. Source AUTO-RUNNER02X Result

- Artifact: ${input.sourceArtifactPath}
- Decision: ${input.current.auto_runner02x_decision}

## 3. Current State

${JSON.stringify(input.current, null, 2)}

## 4. Script Inventory Classification

Inventory rows: ${input.inventory.length}

## 5. Manual Workflow Stages

${input.stages.map((stageRow) => `- Stage ${stageRow.stage}: ${stageRow.name} — gate: ${stageRow.gate}`).join("\n")}

## 6. Gate Matrix

${input.gates.map((gateRow) => `- ${gateRow.gate}: ${gateRow.controls}`).join("\n")}

## 7. Dry-Run Behavior

${input.dryRun.behavior.map((item) => `- ${item}`).join("\n")}

## 8. Failure Handling

${input.failure.fail_closed_rules.map((item) => `- ${item}`).join("\n")}

## 9. Human Review Checkpoints

${input.review.map((item) => `- ${item}`).join("\n")}

## 10. Future Runner Command Design

- Proposed script: ${input.commandDesign.proposed_script}
- Proposed npm script: ${input.commandDesign.proposed_npm_script}
- Dry run: ${input.commandDesign.dry_run_command}

## 11. Risks

${input.risks.map((item) => `- ${item}`).join("\n")}

## 12. Safety Confirmation

${JSON.stringify(input.safety, null, 2)}

## 13. Decision

${input.decision}

## 14. Next Phase

AUTO-RUNNER04X — launchd schedule proposal, disabled. Do not start without explicit instruction.
`;
}

function stage(
  stageNumber: number,
  name: string,
  trigger: string,
  commandCandidates: string[],
  inputs: string[],
  outputs: string[],
  gateValue: string,
  successCriteria: string[],
  failureBehavior: string
): WorkflowStage {
  return {
    stage: stageNumber,
    name,
    trigger,
    command_candidates: commandCandidates,
    inputs,
    outputs,
    gate: gateValue,
    success_criteria: successCriteria,
    failure_behavior: failureBehavior
  };
}

function gate(gateValue: string, controls: string, requiredFor: string[]): GateMatrixRow {
  return {
    gate: gateValue,
    default: "disabled",
    controls,
    required_for: requiredFor,
    failure_if_missing: `${gateValue} missing: print planned action and skip safely.`
  };
}

function gateForCategory(scriptName: string, category: ScriptCategory): string {
  if (scriptName.includes("booking") && category === "live_collector") return "COLLECT_BOOKING=1";
  if (scriptName.includes("jalan") && category === "live_collector") return "COLLECT_JALAN=1";
  if (category === "history_append" && scriptName.includes("booking")) return "BOOKING_HISTORY_APPEND=1";
  if (category === "history_append" && scriptName.includes("jalan")) return "JALAN_HISTORY_APPEND=1";
  if (category === "db_sync") return "HISTORY_TO_DB_SYNC=1";
  if (category === "ai_context_refresh") return "BUILD_AI_CONTEXT=1";
  if (category === "pricing_output") return "GENERATE_PRICE_REPORT=1 or GENERATE_PRICE_CSV=1";
  return "none";
}

function futureUseForCategory(category: ScriptCategory): string {
  switch (category) {
    case "safe_validation":
      return "May run in dry-run/preflight.";
    case "read_only_report":
    case "proposal_only":
      return "May run when inputs are local/read-only.";
    case "live_collector":
      return "Future gated collection only.";
    case "history_append":
      return "Future approved write only.";
    case "db_sync":
      return "Future gated DB mirror step only.";
    case "ai_context_refresh":
      return "Future gated context refresh only.";
    case "pricing_output":
      return "Separate pricing gate; never automatic PMS upload.";
    default:
      return "Manual review before runner use.";
  }
}

function csvCell(value: string): string {
  if (!/[",\n]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

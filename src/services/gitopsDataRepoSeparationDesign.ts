// Phase M07X — GitOps & data-repository separation strategy (DESIGN ONLY).
//
// Pure design layer. Produces the model for splitting the project into a dev
// repo (zao-market-intelligence) and a data-only repo
// (zao-market-intelligence-data), a draft GitHub Actions workflow text saved
// ONLY under debug as a disabled file, a secret-NAME model (no values), a
// concurrency/lock plan, a commit/rollback strategy, failure modes, and an
// activation gate that requires a FUTURE explicit approval sentence.
//
// THIS MODULE ENABLES NOTHING. No GitHub Actions activation. No commit. No
// push. No remote repo creation. No data repo creation. No secrets written.
// No .data/history moves or edits. Existing .data/history is READ-ONLY here.

export const DEV_REPO_NAME = "zao-market-intelligence";
export const DATA_REPO_NAME = "zao-market-intelligence-data";

export const SCHEDULE_CRON_UTC = "0 18 * * *"; // 03:00 JST daily (design only — not active)
export const SCHEDULE_DESCRIPTION_JST = "03:00 JST daily";
export const CONCURRENCY_GROUP = "zao-market-intelligence-daily-collection";
export const COMMIT_MESSAGE_TEMPLATE = "data: append market signals YYYY-MM-DD JST";

// Secret NAMES only — never any values.
export const SECRET_NAMES: readonly string[] = ["DATA_REPO_PAT", "DATA_REPO_URL", "DATA_REPO_BRANCH"];

// Draft workflow is design-only and disabled; it lives under debug, NOT under
// .github/workflows, and uses this filename suffix to make that explicit.
export const DRAFT_WORKFLOW_FILENAME = "draft_daily_collection.workflow.yml.disabled";

// The exact future approval sentence required to activate any of this.
export const ACTIVATION_APPROVAL_SENTENCE =
  "Approve GitHub Actions data-repo workflow activation. You may create draft workflow files and configure data repo push.";

// ---------------------------------------------------------------------------
// 6.1 Repo separation model
// ---------------------------------------------------------------------------

export interface RepoSeparationEntry {
  repo: string;
  role: string;
  contains: string[];
  excludes: string[];
}

export function buildRepoSeparationModel(): RepoSeparationEntry[] {
  return [
    {
      repo: DEV_REPO_NAME,
      role: "Development repo — source code, collectors, services, tests, schema, docs. No appended market history data.",
      contains: ["src/", "tests/", "package.json", "tsconfig.json", "schema design code"],
      excludes: [".data/history/zao_signals_YYYY_MM.csv (appended market signals live in the data repo)"]
    },
    {
      repo: DATA_REPO_NAME,
      role: "Data-only repo — appended market-signal history shards, append logs, generated reports, schema snapshot. No application source code.",
      contains: [
        "data/history/zao_signals_YYYY_MM.csv",
        "data/append-logs/",
        "data/reports/",
        "data/schema/"
      ],
      excludes: ["src/ (application source never committed to the data repo)", "tests/"]
    }
  ];
}

// ---------------------------------------------------------------------------
// 6.2 Data repo layout
// ---------------------------------------------------------------------------

export interface DataRepoLayoutEntry {
  path: string;
  purpose: string;
}

export function buildDataRepoLayout(): DataRepoLayoutEntry[] {
  return [
    { path: "data/history/zao_signals_YYYY_MM.csv", purpose: "Monthly market-signal history shards (append-only)." },
    { path: "data/append-logs/append_YYYYMMDD_HHmmss.csv", purpose: "Per-run append action logs (rows written/skipped/conflict per shard)." },
    { path: "data/reports/", purpose: "Generated run reports (markdown/json/csv) copied from a run." },
    { path: "data/schema/zao_local_history_v1.json", purpose: "Schema snapshot (version + column list) for the data repo." }
  ];
}

// ---------------------------------------------------------------------------
// 6.3 GitHub Actions architecture (design only)
// ---------------------------------------------------------------------------

export interface ActionsArchitecture {
  triggers: string[];
  scheduleCronUtc: string;
  scheduleDescriptionJst: string;
  active: boolean;
  jobSteps: string[];
}

export function buildActionsArchitecture(): ActionsArchitecture {
  return {
    triggers: ["schedule", "workflow_dispatch"],
    scheduleCronUtc: SCHEDULE_CRON_UTC,
    scheduleDescriptionJst: SCHEDULE_DESCRIPTION_JST,
    active: false,
    jobSteps: [
      "checkout dev repo",
      "setup node",
      "npm install",
      "npm run typecheck && npm run test",
      "run collectors (real mode) — gated, future phase",
      "build/validate local history append (guarded engine)",
      "checkout data repo using DATA_REPO_URL/DATA_REPO_BRANCH",
      "copy shards/logs/reports into data repo layout",
      "commit only if changed; push to data repo using DATA_REPO_PAT"
    ]
  };
}

// ---------------------------------------------------------------------------
// 6.4 Secret-name model (NO values)
// ---------------------------------------------------------------------------

export interface SecretModelEntry {
  name: string;
  purpose: string;
  placeholder: string; // GitHub Actions secret reference, never a value
}

export function buildSecretModel(): SecretModelEntry[] {
  return [
    { name: "DATA_REPO_PAT", purpose: "Fine-scoped token to push to the data repo only.", placeholder: "${{ secrets.DATA_REPO_PAT }}" },
    { name: "DATA_REPO_URL", purpose: "Data repo clone/push URL.", placeholder: "${{ secrets.DATA_REPO_URL }}" },
    { name: "DATA_REPO_BRANCH", purpose: "Target branch in the data repo.", placeholder: "${{ secrets.DATA_REPO_BRANCH }}" }
  ];
}

// ---------------------------------------------------------------------------
// 6.5 Concurrency / lock plan
// ---------------------------------------------------------------------------

export interface ConcurrencyPlan {
  group: string;
  cancelInProgress: boolean;
  rationale: string;
}

export function buildConcurrencyPlan(): ConcurrencyPlan {
  return {
    group: CONCURRENCY_GROUP,
    cancelInProgress: false,
    rationale:
      "cancel-in-progress=false so an in-flight append/push is never interrupted mid-run; overlapping runs queue instead of racing on the same shard files."
  };
}

// ---------------------------------------------------------------------------
// 6.6 Commit strategy
// ---------------------------------------------------------------------------

export interface CommitStrategy {
  messageTemplate: string;
  commitOnlyIfChanged: boolean;
  changeDetection: string;
  notes: string;
}

export function buildCommitStrategy(): CommitStrategy {
  return {
    messageTemplate: COMMIT_MESSAGE_TEMPLATE,
    commitOnlyIfChanged: true,
    changeDetection: "git status --porcelain on the data repo; skip commit/push when there are no changes.",
    notes: "One commit per run. Append-only; no force-push; no history rewrite."
  };
}

// ---------------------------------------------------------------------------
// 6.7 Rollback plan
// ---------------------------------------------------------------------------

export interface RollbackStep {
  scenario: string;
  action: string;
}

export function buildRollbackPlan(): RollbackStep[] {
  return [
    { scenario: "Bad commit pushed to data repo", action: "git revert the offending commit (no force-push, preserves history)." },
    { scenario: "Corrupted/incorrect shard", action: "Restore the shard from the prior committed version in git history." },
    { scenario: "Audit / re-run", action: "Use data/append-logs/ to reconstruct exactly which rows each run wrote." }
  ];
}

// ---------------------------------------------------------------------------
// 6.8 Cost / free-tier model
// ---------------------------------------------------------------------------

export interface CostModel {
  freeTier: boolean;
  estimate: string;
  notes: string;
}

export function buildCostModel(): CostModel {
  return {
    freeTier: true,
    estimate: "One short daily run on GitHub-hosted runners fits comfortably within the free Actions minutes for a single repo.",
    notes: "No paid runners, no paid data sources, no external paid APIs. Storage is plain CSV text in git."
  };
}

// ---------------------------------------------------------------------------
// 6.9 Failure modes
// ---------------------------------------------------------------------------

export interface FailureMode {
  mode: string;
  handling: string;
}

export function buildFailureModes(): FailureMode[] {
  return [
    { mode: "hash conflict (same row_id, different row_hash)", handling: "Guarded append engine blocks the run; no write; report the conflict for manual review." },
    { mode: "push conflict (data repo moved ahead)", handling: "Fetch/rebase the data repo and retry; never force-push." },
    { mode: "Playwright install failure", handling: "Fail the run before any append; no partial data committed." },
    { mode: "no changed data", handling: "Skip commit/push (commit only if changed); run exits cleanly." },
    { mode: "secret missing/invalid", handling: "Fail fast before checkout of the data repo; no push attempted." }
  ];
}

// ---------------------------------------------------------------------------
// 6.10 Activation gate (future approval required)
// ---------------------------------------------------------------------------

export interface ActivationGate {
  currentlyActive: boolean;
  requiresExplicitApproval: boolean;
  approvalSentence: string;
  blockedActions: string[];
}

export function buildActivationGate(): ActivationGate {
  return {
    currentlyActive: false,
    requiresExplicitApproval: true,
    approvalSentence: ACTIVATION_APPROVAL_SENTENCE,
    blockedActions: [
      "Enabling GitHub Actions scheduled workflow",
      "Creating .github/workflows production workflow files",
      "git commit / git push",
      "Creating the data repo",
      "Configuring/writing secrets",
      "Moving .data/history into the data repo"
    ]
  };
}

// ---------------------------------------------------------------------------
// 7. Draft workflow text (disabled, design only)
// ---------------------------------------------------------------------------

export function renderDraftWorkflowYaml(): string {
  return [
    "# DESIGN ONLY — DISABLED DRAFT. DO NOT PLACE UNDER .github/workflows.",
    "# This file intentionally uses the .yml.disabled suffix and lives under",
    "# .data/debug so GitHub never parses or runs it. Activation requires the",
    "# explicit approval sentence documented in the M07X design report.",
    "#",
    "# Secret references below are PLACEHOLDERS only. No token values appear here.",
    "",
    "name: Daily market signal collection (DRAFT — DISABLED)",
    "",
    "on:",
    "  workflow_dispatch: {}",
    "  schedule:",
    `    - cron: "${SCHEDULE_CRON_UTC}"  # ${SCHEDULE_DESCRIPTION_JST} (design only — not active)`,
    "",
    "concurrency:",
    `  group: ${CONCURRENCY_GROUP}`,
    "  cancel-in-progress: false",
    "",
    "jobs:",
    "  collect-and-append:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Checkout dev repo",
    "        uses: actions/checkout@v4",
    "",
    "      - name: Setup Node",
    "        uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "          cache: npm",
    "",
    "      - name: Install",
    "        run: npm install",
    "",
    "      - name: Typecheck & test",
    "        run: npm run typecheck && npm run test",
    "",
    "      - name: Build & validate local history append (guarded engine)",
    "        run: echo 'placeholder — guarded append engine runs here in a future approved phase'",
    "",
    "      - name: Checkout data repo",
    "        uses: actions/checkout@v4",
    "        with:",
    `          repository: ${DATA_REPO_NAME}`,
    "          token: ${{ secrets.DATA_REPO_PAT }}",
    "          ref: ${{ secrets.DATA_REPO_BRANCH }}",
    "          path: data-repo",
    "",
    "      - name: Copy shards/logs/reports into data repo layout",
    "        run: echo 'placeholder — copy data/history, data/append-logs, data/reports'",
    "",
    "      - name: Commit only if changed",
    "        run: |",
    "          cd data-repo",
    "          if [ -n \"$(git status --porcelain)\" ]; then",
    "            git add -A",
    "            git commit -m \"data: append market signals $(date -u +%Y-%m-%d) JST\"",
    "            git push ${{ secrets.DATA_REPO_URL }} HEAD:${{ secrets.DATA_REPO_BRANCH }}",
    "          else",
    "            echo 'no changes — skipping commit/push'",
    "          fi",
    ""
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 8. Design components (for CSV) + decision
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "medium" | "high";

export interface DesignComponent {
  component: string;
  status: string; // "designed"
  description: string;
  activationRequired: boolean;
  riskLevel: RiskLevel;
  notes: string;
}

export function buildDesignComponents(): DesignComponent[] {
  return [
    { component: "repo_separation", status: "designed", description: "Split into dev repo and data-only repo.", activationRequired: false, riskLevel: "low", notes: "Design only." },
    { component: "data_repo_layout", status: "designed", description: "data/history, append-logs, reports, schema.", activationRequired: false, riskLevel: "low", notes: "Design only." },
    { component: "actions_architecture", status: "designed", description: "schedule 03:00 JST + workflow_dispatch.", activationRequired: true, riskLevel: "high", notes: "Not active." },
    { component: "secret_model", status: "designed", description: "Secret names only: DATA_REPO_PAT/URL/BRANCH.", activationRequired: true, riskLevel: "high", notes: "No values." },
    { component: "concurrency_plan", status: "designed", description: `group=${CONCURRENCY_GROUP}, cancel-in-progress=false.`, activationRequired: false, riskLevel: "low", notes: "Prevents overlap." },
    { component: "commit_strategy", status: "designed", description: "Commit only if changed; append-only.", activationRequired: true, riskLevel: "medium", notes: "No force-push." },
    { component: "rollback_plan", status: "designed", description: "git revert, restore shard, append logs.", activationRequired: false, riskLevel: "low", notes: "Design only." },
    { component: "cost_model", status: "designed", description: "Free-tier Actions; no paid sources.", activationRequired: false, riskLevel: "low", notes: "Design only." },
    { component: "failure_modes", status: "designed", description: "hash conflict, push conflict, install failure, no change.", activationRequired: false, riskLevel: "medium", notes: "Design only." },
    { component: "activation_gate", status: "designed", description: "Future explicit approval sentence required.", activationRequired: true, riskLevel: "high", notes: "Closed." },
    { component: "draft_workflow", status: "designed", description: "Disabled draft under debug, not .github/workflows.", activationRequired: true, riskLevel: "high", notes: ".yml.disabled" }
  ];
}

export type M07XDecision =
  | "gitops_data_repo_design_ready"
  | "gitops_data_repo_design_basis_caution"
  | "gitops_data_repo_design_not_ready";

export function decideM07X(input: {
  componentCount: number;
  expectedComponentCount: number;
  draftWorkflowDisabled: boolean;
  draftUnderDebugNotWorkflows: boolean;
  actionsActive: boolean;
  activationGateClosed: boolean;
  secretValuesAbsent: boolean;
  m06xArtifactPresent: boolean;
}): M07XDecision {
  if (
    input.componentCount !== input.expectedComponentCount ||
    !input.draftWorkflowDisabled ||
    !input.draftUnderDebugNotWorkflows ||
    input.actionsActive ||
    !input.activationGateClosed ||
    !input.secretValuesAbsent
  ) {
    return "gitops_data_repo_design_not_ready";
  }
  if (!input.m06xArtifactPresent) {
    return "gitops_data_repo_design_basis_caution";
  }
  return "gitops_data_repo_design_ready";
}

// ---------------------------------------------------------------------------
// CSV rendering
// ---------------------------------------------------------------------------

export const DESIGN_COMPONENT_CSV_HEADERS = [
  "component",
  "status",
  "description",
  "activation_required",
  "risk_level",
  "notes"
] as const;

export function renderDesignComponentCsv(components: DesignComponent[]): string {
  const body = components.map((c) =>
    [c.component, c.status, c.description, String(c.activationRequired), c.riskLevel, c.notes].map(csvEscape).join(",")
  );
  return [DESIGN_COMPONENT_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export interface DesignReportInput {
  designId: string;
  generatedAtJst: string;
  decision: M07XDecision;
  m06xArtifact: string;
  historyDirExists: boolean;
  historyFiles: string[];
  repoSeparation: RepoSeparationEntry[];
  dataRepoLayout: DataRepoLayoutEntry[];
  actions: ActionsArchitecture;
  secretModel: SecretModelEntry[];
  concurrency: ConcurrencyPlan;
  commitStrategy: CommitStrategy;
  rollback: RollbackStep[];
  costModel: CostModel;
  failureModes: FailureMode[];
  activationGate: ActivationGate;
  draftWorkflowPath: string;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function renderDesignReport(input: DesignReportInput): string {
  return [
    "# GitOps & Data-Repo Separation DESIGN (Phase M07X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Design ID: ${input.designId}`,
    "",
    "## 1. Policy & safety",
    "",
    "- DESIGN ONLY: M07X enables nothing. No GitHub Actions activation.",
    "- No git commit, no git push, no remote repo creation, no data repo creation.",
    "- No secrets written; no token values in any artifact (placeholders only).",
    "- No .data/history move or edit; existing .data/history is READ-ONLY here.",
    "- The draft workflow is DISABLED and saved under debug, NOT under .github/workflows.",
    "- No paid runners, no paid data sources, no base × 1.1 logic.",
    "",
    "## 2. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 3. Source artifact (M06X real append)",
    "",
    `- m06x_artifact=${input.m06xArtifact}`,
    `- history_dir_exists=${input.historyDirExists}`,
    `- history_files=${JSON.stringify(input.historyFiles)}`,
    "",
    "## 4. Repo separation model",
    "",
    "| repo | role |",
    "|---|---|",
    ...input.repoSeparation.map((r) => `| ${r.repo} | ${r.role} |`),
    "",
    ...input.repoSeparation.flatMap((r) => [
      `### ${r.repo}`,
      `- contains: ${JSON.stringify(r.contains)}`,
      `- excludes: ${JSON.stringify(r.excludes)}`,
      ""
    ]),
    "## 5. Data repo layout",
    "",
    "| path | purpose |",
    "|---|---|",
    ...input.dataRepoLayout.map((e) => `| ${e.path} | ${e.purpose} |`),
    "",
    "## 6. GitHub Actions architecture (design only — NOT active)",
    "",
    `- triggers=${JSON.stringify(input.actions.triggers)}`,
    `- schedule_cron_utc=${input.actions.scheduleCronUtc} (${input.actions.scheduleDescriptionJst})`,
    `- active=${input.actions.active}`,
    "- job steps:",
    ...input.actions.jobSteps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    "## 7. Secret-name model (NO values)",
    "",
    "| name | purpose | placeholder |",
    "|---|---|---|",
    ...input.secretModel.map((s) => `| ${s.name} | ${s.purpose} | \`${s.placeholder}\` |`),
    "",
    "## 8. Concurrency / lock plan",
    "",
    `- group=${input.concurrency.group}`,
    `- cancel_in_progress=${input.concurrency.cancelInProgress}`,
    `- rationale: ${input.concurrency.rationale}`,
    "",
    "## 9. Commit strategy",
    "",
    `- message_template=${input.commitStrategy.messageTemplate}`,
    `- commit_only_if_changed=${input.commitStrategy.commitOnlyIfChanged}`,
    `- change_detection: ${input.commitStrategy.changeDetection}`,
    `- notes: ${input.commitStrategy.notes}`,
    "",
    "## 10. Rollback plan",
    "",
    ...input.rollback.map((r) => `- ${r.scenario}: ${r.action}`),
    "",
    "## 11. Cost / free-tier model",
    "",
    `- free_tier=${input.costModel.freeTier}`,
    `- estimate: ${input.costModel.estimate}`,
    `- notes: ${input.costModel.notes}`,
    "",
    "## 12. Failure modes",
    "",
    ...input.failureModes.map((f) => `- ${f.mode}: ${f.handling}`),
    "",
    "## 13. Activation gate (future approval required)",
    "",
    `- currently_active=${input.activationGate.currentlyActive}`,
    `- requires_explicit_approval=${input.activationGate.requiresExplicitApproval}`,
    "- To activate, a FUTURE message must contain exactly:",
    "```",
    input.activationGate.approvalSentence,
    "```",
    `- blocked_until_then=${JSON.stringify(input.activationGate.blockedActions)}`,
    "",
    "## 14. Draft workflow (disabled, design only)",
    "",
    `- draft_workflow_path=${input.draftWorkflowPath}`,
    "- NOTE: saved under .data/debug with the .yml.disabled suffix; NOT under .github/workflows; GitHub will never parse or run it.",
    "",
    "## 15. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 16. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: M07XDecision): string {
  if (decision === "gitops_data_repo_design_ready") {
    return `- Design is complete and nothing is activated. To proceed to activation in a future phase, a separate explicit approval is required: "${ACTIVATION_APPROVAL_SENTENCE}". Until then, do not enable Actions, do not commit/push, do not create the data repo, and do not move .data/history.`;
  }
  if (decision === "gitops_data_repo_design_basis_caution") {
    return "- Design generated, but the M06X source artifact was not found. Re-confirm the M06X real-append artifact before relying on this design. Do not activate anything.";
  }
  return "- Design preconditions failed (missing components, draft not disabled/misplaced, Actions marked active, gate not closed, or secret values present). Fix the design generator before proceeding. Do not activate anything.";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

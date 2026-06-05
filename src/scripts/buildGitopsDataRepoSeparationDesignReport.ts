// Phase M07X — build the GitOps & data-repo separation DESIGN report.
//
// Reads the latest M06X real-append artifact (read-only), assembles the design
// model, writes a report/CSV/JSON under reports + debug artifacts, and saves the
// DISABLED draft workflow ONLY under the debug directory (never the active
// workflows directory).
//
// Enables nothing: no Actions activation, no version-control commits or pushes,
// no data repo, no secrets, no .data/history move/edit. .data/history is
// READ-ONLY here.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertNotRealHistoryPath } from "../services/localHistoryAppendDryRun";
import {
  ACTIVATION_APPROVAL_SENTENCE,
  DRAFT_WORKFLOW_FILENAME,
  buildActionsArchitecture,
  buildActivationGate,
  buildCommitStrategy,
  buildConcurrencyPlan,
  buildCostModel,
  buildDataRepoLayout,
  buildDesignComponents,
  buildFailureModes,
  buildRepoSeparationModel,
  buildRollbackPlan,
  buildSecretModel,
  decideM07X,
  renderDesignComponentCsv,
  renderDesignReport,
  renderDraftWorkflowYaml,
  type DesignReportInput
} from "../services/gitopsDataRepoSeparationDesign";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/gitops-data-repo-design";
const HISTORY_DIR = ".data/history";
const M06X_REPORT_PREFIX = "local_history_real_append_";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function nowJst(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function resolveLatestM06X(): string {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing artifact directory: ${reportDir}. Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  // Exclude the proposal artifacts (local_history_real_append_proposal_*).
  const jsonFiles = entries
    .filter((n) => n.startsWith(M06X_REPORT_PREFIX) && n.endsWith(".json") && !n.startsWith(`${M06X_REPORT_PREFIX}proposal_`))
    .sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(`Missing M06X artifact (expected ${M06X_REPORT_PREFIX}*.json in ${reportDir}). Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  return resolve(reportDir, latest);
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  // Safety: capture .data/history state; it must not change (read-only).
  const historyDir = resolve(HISTORY_DIR);
  const historyExistedBefore = existsSync(historyDir);
  const historyBefore = historyExistedBefore ? readdirSync(historyDir) : [];

  const ts = timestamp();
  const designId = `gitops_data_repo_design_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  // ---- Source artifact (M06X), read-only ----
  let m06xArtifact = "";
  let m06xArtifactPresent = false;
  try {
    m06xArtifact = resolveLatestM06X();
    JSON.parse(readFileSync(m06xArtifact, "utf8")); // validate readable JSON
    m06xArtifactPresent = true;
  } catch {
    m06xArtifactPresent = false;
  }

  // ---- Design model ----
  const repoSeparation = buildRepoSeparationModel();
  const dataRepoLayout = buildDataRepoLayout();
  const actions = buildActionsArchitecture();
  const secretModel = buildSecretModel();
  const concurrency = buildConcurrencyPlan();
  const commitStrategy = buildCommitStrategy();
  const rollback = buildRollbackPlan();
  const costModel = buildCostModel();
  const failureModes = buildFailureModes();
  const activationGate = buildActivationGate();
  const components = buildDesignComponents();
  const draftWorkflowYaml = renderDraftWorkflowYaml();

  const draftWorkflowPath = resolve(debugRootPath, DRAFT_WORKFLOW_FILENAME);

  // ---- Decision ----
  const secretValuesAbsent = !secretModel.some((s) => s.placeholder.includes("ghp_") || /=/.test(s.placeholder.replace("${{", "")));
  const decision = decideM07X({
    componentCount: components.length,
    expectedComponentCount: 11,
    draftWorkflowDisabled: DRAFT_WORKFLOW_FILENAME.endsWith(".yml.disabled"),
    draftUnderDebugNotWorkflows: draftWorkflowPath.includes(".data/debug") && draftWorkflowPath.endsWith(".yml.disabled"),
    actionsActive: actions.active,
    activationGateClosed: !activationGate.currentlyActive && activationGate.requiresExplicitApproval,
    secretValuesAbsent,
    m06xArtifactPresent
  });

  // ---- Output (report/CSV/JSON + debug); guarded against .data/history ----
  const reportDir = resolve(REPORT_DIR);
  assertNotRealHistoryPath(debugRootPath);
  assertNotRealHistoryPath(draftWorkflowPath);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `gitops_data_repo_design_${ts}.md`);
  const csvPath = resolve(reportDir, `gitops_data_repo_design_${ts}.csv`);
  const jsonPath = resolve(reportDir, `gitops_data_repo_design_${ts}.json`);

  const reportInput: DesignReportInput = {
    designId,
    generatedAtJst: nowJst(),
    decision,
    m06xArtifact,
    historyDirExists: historyExistedBefore,
    historyFiles: historyBefore.filter((n) => n.endsWith(".csv")),
    repoSeparation,
    dataRepoLayout,
    actions,
    secretModel,
    concurrency,
    commitStrategy,
    rollback,
    costModel,
    failureModes,
    activationGate,
    draftWorkflowPath,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  writeFileSync(csvPath, renderDesignComponentCsv(components), "utf8");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        designId,
        generatedAtJst: reportInput.generatedAtJst,
        decision,
        m06xArtifact,
        m06xArtifactPresent,
        activationApprovalSentence: ACTIVATION_APPROVAL_SENTENCE,
        actionsActive: actions.active,
        draftWorkflowPath,
        draftWorkflowUnderDebug: draftWorkflowPath.includes(".data/debug"),
        draftWorkflowDisabledSuffix: draftWorkflowPath.endsWith(".yml.disabled"),
        repoSeparation,
        dataRepoLayout,
        actions,
        secretModel,
        concurrency,
        commitStrategy,
        rollback,
        costModel,
        failureModes,
        activationGate,
        components,
        historyDirExists: historyExistedBefore,
        historyFiles: reportInput.historyFiles
      },
      null,
      2
    ),
    "utf8"
  );
  writeFileSync(reportPath, renderDesignReport(reportInput), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    const target = resolve(debugRootPath, name);
    assertNotRealHistoryPath(target);
    writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_m06x_artifact.json", { m06xArtifact, m06xArtifactPresent });
  writeDebug("current_history_state.json", { exists: historyExistedBefore, files: historyBefore });
  writeDebug("proposed_data_repo_layout.json", { repoSeparation, dataRepoLayout });
  writeDebug("draft_workflow_plan.json", actions);
  writeDebug("secret_model.json", secretModel);
  writeDebug("concurrency_plan.json", concurrency);
  writeDebug("rollback_plan.json", rollback);
  writeDebug("activation_gate.json", activationGate);
  writeDebug("validation_summary.json", { decision, componentCount: components.length, secretValuesAbsent, actionsActive: actions.active });

  // The disabled draft workflow text (guarded; under the debug dir, never the active workflows dir).
  writeFileSync(draftWorkflowPath, draftWorkflowYaml, "utf8");

  // Safety: confirm .data/history did not change.
  const historyAfter = existsSync(historyDir) ? readdirSync(historyDir) : [];
  if (historyExistedBefore !== existsSync(historyDir) || historyAfter.length !== historyBefore.length) {
    throw new Error(
      `Safety violation: ${HISTORY_DIR} changed during M07X (existedBefore=${historyExistedBefore}, before=${historyBefore.length}, after=${historyAfter.length}). M07X is design-only and must not touch real history.`
    );
  }

  return { reportPath, csvPath, jsonPath, debugRootPath, decision };
}

try {
  const result = build();
  console.log(`report_path=${result.reportPath}`);
  console.log(`design_component_csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

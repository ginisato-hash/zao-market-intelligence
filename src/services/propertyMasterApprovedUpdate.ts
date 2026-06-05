// Phase D04X — Approved Property Master Update (excluded-audit append only).
//
// Pure logic for the ONE approved, narrowly-scoped master update: append two
// audit rows (mark_out_of_scope + mark_duplicate) to the existing excluded
// audit CSV. Every safety decision (approval gate, preflight, dedup, validate,
// decision) lives here as pure functions; only the runner performs file I/O.
//
// HARD SCOPE: this module can ONLY ever describe appends to the excluded audit
// CSV. It contains NO code that writes the DB, adds properties, adds aliases,
// promotes active status, adds price-collection targets, enables GitHub
// Actions/GitOps, commits/pushes, touches .data/history, or contacts paid
// sources. The append is gated on explicit human approval AND a runtime env
// flag; absent either, the update is fail-closed.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The ONLY artifact this phase may modify.
export const TARGET_EXCLUDED_AUDIT_RELPATH =
  ".data/exports/zao-universe-review/zao_excluded_audit_20260531_231933.csv";

// The exact, exhaustive set of approved proposal rows. Nothing else may be applied.
export interface ApprovedProposalRow {
  detectedName: string;
  proposedUpdateAction: "mark_out_of_scope" | "mark_duplicate";
  targetRecordKey: string;
}

export const APPROVED_PROPOSAL_ROWS: readonly ApprovedProposalRow[] = [
  {
    detectedName: "蔵王温泉とは",
    proposedUpdateAction: "mark_out_of_scope",
    targetRecordKey: "https://zaomountainresort.com/about/"
  },
  {
    detectedName: "蔵王温泉について",
    proposedUpdateAction: "mark_duplicate",
    targetRecordKey: "https://zaomountainresort.com/about/"
  }
] as const;

// Existing excluded-audit schema (must be preserved exactly).
export const EXCLUDED_AUDIT_HEADERS = [
  "source",
  "property_name_raw",
  "property_url",
  "source_property_id",
  "exclusion_reason",
  "evidence_note",
  "human_review_required",
  "review_decision",
  "reviewer_note"
] as const;

export const D04X_FORBIDDEN_COLUMN_TOKENS = ["beds24", "airhost", "pms_", "channel_manager", "ota_upload"] as const;

export type D04XUpdateDecision =
  | "property_master_update_ready_not_run"
  | "property_master_update_success"
  | "property_master_update_failed_preflight"
  | "property_master_update_failed_rolled_back"
  | "property_master_update_failed_manual_recovery_required";

export type AuditRow = Record<string, string>;

// ---------------------------------------------------------------------------
// Approval gate (explicit approval AND runtime env flag both required)
// ---------------------------------------------------------------------------

export interface ApprovalGateResult {
  explicitUserApproved: boolean;
  envFlagPresent: boolean;
  realUpdateAllowed: boolean;
  reason: string;
}

export function evaluateApprovalGate(input: {
  explicitUserApproved: boolean;
  envFlag: string | undefined;
}): ApprovalGateResult {
  const envFlagPresent = input.envFlag === "1";
  const realUpdateAllowed = input.explicitUserApproved && envFlagPresent;
  const reason = realUpdateAllowed
    ? "Explicit user approval AND PROPERTY_MASTER_UPDATE=1 both present."
    : !input.explicitUserApproved
      ? "Explicit user approval missing; fail-closed."
      : "PROPERTY_MASTER_UPDATE=1 env flag missing; fail-closed.";
  return { explicitUserApproved: input.explicitUserApproved, envFlagPresent, realUpdateAllowed, reason };
}

// ---------------------------------------------------------------------------
// Preflight: proposal must match exactly the two approved rows
// ---------------------------------------------------------------------------

export interface PreflightProposalRow {
  detectedName: string;
  proposedUpdateAction: string;
  targetMasterArtifact: string;
  targetRecordKey: string;
  requiresExplicitApproval: boolean;
}

export function preflightProposal(rows: PreflightProposalRow[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const allowedActions = new Set(["mark_out_of_scope", "mark_duplicate"]);

  if (rows.length !== 2) errors.push(`Expected exactly 2 approved proposal rows, got ${rows.length}.`);

  for (const r of rows) {
    if (r.proposedUpdateAction === "add_new_property") {
      errors.push(`Blocked: add_new_property is not approved (row "${r.detectedName}").`);
    }
    if (r.proposedUpdateAction === "add_alias") {
      errors.push(`Blocked: add_alias is not approved (row "${r.detectedName}").`);
    }
    if (!allowedActions.has(r.proposedUpdateAction)) {
      errors.push(`Unexpected proposed action "${r.proposedUpdateAction}" for "${r.detectedName}".`);
    }
    if (!r.targetMasterArtifact.includes("zao_excluded_audit_20260531_231933.csv")) {
      errors.push(`Target artifact mismatch for "${r.detectedName}": ${r.targetMasterArtifact}.`);
    }
    if (!r.requiresExplicitApproval) {
      errors.push(`Row "${r.detectedName}" is not flagged requires_explicit_approval.`);
    }
  }

  for (const approved of APPROVED_PROPOSAL_ROWS) {
    const match = rows.find(
      (r) =>
        r.detectedName === approved.detectedName &&
        r.proposedUpdateAction === approved.proposedUpdateAction &&
        r.targetRecordKey === approved.targetRecordKey
    );
    if (!match) {
      errors.push(`Approved row missing from proposal: "${approved.detectedName}" / ${approved.proposedUpdateAction}.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Map approved proposal → excluded-audit row (existing schema)
// ---------------------------------------------------------------------------

export function mapProposalToAuditRow(row: { detectedName: string; proposedUpdateAction: string; targetRecordKey: string }): AuditRow {
  const isOutOfScope = row.proposedUpdateAction === "mark_out_of_scope";
  return {
    source: "zao_official_stay",
    property_name_raw: row.detectedName,
    property_url: row.targetRecordKey,
    source_property_id: "",
    exclusion_reason: isOutOfScope ? "out_of_scope" : "duplicate",
    evidence_note: isOutOfScope
      ? "D04X approved mark_out_of_scope: generic informational page/title misdetected as lodging property. source_phase=D04X; approved_by_user=true"
      : "D04X approved mark_duplicate: duplicate of generic informational /about/ page detected under multiple names. source_phase=D04X; approved_by_user=true",
    human_review_required: "false",
    review_decision: isOutOfScope ? "excluded_out_of_scope" : "excluded_duplicate",
    reviewer_note: "Approved by user in Phase D04X."
  };
}

export function auditRowKey(row: AuditRow): string {
  return [row["property_name_raw"] ?? "", row["property_url"] ?? "", row["exclusion_reason"] ?? ""].join("|");
}

// ---------------------------------------------------------------------------
// Append (idempotent: skip rows already present)
// ---------------------------------------------------------------------------

export interface AppendResult {
  merged: AuditRow[];
  appended: AuditRow[];
  skippedExisting: AuditRow[];
}

export function appendAuditRows(input: { existingRows: AuditRow[]; newRows: AuditRow[] }): AppendResult {
  const seen = new Set(input.existingRows.map(auditRowKey));
  const appended: AuditRow[] = [];
  const skippedExisting: AuditRow[] = [];
  for (const row of input.newRows) {
    const key = auditRowKey(row);
    if (seen.has(key)) {
      skippedExisting.push(row);
    } else {
      appended.push(row);
      seen.add(key);
    }
  }
  return { merged: [...input.existingRows, ...appended], appended, skippedExisting };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateAuditCsv(input: { headers: string[]; rows: AuditRow[] }): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (input.headers.join(",") !== [...EXCLUDED_AUDIT_HEADERS].join(",")) {
    errors.push("Header mismatch: excluded-audit schema must be preserved exactly.");
  }
  for (const token of D04X_FORBIDDEN_COLUMN_TOKENS) {
    if (input.headers.join(",").toLowerCase().includes(token)) errors.push(`Forbidden column token present: ${token}.`);
  }
  for (const [i, row] of input.rows.entries()) {
    for (const h of input.headers) {
      if (!(h in row)) errors.push(`Row ${i} missing column "${h}".`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideD04X(input: {
  realUpdateAllowed: boolean;
  preflightOk: boolean;
  wrote: boolean;
  appended: number;
  skippedExisting: number;
  rolledBack: boolean;
  rollbackFailed: boolean;
}): D04XUpdateDecision {
  if (input.rollbackFailed) return "property_master_update_failed_manual_recovery_required";
  if (input.rolledBack) return "property_master_update_failed_rolled_back";
  if (!input.realUpdateAllowed) return "property_master_update_ready_not_run";
  if (!input.preflightOk) return "property_master_update_failed_preflight";
  if (input.wrote || input.appended + input.skippedExisting === APPROVED_PROPOSAL_ROWS.length) {
    return "property_master_update_success";
  }
  return "property_master_update_ready_not_run";
}

export function backupPathFor(timestamp: string): string {
  return `.data/exports/zao-universe-review/.backup/${timestamp}/zao_excluded_audit_20260531_231933.csv.bak`;
}

// ---------------------------------------------------------------------------
// CSV parse / render (quote-aware, header order preserved)
// ---------------------------------------------------------------------------

export function parseCsv(csv: string): { headers: string[]; rows: AuditRow[] } {
  const matrix = parseCsvRows(csv);
  const headers = matrix.shift() ?? [];
  const rows = matrix
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));
  return { headers, rows };
}

export function renderCsv(headers: string[], rows: AuditRow[]): string {
  const body = rows.map((row) => headers.map((h) => csvEscape(row[h] ?? "")).join(","));
  return [headers.join(","), ...body].join("\n") + "\n";
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    const next = csv[i + 1];
    if (inQuotes && ch === "\"" && next === "\"") {
      cell += "\"";
      i++;
    } else if (ch === "\"") {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export interface ApprovedUpdateSummary {
  runId: string;
  generatedAt: string;
  sourceD04xProposalArtifact: string;
  targetArtifact: string;
  decision: D04XUpdateDecision;
  realUpdateAllowed: boolean;
  explicitUserApproved: boolean;
  envFlagPresent: boolean;
  preflightOk: boolean;
  preflightErrors: string[];
  rowsBefore: number;
  rowsAfter: number;
  rowsAppended: number;
  rowsSkippedExisting: number;
  backupPath: string;
  backupCreated: boolean;
  validationOk: boolean;
  rolledBack: boolean;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function renderApprovedUpdateReport(input: { summary: ApprovedUpdateSummary; appended: AuditRow[]; skippedExisting: AuditRow[] }): string {
  const { summary, appended, skippedExisting } = input;
  const rowLine = (r: AuditRow): string =>
    `- ${r["property_name_raw"]} | ${r["exclusion_reason"]} | ${r["property_url"]} | review_decision=${r["review_decision"]}`;
  return [
    "# Approved Property Master Update (Phase D04X)",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${summary.decision}`,
    `- source_d04x_proposal_artifact=${summary.sourceD04xProposalArtifact}`,
    `- target_artifact=${summary.targetArtifact}`,
    `- real_update_allowed=${summary.realUpdateAllowed}`,
    `- explicit_user_approved=${summary.explicitUserApproved}`,
    `- env_flag_present=${summary.envFlagPresent}`,
    "",
    "## 2. Approval gate",
    "",
    `- explicit_user_approved=${summary.explicitUserApproved}`,
    `- PROPERTY_MASTER_UPDATE=1 present=${summary.envFlagPresent}`,
    `- real_update_allowed=${summary.realUpdateAllowed}`,
    "",
    "## 3. Preflight",
    "",
    `- preflight_ok=${summary.preflightOk}`,
    summary.preflightErrors.length > 0 ? summary.preflightErrors.map((e) => `  - ${e}`).join("\n") : "  - (no preflight errors)",
    "",
    "## 4. Rows appended",
    "",
    ...(appended.length === 0 ? ["- none"] : appended.map(rowLine)),
    "",
    "## 5. Rows skipped (already present)",
    "",
    ...(skippedExisting.length === 0 ? ["- none"] : skippedExisting.map(rowLine)),
    "",
    "## 6. Row counts",
    "",
    `- rows_before=${summary.rowsBefore}`,
    `- rows_after=${summary.rowsAfter}`,
    `- rows_appended=${summary.rowsAppended}`,
    `- rows_skipped_existing=${summary.rowsSkippedExisting}`,
    "",
    "## 7. Backup + validation + rollback",
    "",
    `- backup_path=${summary.backupPath}`,
    `- backup_created=${summary.backupCreated}`,
    `- validation_ok=${summary.validationOk}`,
    `- rolled_back=${summary.rolledBack}`,
    "",
    "## 8. Safety confirmation",
    "",
    "- D04X modified ONLY the excluded audit artifact.",
    "- D04X did not create new properties.",
    "- D04X did not add aliases.",
    "- D04X did not active-promote any property.",
    "- D04X did not add price collection targets.",
    "- D04X did not write DB.",
    "- D04X did not modify .data/history.",
    "- No GitHub Actions/GitOps activation, no version-control commits or pushes, no paid sources.",
    "",
    "## 9. Output paths",
    "",
    `- report_path=${summary.reportPath}`,
    `- csv_path=${summary.csvPath}`,
    `- json_summary_path=${summary.jsonPath}`,
    `- debug_artifact_path=${summary.debugRootPath}`,
    "",
    "## 10. Next steps",
    "",
    "- Proceed to Phase D05X (read-only regression) to confirm the approved exclusions/duplicates no longer surface as actionable new candidates.",
    ""
  ].join("\n");
}

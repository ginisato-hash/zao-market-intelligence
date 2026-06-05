// Phase M04X — History append validation & conflict policy hardening.
//
// Hardens the safety/validation layer that must run BEFORE any future real
// write to .data/history. Provides:
//   - schema migration guard (schema drift / forbidden / deprecated columns)
//   - conflict policy (idempotent / hash / schema / invalid / forbidden)
//   - shard integrity policy (validate M03X dry-run shard files)
//   - append lock strategy (documented only; never creates the lock file)
//   - real-run switch guard (refuses real-run unless every gate is satisfied)
//   - history path guard (blocks .data/history targets when not real-run)
//
// NO real .data/history writes. NO DB writes. NO GitHub Actions. NO GitOps.
// In M04X the real-run switch is intentionally disabled.

import {
  FORBIDDEN_COLUMNS,
  HISTORY_CSV_HEADERS,
  HISTORY_SCHEMA_VERSION,
  shardMonthFromCheckin,
  validateHistoryRow,
  type HistoryRow
} from "./localHistorySchemaDesign";
import { isRealHistoryPath } from "./localHistoryAppendDryRun";

export { isRealHistoryPath };

// Deprecated Booking B03X columns (a strict subset of FORBIDDEN_COLUMNS).
export const DEPRECATED_BOOKING_COLUMNS: readonly string[] = [
  "tax_multiplier",
  "tax_included_price",
  "tax_normalization_rule"
];

// Beds24/AirHost/PMS columns that must never appear.
export const PMS_FORBIDDEN_COLUMNS: readonly string[] = [
  "roomid",
  "inventory",
  "minstay",
  "maxstay",
  "multiplier",
  "price1",
  "price2",
  "price3",
  "price4",
  "price5",
  "beds24",
  "airhost",
  "pms"
];

// ---------------------------------------------------------------------------
// 6.1 Schema migration guard
// ---------------------------------------------------------------------------

export interface SchemaGuardResult {
  schemaVersion: string;
  schemaVersionValid: boolean;
  columnCount: number;
  columnCountValid: boolean;
  columnOrderValid: boolean;
  missingColumns: string[];
  extraColumns: string[];
  deprecatedColumns: string[];
  forbiddenColumns: string[];
  errors: string[];
  schemaValid: boolean;
}

export function validateSchemaMigrationGuard(columns: string[], schemaVersion: string): SchemaGuardResult {
  const errors: string[] = [];
  const lower = columns.map((c) => c.toLowerCase());

  const schemaVersionValid = schemaVersion === HISTORY_SCHEMA_VERSION;
  if (!schemaVersionValid) errors.push(`schema_version_mismatch:${schemaVersion}`);

  const columnCountValid = columns.length === HISTORY_CSV_HEADERS.length;
  if (!columnCountValid) errors.push(`column_count:${columns.length}!=${HISTORY_CSV_HEADERS.length}`);

  const columnOrderValid =
    columns.length === HISTORY_CSV_HEADERS.length &&
    HISTORY_CSV_HEADERS.every((col, idx) => columns[idx] === col);
  if (!columnOrderValid && columnCountValid) errors.push("column_order_mismatch");

  const missingColumns = HISTORY_CSV_HEADERS.filter((col) => !columns.includes(col));
  for (const col of missingColumns) errors.push(`missing_column:${col}`);

  const allowed = new Set<string>(HISTORY_CSV_HEADERS);
  const extraColumns = columns.filter((col) => !allowed.has(col));
  for (const col of extraColumns) errors.push(`extra_column:${col}`);

  const deprecatedColumns = DEPRECATED_BOOKING_COLUMNS.filter((dep) => lower.some((c) => c === dep || c.includes(dep)));
  for (const col of deprecatedColumns) errors.push(`deprecated_column:${col}`);

  const forbiddenColumns = PMS_FORBIDDEN_COLUMNS.filter((f) => lower.some((c) => c === f || c.includes(f)));
  for (const col of forbiddenColumns) errors.push(`forbidden_column:${col}`);

  const schemaValid =
    schemaVersionValid &&
    columnCountValid &&
    columnOrderValid &&
    missingColumns.length === 0 &&
    extraColumns.length === 0 &&
    deprecatedColumns.length === 0 &&
    forbiddenColumns.length === 0;

  return {
    schemaVersion,
    schemaVersionValid,
    columnCount: columns.length,
    columnCountValid,
    columnOrderValid,
    missingColumns,
    extraColumns,
    deprecatedColumns,
    forbiddenColumns,
    errors,
    schemaValid
  };
}

// ---------------------------------------------------------------------------
// 6.2 Conflict policy
// ---------------------------------------------------------------------------

export type ConflictType =
  | "idempotent_duplicate"
  | "hash_conflict"
  | "schema_conflict"
  | "invalid_row"
  | "forbidden_column_conflict";

export const CONFLICT_DEFINITIONS: { type: ConflictType; blocksAppend: boolean; description: string }[] = [
  { type: "idempotent_duplicate", blocksAppend: false, description: "same row_id + same row_hash; safe to skip" },
  { type: "hash_conflict", blocksAppend: true, description: "same row_id + different row_hash; block append" },
  { type: "schema_conflict", blocksAppend: true, description: "schema_version or column mismatch; block append" },
  { type: "invalid_row", blocksAppend: true, description: "validation failure on required fields; block append" },
  { type: "forbidden_column_conflict", blocksAppend: true, description: "forbidden/deprecated column present; block append" }
];

export function conflictBlocksAppend(type: ConflictType): boolean {
  return type !== "idempotent_duplicate";
}

// Per-row-pair hash relation against what already lives in a shard.
export type HashRelation = "new" | "idempotent_duplicate" | "hash_conflict";

export function classifyHashRelation(existingHash: string | undefined, incomingHash: string): HashRelation {
  if (existingHash === undefined) return "new";
  if (existingHash === incomingHash) return "idempotent_duplicate";
  return "hash_conflict";
}

export interface ConflictPolicyResult {
  definitions: { type: ConflictType; blocksAppend: boolean; description: string }[];
  idempotentDuplicateCount: number;
  hashConflictCount: number;
  schemaConflict: boolean;
  invalidRowCount: number;
  forbiddenColumnConflictCount: number;
  blockingConflictTypes: ConflictType[];
  appendBlocked: boolean;
}

export function evaluateConflictPolicy(input: {
  idempotentDuplicateCount: number;
  hashConflictCount: number;
  schemaValid: boolean;
  invalidRowCount: number;
  forbiddenColumnErrors: number;
}): ConflictPolicyResult {
  const blocking: ConflictType[] = [];
  if (input.hashConflictCount > 0) blocking.push("hash_conflict");
  if (!input.schemaValid) blocking.push("schema_conflict");
  if (input.invalidRowCount > 0) blocking.push("invalid_row");
  if (input.forbiddenColumnErrors > 0) blocking.push("forbidden_column_conflict");
  return {
    definitions: CONFLICT_DEFINITIONS,
    idempotentDuplicateCount: input.idempotentDuplicateCount,
    hashConflictCount: input.hashConflictCount,
    schemaConflict: !input.schemaValid,
    invalidRowCount: input.invalidRowCount,
    forbiddenColumnConflictCount: input.forbiddenColumnErrors,
    blockingConflictTypes: blocking,
    appendBlocked: blocking.length > 0
  };
}

// ---------------------------------------------------------------------------
// CSV parsing + HistoryRow reconstruction (for shard integrity)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toNumOrNull(value: string): number | null {
  return value === "" ? null : Number(value);
}

function toStrOrNull(value: string): string | null {
  return value === "" ? null : value;
}

export function historyRowFromCsvRecord(values: string[]): HistoryRow {
  const g = (i: number): string => values[i] ?? "";
  const b = (i: number): boolean => g(i) === "true";
  return {
    rowId: g(0),
    rowHash: g(1),
    shardMonth: g(2),
    collectedDateJst: g(3),
    collectedAtJst: g(4),
    normalizedAtJst: g(5),
    source: g(6),
    sourcePhase: g(7),
    collectorStage: g(8),
    canonicalPropertyName: g(9),
    sourcePropertyName: g(10),
    propertyIdentityMatch: b(11),
    sourcePropertyId: g(12),
    sourceSlugOrCode: g(13),
    checkin: g(14),
    checkout: g(15),
    stayNights: Number(g(16)),
    groupAdults: Number(g(17)),
    noRooms: Number(g(18)),
    groupChildren: Number(g(19)),
    currency: g(20),
    language: g(21),
    stayScope: g(22),
    availabilityStatus: g(23),
    soldOutStatus: g(24),
    normalizedTotalPrice: toNumOrNull(g(25)),
    normalizedTotalPriceSource: toStrOrNull(g(26)),
    normalizedTotalPriceBasis: g(27),
    normalizedTotalPriceConfidence: g(28),
    basisConfidence: g(29),
    basisNote: g(30),
    sourcePrimaryPrice: toNumOrNull(g(31)),
    sourceSecondaryPriceOrAdder: toNumOrNull(g(32)),
    sourceComputedTotal: toNumOrNull(g(33)),
    sourceTaxOrFeeClassification: g(34),
    sourceClassification: g(35),
    isPriceUsableForDpDirect: b(36),
    isPriceUsableForDpDirectional: b(37),
    isPriceExcludedFromDp: b(38),
    dpExclusionReason: toStrOrNull(g(39)),
    warningFlags: g(40),
    sourceReportPath: g(41),
    sourceCsvPath: g(42),
    debugArtifactPath: g(43),
    schemaVersion: g(44)
  };
}

// ---------------------------------------------------------------------------
// 6.3 Shard integrity policy
// ---------------------------------------------------------------------------

export interface ShardIntegrityResult {
  fileName: string;
  fileShardMonth: string;
  headerPresent: boolean;
  columnCountValid: boolean;
  schemaColumnsValid: boolean;
  rowCount: number;
  duplicateRowIds: string[];
  emptyRowHashCount: number;
  shardMonthMatchesFilename: boolean;
  shardMonthMismatchRowCount: number;
  invalidRowCount: number;
  errors: string[];
  ok: boolean;
}

export function shardMonthFromFileName(fileName: string): string {
  const match = /zao_signals_(\d{4}_\d{2})\.csv$/u.exec(fileName);
  return match ? match[1]! : "";
}

export function validateShardIntegrity(input: { fileName: string; csv: string }): ShardIntegrityResult {
  const errors: string[] = [];
  const records = parseCsv(input.csv).filter((r) => !(r.length === 1 && r[0] === ""));
  const header = records[0] ?? [];
  const dataRecords = records.slice(1);

  const headerPresent = header.join(",") === HISTORY_CSV_HEADERS.join(",");
  if (!headerPresent) errors.push("header_missing_or_mismatch");
  const columnCountValid = header.length === HISTORY_CSV_HEADERS.length;
  if (!columnCountValid) errors.push(`column_count:${header.length}`);
  const schemaColumnsValid = headerPresent;

  const fileShardMonth = shardMonthFromFileName(input.fileName);
  if (fileShardMonth === "") errors.push(`unparseable_filename:${input.fileName}`);

  const idCounts = new Map<string, number>();
  let emptyRowHashCount = 0;
  let shardMonthMismatchRowCount = 0;
  let invalidRowCount = 0;

  for (const rec of dataRecords) {
    const hr = historyRowFromCsvRecord(rec);
    idCounts.set(hr.rowId, (idCounts.get(hr.rowId) ?? 0) + 1);
    if (hr.rowHash.trim() === "") emptyRowHashCount += 1;
    if (fileShardMonth !== "" && hr.shardMonth !== fileShardMonth) shardMonthMismatchRowCount += 1;
    if (validateHistoryRow(hr).length > 0) invalidRowCount += 1;
  }

  const duplicateRowIds = [...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  if (duplicateRowIds.length > 0) errors.push(`duplicate_row_id_count:${duplicateRowIds.length}`);
  if (emptyRowHashCount > 0) errors.push(`empty_row_hash_count:${emptyRowHashCount}`);
  const shardMonthMatchesFilename = shardMonthMismatchRowCount === 0;
  if (!shardMonthMatchesFilename) errors.push(`shard_month_mismatch_rows:${shardMonthMismatchRowCount}`);
  if (invalidRowCount > 0) errors.push(`invalid_row_count:${invalidRowCount}`);

  const ok =
    headerPresent &&
    columnCountValid &&
    schemaColumnsValid &&
    fileShardMonth !== "" &&
    duplicateRowIds.length === 0 &&
    emptyRowHashCount === 0 &&
    shardMonthMatchesFilename &&
    invalidRowCount === 0;

  return {
    fileName: input.fileName,
    fileShardMonth,
    headerPresent,
    columnCountValid,
    schemaColumnsValid,
    rowCount: dataRecords.length,
    duplicateRowIds,
    emptyRowHashCount,
    shardMonthMatchesFilename,
    shardMonthMismatchRowCount,
    invalidRowCount,
    errors,
    ok
  };
}

// ---------------------------------------------------------------------------
// 6.4 Append lock strategy (documented only; never creates a lock file)
// ---------------------------------------------------------------------------

export interface AppendLockPolicy {
  lockFilePath: string;
  lockFileCreated: boolean;
  staleLockThresholdMinutes: number;
  rules: string[];
}

export function buildAppendLockPolicy(): AppendLockPolicy {
  return {
    lockFilePath: ".data/history/.append.lock",
    lockFileCreated: false,
    staleLockThresholdMinutes: 30,
    rules: [
      "Future real append MUST acquire the lock before any write.",
      "Abort if the lock file exists and is fresh (younger than the stale threshold).",
      "Stale lock threshold is explicit: 30 minutes.",
      "Release the lock only after successful validation AND write.",
      "M04X does not create the lock file; this is policy only."
    ]
  };
}

// ---------------------------------------------------------------------------
// 6.5 Real-run switch guard
// ---------------------------------------------------------------------------

export interface RealRunSwitchInput {
  explicitRealRunApproved: boolean;
  dryRunPassed: boolean;
  hashConflictCount: number;
  schemaValid: boolean;
  forbiddenColumnErrors: number;
  dbWriteMode: boolean;
  githubActionsMode: boolean;
}

export interface RealRunSwitchResult {
  realRunAllowed: boolean;
  failedConditions: string[];
}

export function evaluateRealRunSwitch(input: RealRunSwitchInput): RealRunSwitchResult {
  const failed: string[] = [];
  if (!input.explicitRealRunApproved) failed.push("explicitRealRunApproved!=true");
  if (!input.dryRunPassed) failed.push("dryRunPassed!=true");
  if (input.hashConflictCount !== 0) failed.push("hashConflictCount!=0");
  if (!input.schemaValid) failed.push("schemaValid!=true");
  if (input.forbiddenColumnErrors !== 0) failed.push("forbiddenColumnErrors!=0");
  if (input.dbWriteMode) failed.push("dbWriteMode!=false");
  if (input.githubActionsMode) failed.push("githubActionsMode!=false");
  return { realRunAllowed: failed.length === 0, failedConditions: failed };
}

// ---------------------------------------------------------------------------
// 6.6 History path guard
// ---------------------------------------------------------------------------

export interface HistoryPathGuardResult {
  target: string;
  isRealHistoryPath: boolean;
  realRunAllowed: boolean;
  allowed: boolean;
  reason: string;
}

export function evaluateHistoryWriteTarget(target: string, realRunAllowed: boolean): HistoryPathGuardResult {
  const real = isRealHistoryPath(target);
  let allowed: boolean;
  let reason: string;
  if (!real) {
    allowed = true;
    reason = "non_history_target_allowed";
  } else if (realRunAllowed) {
    allowed = true;
    reason = "real_history_target_allowed_real_run_approved";
  } else {
    allowed = false;
    reason = "real_history_target_blocked_real_run_disabled";
  }
  return { target, isRealHistoryPath: real, realRunAllowed, allowed, reason };
}

export function assertHistoryWriteTargetAllowed(target: string, realRunAllowed: boolean): void {
  const result = evaluateHistoryWriteTarget(target, realRunAllowed);
  if (!result.allowed) {
    throw new Error(`Refusing real history write target: ${target} (realRunAllowed=${realRunAllowed}). M04X must not write to .data/history.`);
  }
}

// ---------------------------------------------------------------------------
// 7. Simulated conflict fixtures (debug-only proof the policy works)
// ---------------------------------------------------------------------------

export interface SimulatedFixtureResult {
  name: string;
  description: string;
  expectedOutcome: string;
  actualOutcome: string;
  blocksAppend: boolean;
  passed: boolean;
  detail: Record<string, unknown>;
}

export function buildSimulatedConflictFixtures(baseRow: HistoryRow): SimulatedFixtureResult[] {
  const out: SimulatedFixtureResult[] = [];

  // 1. idempotent duplicate — same row_id + same row_hash.
  {
    const relation = classifyHashRelation(baseRow.rowHash, baseRow.rowHash);
    const blocks = relation === "idempotent_duplicate" ? conflictBlocksAppend("idempotent_duplicate") : true;
    out.push({
      name: "idempotent_duplicate",
      description: "same row_id + same row_hash should be a safe skip",
      expectedOutcome: "idempotent_duplicate (skip, does not block)",
      actualOutcome: relation,
      blocksAppend: blocks,
      passed: relation === "idempotent_duplicate" && !blocks,
      detail: { rowId: baseRow.rowId, rowHash: baseRow.rowHash }
    });
  }

  // 2. hash conflict — same row_id, different row_hash.
  {
    const incomingHash = `${baseRow.rowHash.slice(0, -1)}${baseRow.rowHash.endsWith("0") ? "1" : "0"}`;
    const relation = classifyHashRelation(baseRow.rowHash, incomingHash);
    const blocks = relation === "hash_conflict" ? conflictBlocksAppend("hash_conflict") : false;
    out.push({
      name: "hash_conflict",
      description: "same row_id + different row_hash must block append",
      expectedOutcome: "hash_conflict (block)",
      actualOutcome: relation,
      blocksAppend: blocks,
      passed: relation === "hash_conflict" && blocks,
      detail: { rowId: baseRow.rowId, existingHash: baseRow.rowHash, incomingHash }
    });
  }

  // 3. schema column-order mismatch.
  {
    const columns = [...HISTORY_CSV_HEADERS];
    [columns[0], columns[1]] = [columns[1]!, columns[0]!];
    const guard = validateSchemaMigrationGuard(columns, HISTORY_SCHEMA_VERSION);
    out.push({
      name: "schema_column_order_mismatch",
      description: "swapping column order must invalidate the schema",
      expectedOutcome: "schemaValid=false (block)",
      actualOutcome: `schemaValid=${guard.schemaValid}`,
      blocksAppend: !guard.schemaValid,
      passed: !guard.schemaValid && !guard.columnOrderValid,
      detail: { columnOrderValid: guard.columnOrderValid, errors: guard.errors }
    });
  }

  // 4. forbidden column present.
  {
    const columns = [...HISTORY_CSV_HEADERS, "roomid"];
    const guard = validateSchemaMigrationGuard(columns, HISTORY_SCHEMA_VERSION);
    out.push({
      name: "forbidden_column_present",
      description: "a PMS/Beds24 column (roomid) must invalidate the schema",
      expectedOutcome: "schemaValid=false, forbidden roomid detected (block)",
      actualOutcome: `schemaValid=${guard.schemaValid} forbidden=${JSON.stringify(guard.forbiddenColumns)}`,
      blocksAppend: !guard.schemaValid,
      passed: !guard.schemaValid && guard.forbiddenColumns.includes("roomid"),
      detail: { forbiddenColumns: guard.forbiddenColumns, extraColumns: guard.extraColumns }
    });
  }

  // 5. invalid row with missing row_id.
  {
    const invalid: HistoryRow = { ...baseRow, rowId: "" };
    const errors = validateHistoryRow(invalid);
    out.push({
      name: "invalid_row_missing_row_id",
      description: "a row with an empty row_id must fail validation",
      expectedOutcome: "validation error row_id_empty (block)",
      actualOutcome: `errors=${JSON.stringify(errors)}`,
      blocksAppend: errors.length > 0,
      passed: errors.includes("row_id_empty"),
      detail: { errors }
    });
  }

  // 6. attempted real .data/history write while realRunAllowed=false.
  {
    const target = ".data/history/zao_signals_2026_08.csv";
    const guard = evaluateHistoryWriteTarget(target, false);
    out.push({
      name: "real_history_write_blocked",
      description: "writing to .data/history while real-run is disabled must be blocked",
      expectedOutcome: "allowed=false (block)",
      actualOutcome: `allowed=${guard.allowed} reason=${guard.reason}`,
      blocksAppend: !guard.allowed,
      passed: !guard.allowed && guard.isRealHistoryPath,
      detail: { target, reason: guard.reason }
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 10. Decision
// ---------------------------------------------------------------------------

export type M04XDecision =
  | "local_history_append_validation_policy_ready"
  | "local_history_append_validation_policy_basis_caution"
  | "local_history_append_validation_policy_not_ready";

export function decideM04X(input: {
  m03xArtifactsValid: boolean;
  schemaValid: boolean;
  shardIntegrityOk: boolean;
  hashConflictCount: number;
  forbiddenColumnErrors: number;
  simulatedBlockingTestsPass: boolean;
  realRunAllowed: boolean;
  historyDirCreated: boolean;
  warningCount: number;
}): M04XDecision {
  if (
    !input.m03xArtifactsValid ||
    !input.schemaValid ||
    !input.shardIntegrityOk ||
    input.hashConflictCount > 0 ||
    input.forbiddenColumnErrors > 0 ||
    !input.simulatedBlockingTestsPass ||
    input.realRunAllowed ||
    input.historyDirCreated
  ) {
    return "local_history_append_validation_policy_not_ready";
  }
  if (input.warningCount > 0) {
    return "local_history_append_validation_policy_basis_caution";
  }
  return "local_history_append_validation_policy_ready";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const POLICY_CHECK_CSV_HEADERS = ["component", "check", "status", "detail"] as const;

export interface PolicyCheckRow {
  component: string;
  check: string;
  status: "pass" | "fail" | "info";
  detail: string;
}

export function renderPolicyCheckCsv(rows: PolicyCheckRow[]): string {
  const body = rows.map((r) => [r.component, r.check, r.status, r.detail].map(csvEscape).join(","));
  return [POLICY_CHECK_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export interface PolicyReportInput {
  generatedAt: string;
  decision: M04XDecision;
  schemaGuard: SchemaGuardResult;
  conflictPolicy: ConflictPolicyResult;
  shardIntegrity: ShardIntegrityResult[];
  shardIntegrityOk: boolean;
  simulatedFixtures: SimulatedFixtureResult[];
  realRunSwitch: RealRunSwitchResult;
  historyPathGuard: HistoryPathGuardResult;
  appendLockPolicy: AppendLockPolicy;
  m02xArtifacts: { reportPath: string; jsonPath: string; debugRoot: string };
  m03xArtifacts: { reportPath: string; jsonPath: string; debugRoot: string };
  historyDirExisted: boolean;
  historyDirCreated: boolean;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function renderValidationPolicyReport(input: PolicyReportInput): string {
  const sg = input.schemaGuard;
  const cp = input.conflictPolicy;
  return [
    "# Local History Append Validation & Conflict Policy (Phase M04X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Policy & safety",
    "",
    "- M04X does NOT perform real history append.",
    "- M04X does NOT enable GitHub Actions / GitOps / cron / auto-commit.",
    "- M04X does NOT create .data/history.",
    "- No DB writes (collector_runs/rate_snapshots/inventory_snapshots untouched).",
    "- No Beds24/AirHost/PMS/OTA columns; no deprecated tax_multiplier/tax_included_price/tax_normalization_rule; no base × 1.1.",
    "- Real-run mode is intentionally disabled in M04X (explicitRealRunApproved=false).",
    "",
    "## 2. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 3. Source M02X / M03X artifacts used",
    "",
    `- M02X report=${input.m02xArtifacts.reportPath}`,
    `- M02X json=${input.m02xArtifacts.jsonPath}`,
    `- M02X debug=${input.m02xArtifacts.debugRoot}`,
    `- M03X report=${input.m03xArtifacts.reportPath}`,
    `- M03X json=${input.m03xArtifacts.jsonPath}`,
    `- M03X debug=${input.m03xArtifacts.debugRoot}`,
    "",
    "## 4. Schema migration guard",
    "",
    `- schema_version=${sg.schemaVersion} (valid=${sg.schemaVersionValid})`,
    `- column_count=${sg.columnCount} (valid=${sg.columnCountValid})`,
    `- column_order_valid=${sg.columnOrderValid}`,
    `- missing_columns=${JSON.stringify(sg.missingColumns)}`,
    `- extra_columns=${JSON.stringify(sg.extraColumns)}`,
    `- deprecated_columns=${JSON.stringify(sg.deprecatedColumns)}`,
    `- forbidden_columns=${JSON.stringify(sg.forbiddenColumns)}`,
    `- schema_valid=${sg.schemaValid}`,
    "",
    "## 5. Conflict policy",
    "",
    ...cp.definitions.map((d) => `- ${d.type}: blocks_append=${d.blocksAppend} — ${d.description}`),
    "",
    `- idempotent_duplicate_count=${cp.idempotentDuplicateCount}`,
    `- hash_conflict_count=${cp.hashConflictCount}`,
    `- schema_conflict=${cp.schemaConflict}`,
    `- invalid_row_count=${cp.invalidRowCount}`,
    `- forbidden_column_conflict_count=${cp.forbiddenColumnConflictCount}`,
    `- blocking_conflict_types=${JSON.stringify(cp.blockingConflictTypes)}`,
    `- append_blocked=${cp.appendBlocked}`,
    "",
    "## 6. Shard integrity",
    "",
    `- shard_integrity_ok=${input.shardIntegrityOk}`,
    "| shard_file | rows | header | cols | dup_row_id | empty_hash | month_match | invalid | ok |",
    "|---|---|---|---|---|---|---|---|---|",
    ...input.shardIntegrity.map(
      (s) =>
        `| ${s.fileName} | ${s.rowCount} | ${s.headerPresent} | ${s.columnCountValid} | ${s.duplicateRowIds.length} | ${s.emptyRowHashCount} | ${s.shardMonthMatchesFilename} | ${s.invalidRowCount} | ${s.ok} |`
    ),
    "",
    "## 7. Simulated conflict fixture results",
    "",
    "| fixture | expected | actual | blocks_append | passed |",
    "|---|---|---|---|---|",
    ...input.simulatedFixtures.map(
      (f) => `| ${f.name} | ${f.expectedOutcome} | ${f.actualOutcome} | ${f.blocksAppend} | ${f.passed} |`
    ),
    "",
    "## 8. Real-run switch guard",
    "",
    `- real_run_allowed=${input.realRunSwitch.realRunAllowed} (expected false in M04X)`,
    `- failed_conditions=${JSON.stringify(input.realRunSwitch.failedConditions)}`,
    "",
    "## 9. History path guard",
    "",
    `- sample_target=${input.historyPathGuard.target}`,
    `- is_real_history_path=${input.historyPathGuard.isRealHistoryPath}`,
    `- allowed=${input.historyPathGuard.allowed}`,
    `- reason=${input.historyPathGuard.reason}`,
    "",
    "## 10. Append lock strategy (documented only; lock file NOT created)",
    "",
    `- lock_file_path=${input.appendLockPolicy.lockFilePath}`,
    `- lock_file_created=${input.appendLockPolicy.lockFileCreated}`,
    `- stale_lock_threshold_minutes=${input.appendLockPolicy.staleLockThresholdMinutes}`,
    ...input.appendLockPolicy.rules.map((r) => `- ${r}`),
    "",
    "## 11. .data/history safety check",
    "",
    `- history_dir_existed_before=${input.historyDirExisted}`,
    `- history_dir_created=${input.historyDirCreated}`,
    "",
    "## 12. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 13. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: M04XDecision): string {
  if (decision === "local_history_append_validation_policy_ready") {
    return "- Proceed to Phase M05X first real local history append PROPOSAL (files/rows/dedupe/rollback + explicit REAL_HISTORY_APPEND=1 gate). Real .data/history writes remain disabled until the user explicitly approves real-run mode.";
  }
  if (decision === "local_history_append_validation_policy_basis_caution") {
    return "- Policy mostly passes but non-critical warnings exist; review warnings before any real append. Do not proceed to real append.";
  }
  return "- Schema/shard-integrity/conflict guard failed, or real-run incorrectly enabled, or .data/history was created. Fix policy/validation first. Do not proceed to M05X.";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

// Re-export for callers that want the canonical forbidden-column list.
export { FORBIDDEN_COLUMNS, HISTORY_CSV_HEADERS, HISTORY_SCHEMA_VERSION, shardMonthFromCheckin };

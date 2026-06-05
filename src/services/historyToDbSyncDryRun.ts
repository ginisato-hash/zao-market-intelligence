// Phase AUTO03X — history-to-DB sync dry-run.
//
// Dry-run/report generation only. This module maps .data/history rows to the
// AUTO02X market_signal_history shape and simulates row_id/row_hash sync
// actions. It does not execute SQL, open/write the DB, create migrations,
// mutate history/property masters, run collectors, or fetch live pages.

export type HistoryToDbSyncDryRunDecision =
  | "history_to_db_sync_dry_run_ready"
  | "history_to_db_sync_dry_run_blocked_conflicts"
  | "history_to_db_sync_dry_run_not_ready";

export type SyncAction = "would_insert" | "would_skip_identical" | "would_conflict_block";

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export interface LoadedHistoryRow {
  sourceFile: string;
  row: Record<string, string>;
}

export interface MarketSignalHistoryDryRunRow {
  row_id: string;
  row_hash: string;
  shard_month: string;
  collected_date_jst: string;
  collected_at_jst: string;
  normalized_at_jst: string;
  source: string;
  canonical_property_name: string;
  source_property_id: string;
  source_url: string;
  checkin_date: string;
  checkout_date: string;
  stay_scope: string;
  availability_status: string;
  sold_out_flag: number | null;
  normalized_total_jpy: number | null;
  price_basis: string;
  basis_confidence: string;
  dp_usage: string;
  classification: string;
  exclusion_reason: string;
  debug_artifact_path: string;
  schema_version: string;
  raw_json: string;
  created_at: string;
  updated_at: string;
}

export interface RequiredColumnCheck {
  required_columns: string[];
  missing_columns_by_file: Record<string, string[]>;
  passed: boolean;
}

export interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  known_source_counts: Record<string, number>;
  dp_usage_counts: Record<string, number>;
  basis_confidence_counts: Record<string, number>;
  forbidden_mapped_columns_present: string[];
  duplicate_source_row_id_conflicts: SourceRowIdConflict[];
}

export interface SourceRowIdConflict {
  row_id: string;
  hashes: string[];
  source_files: string[];
}

export interface SyncActionRecord {
  run_id: string;
  row_id: string;
  row_hash: string;
  source: string;
  canonical_property_name: string;
  checkin_date: string;
  shard_month: string;
  action: SyncAction;
  reason: string;
}

export interface DedupeSummary {
  would_insert_rows: number;
  would_skip_identical_rows: number;
  would_conflict_rows: number;
}

export interface ConflictSummary {
  conflict_count: number;
  conflicts: SyncActionRecord[];
  source_duplicate_conflict_count: number;
  source_duplicate_conflicts: SourceRowIdConflict[];
}

export interface SyncRunPreview {
  sync_run_id: string;
  started_at: string;
  finished_at: string;
  status: "dry_run_ready" | "dry_run_blocked_conflicts" | "dry_run_not_ready";
  source_history_files: string[];
  input_rows: number;
  would_insert_rows: number;
  would_skip_identical_rows: number;
  would_conflict_rows: number;
  error_message: string;
  report_path: string;
  created_at: string;
}

export interface HistoryToDbSyncDryRun {
  run_id: string;
  generated_at_jst: string;
  decision: HistoryToDbSyncDryRunDecision;
  source_history_files: string[];
  history_row_count: number;
  mapped_row_count: number;
  required_column_check: RequiredColumnCheck;
  dedupe_summary: DedupeSummary;
  conflict_summary: ConflictSummary;
  sync_action_plan: SyncActionRecord[];
  sync_run_preview: SyncRunPreview;
  validation_result: ValidationResult;
  safety_confirmation: Record<string, boolean>;
  next_phase: string;
}

export const REQUIRED_HISTORY_COLUMNS = [
  "row_id",
  "row_hash",
  "shard_month",
  "collected_date_jst",
  "collected_at_jst",
  "normalized_at_jst",
  "source",
  "canonical_property_name",
  "source_property_id",
  "checkin",
  "checkout",
  "stay_scope",
  "availability_status",
  "basis_confidence",
  "debug_artifact_path",
  "schema_version"
] as const;

export const KNOWN_SOURCES = ["jalan", "rakuten", "booking", "google_hotels"] as const;
export const ALLOWED_DP_USAGE = ["direct", "directional", "excluded", "insufficient"] as const;
export const ALLOWED_BASIS_CONFIDENCE = ["A", "B", "C", "insufficient"] as const;
export const FORBIDDEN_DB_COLUMNS = [
  "Beds24",
  "AirHost",
  "PMS",
  "roomid",
  "inventory",
  "minstay",
  "maxstay",
  "multiplier",
  "price1",
  "price2",
  "price3",
  "price4",
  "price5"
] as const;

export function parseCsvTable(csv: string): CsvTable {
  const matrix: string[][] = [];
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
      if (row.some((value) => value !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== "")) matrix.push(row);
  }
  const headers = matrix.shift() ?? [];
  return { headers, rows: matrix.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}

export function mapHistoryRowToMarketSignalHistoryRow(
  input: Record<string, string>,
  nowJst: string
): MarketSignalHistoryDryRunRow {
  return {
    row_id: input["row_id"] ?? "",
    row_hash: input["row_hash"] ?? "",
    shard_month: input["shard_month"] ?? "",
    collected_date_jst: input["collected_date_jst"] ?? "",
    collected_at_jst: input["collected_at_jst"] ?? "",
    normalized_at_jst: input["normalized_at_jst"] ?? "",
    source: input["source"] ?? "",
    canonical_property_name: input["canonical_property_name"] ?? "",
    source_property_id: input["source_property_id"] ?? "",
    source_url: input["source_url"] ?? "",
    checkin_date: input["checkin_date"] ?? input["checkin"] ?? "",
    checkout_date: input["checkout_date"] ?? input["checkout"] ?? "",
    stay_scope: input["stay_scope"] ?? "",
    availability_status: input["availability_status"] ?? "",
    sold_out_flag: toSoldOutFlag(input),
    normalized_total_jpy: toNullableInteger(input["normalized_total_jpy"] ?? input["normalized_total_price"]),
    price_basis: input["price_basis"] ?? input["normalized_total_price_basis"] ?? "",
    basis_confidence: input["basis_confidence"] ?? input["normalized_total_price_confidence"] ?? "",
    dp_usage: deriveDpUsage(input),
    classification: input["classification"] ?? input["source_classification"] ?? "",
    exclusion_reason: input["exclusion_reason"] ?? input["dp_exclusion_reason"] ?? "",
    debug_artifact_path: input["debug_artifact_path"] ?? "",
    schema_version: input["schema_version"] ?? "",
    raw_json: JSON.stringify(input),
    created_at: nowJst,
    updated_at: nowJst
  };
}

export function validateRequiredColumns(files: { path: string; headers: string[] }[]): RequiredColumnCheck {
  const missing: Record<string, string[]> = {};
  for (const file of files) {
    const missingForFile = REQUIRED_HISTORY_COLUMNS.filter((column) => !file.headers.includes(column));
    if (missingForFile.length > 0) missing[file.path] = missingForFile;
  }
  return {
    required_columns: [...REQUIRED_HISTORY_COLUMNS],
    missing_columns_by_file: missing,
    passed: Object.keys(missing).length === 0
  };
}

export function validateMappedRows(rows: MarketSignalHistoryDryRunRow[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const known_source_counts: Record<string, number> = {};
  const dp_usage_counts: Record<string, number> = {};
  const basis_confidence_counts: Record<string, number> = {};

  rows.forEach((row, index) => {
    const prefix = `row_index=${index};row_id=${row.row_id || "(missing)"}`;
    if (!row.row_id) errors.push(`${prefix};missing row_id`);
    if (!row.row_hash) errors.push(`${prefix};missing row_hash`);
    if (!row.schema_version) errors.push(`${prefix};missing schema_version`);
    if (!isKnownSource(row.source)) errors.push(`${prefix};unknown source=${row.source}`);
    if (row.dp_usage && !isAllowed(row.dp_usage, ALLOWED_DP_USAGE)) errors.push(`${prefix};invalid dp_usage=${row.dp_usage}`);
    if (row.basis_confidence && !isAllowed(row.basis_confidence, ALLOWED_BASIS_CONFIDENCE)) errors.push(`${prefix};invalid basis_confidence=${row.basis_confidence}`);
    known_source_counts[row.source] = (known_source_counts[row.source] ?? 0) + 1;
    dp_usage_counts[row.dp_usage || ""] = (dp_usage_counts[row.dp_usage || ""] ?? 0) + 1;
    basis_confidence_counts[row.basis_confidence || ""] = (basis_confidence_counts[row.basis_confidence || ""] ?? 0) + 1;
  });

  const duplicate_source_row_id_conflicts = findSourceRowIdConflicts(rows);
  for (const conflict of duplicate_source_row_id_conflicts) {
    errors.push(`source duplicate row_id conflict: ${conflict.row_id} hashes=${conflict.hashes.join("|")}`);
  }

  const forbidden_mapped_columns_present = FORBIDDEN_DB_COLUMNS.filter((column) =>
    rows.some((row) => Object.prototype.hasOwnProperty.call(row, column))
  );
  if (forbidden_mapped_columns_present.length > 0) {
    errors.push(`forbidden mapped columns present: ${forbidden_mapped_columns_present.join(",")}`);
  }

  if (rows.length === 0) warnings.push("No rows mapped from history.");
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    known_source_counts,
    dp_usage_counts,
    basis_confidence_counts,
    forbidden_mapped_columns_present,
    duplicate_source_row_id_conflicts
  };
}

export function simulateHistoryToDbSync(input: {
  runId: string;
  rows: MarketSignalHistoryDryRunRow[];
  existingRows?: MarketSignalHistoryDryRunRow[];
}): { actions: SyncActionRecord[]; dedupe: DedupeSummary; conflicts: SyncActionRecord[] } {
  const existing = new Map<string, string>();
  for (const row of input.existingRows ?? []) existing.set(row.row_id, row.row_hash);

  const actions: SyncActionRecord[] = [];
  const conflicts: SyncActionRecord[] = [];
  const seen = new Map<string, string>();
  let would_insert_rows = 0;
  let would_skip_identical_rows = 0;
  let would_conflict_rows = 0;

  for (const row of input.rows) {
    const targetHash = existing.get(row.row_id) ?? seen.get(row.row_id);
    let action: SyncAction;
    let reason: string;
    if (targetHash === undefined) {
      action = "would_insert";
      reason = "new_row_id";
      seen.set(row.row_id, row.row_hash);
      would_insert_rows += 1;
    } else if (targetHash === row.row_hash) {
      action = "would_skip_identical";
      reason = "same_row_id_same_row_hash";
      would_skip_identical_rows += 1;
    } else {
      action = "would_conflict_block";
      reason = `existing_hash=${targetHash};incoming_hash=${row.row_hash}`;
      would_conflict_rows += 1;
    }

    const record: SyncActionRecord = {
      run_id: input.runId,
      row_id: row.row_id,
      row_hash: row.row_hash,
      source: row.source,
      canonical_property_name: row.canonical_property_name,
      checkin_date: row.checkin_date,
      shard_month: row.shard_month,
      action,
      reason
    };
    actions.push(record);
    if (action === "would_conflict_block") conflicts.push(record);
  }

  return {
    actions,
    dedupe: { would_insert_rows, would_skip_identical_rows, would_conflict_rows },
    conflicts
  };
}

export function buildSyncRunPreview(input: {
  runId: string;
  generatedAtJst: string;
  sourceHistoryFiles: string[];
  inputRows: number;
  dedupe: DedupeSummary;
  reportPath: string;
  validationPassed: boolean;
}): SyncRunPreview {
  const status = input.dedupe.would_conflict_rows > 0
      ? "dry_run_blocked_conflicts"
      : !input.validationPassed
        ? "dry_run_not_ready"
      : "dry_run_ready";
  return {
    sync_run_id: input.runId,
    started_at: input.generatedAtJst,
    finished_at: input.generatedAtJst,
    status,
    source_history_files: input.sourceHistoryFiles,
    input_rows: input.inputRows,
    would_insert_rows: input.dedupe.would_insert_rows,
    would_skip_identical_rows: input.dedupe.would_skip_identical_rows,
    would_conflict_rows: input.dedupe.would_conflict_rows,
    error_message: status === "dry_run_ready" ? "" : status,
    report_path: input.reportPath,
    created_at: input.generatedAtJst
  };
}

export function buildHistoryToDbSyncDryRun(input: {
  runId: string;
  generatedAtJst: string;
  reportPath: string;
  sourceHistoryFiles: string[];
  loadedRows: LoadedHistoryRow[];
  requiredColumnCheck: RequiredColumnCheck;
  existingRows?: MarketSignalHistoryDryRunRow[];
}): HistoryToDbSyncDryRun {
  const mappedRows = input.loadedRows.map((r) => mapHistoryRowToMarketSignalHistoryRow(r.row, input.generatedAtJst));
  const validation = validateMappedRows(mappedRows);
  if (!input.requiredColumnCheck.passed) {
    validation.errors.push("required history columns missing");
  }
  const simulated = simulateHistoryToDbSync({
    runId: input.runId,
    rows: mappedRows,
    ...(input.existingRows === undefined ? {} : { existingRows: input.existingRows })
  });
  const conflictSummary: ConflictSummary = {
    conflict_count: simulated.conflicts.length,
    conflicts: simulated.conflicts,
    source_duplicate_conflict_count: validation.duplicate_source_row_id_conflicts.length,
    source_duplicate_conflicts: validation.duplicate_source_row_id_conflicts
  };
  const validationPassed = input.requiredColumnCheck.passed && validation.passed;
  const syncRunPreview = buildSyncRunPreview({
    runId: input.runId,
    generatedAtJst: input.generatedAtJst,
    sourceHistoryFiles: input.sourceHistoryFiles,
    inputRows: input.loadedRows.length,
    dedupe: simulated.dedupe,
    reportPath: input.reportPath,
    validationPassed
  });

  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: decideHistoryToDbSyncDryRun({
      validationPassed,
      mappedRowCount: mappedRows.length,
      conflictCount: simulated.dedupe.would_conflict_rows + validation.duplicate_source_row_id_conflicts.length
    }),
    source_history_files: input.sourceHistoryFiles,
    history_row_count: input.loadedRows.length,
    mapped_row_count: mappedRows.length,
    required_column_check: input.requiredColumnCheck,
    dedupe_summary: simulated.dedupe,
    conflict_summary: conflictSummary,
    sync_action_plan: simulated.actions,
    sync_run_preview: syncRunPreview,
    validation_result: validation,
    safety_confirmation: {
      dbWrites: false,
      sqlExecuted: false,
      migrationsCreated: false,
      liveExternalFetch: false,
      collectorRun: false,
      workflowCreatedOrActivated: false,
      cronActivated: false,
      gitCommitOrPush: false,
      dataRepoCreated: false,
      historyModified: false,
      propertyMasterModified: false,
      pmsOrChannelOutput: false,
      priceUpdate: false,
      paidSourceTooling: false,
      bookingBaseTimesOnePointOneLogic: false
    },
    next_phase: "AUTO04X — First guarded DB mirror sync real run with explicit approval"
  };
}

export function decideHistoryToDbSyncDryRun(input: {
  validationPassed: boolean;
  mappedRowCount: number;
  conflictCount: number;
}): HistoryToDbSyncDryRunDecision {
  if (input.conflictCount > 0) return "history_to_db_sync_dry_run_blocked_conflicts";
  if (!input.validationPassed || input.mappedRowCount === 0) return "history_to_db_sync_dry_run_not_ready";
  return "history_to_db_sync_dry_run_ready";
}

export function renderHistoryToDbSyncDryRunCsv(plan: HistoryToDbSyncDryRun): string {
  const headers = ["run_id", "row_id", "row_hash", "source", "canonical_property_name", "checkin_date", "shard_month", "action", "reason"];
  const rows = plan.sync_action_plan.map((a) =>
    [a.run_id, a.row_id, a.row_hash, a.source, a.canonical_property_name, a.checkin_date, a.shard_month, a.action, a.reason].map(csvEscape).join(",")
  );
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

export function renderHistoryToDbSyncDryRunReport(plan: HistoryToDbSyncDryRun): string {
  return [
    "# History-to-DB Sync Dry-Run",
    "",
    `Generated at: ${plan.generated_at_jst}`,
    `Decision: ${plan.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `Loaded ${plan.history_row_count} history rows and mapped ${plan.mapped_row_count} rows to the future market_signal_history shape. No DB writes or SQL execution occurred.`,
    "",
    "## 2. Source History Files",
    "",
    ...plan.source_history_files.map((file) => `- ${file}`),
    "",
    "## 3. Schema Mapping",
    "",
    "- checkin/checkin_date -> checkin_date",
    "- checkout/checkout_date -> checkout_date",
    "- normalized_total_price/normalized_total_jpy -> normalized_total_jpy",
    "- normalized_total_price_basis/price_basis -> price_basis",
    "- source_classification/classification -> classification",
    "- dp_exclusion_reason/exclusion_reason -> exclusion_reason",
    "- all extra source metadata is preserved in raw_json",
    "",
    "## 4. Row Counts",
    "",
    `- history_row_count=${plan.history_row_count}`,
    `- mapped_row_count=${plan.mapped_row_count}`,
    "",
    "## 5. Dedupe Summary",
    "",
    `- would_insert_rows=${plan.dedupe_summary.would_insert_rows}`,
    `- would_skip_identical_rows=${plan.dedupe_summary.would_skip_identical_rows}`,
    `- would_conflict_rows=${plan.dedupe_summary.would_conflict_rows}`,
    "",
    "## 6. Conflict Summary",
    "",
    `- conflict_count=${plan.conflict_summary.conflict_count}`,
    `- source_duplicate_conflict_count=${plan.conflict_summary.source_duplicate_conflict_count}`,
    ...plan.conflict_summary.conflicts.map((c) => `- conflict row_id=${c.row_id}; reason=${c.reason}`),
    ...plan.conflict_summary.source_duplicate_conflicts.map((c) => `- source_duplicate_conflict row_id=${c.row_id}; hashes=${c.hashes.join("|")}`),
    "",
    "## 7. Sync Action Plan",
    "",
    `- action_rows=${plan.sync_action_plan.length}`,
    `- would_insert=${plan.sync_action_plan.filter((a) => a.action === "would_insert").length}`,
    `- would_skip_identical=${plan.sync_action_plan.filter((a) => a.action === "would_skip_identical").length}`,
    `- would_conflict_block=${plan.sync_action_plan.filter((a) => a.action === "would_conflict_block").length}`,
    "",
    "## 8. Sync Run Preview",
    "",
    `- sync_run_id=${plan.sync_run_preview.sync_run_id}`,
    `- status=${plan.sync_run_preview.status}`,
    `- input_rows=${plan.sync_run_preview.input_rows}`,
    `- would_insert_rows=${plan.sync_run_preview.would_insert_rows}`,
    `- would_skip_identical_rows=${plan.sync_run_preview.would_skip_identical_rows}`,
    `- would_conflict_rows=${plan.sync_run_preview.would_conflict_rows}`,
    "",
    "## 9. Validation Results",
    "",
    `- required_column_check_passed=${plan.required_column_check.passed}`,
    `- validation_passed=${plan.validation_result.passed}`,
    `- errors=${plan.validation_result.errors.length}`,
    `- warnings=${plan.validation_result.warnings.length}`,
    `- source_counts=${JSON.stringify(plan.validation_result.known_source_counts)}`,
    `- dp_usage_counts=${JSON.stringify(plan.validation_result.dp_usage_counts)}`,
    `- basis_confidence_counts=${JSON.stringify(plan.validation_result.basis_confidence_counts)}`,
    ...plan.validation_result.errors.map((e) => `- error=${e}`),
    ...plan.validation_result.warnings.map((w) => `- warning=${w}`),
    "",
    "## 10. Safety Confirmation",
    "",
    ...Object.entries(plan.safety_confirmation).map(([k, v]) => `- ${k}=${v}`),
    "",
    "## 11. Next Phase: AUTO04X",
    "",
    plan.next_phase,
    ""
  ].join("\n");
}

export function findSourceRowIdConflicts(rows: MarketSignalHistoryDryRunRow[]): SourceRowIdConflict[] {
  const grouped = new Map<string, { hashes: Set<string>; files: Set<string> }>();
  for (const row of rows) {
    const raw = safeJson(row.raw_json);
    const sourceFile = typeof raw["__source_file"] === "string" ? raw["__source_file"] : "";
    const bucket = grouped.get(row.row_id) ?? { hashes: new Set<string>(), files: new Set<string>() };
    bucket.hashes.add(row.row_hash);
    if (sourceFile) bucket.files.add(sourceFile);
    grouped.set(row.row_id, bucket);
  }
  const conflicts: SourceRowIdConflict[] = [];
  for (const [row_id, bucket] of grouped) {
    if (bucket.hashes.size > 1) {
      conflicts.push({ row_id, hashes: [...bucket.hashes].sort(), source_files: [...bucket.files].sort() });
    }
  }
  return conflicts;
}

function deriveDpUsage(input: Record<string, string>): string {
  if (input["dp_usage"]) return input["dp_usage"]!;
  if (isTruthy(input["is_price_usable_for_dp_direct"])) return "direct";
  if (isTruthy(input["is_price_usable_for_dp_directional"])) return "directional";
  if (isTruthy(input["is_price_excluded_from_dp"])) return "excluded";
  return "insufficient";
}

function toSoldOutFlag(input: Record<string, string>): number | null {
  const value = `${input["sold_out_flag"] ?? ""} ${input["sold_out_status"] ?? ""} ${input["availability_status"] ?? ""}`.toLowerCase();
  if (value.includes("sold_out") || value.includes("sold out")) return 1;
  if (value.trim() === "") return null;
  return 0;
}

function toNullableInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function isTruthy(value: string | undefined): boolean {
  return ["true", "1", "yes", "y"].includes((value ?? "").trim().toLowerCase());
}

function isKnownSource(source: string): boolean {
  return isAllowed(source, KNOWN_SOURCES);
}

function isAllowed<T extends readonly string[]>(value: string, allowed: T): boolean {
  return (allowed as readonly string[]).includes(value);
}

function safeJson(rawJson: string): Record<string, unknown> {
  try {
    return JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

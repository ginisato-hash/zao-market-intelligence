// Phase M04X — build the history append validation & conflict policy report.
//
// Reads the latest M03X dry-run artifacts (summary + simulated shard CSVs) and
// M02X schema artifacts, runs the hardened validation/conflict/shard-integrity
// guards, simulates blocking conflict fixtures, and emits a local
// report/CSV/JSON + debug artifacts. Real-run mode is disabled: every
// .data/history target is blocked and .data/history must not be created.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HISTORY_CSV_HEADERS,
  HISTORY_SCHEMA_VERSION,
  type HistoryRow
} from "../services/localHistorySchemaDesign";
import {
  assertHistoryWriteTargetAllowed,
  buildAppendLockPolicy,
  buildSimulatedConflictFixtures,
  decideM04X,
  evaluateConflictPolicy,
  evaluateHistoryWriteTarget,
  evaluateRealRunSwitch,
  renderPolicyCheckCsv,
  renderValidationPolicyReport,
  validateSchemaMigrationGuard,
  validateShardIntegrity,
  type PolicyCheckRow,
  type ShardIntegrityResult
} from "../services/localHistoryAppendValidationPolicy";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/history-append-validation-policy";
const HISTORY_DIR = ".data/history";

const M03X_REPORT_PREFIX = "local_history_append_dry_run_";
const M03X_DEBUG_ROOT = ".data/debug/history-append-dry-run";
const M02X_REPORT_PREFIX = "local_history_schema_design_";
const M02X_DEBUG_ROOT = ".data/debug/history-schema-design";

// M04X is a hardening/reporting layer only — real-run mode stays disabled.
const EXPLICIT_REAL_RUN_APPROVED = false;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function resolveLatest(prefix: string): { jsonPath: string; ts: string } {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing artifact directory: ${reportDir}. Do not re-run collectors; produce the prior-phase artifact first.`);
  }
  const jsonFiles = entries.filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(`Missing source JSON (expected ${prefix}*.json in ${reportDir}). Do not re-run collectors; stop and report the missing artifact path.`);
  }
  const ts = latest.slice(prefix.length, -".json".length);
  return { jsonPath: resolve(reportDir, latest), ts };
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Missing required artifact: ${path}. Stop and report the missing artifact path.`);
  }
  try {
    return JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Malformed JSON ${path}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

function loadBaseHistoryRow(m02xTs: string): HistoryRow {
  const rowsPath = resolve(M02X_DEBUG_ROOT, m02xTs, "history_rows_prototype.json");
  const parsed = readJson(rowsPath);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`M02X history rows JSON ${rowsPath} is empty. Stop and report the malformed artifact.`);
  }
  return parsed[0] as HistoryRow;
}

interface M03XSummary {
  hashConflictCount: number;
  duplicateInputRowCount: number;
  scenarioBAppendedCount: number;
  decision: string;
  historyDirCreated: boolean;
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  // Safety: capture .data/history state up front; it must not change.
  const historyDir = resolve(HISTORY_DIR);
  const historyExistedBefore = existsSync(historyDir);
  const historyBefore = historyExistedBefore ? readdirSync(historyDir) : [];

  const ts = timestamp();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  const fixturesDir = resolve(debugRootPath, "simulated-fixtures");

  // ---- Source artifacts (M02X + M03X) ----
  const m02x = resolveLatest(M02X_REPORT_PREFIX);
  const m03x = resolveLatest(M03X_REPORT_PREFIX);
  const m03xSummary = readJson(resolve(M03X_DEBUG_ROOT, m03x.ts, "summary.json")) as M03XSummary;
  const baseRow = loadBaseHistoryRow(m02x.ts);

  const m03xArtifactsValid =
    typeof m03xSummary.hashConflictCount === "number" &&
    m03xSummary.decision === "local_history_append_dry_run_ready" &&
    m03xSummary.historyDirCreated === false;

  // ---- 6.1 Schema migration guard (on the canonical 45-column schema) ----
  const schemaGuard = validateSchemaMigrationGuard([...HISTORY_CSV_HEADERS], HISTORY_SCHEMA_VERSION);

  // ---- 6.3 Shard integrity (validate each M03X dry-run shard file) ----
  const shardsDir = resolve(M03X_DEBUG_ROOT, m03x.ts, "shards");
  let shardFiles: string[];
  try {
    shardFiles = readdirSync(shardsDir).filter((n) => n.endsWith(".csv")).sort();
  } catch {
    throw new Error(`Missing M03X dry-run shards dir: ${shardsDir}. Stop and report the missing artifact path.`);
  }
  if (shardFiles.length === 0) {
    throw new Error(`M03X dry-run shards dir ${shardsDir} has no CSV shards. Stop and report the malformed artifact.`);
  }
  const shardIntegrity: ShardIntegrityResult[] = shardFiles.map((fileName) =>
    validateShardIntegrity({ fileName, csv: readFileSync(resolve(shardsDir, fileName), "utf8") })
  );
  const shardIntegrityOk = shardIntegrity.every((s) => s.ok);
  const shardInvalidRowCount = shardIntegrity.reduce((sum, s) => sum + s.invalidRowCount, 0);
  const shardDuplicateRowIdCount = shardIntegrity.reduce((sum, s) => sum + s.duplicateRowIds.length, 0);

  // ---- 6.2 Conflict policy ----
  const conflictPolicy = evaluateConflictPolicy({
    idempotentDuplicateCount: m03xSummary.duplicateInputRowCount,
    hashConflictCount: m03xSummary.hashConflictCount,
    schemaValid: schemaGuard.schemaValid,
    invalidRowCount: shardInvalidRowCount,
    forbiddenColumnErrors: schemaGuard.forbiddenColumns.length + schemaGuard.deprecatedColumns.length
  });

  // ---- 6.4 Append lock policy (documented only) ----
  const appendLockPolicy = buildAppendLockPolicy();

  // ---- 6.5 Real-run switch guard (must stay false in M04X) ----
  const realRunSwitch = evaluateRealRunSwitch({
    explicitRealRunApproved: EXPLICIT_REAL_RUN_APPROVED,
    dryRunPassed: m03xArtifactsValid,
    hashConflictCount: m03xSummary.hashConflictCount,
    schemaValid: schemaGuard.schemaValid,
    forbiddenColumnErrors: schemaGuard.forbiddenColumns.length + schemaGuard.deprecatedColumns.length,
    dbWriteMode: false,
    githubActionsMode: false
  });

  // ---- 6.6 History path guard (sample real target while real-run disabled) ----
  const historyPathGuard = evaluateHistoryWriteTarget(`${HISTORY_DIR}/zao_signals_2026_08.csv`, realRunSwitch.realRunAllowed);

  // ---- 7. Simulated conflict fixtures ----
  const simulatedFixtures = buildSimulatedConflictFixtures(baseRow);
  const simulatedBlockingTestsPass = simulatedFixtures.every((f) => f.passed);

  // ---- 10. Decision ----
  const forbiddenColumnErrors = schemaGuard.forbiddenColumns.length + schemaGuard.deprecatedColumns.length;
  const historyDirCreatedDuringRun = existsSync(historyDir) && !historyExistedBefore;
  const decision = decideM04X({
    m03xArtifactsValid,
    schemaValid: schemaGuard.schemaValid,
    shardIntegrityOk,
    hashConflictCount: m03xSummary.hashConflictCount,
    forbiddenColumnErrors,
    simulatedBlockingTestsPass,
    realRunAllowed: realRunSwitch.realRunAllowed,
    historyDirCreated: historyDirCreatedDuringRun,
    warningCount: 0
  });

  // ---- Output dirs (debug only; guarded) ----
  const reportDir = resolve(REPORT_DIR);
  assertHistoryWriteTargetAllowed(debugRootPath, realRunSwitch.realRunAllowed);
  assertHistoryWriteTargetAllowed(fixturesDir, realRunSwitch.realRunAllowed);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });

  const reportPath = resolve(reportDir, `local_history_append_validation_policy_${ts}.md`);
  const csvPath = resolve(reportDir, `local_history_append_validation_policy_${ts}.csv`);
  const jsonPath = resolve(reportDir, `local_history_append_validation_policy_${ts}.json`);

  const m02xArtifacts = {
    reportPath: m02x.jsonPath.replace(/\.json$/u, ".md"),
    jsonPath: m02x.jsonPath,
    debugRoot: resolve(M02X_DEBUG_ROOT, m02x.ts)
  };
  const m03xArtifacts = {
    reportPath: m03x.jsonPath.replace(/\.json$/u, ".md"),
    jsonPath: m03x.jsonPath,
    debugRoot: resolve(M03X_DEBUG_ROOT, m03x.ts)
  };

  // ---- Policy-check CSV rows ----
  const checks: PolicyCheckRow[] = [
    { component: "schema_guard", check: "schema_version", status: schemaGuard.schemaVersionValid ? "pass" : "fail", detail: schemaGuard.schemaVersion },
    { component: "schema_guard", check: "column_count", status: schemaGuard.columnCountValid ? "pass" : "fail", detail: String(schemaGuard.columnCount) },
    { component: "schema_guard", check: "column_order", status: schemaGuard.columnOrderValid ? "pass" : "fail", detail: "" },
    { component: "schema_guard", check: "forbidden_columns", status: schemaGuard.forbiddenColumns.length === 0 ? "pass" : "fail", detail: JSON.stringify(schemaGuard.forbiddenColumns) },
    { component: "schema_guard", check: "deprecated_columns", status: schemaGuard.deprecatedColumns.length === 0 ? "pass" : "fail", detail: JSON.stringify(schemaGuard.deprecatedColumns) },
    { component: "conflict_policy", check: "hash_conflict_count", status: conflictPolicy.hashConflictCount === 0 ? "pass" : "fail", detail: String(conflictPolicy.hashConflictCount) },
    { component: "conflict_policy", check: "append_blocked", status: conflictPolicy.appendBlocked ? "fail" : "pass", detail: JSON.stringify(conflictPolicy.blockingConflictTypes) },
    { component: "conflict_policy", check: "idempotent_duplicate_count", status: "info", detail: String(conflictPolicy.idempotentDuplicateCount) },
    ...shardIntegrity.map((s): PolicyCheckRow => ({ component: "shard_integrity", check: s.fileName, status: s.ok ? "pass" : "fail", detail: JSON.stringify(s.errors) })),
    { component: "shard_integrity", check: "duplicate_row_id_total", status: shardDuplicateRowIdCount === 0 ? "pass" : "fail", detail: String(shardDuplicateRowIdCount) },
    ...simulatedFixtures.map((f): PolicyCheckRow => ({ component: "simulated_fixture", check: f.name, status: f.passed ? "pass" : "fail", detail: f.actualOutcome })),
    { component: "real_run_switch", check: "real_run_allowed", status: realRunSwitch.realRunAllowed ? "fail" : "pass", detail: JSON.stringify(realRunSwitch.failedConditions) },
    { component: "history_path_guard", check: "real_history_blocked", status: historyPathGuard.allowed ? "fail" : "pass", detail: historyPathGuard.reason },
    { component: "append_lock", check: "lock_file_created", status: appendLockPolicy.lockFileCreated ? "fail" : "pass", detail: appendLockPolicy.lockFilePath }
  ];

  const generatedAt = new Date().toISOString();
  writeFileSync(csvPath, renderPolicyCheckCsv(checks), "utf8");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        decision,
        generatedAt,
        schemaGuard,
        conflictPolicy,
        shardIntegrity,
        shardIntegrityOk,
        simulatedFixtures,
        simulatedBlockingTestsPass,
        realRunSwitch,
        historyPathGuard,
        appendLockPolicy,
        m02xArtifacts,
        m03xArtifacts,
        m03xSummary,
        historyDirExisted: historyExistedBefore,
        historyDirCreated: historyDirCreatedDuringRun
      },
      null,
      2
    ),
    "utf8"
  );
  writeFileSync(
    reportPath,
    renderValidationPolicyReport({
      generatedAt,
      decision,
      schemaGuard,
      conflictPolicy,
      shardIntegrity,
      shardIntegrityOk,
      simulatedFixtures,
      realRunSwitch,
      historyPathGuard,
      appendLockPolicy,
      m02xArtifacts,
      m03xArtifacts,
      historyDirExisted: historyExistedBefore,
      historyDirCreated: historyDirCreatedDuringRun,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    const target = resolve(debugRootPath, name);
    assertHistoryWriteTargetAllowed(target, realRunSwitch.realRunAllowed);
    writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_m02x_artifacts.json", m02xArtifacts);
  writeDebug("source_m03x_artifacts.json", { ...m03xArtifacts, summary: m03xSummary });
  writeDebug("schema_guard_result.json", schemaGuard);
  writeDebug("conflict_policy_result.json", conflictPolicy);
  writeDebug("shard_integrity_result.json", shardIntegrity);
  writeDebug("real_run_switch_guard_result.json", realRunSwitch);
  writeDebug("history_path_guard_result.json", historyPathGuard);
  writeDebug("append_lock_policy.json", appendLockPolicy);
  writeDebug("simulated_conflict_fixtures.json", simulatedFixtures);
  writeDebug("validation_summary.json", {
    decision,
    schemaValid: schemaGuard.schemaValid,
    shardIntegrityOk,
    hashConflictCount: m03xSummary.hashConflictCount,
    forbiddenColumnErrors,
    simulatedBlockingTestsPass,
    realRunAllowed: realRunSwitch.realRunAllowed,
    historyDirCreated: historyDirCreatedDuringRun
  });

  // Simulated fixtures live under the debug fixtures dir (guarded above).
  for (const fixture of simulatedFixtures) {
    const target = resolve(fixturesDir, `${fixture.name}.json`);
    assertHistoryWriteTargetAllowed(target, realRunSwitch.realRunAllowed);
    writeFileSync(target, JSON.stringify(fixture, null, 2), "utf8");
  }

  // Safety: confirm .data/history did not change.
  const historyAfter = existsSync(historyDir) ? readdirSync(historyDir) : [];
  if (historyDirCreatedDuringRun || historyAfter.length !== historyBefore.length) {
    throw new Error(
      `Safety violation: ${HISTORY_DIR} changed during M04X (existedBefore=${historyExistedBefore}, before=${historyBefore.length}, after=${historyAfter.length}). M04X must not touch real history.`
    );
  }

  return { reportPath, csvPath, jsonPath, debugRootPath, decision };
}

try {
  const result = build();
  console.log(`report_path=${result.reportPath}`);
  console.log(`policy_csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`history_dir_exists=${existsSync(resolve(HISTORY_DIR))}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

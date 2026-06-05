import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HISTORY_CSV_HEADERS,
  HISTORY_SCHEMA_VERSION,
  renderHistoryCsv,
  type HistoryRow
} from "../src/services/localHistorySchemaDesign";
import {
  APPEND_LOCK_FILENAME,
  EXPECTED_SHARD_ROW_COUNTS,
  EXPECTED_TOTAL_ROWS,
  STALE_LOCK_THRESHOLD_MINUTES,
  WRITE_ACTION_CSV_HEADERS,
  evaluateRealAppendGate,
  isLockStale,
  parseShardRows,
  renderWriteActionCsv,
  runPreflight,
  runRealAppend,
  validatePostWriteShards,
  type RealAppendGateInput,
  type RealAppendGateResult
} from "../src/services/localHistoryRealAppend";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/localHistoryRealAppend.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runLocalHistoryRealAppend.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(shardMonth: string, i: number, over: Partial<HistoryRow> = {}): HistoryRow {
  const [y, m] = shardMonth.split("_");
  const checkin = `${y}-${m}-${String((i % 27) + 1).padStart(2, "0")}`;
  const base: HistoryRow = {
    rowId: `${shardMonth}|booking|prop|slug${i}|${checkin}|${checkin}|scope`,
    rowHash: `hash_${shardMonth}_${i}`,
    shardMonth,
    collectedDateJst: "2026-06-01",
    collectedAtJst: "2026-06-01T09:00:00+09:00",
    normalizedAtJst: "2026-06-01T09:00:00+09:00",
    source: "booking",
    sourcePhase: "phase",
    collectorStage: "stage",
    canonicalPropertyName: "prop",
    sourcePropertyName: "prop",
    propertyIdentityMatch: true,
    sourcePropertyId: "pid",
    sourceSlugOrCode: `slug${i}`,
    checkin,
    checkout: checkin,
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: "scope",
    availabilityStatus: "available",
    soldOutStatus: "no",
    normalizedTotalPrice: 10000,
    normalizedTotalPriceSource: "src",
    normalizedTotalPriceBasis: "basis",
    normalizedTotalPriceConfidence: "A",
    basisConfidence: "A",
    basisNote: "",
    sourcePrimaryPrice: 10000,
    sourceSecondaryPriceOrAdder: null,
    sourceComputedTotal: 10000,
    sourceTaxOrFeeClassification: "included",
    sourceClassification: "official",
    isPriceUsableForDpDirect: true,
    isPriceUsableForDpDirectional: false,
    isPriceExcludedFromDp: false,
    dpExclusionReason: null,
    warningFlags: "",
    sourceReportPath: "",
    sourceCsvPath: "",
    debugArtifactPath: "",
    schemaVersion: HISTORY_SCHEMA_VERSION
  };
  return { ...base, ...over };
}

function sourceShard(shardMonth: string, n: number): { shardMonth: string; csv: string } {
  const rows = Array.from({ length: n }, (_, i) => makeRow(shardMonth, i));
  return { shardMonth, csv: renderHistoryCsv(rows) };
}

const tmpDirs: string[] = [];
function makeHistoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m06x-"));
  tmpDirs.push(dir);
  return join(dir, "history");
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const allPassGate: RealAppendGateInput = {
  explicitUserApproved: true,
  envRealHistoryAppend: "1",
  m03xDecision: "local_history_append_dry_run_ready",
  m04xDecision: "local_history_append_validation_policy_ready",
  m05xDecision: "local_history_real_append_proposal_ready",
  hashConflictCount: 0,
  schemaValid: true,
  shardIntegrityPassed: true,
  forbiddenColumnErrors: 0,
  dbWriteMode: false,
  githubActionsMode: false
};

const allowedGate: RealAppendGateResult = { realAppendAllowed: true, failedConditions: [] };

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

describe("Phase M06X — approval gate", () => {
  it("(1) false without explicit user approval", () => {
    const r = evaluateRealAppendGate({ ...allPassGate, explicitUserApproved: false });
    expect(r.realAppendAllowed).toBe(false);
    expect(r.failedConditions).toContain("explicitUserApproved!=true");
  });

  it("(2) false without REAL_HISTORY_APPEND=1", () => {
    expect(evaluateRealAppendGate({ ...allPassGate, envRealHistoryAppend: undefined }).realAppendAllowed).toBe(false);
    expect(evaluateRealAppendGate({ ...allPassGate, envRealHistoryAppend: "0" }).realAppendAllowed).toBe(false);
    expect(evaluateRealAppendGate({ ...allPassGate, envRealHistoryAppend: "1" }).realAppendAllowed).toBe(true);
  });

  it("(3) true only with approval + env + ready decisions + clean gates", () => {
    const r = evaluateRealAppendGate(allPassGate);
    expect(r.realAppendAllowed).toBe(true);
    expect(r.failedConditions).toHaveLength(0);
  });

  it("(4) missing M03X/M04X/M05X decision blocks the gate", () => {
    expect(evaluateRealAppendGate({ ...allPassGate, m03xDecision: "x" }).failedConditions).toContain("m03xDecision!=ready");
    expect(evaluateRealAppendGate({ ...allPassGate, m04xDecision: "x" }).failedConditions).toContain("m04xDecision!=ready");
    expect(evaluateRealAppendGate({ ...allPassGate, m05xDecision: "x" }).failedConditions).toContain("m05xDecision!=ready");
  });

  it("false on conflicts / invalid schema / shard integrity / forbidden / db / gha", () => {
    expect(evaluateRealAppendGate({ ...allPassGate, hashConflictCount: 1 }).realAppendAllowed).toBe(false);
    expect(evaluateRealAppendGate({ ...allPassGate, schemaValid: false }).realAppendAllowed).toBe(false);
    expect(evaluateRealAppendGate({ ...allPassGate, shardIntegrityPassed: false }).realAppendAllowed).toBe(false);
    expect(evaluateRealAppendGate({ ...allPassGate, forbiddenColumnErrors: 2 }).realAppendAllowed).toBe(false);
    expect(evaluateRealAppendGate({ ...allPassGate, dbWriteMode: true }).realAppendAllowed).toBe(false);
    expect(evaluateRealAppendGate({ ...allPassGate, githubActionsMode: true }).realAppendAllowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe("Phase M06X — preflight", () => {
  const sixShards = Object.entries(EXPECTED_SHARD_ROW_COUNTS).map(([m, n]) => sourceShard(m, n));

  it("passes for the six expected shards with matching counts (total=145)", () => {
    const r = runPreflight({
      gate: allowedGate,
      sourceShards: sixShards,
      expectedCountsByShard: EXPECTED_SHARD_ROW_COUNTS,
      expectedTotalRows: EXPECTED_TOTAL_ROWS
    });
    expect(r.ok).toBe(true);
    expect(r.totalIncomingRows).toBe(145);
    expect(r.failedChecks).toHaveLength(0);
  });

  it("(5) gate-blocking hash conflicts block preflight", () => {
    const blocked = evaluateRealAppendGate({ ...allPassGate, hashConflictCount: 3 });
    const r = runPreflight({
      gate: blocked,
      sourceShards: sixShards,
      expectedCountsByShard: EXPECTED_SHARD_ROW_COUNTS,
      expectedTotalRows: EXPECTED_TOTAL_ROWS
    });
    expect(r.ok).toBe(false);
    expect(r.failedChecks.some((c) => c.startsWith("gate_not_allowed"))).toBe(true);
  });

  it("(6) schema-invalid source shard blocks preflight", () => {
    const badHeader = "wrong_col\n" + "x\n";
    const r = runPreflight({
      gate: allowedGate,
      sourceShards: [{ shardMonth: "2026_05", csv: badHeader }],
      expectedCountsByShard: { "2026_05": 1 },
      expectedTotalRows: 1
    });
    expect(r.ok).toBe(false);
    expect(r.schemaValid).toBe(false);
  });

  it("count mismatch blocks preflight", () => {
    const r = runPreflight({
      gate: allowedGate,
      sourceShards: [sourceShard("2026_05", 5)],
      expectedCountsByShard: { "2026_05": 2 },
      expectedTotalRows: 2
    });
    expect(r.ok).toBe(false);
    expect(r.countMismatches.length).toBeGreaterThan(0);
  });

  it("(7) target plan covers exactly six expected files", () => {
    expect(Object.keys(EXPECTED_SHARD_ROW_COUNTS)).toEqual([
      "2026_05",
      "2026_06",
      "2026_07",
      "2026_08",
      "2026_10",
      "2026_12"
    ]);
    expect(Object.values(EXPECTED_SHARD_ROW_COUNTS).reduce((a, b) => a + b, 0)).toBe(145);
  });
});

// ---------------------------------------------------------------------------
// Write engine
// ---------------------------------------------------------------------------

describe("Phase M06X — write engine", () => {
  it("(8) first-run write creates six shard files from sources", () => {
    const historyDir = makeHistoryDir();
    const shards = Object.keys(EXPECTED_SHARD_ROW_COUNTS).map((m) => sourceShard(m, 2));
    const r = runRealAppend({ historyDir, runId: "run1", backupTimestamp: "20260602_120000", sourceShards: shards });
    expect(r.decision).toBe("local_history_real_append_success");
    expect(r.filesCreated).toBe(6);
    for (const m of Object.keys(EXPECTED_SHARD_ROW_COUNTS)) {
      expect(existsSync(join(historyDir, `zao_signals_${m}.csv`))).toBe(true);
    }
    expect(r.rowsWritten).toBe(12);
  });

  it("(9) an existing target file triggers a backup", () => {
    const historyDir = makeHistoryDir();
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, "zao_signals_2026_06.csv"), renderHistoryCsv([makeRow("2026_06", 0)]), "utf8");
    const r = runRealAppend({
      historyDir,
      runId: "run2",
      backupTimestamp: "20260602_120000",
      sourceShards: [sourceShard("2026_06", 3)]
    });
    expect(r.decision).toBe("local_history_real_append_success");
    expect(r.backupsCreated).toBe(1);
    const backup = r.shardActions[0]!.backupPath;
    expect(backup).not.toBe("");
    expect(existsSync(backup)).toBe(true);
  });

  it("(10) existing identical rows dedupe without duplicate row_id", () => {
    const historyDir = makeHistoryDir();
    mkdirSync(historyDir, { recursive: true });
    const rows = [makeRow("2026_06", 0), makeRow("2026_06", 1)];
    writeFileSync(join(historyDir, "zao_signals_2026_06.csv"), renderHistoryCsv(rows), "utf8");
    const r = runRealAppend({
      historyDir,
      runId: "run3",
      backupTimestamp: "20260602_120000",
      sourceShards: [{ shardMonth: "2026_06", csv: renderHistoryCsv(rows) }]
    });
    expect(r.decision).toBe("local_history_real_append_success");
    expect(r.rowsWritten).toBe(0);
    expect(r.rowsSkippedDuplicate).toBe(2);
    const finalRows = parseShardRows(readFileSync(join(historyDir, "zao_signals_2026_06.csv"), "utf8"));
    expect(finalRows).toHaveLength(2);
    expect(new Set(finalRows.map((x) => x.rowId)).size).toBe(2);
  });

  it("(11) same row_id with a different hash blocks the write", () => {
    const historyDir = makeHistoryDir();
    mkdirSync(historyDir, { recursive: true });
    const existing = renderHistoryCsv([makeRow("2026_06", 0, { rowId: "X", rowHash: "H1" })]);
    const targetPath = join(historyDir, "zao_signals_2026_06.csv");
    writeFileSync(targetPath, existing, "utf8");
    const r = runRealAppend({
      historyDir,
      runId: "run4",
      backupTimestamp: "20260602_120000",
      sourceShards: [{ shardMonth: "2026_06", csv: renderHistoryCsv([makeRow("2026_06", 0, { rowId: "X", rowHash: "H2" })]) }]
    });
    expect(r.decision).toBe("local_history_real_append_failed_write");
    expect(r.rowsConflict).toBeGreaterThan(0);
    // Original file untouched.
    expect(readFileSync(targetPath, "utf8")).toBe(existing);
    // Lock released.
    expect(existsSync(join(historyDir, APPEND_LOCK_FILENAME))).toBe(false);
  });

  it("(12) uses temp-file write + atomic rename and leaves no temp residue", () => {
    const historyDir = makeHistoryDir();
    const r = runRealAppend({
      historyDir,
      runId: "run5",
      backupTimestamp: "20260602_120000",
      sourceShards: [sourceShard("2026_05", 2)]
    });
    expect(r.decision).toBe("local_history_real_append_success");
    expect(existsSync(join(historyDir, ".tmp"))).toBe(false);
    expect(SERVICE_SOURCE).toMatch(/renameSync/u);
    expect(SERVICE_SOURCE).toMatch(/\.tmp/u);
  });

  it("(13) append lock is created and removed", () => {
    const historyDir = makeHistoryDir();
    const r = runRealAppend({
      historyDir,
      runId: "run6",
      backupTimestamp: "20260602_120000",
      sourceShards: [sourceShard("2026_05", 2)]
    });
    expect(r.lockAcquired).toBe(true);
    expect(r.lockRemoved).toBe(true);
    expect(existsSync(join(historyDir, APPEND_LOCK_FILENAME))).toBe(false);
  });

  it("(14) a fresh existing lock blocks the write", () => {
    const historyDir = makeHistoryDir();
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, APPEND_LOCK_FILENAME), "other-run\n", "utf8");
    const r = runRealAppend({
      historyDir,
      runId: "run7",
      backupTimestamp: "20260602_120000",
      sourceShards: [sourceShard("2026_05", 2)]
    });
    expect(r.decision).toBe("local_history_real_append_failed_preflight");
    expect(existsSync(join(historyDir, "zao_signals_2026_05.csv"))).toBe(false);
  });

  it("(15) stale lock policy is explicit and a stale lock is cleared", () => {
    expect(STALE_LOCK_THRESHOLD_MINUTES).toBe(30);
    expect(isLockStale(31 * 60_000)).toBe(true);
    expect(isLockStale(10 * 60_000)).toBe(false);

    const historyDir = makeHistoryDir();
    mkdirSync(historyDir, { recursive: true });
    const lockPath = join(historyDir, APPEND_LOCK_FILENAME);
    writeFileSync(lockPath, "stale-run\n", "utf8");
    // Backdate the lock mtime by an hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(lockPath, oneHourAgo, oneHourAgo);
    const r = runRealAppend({
      historyDir,
      runId: "run8",
      backupTimestamp: "20260602_120000",
      sourceShards: [sourceShard("2026_05", 2)]
    });
    expect(r.decision).toBe("local_history_real_append_success");
  });

  it("(18) rollback removes newly created files on failure", () => {
    const historyDir = makeHistoryDir();
    const r = runRealAppend({
      historyDir,
      runId: "run9",
      backupTimestamp: "20260602_120000",
      sourceShards: [sourceShard("2026_05", 2), sourceShard("2026_06", 2)],
      failWriteForShard: "2026_06"
    });
    expect(r.decision).toBe("local_history_real_append_failed_rolled_back");
    expect(existsSync(join(historyDir, "zao_signals_2026_05.csv"))).toBe(false);
    expect(existsSync(join(historyDir, "zao_signals_2026_06.csv"))).toBe(false);
    expect(existsSync(join(historyDir, APPEND_LOCK_FILENAME))).toBe(false);
  });

  it("(19) rollback restores backups on failure", () => {
    const historyDir = makeHistoryDir();
    mkdirSync(historyDir, { recursive: true });
    const original = renderHistoryCsv([makeRow("2026_05", 0)]);
    const targetA = join(historyDir, "zao_signals_2026_05.csv");
    writeFileSync(targetA, original, "utf8");
    const r = runRealAppend({
      historyDir,
      runId: "run10",
      backupTimestamp: "20260602_120000",
      sourceShards: [sourceShard("2026_05", 3), sourceShard("2026_06", 2)],
      failWriteForShard: "2026_06"
    });
    expect(r.decision).toBe("local_history_real_append_failed_rolled_back");
    // Existing file restored to its original content.
    expect(readFileSync(targetA, "utf8")).toBe(original);
    // Newly created file removed.
    expect(existsSync(join(historyDir, "zao_signals_2026_06.csv"))).toBe(false);
  });

  it("idempotent re-run writes nothing new the second time", () => {
    const historyDir = makeHistoryDir();
    const shards = [sourceShard("2026_05", 2), sourceShard("2026_06", 3)];
    const first = runRealAppend({ historyDir, runId: "r1", backupTimestamp: "ts1", sourceShards: shards });
    expect(first.rowsWritten).toBe(5);
    const second = runRealAppend({ historyDir, runId: "r2", backupTimestamp: "ts2", sourceShards: shards });
    expect(second.decision).toBe("local_history_real_append_success");
    expect(second.rowsWritten).toBe(0);
    expect(second.rowsSkippedDuplicate).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Post-write validation
// ---------------------------------------------------------------------------

describe("Phase M06X — post-write validation", () => {
  it("passes for a well-formed shard with the expected row count", () => {
    const csv = renderHistoryCsv([makeRow("2026_05", 0), makeRow("2026_05", 1)]);
    const r = validatePostWriteShards([{ fileName: "zao_signals_2026_05.csv", csv, expectedRowCount: 2 }]);
    expect(r.ok).toBe(true);
  });

  it("(16) fails on duplicate row_id", () => {
    const dup = makeRow("2026_05", 0, { rowId: "DUP" });
    const csv = renderHistoryCsv([dup, { ...dup }]);
    const r = validatePostWriteShards([{ fileName: "zao_signals_2026_05.csv", csv, expectedRowCount: 2 }]);
    expect(r.ok).toBe(false);
    expect(r.results[0]!.duplicateRowIds).toContain("DUP");
  });

  it("(17) fails on a forbidden column", () => {
    const csv = [HISTORY_CSV_HEADERS.join(",") + ",roomid", "a,b"].join("\n") + "\n";
    const r = validatePostWriteShards([{ fileName: "zao_signals_2026_05.csv", csv, expectedRowCount: 1 }]);
    expect(r.ok).toBe(false);
  });

  it("fails when row count does not match expectation", () => {
    const csv = renderHistoryCsv([makeRow("2026_05", 0)]);
    const r = validatePostWriteShards([{ fileName: "zao_signals_2026_05.csv", csv, expectedRowCount: 5 }]);
    expect(r.ok).toBe(false);
    expect(r.results[0]!.rowCountMatches).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSV renderer
// ---------------------------------------------------------------------------

describe("Phase M06X — write-action CSV", () => {
  it("(20) has the expected header and shape", () => {
    const historyDir = makeHistoryDir();
    const r = runRealAppend({ historyDir, runId: "runCsv", backupTimestamp: "ts", sourceShards: [sourceShard("2026_05", 2)] });
    const csv = renderWriteActionCsv("runCsv", r.shardActions);
    expect(csv.split("\n")[0]).toBe(WRITE_ACTION_CSV_HEADERS.join(","));
    expect(csv).toMatch(/zao_signals_2026_05\.csv/u);
    expect(csv).toMatch(/success/u);
  });
});

// ---------------------------------------------------------------------------
// Source scans
// ---------------------------------------------------------------------------

describe("Phase M06X — source scans", () => {
  it("(21) no DB writing code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/better-sqlite3/u);
      expect(src).not.toMatch(/INSERT\s+INTO/iu);
      expect(src).not.toMatch(/collector_runs|rate_snapshots|inventory_snapshots/u);
    }
  });

  it("(22) no GitHub Actions / GitOps files are created", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\.github\/workflows/u);
      expect(src).not.toMatch(/git\s+commit|git\s+push/u);
    }
  });

  it("(23) no collector re-run occurs", () => {
    expect(SCRIPT_SOURCE).toMatch(/Do not re-run collectors/u);
    expect(SCRIPT_SOURCE).not.toMatch(/runJalan|runRakuten|collect:mvp|playwright/u);
  });

  it("(24) no synthetic base × 1.1 logic exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\*\s*1\.1/u);
    }
  });

  it("(25) real-run script requires REAL_HISTORY_APPEND", () => {
    expect(SCRIPT_SOURCE).toMatch(/REAL_HISTORY_APPEND/u);
    expect(SCRIPT_SOURCE).toMatch(/process\.env\.REAL_HISTORY_APPEND/u);
  });

  it("(26) explicit approval constant is checked", () => {
    expect(SCRIPT_SOURCE).toMatch(/EXPLICIT_USER_APPROVED/u);
    expect(SCRIPT_SOURCE).toMatch(/explicitUserApproved:\s*EXPLICIT_USER_APPROVED/u);
  });

  it("(27) write target is limited to .data/history/zao_signals_YYYY_MM.csv", () => {
    expect(SERVICE_SOURCE).toMatch(/zao_signals_\$\{shardMonth\}\.csv/u);
    // Script never targets a writeFileSync directly at .data/history; all history
    // writes flow through the engine's shard path builder.
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/u);
  });
});

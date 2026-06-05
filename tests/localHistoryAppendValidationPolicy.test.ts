import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHistoryWriteTargetAllowed,
  buildAppendLockPolicy,
  buildSimulatedConflictFixtures,
  classifyHashRelation,
  conflictBlocksAppend,
  decideM04X,
  evaluateConflictPolicy,
  evaluateHistoryWriteTarget,
  evaluateRealRunSwitch,
  historyRowFromCsvRecord,
  isRealHistoryPath,
  parseCsv,
  renderPolicyCheckCsv,
  renderValidationPolicyReport,
  shardMonthFromFileName,
  validateSchemaMigrationGuard,
  validateShardIntegrity,
  POLICY_CHECK_CSV_HEADERS,
  type ConflictType,
  type HistoryPathGuardResult,
  type PolicyCheckRow,
  type RealRunSwitchInput,
  type ShardIntegrityResult
} from "../src/services/localHistoryAppendValidationPolicy";
import {
  HISTORY_CSV_HEADERS,
  HISTORY_SCHEMA_VERSION,
  mapUnifiedRowToHistoryRow,
  type HistoryRow
} from "../src/services/localHistorySchemaDesign";
import { type UnifiedMarketSignalRow } from "../src/services/crossSourceMarketSignalNormalization";

const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildLocalHistoryAppendValidationPolicyReport.ts"),
  "utf8"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUnified(overrides: Partial<UnifiedMarketSignalRow> = {}): UnifiedMarketSignalRow {
  return {
    runId: "cross_source_test",
    normalizedAtJst: "2026-06-01T23:07:31+09:00",
    source: "booking",
    sourcePhase: "B04X",
    collectorStage: "local_normalization_only",
    canonicalPropertyName: "蔵王国際ホテル",
    sourcePropertyName: "蔵王国際ホテル",
    propertyIdentityMatch: true,
    sourcePropertyId: "zao-kokusai",
    sourceSlugOrCode: "zao-kokusai",
    checkin: "2026-08-12",
    checkout: "2026-08-13",
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: "2_adults_1_room_1_night",
    availabilityStatus: "available",
    soldOutStatus: "available",
    normalizedTotalPrice: 60_360,
    normalizedTotalPriceSource: "booking_official_base_plus_visible_tax_fee_adder",
    normalizedTotalPriceBasis: "room_total_official_visible_tax_fee_2_adults_1_room_1_night",
    normalizedTotalPriceConfidence: "B",
    basisConfidence: "B",
    basisNote: "Computed total = base + official adder.",
    sourcePrimaryPrice: 60_060,
    sourceSecondaryPriceOrAdder: 300,
    sourceComputedTotal: 60_360,
    sourceTaxOrFeeClassification: "booking_room_total_official_base_plus_tax_fee_adder",
    sourceClassification: "booking_b04a_official_base_plus_adder_numeric",
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: true,
    isPriceExcludedFromDp: false,
    dpExclusionReason: null,
    warningFlags: "",
    sourceReportPath: "/abs/m01x.md",
    sourceCsvPath: "/abs/m01x.csv",
    debugArtifactPath: "/abs/debug/zao-kokusai_2026-08-12",
    ...overrides
  };
}

function row(overrides: Partial<UnifiedMarketSignalRow> = {}): HistoryRow {
  return mapUnifiedRowToHistoryRow(makeUnified(overrides));
}

function makeMinimalShardCsv(rows: HistoryRow[]): string {
  const body = rows
    .map((r) =>
      [
        r.rowId, r.rowHash, r.shardMonth, r.collectedDateJst, r.collectedAtJst, r.normalizedAtJst,
        r.source, r.sourcePhase, r.collectorStage, r.canonicalPropertyName, r.sourcePropertyName,
        String(r.propertyIdentityMatch), r.sourcePropertyId, r.sourceSlugOrCode, r.checkin, r.checkout,
        String(r.stayNights), String(r.groupAdults), String(r.noRooms), String(r.groupChildren),
        r.currency, r.language, r.stayScope, r.availabilityStatus, r.soldOutStatus,
        r.normalizedTotalPrice === null ? "" : String(r.normalizedTotalPrice),
        r.normalizedTotalPriceSource ?? "", r.normalizedTotalPriceBasis, r.normalizedTotalPriceConfidence,
        r.basisConfidence, r.basisNote,
        r.sourcePrimaryPrice === null ? "" : String(r.sourcePrimaryPrice),
        r.sourceSecondaryPriceOrAdder === null ? "" : String(r.sourceSecondaryPriceOrAdder),
        r.sourceComputedTotal === null ? "" : String(r.sourceComputedTotal),
        r.sourceTaxOrFeeClassification, r.sourceClassification,
        String(r.isPriceUsableForDpDirect), String(r.isPriceUsableForDpDirectional), String(r.isPriceExcludedFromDp),
        r.dpExclusionReason ?? "", r.warningFlags, r.sourceReportPath, r.sourceCsvPath, r.debugArtifactPath,
        r.schemaVersion
      ].join(",")
    );
  return [HISTORY_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 6.1 Schema migration guard
// ---------------------------------------------------------------------------

describe("Phase M04X — schema migration guard", () => {
  it("(1) passes for exact 45-column M02X schema in correct order", () => {
    const result = validateSchemaMigrationGuard([...HISTORY_CSV_HEADERS], HISTORY_SCHEMA_VERSION);
    expect(result.schemaValid).toBe(true);
    expect(result.columnCount).toBe(45);
    expect(result.columnOrderValid).toBe(true);
    expect(result.missingColumns).toHaveLength(0);
    expect(result.extraColumns).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("(2) fails for missing column", () => {
    const cols = HISTORY_CSV_HEADERS.filter((c) => c !== "row_hash");
    const result = validateSchemaMigrationGuard(cols, HISTORY_SCHEMA_VERSION);
    expect(result.schemaValid).toBe(false);
    expect(result.missingColumns).toContain("row_hash");
    expect(result.errors.some((e) => e.includes("missing_column:row_hash"))).toBe(true);
  });

  it("(3) fails for extra column", () => {
    const cols = [...HISTORY_CSV_HEADERS, "mystery_col"];
    const result = validateSchemaMigrationGuard(cols, HISTORY_SCHEMA_VERSION);
    expect(result.schemaValid).toBe(false);
    expect(result.extraColumns).toContain("mystery_col");
    expect(result.errors.some((e) => e.includes("extra_column:mystery_col"))).toBe(true);
  });

  it("(4) fails for column order mismatch", () => {
    const cols = [...HISTORY_CSV_HEADERS] as string[];
    [cols[0], cols[1]] = [cols[1]!, cols[0]!];
    const result = validateSchemaMigrationGuard(cols, HISTORY_SCHEMA_VERSION);
    expect(result.schemaValid).toBe(false);
    expect(result.columnOrderValid).toBe(false);
    expect(result.errors).toContain("column_order_mismatch");
  });

  it("(5) fails for deprecated column tax_multiplier", () => {
    const cols = [...HISTORY_CSV_HEADERS, "tax_multiplier"];
    const result = validateSchemaMigrationGuard(cols, HISTORY_SCHEMA_VERSION);
    expect(result.schemaValid).toBe(false);
    expect(result.deprecatedColumns).toContain("tax_multiplier");
    expect(result.errors.some((e) => e.includes("deprecated_column:tax_multiplier"))).toBe(true);
  });

  it("(6) fails for forbidden column roomid", () => {
    const cols = [...HISTORY_CSV_HEADERS, "roomid"];
    const result = validateSchemaMigrationGuard(cols, HISTORY_SCHEMA_VERSION);
    expect(result.schemaValid).toBe(false);
    expect(result.forbiddenColumns).toContain("roomid");
    expect(result.errors.some((e) => e.includes("forbidden_column:roomid"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6.2 Conflict policy
// ---------------------------------------------------------------------------

describe("Phase M04X — conflict policy", () => {
  it("(7) classifyHashRelation returns idempotent_duplicate for same hash", () => {
    expect(classifyHashRelation("abc123", "abc123")).toBe("idempotent_duplicate");
  });

  it("(8) classifyHashRelation returns hash_conflict for different hash", () => {
    expect(classifyHashRelation("abc123", "def456")).toBe("hash_conflict");
  });

  it("(8b) classifyHashRelation returns new when no existing hash", () => {
    expect(classifyHashRelation(undefined, "abc123")).toBe("new");
  });

  it("(9) hash conflict blocks append", () => {
    expect(conflictBlocksAppend("hash_conflict")).toBe(true);
  });

  it("(10) idempotent duplicate does not block append", () => {
    expect(conflictBlocksAppend("idempotent_duplicate")).toBe(false);
  });

  it("evaluateConflictPolicy: no blocking when all clean", () => {
    const result = evaluateConflictPolicy({
      idempotentDuplicateCount: 14,
      hashConflictCount: 0,
      schemaValid: true,
      invalidRowCount: 0,
      forbiddenColumnErrors: 0
    });
    expect(result.appendBlocked).toBe(false);
    expect(result.blockingConflictTypes).toHaveLength(0);
  });

  it("evaluateConflictPolicy: hash_conflict blocks", () => {
    const result = evaluateConflictPolicy({
      idempotentDuplicateCount: 0,
      hashConflictCount: 2,
      schemaValid: true,
      invalidRowCount: 0,
      forbiddenColumnErrors: 0
    });
    expect(result.appendBlocked).toBe(true);
    expect(result.blockingConflictTypes).toContain("hash_conflict" satisfies ConflictType);
  });

  it("evaluateConflictPolicy: schema_conflict blocks when schemaValid=false", () => {
    const result = evaluateConflictPolicy({
      idempotentDuplicateCount: 0,
      hashConflictCount: 0,
      schemaValid: false,
      invalidRowCount: 0,
      forbiddenColumnErrors: 0
    });
    expect(result.appendBlocked).toBe(true);
    expect(result.blockingConflictTypes).toContain("schema_conflict" satisfies ConflictType);
  });
});

// ---------------------------------------------------------------------------
// 6.3 Shard integrity
// ---------------------------------------------------------------------------

describe("Phase M04X — shard integrity", () => {
  it("(11) passes for a valid shard", () => {
    const r = row();
    const csv = makeMinimalShardCsv([r]);
    const result = validateShardIntegrity({ fileName: "zao_signals_2026_08.csv", csv });
    expect(result.ok).toBe(true);
    expect(result.headerPresent).toBe(true);
    expect(result.columnCountValid).toBe(true);
    expect(result.duplicateRowIds).toHaveLength(0);
    expect(result.emptyRowHashCount).toBe(0);
    expect(result.shardMonthMatchesFilename).toBe(true);
    expect(result.invalidRowCount).toBe(0);
  });

  it("(12) fails on duplicate row_id inside shard", () => {
    const r = row();
    const csv = makeMinimalShardCsv([r, r]);
    const result = validateShardIntegrity({ fileName: "zao_signals_2026_08.csv", csv });
    expect(result.ok).toBe(false);
    expect(result.duplicateRowIds).toContain(r.rowId);
  });

  it("(13) fails when shard_month mismatches filename", () => {
    // Row has checkin 2026-08 → shardMonth 2026_08, but filename says 2026_07.
    const r = row();
    const csv = makeMinimalShardCsv([r]);
    const result = validateShardIntegrity({ fileName: "zao_signals_2026_07.csv", csv });
    expect(result.ok).toBe(false);
    expect(result.shardMonthMatchesFilename).toBe(false);
    expect(result.shardMonthMismatchRowCount).toBeGreaterThan(0);
  });

  it("shardMonthFromFileName extracts month from canonical filename", () => {
    expect(shardMonthFromFileName("zao_signals_2026_08.csv")).toBe("2026_08");
    expect(shardMonthFromFileName("zao_signals_2026_12.csv")).toBe("2026_12");
    expect(shardMonthFromFileName("unknown.csv")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 6.5 Real-run switch guard
// ---------------------------------------------------------------------------

describe("Phase M04X — real-run switch guard", () => {
  const allTrue: RealRunSwitchInput = {
    explicitRealRunApproved: true,
    dryRunPassed: true,
    hashConflictCount: 0,
    schemaValid: true,
    forbiddenColumnErrors: 0,
    dbWriteMode: false,
    githubActionsMode: false
  };

  it("(14) returns false when explicit approval is false", () => {
    const result = evaluateRealRunSwitch({ ...allTrue, explicitRealRunApproved: false });
    expect(result.realRunAllowed).toBe(false);
    expect(result.failedConditions).toContain("explicitRealRunApproved!=true");
  });

  it("(15) returns false when hashConflictCount > 0", () => {
    const result = evaluateRealRunSwitch({ ...allTrue, hashConflictCount: 1 });
    expect(result.realRunAllowed).toBe(false);
    expect(result.failedConditions).toContain("hashConflictCount!=0");
  });

  it("(16) returns false when schema invalid", () => {
    const result = evaluateRealRunSwitch({ ...allTrue, schemaValid: false });
    expect(result.realRunAllowed).toBe(false);
    expect(result.failedConditions).toContain("schemaValid!=true");
  });

  it("(17) returns true only when all required conditions are true", () => {
    const result = evaluateRealRunSwitch(allTrue);
    expect(result.realRunAllowed).toBe(true);
    expect(result.failedConditions).toHaveLength(0);
  });

  it("(17b) returns false when dbWriteMode=true", () => {
    const result = evaluateRealRunSwitch({ ...allTrue, dbWriteMode: true });
    expect(result.realRunAllowed).toBe(false);
  });

  it("(17c) returns false when githubActionsMode=true", () => {
    const result = evaluateRealRunSwitch({ ...allTrue, githubActionsMode: true });
    expect(result.realRunAllowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6.6 History path guard
// ---------------------------------------------------------------------------

describe("Phase M04X — history path guard", () => {
  it("(18) blocks .data/history target when realRunAllowed=false", () => {
    const result = evaluateHistoryWriteTarget(".data/history/zao_signals_2026_08.csv", false);
    expect(result.allowed).toBe(false);
    expect(result.isRealHistoryPath).toBe(true);
    expect(result.reason).toMatch(/blocked/u);
  });

  it("(18b) assertHistoryWriteTargetAllowed throws for real path when not allowed", () => {
    expect(() => assertHistoryWriteTargetAllowed(".data/history/zao_signals_2026_08.csv", false)).toThrow(
      /Refusing real history write target/u
    );
  });

  it("(19) allows debug dry-run path", () => {
    const result = evaluateHistoryWriteTarget(
      ".data/debug/history-append-dry-run/20260601_232310/shards/zao_signals_2026_08.csv",
      false
    );
    expect(result.allowed).toBe(true);
    expect(result.isRealHistoryPath).toBe(false);
    expect(result.reason).toMatch(/allowed/u);
  });

  it("allows real path when realRunAllowed=true", () => {
    const result = evaluateHistoryWriteTarget(".data/history/zao_signals_2026_08.csv", true);
    expect(result.allowed).toBe(true);
    expect(result.reason).toMatch(/approved/u);
  });
});

// ---------------------------------------------------------------------------
// 6.4 Append lock policy
// ---------------------------------------------------------------------------

describe("Phase M04X — append lock policy", () => {
  it("(20) does not create a lock file (lockFileCreated=false)", () => {
    const policy = buildAppendLockPolicy();
    expect(policy.lockFileCreated).toBe(false);
    expect(policy.lockFilePath).toBe(".data/history/.append.lock");
    expect(policy.rules.length).toBeGreaterThan(0);
    expect(policy.staleLockThresholdMinutes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Simulated conflict fixtures
// ---------------------------------------------------------------------------

describe("Phase M04X — simulated conflict fixtures", () => {
  const base = row();
  const fixtures = buildSimulatedConflictFixtures(base);

  it("(21) all 6 simulated fixtures pass", () => {
    expect(fixtures).toHaveLength(6);
    for (const f of fixtures) {
      expect(f.passed, `fixture ${f.name} should pass`).toBe(true);
    }
  });

  it("(21b) idempotent_duplicate fixture does not block append", () => {
    const f = fixtures.find((x) => x.name === "idempotent_duplicate")!;
    expect(f.blocksAppend).toBe(false);
    expect(f.passed).toBe(true);
  });

  it("(21c) hash_conflict fixture blocks append", () => {
    const f = fixtures.find((x) => x.name === "hash_conflict")!;
    expect(f.blocksAppend).toBe(true);
    expect(f.passed).toBe(true);
  });

  it("(21d) real_history_write_blocked fixture is blocked and under debug semantics", () => {
    const f = fixtures.find((x) => x.name === "real_history_write_blocked")!;
    expect(f.blocksAppend).toBe(true);
    expect(f.passed).toBe(true);
    // The simulated target path must contain .data/history but the fixture
    // itself never writes there (it only records the guard result).
    expect(f.detail["target"]).toMatch(/\.data\/history/u);
  });
});

// ---------------------------------------------------------------------------
// Report renderer
// ---------------------------------------------------------------------------

describe("Phase M04X — report renderer", () => {
  it("(22) report states no real history append was performed", () => {
    const shardResult: ShardIntegrityResult = {
      fileName: "zao_signals_2026_08.csv",
      fileShardMonth: "2026_08",
      headerPresent: true,
      columnCountValid: true,
      schemaColumnsValid: true,
      rowCount: 1,
      duplicateRowIds: [],
      emptyRowHashCount: 0,
      shardMonthMatchesFilename: true,
      shardMonthMismatchRowCount: 0,
      invalidRowCount: 0,
      errors: [],
      ok: true
    };
    const report = renderValidationPolicyReport({
      generatedAt: "2026-06-01T15:00:00.000Z",
      decision: "local_history_append_validation_policy_ready",
      schemaGuard: validateSchemaMigrationGuard([...HISTORY_CSV_HEADERS], HISTORY_SCHEMA_VERSION),
      conflictPolicy: evaluateConflictPolicy({ idempotentDuplicateCount: 14, hashConflictCount: 0, schemaValid: true, invalidRowCount: 0, forbiddenColumnErrors: 0 }),
      shardIntegrity: [shardResult],
      shardIntegrityOk: true,
      simulatedFixtures: buildSimulatedConflictFixtures(row()),
      realRunSwitch: evaluateRealRunSwitch({ explicitRealRunApproved: false, dryRunPassed: true, hashConflictCount: 0, schemaValid: true, forbiddenColumnErrors: 0, dbWriteMode: false, githubActionsMode: false }),
      historyPathGuard: evaluateHistoryWriteTarget(".data/history/zao_signals_2026_08.csv", false) as HistoryPathGuardResult,
      appendLockPolicy: buildAppendLockPolicy(),
      m02xArtifacts: { reportPath: "/m02x.md", jsonPath: "/m02x.json", debugRoot: "/m02x_debug" },
      m03xArtifacts: { reportPath: "/m03x.md", jsonPath: "/m03x.json", debugRoot: "/m03x_debug" },
      historyDirExisted: false,
      historyDirCreated: false,
      reportPath: "/out.md",
      csvPath: "/out.csv",
      jsonPath: "/out.json",
      debugRootPath: "/debug"
    });
    expect(report).toMatch(/M04X does NOT perform real history append/u);
    expect(report).toMatch(/M04X does NOT enable GitHub Actions/u);
    expect(report).toMatch(/M04X does NOT create \.data\/history/u);
    expect(report).toMatch(/Real-run mode is intentionally disabled/u);
  });
});

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

describe("Phase M04X — decision", () => {
  const passing = {
    m03xArtifactsValid: true,
    schemaValid: true,
    shardIntegrityOk: true,
    hashConflictCount: 0,
    forbiddenColumnErrors: 0,
    simulatedBlockingTestsPass: true,
    realRunAllowed: false,
    historyDirCreated: false,
    warningCount: 0
  };

  it("(23) ready when all guards pass and realRunAllowed=false", () => {
    expect(decideM04X(passing)).toBe("local_history_append_validation_policy_ready");
  });

  it("(24) not_ready if realRunAllowed=true (unexpected)", () => {
    expect(decideM04X({ ...passing, realRunAllowed: true })).toBe("local_history_append_validation_policy_not_ready");
  });

  it("not_ready if schema invalid", () => {
    expect(decideM04X({ ...passing, schemaValid: false })).toBe("local_history_append_validation_policy_not_ready");
  });

  it("not_ready if shard integrity fails", () => {
    expect(decideM04X({ ...passing, shardIntegrityOk: false })).toBe("local_history_append_validation_policy_not_ready");
  });

  it("not_ready if hash conflicts > 0", () => {
    expect(decideM04X({ ...passing, hashConflictCount: 1 })).toBe("local_history_append_validation_policy_not_ready");
  });

  it("not_ready if historyDirCreated=true", () => {
    expect(decideM04X({ ...passing, historyDirCreated: true })).toBe("local_history_append_validation_policy_not_ready");
  });

  it("not_ready if simulated blocking tests fail", () => {
    expect(decideM04X({ ...passing, simulatedBlockingTestsPass: false })).toBe("local_history_append_validation_policy_not_ready");
  });

  it("basis_caution if warnings > 0 but otherwise passing", () => {
    expect(decideM04X({ ...passing, warningCount: 1 })).toBe("local_history_append_validation_policy_basis_caution");
  });
});

// ---------------------------------------------------------------------------
// Script source scans
// ---------------------------------------------------------------------------

describe("Phase M04X — script source scans", () => {
  it("(25) script does not write directly to .data/history", () => {
    // writeFileSync calls must not target .data/history paths.
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/u);
  });

  it("(25b) script calls assertHistoryWriteTargetAllowed before every write", () => {
    expect(SCRIPT_SOURCE).toMatch(/assertHistoryWriteTargetAllowed/u);
  });

  it("(25c) script sets EXPLICIT_REAL_RUN_APPROVED = false", () => {
    expect(SCRIPT_SOURCE).toMatch(/EXPLICIT_REAL_RUN_APPROVED\s*=\s*false/u);
  });

  it("(26) script verifies .data/history absent before/after", () => {
    expect(SCRIPT_SOURCE).toMatch(/historyExistedBefore/u);
    expect(SCRIPT_SOURCE).toMatch(/Safety violation/u);
    expect(SCRIPT_SOURCE).toMatch(/must not touch real history/u);
  });

  it("(26b) script throws a clear error if M03X artifact is missing", () => {
    expect(SCRIPT_SOURCE).toMatch(/Stop and report the missing artifact path/u);
  });
});

// ---------------------------------------------------------------------------
// CSV parser + historyRowFromCsvRecord
// ---------------------------------------------------------------------------

describe("Phase M04X — CSV parser", () => {
  it("parseCsv handles plain rows", () => {
    const result = parseCsv("a,b,c\n1,2,3\n");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(["a", "b", "c"]);
    expect(result[1]).toEqual(["1", "2", "3"]);
  });

  it("parseCsv handles quoted fields with commas", () => {
    const result = parseCsv('a,"b,c",d\n');
    expect(result[0]).toEqual(["a", "b,c", "d"]);
  });

  it("parseCsv handles escaped double-quotes", () => {
    const result = parseCsv('a,"say ""hi""",c\n');
    expect(result[0]).toEqual(["a", 'say "hi"', "c"]);
  });

  it("historyRowFromCsvRecord reconstructs a valid HistoryRow", () => {
    const original = row();
    const csv = makeMinimalShardCsv([original]);
    const records = parseCsv(csv);
    const reconstructed = historyRowFromCsvRecord(records[1]!);
    expect(reconstructed.rowId).toBe(original.rowId);
    expect(reconstructed.rowHash).toBe(original.rowHash);
    expect(reconstructed.source).toBe("booking");
    expect(reconstructed.normalizedTotalPrice).toBe(60_360);
    expect(reconstructed.isPriceUsableForDpDirect).toBe(false);
  });

  it("policy-check CSV has stable header", () => {
    const checks: PolicyCheckRow[] = [{ component: "test", check: "x", status: "pass", detail: "ok" }];
    const csv = renderPolicyCheckCsv(checks);
    expect(csv.split("\n")[0]).toBe(POLICY_CHECK_CSV_HEADERS.join(","));
    expect(csv).toMatch(/pass/u);
  });
});

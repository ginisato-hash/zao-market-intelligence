import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderHistoryCsv,
  HISTORY_SCHEMA_VERSION,
  type HistoryRow
} from "../src/services/localHistorySchemaDesign";
import { runRealAppend } from "../src/services/localHistoryRealAppend";
import {
  B11X_COLLECTOR_STAGE,
  B11X_SOURCE_PHASE,
  buildAppendRowId,
  computeAppendPreflight,
  decideB11XBeforeWrite,
  evaluateBookingAppendGate,
  groupRowsToSourceShards,
  reconstructHistoryRow,
  selectAppendRows,
  validateApprovedHistoryRows,
  type B09XFullRow,
  type B10ZProposalRowLite,
  type ExistingHistoryKey
} from "../src/services/bookingBoundedAppendWithIdentityRealRun";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/bookingBoundedAppendWithIdentityRealRun.ts"),
  "utf8"
);
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/runBookingBoundedAppendWithIdentityRealRun.ts"),
  "utf8"
);

const CTX = { sourceReportPath: "report.md", sourceCsvPath: "report.csv" };
const OBS_ID = "8f1f66a0819dc7f9144489addc49ddabd99e78c72c835c633e3e07514d7d0d8a";

// A directional (B) B09X normalized row. reconstructHistoryRow re-derives row_hash
// with the canonical schema, so policy validation passes without precomputing it.
function makeB09X(over: Partial<B09XFullRow> = {}): B09XFullRow {
  return {
    row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    shard_month: "2026_06",
    collected_date_jst: "2026-06-04",
    collected_at_jst: "2026-06-04T16:16:23+09:00",
    normalized_at_jst: "2026-06-04T16:16:23+09:00",
    canonical_property_name: "蔵王国際ホテル",
    source_property_name: "航空券＋ホテル",
    property_identity_match: true,
    source_property_id: "zao-kokusai",
    source_slug_or_code: "zao-kokusai",
    checkin: "2026-06-14",
    checkout: "2026-06-15",
    stay_nights: 1,
    group_adults: 2,
    no_rooms: 1,
    group_children: 0,
    currency: "JPY",
    language: "ja",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_status: "available",
    normalized_total_price: 33_300,
    normalized_total_price_source: "booking_official_visible_total",
    normalized_total_price_basis: "booking_official_visible_base_plus_tax_fee_adder_2_adults_1_room_1_night",
    normalized_total_price_confidence: "B",
    basis_confidence: "B",
    basis_note: "Booking.com directional total = official visible base price + official visible tax/fee adder.",
    source_primary_price: 33_000,
    source_secondary_price_or_adder: 300,
    source_computed_total: 33_300,
    source_tax_or_fee_classification: "booking_room_total_official_base_plus_tax_fee_adder",
    source_classification: "booking_b04a_official_base_plus_adder_numeric",
    dp_usage: "directional",
    dp_exclusion_reason: null,
    debug_artifact_path: ".data/debug/booking-bounded-expanded-collection/x",
    ...over
  };
}

// An excluded (C) B09X normalized row (different property, no usable total).
function makeExcludedB09X(over: Partial<B09XFullRow> = {}): B09XFullRow {
  return makeB09X({
    row_id: "2026-06-04|booking|蔵王四季のホテル|zao-shiki-no|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    canonical_property_name: "蔵王四季のホテル",
    source_property_id: "zao-shiki-no",
    source_slug_or_code: "zao-shiki-no",
    normalized_total_price: null,
    normalized_total_price_source: null,
    normalized_total_price_confidence: "C",
    basis_confidence: "C",
    source_primary_price: 33_000,
    source_secondary_price_or_adder: null,
    source_computed_total: null,
    source_classification: "booking_b04a_price_basis_unclear",
    dp_usage: "excluded",
    dp_exclusion_reason: "missing_official_tax_fee_adder",
    ...over
  });
}

function proposal(over: Partial<B10ZProposalRowLite> = {}): B10ZProposalRowLite {
  return {
    new_row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    history_action: "append_new",
    append_recommendation: "append_directional",
    observation_id: OBS_ID,
    ...over
  };
}

function directionalRow(): HistoryRow {
  return reconstructHistoryRow(makeB09X(), proposal(), CTX);
}

function excludedRow(): HistoryRow {
  return reconstructHistoryRow(
    makeExcludedB09X(),
    proposal({
      new_row_id: "2026-06-04|booking|蔵王四季のホテル|zao-shiki-no|2026-06-14|2026-06-15|2_adults_1_room_1_night",
      append_recommendation: "append_excluded_audit"
    }),
    CTX
  );
}

// Build a realistic 30-row proposal: 15 append_new + 10 identity-fix + 5 skip.
function realisticProposal(): B10ZProposalRowLite[] {
  const rows: B10ZProposalRowLite[] = [];
  for (let i = 0; i < 13; i += 1) {
    rows.push(proposal({ new_row_id: `new-${i}`, history_action: "append_new", append_recommendation: "append_directional" }));
  }
  for (let i = 0; i < 2; i += 1) {
    rows.push(proposal({ new_row_id: `new-exc-${i}`, history_action: "append_new", append_recommendation: "append_excluded_audit" }));
  }
  for (let i = 0; i < 10; i += 1) {
    rows.push(proposal({ new_row_id: `fix-${i}`, history_action: "append_new_observation_after_identity_fix", append_recommendation: "append_directional" }));
  }
  for (let i = 0; i < 5; i += 1) {
    rows.push(proposal({ new_row_id: `skip-${i}`, history_action: "skip_benign_duplicate", append_recommendation: "skip" }));
  }
  return rows;
}

const tempDirs: string[] = [];
function makeTempHistoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b11x-history-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("BOOKING-B11X — approval gate", () => {
  it("(1) gate is false without the env flag", () => {
    expect(evaluateBookingAppendGate({ approvalSentencePresent: true, envFlag: undefined }).allowed).toBe(false);
  });

  it("(2) gate is true only with approval sentence present AND env flag = 1", () => {
    expect(evaluateBookingAppendGate({ approvalSentencePresent: true, envFlag: "1" }).allowed).toBe(true);
    expect(evaluateBookingAppendGate({ approvalSentencePresent: false, envFlag: "1" }).allowed).toBe(false);
    expect(evaluateBookingAppendGate({ approvalSentencePresent: true, envFlag: "0" }).allowed).toBe(false);
  });
});

describe("BOOKING-B11X — proposal selection", () => {
  it("(3) selects 25 appendable rows (15 append_new + 10 identity-fix), skips 5, blocks 0", () => {
    const { appendRowIds, skippedRowIds, blockedRowIds } = selectAppendRows(realisticProposal());
    expect(appendRowIds).toHaveLength(25);
    expect(skippedRowIds).toHaveLength(5);
    expect(blockedRowIds).toHaveLength(0);
  });

  it("(4) appends append_new + append_directional rows", () => {
    const { appendRowIds } = selectAppendRows([
      proposal({ new_row_id: "a", history_action: "append_new", append_recommendation: "append_directional" })
    ]);
    expect(appendRowIds).toEqual(["a"]);
  });

  it("(5) appends append_new_observation_after_identity_fix rows", () => {
    const { appendRowIds } = selectAppendRows([
      proposal({ new_row_id: "b", history_action: "append_new_observation_after_identity_fix", append_recommendation: "append_directional" })
    ]);
    expect(appendRowIds).toEqual(["b"]);
  });

  it("(6) appends append_excluded_audit rows", () => {
    const { appendRowIds } = selectAppendRows([
      proposal({ new_row_id: "c", history_action: "append_new", append_recommendation: "append_excluded_audit" })
    ]);
    expect(appendRowIds).toEqual(["c"]);
  });

  it("(7) skips skip_benign_duplicate / skip_identical rows", () => {
    const { appendRowIds, skippedRowIds } = selectAppendRows([
      proposal({ new_row_id: "d", history_action: "skip_benign_duplicate", append_recommendation: "skip" }),
      proposal({ new_row_id: "e", history_action: "skip_identical", append_recommendation: "skip" })
    ]);
    expect(appendRowIds).toEqual([]);
    expect(skippedRowIds).toEqual(["d", "e"]);
  });

  it("(8) blocks true-conflict / unknown actions", () => {
    const { appendRowIds, blockedRowIds } = selectAppendRows([
      proposal({ new_row_id: "f", history_action: "block_true_conflict", append_recommendation: "block_until_review" })
    ]);
    expect(appendRowIds).toEqual([]);
    expect(blockedRowIds).toEqual(["f"]);
  });
});

describe("BOOKING-B11X — identity policy row_id", () => {
  it("(9) buildAppendRowId keeps the plain legacy row_id for append_new", () => {
    expect(buildAppendRowId({ legacyRowId: "L", historyAction: "append_new", observationId: OBS_ID })).toBe("L");
  });

  it("(10) buildAppendRowId qualifies the row_id for identity-fix re-observations", () => {
    const id = buildAppendRowId({ legacyRowId: "L", historyAction: "append_new_observation_after_identity_fix", observationId: OBS_ID });
    expect(id).toBe(`L|obs:${OBS_ID.slice(0, 16)}`);
    expect(id).toMatch(/\|obs:[0-9a-f]{16}$/u);
  });

  it("(11) reconstructed identity-fix row carries the qualified row_id", () => {
    const row = reconstructHistoryRow(
      makeB09X({ normalized_total_price: 35_000 }),
      proposal({ history_action: "append_new_observation_after_identity_fix" }),
      CTX
    );
    expect(row.rowId).toMatch(/\|obs:[0-9a-f]{16}$/u);
  });

  it("(12) reconstructed append_new row carries the plain legacy row_id (no qualifier)", () => {
    const row = directionalRow();
    expect(row.rowId).not.toMatch(/\|obs:/u);
    expect(row.rowId.split("|")).toHaveLength(7);
  });
});

describe("BOOKING-B11X — safe append (backup / temp / atomic / rollback)", () => {
  function seed(historyDir: string, shardMonth: string, existing: HistoryRow): void {
    writeFileSync(join(historyDir, `zao_signals_${shardMonth}.csv`), renderHistoryCsv([existing]), "utf8");
  }
  function incomingRow(): HistoryRow {
    return reconstructHistoryRow(
      makeB09X({
        row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-21|2026-06-22|2_adults_1_room_1_night",
        checkin: "2026-06-21",
        checkout: "2026-06-22"
      }),
      proposal({ new_row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-21|2026-06-22|2_adults_1_room_1_night" }),
      CTX
    );
  }

  it("(13) creates backups for touched shards", () => {
    const dir = makeTempHistoryDir();
    seed(dir, "2026_06", directionalRow());
    const result = runRealAppend({ historyDir: dir, runId: "t13", backupTimestamp: "ts13", sourceShards: groupRowsToSourceShards([incomingRow()]) });
    expect(result.decision).toBe("local_history_real_append_success");
    expect(result.backupsCreated).toBe(1);
    expect(existsSync(join(dir, ".backup", "ts13", "zao_signals_2026_06.csv.bak"))).toBe(true);
  });

  it("(14) writes via temp file + atomic rename (no .tmp left behind)", () => {
    const dir = makeTempHistoryDir();
    seed(dir, "2026_06", directionalRow());
    const result = runRealAppend({ historyDir: dir, runId: "t14", backupTimestamp: "ts14", sourceShards: groupRowsToSourceShards([incomingRow()]) });
    expect(result.decision).toBe("local_history_real_append_success");
    expect(existsSync(join(dir, ".tmp"))).toBe(false);
    const rows = readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(rows).toHaveLength(3); // header + 2 rows
  });

  it("(15) rolls back on write failure (target restored)", () => {
    const dir = makeTempHistoryDir();
    seed(dir, "2026_06", directionalRow());
    const original = readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8");
    const result = runRealAppend({
      historyDir: dir,
      runId: "t15",
      backupTimestamp: "ts15",
      sourceShards: groupRowsToSourceShards([incomingRow()]),
      failWriteForShard: "2026_06"
    });
    expect(result.rollbackPerformed).toBe(true);
    expect(readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8")).toBe(original);
  });
});

describe("BOOKING-B11X — preflight & row policy", () => {
  it("(16) preflight reports the expected row-count delta", () => {
    const preflight = computeAppendPreflight([directionalRow(), excludedRow()], [], 160);
    expect(preflight.new_row_count).toBe(2);
    expect(preflight.expected_total_after_append).toBe(162);
  });

  it("(17) identity-fix row coexists with the existing legacy row (no duplicate row_id)", () => {
    const dir = makeTempHistoryDir();
    const existing = directionalRow(); // plain legacy row_id, price 33300
    writeFileSync(join(dir, "zao_signals_2026_06.csv"), renderHistoryCsv([existing]), "utf8");
    const reobs = reconstructHistoryRow(
      makeB09X({ normalized_total_price: 35_000 }),
      proposal({ history_action: "append_new_observation_after_identity_fix" }),
      CTX
    );
    expect(reobs.rowId).not.toBe(existing.rowId);
    runRealAppend({ historyDir: dir, runId: "t17", backupTimestamp: "ts17", sourceShards: groupRowsToSourceShards([reobs]) });
    const ids = readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(1)
      .map((l) => l.split(",")[0]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("(18) reconstructed rows carry schema_version=zao_local_history_v1 and mismatch is flagged", () => {
    const row = directionalRow();
    expect(row.schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
    const v = validateApprovedHistoryRows([{ ...row, schemaVersion: "wrong" }], new Set());
    expect(v.errors.some((e) => e.includes("schema_version_mismatch"))).toBe(true);
  });

  it("(19) validates shard_month matches checkin", () => {
    const v = validateApprovedHistoryRows([{ ...directionalRow(), shardMonth: "2026_09" }], new Set());
    expect(v.errors.some((e) => e.includes("shard_month_mismatch"))).toBe(true);
  });

  it("(20) B rows remain directional price-pressure usable; C rows remain excluded audit; direct count is 0", () => {
    const rows = [directionalRow(), excludedRow()];
    const v = validateApprovedHistoryRows(rows, new Set());
    expect(v.ok).toBe(true);
    expect(v.directionalCount).toBe(1);
    expect(v.excludedCount).toBe(1);
    expect(v.directCount).toBe(0);
    expect(rows.every((r) => r.isPriceUsableForDpDirect === false)).toBe(true);
    const b = rows[0]!;
    expect(b.isPriceUsableForDpDirectional).toBe(true);
    expect(b.normalizedTotalPrice).not.toBeNull();
    const c = rows[1]!;
    expect(c.isPriceExcludedFromDp).toBe(true);
    expect(c.dpExclusionReason).toBe("missing_official_tax_fee_adder");
  });

  it("(21) flags an unexpected observation qualifier on a non-identity-fix row", () => {
    const row = reconstructHistoryRow(
      makeB09X(),
      proposal({ history_action: "append_new_observation_after_identity_fix" }),
      CTX
    );
    // Reconstructed as a fix (qualified id) but NOT declared in identityFixRowIds.
    const v = validateApprovedHistoryRows([row], new Set());
    expect(v.errors.some((e) => e.includes("unexpected_observation_qualifier"))).toBe(true);
  });

  it("(22) detects a row_hash mismatch (tampered hash)", () => {
    const v = validateApprovedHistoryRows([{ ...directionalRow(), rowHash: "tampered" }], new Set());
    expect(v.errors.some((e) => e.includes("row_hash_mismatch"))).toBe(true);
  });
});

describe("BOOKING-B11X — decisions & conflicts", () => {
  it("(23) decision labels map gate/validation/conflict states", () => {
    expect(decideB11XBeforeWrite({ gateAllowed: false, validationOk: true, conflictCount: 0 })).toBe(
      "booking_bounded_append_with_identity_ready_not_run"
    );
    expect(decideB11XBeforeWrite({ gateAllowed: true, validationOk: false, conflictCount: 0 })).toBe(
      "booking_bounded_append_with_identity_failed_validation"
    );
    expect(decideB11XBeforeWrite({ gateAllowed: true, validationOk: true, conflictCount: 2 })).toBe(
      "booking_bounded_append_with_identity_failed_conflicts"
    );
    expect(decideB11XBeforeWrite({ gateAllowed: true, validationOk: true, conflictCount: 0 })).toBe(
      "booking_bounded_append_with_identity_success"
    );
  });

  it("(24) a same-row_id / different-hash collision is a conflict → failed_conflicts", () => {
    const row = directionalRow();
    const existing: ExistingHistoryKey[] = [{ row_id: row.rowId, row_hash: "different_hash", shard_month: row.shardMonth }];
    const preflight = computeAppendPreflight([row], existing, 160);
    expect(preflight.conflict_count).toBe(1);
    expect(decideB11XBeforeWrite({ gateAllowed: true, validationOk: true, conflictCount: preflight.conflict_count })).toBe(
      "booking_bounded_append_with_identity_failed_conflicts"
    );
  });
});

describe("BOOKING-B11X — safety scans", () => {
  it("(25) no synthetic Booking tax multiplier in service or script", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/);
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SCRIPT_SOURCE).not.toMatch(/1\.1\s*\*/);
  });

  it("(26) script performs no DB writes", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/better-sqlite3|new Database\(|INSERT\s+INTO|\.prepare\(/);
  });

  it("(27) script runs no DB mirror sync", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/history-to-db-sync|historyToDbSync|HISTORY_TO_DB_SYNC|db:sync/i);
  });

  it("(28) script triggers no AI context refresh", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/build:ai-context|buildAiContextPacks|query:ai-task/i);
  });

  it("(29) script runs no live Booking probe", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/probe:booking|liveBookingFetch|fetch\(/i);
  });

  it("(30) script uses no browser automation / PMS / paid-source tooling", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/playwright|chromium|page\.goto|newContext/);
    expect(SCRIPT_SOURCE).not.toMatch(/beds24|airhost|pms_upload|ota_upload/i);
    expect(SCRIPT_SOURCE).not.toMatch(/serpapi|dataforseo|apify|brightdata|oxylabs/i);
  });
});

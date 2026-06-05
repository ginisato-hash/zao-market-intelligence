import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRowHash,
  renderHistoryCsv,
  HISTORY_SCHEMA_VERSION,
  type HistoryRow
} from "../src/services/localHistorySchemaDesign";
import { runRealAppend } from "../src/services/localHistoryRealAppend";
import {
  B07X_COLLECTOR_STAGE,
  B07X_SOURCE_PHASE,
  computeAppendPreflight,
  decideB07XBeforeWrite,
  evaluateBookingAppendGate,
  groupRowsToSourceShards,
  reconstructHistoryRow,
  selectApprovedRowIds,
  validateApprovedHistoryRows,
  type B05XFullRow,
  type ExistingHistoryKey,
  type ProposalRowLite
} from "../src/services/bookingHistoryAppendRealRun";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/bookingHistoryAppendRealRun.ts"),
  "utf8"
);
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/runBookingHistoryAppendRealRun.ts"),
  "utf8"
);

const RECONSTRUCT_CTX = { sourceReportPath: "report.md", sourceCsvPath: "report.csv" };

// Build a B05X full row whose carried row_hash matches what reconstructHistoryRow
// will re-derive (so policy validation passes), mirroring the real B05X mapping.
function makeB05XRow(over: Partial<B05XFullRow> = {}): B05XFullRow {
  const base: B05XFullRow = {
    row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    row_hash: "",
    shard_month: "2026_06",
    collected_date_jst: "2026-06-04",
    collected_at_jst: "2026-06-04T14:24:35+09:00",
    normalized_at_jst: "2026-06-04T14:24:35+09:00",
    canonical_property_name: "蔵王国際ホテル",
    source_property_name: "航空券＋ホテル",
    property_identity_match: true,
    source_property_id: "zao-kokusai",
    source_slug_or_code: "zao-kokusai",
    source_url: "https://example.invalid/zao-kokusai",
    checkin_date: "2026-06-14",
    checkout_date: "2026-06-15",
    stay_nights: 1,
    group_adults: 2,
    no_rooms: 1,
    group_children: 0,
    currency: "JPY",
    language: "ja",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_status: "available",
    normalized_total_jpy: 32_157,
    price_basis: "room_total_official_visible_tax_fee_2_adults_1_room_1_night",
    basis_confidence: "B",
    source_primary_price: 26_573,
    source_official_tax_fee_adder: 5_584,
    source_computed_total_with_tax_fee: 32_157,
    source_tax_basis_classification: "official_visible_tax_fee_adder",
    classification: "booking_b04a_official_base_plus_adder_numeric",
    dp_usage: "directional",
    exclusion_reason: "",
    basis_note: "Computed total = Booking.com official visible base price + official visible tax/fee adder; no synthetic multiplier applied.",
    debug_artifact_path: ".data/debug/booking-broader-normalized/x"
  };
  const merged = { ...base, ...over };
  const isDirectional = merged.dp_usage === "directional";
  const isExcluded = merged.dp_usage === "excluded";
  merged.row_hash = buildRowHash({
    source: "booking",
    sourcePhase: B07X_SOURCE_PHASE,
    collectorStage: B07X_COLLECTOR_STAGE,
    canonicalPropertyName: merged.canonical_property_name,
    sourceSlugOrCode: merged.source_slug_or_code,
    sourcePropertyId: merged.source_property_id,
    checkin: merged.checkin_date,
    checkout: merged.checkout_date,
    stayScope: merged.stay_scope,
    collectedDateJst: merged.collected_date_jst,
    availabilityStatus: merged.availability_status,
    soldOutStatus: merged.sold_out_status,
    normalizedTotalPrice: merged.normalized_total_jpy,
    basisConfidence: merged.basis_confidence,
    sourceClassification: merged.classification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: isDirectional,
    isPriceExcludedFromDp: isExcluded
  });
  return merged;
}

function directionalB05X(over: Partial<B05XFullRow> = {}): B05XFullRow {
  return makeB05XRow(over);
}

function excludedB05X(over: Partial<B05XFullRow> = {}): B05XFullRow {
  return makeB05XRow({
    row_id: "2026-06-04|booking|蔵王四季のホテル|zao-shiki-no|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    canonical_property_name: "蔵王四季のホテル",
    source_property_id: "zao-shiki-no",
    source_slug_or_code: "zao-shiki-no",
    normalized_total_jpy: null,
    basis_confidence: "C",
    source_primary_price: 33_000,
    source_official_tax_fee_adder: null,
    source_computed_total_with_tax_fee: null,
    source_tax_basis_classification: "unclear",
    classification: "booking_b04a_price_basis_unclear",
    dp_usage: "excluded",
    exclusion_reason: "missing_official_tax_fee_adder",
    ...over
  });
}

// 15 proposal rows: 14 append_new/append_directional + 1 append_new/append_excluded_audit.
function realisticProposalRows(): ProposalRowLite[] {
  const rows: ProposalRowLite[] = [];
  for (let i = 0; i < 14; i += 1) {
    rows.push({ row_id: `dir-${i}`, history_action: "append_new", append_recommendation: "append_directional" });
  }
  rows.push({ row_id: "exc-0", history_action: "append_new", append_recommendation: "append_excluded_audit" });
  return rows;
}

const tempDirs: string[] = [];
function makeTempHistoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b07x-history-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("BOOKING-B07X — approval gate", () => {
  it("(1) gate is false without the env flag", () => {
    expect(evaluateBookingAppendGate({ approvalSentencePresent: true, envFlag: undefined }).allowed).toBe(false);
  });

  it("(2) gate is true only with approval sentence present AND env flag = 1", () => {
    expect(evaluateBookingAppendGate({ approvalSentencePresent: true, envFlag: "1" }).allowed).toBe(true);
    expect(evaluateBookingAppendGate({ approvalSentencePresent: false, envFlag: "1" }).allowed).toBe(false);
    expect(evaluateBookingAppendGate({ approvalSentencePresent: true, envFlag: "0" }).allowed).toBe(false);
  });
});

describe("BOOKING-B07X — proposal selection", () => {
  it("(3) loads the B06X proposal: 15 approved rows", () => {
    const { approvedRowIds } = selectApprovedRowIds(realisticProposalRows());
    expect(approvedRowIds).toHaveLength(15);
  });

  it("(4) rejects when a conflict is present (decision failed_conflicts)", () => {
    const row = reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX);
    const existing: ExistingHistoryKey[] = [
      { row_id: row.rowId, row_hash: "different_hash", shard_month: row.shardMonth }
    ];
    const preflight = computeAppendPreflight([row], existing, 145);
    expect(preflight.conflict_count).toBe(1);
    expect(decideB07XBeforeWrite({ gateAllowed: true, validationOk: true, conflictCount: 1 })).toBe(
      "booking_history_append_failed_conflicts"
    );
  });

  it("(5) appends only append_new rows", () => {
    const rows: ProposalRowLite[] = [
      { row_id: "a", history_action: "append_new", append_recommendation: "append_directional" },
      { row_id: "b", history_action: "skip_identical", append_recommendation: "append_directional" }
    ];
    const { approvedRowIds, blockedRowIds } = selectApprovedRowIds(rows);
    expect(approvedRowIds).toEqual(["a"]);
    expect(blockedRowIds).toEqual(["b"]);
  });

  it("(6) appends append_directional rows", () => {
    const { approvedRowIds } = selectApprovedRowIds([
      { row_id: "a", history_action: "append_new", append_recommendation: "append_directional" }
    ]);
    expect(approvedRowIds).toEqual(["a"]);
  });

  it("(7) appends append_excluded_audit rows", () => {
    const { approvedRowIds } = selectApprovedRowIds([
      { row_id: "a", history_action: "append_new", append_recommendation: "append_excluded_audit" }
    ]);
    expect(approvedRowIds).toEqual(["a"]);
  });

  it("(8) does not append block_conflict rows", () => {
    const { approvedRowIds, blockedRowIds } = selectApprovedRowIds([
      { row_id: "a", history_action: "block_conflict", append_recommendation: "block_until_review" }
    ]);
    expect(approvedRowIds).toEqual([]);
    expect(blockedRowIds).toEqual(["a"]);
  });
});

describe("BOOKING-B07X — safe append (backup / temp / atomic / rollback)", () => {
  // Seed an existing shard with one row, then append a different new row.
  function seedExistingShard(historyDir: string, shardMonth: string, existing: HistoryRow): void {
    writeFileSync(join(historyDir, `zao_signals_${shardMonth}.csv`), renderHistoryCsv([existing]), "utf8");
  }

  it("(9) creates backups for touched shards", () => {
    const dir = makeTempHistoryDir();
    const existing = reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX);
    seedExistingShard(dir, "2026_06", existing);
    const incoming = reconstructHistoryRow(
      directionalB05X({
        row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-21|2026-06-22|2_adults_1_room_1_night",
        checkin_date: "2026-06-21",
        checkout_date: "2026-06-22"
      }),
      RECONSTRUCT_CTX
    );
    const result = runRealAppend({
      historyDir: dir,
      runId: "t9",
      backupTimestamp: "ts9",
      sourceShards: groupRowsToSourceShards([incoming])
    });
    expect(result.decision).toBe("local_history_real_append_success");
    expect(result.backupsCreated).toBe(1);
    expect(existsSync(join(dir, ".backup", "ts9", "zao_signals_2026_06.csv.bak"))).toBe(true);
  });

  it("(10) writes via temp file + atomic rename (no .tmp left behind)", () => {
    const dir = makeTempHistoryDir();
    const existing = reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX);
    seedExistingShard(dir, "2026_06", existing);
    const incoming = reconstructHistoryRow(
      directionalB05X({
        row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-21|2026-06-22|2_adults_1_room_1_night",
        checkin_date: "2026-06-21",
        checkout_date: "2026-06-22"
      }),
      RECONSTRUCT_CTX
    );
    const result = runRealAppend({
      historyDir: dir,
      runId: "t10",
      backupTimestamp: "ts10",
      sourceShards: groupRowsToSourceShards([incoming])
    });
    expect(result.decision).toBe("local_history_real_append_success");
    expect(existsSync(join(dir, ".tmp"))).toBe(false);
    const finalRows = readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(finalRows).toHaveLength(3); // header + 2 rows
  });

  it("(11) rolls back on write failure (target restored)", () => {
    const dir = makeTempHistoryDir();
    const existing = reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX);
    seedExistingShard(dir, "2026_06", existing);
    const originalCsv = readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8");
    const incoming = reconstructHistoryRow(
      directionalB05X({
        row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-21|2026-06-22|2_adults_1_room_1_night",
        checkin_date: "2026-06-21",
        checkout_date: "2026-06-22"
      }),
      RECONSTRUCT_CTX
    );
    const result = runRealAppend({
      historyDir: dir,
      runId: "t11",
      backupTimestamp: "ts11",
      sourceShards: groupRowsToSourceShards([incoming]),
      failWriteForShard: "2026_06"
    });
    expect(result.rollbackPerformed).toBe(true);
    expect(readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8")).toBe(originalCsv);
  });
});

describe("BOOKING-B07X — preflight & row policy", () => {
  it("(12) preflight reports the expected row-count delta", () => {
    const rows = [
      reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX),
      reconstructHistoryRow(excludedB05X(), RECONSTRUCT_CTX)
    ];
    const preflight = computeAppendPreflight(rows, [], 145);
    expect(preflight.new_row_count).toBe(2);
    expect(preflight.expected_total_after_append).toBe(147);
  });

  it("(13) validates absence of duplicate row_id after merge", () => {
    const dir = makeTempHistoryDir();
    const existing = reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX);
    writeFileSync(join(dir, "zao_signals_2026_06.csv"), renderHistoryCsv([existing]), "utf8");
    const incoming = reconstructHistoryRow(
      directionalB05X({
        row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-21|2026-06-22|2_adults_1_room_1_night",
        checkin_date: "2026-06-21",
        checkout_date: "2026-06-22"
      }),
      RECONSTRUCT_CTX
    );
    runRealAppend({
      historyDir: dir,
      runId: "t13",
      backupTimestamp: "ts13",
      sourceShards: groupRowsToSourceShards([incoming])
    });
    const ids = readFileSync(join(dir, "zao_signals_2026_06.csv"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(1)
      .map((l) => l.split(",")[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("(14) reconstructed rows carry schema_version=zao_local_history_v1", () => {
    const row = reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX);
    expect(row.schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
    const validation = validateApprovedHistoryRows([
      { ...row, schemaVersion: "wrong_version" }
    ]);
    expect(validation.errors.some((e) => e.includes("schema_version_mismatch"))).toBe(true);
  });

  it("(15) validates shard_month matches checkin", () => {
    const row = reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX);
    const validation = validateApprovedHistoryRows([{ ...row, shardMonth: "2026_09" }]);
    expect(validation.errors.some((e) => e.includes("shard_month_mismatch"))).toBe(true);
  });

  it("(16) B rows remain directional price-pressure usable", () => {
    const row = reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX);
    expect(row.basisConfidence).toBe("B");
    expect(row.isPriceUsableForDpDirectional).toBe(true);
    expect(row.isPriceExcludedFromDp).toBe(false);
    expect(row.normalizedTotalPrice).not.toBeNull();
  });

  it("(17) C rows remain excluded audit", () => {
    const row = reconstructHistoryRow(excludedB05X(), RECONSTRUCT_CTX);
    expect(row.basisConfidence).toBe("C");
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.isPriceUsableForDpDirectional).toBe(false);
    expect(row.dpExclusionReason).toBe("missing_official_tax_fee_adder");
  });

  it("(18) price-pressure usable only for valid B (directional + total present)", () => {
    const rows = [
      reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX),
      reconstructHistoryRow(excludedB05X(), RECONSTRUCT_CTX)
    ];
    const validation = validateApprovedHistoryRows(rows);
    expect(validation.ok).toBe(true);
    expect(validation.directionalCount).toBe(1);
    expect(validation.excludedCount).toBe(1);
    const usable = rows.filter((r) => r.isPriceUsableForDpDirectional && r.normalizedTotalPrice !== null);
    expect(usable).toHaveLength(1);
  });

  it("(19) dp-direct usable is false for all rows (direct count 0)", () => {
    const rows = [
      reconstructHistoryRow(directionalB05X(), RECONSTRUCT_CTX),
      reconstructHistoryRow(excludedB05X(), RECONSTRUCT_CTX)
    ];
    expect(rows.every((r) => r.isPriceUsableForDpDirect === false)).toBe(true);
    expect(validateApprovedHistoryRows(rows).directCount).toBe(0);
  });
});

describe("BOOKING-B07X — decisions", () => {
  it("(28) decision labels map gate/validation/conflict states", () => {
    expect(decideB07XBeforeWrite({ gateAllowed: false, validationOk: true, conflictCount: 0 })).toBe(
      "booking_history_append_ready_not_run"
    );
    expect(decideB07XBeforeWrite({ gateAllowed: true, validationOk: false, conflictCount: 0 })).toBe(
      "booking_history_append_failed_validation"
    );
    expect(decideB07XBeforeWrite({ gateAllowed: true, validationOk: true, conflictCount: 2 })).toBe(
      "booking_history_append_failed_conflicts"
    );
    expect(decideB07XBeforeWrite({ gateAllowed: true, validationOk: true, conflictCount: 0 })).toBe(
      "booking_history_append_success"
    );
  });
});

describe("BOOKING-B07X — safety scans", () => {
  it("(20) no Booking base × 1.1 in service or script", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/);
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SCRIPT_SOURCE).not.toMatch(/1\.1\s*\*/);
  });

  it("(21) script performs no DB writes", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/better-sqlite3|new Database\(|INSERT\s+INTO|\.prepare\(/);
  });

  it("(22) script runs no DB mirror sync", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/history-to-db-sync|historyToDbSync|HISTORY_TO_DB_SYNC|db:sync/i);
  });

  it("(23) script triggers no AI context refresh", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/build:ai-context|buildAiContextPacks|query:ai-task/i);
  });

  it("(24) script runs no live Booking probe", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/probe:booking|liveBookingFetch|fetch\(/i);
  });

  it("(25) script uses no Playwright / headless browser", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/playwright|chromium|page\.goto|newContext/);
  });

  it("(26) script emits no PMS/Beds24/AirHost output", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/beds24|airhost|pms_upload|ota_upload/i);
  });

  it("(27) script uses no paid-source tooling", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/serpapi|dataforseo|apify|brightdata|oxylabs/i);
  });
});

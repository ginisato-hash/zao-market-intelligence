import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_SCHEMA_VERSION,
  renderHistoryCsv,
  shardMonthFromCheckin,
  validateHistoryRow,
  type HistoryRow
} from "../src/services/localHistorySchemaDesign";
import {
  APPROVAL_SENTENCE,
  AUTO_HISTORY_APPEND_SOURCE,
  AUTO_HISTORY_APPEND_TARGETS,
  MAX_BROWSER_PAGES,
  MAX_PROPERTIES,
  MAX_REQUESTS,
  buildCollectionResult,
  decideAutoHistoryAppend,
  evaluateAutoHistoryAppendGate,
  executeAutoAppend,
  groupNewRowsToSourceShards,
  isApprovalSentencePresent,
  normalizeObservationToHistoryRow,
  normalizeObservations,
  observationsFromFetch,
  renderAutoAppendReport,
  renderObservationCsv,
  runConflictPreflight,
  runNewRowsPreflight,
  type NormalizeContext,
  type RakutenAutoDayObservation,
  type RakutenAutoFetchResult,
  type RakutenAutoRequest,
  type RakutenAutoTarget
} from "../src/services/autoHistoryAppendRealRun";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoHistoryAppendRealRun.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoHistoryAppendRealRun.ts"), "utf8");

const TARGET: RakutenAutoTarget = AUTO_HISTORY_APPEND_TARGETS[0]!;

const CTX: NormalizeContext = {
  collectedAtJst: "2026-06-04T09:00:00+09:00",
  normalizedAtJst: "2026-06-04T09:00:00+09:00",
  sourceReportPath: ".data/reports/automation/auto_history_append_x.md",
  sourceCsvPath: ".data/reports/automation/auto_history_append_x.csv",
  debugArtifactPath: ".data/debug/auto-history-append/x"
};

interface RawDay {
  viewDay: string;
  day?: number;
  stock?: number;
  price?: number;
  link?: string;
  monthClass?: string;
  isPast?: boolean;
  isFull?: boolean;
  isVacant?: boolean;
}

function jsonpBody(opts: {
  viewDate: string;
  chargeType?: string;
  isTaxExclusive?: boolean;
  isEmpty?: boolean;
  days: RawDay[];
}): string {
  const json = {
    viewDate: opts.viewDate,
    isEmpty: opts.isEmpty ?? false,
    isTaxExclusive: opts.isTaxExclusive ?? false,
    vacantRoomCount: 1,
    hotelNo: TARGET.hotelNo,
    roomCode: "",
    roomInfoDto: { chargeType: opts.chargeType ?? "CHARGE_PER_HUMAN" },
    dayList: opts.days.map((d) => ({
      viewDay: d.viewDay,
      day: d.day ?? 0,
      stock: d.stock ?? 0,
      price: d.price ?? 0,
      priceWithoutTax: 0,
      discountedPrice: 0,
      link: d.link ?? "",
      vacantCondition: "",
      monthClass: d.monthClass ?? "thisMonth",
      isPast: d.isPast ?? false,
      isFull: d.isFull ?? false,
      isVacant: d.isVacant ?? false
    }))
  };
  return `cb(${JSON.stringify(json)});`;
}

function okFetch(body: string): RakutenAutoFetchResult {
  return { status: 200, body, error: "" };
}

function sampleRequest(monthAnchor = "20260701"): RakutenAutoRequest {
  return { target: TARGET, monthAnchor };
}

function availableObs(dateIso = "2026-07-10", price = 18000): RakutenAutoDayObservation {
  return {
    target: TARGET,
    monthAnchor: "20260701",
    viewDate: "2026年7月",
    viewDay: dateIso.slice(8),
    dateIso,
    dayOfWeek: "Fri",
    isPast: false,
    isFull: false,
    isVacant: true,
    stock: 3,
    rawPrice: price,
    chargeType: "CHARGE_PER_HUMAN",
    isTaxExclusive: false,
    link: "https://hotel.travel.rakuten.co.jp/condition/x"
  };
}

function soldOutObs(dateIso = "2026-07-11"): RakutenAutoDayObservation {
  return {
    target: TARGET,
    monthAnchor: "20260701",
    viewDate: "2026年7月",
    viewDay: dateIso.slice(8),
    dateIso,
    dayOfWeek: "Sat",
    isPast: false,
    isFull: true,
    isVacant: false,
    stock: 0,
    rawPrice: 0,
    chargeType: "CHARGE_PER_HUMAN",
    isTaxExclusive: false,
    link: ""
  };
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

describe("approval gate", () => {
  const openInput = {
    approvalSentencePresent: true,
    envAutoHistoryAppend: "1",
    source: AUTO_HISTORY_APPEND_SOURCE,
    propertyCount: 2,
    requestCount: 4,
    browserPages: 0,
    dbWriteMode: false,
    githubActionsMode: false
  };

  it("fails closed without the approval sentence", () => {
    const r = evaluateAutoHistoryAppendGate({ ...openInput, approvalSentencePresent: false });
    expect(r.runAllowed).toBe(false);
    expect(r.failedConditions).toContain("approvalSentencePresent!=true");
  });

  it("fails closed without AUTO_HISTORY_APPEND=1", () => {
    const r = evaluateAutoHistoryAppendGate({ ...openInput, envAutoHistoryAppend: undefined });
    expect(r.runAllowed).toBe(false);
    expect(r.failedConditions).toContain("AUTO_HISTORY_APPEND!=1");
  });

  it("lists both conditions when both are missing", () => {
    const r = evaluateAutoHistoryAppendGate({
      ...openInput,
      approvalSentencePresent: false,
      envAutoHistoryAppend: "0"
    });
    expect(r.failedConditions).toEqual(
      expect.arrayContaining(["approvalSentencePresent!=true", "AUTO_HISTORY_APPEND!=1"])
    );
  });

  it("passes only when both gate factors and bounded scope hold", () => {
    expect(evaluateAutoHistoryAppendGate(openInput).runAllowed).toBe(true);
  });

  it("rejects a non-rakuten source", () => {
    const r = evaluateAutoHistoryAppendGate({ ...openInput, source: "booking" });
    expect(r.runAllowed).toBe(false);
    expect(r.failedConditions).toContain("source!=rakuten");
  });

  it("rejects more than two properties / four requests / any browser page / db-write mode", () => {
    expect(evaluateAutoHistoryAppendGate({ ...openInput, propertyCount: 3 }).failedConditions).toContain("propertyCount>2");
    expect(evaluateAutoHistoryAppendGate({ ...openInput, requestCount: 5 }).failedConditions).toContain("requestCount>4");
    expect(evaluateAutoHistoryAppendGate({ ...openInput, browserPages: 1 }).failedConditions).toContain("browserPages>0");
    expect(evaluateAutoHistoryAppendGate({ ...openInput, dbWriteMode: true }).failedConditions).toContain("dbWriteMode!=false");
  });
});

describe("approval sentence detection", () => {
  it("detects the exact sentence inside surrounding text with collapsed whitespace", () => {
    const msg = `Please proceed.\n\n${APPROVAL_SENTENCE}\n\nThanks.`;
    expect(isApprovalSentencePresent(msg)).toBe(true);
  });

  it("rejects missing or partial approval text", () => {
    expect(isApprovalSentencePresent(undefined)).toBe(false);
    expect(isApprovalSentencePresent("Approve Phase AUTO08X")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Collection / parsing
// ---------------------------------------------------------------------------

describe("observation parsing", () => {
  it("extracts in-month available + sold-out days and skips past days", () => {
    const body = jsonpBody({
      viewDate: "2026年7月",
      days: [
        { viewDay: "1", isPast: true },
        { viewDay: "10", price: 18000, link: "https://x", isVacant: true, stock: 3 },
        { viewDay: "11", isFull: true },
        { viewDay: "12", monthClass: "nextMonth", price: 9000, isVacant: true }
      ]
    });
    const { observations, summary } = observationsFromFetch({ request: sampleRequest(), fetch: okFetch(body) });
    // past skipped, next-month skipped → only the available + sold-out in-month days
    expect(observations.map((o) => o.dateIso)).toEqual(["2026-07-10", "2026-07-11"]);
    expect(summary.classification).toBe("rakuten_request_positive");
    expect(summary.availableCount).toBe(1);
    expect(summary.soldOutCount).toBe(1);
  });

  it("classifies an http error", () => {
    const { observations, summary } = observationsFromFetch({
      request: sampleRequest(),
      fetch: { status: 0, body: "", error: "network" }
    });
    expect(observations).toHaveLength(0);
    expect(summary.classification).toBe("rakuten_request_http_error");
  });

  it("marks the whole collection failed only when every request errors", () => {
    const allBad = buildCollectionResult([
      { request: sampleRequest(), fetch: { status: 0, body: "", error: "x" } },
      { request: sampleRequest("20260801"), fetch: { status: 503, body: "", error: "" } }
    ]);
    expect(allBad.collectionFailed).toBe(true);

    const mixed = buildCollectionResult([
      { request: sampleRequest(), fetch: { status: 0, body: "", error: "x" } },
      {
        request: sampleRequest("20260801"),
        fetch: okFetch(jsonpBody({ viewDate: "2026年8月", days: [{ viewDay: "5", price: 12000, link: "https://x", isVacant: true }] }))
      }
    ]);
    expect(mixed.collectionFailed).toBe(false);
    expect(mixed.observations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("normalization to history rows", () => {
  it("prices an available day per-person × 2 with directional B confidence", () => {
    const row = normalizeObservationToHistoryRow(availableObs("2026-07-10", 18000), CTX);
    expect(row.normalizedTotalPrice).toBe(36000);
    expect(row.basisConfidence).toBe("B");
    expect(row.isPriceUsableForDpDirectional).toBe(true);
    expect(row.isPriceUsableForDpDirect).toBe(false);
    expect(row.isPriceExcludedFromDp).toBe(false);
    expect(row.sourcePrimaryPrice).toBe(18000);
  });

  it("records a sold-out day as null-price demand pressure excluded from DP", () => {
    const row = normalizeObservationToHistoryRow(soldOutObs("2026-07-11"), CTX);
    expect(row.normalizedTotalPrice).toBeNull();
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("sold_out_no_price");
    expect(row.soldOutStatus).toBe("sold_out");
    expect(row.basisConfidence).toBe("insufficient");
  });

  it("produces schema-valid rows with v1 version, non-empty id/hash, and matching shard month", () => {
    const rows = normalizeObservations([availableObs("2026-07-10"), soldOutObs("2026-07-11")], CTX);
    for (const row of rows) {
      expect(validateHistoryRow(row)).toEqual([]);
      expect(row.schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
      expect(row.rowId.length).toBeGreaterThan(0);
      expect(row.rowHash.length).toBeGreaterThan(0);
      expect(row.shardMonth).toBe(shardMonthFromCheckin(row.checkin));
      expect(row.shardMonth).toBe("2026_07");
    }
  });

  it("never uses a Booking base × 1.1 multiplier", () => {
    const row = normalizeObservationToHistoryRow(availableObs("2026-07-10", 20000), CTX);
    expect(row.normalizedTotalPrice).toBe(40000); // ×2, not ×1.1
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1|1\.1\s*\*/);
  });
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe("new-rows preflight", () => {
  it("passes for valid normalized rows", () => {
    const rows = normalizeObservations([availableObs(), soldOutObs()], CTX);
    expect(runNewRowsPreflight(rows).ok).toBe(true);
  });

  it("flags an invalid row", () => {
    const rows = normalizeObservations([availableObs()], CTX);
    const broken: HistoryRow = { ...rows[0]!, rowId: "" };
    const r = runNewRowsPreflight([broken]);
    expect(r.ok).toBe(false);
    expect(r.invalidRowCount).toBe(1);
  });
});

describe("conflict preflight", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auto-append-pf-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports all new rows as appendable against an empty dir", () => {
    const rows = normalizeObservations([availableObs(), soldOutObs()], CTX);
    const pf = runConflictPreflight({ historyDir: dir, newRows: rows, runId: "r1" });
    expect(pf.existingRowCount).toBe(0);
    expect(pf.appendedCount).toBe(2);
    expect(pf.conflictCount).toBe(0);
    expect(pf.touchedShardMonths).toEqual(["2026_07"]);
  });

  it("skips an identical already-present row", () => {
    const rows = normalizeObservations([availableObs()], CTX);
    writeFileSync(join(dir, "zao_signals_2026_07.csv"), renderHistoryCsv(rows), "utf8");
    const pf = runConflictPreflight({ historyDir: dir, newRows: rows, runId: "r2" });
    expect(pf.appendedCount).toBe(0);
    expect(pf.skippedIdenticalCount).toBe(1);
    expect(pf.conflictCount).toBe(0);
  });

  it("flags a hash conflict (same row_id, different value)", () => {
    const existing = normalizeObservations([availableObs("2026-07-10", 18000)], CTX);
    writeFileSync(join(dir, "zao_signals_2026_07.csv"), renderHistoryCsv(existing), "utf8");
    const incoming = normalizeObservations([availableObs("2026-07-10", 25000)], CTX);
    const pf = runConflictPreflight({ historyDir: dir, newRows: incoming, runId: "r3" });
    expect(pf.conflictCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Execute (atomic append against a temp history dir)
// ---------------------------------------------------------------------------

describe("executeAutoAppend", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auto-append-exec-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends new rows and validates the row-count delta on success", () => {
    const rows = normalizeObservations([availableObs("2026-07-10"), soldOutObs("2026-07-11")], CTX);
    const out = executeAutoAppend({ historyDir: dir, runId: "exec1", backupTimestamp: "ts1", newRows: rows, collectionFailed: false });
    expect(out.decision).toBe("auto_history_append_success");
    expect(out.rowsAppended).toBe(2);
    expect(out.postWrite?.ok).toBe(true);
    expect(out.postWrite?.actualDelta).toBe(2);
    expect(existsSync(join(dir, "zao_signals_2026_07.csv"))).toBe(true);
  });

  it("is idempotent: re-appending identical rows writes nothing new", () => {
    const rows = normalizeObservations([availableObs("2026-07-10")], CTX);
    executeAutoAppend({ historyDir: dir, runId: "exec2a", backupTimestamp: "ts2a", newRows: rows, collectionFailed: false });
    const again = executeAutoAppend({ historyDir: dir, runId: "exec2b", backupTimestamp: "ts2b", newRows: rows, collectionFailed: false });
    expect(again.decision).toBe("auto_history_append_success");
    expect(again.conflictPreflight.appendedCount).toBe(0);
    expect(again.conflictPreflight.skippedIdenticalCount).toBe(1);
    expect(again.rowsAppended).toBe(0);
  });

  it("blocks on a hash conflict and writes nothing", () => {
    const existing = normalizeObservations([availableObs("2026-07-10", 18000)], CTX);
    executeAutoAppend({ historyDir: dir, runId: "exec3a", backupTimestamp: "ts3a", newRows: existing, collectionFailed: false });
    const before = readFileSync(join(dir, "zao_signals_2026_07.csv"), "utf8");
    const incoming = normalizeObservations([availableObs("2026-07-10", 25000)], CTX);
    const out = executeAutoAppend({ historyDir: dir, runId: "exec3b", backupTimestamp: "ts3b", newRows: incoming, collectionFailed: false });
    expect(out.decision).toBe("auto_history_append_failed_conflicts");
    expect(out.writeResult).toBeNull();
    expect(readFileSync(join(dir, "zao_signals_2026_07.csv"), "utf8")).toBe(before);
  });

  it("does not write when collection failed", () => {
    const rows = normalizeObservations([availableObs()], CTX);
    const out = executeAutoAppend({ historyDir: dir, runId: "exec4", backupTimestamp: "ts4", newRows: rows, collectionFailed: true });
    expect(out.decision).toBe("auto_history_append_failed_collection");
    expect(out.writeResult).toBeNull();
    expect(readdirSync(dir).filter((f) => f.startsWith("zao_signals_"))).toHaveLength(0);
  });
});

describe("groupNewRowsToSourceShards", () => {
  it("groups rows by shard month with a valid CSV header each", () => {
    const rows = normalizeObservations(
      [availableObs("2026-07-10"), availableObs("2026-08-05")],
      CTX
    );
    const shards = groupNewRowsToSourceShards(rows);
    expect(shards.map((s) => s.shardMonth)).toEqual(["2026_07", "2026_08"]);
    for (const s of shards) expect(s.csv.startsWith("row_id,row_hash,")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decision mapping
// ---------------------------------------------------------------------------

describe("decideAutoHistoryAppend", () => {
  const base = {
    gateAllowed: true,
    collectionFailed: false,
    newRowsPreflightOk: true,
    conflictCount: 0,
    writeAttempted: true,
    writeSucceeded: true,
    postWriteOk: true
  };

  it("returns ready_not_run when the gate is closed", () => {
    expect(decideAutoHistoryAppend({ ...base, gateAllowed: false })).toBe("auto_history_append_ready_not_run");
  });

  it("maps the failure modes", () => {
    expect(decideAutoHistoryAppend({ ...base, collectionFailed: true })).toBe("auto_history_append_failed_collection");
    expect(decideAutoHistoryAppend({ ...base, newRowsPreflightOk: false })).toBe("auto_history_append_failed_preflight");
    expect(decideAutoHistoryAppend({ ...base, conflictCount: 1 })).toBe("auto_history_append_failed_conflicts");
    expect(decideAutoHistoryAppend({ ...base, writeAttempted: false })).toBe("auto_history_append_failed_validation");
    expect(decideAutoHistoryAppend({ ...base, postWriteOk: false })).toBe("auto_history_append_failed_validation");
  });

  it("returns success when everything passes", () => {
    expect(decideAutoHistoryAppend(base)).toBe("auto_history_append_success");
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("rendering", () => {
  it("renders the observation CSV header", () => {
    const csv = renderObservationCsv([availableObs()]);
    expect(csv.split("\n")[0]).toBe(
      "canonical_property_name,hotel_no,f_syu,month_anchor,date_iso,day_of_week,is_full,is_vacant,stock,raw_price,charge_type,is_tax_exclusive"
    );
  });

  it("renders a fail-closed report with the decision and safety policy", () => {
    const md = renderAutoAppendReport({
      generatedAtJst: "2026-06-04T09:00:00+09:00",
      runId: "auto_history_append_test",
      decision: "auto_history_append_ready_not_run",
      gate: { runAllowed: false, failedConditions: ["approvalSentencePresent!=true", "AUTO_HISTORY_APPEND!=1"] },
      approvalSentencePresent: false,
      envFlagPresent: false,
      requests: [sampleRequest()],
      collection: null,
      newRowCount: 0,
      execution: null,
      historyDirExistedBefore: false,
      historyFilesAfter: [],
      reportPath: "r.md",
      csvPath: "r.csv",
      jsonPath: "r.json",
      debugRootPath: "d"
    });
    expect(md).toContain("decision=auto_history_append_ready_not_run");
    expect(md).toContain("approval_sentence_present=false");
    expect(md).toMatch(/AUTO08X/);
  });
});

// ---------------------------------------------------------------------------
// Bounded-scope constants
// ---------------------------------------------------------------------------

describe("bounded scope", () => {
  it("enforces the documented caps", () => {
    expect(MAX_REQUESTS).toBe(4);
    expect(MAX_PROPERTIES).toBe(2);
    expect(MAX_BROWSER_PAGES).toBe(0);
    expect(AUTO_HISTORY_APPEND_SOURCE).toBe("rakuten");
    expect(AUTO_HISTORY_APPEND_TARGETS.length).toBeLessThanOrEqual(MAX_PROPERTIES);
  });
});

// ---------------------------------------------------------------------------
// Behavioral safety scans (prose may legitimately mention forbidden tokens)
// ---------------------------------------------------------------------------

describe("safety: no forbidden behavior in source", () => {
  it("never imports paid scraping tools or proxies", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(
      /(import|require)[^;\n]*(serpapi|dataforseo|apify|brightdata|oxylabs|proxy)/i
    );
  });

  it("never writes to .data/ai-context or the property master", () => {
    const writeOps = /(writeFileSync|appendFileSync|renameSync|copyFileSync|symlinkSync)\s*\([^)]*(ai-context|zao_universe_properties)/i;
    expect(SCRIPT_SOURCE).not.toMatch(writeOps);
    expect(SERVICE_SOURCE).not.toMatch(writeOps);
  });

  it("does not sync the DB, refresh AI context, or run the task-query CLI in this phase", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(
      /(import|require)[^;\n]*(historyToDbSyncRealRun|buildAiContextPacks|runAiTaskQuery|aiContextPackGenerator|aiTaskQueryRecipes)/i
    );
    expect(SCRIPT_SOURCE).not.toMatch(/better-sqlite3|openLocalDatabase/i);
  });

  it("never opens a browser / Playwright (browser pages = 0)", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(import|require)[^;\n]*playwright|chromium\.launch/i);
  });

  it("explicitly declares the approval-sentence constant and still gates on the env flag at runtime", () => {
    // AUTO08X was approved with the exact sentence, so APPROVAL_SENTENCE_PRESENT = true.
    // The hard runtime gate remains: AUTO_HISTORY_APPEND must equal "1" or the run fails closed.
    expect(SCRIPT_SOURCE).toMatch(/APPROVAL_SENTENCE_PRESENT\s*=\s*(true|false)/);
    expect(SCRIPT_SOURCE).toMatch(/AUTO_HISTORY_APPEND/);
    expect(SERVICE_SOURCE).toMatch(/envAutoHistoryAppend\s*!==\s*"1"/);
  });
});

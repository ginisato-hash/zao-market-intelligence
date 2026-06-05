// Phase AUTO08X — First Guarded Auto History Append Real Run (service).
//
// This is the FIRST automation phase allowed to (a) run a tiny bounded Rakuten
// collector batch and (b) append validated normalized rows to .data/history —
// but ONLY behind a hard double gate:
//   1. the EXACT standalone approval sentence is present in the current user
//      instruction (APPROVAL_SENTENCE below), AND
//   2. the runtime env flag AUTO_HISTORY_APPEND=1 is set.
// Missing either → fail closed: NO live collection, NO history append; the run
// emits an `auto_history_append_ready_not_run` report only.
//
// Bounded scope when (and only when) the gate passes:
//   - source = rakuten ONLY, via the public /hplan/calendar JSONP feed (Method B)
//   - properties ≤ 2, requests ≤ 4, browser pages = 0 (plain JSONP fetch)
//   - no Booking rendered DOM, no condition/reservation link following
//   - Rakuten basis: raw price is per-person when chargeType=CHARGE_PER_HUMAN;
//     normalized_total = raw_price * 2 (2 adults / 1 room / 1 night);
//     basis_confidence = B; dp_usage = directional. Sold-out days may carry a
//     null price but still record demand pressure.
//
// STILL FORBIDDEN (always): DB writes / sync / migration / table creation; any
// broad live collector or external mass fetch; Booking broad Playwright; GitHub
// Actions / cron / GitOps / git commit / push / data-repo / production schedule;
// PMS / Beds24 / AirHost / OTA output; price updates; property-master edits;
// .data/ai-context/latest mutation; paid APIs (SerpAPI / DataForSEO / Apify /
// Bright Data / Oxylabs / paid proxy); CAPTCHA bypass / stealth / login / cookie
// injection; Booking base × 1.1. Do NOT start DP03X or R01X. Writes are limited
// to .data/history/zao_signals_YYYY_MM.csv (+ .backup/.tmp/.append.lock) plus
// reports/debug under .data/reports and .data/debug.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HISTORY_SCHEMA_VERSION,
  buildRowHash,
  buildRowId,
  renderHistoryCsv,
  shardMonthFromCheckin,
  validateHistoryRow,
  type HistoryRow
} from "./localHistorySchemaDesign";
import { simulateAppend, type AppendActionRecord } from "./localHistoryAppendDryRun";
import {
  parseShardRows,
  runRealAppend,
  validatePostWriteShards,
  type RunRealAppendResult
} from "./localHistoryRealAppend";
import {
  parseHplanCalendarResponse,
  type HplanCalendarParsed,
  type HplanDay
} from "./rakutenHplanCalendarProbe";
import { dateIsoFromViewDateAndViewDay, dayOfWeek } from "./rakutenLimitedCollectorPrototype";

// ---------------------------------------------------------------------------
// Approval gate constants
// ---------------------------------------------------------------------------

// The EXACT standalone sentence the current user instruction must contain to
// unlock AUTO08X. Compared after whitespace normalization.
export const APPROVAL_SENTENCE =
  "Approve Phase AUTO08X first guarded auto history append real run. You may run the approved bounded collectors locally and append validated normalized rows to .data/history.";

export const AUTO_HISTORY_APPEND_ENV_FLAG = "AUTO_HISTORY_APPEND";

// Bounded-scope caps.
export const AUTO_HISTORY_APPEND_SOURCE = "rakuten" as const;
export const MAX_PROPERTIES = 2;
export const MAX_REQUESTS = 4;
export const MAX_BROWSER_PAGES = 0;
export const STAY_NIGHTS = 1;
export const GROUP_ADULTS = 2;
export const NO_ROOMS = 1;
export const STAY_SCOPE = "2adult_1room_1night";

export const AUTO_APPEND_SOURCE_PHASE = "AUTO08X";
export const AUTO_APPEND_COLLECTOR_STAGE = "auto_history_append_guarded_real_run";
export const AUTO_APPEND_PRICED_BASIS_CONFIDENCE = "B" as const;
export const AUTO_APPEND_SOLD_OUT_BASIS_CONFIDENCE = "insufficient" as const;
export const AUTO_APPEND_PRICE_BASIS = "rakuten_hplan_per_person_x2";
export const AUTO_APPEND_PRICE_SOURCE = "rakuten_hplan_calendar";
export const AUTO_APPEND_BASIS_NOTE =
  "Rakuten /hplan/calendar per-person price (isTaxExclusive=false, CHARGE_PER_HUMAN) × 2 for 2 adults/1 room/1 night; directional B-confidence only, not a confirmed booked total.";

// ---------------------------------------------------------------------------
// Targets (≤ MAX_PROPERTIES). Suggested low-bot-risk Rakuten properties.
// ---------------------------------------------------------------------------

export interface RakutenAutoTarget {
  canonicalPropertyName: string;
  sourcePropertyName: string;
  hotelNo: string;
  fSyu: string;
  fCampId: string;
}

export const AUTO_HISTORY_APPEND_TARGETS: readonly RakutenAutoTarget[] = [
  {
    canonicalPropertyName: "蔵王国際ホテル",
    sourcePropertyName: "蔵王国際ホテル",
    hotelNo: "5723",
    fSyu: "00",
    fCampId: "6468227"
  },
  {
    canonicalPropertyName: "名湯リゾート ルーセント",
    sourcePropertyName: "名湯リゾート ルーセント",
    hotelNo: "39565",
    fSyu: "honkan-exk",
    fCampId: "5623966"
  }
];

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type AutoHistoryAppendDecision =
  | "auto_history_append_ready_not_run"
  | "auto_history_append_success"
  | "auto_history_append_failed_preflight"
  | "auto_history_append_failed_collection"
  | "auto_history_append_failed_conflicts"
  | "auto_history_append_failed_validation";

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

export function normalizeApprovalText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function isApprovalSentencePresent(instruction: string | undefined): boolean {
  if (instruction === undefined) return false;
  return normalizeApprovalText(instruction).includes(normalizeApprovalText(APPROVAL_SENTENCE));
}

export interface AutoAppendGateInput {
  approvalSentencePresent: boolean;
  envAutoHistoryAppend: string | undefined;
  source: string;
  propertyCount: number;
  requestCount: number;
  browserPages: number;
  dbWriteMode: boolean;
  githubActionsMode: boolean;
}

export interface AutoAppendGateResult {
  runAllowed: boolean;
  failedConditions: string[];
}

export function evaluateAutoHistoryAppendGate(input: AutoAppendGateInput): AutoAppendGateResult {
  const failed: string[] = [];
  if (!input.approvalSentencePresent) failed.push("approvalSentencePresent!=true");
  if (input.envAutoHistoryAppend !== "1") failed.push(`${AUTO_HISTORY_APPEND_ENV_FLAG}!=1`);
  if (input.source !== AUTO_HISTORY_APPEND_SOURCE) failed.push(`source!=${AUTO_HISTORY_APPEND_SOURCE}`);
  if (input.propertyCount > MAX_PROPERTIES) failed.push(`propertyCount>${MAX_PROPERTIES}`);
  if (input.requestCount > MAX_REQUESTS) failed.push(`requestCount>${MAX_REQUESTS}`);
  if (input.browserPages > MAX_BROWSER_PAGES) failed.push(`browserPages>${MAX_BROWSER_PAGES}`);
  if (input.dbWriteMode) failed.push("dbWriteMode!=false");
  if (input.githubActionsMode) failed.push("githubActionsMode!=false");
  return { runAllowed: failed.length === 0, failedConditions: failed };
}

// ---------------------------------------------------------------------------
// Collection (pure): parse an already-fetched JSONP payload into observations.
// The live JSONP fetch itself lives in the runner; the service stays pure and
// fully testable from synthetic payloads.
// ---------------------------------------------------------------------------

export interface RakutenAutoRequest {
  target: RakutenAutoTarget;
  monthAnchor: string; // YYYYMMDD
}

export interface RakutenAutoFetchResult {
  status: number;
  body: string;
  error: string;
}

export interface RakutenAutoDayObservation {
  target: RakutenAutoTarget;
  monthAnchor: string;
  viewDate: string;
  viewDay: string;
  dateIso: string;
  dayOfWeek: string;
  isPast: boolean;
  isFull: boolean;
  isVacant: boolean;
  stock: number;
  rawPrice: number;
  chargeType: string;
  isTaxExclusive: boolean;
  link: string;
}

export type RakutenAutoRequestClassification =
  | "rakuten_request_positive"
  | "rakuten_request_all_full"
  | "rakuten_request_empty"
  | "rakuten_request_http_error"
  | "rakuten_request_jsonp_parse_error";

export interface RakutenAutoRequestSummary {
  canonicalPropertyName: string;
  hotelNo: string;
  fSyu: string;
  monthAnchor: string;
  httpStatus: number;
  responseType: string;
  isTaxExclusive: boolean;
  chargeType: string;
  dayListLength: number;
  observationCount: number;
  availableCount: number;
  soldOutCount: number;
  classification: RakutenAutoRequestClassification;
  error: string;
}

function isInMonthDay(day: HplanDay): boolean {
  return day.monthClass === "" || day.monthClass === "thisMonth";
}

export function classifyRakutenAutoRequest(input: {
  fetch: RakutenAutoFetchResult;
  parsed: HplanCalendarParsed | null;
  observations: RakutenAutoDayObservation[];
}): RakutenAutoRequestClassification {
  if (input.fetch.error !== "" || input.fetch.status === 0 || input.fetch.status >= 400) {
    return "rakuten_request_http_error";
  }
  const parsed = input.parsed;
  if (parsed === null || (!parsed.ok && parsed.days.length === 0)) return "rakuten_request_jsonp_parse_error";
  if (parsed.isEmpty || parsed.days.length === 0) return "rakuten_request_empty";
  if (input.observations.some((o) => o.isVacant && o.rawPrice > 0)) return "rakuten_request_positive";
  if (input.observations.length > 0 && input.observations.every((o) => o.isFull)) return "rakuten_request_all_full";
  return "rakuten_request_empty";
}

// Turn one fetched request into in-month, non-past day observations.
export function observationsFromFetch(input: {
  request: RakutenAutoRequest;
  fetch: RakutenAutoFetchResult;
}): { observations: RakutenAutoDayObservation[]; parsed: HplanCalendarParsed | null; summary: RakutenAutoRequestSummary } {
  const { target, monthAnchor } = input.request;
  const reachable = input.fetch.error === "" && input.fetch.status > 0 && input.fetch.status < 400;
  const parsed = reachable ? parseHplanCalendarResponse(input.fetch.body, input.fetch.status) : null;

  const observations: RakutenAutoDayObservation[] = [];
  if (parsed !== null) {
    for (const day of parsed.days) {
      if (!isInMonthDay(day)) continue;
      if (day.isPast) continue;
      const dateIso = dateIsoFromViewDateAndViewDay(parsed.viewDate, day.viewDay);
      if (dateIso === "") continue;
      observations.push({
        target,
        monthAnchor,
        viewDate: parsed.viewDate,
        viewDay: day.viewDay,
        dateIso,
        dayOfWeek: dayOfWeek(dateIso),
        isPast: day.isPast,
        isFull: day.isFull,
        isVacant: day.isVacant,
        stock: day.stock,
        rawPrice: day.price,
        chargeType: parsed.chargeType,
        isTaxExclusive: parsed.isTaxExclusive,
        link: day.link
      });
    }
  }

  const classification = classifyRakutenAutoRequest({ fetch: input.fetch, parsed, observations });
  const summary: RakutenAutoRequestSummary = {
    canonicalPropertyName: target.canonicalPropertyName,
    hotelNo: target.hotelNo,
    fSyu: target.fSyu,
    monthAnchor,
    httpStatus: input.fetch.status,
    responseType: parsed?.responseType ?? "parse_error",
    isTaxExclusive: parsed?.isTaxExclusive ?? false,
    chargeType: parsed?.chargeType ?? "",
    dayListLength: parsed?.days.length ?? 0,
    observationCount: observations.length,
    availableCount: observations.filter((o) => o.isVacant).length,
    soldOutCount: observations.filter((o) => o.isFull).length,
    classification,
    error: input.fetch.error
  };
  return { observations, parsed, summary };
}

export interface CollectionResult {
  requestCount: number;
  observations: RakutenAutoDayObservation[];
  requestSummaries: RakutenAutoRequestSummary[];
  errorCount: number;
  collectionFailed: boolean;
}

// Combine all fetched requests into a single collection result. `collectionFailed`
// is true only when every request errored (http/parse) — otherwise we proceed
// with whatever clean observations we got.
export function buildCollectionResult(
  fetched: { request: RakutenAutoRequest; fetch: RakutenAutoFetchResult }[]
): CollectionResult {
  const observations: RakutenAutoDayObservation[] = [];
  const requestSummaries: RakutenAutoRequestSummary[] = [];
  let errorCount = 0;
  for (const item of fetched) {
    const out = observationsFromFetch(item);
    observations.push(...out.observations);
    requestSummaries.push(out.summary);
    if (
      out.summary.classification === "rakuten_request_http_error" ||
      out.summary.classification === "rakuten_request_jsonp_parse_error"
    ) {
      errorCount += 1;
    }
  }
  return {
    requestCount: fetched.length,
    observations,
    requestSummaries,
    errorCount,
    collectionFailed: fetched.length > 0 && errorCount === fetched.length
  };
}

// ---------------------------------------------------------------------------
// Normalization: observation → HistoryRow (schema v1).
// ---------------------------------------------------------------------------

function addOneDayIso(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export interface NormalizeContext {
  collectedAtJst: string; // ISO with +09:00
  normalizedAtJst: string; // ISO with +09:00
  sourceReportPath: string;
  sourceCsvPath: string;
  debugArtifactPath: string;
}

// One observation → one normalized history row. Priced available days carry a
// directional B-confidence per-person×2 total; sold-out days carry a null price
// flagged as demand pressure (excluded from DP, insufficient price basis).
export function normalizeObservationToHistoryRow(
  obs: RakutenAutoDayObservation,
  ctx: NormalizeContext
): HistoryRow {
  const collectedDateJst = ctx.collectedAtJst.slice(0, 10);
  const checkin = obs.dateIso;
  const checkout = addOneDayIso(obs.dateIso);
  const shardMonth = shardMonthFromCheckin(checkin);
  const sourceSlugOrCode = `${obs.target.hotelNo}:${obs.target.fSyu}`;
  const sourcePropertyId = obs.target.hotelNo;

  const priced = obs.isVacant && obs.rawPrice > 0 && obs.chargeType === "CHARGE_PER_HUMAN";
  const soldOut = obs.isFull || (!obs.isVacant && obs.rawPrice === 0);

  const normalizedTotalPrice = priced ? obs.rawPrice * GROUP_ADULTS : null;
  const availabilityStatus = priced ? "available" : soldOut ? "sold_out" : "unavailable";
  const soldOutStatus = soldOut ? "sold_out" : priced ? "available" : "unknown";
  const basisConfidence = priced
    ? AUTO_APPEND_PRICED_BASIS_CONFIDENCE
    : AUTO_APPEND_SOLD_OUT_BASIS_CONFIDENCE;

  const sourceClassification = priced
    ? "rakuten_day_available_price"
    : soldOut
      ? "rakuten_day_sold_out"
      : "rakuten_day_no_price";

  const isPriceUsableForDpDirectional = priced;
  const isPriceExcludedFromDp = !priced;
  const dpExclusionReason = priced ? null : soldOut ? "sold_out_no_price" : "no_usable_price";
  const warningFlags = priced ? "directional_only_b_confidence" : "demand_pressure_no_price";

  const base = {
    source: AUTO_HISTORY_APPEND_SOURCE,
    sourcePhase: AUTO_APPEND_SOURCE_PHASE,
    collectorStage: AUTO_APPEND_COLLECTOR_STAGE,
    canonicalPropertyName: obs.target.canonicalPropertyName,
    sourceSlugOrCode,
    sourcePropertyId,
    checkin,
    checkout,
    stayScope: STAY_SCOPE,
    collectedDateJst,
    availabilityStatus,
    soldOutStatus,
    normalizedTotalPrice,
    basisConfidence,
    sourceClassification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional,
    isPriceExcludedFromDp
  };

  const rowId = buildRowId({
    collectedDateJst,
    source: base.source,
    canonicalPropertyName: base.canonicalPropertyName,
    sourceSlugOrCode,
    sourcePropertyId,
    checkin,
    checkout,
    stayScope: STAY_SCOPE
  });
  const rowHash = buildRowHash(base);

  return {
    rowId,
    rowHash,
    shardMonth,
    collectedDateJst,
    collectedAtJst: ctx.collectedAtJst,
    normalizedAtJst: ctx.normalizedAtJst,
    source: base.source,
    sourcePhase: base.sourcePhase,
    collectorStage: base.collectorStage,
    canonicalPropertyName: base.canonicalPropertyName,
    sourcePropertyName: obs.target.sourcePropertyName,
    propertyIdentityMatch: true,
    sourcePropertyId,
    sourceSlugOrCode,
    checkin,
    checkout,
    stayNights: STAY_NIGHTS,
    groupAdults: GROUP_ADULTS,
    noRooms: NO_ROOMS,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: STAY_SCOPE,
    availabilityStatus,
    soldOutStatus,
    normalizedTotalPrice,
    normalizedTotalPriceSource: priced ? AUTO_APPEND_PRICE_SOURCE : null,
    normalizedTotalPriceBasis: priced ? AUTO_APPEND_PRICE_BASIS : "none",
    normalizedTotalPriceConfidence: basisConfidence,
    basisConfidence,
    basisNote: AUTO_APPEND_BASIS_NOTE,
    sourcePrimaryPrice: obs.rawPrice > 0 ? obs.rawPrice : null,
    sourceSecondaryPriceOrAdder: null,
    sourceComputedTotal: normalizedTotalPrice,
    sourceTaxOrFeeClassification: obs.isTaxExclusive ? "tax_exclusive" : "tax_inclusive",
    sourceClassification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional,
    isPriceExcludedFromDp,
    dpExclusionReason,
    warningFlags,
    sourceReportPath: ctx.sourceReportPath,
    sourceCsvPath: ctx.sourceCsvPath,
    debugArtifactPath: ctx.debugArtifactPath,
    schemaVersion: HISTORY_SCHEMA_VERSION
  };
}

export function normalizeObservations(
  observations: RakutenAutoDayObservation[],
  ctx: NormalizeContext
): HistoryRow[] {
  return observations.map((o) => normalizeObservationToHistoryRow(o, ctx));
}

// ---------------------------------------------------------------------------
// New-row preflight (schema/validity of the freshly collected rows).
// ---------------------------------------------------------------------------

export interface NewRowsPreflightResult {
  ok: boolean;
  rowCount: number;
  invalidRowCount: number;
  invalidRows: { rowId: string; errors: string[] }[];
  schemaVersionMismatchCount: number;
  emptyRowHashCount: number;
  duplicateRowIdCount: number;
  failedChecks: string[];
}

export function runNewRowsPreflight(rows: HistoryRow[]): NewRowsPreflightResult {
  const failedChecks: string[] = [];
  const invalidRows: { rowId: string; errors: string[] }[] = [];
  let schemaVersionMismatchCount = 0;
  let emptyRowHashCount = 0;

  const idCounts = new Map<string, number>();
  for (const row of rows) {
    const errors = validateHistoryRow(row);
    if (errors.length > 0) invalidRows.push({ rowId: row.rowId, errors });
    if (row.schemaVersion !== HISTORY_SCHEMA_VERSION) schemaVersionMismatchCount += 1;
    if (row.rowHash.trim() === "") emptyRowHashCount += 1;
    idCounts.set(row.rowId, (idCounts.get(row.rowId) ?? 0) + 1);
  }
  const duplicateRowIdCount = [...idCounts.values()].filter((c) => c > 1).length;

  if (invalidRows.length > 0) failedChecks.push(`invalid_rows:${invalidRows.length}`);
  if (schemaVersionMismatchCount > 0) failedChecks.push(`schema_version_mismatch:${schemaVersionMismatchCount}`);
  if (emptyRowHashCount > 0) failedChecks.push(`empty_row_hash:${emptyRowHashCount}`);
  if (duplicateRowIdCount > 0) failedChecks.push(`duplicate_row_id:${duplicateRowIdCount}`);

  return {
    ok: failedChecks.length === 0,
    rowCount: rows.length,
    invalidRowCount: invalidRows.length,
    invalidRows,
    schemaVersionMismatchCount,
    emptyRowHashCount,
    duplicateRowIdCount,
    failedChecks
  };
}

// ---------------------------------------------------------------------------
// Conflict preflight against the existing on-disk shards (read-only).
// ---------------------------------------------------------------------------

export function shardFileName(shardMonth: string): string {
  return `zao_signals_${shardMonth}.csv`;
}

export interface ConflictPreflightResult {
  existingRowCount: number;
  appendedCount: number;
  skippedIdenticalCount: number;
  conflictCount: number;
  conflicts: AppendActionRecord[];
  touchedShardMonths: string[];
}

export function runConflictPreflight(input: {
  historyDir: string;
  newRows: HistoryRow[];
  runId: string;
}): ConflictPreflightResult {
  const touched = [...new Set(input.newRows.map((r) => r.shardMonth))].sort();
  const existingRows: HistoryRow[] = [];
  for (const shardMonth of touched) {
    const targetPath = resolve(input.historyDir, shardFileName(shardMonth));
    if (existsSync(targetPath)) existingRows.push(...parseShardRows(readFileSync(targetPath, "utf8")));
  }
  const sim = simulateAppend(existingRows, input.newRows, {
    scenario: "auto_history_append_preflight",
    runId: input.runId,
    dryRunShardDir: input.historyDir
  });
  return {
    existingRowCount: existingRows.length,
    appendedCount: sim.appendedCount,
    skippedIdenticalCount: sim.skippedIdenticalCount,
    conflictCount: sim.conflictCount,
    conflicts: sim.conflicts,
    touchedShardMonths: touched
  };
}

// Group freshly collected rows into per-shard incoming CSV payloads (the input
// shape the shared write engine consumes).
export function groupNewRowsToSourceShards(rows: HistoryRow[]): { shardMonth: string; csv: string }[] {
  const byShard = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const bucket = byShard.get(row.shardMonth) ?? [];
    bucket.push(row);
    byShard.set(row.shardMonth, bucket);
  }
  return [...byShard.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([shardMonth, shardRows]) => ({ shardMonth, csv: renderHistoryCsv(shardRows) }));
}

// ---------------------------------------------------------------------------
// Post-write validation: integrity of touched shards + row-count delta check.
// ---------------------------------------------------------------------------

export interface PostWriteCheckResult {
  ok: boolean;
  integrityOk: boolean;
  rowCountDeltaOk: boolean;
  expectedDelta: number;
  actualDelta: number;
  perShard: { shardMonth: string; rowCount: number; ok: boolean }[];
  failedChecks: string[];
}

export function runPostWriteCheck(input: {
  historyDir: string;
  touchedShardMonths: string[];
  existingRowCountBefore: number;
  appendedCount: number;
}): PostWriteCheckResult {
  const failedChecks: string[] = [];
  const shards = input.touchedShardMonths.map((shardMonth) => {
    const fileName = shardFileName(shardMonth);
    const csv = readFileSync(resolve(input.historyDir, fileName), "utf8");
    return { fileName, shardMonth, csv };
  });

  const integ = validatePostWriteShards(
    shards.map((s) => ({ fileName: s.fileName, csv: s.csv, expectedRowCount: -1 }))
  );
  // validatePostWriteShards enforces expectedRowCount; we only want structural
  // integrity here, so recompute the structural ok per shard.
  const perShard = integ.results.map((r) => ({
    shardMonth: shards.find((s) => s.fileName === r.fileName)?.shardMonth ?? r.fileName,
    rowCount: r.rowCount,
    ok: r.ok
  }));
  const integrityOk = perShard.every((p) => p.ok);
  if (!integrityOk) failedChecks.push("shard_integrity_failed");

  const actualDelta = perShard.reduce((acc, p) => acc + p.rowCount, 0) - input.existingRowCountBefore;
  const expectedDelta = input.appendedCount;
  const rowCountDeltaOk = actualDelta === expectedDelta;
  if (!rowCountDeltaOk) failedChecks.push(`row_count_delta:expected=${expectedDelta},actual=${actualDelta}`);

  return {
    ok: failedChecks.length === 0,
    integrityOk,
    rowCountDeltaOk,
    expectedDelta,
    actualDelta,
    perShard,
    failedChecks
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideAutoHistoryAppend(input: {
  gateAllowed: boolean;
  collectionFailed: boolean;
  newRowsPreflightOk: boolean;
  conflictCount: number;
  writeAttempted: boolean;
  writeSucceeded: boolean;
  postWriteOk: boolean;
}): AutoHistoryAppendDecision {
  if (!input.gateAllowed) return "auto_history_append_ready_not_run";
  if (input.collectionFailed) return "auto_history_append_failed_collection";
  if (!input.newRowsPreflightOk) return "auto_history_append_failed_preflight";
  if (input.conflictCount > 0) return "auto_history_append_failed_conflicts";
  if (!input.writeAttempted) return "auto_history_append_failed_validation";
  if (input.writeSucceeded && input.postWriteOk) return "auto_history_append_success";
  return "auto_history_append_failed_validation";
}

// ---------------------------------------------------------------------------
// Orchestration helper used by the runner once the gate has passed.
// ---------------------------------------------------------------------------

export interface AutoAppendExecutionResult {
  decision: AutoHistoryAppendDecision;
  newRowsPreflight: NewRowsPreflightResult;
  conflictPreflight: ConflictPreflightResult;
  writeResult: RunRealAppendResult | null;
  postWrite: PostWriteCheckResult | null;
  rowsAppended: number;
}

// Given freshly normalized rows and a confirmed-open gate, run new-row preflight,
// conflict preflight, the shared atomic write engine, and the post-write check.
export function executeAutoAppend(input: {
  historyDir: string;
  runId: string;
  backupTimestamp: string;
  newRows: HistoryRow[];
  collectionFailed: boolean;
}): AutoAppendExecutionResult {
  const newRowsPreflight = runNewRowsPreflight(input.newRows);
  const conflictPreflight = runConflictPreflight({
    historyDir: input.historyDir,
    newRows: input.newRows,
    runId: input.runId
  });

  let writeResult: RunRealAppendResult | null = null;
  let postWrite: PostWriteCheckResult | null = null;

  const canWrite =
    !input.collectionFailed && newRowsPreflight.ok && conflictPreflight.conflictCount === 0 && input.newRows.length > 0;

  if (canWrite) {
    const sourceShards = groupNewRowsToSourceShards(input.newRows);
    writeResult = runRealAppend({
      historyDir: input.historyDir,
      runId: input.runId,
      backupTimestamp: input.backupTimestamp,
      sourceShards
    });
    if (writeResult.decision === "local_history_real_append_success") {
      postWrite = runPostWriteCheck({
        historyDir: input.historyDir,
        touchedShardMonths: conflictPreflight.touchedShardMonths,
        existingRowCountBefore: conflictPreflight.existingRowCount,
        appendedCount: conflictPreflight.appendedCount
      });
    }
  }

  const decision = decideAutoHistoryAppend({
    gateAllowed: true,
    collectionFailed: input.collectionFailed,
    newRowsPreflightOk: newRowsPreflight.ok,
    conflictCount: conflictPreflight.conflictCount,
    writeAttempted: writeResult !== null,
    writeSucceeded: writeResult?.decision === "local_history_real_append_success",
    postWriteOk: postWrite?.ok ?? false
  });

  return {
    decision,
    newRowsPreflight,
    conflictPreflight,
    writeResult,
    postWrite,
    rowsAppended: writeResult?.rowsWritten ?? 0
  };
}

// ---------------------------------------------------------------------------
// CSV + report rendering
// ---------------------------------------------------------------------------

export const AUTO_APPEND_OBS_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "f_syu",
  "month_anchor",
  "date_iso",
  "day_of_week",
  "is_full",
  "is_vacant",
  "stock",
  "raw_price",
  "charge_type",
  "is_tax_exclusive"
] as const;

export function renderObservationCsv(observations: RakutenAutoDayObservation[]): string {
  const body = observations.map((o) =>
    [
      o.target.canonicalPropertyName,
      o.target.hotelNo,
      o.target.fSyu,
      o.monthAnchor,
      o.dateIso,
      o.dayOfWeek,
      String(o.isFull),
      String(o.isVacant),
      String(o.stock),
      String(o.rawPrice),
      o.chargeType,
      String(o.isTaxExclusive)
    ]
      .map(csvEscape)
      .join(",")
  );
  return [AUTO_APPEND_OBS_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export interface AutoAppendReportInput {
  generatedAtJst: string;
  runId: string;
  decision: AutoHistoryAppendDecision;
  gate: AutoAppendGateResult;
  approvalSentencePresent: boolean;
  envFlagPresent: boolean;
  requests: RakutenAutoRequest[];
  collection: CollectionResult | null;
  newRowCount: number;
  execution: AutoAppendExecutionResult | null;
  historyDirExistedBefore: boolean;
  historyFilesAfter: string[];
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function renderAutoAppendReport(input: AutoAppendReportInput): string {
  const exec = input.execution;
  const collection = input.collection;
  return [
    "# First Guarded Auto History Append Real Run (Phase AUTO08X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Policy & safety",
    "",
    "- Hard double gate: EXACT approval sentence in the current instruction AND AUTO_HISTORY_APPEND=1. Missing either → fail closed, nothing collected or written.",
    "- Bounded scope: source=rakuten only; /hplan/calendar JSONP (Method B); properties ≤ 2; requests ≤ 4; browser pages = 0; no Booking rendered DOM; no condition/reservation links.",
    "- Rakuten basis: per-person price × 2 (2 adults/1 room/1 night); basis_confidence=B; dp_usage=directional; sold-out → null price as demand pressure.",
    "- No DB writes/sync/migration/tables; no GitHub Actions/cron/GitOps/commit/push; no PMS/Beds24/AirHost/OTA; no price updates; no property-master edits; no .data/ai-context/latest mutation; no paid APIs; no CAPTCHA/stealth/login/cookie; no Booking base × 1.1.",
    "- Writes (only when the gate passes) limited to .data/history/zao_signals_YYYY_MM.csv (+ .backup/.tmp/.append.lock).",
    "",
    "## 2. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 3. Approval gate",
    "",
    `- approval_sentence_present=${input.approvalSentencePresent}`,
    `- ${AUTO_HISTORY_APPEND_ENV_FLAG}=1_present=${input.envFlagPresent}`,
    `- run_allowed=${input.gate.runAllowed}`,
    `- failed_conditions=${JSON.stringify(input.gate.failedConditions)}`,
    "",
    "## 4. Bounded request plan",
    "",
    `- request_count=${input.requests.length} (cap=${MAX_REQUESTS})`,
    `- property_count=${new Set(input.requests.map((r) => r.target.hotelNo)).size} (cap=${MAX_PROPERTIES})`,
    ...input.requests.map(
      (r) => `- ${r.target.canonicalPropertyName} hotelNo=${r.target.hotelNo} f_syu=${r.target.fSyu} month=${r.monthAnchor}`
    ),
    "",
    "## 5. Collection result",
    "",
    collection === null
      ? "- not executed (gate closed)"
      : `- requests=${collection.requestCount}, observations=${collection.observations.length}, errors=${collection.errorCount}, collection_failed=${collection.collectionFailed}`,
    ...(collection
      ? collection.requestSummaries.map(
          (s) =>
            `- ${s.canonicalPropertyName} ${s.monthAnchor}: status=${s.httpStatus}, response=${s.responseType}, days=${s.dayListLength}, obs=${s.observationCount}, available=${s.availableCount}, sold_out=${s.soldOutCount}, class=${s.classification}`
        )
      : []),
    "",
    "## 6. New rows preflight",
    "",
    `- new_row_count=${input.newRowCount}`,
    exec === null
      ? "- not executed (gate closed)"
      : `- preflight_ok=${exec.newRowsPreflight.ok}, invalid=${exec.newRowsPreflight.invalidRowCount}, schema_mismatch=${exec.newRowsPreflight.schemaVersionMismatchCount}, empty_hash=${exec.newRowsPreflight.emptyRowHashCount}, dup_row_id=${exec.newRowsPreflight.duplicateRowIdCount}`,
    "",
    "## 7. Conflict preflight",
    "",
    exec === null
      ? "- not executed (gate closed)"
      : `- existing_rows=${exec.conflictPreflight.existingRowCount}, would_append=${exec.conflictPreflight.appendedCount}, skip_identical=${exec.conflictPreflight.skippedIdenticalCount}, conflicts=${exec.conflictPreflight.conflictCount}, touched_shards=${JSON.stringify(exec.conflictPreflight.touchedShardMonths)}`,
    "",
    "## 8. Write result",
    "",
    exec?.writeResult == null
      ? "- no write attempted"
      : `- write_decision=${exec.writeResult.decision}, rows_written=${exec.writeResult.rowsWritten}, files_created=${exec.writeResult.filesCreated}, files_updated=${exec.writeResult.filesUpdated}, backups=${exec.writeResult.backupsCreated}, rolled_back=${exec.writeResult.rollbackPerformed}`,
    "",
    "## 9. Post-write validation",
    "",
    exec?.postWrite == null
      ? "- not executed"
      : `- post_write_ok=${exec.postWrite.ok}, integrity_ok=${exec.postWrite.integrityOk}, expected_delta=${exec.postWrite.expectedDelta}, actual_delta=${exec.postWrite.actualDelta}`,
    "",
    "## 10. .data/history final state",
    "",
    `- history_dir_existed_before=${input.historyDirExistedBefore}`,
    `- files_after=${JSON.stringify(input.historyFilesAfter)}`,
    "",
    "## 11. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 12. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: AutoHistoryAppendDecision): string {
  switch (decision) {
    case "auto_history_append_ready_not_run":
      return "- Gate closed (missing exact approval sentence and/or AUTO_HISTORY_APPEND=1). Nothing was collected or written. Provide the exact standalone approval sentence AND set the env flag to run.";
    case "auto_history_append_success":
      return "- First guarded auto history append succeeded. Do NOT auto-sync the DB, refresh AI context, or enable any schedule. Review the appended rows before any AUTO09X work.";
    case "auto_history_append_failed_collection":
      return "- Every bounded Rakuten request errored; nothing was written. Re-check endpoint reachability under human review. Do not widen scope.";
    case "auto_history_append_failed_preflight":
      return "- Freshly collected rows failed schema/validity preflight; nothing was written. Fix normalization before retrying.";
    case "auto_history_append_failed_conflicts":
      return "- Hash conflict(s) detected (same row_id, different row_hash); append blocked, nothing written. Resolve the conflicting row(s) before retrying.";
    case "auto_history_append_failed_validation":
      return "- Write occurred but post-write validation failed (integrity or row-count delta). Inspect .data/history and .data/history/.backup. Manual review required.";
    default:
      return "- Unknown state; inspect artifacts.";
  }
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

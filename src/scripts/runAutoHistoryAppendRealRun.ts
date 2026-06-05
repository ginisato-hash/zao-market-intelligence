// Phase AUTO08X — runner for the first guarded auto history append real run.
//
// This runner FAILS CLOSED. It performs a live bounded Rakuten /hplan/calendar
// JSONP collection AND appends normalized rows to .data/history ONLY when BOTH:
//   1. the EXACT standalone approval sentence is present in the current user
//      instruction (APPROVAL_SENTENCE_PRESENT below), AND
//   2. process.env.AUTO_HISTORY_APPEND === "1".
// Missing either → no collection, no append; it writes an
// `auto_history_append_ready_not_run` report only.
//
// It NEVER: writes/syncs/migrates the DB; runs a broad collector; performs a
// Booking rendered-DOM/Playwright fetch; enables GitHub Actions/cron/GitOps or
// commits/pushes; writes PMS/Beds24/AirHost/OTA output; updates prices; edits
// the property master; mutates .data/ai-context/latest; uses paid APIs/proxies;
// bypasses CAPTCHA / uses stealth / login / cookie injection; uses Booking base
// × 1.1; or starts DP03X/R01X. It also does NOT sync the DB, refresh AI context,
// or run the task-query CLI in this phase. Reports/debug go under .data/reports
// and .data/debug; history writes (gate-permitting) go only to .data/history.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertNotRealHistoryPath } from "../services/localHistoryAppendDryRun";
import {
  buildHplanCalendarUrl
} from "../services/rakutenHplanCalendarProbe";
import {
  AUTO_HISTORY_APPEND_ENV_FLAG,
  AUTO_HISTORY_APPEND_SOURCE,
  AUTO_HISTORY_APPEND_TARGETS,
  MAX_REQUESTS,
  buildCollectionResult,
  evaluateAutoHistoryAppendGate,
  executeAutoAppend,
  normalizeObservations,
  renderAutoAppendReport,
  renderObservationCsv,
  type AutoAppendExecutionResult,
  type AutoHistoryAppendDecision,
  type CollectionResult,
  type RakutenAutoFetchResult,
  type RakutenAutoRequest
} from "../services/autoHistoryAppendRealRun";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-history-append";
const HISTORY_DIR = ".data/history";

// The EXACT standalone approval sentence WAS provided in the user instruction
// ("Approve Phase AUTO08X first guarded auto history append real run. You may run
// the approved bounded collectors locally and append validated normalized rows to
// .data/history."). The run is additionally gated by AUTO_HISTORY_APPEND=1 at
// runtime; without that env flag it still fails closed (ready_not_run).
const APPROVAL_SENTENCE_PRESENT = true;

const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-auto-history-append/0.1; low-volume guarded)";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstParts(): { iso: string; date: string } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { iso: `${date}T${get("hour")}:${get("minute")}:${get("second")}+09:00`, date };
}

// Two near-term month anchors: the 1st of the current JST month and the 1st of
// the following month (YYYYMMDD).
function buildMonthAnchors(todayJstDate: string): string[] {
  const [y, m] = todayJstDate.split("-").map(Number) as [number, number];
  const first = `${String(y).padStart(4, "0")}${String(m).padStart(2, "0")}01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const second = `${String(nextY).padStart(4, "0")}${String(nextM).padStart(2, "0")}01`;
  return [first, second];
}

// Build the bounded request plan: targets × month anchors, capped at MAX_REQUESTS.
function buildRequests(todayJstDate: string): RakutenAutoRequest[] {
  const anchors = buildMonthAnchors(todayJstDate);
  const requests: RakutenAutoRequest[] = [];
  for (const target of AUTO_HISTORY_APPEND_TARGETS) {
    for (const monthAnchor of anchors) {
      if (requests.length >= MAX_REQUESTS) break;
      requests.push({ target, monthAnchor });
    }
  }
  return requests.slice(0, MAX_REQUESTS);
}

// Live JSONP fetch with ZERO browser pages (plain HTTP GET). Only ever called
// when the gate has passed.
async function fetchHplanJsonp(url: string): Promise<RakutenAutoFetchResult> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "X-Requested-With": "XMLHttpRequest" }
    });
    const body = await res.text();
    return { status: res.status, body, error: "" };
  } catch (e) {
    return { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  const ts = timestamp();
  const runId = `auto_history_append_${ts}`;
  const jst = jstParts();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  const historyDir = resolve(HISTORY_DIR);
  const historyExistedBefore = existsSync(historyDir);

  const requests = buildRequests(jst.date);
  const envFlag = process.env[AUTO_HISTORY_APPEND_ENV_FLAG];
  const envFlagPresent = envFlag === "1";

  const gate = evaluateAutoHistoryAppendGate({
    approvalSentencePresent: APPROVAL_SENTENCE_PRESENT,
    envAutoHistoryAppend: envFlag,
    source: AUTO_HISTORY_APPEND_SOURCE,
    propertyCount: new Set(requests.map((r) => r.target.hotelNo)).size,
    requestCount: requests.length,
    browserPages: 0,
    dbWriteMode: false,
    githubActionsMode: false
  });

  // Output dirs (NEVER under .data/history).
  assertNotRealHistoryPath(debugRootPath);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });
  const writeDebug = (name: string, data: unknown): void => {
    const target = resolve(debugRootPath, name);
    assertNotRealHistoryPath(target);
    writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
  };

  let collection: CollectionResult | null = null;
  let execution: AutoAppendExecutionResult | null = null;
  let newRowCount = 0;
  let decision: AutoHistoryAppendDecision = "auto_history_append_ready_not_run";

  if (!gate.runAllowed) {
    // FAIL CLOSED: no live collection, no history append.
    decision = "auto_history_append_ready_not_run";
  } else {
    // ---- Gate open: bounded live collection (≤4 JSONP GETs, 0 browser pages) ----
    const fetched: { request: RakutenAutoRequest; fetch: RakutenAutoFetchResult }[] = [];
    for (const request of requests) {
      const url = buildHplanCalendarUrl({
        hotelNo: request.target.hotelNo,
        fSyu: request.target.fSyu,
        monthAnchor: request.monthAnchor,
        callback: `cb_${request.target.hotelNo}_${request.monthAnchor}`,
        cacheBust: Date.now()
      });
      const fetch = await fetchHplanJsonp(url);
      writeDebug(`request_${request.target.hotelNo}_${request.monthAnchor}.json`, { url, status: fetch.status, error: fetch.error, bodyExcerpt: fetch.body.slice(0, 4000) });
      fetched.push({ request, fetch });
    }

    collection = buildCollectionResult(fetched);
    const sourceArtifact = `${REPORT_DIR}/${runId}`;
    const newRows = normalizeObservations(collection.observations, {
      collectedAtJst: jst.iso,
      normalizedAtJst: jst.iso,
      sourceReportPath: `${sourceArtifact}.md`,
      sourceCsvPath: `${sourceArtifact}.csv`,
      debugArtifactPath: debugRootPath
    });
    newRowCount = newRows.length;
    writeDebug("collection_result.json", { ...collection, observations: undefined });
    writeDebug("observations.json", collection.observations);
    writeDebug("normalized_new_rows.json", newRows);

    execution = executeAutoAppend({
      historyDir,
      runId,
      backupTimestamp: ts,
      newRows,
      collectionFailed: collection.collectionFailed
    });
    decision = execution.decision;
    writeDebug("execution_result.json", execution);
  }

  const historyFilesAfter = existsSync(historyDir) ? readdirSync(historyDir) : [];

  const safetyConfirmation = {
    approvalSentencePresent: APPROVAL_SENTENCE_PRESENT,
    envFlagPresent,
    gateRunAllowed: gate.runAllowed,
    liveCollectionExecuted: collection !== null,
    source: AUTO_HISTORY_APPEND_SOURCE,
    browserPagesUsed: 0,
    bookingRenderedDom: false,
    conditionLinksFollowed: false,
    dbWrites: false,
    dbSync: false,
    sqlExecuted: false,
    migrationsExecuted: false,
    tablesCreated: false,
    aiContextRefreshed: false,
    aiContextLatestMutated: false,
    aiTaskQueryRun: false,
    propertyMasterModified: false,
    pricesUpdated: false,
    pmsOutput: false,
    beds24Output: false,
    airhostOutput: false,
    otaUpload: false,
    bookingBaseTimes1_1: false,
    githubActionsActivated: false,
    cronActivated: false,
    gitOpsPush: false,
    versionControlCommitsOrPushes: false,
    dataRepoCreated: false,
    productionScheduleActivated: false,
    paidSources: false,
    captchaBypass: false,
    stealthPlugin: false,
    loginOrCookieInjection: false,
    startedDp03x: false,
    startedR01x: false
  };
  writeDebug("safety_confirmation.json", safetyConfirmation);
  writeDebug("approval_gate_result.json", { ...gate, approvalSentencePresent: APPROVAL_SENTENCE_PRESENT, envFlag: envFlag ?? null });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);

  const reportInput = {
    generatedAtJst: jst.iso,
    runId,
    decision,
    gate,
    approvalSentencePresent: APPROVAL_SENTENCE_PRESENT,
    envFlagPresent,
    requests,
    collection,
    newRowCount,
    execution,
    historyDirExistedBefore: historyExistedBefore,
    historyFilesAfter,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  writeFileSync(csvPath, renderObservationCsv(collection?.observations ?? []), "utf8");
  writeFileSync(
    jsonPath,
    JSON.stringify({ ...reportInput, safetyConfirmation }, null, 2),
    "utf8"
  );
  writeFileSync(reportPath, renderAutoAppendReport(reportInput), "utf8");

  console.log(`decision=${decision}`);
  console.log(`run_allowed=${gate.runAllowed}`);
  console.log(`approval_sentence_present=${APPROVAL_SENTENCE_PRESENT}`);
  console.log(`${AUTO_HISTORY_APPEND_ENV_FLAG}=1_present=${envFlagPresent}`);
  console.log(`failed_conditions=${JSON.stringify(gate.failedConditions)}`);
  console.log(`new_row_count=${newRowCount}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_root=${debugRootPath}`);
  console.log(`history_dir_exists=${existsSync(historyDir)}`);

  if (
    decision !== "auto_history_append_ready_not_run" &&
    decision !== "auto_history_append_success"
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

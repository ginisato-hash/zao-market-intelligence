// Phase JALAN-AUTO03B - improved bounded Jalan collection probe (live).
//
// Uses browser automation only for the 25 fixed AUTO02X Jalan property/date
// targets, identical to AUTO03X, but applies the coupon-aware classifier from
// jalanBoundedCollectionProbeImproved. The selected price block text and the
// broader page text are captured SEPARATELY so the classifier can split
// selected-plan coupon evidence (hard) from generic page-chrome evidence (soft).
//
// The primary-source directional backbone is unchanged; Jalan stays a
// supplementary domestic OTA signal. This script writes source-discovery
// report/debug artifacts and preview rows only. No history append, DB
// write/sync, AI context refresh, pricing CSV, or PMS output.

import { chromium, type Browser } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectJalanStatus } from "../collectors/jalanStatusDetection";
import { analyzeJalanPlanPageExtractionEvidence } from "../collectors/jalanEvidence";
import {
  collectVisibleJalanPlanBlockTexts,
  extractJalanPlanBlocks
} from "../collectors/jalanPlanBlockExtractor";
import { selectAcceptedJalanPriceCandidate } from "../collectors/jalanAcceptedPricePolicy";
import { chooseJalanNavigationCandidate, collectJalanLinkCandidates } from "../collectors/jalanLinkInspector";
import {
  buildAuto03xComparison,
  buildFutureAuto04xPlan,
  buildImprovedPreviewRow,
  buildImprovedSummaries,
  buildRescuedRows,
  buildSafetyConfirmation,
  decideImproved,
  loadAuto02xTargetMatrix,
  renderImprovedPreviewRowsCsv,
  renderImprovedReport,
  type Auto03xPriorRow,
  type JalanImprovedExtractionCandidate,
  type JalanImprovedPreviewRow,
  type JalanProbeTarget,
  type ProbeAvailabilityStatus
} from "../services/jalanBoundedCollectionProbeImproved";

const AUTO02X_ARTIFACT = ".data/reports/automation/jalan_target_matrix_proposal_20260604_220220.json";
const AUTO03X_ARTIFACT = ".data/reports/source-discovery/jalan_bounded_collection_probe_20260604_232102.json";
const AUTO03R_ARTIFACT = ".data/reports/source-discovery/jalan_probe_result_review_20260604_235116.json";
const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/jalan-bounded-collection-probe-improved";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeName(target: JalanProbeTarget): string {
  return `${target.jalan_yad_id}_${target.checkin}`;
}

function loadAuto03xPriorRows(artifact: Record<string, unknown>): Auto03xPriorRow[] {
  const rows = Array.isArray(artifact["normalized_preview_rows"]) ? (artifact["normalized_preview_rows"] as Record<string, unknown>[]) : [];
  return rows.map((row) => ({
    source_slug_or_code: String(row["source_slug_or_code"] ?? ""),
    checkin: String(row["checkin"] ?? ""),
    dp_usage: String(row["dp_usage"] ?? ""),
    normalized_total_price:
      typeof row["normalized_total_price"] === "number" ? (row["normalized_total_price"] as number) : null
  }));
}

export interface PageResult {
  target_id: string;
  canonical_property_name: string;
  jalan_yad_id: string;
  checkin: string;
  checkout: string;
  target_url: string;
  final_url: string | null;
  http_status: number | null;
  attempt_count: number;
  retry_used: boolean;
  final_status: ProbeAvailabilityStatus;
  price_total_tax_included: number | null;
  basis_confidence: string;
  dp_usage: string;
  hard_exclusion_reason: string;
  direct_downgrade_reason: string;
  directional_downgrade_reason: string;
  error_reason: string | null;
  screenshot_path: string | null;
  text_excerpt_path: string | null;
  html_excerpt_path: string | null;
  target_result_json_path: string;
  warning_flags: string[];
}

export async function collectTarget(input: {
  browser: Browser;
  target: JalanProbeTarget;
  runId: string;
  checkedAt: string;
  debugPath: string;
  reportPath: string;
  csvPath: string;
}): Promise<{ pageResult: PageResult; row: JalanImprovedPreviewRow }> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= 1) {
    attempt += 1;
    try {
      return await collectTargetOnce({ ...input, attemptCount: attempt, retryUsed: attempt > 1 });
    } catch (error) {
      lastError = error;
      if (attempt > 1) break;
    }
  }
  return buildThrownFailure({ ...input, error: lastError, attemptCount: attempt, retryUsed: attempt > 1 });
}

async function collectTargetOnce(input: {
  browser: Browser;
  target: JalanProbeTarget;
  runId: string;
  checkedAt: string;
  debugPath: string;
  reportPath: string;
  csvPath: string;
  attemptCount: number;
  retryUsed: boolean;
}): Promise<{ pageResult: PageResult; row: JalanImprovedPreviewRow }> {
  const page = await input.browser.newPage({
    userAgent: "Mozilla/5.0 (compatible; zao-market-intelligence-auto03b/0.1; bounded manual verification)"
  });
  page.setDefaultTimeout(20_000);

  const name = safeName(input.target);
  const screenshotPath = resolve(input.debugPath, "screenshots", `${name}.png`);
  const textPath = resolve(input.debugPath, "text", `${name}.txt`);
  const htmlPath = resolve(input.debugPath, "html", `${name}.html`);
  const targetJsonPath = resolve(input.debugPath, "classification_decisions", `${name}.json`);
  const evidenceJsonPath = resolve(input.debugPath, "evidence_flags", `${name}.json`);
  let screenshot: string | null = null;
  let bodyText = "";
  let html = "";
  let finalUrl: string | null = null;
  let httpStatus: number | null = null;

  try {
    const response = await page.goto(input.target.target_url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    httpStatus = response?.status() ?? null;
    await page.waitForTimeout(1_200);
    finalUrl = page.url();
    bodyText = await page.locator("body").innerText({ timeout: 8_000 });
    html = await page.content();
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshot = screenshotPath;
    } catch {
      screenshot = null;
    }

    let blockTexts = await collectVisibleJalanPlanBlockTexts(page).catch(() => []);
    let candidate = extractCandidateFromState({
      target: input.target,
      bodyText,
      finalUrl: finalUrl ?? input.target.target_url,
      httpStatus,
      screenshotPath: screenshot,
      blockTexts
    });

    if (candidate.price_total_tax_included === null && candidate.availability_status === "failed") {
      const navigated = await attemptBoundedPlanClick(page);
      if (navigated) {
        await page.waitForTimeout(1_200);
        finalUrl = page.url();
        bodyText = await page.locator("body").innerText({ timeout: 8_000 });
        html = await page.content();
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          screenshot = screenshotPath;
        } catch {
          screenshot = null;
        }
        blockTexts = await collectVisibleJalanPlanBlockTexts(page).catch(() => []);
        candidate = extractCandidateFromState({
          target: input.target,
          bodyText,
          finalUrl: finalUrl ?? input.target.target_url,
          httpStatus,
          screenshotPath: screenshot,
          blockTexts
        });
      }
    }

    writeFileSync(textPath, bodyText.slice(0, 30_000), "utf8");
    writeFileSync(htmlPath, html.slice(0, 80_000), "utf8");

    const row = buildImprovedPreviewRow({
      runId: input.runId,
      checkedAt: input.checkedAt,
      target: input.target,
      candidate,
      reportPath: input.reportPath,
      csvPath: input.csvPath,
      debugPath: targetJsonPath
    });
    const pageResult: PageResult = {
      target_id: input.target.target_id,
      canonical_property_name: input.target.canonical_property_name,
      jalan_yad_id: input.target.jalan_yad_id,
      checkin: input.target.checkin,
      checkout: input.target.checkout,
      target_url: input.target.target_url,
      final_url: finalUrl,
      http_status: httpStatus,
      attempt_count: input.attemptCount,
      retry_used: input.retryUsed,
      final_status: row.availability_status,
      price_total_tax_included: row.normalized_total_price,
      basis_confidence: row.basis_confidence,
      dp_usage: row.dp_usage,
      hard_exclusion_reason: row.hard_exclusion_reason,
      direct_downgrade_reason: row.direct_downgrade_reason,
      directional_downgrade_reason: row.directional_downgrade_reason,
      error_reason: row.error_reason || null,
      screenshot_path: screenshot,
      text_excerpt_path: textPath,
      html_excerpt_path: htmlPath,
      target_result_json_path: targetJsonPath,
      warning_flags: row.warning_flags === "" ? [] : row.warning_flags.split(";")
    };
    writeJson(targetJsonPath, { target: input.target, pageResult, row, candidate });
    writeJson(evidenceJsonPath, { target: input.target, evidence_flags: row.evidence_flags });
    return { pageResult, row };
  } finally {
    await page.close();
  }
}

async function attemptBoundedPlanClick(page: import("playwright").Page): Promise<boolean> {
  const candidates = await collectJalanLinkCandidates(page, page.url()).catch(() => []);
  const { chosen } = chooseJalanNavigationCandidate(candidates);
  if (chosen === null) return false;
  try {
    const locator = page.locator("a, button, input[type='submit'], input[type='button']").nth(chosen.index);
    await locator.click({ timeout: 10_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function extractCandidateFromState(input: {
  target: JalanProbeTarget;
  bodyText: string;
  finalUrl: string;
  httpStatus: number | null;
  screenshotPath: string | null;
  blockTexts: string[];
}): JalanImprovedExtractionCandidate {
  const base = {
    facility_name: extractFacilityName(input.bodyText) ?? input.target.canonical_property_name,
    meal_condition: extractMealCondition(input.bodyText),
    source_url: input.finalUrl,
    screenshot_path: input.screenshotPath,
    page_text_excerpt: input.bodyText.slice(0, 8000),
    date_condition_evidence: urlConfirmsStayDate(input.finalUrl, input.target.checkin),
    stay_scope_evidence: urlConfirmsStayScope(input.finalUrl),
    property_identity_confirmed: input.httpStatus !== 404 && input.finalUrl.includes(input.target.jalan_yad_id.replace(/^yad/u, "")),
    price_per_person: null
  };

  if (input.httpStatus === 404) {
    return {
      ...base,
      room_or_plan_name: null,
      room_name: null,
      plan_name: null,
      selected_block_text: "",
      availability_status: "not_found",
      price_total_tax_included: null,
      price_basis_text: "missing",
      tax_included_evidence: false,
      error_reason: "not_found",
      extraction_confidence: "low"
    };
  }

  const statusDetection = detectJalanStatus(input.bodyText);
  const selectedCalendarStatus = detectSelectedDateCalendarStatus(input.bodyText, input.target.checkin);
  if (selectedCalendarStatus === "sold_out") {
    return {
      ...base,
      room_or_plan_name: null,
      room_name: null,
      plan_name: null,
      selected_block_text: "",
      availability_status: "sold_out",
      price_total_tax_included: null,
      price_basis_text: "missing",
      tax_included_evidence: false,
      error_reason: "selected_date_calendar_sold_out",
      extraction_confidence: "low"
    };
  }

  const blockTexts = input.blockTexts.length > 0 ? input.blockTexts : extractPlanBlockTextsFromTextFallback(input.bodyText);
  const extraction = extractJalanPlanBlocks({
    blockTexts,
    pageUrl: input.finalUrl,
    stayDate: input.target.checkin,
    adults: 2,
    rooms: 1,
    nights: 1
  });
  const selection = selectAcceptedJalanPriceCandidate(extraction.candidates, "cheapest_total_tax_included_safe_plan");
  const selected = selection.selectedCandidate;
  if (selected !== undefined && selected.priceValue !== undefined) {
    return {
      ...base,
      property_identity_confirmed: base.property_identity_confirmed && !hasOtherFacilityContext(selected.blockText, input.target.canonical_property_name),
      room_or_plan_name: selected.planName ?? selected.roomName ?? null,
      room_name: selected.roomName ?? null,
      plan_name: selected.planName ?? null,
      selected_block_text: selected.blockText,
      meal_condition: extractMealCondition(selected.blockText) ?? base.meal_condition,
      availability_status: "available",
      price_total_tax_included: selected.priceValue,
      price_basis_text: selected.priceText ?? "合計(税込)",
      tax_included_evidence: selected.hasTotalTaxIncludedEvidence,
      error_reason: null,
      extraction_confidence: selected.confidence
    };
  }

  const evidence = analyzeJalanPlanPageExtractionEvidence(input.bodyText, input.target.checkin, input.finalUrl);
  if (evidence.priceFound && evidence.priceBasis === "total_tax_included" && evidence.priceValue !== undefined) {
    return {
      ...base,
      room_or_plan_name: null,
      room_name: null,
      plan_name: null,
      selected_block_text: evidence.surroundingText ?? "",
      availability_status: "available",
      price_total_tax_included: evidence.priceValue,
      price_basis_text: evidence.priceText ?? "total_tax_included",
      tax_included_evidence: true,
      error_reason: null,
      extraction_confidence: evidence.confidence
    };
  }

  const status = normalizeStatus(statusDetection.status);
  return {
    ...base,
    room_or_plan_name: null,
    room_name: null,
    plan_name: null,
    selected_block_text: "",
    availability_status: status,
    price_total_tax_included: null,
    price_basis_text: "missing_or_unclear",
    tax_included_evidence: false,
    error_reason: statusDetection.errorReason ?? evidence.rejectionReason ?? (status === "failed" ? "price_missing_or_basis_unclear" : null),
    extraction_confidence: "low"
  };
}

function extractPlanBlockTextsFromTextFallback(bodyText: string): string[] {
  return bodyText
    .split(/\n{2,}/u)
    .map((block) => block.replace(/\s+/gu, " ").trim())
    .filter((block) => block.includes("合計") && block.includes("円") && block.length >= 40 && block.length <= 2500)
    .slice(0, 30);
}

function buildThrownFailure(input: {
  target: JalanProbeTarget;
  runId: string;
  checkedAt: string;
  debugPath: string;
  reportPath: string;
  csvPath: string;
  error: unknown;
  attemptCount: number;
  retryUsed: boolean;
}): { pageResult: PageResult; row: JalanImprovedPreviewRow } {
  const name = safeName(input.target);
  const targetJsonPath = resolve(input.debugPath, "classification_decisions", `${name}.json`);
  const errorMessage = input.error instanceof Error ? input.error.message : "unknown_error";
  const candidate: JalanImprovedExtractionCandidate = {
    facility_name: input.target.canonical_property_name,
    room_or_plan_name: null,
    room_name: null,
    plan_name: null,
    meal_condition: null,
    availability_status: "failed",
    price_total_tax_included: null,
    price_per_person: null,
    price_basis_text: "missing",
    tax_included_evidence: false,
    stay_scope_evidence: false,
    date_condition_evidence: false,
    property_identity_confirmed: false,
    screenshot_path: null,
    source_url: input.target.target_url,
    selected_block_text: "",
    page_text_excerpt: "",
    error_reason: `navigation_or_collection_failed: ${errorMessage}`,
    extraction_confidence: "low"
  };
  const row = buildImprovedPreviewRow({
    runId: input.runId,
    checkedAt: input.checkedAt,
    target: input.target,
    candidate,
    reportPath: input.reportPath,
    csvPath: input.csvPath,
    debugPath: targetJsonPath
  });
  const pageResult: PageResult = {
    target_id: input.target.target_id,
    canonical_property_name: input.target.canonical_property_name,
    jalan_yad_id: input.target.jalan_yad_id,
    checkin: input.target.checkin,
    checkout: input.target.checkout,
    target_url: input.target.target_url,
    final_url: null,
    http_status: null,
    attempt_count: input.attemptCount,
    retry_used: input.retryUsed,
    final_status: "failed",
    price_total_tax_included: null,
    basis_confidence: row.basis_confidence,
    dp_usage: row.dp_usage,
    hard_exclusion_reason: row.hard_exclusion_reason,
    direct_downgrade_reason: row.direct_downgrade_reason,
    directional_downgrade_reason: row.directional_downgrade_reason,
    error_reason: row.error_reason,
    screenshot_path: null,
    text_excerpt_path: null,
    html_excerpt_path: null,
    target_result_json_path: targetJsonPath,
    warning_flags: row.warning_flags === "" ? [] : row.warning_flags.split(";")
  };
  writeJson(targetJsonPath, { target: input.target, pageResult, row, candidate });
  writeJson(resolve(input.debugPath, "errors", `${name}.json`), { target: input.target, error: errorMessage });
  return { pageResult, row };
}

function normalizeStatus(status: string): ProbeAvailabilityStatus {
  if (status === "available" || status === "sold_out" || status === "not_listed" || status === "not_found" || status === "failed") {
    return status;
  }
  return "failed";
}

function extractFacilityName(text: string): string | null {
  const line = text.split(/\n/u).map((part) => part.trim()).find((part) => /蔵王|ホテル|温泉|JURIN|HAMMOND|吉田屋|喜らく/u.test(part));
  return line?.slice(0, 120) ?? null;
}

function extractMealCondition(text: string): string | null {
  return text.match(/食事なし|素泊まり|朝食(?:あり|付き|付)?|夕食(?:あり|付き|付)?|２食付き|2食付き|一泊二食/u)?.[0] ?? null;
}

function detectSelectedDateCalendarStatus(text: string, checkin: string): "available" | "sold_out" | "unknown" {
  const [year, monthRaw, dayRaw] = checkin.split("-");
  if (year === undefined || monthRaw === undefined || dayRaw === undefined) return "unknown";
  const month = String(Number(monthRaw));
  const day = String(Number(dayRaw));
  const monthIndex = text.indexOf(`${year}年${month}月`);
  if (monthIndex < 0) return "unknown";
  const monthBlock = text.slice(monthIndex, monthIndex + 2500);
  const dayPattern = new RegExp(`(?:^|\\n|\\s)${day}(?:\\n|\\s)+(?<marker>○|▲|×|満|[0-9０-９]+\\s*部屋)`, "u");
  const marker = monthBlock.match(dayPattern)?.groups?.marker;
  if (marker === undefined) return "unknown";
  if (/×|満/u.test(marker)) return "sold_out";
  return "available";
}

function hasOtherFacilityContext(blockText: string, canonicalPropertyName: string): boolean {
  const normalizedTarget = canonicalPropertyName.toLocaleLowerCase();
  const normalizedBlock = blockText.toLocaleLowerCase();
  const otherFacilityPatterns = [
    /森のホテル\s*ヴァルトベルク/u,
    /蔵王国際ホテル/u,
    /蔵王四季のホテル/u,
    /おおみや旅館/u,
    /深山荘\s*高見屋/u,
    /名湯リゾート\s*ルーセント/u,
    /名湯舎\s*創/u,
    /jurin/iu,
    /hammond/iu,
    /吉田屋/u,
    /ル・ベール蔵王/u
  ];
  return otherFacilityPatterns.some((pattern) => pattern.test(blockText)) && !normalizedBlock.includes(normalizedTarget);
}

function urlConfirmsStayDate(urlText: string, checkin: string): boolean {
  const [year, month, day] = checkin.split("-");
  if (year === undefined || month === undefined || day === undefined) return false;
  try {
    const url = new URL(urlText);
    return url.searchParams.get("stayYear") === year && url.searchParams.get("stayMonth") === month && url.searchParams.get("stayDay") === day;
  } catch {
    return false;
  }
}

function urlConfirmsStayScope(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    return url.searchParams.get("stayCount") === "1" && (url.searchParams.get("roomCrack") ?? "").startsWith("2") && url.searchParams.get("roomCount") === "1";
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const ts = timestamp();
  const runId = `jalan_bounded_collection_probe_improved_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(resolve(debugPath, "screenshots"), { recursive: true });
  mkdirSync(resolve(debugPath, "html"), { recursive: true });
  mkdirSync(resolve(debugPath, "text"), { recursive: true });
  mkdirSync(resolve(debugPath, "errors"), { recursive: true });
  mkdirSync(resolve(debugPath, "evidence_flags"), { recursive: true });
  mkdirSync(resolve(debugPath, "classification_decisions"), { recursive: true });

  const reportPath = resolve(REPORT_DIR, `jalan_bounded_collection_probe_improved_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `jalan_bounded_collection_probe_improved_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `jalan_bounded_collection_probe_improved_${ts}.csv`);

  const auto02x = readJson(AUTO02X_ARTIFACT);
  const targets = loadAuto02xTargetMatrix(auto02x);
  writeJson(resolve(debugPath, "target_matrix.json"), targets);

  const auto03xPriorRows = loadAuto03xPriorRows(readJson(AUTO03X_ARTIFACT));

  const browser = await chromium.launch({ headless: true });
  const pageResults: PageResult[] = [];
  const rows: JalanImprovedPreviewRow[] = [];
  try {
    for (const target of targets) {
      const result = await collectTarget({ browser, target, runId, checkedAt: generatedAtJst, debugPath, reportPath, csvPath });
      pageResults.push(result.pageResult);
      rows.push(result.row);
    }
  } finally {
    await browser.close();
  }

  const summaries = buildImprovedSummaries({ targets, rows });
  const comparison = buildAuto03xComparison({ priorRows: auto03xPriorRows, rows });
  const rescuedRows = buildRescuedRows({ priorRows: auto03xPriorRows, rows });
  const directionalCount = rows.filter((row) => row.dp_usage === "directional").length;
  const decision = decideImproved({
    targetCount: targets.length,
    rowCount: rows.length,
    failedCount: summaries.failure_summary["failed_count"] as number,
    blockedCount: rows.filter((row) => /block|captcha/u.test(row.error_reason)).length,
    pricedRows: summaries.normalized_preview_rows_summary["priced_rows"] as number,
    directionalCount,
    screenshotCount: summaries.screenshot_summary["screenshot_count"] as number
  });
  const futureAuto04xPlan = buildFutureAuto04xPlan();
  const safetyConfirmation = buildSafetyConfirmation();
  const nextPhase =
    directionalCount > 0
      ? "JALAN-AUTO04X — Jalan history append proposal (directional-only). Do not start without explicit instruction."
      : "JALAN-AUTO03C — Jalan extractor/manual evidence refinement. Do not start without explicit instruction.";

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto02x_artifact: AUTO02X_ARTIFACT,
    source_auto03x_artifact: AUTO03X_ARTIFACT,
    source_auto03r_artifact: AUTO03R_ARTIFACT,
    target_matrix_summary: summaries.target_matrix_summary,
    page_results_summary: summaries.page_results_summary,
    normalized_preview_rows_summary: summaries.normalized_preview_rows_summary,
    auto03x_comparison_summary: comparison,
    direct_directional_excluded_summary: summaries.direct_directional_excluded_summary,
    availability_summary: summaries.availability_summary,
    confidence_summary: summaries.confidence_summary,
    price_basis_summary: summaries.price_basis_summary,
    coupon_discount_evidence_summary: summaries.coupon_discount_evidence_summary,
    evidence_flags_summary: summaries.evidence_flags_summary,
    screenshot_summary: summaries.screenshot_summary,
    failure_summary: summaries.failure_summary,
    rescued_rows_summary: { rescued_count: rescuedRows.length, rescued_rows: rescuedRows },
    normalized_preview_rows: rows,
    future_auto04x_plan: futureAuto04xPlan,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase
  };

  writeJson(resolve(debugPath, "page_results.json"), pageResults);
  writeJson(resolve(debugPath, "normalized_preview_rows.json"), rows);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderImprovedPreviewRowsCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderImprovedReport({
      generatedAtJst,
      decision,
      sourceAuto02xArtifact: AUTO02X_ARTIFACT,
      sourceAuto03xArtifact: AUTO03X_ARTIFACT,
      sourceAuto03rArtifact: AUTO03R_ARTIFACT,
      targetMatrixSummary: summaries.target_matrix_summary,
      pageResultsSummary: summaries.page_results_summary,
      normalizedPreviewRowsSummary: summaries.normalized_preview_rows_summary,
      auto03xComparison: comparison,
      availabilitySummary: summaries.availability_summary,
      priceBasisSummary: summaries.price_basis_summary,
      couponDiscountEvidenceSummary: summaries.coupon_discount_evidence_summary,
      directDirectionalExcludedSummary: summaries.direct_directional_excluded_summary,
      rescuedRows,
      failureSummary: summaries.failure_summary,
      screenshotSummary: summaries.screenshot_summary,
      futureAuto04xPlan,
      safetyConfirmation
    }),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        decision,
        report_path: reportPath,
        json_path: jsonPath,
        csv_path: csvPath,
        debug_path: debugPath,
        target_count: targets.length,
        row_count: rows.length,
        availability_summary: summaries.availability_summary,
        dp_usage_summary: summaries.direct_directional_excluded_summary,
        auto03x_comparison: comparison,
        rescued_count: rescuedRows.length
      },
      null,
      2
    )
  );
}

if (process.argv[1]?.endsWith("probeJalanBoundedCollectionImproved.ts")) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

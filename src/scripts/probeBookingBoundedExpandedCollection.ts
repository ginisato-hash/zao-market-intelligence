// Phase BOOKING-B09X — run the bounded expanded Booking.com collection.
//
// Bounded rendered-DOM probe over the B08X-approved fixed Booking property/date
// matrix only. Produces normalized preview rows and local artifacts. No history
// append, DB write/sync, AI context refresh, slug discovery, search scraping, or
// PMS/OTA output.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import {
  buildB04ARow,
  detectFinalAllInTotalVisible,
  type B04ARow
} from "../services/bookingOfficialTaxFeeTotalHardening";
import {
  extractPrimaryRateCardCandidate,
  REQUIRED_BOOKING_SELECTORS,
  summarizeSelectorPresence,
  type SelectorPresence
} from "../services/bookingRateCardExtractionProbe";
import { sanitizeBookingUrl } from "../services/bookingRenderedDomProbe";
import {
  buildB09XFutureB10XPlan,
  buildB09XSafetyConfirmation,
  buildB09XSchemaCompatibilitySummary,
  buildB09XUrl,
  decideB09X,
  normalizeB09XRows,
  renderB09XCsv,
  renderB09XReport,
  summarizeB09XBlockDetection,
  summarizeB09XPriceBasis,
  summarizeB09XRows,
  validateB09XTargetMatrix,
  type B08XProposalLike
} from "../services/bookingBoundedExpandedCollection";

const SOURCE_B08X_ARTIFACT_PATH =
  ".data/reports/source-discovery/booking_target_matrix_expansion_proposal_20260604_160105.json";
const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/booking-bounded-expanded-collection";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-booking-b09x-bounded-expanded/0.1; low-volume fixed-property-pages)";
const PER_PAGE_TIMEOUT_MS = 35_000;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstParts(): { iso: string; date: string } {
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
  const iso = `${formatted.replace(" ", "T")}+09:00`;
  return { iso, date: iso.slice(0, 10) };
}

async function selectorPresence(page: Page): Promise<SelectorPresence> {
  const entries = await Promise.all(
    Object.entries(REQUIRED_BOOKING_SELECTORS).map(async ([key, selector]) => [
      key,
      await page.locator(selector).count().catch(() => 0)
    ])
  );
  return summarizeSelectorPresence(Object.fromEntries(entries) as Partial<SelectorPresence>);
}

async function headlineName(page: Page, bodyText: string): Promise<string> {
  const selectorText = await page
    .locator(REQUIRED_BOOKING_SELECTORS.propertyHeadlineName)
    .first()
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  if (selectorText.trim()) return selectorText.trim();
  return bodyText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /Hotel|ホテル|旅館|高見屋|蔵王/u.test(line)) ?? "";
}

interface CapturedPage {
  httpStatus: number;
  finalUrl: string;
  pageTitle: string;
  bodyText: string;
  presence: SelectorPresence;
  headline: string;
  error: string;
}

async function loadPage(page: Page, url: string): Promise<CapturedPage> {
  let httpStatus = 0;
  let finalUrl = url;
  let pageTitle = "";
  let bodyText = "";
  let presence = summarizeSelectorPresence({});
  let headline = "";
  let error = "";
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: PER_PAGE_TIMEOUT_MS });
    httpStatus = response?.status() ?? 0;
    await page.waitForTimeout(5_000);
    finalUrl = page.url();
    pageTitle = await page.title().catch(() => "");
    bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    presence = await selectorPresence(page);
    headline = await headlineName(page, bodyText);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    finalUrl = page.url() || url;
  }
  return { httpStatus, finalUrl, pageTitle, bodyText, presence, headline, error };
}

async function runB09X(): Promise<{
  decision: string;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
  rows: number;
}> {
  const ts = timestamp();
  const runId = `booking_bounded_expanded_collection_${ts}`;
  const { iso: generatedAtJst, date: collectedDateJst } = jstParts();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  const pagesDebugPath = join(debugPath, "pages");
  mkdirSync(reportDir, { recursive: true });
  await mkdir(pagesDebugPath, { recursive: true });

  const sourceB08xArtifactPath = resolve(SOURCE_B08X_ARTIFACT_PATH);
  const proposal = JSON.parse(await readFile(sourceB08xArtifactPath, "utf8")) as B08XProposalLike;
  const matrix = proposal.proposed_b09x_target_matrix ?? [];
  const matrixValidation = validateB09XTargetMatrix(matrix);

  const reportPath = resolve(REPORT_DIR, `booking_bounded_expanded_collection_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `booking_bounded_expanded_collection_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `booking_bounded_expanded_collection_${ts}.csv`);

  const b04aRows: B04ARow[] = [];
  const pageResults: Record<string, unknown>[] = [];

  if (matrixValidation.valid) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
    try {
      for (const cell of matrix) {
        const url = buildB09XUrl(cell);
        const artifactDir = join(pagesDebugPath, `${cell.booking_slug}_${cell.checkin}`);
        await mkdir(artifactDir, { recursive: true });
        const page = await context.newPage();
        page.setDefaultTimeout(PER_PAGE_TIMEOUT_MS);
        const captured = await loadPage(page, url);
        await page.screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: true }).catch(() => undefined);
        await page.close().catch(() => undefined);

        const candidate = extractPrimaryRateCardCandidate(captured.error ? `${captured.bodyText}\n${captured.error}` : captured.bodyText);
        const finalAllInTotalVisible = detectFinalAllInTotalVisible(captured.bodyText);
        const b04aRow = buildB04ARow({
          runId,
          collectedAtJst: generatedAtJst,
          target: { canonicalPropertyName: cell.canonical_property_name, slug: cell.booking_slug },
          checkin: cell.checkin,
          finalUrl: captured.finalUrl,
          httpStatus: captured.httpStatus,
          pageTitle: captured.pageTitle,
          propertyHeadlineName: captured.headline,
          visibleText: captured.error ? `${captured.bodyText}\n${captured.error}` : captured.bodyText,
          selectorPresence: captured.presence,
          debugArtifactPath: artifactDir,
          finalAllInTotalVisible
        });
        b04aRows.push(b04aRow);

        const pageResult = {
          canonical_property_name: cell.canonical_property_name,
          booking_slug: cell.booking_slug,
          checkin: cell.checkin,
          checkout: cell.checkout,
          url_sanitized: sanitizeBookingUrl(url),
          final_url_sanitized: sanitizeBookingUrl(captured.finalUrl),
          http_status: captured.httpStatus,
          page_title: captured.pageTitle,
          body_text_length: captured.bodyText.length,
          selector_presence: captured.presence,
          price_candidate: candidate,
          b04a_classification: b04aRow.classification,
          blocking_or_modal_state: b04aRow.blockingOrModalState,
          debug_artifact_path: artifactDir
        };
        pageResults.push(pageResult);
        await writeFile(join(artifactDir, "url_sanitized.txt"), sanitizeBookingUrl(url), "utf8");
        await writeFile(join(artifactDir, "final_url_sanitized.txt"), sanitizeBookingUrl(captured.finalUrl), "utf8");
        await writeFile(join(artifactDir, "visible_text.txt"), captured.bodyText.slice(0, 500_000), "utf8");
        await writeFile(join(artifactDir, "selector_presence.json"), JSON.stringify(captured.presence, null, 2), "utf8");
        await writeFile(join(artifactDir, "price_candidate.json"), JSON.stringify(candidate, null, 2), "utf8");
        await writeFile(join(artifactDir, "b04a_row.json"), JSON.stringify(b04aRow, null, 2), "utf8");
      }
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  const rows = normalizeB09XRows(b04aRows, {
    collectedDateJst,
    collectedAtJst: generatedAtJst,
    normalizedAtJst: generatedAtJst,
    sourceReportPath: reportPath,
    sourceCsvPath: csvPath
  });
  const normalizedRowsSummary = summarizeB09XRows(rows);
  const priceBasisSummary = summarizeB09XPriceBasis(rows);
  const dpUsageSummary = {
    directional: rows.filter((row) => row.dp_usage === "directional").length,
    excluded: rows.filter((row) => row.dp_usage === "excluded").length,
    direct: 0
  };
  const blockDetectionSummary = summarizeB09XBlockDetection(rows);
  const schemaCompatibilitySummary = buildB09XSchemaCompatibilitySummary(rows);
  const futureB10xAppendPlan = buildB09XFutureB10XPlan();
  const safetyConfirmation = buildB09XSafetyConfirmation();
  const decision = decideB09X({
    matrixValidation,
    rows,
    blockSummary: blockDetectionSummary,
    schemaCompatibility: schemaCompatibilitySummary
  });

  const pageResultsSummary = {
    attempted_pages: pageResults.length,
    target_pages: matrix.length,
    b04a_classification_counts: countBy(pageResults.map((r) => String(r.b04a_classification ?? ""))),
    http_status_counts: countBy(pageResults.map((r) => String(r.http_status ?? "")))
  };

  writeFileSync(csvPath, renderB09XCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderB09XReport({
      generatedAtJst,
      decision,
      sourceB08xArtifactPath,
      targetMatrixSummary: matrixValidation,
      pageResultsSummary,
      normalizedRowsSummary,
      priceBasisSummary,
      dpUsageSummary,
      blockDetectionSummary,
      schemaCompatibilitySummary,
      futureB10xPlan: futureB10xAppendPlan,
      reportPath,
      jsonPath,
      csvPath,
      debugPath
    }),
    "utf8"
  );

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_b08x_artifact_path: sourceB08xArtifactPath,
    target_matrix_summary: matrixValidation,
    page_results_summary: pageResultsSummary,
    normalized_rows_summary: normalizedRowsSummary,
    price_basis_summary: priceBasisSummary,
    dp_usage_summary: dpUsageSummary,
    block_detection_summary: blockDetectionSummary,
    schema_compatibility_summary: schemaCompatibilitySummary,
    normalized_rows_preview: rows,
    future_b10x_append_plan: futureB10xAppendPlan,
    safety_confirmation: safetyConfirmation,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };
  writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");

  await writeFile(join(debugPath, "source_b08x_proposal.json"), JSON.stringify(proposal, null, 2), "utf8");
  await writeFile(join(debugPath, "target_matrix.json"), JSON.stringify(matrix, null, 2), "utf8");
  await writeFile(join(debugPath, "page_results.json"), JSON.stringify(pageResults, null, 2), "utf8");
  await writeFile(join(debugPath, "normalized_rows_preview.json"), JSON.stringify(rows, null, 2), "utf8");
  await writeFile(join(debugPath, "price_basis_summary.json"), JSON.stringify(priceBasisSummary, null, 2), "utf8");
  await writeFile(join(debugPath, "block_detection_summary.json"), JSON.stringify(blockDetectionSummary, null, 2), "utf8");
  await writeFile(join(debugPath, "schema_compatibility_summary.json"), JSON.stringify(schemaCompatibilitySummary, null, 2), "utf8");
  await writeFile(join(debugPath, "safety_confirmation.json"), JSON.stringify(safetyConfirmation, null, 2), "utf8");

  return { decision, reportPath, jsonPath, csvPath, debugPath, rows: rows.length };
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

runB09X()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`json_path=${result.jsonPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`debug_artifact_path=${result.debugPath}`);
    console.log(`rows=${result.rows}`);
    console.log(`decision=${result.decision}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

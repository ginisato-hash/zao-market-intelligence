// Phase BOOKING-B05X — orchestrate the broader (bounded) Booking.com normalized
// collection prototype.
//
// Opens a BOUNDED set of fixed Booking.com property-page URLs with Playwright
// normal rendering only (no search results, no pagination, no broad crawl). For
// each page it extracts the official base price + visible tax/fee adder (Phase
// B04A policy: total = base + adder, never base × 1.1) and produces a normalized
// row preview compatible with the local .data/history schema and its DB mirror.
//
// It appends NO history, writes NO DB rows, refreshes NO AI context, runs NO
// GitHub Actions, follows NO links beyond the fixed URLs, uses NO login / cookie
// injection / stealth / CAPTCHA bypass, and uses NO paid data tooling. If a
// block / consent wall / 403 / CAPTCHA appears it records the state and moves on.

import { mkdir, writeFile } from "node:fs/promises";
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
import { buildBookingRenderedDomUrl, sanitizeBookingUrl } from "../services/bookingRenderedDomProbe";
import {
  B05X_DEFAULT_DATES,
  B05X_MAX_DATES_PER_PROPERTY,
  B05X_MAX_PAGES,
  B05X_MAX_PROPERTIES,
  B05X_MAX_RUNTIME_MS,
  B05X_VERIFIED_BOOKING_TARGETS,
  buildB05XSchemaCompatibilitySummary,
  buildB05XSoldOutSemanticsGuard,
  buildB05XTargetMatrix,
  decideB05X,
  normalizeB05XRows,
  renderB05XCsv,
  renderB05XReport,
  summarizeB05XDpUsage,
  summarizeB05XPriceBasis,
  type B05XNormalizedRowPreview
} from "../services/bookingBroaderNormalizedCollection";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/booking-broader-normalized-collection";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-booking-broader-normalized-collection/0.1; low-volume feasibility)";
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
  const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /Hotel|ホテル|旅館|高見屋|蔵王/u.test(line)) ?? "";
}

interface CapturedPage {
  httpStatus: number;
  finalUrl: string;
  pageTitle: string;
  bodyText: string;
  html: string;
  presence: SelectorPresence;
  headline: string;
  error: string;
  loaded: boolean;
}

async function loadPage(page: Page, url: string, timeoutMs: number): Promise<CapturedPage> {
  let httpStatus = 0;
  let finalUrl = url;
  let pageTitle = "";
  let bodyText = "";
  let html = "";
  let presence = summarizeSelectorPresence({});
  let headline = "";
  let error = "";
  let loaded = false;
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    httpStatus = response?.status() ?? 0;
    loaded = true;
    await page.waitForTimeout(5_000);
    finalUrl = page.url();
    pageTitle = await page.title().catch(() => "");
    bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    html = await page.content().catch(() => "");
    presence = await selectorPresence(page);
    headline = await headlineName(page, bodyText);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    finalUrl = page.url() || url;
  }
  return { httpStatus, finalUrl, pageTitle, bodyText, html, presence, headline, error, loaded };
}

async function runB05X(): Promise<{
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
  rows: B05XNormalizedRowPreview[];
  decision: string;
  pageLoadCount: number;
}> {
  const ts = timestamp();
  const runId = `booking_b05x_${ts}`;
  const { iso: jstIso, date: collectedDateJst } = jstParts();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const matrix = buildB05XTargetMatrix(B05X_VERIFIED_BOOKING_TARGETS, B05X_DEFAULT_DATES, {
    maxProperties: B05X_MAX_PROPERTIES,
    maxDatesPerProperty: B05X_MAX_DATES_PER_PROPERTY,
    maxPages: B05X_MAX_PAGES
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  const b04aRows: B04ARow[] = [];
  let pageLoadCount = 0;
  const startedAt = Date.now();

  try {
    for (const cell of matrix.cells) {
      if (Date.now() - startedAt > B05X_MAX_RUNTIME_MS) break;
      const target = { canonicalPropertyName: cell.canonicalPropertyName, slug: cell.slug };
      const url = buildBookingRenderedDomUrl({ ...target, checkin: cell.checkin });
      const artifactDir = join(debugRootPath, `${cell.slug}_${cell.checkin}`);
      await mkdir(artifactDir, { recursive: true });

      const page = await context.newPage();
      page.setDefaultTimeout(PER_PAGE_TIMEOUT_MS);
      const captured = await loadPage(page, url, PER_PAGE_TIMEOUT_MS);
      pageLoadCount += 1;
      await page.screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: true }).catch(() => undefined);
      await page.close().catch(() => undefined);

      const candidate = extractPrimaryRateCardCandidate(captured.bodyText);
      const finalAllInTotalVisible = detectFinalAllInTotalVisible(captured.bodyText);
      const row = buildB04ARow({
        runId,
        collectedAtJst: jstIso,
        target,
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
      b04aRows.push(row);

      await writeFile(join(artifactDir, "url_sanitized.txt"), sanitizeBookingUrl(url), "utf8");
      await writeFile(join(artifactDir, "final_url_sanitized.txt"), sanitizeBookingUrl(captured.finalUrl), "utf8");
      await writeFile(join(artifactDir, "visible_text.txt"), captured.bodyText.slice(0, 500_000), "utf8");
      await writeFile(join(artifactDir, "selector_presence.json"), JSON.stringify(captured.presence, null, 2), "utf8");
      await writeFile(join(artifactDir, "price_candidate.json"), JSON.stringify(candidate, null, 2), "utf8");
      await writeFile(join(artifactDir, "b04a_row.json"), JSON.stringify(row, null, 2), "utf8");
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const rows = normalizeB05XRows(b04aRows, {
    collectedDateJst,
    collectedAtJst: jstIso,
    normalizedAtJst: jstIso
  });
  const decision = decideB05X(rows);
  const dpUsage = summarizeB05XDpUsage(rows);
  const priceBasis = summarizeB05XPriceBasis(rows);
  const schemaCompatibility = buildB05XSchemaCompatibilitySummary();
  const soldOutGuard = buildB05XSoldOutSemanticsGuard();

  const reportPath = resolve(REPORT_DIR, `booking_broader_normalized_collection_${ts}.md`);
  const csvPath = resolve(REPORT_DIR, `booking_broader_normalized_collection_${ts}.csv`);
  const jsonPath = resolve(REPORT_DIR, `booking_broader_normalized_collection_${ts}.json`);

  writeFileSync(csvPath, renderB05XCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderB05XReport({
      generatedAt: new Date().toISOString(),
      rows,
      matrix,
      decision,
      dpUsage,
      priceBasis,
      schemaCompatibility,
      soldOutGuard,
      pageLoadCount,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );

  const safetyConfirmation = {
    history_appended: false,
    db_writes: false,
    ai_context_refreshed: false,
    github_actions_or_cron: false,
    broad_crawl: false,
    pagination_followed: false,
    search_results_scraped: false,
    links_followed_beyond_fixed_urls: false,
    login_used: false,
    cookie_injection_used: false,
    stealth_used: false,
    captcha_bypass_attempted: false,
    paid_source_tooling_used: false,
    base_times_1_1_used: false,
    fixed_property_slug_urls_only: true
  };

  const summary = {
    decision,
    runId,
    pageLoadCount,
    pricePolicyVersion: rows[0]?.price_policy_version ?? "booking_official_visible_adder_v1",
    matrix,
    dpUsage,
    priceBasis,
    schemaCompatibility,
    soldOutGuard,
    safetyConfirmation,
    rows
  };
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  await writeFile(join(debugRootPath, "target_matrix.json"), JSON.stringify(matrix, null, 2), "utf8");
  await writeFile(join(debugRootPath, "page_results.json"), JSON.stringify(b04aRows, null, 2), "utf8");
  await writeFile(join(debugRootPath, "normalized_rows_preview.json"), JSON.stringify(rows, null, 2), "utf8");
  await writeFile(
    join(debugRootPath, "blocked_or_captcha_detection.json"),
    JSON.stringify(
      b04aRows.map((r) => ({
        slug: r.bookingSlug,
        checkin: r.checkin,
        blocking_or_modal_state: r.blockingOrModalState,
        classification: r.classification
      })),
      null,
      2
    ),
    "utf8"
  );
  await writeFile(join(debugRootPath, "price_basis_summary.json"), JSON.stringify(priceBasis, null, 2), "utf8");
  await writeFile(
    join(debugRootPath, "schema_compatibility_summary.json"),
    JSON.stringify(schemaCompatibility, null, 2),
    "utf8"
  );
  await writeFile(join(debugRootPath, "safety_confirmation.json"), JSON.stringify(safetyConfirmation, null, 2), "utf8");
  await writeFile(join(debugRootPath, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  return { reportPath, csvPath, jsonPath, debugRootPath, rows, decision, pageLoadCount };
}

runB05X()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`json_summary_path=${result.jsonPath}`);
    console.log(`debug_root=${result.debugRootPath}`);
    console.log(`page_load_count=${result.pageLoadCount}`);
    console.log(`rows=${result.rows.length}`);
    console.log(`decision=${result.decision}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

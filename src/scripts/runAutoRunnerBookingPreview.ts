// Phase AUTO-RUNNER08X - gated Booking collector preview runner (driver).
//
// Fail-closed by default: without COLLECT_BOOKING=1 it builds the bounded target
// matrix, reports what WOULD run, executes zero live pages, and mutates nothing.
// With COLLECT_BOOKING=1 it runs a small bounded (<=9 page) read-only Booking
// rendered-DOM preview by reusing the proven src/services/bookingRenderedDomProbe
// extractor. It NEVER appends history, writes/syncs the DB, refreshes AI context,
// or emits pricing/PMS output. No login, no cookies, no stealth, no CAPTCHA
// bypass, no paid proxy.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  buildBookingRenderedDomUrl,
  sanitizeBookingUrl,
  type BookingRenderedDomRow
} from "../services/bookingRenderedDomProbe";
import {
  MAX_PAGES,
  MAX_PROPERTIES,
  SOURCE_PHASE,
  VERIFIED_BOOKING_TARGETS,
  buildSafetyConfirmation,
  buildTargetMatrix,
  decidePreview,
  enforcePageCap,
  readGate,
  renderPreviewCsv,
  renderReport,
  selectPreviewDates,
  summarizeClassification,
  toPreviewRow,
  type PreviewResult,
  type PreviewRow,
  type TargetCell
} from "../services/autoRunnerBookingPreview";
import { resolveCrawlVolumeMultiplier, resolveForcedCheckinDates, scaleCap } from "../services/crawlVolumeConfig";
import {
  backoffDelayMs,
  classifyBlock,
  jitterDelayMs,
  shouldEarlyStop,
  sleep
} from "../services/crawlThrottlePolicy";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/auto-runner-booking-preview";
const PEAK_DATE = "2026-08-10"; // known major/peak sample date (Obon period)
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-booking-preview/0.1; low-volume bounded preview)";

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

function todayUtcYmd(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function collectLive(
  cells: readonly TargetCell[],
  debugRootPath: string,
  collectedAtJst: string,
  timeoutMs: number,
  maxPages: number
): Promise<PreviewRow[]> {
  const rows: PreviewRow[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  let consecutiveBlocks = 0;
  let backoffAttempt = 0;
  try {
    let pageCount = 0;
    for (const cell of cells) {
      if (pageCount >= maxPages) break; // hard page-cap enforcement (base * multiplier)
      pageCount += 1;
      // Polite jitter between sequential requests (skip before the very first).
      if (pageCount > 1) await sleep(jitterDelayMs());
      const target = { canonicalPropertyName: cell.canonical_property_name, slug: cell.property_slug };
      const probeUrl = buildBookingRenderedDomUrl({ ...target, checkin: cell.checkin });
      const artifactDir = join(debugRootPath, `${cell.property_slug}_${cell.checkin}`);
      await mkdir(artifactDir, { recursive: true });
      const screenshotPath = join(artifactDir, "screenshot.png");

      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      let loaded = false;
      let httpStatus = 0;
      let finalUrl = probeUrl;
      let pageTitle = "";
      let bodyText = "";
      let error = "";
      try {
        const response = await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        loaded = response !== null;
        httpStatus = response?.status() ?? 0;
        await page.waitForTimeout(5_000);
        finalUrl = page.url();
        pageTitle = await page.title().catch(() => "");
        bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        finalUrl = page.url() || probeUrl;
      } finally {
        await page.close().catch(() => undefined);
      }

      const signals = analyzeBookingRenderedDomSignals({
        target,
        checkin: cell.checkin,
        checkout: cell.checkout,
        loaded,
        httpStatus,
        finalUrl,
        pageTitle,
        bodyText,
        error
      });
      const domRow: BookingRenderedDomRow = buildBookingRenderedDomRow({
        target,
        checkin: cell.checkin,
        checkout: cell.checkout,
        probeUrl,
        signals,
        debugArtifactPath: artifactDir
      });
      const previewRow = toPreviewRow(domRow, { screenshotPath, debugPath: artifactDir, collectedAtJst });
      rows.push(previewRow);

      await writeFile(join(artifactDir, "probe_url_sanitized.txt"), sanitizeBookingUrl(probeUrl), "utf8");
      await writeFile(join(artifactDir, "visible_text.txt"), bodyText.slice(0, 250_000), "utf8");
      await writeFile(join(artifactDir, "preview_row.json"), JSON.stringify(previewRow, null, 2), "utf8");

      // Detect a rate-limit/block signal and back off (never bypass). Stop the
      // source after repeated consecutive blocks so we stay polite at volume.
      const block = classifyBlock(httpStatus, `${pageTitle}\n${bodyText}\n${error}`);
      if (block !== null) {
        consecutiveBlocks += 1;
        await sleep(backoffDelayMs(backoffAttempt));
        backoffAttempt += 1;
        if (shouldEarlyStop(consecutiveBlocks)) break;
      } else {
        consecutiveBlocks = 0;
        backoffAttempt = 0;
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  return rows;
}

async function run(): Promise<PreviewResult> {
  const ts = timestamp();
  const runId = `auto_runner_booking_preview_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const gate = readGate(process.env);
  const multiplier = resolveCrawlVolumeMultiplier(process.env);
  const forcedCheckin = resolveForcedCheckinDates(process.env);
  if (forcedCheckin.invalid.length > 0) console.warn(`warning_invalid_forced_checkin_dates=${forcedCheckin.invalid.join(",")}`);
  const dates = selectPreviewDates(todayUtcYmd(), PEAK_DATE, multiplier, forcedCheckin.valid);
  const targetMatrix = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, dates, multiplier, forcedCheckin.valid.length);
  const pageCap = enforcePageCap(targetMatrix, multiplier, forcedCheckin.valid.length);

  let previewRows: PreviewRow[] = [];
  let liveExecuted = false;
  if (gate.live_collection_authorized) {
    liveExecuted = true;
    previewRows = await collectLive(pageCap.selected, debugPath, generatedAtJst, 35_000, scaleCap(MAX_PAGES, multiplier) + MAX_PROPERTIES * forcedCheckin.valid.length);
  }

  const classificationSummary = summarizeClassification(previewRows);
  const safety = buildSafetyConfirmation({ liveExecuted, pageCapRespected: pageCap.respected });
  const decision = decidePreview({
    liveExecuted,
    pageCapRespected: pageCap.respected,
    implementationSafe: true,
    rows: previewRows
  });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const result: PreviewResult = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_phase: SOURCE_PHASE,
    gate,
    max_pages: scaleCap(MAX_PAGES, multiplier),
    page_cap: pageCap,
    target_matrix: targetMatrix,
    selected_targets: pageCap.selected,
    preview_rows: previewRows,
    classification_summary: classificationSummary,
    safety_confirmation: safety,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(reportPath, renderReport(result), "utf8");
  writeJson(jsonPath, result);
  writeFileSync(csvPath, renderPreviewCsv(previewRows), "utf8");

  // Debug artifacts.
  writeJson(resolve(debugPath, "gate_result.json"), gate);
  writeJson(resolve(debugPath, "target_matrix.json"), targetMatrix);
  writeJson(resolve(debugPath, "selected_targets.json"), pageCap.selected);
  writeJson(resolve(debugPath, "preview_rows.json"), previewRows);
  writeJson(resolve(debugPath, "classification_summary.json"), classificationSummary);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safety);
  writeJson(
    resolve(debugPath, "screenshot_manifest.json"),
    previewRows.map((r) => ({ slug: r.property_slug, checkin: r.checkin, screenshot_path: r.screenshot_path }))
  );

  return result;
}

run()
  .then((result) => {
    console.log(`decision=${result.decision}`);
    console.log(`crawl_volume_multiplier=${resolveCrawlVolumeMultiplier(process.env)}`);
    console.log(`live_collection_executed=${result.safety_confirmation.live_collection_executed}`);
    console.log(`page_cap_respected=${result.safety_confirmation.page_cap_respected}`);
    console.log(`requested_pages=${result.page_cap.requested}`);
    console.log(`selected_pages=${result.page_cap.selected.length}`);
    console.log(`classification_summary=${JSON.stringify(result.classification_summary)}`);
    console.log(`report_path=${result.report_path}`);
    console.log(`json_path=${result.json_path}`);
    console.log(`csv_path=${result.csv_path}`);
    console.log(`debug_artifact_path=${result.debug_artifact_path}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

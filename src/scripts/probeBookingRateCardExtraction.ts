import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import {
  buildBookingRateCardRow,
  buildBookingRateCardUrl,
  decideBookingRateCardExtraction,
  extractPrimaryRateCardCandidate,
  REQUIRED_BOOKING_SELECTORS,
  renderBookingRateCardCsv,
  renderBookingRateCardReport,
  summarizeSelectorPresence,
  type BookingRateCardRow,
  type SelectorPresence
} from "../services/bookingRateCardExtractionProbe";
import { sanitizeBookingUrl, type BookingRenderedDomTarget } from "../services/bookingRenderedDomProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/booking-rate-card-extraction";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-booking-rate-card-extraction/0.1; low-volume feasibility)";

const TARGETS: BookingRenderedDomTarget[] = [
  { canonicalPropertyName: "蔵王国際ホテル", slug: "zao-kokusai" },
  { canonicalPropertyName: "蔵王四季のホテル", slug: "zao-shiki-no" },
  { canonicalPropertyName: "深山荘 高見屋", slug: "shinzanso-takamiya" }
];

const CHECKINS = ["2026-08-12", "2026-10-10"] as const;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function collectedAtJst(): string {
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
  const addressIndex = lines.findIndex((line) => /^〒990-2301/u.test(line));
  if (addressIndex > 0) {
    for (let i = addressIndex - 1; i >= 0; i -= 1) {
      const candidate = lines[i] ?? "";
      if (candidate && candidate !== "プライスマッチ" && !/予約|写真|クチコミ/u.test(candidate)) return candidate;
    }
  }
  return lines.find((line) => /Hotel|ホテル|旅館|高見屋|蔵王/u.test(line)) ?? "";
}

async function runBookingRateCardExtractionProbe(options: { timeoutMs?: number } = {}): Promise<{
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
  rows: BookingRateCardRow[];
  decision: string;
  pageLoadCount: number;
}> {
  const timeoutMs = options.timeoutMs ?? 35_000;
  const ts = timestamp();
  const runId = `booking_rate_card_${ts}`;
  const collectedAt = collectedAtJst();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  const rows: BookingRateCardRow[] = [];
  const selectorPresenceByRow: Array<{ rowKey: string; selectorPresence: SelectorPresence }> = [];
  let pageLoadCount = 0;

  try {
    for (const target of TARGETS) {
      for (const checkin of CHECKINS) {
        const url = buildBookingRateCardUrl({ ...target, checkin });
        const artifactDir = join(debugRootPath, `${target.slug}_${checkin}`);
        await mkdir(artifactDir, { recursive: true });
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);

        let httpStatus = 0;
        let finalUrl = url;
        let pageTitle = "";
        let bodyText = "";
        let html = "";
        let presence = summarizeSelectorPresence({});
        let headline = "";
        let error = "";
        try {
          const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          pageLoadCount += 1;
          httpStatus = response?.status() ?? 0;
          await page.waitForTimeout(5_000);
          finalUrl = page.url();
          pageTitle = await page.title().catch(() => "");
          bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
          html = await page.content().catch(() => "");
          presence = await selectorPresence(page);
          headline = await headlineName(page, bodyText);
          await page.screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: true }).catch(() => undefined);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          finalUrl = page.url() || url;
        } finally {
          await page.close().catch(() => undefined);
        }

        const row = buildBookingRateCardRow({
          runId,
          collectedAtJst: collectedAt,
          target,
          checkin,
          finalUrl,
          httpStatus,
          pageTitle,
          propertyHeadlineName: headline,
          visibleText: error ? `${bodyText}\n${error}` : bodyText,
          selectorPresence: presence,
          debugArtifactPath: artifactDir
        });
        rows.push(row);
        selectorPresenceByRow.push({ rowKey: `${target.slug}_${checkin}`, selectorPresence: presence });

        const primaryCandidate = extractPrimaryRateCardCandidate(bodyText);
        await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8");
        await writeFile(join(artifactDir, "url_sanitized.txt"), sanitizeBookingUrl(url), "utf8");
        await writeFile(join(artifactDir, "final_url_sanitized.txt"), sanitizeBookingUrl(finalUrl), "utf8");
        await writeFile(join(artifactDir, "html.html"), html.slice(0, 500_000), "utf8");
        await writeFile(join(artifactDir, "visible_text.txt"), bodyText.slice(0, 500_000), "utf8");
        await writeFile(join(artifactDir, "selector_presence.json"), JSON.stringify(presence, null, 2), "utf8");
        await writeFile(join(artifactDir, "rate_card_candidates.json"), JSON.stringify(primaryCandidate ? [primaryCandidate] : [], null, 2), "utf8");
        await writeFile(join(artifactDir, "price_candidates.json"), JSON.stringify(primaryCandidate, null, 2), "utf8");
        await writeFile(join(artifactDir, "tax_charge_candidates.json"), JSON.stringify({ primary_tax_charge_text: row.primaryTaxChargeText }, null, 2), "utf8");
        await writeFile(join(artifactDir, "classification.json"), JSON.stringify({ classification: row.classification, basisConfidence: row.basisConfidence }, null, 2), "utf8");
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const decision = decideBookingRateCardExtraction(rows);
  const csvPath = resolve(REPORT_DIR, `booking_rate_card_extraction_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `booking_rate_card_extraction_probe_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `booking_rate_card_extraction_probe_${ts}.json`);
  const summary = {
    decision,
    pageLoadCount,
    rows,
    selectorPresenceByRow,
    classificationCounts: countBy(rows.map((row) => row.classification)),
    basisConfidenceCounts: countBy(rows.map((row) => row.basisConfidence))
  };
  writeFileSync(csvPath, renderBookingRateCardCsv(rows), "utf8");
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(
    reportPath,
    renderBookingRateCardReport({
      generatedAt: new Date().toISOString(),
      rows,
      selectorPresenceByRow,
      decision,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );
  await writeFile(join(debugRootPath, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  return { reportPath, csvPath, jsonPath, debugRootPath, rows, decision, pageLoadCount };
}

runBookingRateCardExtractionProbe()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`json_summary_path=${result.jsonPath}`);
    console.log(`debug_root=${result.debugRootPath}`);
    console.log(`page_load_count=${result.pageLoadCount}`);
    console.log(`classification_counts=${JSON.stringify(countBy(result.rows.map((row) => row.classification)))}`);
    console.log(`basis_confidence_counts=${JSON.stringify(countBy(result.rows.map((row) => row.basisConfidence)))}`);
    console.log(`decision=${result.decision}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

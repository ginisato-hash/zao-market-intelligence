import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  decideBookingRenderedDomFeasibility,
  renderBookingRenderedDomCsv,
  renderBookingRenderedDomReport,
  sanitizeBookingUrl,
  type BookingPriceCandidate,
  type BookingRenderedDomRow,
  type BookingRenderedDomTarget
} from "../services/bookingRenderedDomProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/booking-rendered-dom-probe";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-booking-rendered-dom-probe/0.1; low-volume feasibility)";

const TARGETS: BookingRenderedDomTarget[] = [
  { canonicalPropertyName: "蔵王国際ホテル", slug: "zao-kokusai" },
  { canonicalPropertyName: "蔵王四季のホテル", slug: "zao-shiki-no" },
  { canonicalPropertyName: "深山荘 高見屋", slug: "shinzanso-takamiya" }
];

const CHECKINS = ["2026-08-10", "2026-10-10"] as const;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function runBookingRenderedDomProbe(options: { timeoutMs?: number } = {}): Promise<{
  reportPath: string;
  csvPath: string;
  debugRootPath: string;
  rows: BookingRenderedDomRow[];
  decision: string;
}> {
  const timeoutMs = options.timeoutMs ?? 35_000;
  const ts = timestamp();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  const rows: BookingRenderedDomRow[] = [];

  try {
    for (const target of TARGETS) {
      for (const checkin of CHECKINS) {
        const checkout = checkoutForOneNight(checkin);
        const probeUrl = buildBookingRenderedDomUrl({ ...target, checkin });
        const artifactDir = join(debugRootPath, `${target.slug}_${checkin}`);
        await mkdir(artifactDir, { recursive: true });
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);

        let loaded = false;
        let httpStatus = 0;
        let finalUrl = probeUrl;
        let pageTitle = "";
        let bodyText = "";
        let bodyHtml = "";
        let error = "";
        try {
          const response = await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          loaded = response !== null;
          httpStatus = response?.status() ?? 0;
          await page.waitForTimeout(5_000);
          finalUrl = page.url();
          pageTitle = await page.title().catch(() => "");
          bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
          bodyHtml = await page.content().catch(() => "");
          await page.screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: true }).catch(() => undefined);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          finalUrl = page.url() || probeUrl;
        } finally {
          await page.close().catch(() => undefined);
        }

        const signals = analyzeBookingRenderedDomSignals({
          target,
          checkin,
          checkout,
          loaded,
          httpStatus,
          finalUrl,
          pageTitle,
          bodyText,
          error
        });
        const row = buildBookingRenderedDomRow({
          target,
          checkin,
          checkout,
          probeUrl,
          signals,
          debugArtifactPath: artifactDir
        });
        rows.push(row);

        await writeFile(join(artifactDir, "probe_url_sanitized.txt"), sanitizeBookingUrl(probeUrl), "utf8");
        await writeFile(join(artifactDir, "final_url_sanitized.txt"), sanitizeBookingUrl(finalUrl), "utf8");
        await writeFile(join(artifactDir, "visible_text.txt"), bodyText.slice(0, 250_000), "utf8");
        await writeFile(join(artifactDir, "dom_excerpt.html"), bodyHtml.slice(0, 250_000), "utf8");
        await writeFile(join(artifactDir, "price_candidates.json"), JSON.stringify(signals.priceCandidates, null, 2), "utf8");
        await writeFile(
          join(artifactDir, "signals.json"),
          JSON.stringify(redactSignals(signals), null, 2),
          "utf8"
        );
        await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8");
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const decision = decideBookingRenderedDomFeasibility(rows);
  const csvPath = resolve(REPORT_DIR, `booking_rendered_dom_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `booking_rendered_dom_probe_${ts}.md`);
  writeFileSync(csvPath, renderBookingRenderedDomCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderBookingRenderedDomReport({
      generatedAt: new Date().toISOString(),
      rows,
      decision,
      reportPath,
      csvPath,
      debugRootPath
    }),
    "utf8"
  );
  await writeFile(
    join(debugRootPath, "summary.json"),
    JSON.stringify({ decision, rows, classification_counts: countBy(rows.map((row) => row.classification)) }, null, 2),
    "utf8"
  );

  return { reportPath, csvPath, debugRootPath, rows, decision };
}

function redactSignals(signals: ReturnType<typeof analyzeBookingRenderedDomSignals>): unknown {
  return {
    ...signals,
    finalUrl: sanitizeBookingUrl(signals.finalUrl),
    bodyText: signals.bodyText.slice(0, 8_000),
    priceCandidates: signals.priceCandidates.map((candidate: BookingPriceCandidate) => ({
      ...candidate,
      contextBeforeAfter: candidate.contextBeforeAfter.slice(0, 300)
    }))
  };
}

runBookingRenderedDomProbe()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`debug_root=${result.debugRootPath}`);
    console.log(`rows_tested=${result.rows.length}`);
    console.log(`classification_counts=${JSON.stringify(countBy(result.rows.map((row) => row.classification)))}`);
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

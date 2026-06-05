import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import {
  buildRakutenHotelPlanUrl,
  buildRakutenIframeUrlForDate,
  classifyRakutenIframeProbe,
  decideRakutenIframeFeasibility,
  detectIframeDateScopedTotalEvidence,
  extractTwoPersonCalendarHref,
  renderRakutenIframeProbeCsv,
  renderRakutenIframeProbeReport,
  type RakutenIframeProbeRow
} from "../services/rakutenIframeProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-iframe-probe";

const PROPERTIES = [
  { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" },
  { canonicalPropertyName: "YuiLocalZao", hotelNo: "198027" },
  { canonicalPropertyName: "蔵王国際ホテル", hotelNo: "5723" }
] as const;

const STAY_DATES = ["2026-08-10", "2026-10-10"] as const;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface ProbeObservation {
  planReachable: boolean;
  iframeReachable: boolean;
  extractedCalendarHref: string;
  generatedIframeUrl: string;
  planText: string;
  planDom: string;
  iframeText: string;
  iframeDom: string;
  errorReason: string;
}

async function extractCalendarHrefFromPage(page: import("playwright").Page): Promise<string | null> {
  const hrefFromDom = await page
    .evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));
      let fallback = "";
      for (const anchor of anchors) {
        const text = anchor.textContent || "";
        const href = anchor.getAttribute("href") || "";
        if (!text.includes("空室カレンダー") || !href) continue;
        if (/[?&]f_otona_su=2(?:&|$)/.test(href.replace(/&amp;/g, "&"))) {
          return href;
        }
        if (!fallback) fallback = href;
        let context = "";
        let node: Element | null = anchor;
        for (let i = 0; i < 7 && node; i++) {
          context = node.textContent || context;
          node = node.parentElement;
        }
        if (context.includes("2名利用時") || /2\s*名/.test(context)) {
          return href;
        }
      }
      return fallback || null;
    })
    .catch(() => null);
  if (hrefFromDom) return hrefFromDom;
  const html = await page.content().catch(() => "");
  return extractTwoPersonCalendarHref(html);
}

async function probeOne(
  browser: Browser | null,
  property: { canonicalPropertyName: string; hotelNo: string },
  stayDate: string,
  artifactDir: string,
  timeoutMs: number
): Promise<ProbeObservation> {
  const planUrl = buildRakutenHotelPlanUrl(property.hotelNo);
  const obs: ProbeObservation = {
    planReachable: false,
    iframeReachable: false,
    extractedCalendarHref: "",
    generatedIframeUrl: "",
    planText: "",
    planDom: "",
    iframeText: "",
    iframeDom: "",
    errorReason: ""
  };

  if (browser === null) {
    obs.errorReason = "browser_launch_failed";
    await writeRequiredArtifacts(artifactDir, obs);
    return obs;
  }

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-iframe-probe/0.1; low-volume feasibility)"
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    await page.goto(planUrl, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForTimeout(2_000);
    obs.planReachable = true;
    obs.planText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    obs.planDom = await page.content().catch(() => "");
    await writeFile(join(artifactDir, "plan_page_text.txt"), obs.planText.slice(0, 80_000), "utf8");
    await writeFile(join(artifactDir, "plan_page_dom_excerpt.html"), obs.planDom.slice(0, 80_000), "utf8");
    await page.screenshot({ path: join(artifactDir, "screenshot_plan_page.png"), fullPage: true }).catch(() => undefined);

    obs.extractedCalendarHref = (await extractCalendarHrefFromPage(page)) ?? "";
    await writeFile(join(artifactDir, "extracted_calendar_href.txt"), obs.extractedCalendarHref, "utf8");

    if (!obs.extractedCalendarHref) {
      obs.errorReason = "2-person calendar href not found on rendered plan page";
      return obs;
    }

    obs.generatedIframeUrl = buildRakutenIframeUrlForDate(obs.extractedCalendarHref, stayDate);
    await writeFile(join(artifactDir, "generated_iframe_url.txt"), obs.generatedIframeUrl, "utf8");

    await page.goto(obs.generatedIframeUrl, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForTimeout(2_000);
    obs.iframeReachable = true;
    obs.iframeText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    obs.iframeDom = await page.content().catch(() => "");
    await writeFile(join(artifactDir, "iframe_page_text.txt"), obs.iframeText.slice(0, 80_000), "utf8");
    await writeFile(join(artifactDir, "iframe_dom_excerpt.html"), obs.iframeDom.slice(0, 80_000), "utf8");
    await page.screenshot({ path: join(artifactDir, "screenshot_iframe_page.png"), fullPage: true }).catch(() => undefined);
  } catch (error) {
    obs.errorReason = error instanceof Error ? error.message : String(error);
  } finally {
    await context.close().catch(() => undefined);
  }

  await writeRequiredArtifacts(artifactDir, obs);
  return obs;
}

async function writeRequiredArtifacts(artifactDir: string, obs: ProbeObservation): Promise<void> {
  await writeFile(join(artifactDir, "plan_page_text.txt"), obs.planText.slice(0, 80_000), "utf8").catch(() => undefined);
  await writeFile(join(artifactDir, "plan_page_dom_excerpt.html"), obs.planDom.slice(0, 80_000), "utf8").catch(() => undefined);
  await writeFile(join(artifactDir, "extracted_calendar_href.txt"), obs.extractedCalendarHref, "utf8").catch(() => undefined);
  await writeFile(join(artifactDir, "generated_iframe_url.txt"), obs.generatedIframeUrl, "utf8").catch(() => undefined);
  await writeFile(join(artifactDir, "iframe_page_text.txt"), obs.iframeText.slice(0, 80_000), "utf8").catch(() => undefined);
  await writeFile(join(artifactDir, "iframe_dom_excerpt.html"), obs.iframeDom.slice(0, 80_000), "utf8").catch(() => undefined);
}

export async function runRakutenIframeProbe(options: { timeoutMs?: number } = {}): Promise<{
  rows: RakutenIframeProbeRow[];
  decision: ReturnType<typeof decideRakutenIframeFeasibility>;
  csvPath: string;
  reportPath: string;
  debugRootPath: string;
  executionNote: string;
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  let browser: Browser | null = null;
  let executionNote = "completed rakuten iframe probe";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const rows: RakutenIframeProbeRow[] = [];
  for (const property of PROPERTIES) {
    for (const stayDate of STAY_DATES) {
      const artifactDir = join(debugRootPath, `${property.hotelNo}_${stayDate}`);
      await mkdir(artifactDir, { recursive: true });
      const obs = await probeOne(browser, property, stayDate, artifactDir, timeoutMs);
      const evidence = detectIframeDateScopedTotalEvidence({
        text: obs.iframeText,
        stayDate,
        canonicalPropertyName: property.canonicalPropertyName
      });
      const classification = classifyRakutenIframeProbe({
        iframeReachable: obs.iframeReachable,
        evidence
      });
      const row: RakutenIframeProbeRow = {
        canonicalPropertyName: property.canonicalPropertyName,
        hotelNo: property.hotelNo,
        stayDate,
        planUrl: buildRakutenHotelPlanUrl(property.hotelNo),
        extractedCalendarHref: obs.extractedCalendarHref,
        generatedIframeUrl: obs.generatedIframeUrl,
        iframeReachable: obs.iframeReachable,
        dateScopeDetected: evidence.dateScopeDetected,
        roomCountDetected: evidence.roomCountDetected,
        adultCountDetected: evidence.adultCountDetected,
        nightCountDetected: evidence.nightCountDetected,
        taxIncludedTotalDetected: evidence.taxIncludedTotalText,
        perPersonPriceDetected: evidence.perPersonPriceText,
        availabilityStatus: evidence.availabilityStatus,
        classification,
        riskNote: obs.errorReason || riskNoteFor(classification),
        debugArtifactPath: artifactDir
      };
      await writeFile(
        join(artifactDir, "summary.json"),
        JSON.stringify({ ...row, planReachable: obs.planReachable, evidence }, null, 2),
        "utf8"
      );
      rows.push(row);
    }
  }

  if (browser !== null) {
    await browser.close().catch(() => undefined);
  }

  const decision = decideRakutenIframeFeasibility(rows.map((row) => row.classification));
  const csvPath = resolve(REPORT_DIR, `rakuten_iframe_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_iframe_probe_${ts}.md`);
  writeFileSync(csvPath, renderRakutenIframeProbeCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderRakutenIframeProbeReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      rows,
      decision,
      executionNote
    }),
    "utf8"
  );

  return { rows, decision, csvPath, reportPath, debugRootPath, executionNote };
}

function riskNoteFor(classification: string): string {
  switch (classification) {
    case "iframe_date_scoped_total_found":
      return "Date-scoped 2-adult/1-room/1-night total evidence was detected in public iframe text; review selectors before DB collection.";
    case "iframe_date_scoped_per_person_found":
      return "Public iframe exposed date-scoped per-person evidence, but not a safe total.";
    case "iframe_no_plan_or_sold_out":
      return "Public iframe reached an explicit no-plan/sold-out state.";
    case "iframe_date_scope_unverified":
      return "Iframe opened but target date could not be confirmed in rendered text.";
    case "iframe_basis_unverified":
      return "Iframe opened but adult/room/night/total basis remains unclear.";
    default:
      return "Iframe URL failed or did not return usable Rakuten content.";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenIframeProbe();
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`probe_rows=${result.rows.length}`);
  console.log(`execution_note=${result.executionNote}`);
  console.log(`classification_counts=${JSON.stringify(countClassifications(result.rows))}`);
  console.log(`feasibility_decision=${result.decision}`);
}

function countClassifications(rows: RakutenIframeProbeRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  }
  return counts;
}

if (process.argv[1]?.endsWith("probeRakutenIframeUrl.ts")) {
  void main();
}

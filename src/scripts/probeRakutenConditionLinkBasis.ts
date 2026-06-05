import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import {
  parseHplanCalendarResponse,
  type HplanCalendarParsed,
  type HplanDay
} from "../services/rakutenCorrectedHplanUrlProbe";
import {
  buildAbsoluteRakutenConditionUrl,
  classifyConditionBasis,
  compareConditionBasis,
  decideConditionBasis,
  extractConditionPageSignals,
  renderConditionBasisCsv,
  renderConditionBasisReport,
  sanitizeRakutenConditionUrl,
  selectFirstAvailableDay,
  type BasisComparison,
  type ConditionPageSignals,
  type PriceCandidate,
  type RakutenConditionBasisRow
} from "../services/rakutenConditionLinkBasisProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-condition-link-basis";
const PHASE64_PRIMARY_DEBUG = ".data/debug/rakuten-corrected-hplan-url/20260601_202308/5723_00_20260601";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-condition-link-basis-probe/0.1; low-volume feasibility)";

const SOURCE_CONTEXT = {
  canonicalPropertyName: "蔵王国際ホテル",
  hotelNo: "5723",
  fSyu: "00",
  fCampId: "6468227",
  sourceViewDate: "2026年06月",
  adultCount: 2,
  roomCount: 1,
  nights: 1
};

interface DestinationFetch {
  status: number;
  finalUrl: string;
  html: string;
  text: string;
  title: string;
  mode: "static" | "browser" | "none";
  screenshotWritten: boolean;
  error: string;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function loadPhase64Parsed(): Promise<HplanCalendarParsed> {
  const raw = await readFile(resolve(PHASE64_PRIMARY_DEBUG, "response_body.txt"), "utf8");
  return parseHplanCalendarResponse(raw, 200);
}

async function fetchStatic(url: string): Promise<DestinationFetch> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": USER_AGENT
      }
    });
    const html = await response.text();
    return {
      status: response.status,
      finalUrl: response.url,
      html,
      text: htmlToText(html),
      title: extractTitle(html),
      mode: "static",
      screenshotWritten: false,
      error: ""
    };
  } catch (error) {
    return {
      status: 0,
      finalUrl: url,
      html: "",
      text: "",
      title: "",
      mode: "static",
      screenshotWritten: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchBrowser(url: string, artifactDir: string, timeoutMs: number): Promise<DestinationFetch> {
  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1_500);
    const html = await page.content().catch(() => "");
    const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => htmlToText(html));
    const title = await page.title().catch(() => extractTitle(html));
    const screenshotPath = join(artifactDir, "destination_screenshot.png");
    const screenshotWritten = await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .then(() => true)
      .catch(() => false);
    return {
      status: response?.status() ?? 0,
      finalUrl: page.url(),
      html,
      text,
      title,
      mode: "browser",
      screenshotWritten,
      error: ""
    };
  } catch (error) {
    return {
      status: 0,
      finalUrl: url,
      html: "",
      text: "",
      title: "",
      mode: "browser",
      screenshotWritten: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

function isStaticUsable(fetch: DestinationFetch, day: HplanDay): boolean {
  if (fetch.status < 200 || fetch.status >= 400) return false;
  if (fetch.text.length < 500) return false;
  return fetch.text.includes(String(day.price)) || fetch.text.includes((day.price * SOURCE_CONTEXT.adultCount).toLocaleString("ja-JP"));
}

async function inspectDestination(
  url: string,
  day: HplanDay,
  artifactDir: string,
  timeoutMs: number
): Promise<DestinationFetch> {
  const staticFetch = await fetchStatic(url);
  if (isStaticUsable(staticFetch, day)) return staticFetch;
  const browserFetch = await fetchBrowser(url, artifactDir, timeoutMs);
  if (browserFetch.status === 0) {
    return {
      ...staticFetch,
      error: `${staticFetch.error || "static fetch insufficient"}; browser_error: ${browserFetch.error}`
    };
  }
  return browserFetch;
}

async function runRakutenConditionLinkBasisProbe(options: { timeoutMs?: number } = {}): Promise<{
  rows: RakutenConditionBasisRow[];
  reportPath: string;
  csvPath: string;
  debugRootPath: string;
  followedLinks: number;
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const parsed = await loadPhase64Parsed();
  await writeFile(
    join(debugRootPath, "source_jsonp_context.json"),
    JSON.stringify(
      {
        ...SOURCE_CONTEXT,
        responseType: parsed.responseType,
        viewDate: parsed.viewDate,
        isTaxExclusive: parsed.isTaxExclusive,
        chargeType: parsed.chargeType,
        dayListLength: parsed.days.length
      },
      null,
      2
    ),
    "utf8"
  );

  let selectedDay: HplanDay | null = null;
  let comparison: BasisComparison | null = null;
  let signals: ConditionPageSignals | null = null;
  let priceCandidates: PriceCandidate[] = [];
  const rows: RakutenConditionBasisRow[] = [];
  let followedLinks = 0;

  for (let skip = 0; skip < 2; skip += 1) {
    const day = selectFirstAvailableDay(parsed, skip);
    if (day === null) break;
    selectedDay = day;
    const artifactDir = join(debugRootPath, `${SOURCE_CONTEXT.hotelNo}_${SOURCE_CONTEXT.fSyu}_${day.viewDay.replace(/\W/gu, "_")}`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "selected_day.json"), JSON.stringify(day, null, 2), "utf8");

    const absoluteUrl = buildAbsoluteRakutenConditionUrl(day.link);
    const sanitizedUrl = sanitizeRakutenConditionUrl(absoluteUrl);
    await writeFile(join(artifactDir, "destination_url_sanitized.txt"), sanitizedUrl, "utf8");
    followedLinks += 1;

    const destination = await inspectDestination(absoluteUrl, day, artifactDir, timeoutMs);
    await writeFile(join(artifactDir, "destination_response_body.html"), destination.html.slice(0, 250_000), "utf8");
    await writeFile(join(artifactDir, "destination_visible_text.txt"), destination.text.slice(0, 120_000), "utf8");

    signals = extractConditionPageSignals({
      text: destination.text,
      title: destination.title,
      canonicalPropertyName: SOURCE_CONTEXT.canonicalPropertyName,
      roomCode: SOURCE_CONTEXT.fSyu,
      selectedDay: day
    });
    priceCandidates = [...signals.totalPriceCandidates, ...signals.perPersonPriceCandidates];
    comparison = compareConditionBasis({ day, adultCount: SOURCE_CONTEXT.adultCount, signals });
    const classification = classifyConditionBasis({
      reachable: destination.status >= 200 && destination.status < 400,
      renderedBlocked: /captcha|アクセスが集中|ロボット|bot|blocked/iu.test(destination.text),
      comparison
    });
    const decision = decideConditionBasis(classification);

    await writeFile(join(artifactDir, "price_candidates.json"), JSON.stringify(priceCandidates, null, 2), "utf8");
    await writeFile(join(artifactDir, "basis_comparison.json"), JSON.stringify(comparison, null, 2), "utf8");
    await writeFile(join(artifactDir, "classification.json"), JSON.stringify({ classification, decision }, null, 2), "utf8");

    const row: RakutenConditionBasisRow = {
      canonicalPropertyName: SOURCE_CONTEXT.canonicalPropertyName,
      hotelNo: SOURCE_CONTEXT.hotelNo,
      fSyu: SOURCE_CONTEXT.fSyu,
      fCampId: SOURCE_CONTEXT.fCampId,
      sourceViewDate: parsed.viewDate,
      selectedViewDay: day.viewDay,
      selectedEpoch: day.epoch,
      dayListPrice: day.price,
      expectedTwoAdultTotal: day.price * SOURCE_CONTEXT.adultCount,
      destinationHttpStatus: destination.status,
      destinationFinalUrlSanitized: sanitizeRakutenConditionUrl(destination.finalUrl),
      fetchMode: destination.mode,
      pageTitle: destination.title,
      dateScopeDetected: comparison.dateMatches,
      adultCountDetected: comparison.adultScopeMatches,
      roomCountDetected: comparison.roomScopeMatches,
      nightCountDetected: comparison.nightScopeMatches,
      taxIncludedTextPresent: comparison.taxIncludedConfirmed,
      totalMatchDetected: comparison.anyVisiblePriceEqualsPriceTimesAdults,
      perPersonMatchDetected: comparison.anyVisiblePriceEqualsDayListPrice,
      classification,
      decision,
      riskNote: destination.error || riskNoteFor(classification, comparison),
      debugArtifactPath: artifactDir
    };
    rows.push(row);
    await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8");

    if (classification !== "condition_link_basis_destination_unreachable") break;
  }

  const csvPath = resolve(REPORT_DIR, `rakuten_condition_link_basis_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_condition_link_basis_probe_${ts}.md`);
  writeFileSync(csvPath, renderConditionBasisCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderConditionBasisReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      rows,
      selectedDay,
      comparison,
      priceCandidates,
      destinationUrlSanitized: rows[0]?.destinationFinalUrlSanitized ?? ""
    }),
    "utf8"
  );

  return { rows, reportPath, csvPath, debugRootPath, followedLinks };
}

function riskNoteFor(classification: string, comparison: BasisComparison): string {
  if (classification === "condition_link_basis_confirmed_total_matches_price_times_adults") {
    return "Destination page visibly matched dayList.price * 2 with date/people/room/night/tax scope.";
  }
  if (classification === "condition_link_basis_confirmed_per_person_only") {
    return "Destination page showed dayList.price, but no clear 2-adult total match.";
  }
  const missing = [
    comparison.dateMatches ? "" : "date",
    comparison.adultScopeMatches ? "" : "adult_count",
    comparison.roomScopeMatches ? "" : "room_count",
    comparison.nightScopeMatches ? "" : "night_count",
    comparison.taxIncludedConfirmed ? "" : "tax_included",
    comparison.anyVisiblePriceEqualsPriceTimesAdults || comparison.anyVisiblePriceEqualsDayListPrice ? "" : "price_match"
  ].filter(Boolean);
  return `Basis remains ambiguous or mismatched: ${missing.join(", ") || "unknown"}.`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return htmlToText(match?.[1] ?? "");
}

runRakutenConditionLinkBasisProbe()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`debug_root=${result.debugRootPath}`);
    console.log(`followed_links=${result.followedLinks}`);
    console.log(`classification_counts=${JSON.stringify(countBy(result.rows.map((r) => r.classification)))}`);
    console.log(`decision=${result.rows[0]?.decision ?? "rakuten_price_basis_not_ready"}`);
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

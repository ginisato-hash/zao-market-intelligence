import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  buildRakutenHotelPlanUrl,
  extractTwoPersonCalendarHref,
  parseRakutenIframeParams
} from "../services/rakutenIframeProbe";
import { buildMatrixIframeUrl } from "../services/rakutenIframeMatrixProbe";
import {
  classifyRakutenDayLink,
  decideRakutenDayLinkFeasibility,
  detectConditionPage,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  extractCalendarMonth,
  extractDayLinksFromCalendarHtml,
  isCalendarDayCellEnabled,
  KNOWN_ZAO_BASE_IFRAME_URL,
  renderRakutenDayLinkCsv,
  renderRakutenDayLinkReport,
  type CalendarDayCell,
  type RakutenDayLinkProbeRow
} from "../services/rakutenDayLinkProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-day-link-probe";

const PROPERTY = { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" } as const;
const PRIMARY_DATE = "2026-06-15";
const MAX_DAY_LINKS_FOLLOWED = 3;
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-day-link-probe/0.1; low-volume feasibility)";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function normalizeHref(href: string): string {
  const decoded = href.replace(/&amp;/gu, "&").trim();
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("/")) return `https://hotel.travel.rakuten.co.jp${decoded}`;
  return decoded;
}

async function extractLiveCalendarHref(page: Page): Promise<string | null> {
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

interface RawDayCell {
  day: string;
  visible: string;
  href: string;
  onclick: string;
  outer: string;
}

async function extractDayCellsFromPage(page: Page): Promise<CalendarDayCell[]> {
  const raw = await page
    .evaluate(() => {
      const out: { day: string; visible: string; href: string; onclick: string; outer: string }[] = [];
      const table = document.querySelector("#roomCalendar");
      if (!table) return out;
      const tds = Array.from(table.querySelectorAll("td"));
      for (const td of tds) {
        const daySpan = td.querySelector("span.thisMonth");
        const day = daySpan ? (daySpan.textContent || "").trim() : "";
        if (!/^\d{1,2}$/.test(day)) continue;
        const a = td.querySelector("a");
        let href = "";
        let onclick = "";
        let visible = "";
        if (a) {
          href = a.getAttribute("href") || "";
          onclick = a.getAttribute("onclick") || "";
          visible = (a.textContent || "").trim();
        } else {
          const full = (td.textContent || "").trim();
          visible = full.replace(day, "").trim();
        }
        out.push({ day, visible, href, onclick, outer: td.outerHTML.slice(0, 600) });
      }
      return out;
    })
    .catch(() => [] as RawDayCell[]);
  return raw.map(toCalendarDayCell);
}

function toCalendarDayCell(raw: RawDayCell): CalendarDayCell {
  const href = raw.href ? normalizeHref(raw.href) : "";
  const cell: CalendarDayCell = {
    day: raw.day,
    visibleText: raw.visible,
    href,
    onclick: raw.onclick,
    outerHtml: raw.outer,
    enabled: false
  };
  cell.enabled = isCalendarDayCellEnabled(cell);
  return cell;
}

function dayToStayDate(calendarMonth: string, day: string): string {
  // calendarMonth is "YYYY-MM"; build "YYYY-MM-DD".
  if (!/^\d{4}-\d{2}$/u.test(calendarMonth) || !/^\d{1,2}$/u.test(day)) return PRIMARY_DATE;
  return `${calendarMonth}-${day.padStart(2, "0")}`;
}

interface FollowResult {
  followedUrl: string;
  reachable: boolean;
  pageText: string;
  pageDom: string;
  errorReason: string;
}

async function followDayLink(
  context: BrowserContext,
  cell: CalendarDayCell,
  artifactDir: string,
  timeoutMs: number
): Promise<FollowResult> {
  const result: FollowResult = {
    followedUrl: cell.href,
    reachable: false,
    pageText: "",
    pageDom: "",
    errorReason: ""
  };
  await writeFile(
    join(artifactDir, "generated_or_followed_url.txt"),
    cell.href || `(onclick) ${cell.onclick}`,
    "utf8"
  ).catch(() => undefined);

  if (!cell.href) {
    // onclick-only links require the parent calendar JS context; out of scope for
    // a direct navigation probe. Record and skip.
    result.errorReason = "onclick_only_link_not_directly_navigable";
    await writeFollowArtifacts(artifactDir, result);
    return result;
  }

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(cell.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(3_000);
    result.reachable = true;
    result.followedUrl = page.url();
    result.pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    result.pageDom = await page.content().catch(() => "");
    await page.screenshot({ path: join(artifactDir, "result_screenshot.png"), fullPage: true }).catch(
      () => undefined
    );
  } catch (error) {
    result.errorReason = error instanceof Error ? error.message : String(error);
  } finally {
    await page.close().catch(() => undefined);
  }
  await writeFollowArtifacts(artifactDir, result);
  return result;
}

async function writeFollowArtifacts(artifactDir: string, result: FollowResult): Promise<void> {
  await writeFile(join(artifactDir, "result_page_text.txt"), result.pageText.slice(0, 80_000), "utf8").catch(
    () => undefined
  );
  await writeFile(join(artifactDir, "result_dom_excerpt.html"), result.pageDom.slice(0, 80_000), "utf8").catch(
    () => undefined
  );
}

function followedRow(
  cell: CalendarDayCell,
  calendarMonth: string,
  liveFSyu: string,
  follow: FollowResult,
  artifactDir: string
): RakutenDayLinkProbeRow {
  const stayDate = dayToStayDate(calendarMonth, cell.day);
  const evidence = detectIframeDateScopedTotalEvidence({
    text: follow.pageText,
    stayDate,
    canonicalPropertyName: PROPERTY.canonicalPropertyName
  });
  const noMatchingRoomType = detectNoMatchingRoomType(follow.pageText);
  const conditionPageReached = detectConditionPage(follow.pageText);
  const classification = classifyRakutenDayLink({
    enabled: cell.enabled,
    followed: true,
    reachable: follow.reachable,
    conditionPageReached,
    noMatchingRoomType,
    evidence
  });
  return {
    canonicalPropertyName: PROPERTY.canonicalPropertyName,
    hotelNo: PROPERTY.hotelNo,
    liveFSyu,
    calendarMonth,
    day: cell.day,
    dayLinkVisibleText: cell.visibleText,
    dayLinkHref: cell.href,
    dayLinkOnclick: cell.onclick,
    dayLinkEnabled: cell.enabled,
    followedUrl: follow.followedUrl,
    reachable: follow.reachable,
    dateScopeDetected: evidence.dateScopeDetected,
    roomCountDetected: evidence.roomCountDetected,
    adultCountDetected: evidence.adultCountDetected,
    nightCountDetected: evidence.nightCountDetected,
    taxIncludedTotalDetected: evidence.taxIncludedTotalText,
    perPersonPriceDetected: evidence.perPersonPriceText,
    availabilityStatus: evidence.availabilityStatus,
    classification,
    riskNote: follow.errorReason || riskNoteFor(classification),
    debugArtifactPath: artifactDir
  };
}

function noAvailableDatesRow(
  calendarMonth: string,
  liveFSyu: string,
  debugRootPath: string
): RakutenDayLinkProbeRow {
  return {
    canonicalPropertyName: PROPERTY.canonicalPropertyName,
    hotelNo: PROPERTY.hotelNo,
    liveFSyu,
    calendarMonth,
    day: "",
    dayLinkVisibleText: "",
    dayLinkHref: "",
    dayLinkOnclick: "",
    dayLinkEnabled: false,
    followedUrl: "",
    reachable: false,
    dateScopeDetected: false,
    roomCountDetected: false,
    adultCountDetected: false,
    nightCountDetected: false,
    taxIncludedTotalDetected: "",
    perPersonPriceDetected: "",
    availabilityStatus: "unknown",
    classification: "day_link_disabled_or_unavailable",
    riskNote:
      "Vacancy calendar rendered but no enabled/available day links (all in-month cells were '-'/'×').",
    debugArtifactPath: debugRootPath
  };
}

export async function runRakutenDayLinkProbe(options: { timeoutMs?: number } = {}): Promise<{
  rows: RakutenDayLinkProbeRow[];
  decision: ReturnType<typeof decideRakutenDayLinkFeasibility>;
  csvPath: string;
  reportPath: string;
  debugRootPath: string;
  executionNote: string;
  liveExtractedHref: string;
  liveSyuValue: string;
  calendarMonth: string;
  gridRendered: boolean;
  allDayCells: CalendarDayCell[];
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  let browser: Browser | null = null;
  let executionNote = "completed rakuten day-link probe";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  let liveExtractedHref = "";
  let liveSyuValue = "";
  let calendarMonth = "";
  let gridRendered = false;
  let allDayCells: CalendarDayCell[] = [];
  const rows: RakutenDayLinkProbeRow[] = [];

  if (browser !== null) {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    try {
      // 1. Live f_syu extraction from the current 2名利用時 空室カレンダー href.
      const planPage = await context.newPage();
      planPage.setDefaultTimeout(timeoutMs);
      try {
        await planPage.goto(buildRakutenHotelPlanUrl(PROPERTY.hotelNo), {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs
        });
        await planPage.waitForTimeout(3_000);
        liveExtractedHref = (await extractLiveCalendarHref(planPage)) ?? "";
        if (liveExtractedHref) liveSyuValue = parseRakutenIframeParams(liveExtractedHref).fSyu ?? "";
      } catch (error) {
        executionNote = `live_extraction_issue: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        await planPage.close().catch(() => undefined);
      }

      // 2. Open the vacancy-calendar iframe for the live f_syu (f_hak left blank,
      //    f_otona_su=2/f_heya_su=1, anchored on the primary date's month).
      const calendarUrl = buildMatrixIframeUrl({
        baseUrl: KNOWN_ZAO_BASE_IFRAME_URL,
        fSyuValue: liveSyuValue || null,
        fHakValue: "",
        stayDate: PRIMARY_DATE
      });
      await writeFile(join(debugRootPath, "calendar_url.txt"), calendarUrl, "utf8").catch(() => undefined);

      const calendarPage = await context.newPage();
      calendarPage.setDefaultTimeout(timeoutMs);
      let calendarText = "";
      let calendarDom = "";
      try {
        await calendarPage.goto(calendarUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        // Give the ttCalendar widget time to load month availability via AJAX.
        await calendarPage.waitForSelector("#roomCalendar", { timeout: 10_000 }).catch(() => undefined);
        await calendarPage.waitForTimeout(6_000);
        gridRendered = (await calendarPage.locator("#roomCalendar").count().catch(() => 0)) > 0;
        calendarText = await calendarPage.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
        calendarDom = await calendarPage.content().catch(() => "");
        calendarMonth = extractCalendarMonth(calendarText) || extractCalendarMonth(calendarDom);
        await calendarPage
          .screenshot({ path: join(debugRootPath, "calendar_screenshot.png"), fullPage: true })
          .catch(() => undefined);
        allDayCells = await extractDayCellsFromPage(calendarPage);
        if (allDayCells.length === 0) {
          allDayCells = extractDayLinksFromCalendarHtml(calendarDom);
        }
      } catch (error) {
        executionNote = `calendar_render_issue: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        await calendarPage.close().catch(() => undefined);
      }
      await writeFile(join(debugRootPath, "calendar_page_text.txt"), calendarText.slice(0, 80_000), "utf8").catch(
        () => undefined
      );
      await writeFile(
        join(debugRootPath, "calendar_dom_excerpt.html"),
        calendarDom.slice(0, 80_000),
        "utf8"
      ).catch(() => undefined);

      // 3. Follow up to MAX_DAY_LINKS_FOLLOWED enabled/available day links.
      const enabled = allDayCells.filter((c) => c.enabled).slice(0, MAX_DAY_LINKS_FOLLOWED);
      for (const cell of enabled) {
        const artifactDir = join(debugRootPath, `day_${cell.day.padStart(2, "0")}`);
        await mkdir(artifactDir, { recursive: true });
        const follow = await followDayLink(context, cell, artifactDir, timeoutMs);
        const row = followedRow(cell, calendarMonth, liveSyuValue, follow, artifactDir);
        await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8").catch(
          () => undefined
        );
        rows.push(row);
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  await writeFile(join(debugRootPath, "live_extracted_href.txt"), liveExtractedHref, "utf8");
  await writeFile(
    join(debugRootPath, "live_extracted_params.json"),
    JSON.stringify(
      liveExtractedHref ? parseRakutenIframeParams(liveExtractedHref) : { note: "live href not found" },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(join(debugRootPath, "day_links.json"), JSON.stringify(allDayCells, null, 2), "utf8");

  if (browser !== null) await browser.close().catch(() => undefined);

  const enabledLinkCount = allDayCells.filter((c) => c.enabled).length;
  if (rows.length === 0) {
    rows.push(noAvailableDatesRow(calendarMonth, liveSyuValue, debugRootPath));
  }

  const decision = decideRakutenDayLinkFeasibility({
    gridRendered,
    enabledLinkCount,
    classifications: rows.map((r) => r.classification)
  });

  const csvPath = resolve(REPORT_DIR, `rakuten_day_link_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_day_link_probe_${ts}.md`);
  writeFileSync(csvPath, renderRakutenDayLinkCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderRakutenDayLinkReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      liveExtractedHref,
      liveSyuValue,
      calendarMonth,
      gridRendered,
      allDayCells,
      rows,
      decision,
      executionNote
    }),
    "utf8"
  );

  return {
    rows,
    decision,
    csvPath,
    reportPath,
    debugRootPath,
    executionNote,
    liveExtractedHref,
    liveSyuValue,
    calendarMonth,
    gridRendered,
    allDayCells
  };
}

function riskNoteFor(classification: string): string {
  switch (classification) {
    case "day_link_total_found":
      return "Day link exposed a date-scoped 2-adult/1-room/1-night tax-included total; review selectors before DB collection.";
    case "day_link_per_person_found":
      return "Day link exposed date-scoped per-person evidence, but not a safe total.";
    case "day_link_condition_page_reached":
      return "Day link reached a reservation condition-setting page; price basis not yet extracted.";
    case "day_link_no_plan_or_sold_out":
      return "Day link reached an explicit no-plan/sold-out state.";
    case "day_link_disabled_or_unavailable":
      return "Day cell was not a clickable available vacancy link.";
    case "day_link_navigation_failed":
      return "Day link could not be followed.";
    default:
      return "Day link opened but adult/room/night/total basis remains unclear.";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenDayLinkProbe();
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`live_extracted_href=${result.liveExtractedHref || "not_found"}`);
  console.log(`live_f_syu=${result.liveSyuValue || "not_found"}`);
  console.log(`calendar_month=${result.calendarMonth || "not_found"}`);
  console.log(`grid_rendered=${result.gridRendered}`);
  console.log(`day_cells_extracted=${result.allDayCells.length}`);
  console.log(`enabled_day_links=${result.allDayCells.filter((c) => c.enabled).length}`);
  console.log(`probe_rows=${result.rows.length}`);
  console.log(`execution_note=${result.executionNote}`);
  console.log(`classification_counts=${JSON.stringify(countClassifications(result.rows))}`);
  console.log(`feasibility_decision=${result.decision}`);
}

function countClassifications(rows: RakutenDayLinkProbeRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  return counts;
}

if (process.argv[1]?.endsWith("probeRakutenDayLinks.ts")) {
  void main();
}

import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  buildHplanCalendarUrl,
  classifyHplanCalendarEndpoint,
  classifyHplanDayLink,
  decideRakutenHplanFeasibility,
  detectConditionPage,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  parseHplanCalendarResponse,
  renderRakutenHplanCsv,
  renderRakutenHplanReport,
  summarizeHplanDays,
  type HplanCalendarParsed,
  type HplanDay,
  type HplanDayLinkClassification,
  type RakutenHplanProbeRow
} from "../services/rakutenHplanCalendarProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-hplan-calendar-probe";

const PROPERTY = { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" } as const;
const F_SYU = "zaobase";
const MONTH_ANCHORS = ["20260601", "20260701", "20260801", "20261001"] as const;
const MAX_DAY_LINKS_FOLLOWED = 3;
const SESSION_SEED_URL =
  "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?TB_iframe=true&f_flg=PLAN&f_hak=&f_heya_su=1&f_hizuke=20260615&f_no=197787&f_otona_su=2&f_syu=zaobase&f_thick=1&height=768&width=1024";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-hplan-calendar-probe/0.1; low-volume feasibility)";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const FOLLOW_RANK: Record<HplanDayLinkClassification, number> = {
  hplan_day_link_total_found: 6,
  hplan_day_link_per_person_found: 5,
  hplan_day_link_condition_page_reached: 4,
  hplan_day_link_no_plan_or_sold_out: 3,
  hplan_day_link_basis_unverified: 2,
  hplan_day_link_navigation_failed: 1
};

interface EndpointFetch {
  status: number;
  body: string;
  error: string;
}

async function fetchInContext(page: Page, url: string): Promise<EndpointFetch> {
  return page
    .evaluate(async (u: string) => {
      try {
        const r = await fetch(u, {
          headers: { "X-Requested-With": "XMLHttpRequest" },
          credentials: "include"
        });
        const body = await r.text();
        return { status: r.status, body, error: "" };
      } catch (e) {
        return { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
      }
    }, url)
    .catch((e: unknown) => ({ status: 0, body: "", error: e instanceof Error ? e.message : String(e) }));
}

function epochToStayDate(epoch: number, fallback: string): string {
  if (!epoch) return fallback;
  const d = new Date(epoch);
  if (Number.isNaN(d.getTime())) return fallback;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function monthAnchorToDate(monthAnchor: string): string {
  return `${monthAnchor.slice(0, 4)}-${monthAnchor.slice(4, 6)}-${monthAnchor.slice(6, 8)}`;
}

interface FollowOutcome {
  classification: HplanDayLinkClassification;
  reachable: boolean;
}

async function followDayLink(
  context: BrowserContext,
  day: HplanDay,
  monthAnchor: string,
  artifactDir: string,
  timeoutMs: number
): Promise<FollowOutcome> {
  await writeFile(join(artifactDir, "followed_url.txt"), day.link, "utf8").catch(() => undefined);
  let reachable = false;
  let pageText = "";
  let pageDom = "";
  let errorReason = "";
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(day.link, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(3_000);
    reachable = true;
    pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    pageDom = await page.content().catch(() => "");
    await page.screenshot({ path: join(artifactDir, "result_screenshot.png"), fullPage: true }).catch(
      () => undefined
    );
  } catch (error) {
    errorReason = error instanceof Error ? error.message : String(error);
  } finally {
    await page.close().catch(() => undefined);
  }
  await writeFile(join(artifactDir, "result_page_text.txt"), pageText.slice(0, 80_000), "utf8").catch(
    () => undefined
  );
  await writeFile(join(artifactDir, "result_dom_excerpt.html"), pageDom.slice(0, 80_000), "utf8").catch(
    () => undefined
  );

  const stayDate = epochToStayDate(day.epoch, monthAnchorToDate(monthAnchor));
  const evidence = detectIframeDateScopedTotalEvidence({
    text: pageText,
    stayDate,
    canonicalPropertyName: PROPERTY.canonicalPropertyName
  });
  const classification = classifyHplanDayLink({
    reachable,
    conditionPageReached: detectConditionPage(pageText),
    noMatchingRoomType: detectNoMatchingRoomType(pageText),
    evidence
  });
  const outcome: FollowOutcome = { classification, reachable };
  await writeFile(
    join(artifactDir, "summary.json"),
    JSON.stringify({ monthAnchor, viewDay: day.viewDay, link: day.link, stayDate, classification, reachable, errorReason }, null, 2),
    "utf8"
  ).catch(() => undefined);
  return outcome;
}

export async function runRakutenHplanCalendarProbe(options: { timeoutMs?: number } = {}): Promise<{
  rows: RakutenHplanProbeRow[];
  decision: ReturnType<typeof decideRakutenHplanFeasibility>;
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
  let executionNote = "completed rakuten hplan-calendar probe";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const rows: RakutenHplanProbeRow[] = [];
  const endpointClassifications: RakutenHplanProbeRow["classification"][] = [];
  const followedClassifications: HplanDayLinkClassification[] = [];
  const enabledQueue: { day: HplanDay; monthAnchor: string }[] = [];

  if (browser !== null) {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    try {
      // Establish a public session on the calendar origin so the JSONP feed
      // responds to same-origin XHR like the live widget.
      const seedPage = await context.newPage();
      seedPage.setDefaultTimeout(timeoutMs);
      try {
        await seedPage.goto(SESSION_SEED_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await seedPage.waitForTimeout(3_000);
      } catch (error) {
        executionNote = `session_seed_issue: ${error instanceof Error ? error.message : String(error)}`;
      }

      for (const monthAnchor of MONTH_ANCHORS) {
        const artifactDir = join(debugRootPath, `month_${monthAnchor}`);
        await mkdir(artifactDir, { recursive: true });
        const endpointUrl = buildHplanCalendarUrl({
          hotelNo: PROPERTY.hotelNo,
          fSyu: F_SYU,
          monthAnchor,
          callback: `cb_${monthAnchor}`,
          cacheBust: Date.now()
        });
        await writeFile(join(artifactDir, "endpoint_url.txt"), endpointUrl, "utf8").catch(() => undefined);

        const fetched = await fetchInContext(seedPage, endpointUrl);
        await writeFile(join(artifactDir, "response_text.txt"), fetched.body.slice(0, 200_000), "utf8").catch(
          () => undefined
        );
        await writeFile(join(artifactDir, "response_dom_or_raw.txt"), fetched.body.slice(0, 200_000), "utf8").catch(
          () => undefined
        );

        const reachable = fetched.error === "" && fetched.status > 0;
        const parsed: HplanCalendarParsed = parseHplanCalendarResponse(fetched.body, fetched.status);
        const summary = summarizeHplanDays(parsed);
        await writeFile(
          join(artifactDir, "parsed_day_links.json"),
          JSON.stringify({ status: fetched.status, parsed, summary: { ...summary, enabledDays: undefined }, enabledDays: summary.enabledDays }, null, 2),
          "utf8"
        ).catch(() => undefined);

        const classification = classifyHplanCalendarEndpoint({
          reachable,
          parsed,
          availableLinkCount: summary.enabledDays.length
        });
        endpointClassifications.push(classification);
        for (const day of summary.enabledDays) enabledQueue.push({ day, monthAnchor });

        const row: RakutenHplanProbeRow = {
          canonicalPropertyName: PROPERTY.canonicalPropertyName,
          hotelNo: PROPERTY.hotelNo,
          fSyu: F_SYU,
          monthAnchor,
          endpointUrl,
          reachable,
          responseType: parsed.responseType,
          availableDayLinksCount: summary.enabledDays.length,
          soldOutDayCount: summary.soldOutCount,
          noPlanDayCount: summary.noPlanCount,
          priceTextDetected: summary.priceText,
          classification,
          followedLinksCount: 0,
          bestFollowedClassification: "",
          riskNote: fetched.error || riskNoteForEndpoint(classification),
          debugArtifactPath: artifactDir
        };
        await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8").catch(
          () => undefined
        );
        rows.push(row);
      }

      // Follow up to MAX_DAY_LINKS_FOLLOWED enabled day links (global cap).
      const toFollow = enabledQueue.slice(0, MAX_DAY_LINKS_FOLLOWED);
      for (const { day, monthAnchor } of toFollow) {
        const followDir = join(debugRootPath, `follow_${monthAnchor}_${day.viewDay.padStart(2, "0")}`);
        await mkdir(followDir, { recursive: true });
        const outcome = await followDayLink(context, day, monthAnchor, followDir, timeoutMs);
        followedClassifications.push(outcome.classification);
        const row = rows.find((r) => r.monthAnchor === monthAnchor);
        if (row) {
          row.followedLinksCount += 1;
          if (
            row.bestFollowedClassification === "" ||
            FOLLOW_RANK[outcome.classification] >
              FOLLOW_RANK[row.bestFollowedClassification as HplanDayLinkClassification]
          ) {
            row.bestFollowedClassification = outcome.classification;
          }
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
  }

  const decision = decideRakutenHplanFeasibility({ endpointClassifications, followedClassifications });
  const csvPath = resolve(REPORT_DIR, `rakuten_hplan_calendar_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_hplan_calendar_probe_${ts}.md`);
  writeFileSync(csvPath, renderRakutenHplanCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderRakutenHplanReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      liveFSyu: F_SYU,
      rows,
      decision,
      executionNote
    }),
    "utf8"
  );

  return { rows, decision, csvPath, reportPath, debugRootPath, executionNote };
}

function riskNoteForEndpoint(classification: string): string {
  switch (classification) {
    case "hplan_calendar_with_available_links":
      return "Endpoint returned vacant day links with price/link fields; map dayList.price/link before DB collection.";
    case "hplan_calendar_no_available_dates":
      return "Endpoint reachable with a clean dayList, but no vacant day for this f_syu/month (all isPast/non-vacant).";
    case "hplan_calendar_sold_out_or_no_plan":
      return "Endpoint reachable; probed month is sold out / no plan (days marked full).";
    case "hplan_calendar_empty":
      return "Endpoint returned an empty payload.";
    case "hplan_calendar_blocked_or_failed":
      return "Endpoint blocked or request failed.";
    default:
      return "Endpoint reachable but day-level basis could not be confirmed.";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenHplanCalendarProbe();
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`endpoint_urls_tested=${result.rows.length}`);
  console.log(`response_types=${JSON.stringify(result.rows.map((r) => r.responseType))}`);
  console.log(`available_links=${JSON.stringify(result.rows.map((r) => r.availableDayLinksCount))}`);
  console.log(`execution_note=${result.executionNote}`);
  console.log(`classification_counts=${JSON.stringify(countClassifications(result.rows))}`);
  console.log(`feasibility_decision=${result.decision}`);
}

function countClassifications(rows: RakutenHplanProbeRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  return counts;
}

if (process.argv[1]?.endsWith("probeRakutenHplanCalendar.ts")) {
  void main();
}

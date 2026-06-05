import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  buildHplanCalendarUrl,
  classifyHplanFollowedLink,
  classifyHplanVacancyEndpoint,
  decideRakutenHplanVacancy,
  detectConditionPage,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  extractRoomCodesFromPlanPage,
  limitRoomCodes,
  parseHplanCalendarResponse,
  renderRakutenHplanVacancyCsv,
  renderRakutenHplanVacancyReport,
  summarizeVacancyDays,
  type HplanCalendarParsed,
  type HplanDay,
  type HplanFollowedClassification,
  type HplanVacancyEndpointClassification,
  type RakutenHplanVacancyRow
} from "../services/rakutenHplanVacancyProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-hplan-vacancy-positive-probe";

const PROPERTIES = [
  { canonicalPropertyName: "蔵王国際ホテル", hotelNo: "5723" },
  { canonicalPropertyName: "深山荘 高見屋", hotelNo: "38534" },
  { canonicalPropertyName: "名湯リゾート ルーセント", hotelNo: "39565" },
  { canonicalPropertyName: "JURIN", hotelNo: "14585" }
] as const;
const MONTH_ANCHORS = ["20260601", "20260701", "20260801", "20261001"] as const;
const MAX_ROOM_CODES = 3;
const MAX_ENDPOINT_URLS = 48;
const MAX_FOLLOWED_LINKS = 3;
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-hplan-vacancy-probe/0.1; low-volume feasibility)";

function planPageUrl(hotelNo: string): string {
  return `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${hotelNo}`;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const FOLLOW_RANK: Record<HplanFollowedClassification, number> = {
  hplan_followed_total_found: 6,
  hplan_followed_per_person_found: 5,
  hplan_followed_condition_page_reached: 4,
  hplan_followed_no_plan_or_sold_out: 3,
  hplan_followed_basis_unverified: 2,
  hplan_followed_navigation_failed: 1
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
  classification: HplanFollowedClassification;
}

async function followDayLink(
  context: BrowserContext,
  day: HplanDay,
  propertyName: string,
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
    canonicalPropertyName: propertyName
  });
  const classification = classifyHplanFollowedLink({
    reachable,
    conditionPageReached: detectConditionPage(pageText),
    noMatchingRoomType: detectNoMatchingRoomType(pageText),
    evidence
  });
  await writeFile(
    join(artifactDir, "summary.json"),
    JSON.stringify({ propertyName, monthAnchor, viewDay: day.viewDay, link: day.link, stayDate, classification, reachable, errorReason }, null, 2),
    "utf8"
  ).catch(() => undefined);
  return { classification };
}

export async function runRakutenHplanVacancyProbe(options: { timeoutMs?: number } = {}): Promise<{
  rows: RakutenHplanVacancyRow[];
  decision: ReturnType<typeof decideRakutenHplanVacancy>;
  csvPath: string;
  reportPath: string;
  debugRootPath: string;
  executionNote: string;
  propertiesTested: { canonicalPropertyName: string; hotelNo: string; roomCodes: string[] }[];
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  let browser: Browser | null = null;
  let executionNote = "completed rakuten hplan vacancy-positive probe";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const rows: RakutenHplanVacancyRow[] = [];
  const endpointClassifications: HplanVacancyEndpointClassification[] = [];
  const followedClassifications: HplanFollowedClassification[] = [];
  const followQueue: { day: HplanDay; propertyName: string; monthAnchor: string; rowKey: string }[] = [];
  const propertiesTested: { canonicalPropertyName: string; hotelNo: string; roomCodes: string[] }[] = [];

  let endpointBudget = MAX_ENDPOINT_URLS;

  if (browser !== null) {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    try {
      for (const property of PROPERTIES) {
        const planUrl = planPageUrl(property.hotelNo);
        const planPage = await context.newPage();
        planPage.setDefaultTimeout(timeoutMs);
        let planHtml = "";
        try {
          await planPage.goto(planUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          await planPage.waitForTimeout(3_000);
          planHtml = await planPage.content().catch(() => "");
        } catch (error) {
          executionNote = `plan_page_issue(${property.hotelNo}): ${error instanceof Error ? error.message : String(error)}`;
        }

        const extracted = extractRoomCodesFromPlanPage(planHtml);
        const roomCodes = limitRoomCodes(extracted.map((r) => r.fSyu), MAX_ROOM_CODES);
        // Fall back to the bare default room scope so the endpoint is still probed.
        const probeCodes = roomCodes.length > 0 ? roomCodes : [""];
        propertiesTested.push({
          canonicalPropertyName: property.canonicalPropertyName,
          hotelNo: property.hotelNo,
          roomCodes
        });

        for (const fSyu of probeCodes) {
          for (const monthAnchor of MONTH_ANCHORS) {
            if (endpointBudget <= 0) break;
            endpointBudget -= 1;

            const safeSyu = fSyu === "" ? "default" : fSyu.replace(/[^\w-]/gu, "_");
            const artifactDir = join(debugRootPath, `${property.hotelNo}_${safeSyu}_${monthAnchor}`);
            await mkdir(artifactDir, { recursive: true });
            await writeFile(join(artifactDir, "plan_page_url.txt"), planUrl, "utf8").catch(() => undefined);
            await writeFile(
              join(artifactDir, "extracted_calendar_hrefs.json"),
              JSON.stringify(extracted, null, 2),
              "utf8"
            ).catch(() => undefined);

            const endpointUrl = buildHplanCalendarUrl({
              hotelNo: property.hotelNo,
              fSyu,
              monthAnchor,
              callback: `cb_${property.hotelNo}_${monthAnchor}`,
              cacheBust: Date.now()
            });
            await writeFile(join(artifactDir, "endpoint_url.txt"), endpointUrl, "utf8").catch(() => undefined);

            // Use the property's own plan page as same-origin context for the JSONP XHR.
            const fetched = await fetchInContext(planPage, endpointUrl);
            await writeFile(join(artifactDir, "response_text.txt"), fetched.body.slice(0, 200_000), "utf8").catch(
              () => undefined
            );

            const reachable = fetched.error === "" && fetched.status > 0;
            const parsed: HplanCalendarParsed = parseHplanCalendarResponse(fetched.body, fetched.status);
            const summary = summarizeVacancyDays(parsed);
            await writeFile(
              join(artifactDir, "response_raw.json"),
              JSON.stringify({ status: fetched.status, error: fetched.error, parsed }, null, 2),
              "utf8"
            ).catch(() => undefined);
            await writeFile(
              join(artifactDir, "parsed_day_links.json"),
              JSON.stringify(summary, null, 2),
              "utf8"
            ).catch(() => undefined);

            const classification = classifyHplanVacancyEndpoint({ reachable, parsed });
            endpointClassifications.push(classification);

            const rowKey = `${property.hotelNo}_${safeSyu}_${monthAnchor}`;
            for (const day of summary.vacancyPositiveDays) {
              followQueue.push({ day, propertyName: property.canonicalPropertyName, monthAnchor, rowKey });
            }

            const row: RakutenHplanVacancyRow = {
              canonicalPropertyName: property.canonicalPropertyName,
              hotelNo: property.hotelNo,
              fSyu,
              monthAnchor,
              endpointUrl,
              reachable,
              responseType: parsed.responseType,
              isTaxExclusive: parsed.isTaxExclusive,
              chargeType: parsed.chargeType,
              availableDayCount: summary.availableDayCount,
              pricePositiveDayCount: summary.pricePositiveDayCount,
              populatedLinkCount: summary.populatedLinkCount,
              sampleAvailableDate: summary.sampleAvailableDate,
              samplePrice: summary.samplePrice,
              sampleLink: summary.sampleLink,
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
        }
        await planPage.close().catch(() => undefined);
      }

      // Follow up to MAX_FOLLOWED_LINKS vacancy-positive day links (global cap).
      const toFollow = followQueue.slice(0, MAX_FOLLOWED_LINKS);
      for (const { day, propertyName, monthAnchor, rowKey } of toFollow) {
        const followDir = join(debugRootPath, `follow_${rowKey}_${day.viewDay.padStart(2, "0")}`);
        await mkdir(followDir, { recursive: true });
        const outcome = await followDayLink(context, day, propertyName, monthAnchor, followDir, timeoutMs);
        followedClassifications.push(outcome.classification);
        const row = rows.find((r) => `${r.hotelNo}_${r.fSyu === "" ? "default" : r.fSyu.replace(/[^\w-]/gu, "_")}_${r.monthAnchor}` === rowKey);
        if (row) {
          row.followedLinksCount += 1;
          if (
            row.bestFollowedClassification === "" ||
            FOLLOW_RANK[outcome.classification] >
              FOLLOW_RANK[row.bestFollowedClassification as HplanFollowedClassification]
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

  const decision = decideRakutenHplanVacancy({ endpointClassifications, followedClassifications });
  const csvPath = resolve(REPORT_DIR, `rakuten_hplan_vacancy_positive_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_hplan_vacancy_positive_probe_${ts}.md`);
  writeFileSync(csvPath, renderRakutenHplanVacancyCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderRakutenHplanVacancyReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      rows,
      decision,
      executionNote,
      propertiesTested,
      monthAnchors: [...MONTH_ANCHORS]
    }),
    "utf8"
  );

  return { rows, decision, csvPath, reportPath, debugRootPath, executionNote, propertiesTested };
}

function riskNoteForEndpoint(classification: HplanVacancyEndpointClassification): string {
  switch (classification) {
    case "hplan_vacancy_positive":
      return "Vacancy-positive day(s) with price>0 + link; follow the link and map dayList.price/link before DB collection.";
    case "hplan_price_positive_no_link":
      return "Price-positive day(s) present but link empty; basis exists but no condition-page entry to confirm.";
    case "hplan_no_available_dates":
      return "Endpoint reachable with a clean dayList, but no vacant day for this room/month (all isPast/non-vacant).";
    case "hplan_sold_out_or_no_plan":
      return "Endpoint reachable; probed month is sold out / no plan (days marked full).";
    case "hplan_empty":
      return "Endpoint returned an empty payload.";
    case "hplan_blocked_or_failed":
      return "Endpoint blocked or request failed.";
    default:
      return "Endpoint reachable but day-level basis could not be confirmed.";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenHplanVacancyProbe();
  const vacancyPositive = result.rows.filter((r) => r.classification === "hplan_vacancy_positive").length;
  const pricePositive = result.rows.filter(
    (r) => r.classification === "hplan_vacancy_positive" || r.classification === "hplan_price_positive_no_link"
  ).length;
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`endpoint_urls_tested=${result.rows.length}`);
  console.log(`properties_tested=${JSON.stringify(result.propertiesTested.map((p) => `${p.hotelNo}:[${p.roomCodes.join("|")}]`))}`);
  console.log(`vacancy_positive_rows=${vacancyPositive}`);
  console.log(`price_positive_rows=${pricePositive}`);
  console.log(`classification_counts=${JSON.stringify(countClassifications(result.rows))}`);
  console.log(`execution_note=${result.executionNote}`);
  console.log(`feasibility_decision=${result.decision}`);
}

function countClassifications(rows: RakutenHplanVacancyRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  return counts;
}

if (process.argv[1]?.endsWith("probeRakutenHplanVacancyPositive.ts")) {
  void main();
}

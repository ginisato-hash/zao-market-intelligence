import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page, Request as PWRequest } from "playwright";
import {
  buildHplanCalendarUrl,
  classifyLiveHplanCapture,
  computeParamDiff,
  decideRakutenLiveHplan,
  isHplanCalendarUrl,
  parseHplanCalendarResponse,
  summarizeVacancyDays,
  renderRakutenLiveHplanCsv,
  renderRakutenLiveHplanReport,
  type HplanCalendarParsed,
  type LiveHplanClassification,
  type ParamDiff,
  type RakutenLiveHplanRow
} from "../services/rakutenLiveHplanCaptureProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-live-hplan-capture";

const PROPERTIES = [
  { canonicalPropertyName: "蔵王国際ホテル", hotelNo: "5723" },
  { canonicalPropertyName: "名湯リゾート ルーセント", hotelNo: "39565" },
  { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" }
] as const;
const MAX_PROPERTIES = 3;
const MAX_CLICKS_PER_PROPERTY = 3;
const MAX_TOTAL_CAPTURED_REQUESTS = 10;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function planPageUrl(hotelNo: string): string {
  return `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${hotelNo}`;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface CapturedRequest {
  url: string;
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  postData: string;
  status: number;
  contentType: string;
  body: string;
}

interface CandidateLink {
  index: number;
  text: string;
  href: string;
  outerHtml: string;
  surrounding: string;
  prefersTwoAdults: boolean;
}

const HEADER_SUBSET = ["referer", "x-requested-with", "accept", "user-agent", "cookie"];

function pickHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of HEADER_SUBSET) {
    const v = headers[key];
    if (v !== undefined) out[key] = key === "cookie" ? `present(${v.length} chars)` : v;
  }
  return out;
}

/** Reconstruct the Phase 62X URL for the same hotel/room/month the live request used. */
function reconstructedForLive(liveUrl: string): string {
  let hotelNo = "5723";
  let fSyu = "";
  let monthAnchor = "20260601";
  try {
    const u = new URL(liveUrl);
    hotelNo = u.searchParams.get("f_no") ?? hotelNo;
    fSyu = u.searchParams.get("f_syu") ?? "";
    const cal = u.searchParams.get("f_calendar") ?? u.searchParams.get("f_hizuke") ?? "";
    if (/^\d{8}$/u.test(cal)) monthAnchor = cal;
    else if (/^\d{6}$/u.test(cal)) monthAnchor = `${cal}01`;
  } catch {
    // keep defaults
  }
  if (!/^\d+$/u.test(hotelNo)) hotelNo = "5723";
  try {
    return buildHplanCalendarUrl({ hotelNo, fSyu, monthAnchor, callback: "cb", cacheBust: 0 });
  } catch {
    return buildHplanCalendarUrl({ hotelNo: "5723", fSyu: "", monthAnchor: "20260601", callback: "cb", cacheBust: 0 });
  }
}

async function findCalendarLinks(page: Page): Promise<CandidateLink[]> {
  const raw = await page
    .evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));
      const out: { index: number; text: string; href: string; outerHtml: string; surrounding: string }[] = [];
      anchors.forEach((a, index) => {
        const href = a.getAttribute("href") ?? "";
        const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
        const isCalendar = /calendar/i.test(href) || /空室カレンダー/.test(text);
        if (!isCalendar) return;
        const block = a.closest("li,tr,div,section") ?? a.parentElement;
        out.push({
          index,
          text,
          href,
          outerHtml: a.outerHTML.slice(0, 4_000),
          surrounding: (block?.outerHTML ?? "").slice(0, 8_000)
        });
      });
      return out;
    })
    .catch(() => [] as { index: number; text: string; href: string; outerHtml: string; surrounding: string }[]);

  return raw
    .map((r) => ({ ...r, prefersTwoAdults: /2\s*名|２名|大人\s*2|大人２/u.test(r.surrounding) }))
    .sort((a, b) => Number(b.prefersTwoAdults) - Number(a.prefersTwoAdults));
}

export async function runRakutenLiveHplanCapture(options: { timeoutMs?: number } = {}): Promise<{
  rows: RakutenLiveHplanRow[];
  decision: ReturnType<typeof decideRakutenLiveHplan>;
  csvPath: string;
  reportPath: string;
  debugRootPath: string;
  executionNote: string;
  representativeDiff: ParamDiff | null;
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  let browser: Browser | null = null;
  let executionNote = "completed rakuten live hplan capture";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const rows: RakutenLiveHplanRow[] = [];
  const classifications: LiveHplanClassification[] = [];
  let representativeDiff: ParamDiff | null = null;
  let totalCaptured = 0;

  if (browser !== null) {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
    try {
      for (const property of PROPERTIES.slice(0, MAX_PROPERTIES)) {
        const planUrl = planPageUrl(property.hotelNo);
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);

        // Attach network listeners BEFORE navigation so auto-fired calendar
        // requests (widget on load) are captured too.
        const captured: CapturedRequest[] = [];
        const pendingBodies: Promise<void>[] = [];
        page.on("request", (req: PWRequest) => {
          if (!isHplanCalendarUrl(req.url())) return;
          captured.push({
            url: req.url(),
            method: req.method(),
            resourceType: req.resourceType(),
            headers: pickHeaders(req.headers()),
            postData: req.postData() ?? "",
            status: 0,
            contentType: "",
            body: ""
          });
        });
        page.on("response", (resp) => {
          if (!isHplanCalendarUrl(resp.url())) return;
          const entry = captured.find((c) => c.url === resp.url() && c.status === 0);
          if (!entry) return;
          entry.status = resp.status();
          entry.contentType = resp.headers()["content-type"] ?? "";
          pendingBodies.push(
            resp
              .text()
              .then((t) => {
                entry.body = t.slice(0, 200_000);
              })
              .catch(() => undefined)
          );
        });

        let pageTextBefore = "";
        const propDirBase = join(debugRootPath, `${property.hotelNo}`);
        try {
          await page.goto(planUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          await page.waitForTimeout(4_000);
          pageTextBefore = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
        } catch (error) {
          executionNote = `plan_page_issue(${property.hotelNo}): ${error instanceof Error ? error.message : String(error)}`;
        }
        await mkdir(propDirBase, { recursive: true });
        await page.screenshot({ path: join(propDirBase, "screenshot_before.png"), fullPage: false }).catch(
          () => undefined
        );

        const links = await findCalendarLinks(page);
        const clicks = Math.min(links.length, MAX_CLICKS_PER_PROPERTY);
        const effectiveClicks = clicks > 0 ? clicks : 1; // still emit one row if no link found

        for (let i = 0; i < effectiveClicks; i++) {
          if (totalCaptured >= MAX_TOTAL_CAPTURED_REQUESTS) break;
          const link = links[i];
          const artifactDir = join(debugRootPath, `${property.hotelNo}_click_${i}`);
          await mkdir(artifactDir, { recursive: true });
          await writeFile(join(artifactDir, "plan_page_url.txt"), planUrl, "utf8").catch(() => undefined);
          await writeFile(join(artifactDir, "calendar_link_outer_html.html"), link?.outerHtml ?? "", "utf8").catch(
            () => undefined
          );
          await writeFile(join(artifactDir, "surrounding_plan_block.html"), link?.surrounding ?? "", "utf8").catch(
            () => undefined
          );
          await writeFile(join(artifactDir, "page_text_before.txt"), pageTextBefore.slice(0, 80_000), "utf8").catch(
            () => undefined
          );

          const capturedBefore = captured.length;
          let clickRegisteredEffect = false;
          if (link) {
            try {
              const target = page.locator("a").nth(link.index);
              await target.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
              await target.click({ timeout: 6_000 }).catch(() => undefined);
              clickRegisteredEffect = true;
              await page
                .waitForRequest((r) => isHplanCalendarUrl(r.url()), { timeout: 8_000 })
                .catch(() => undefined);
              await page.waitForTimeout(3_000);
            } catch {
              clickRegisteredEffect = false;
            }
          }
          await Promise.all(pendingBodies).catch(() => undefined);

          const pageTextAfter = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
          await writeFile(join(artifactDir, "page_text_after.txt"), pageTextAfter.slice(0, 80_000), "utf8").catch(
            () => undefined
          );
          await page.screenshot({ path: join(artifactDir, "screenshot_after.png"), fullPage: false }).catch(
            () => undefined
          );

          const newRequests = captured.slice(capturedBefore);
          const requestCaptured = newRequests.length > 0;
          if (requestCaptured) totalCaptured += newRequests.length;

          await writeFile(
            join(artifactDir, "captured_requests.json"),
            JSON.stringify(newRequests, null, 2),
            "utf8"
          ).catch(() => undefined);

          const primary = newRequests.find((r) => r.body !== "") ?? newRequests[0];
          let parsed: HplanCalendarParsed | null = null;
          let diff: ParamDiff | null = null;
          if (primary) {
            await writeFile(join(artifactDir, "captured_response_body.txt"), primary.body, "utf8").catch(
              () => undefined
            );
            parsed = parseHplanCalendarResponse(primary.body, primary.status || 200);
            await writeFile(
              join(artifactDir, "captured_response_parsed.json"),
              JSON.stringify(parsed, null, 2),
              "utf8"
            ).catch(() => undefined);
            diff = computeParamDiff(primary.url, reconstructedForLive(primary.url));
            await writeFile(join(artifactDir, "param_diff.json"), JSON.stringify(diff, null, 2), "utf8").catch(
              () => undefined
            );
            if (representativeDiff === null) representativeDiff = diff;
          } else {
            await writeFile(join(artifactDir, "captured_response_body.txt"), "", "utf8").catch(() => undefined);
            await writeFile(join(artifactDir, "param_diff.json"), JSON.stringify(null), "utf8").catch(
              () => undefined
            );
          }

          const summary = parsed ? summarizeVacancyDays(parsed) : null;
          const classification = classifyLiveHplanCapture({
            requestCaptured,
            clickRegisteredEffect,
            parsed
          });
          classifications.push(classification);

          const row: RakutenLiveHplanRow = {
            canonicalPropertyName: property.canonicalPropertyName,
            hotelNo: property.hotelNo,
            clickIndex: i,
            calendarLinkText: link?.text ?? "",
            calendarLinkHref: link?.href ?? "",
            capturedHplanUrl: primary?.url ?? "",
            capturedStatus: primary?.status ?? 0,
            capturedResponseType: parsed?.responseType ?? "",
            liveAvailableDayCount: summary?.availableDayCount ?? 0,
            livePricePositiveDayCount: summary?.pricePositiveDayCount ?? 0,
            livePopulatedLinkCount: summary?.populatedLinkCount ?? 0,
            phase62ParamGapCount: diff?.gapCount ?? 0,
            classification,
            riskNote: riskNoteForClassification(classification),
            debugArtifactPath: artifactDir
          };
          await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8").catch(
            () => undefined
          );
          rows.push(row);
        }

        await page.close().catch(() => undefined);
        if (totalCaptured >= MAX_TOTAL_CAPTURED_REQUESTS) break;
      }
    } finally {
      await context.close().catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
  }

  const anyParamGap = rows.some((r) => r.phase62ParamGapCount > 0);
  const decision = decideRakutenLiveHplan({ classifications, anyParamGap });
  const csvPath = resolve(REPORT_DIR, `rakuten_live_hplan_capture_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_live_hplan_capture_${ts}.md`);
  writeFileSync(csvPath, renderRakutenLiveHplanCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderRakutenLiveHplanReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      rows,
      decision,
      executionNote,
      propertiesTested: PROPERTIES.slice(0, MAX_PROPERTIES).map((p) => ({
        canonicalPropertyName: p.canonicalPropertyName,
        hotelNo: p.hotelNo
      })),
      representativeDiff
    }),
    "utf8"
  );

  return { rows, decision, csvPath, reportPath, debugRootPath, executionNote, representativeDiff };
}

function riskNoteForClassification(classification: LiveHplanClassification): string {
  switch (classification) {
    case "live_hplan_response_positive":
      return "Live request captured with vacancy-positive day data (isVacant+price>0+link).";
    case "live_hplan_response_all_full":
      return "Live request captured but response is all-full (no vacant day) for this property/date.";
    case "live_hplan_response_empty":
      return "Live request captured but response was empty.";
    case "live_hplan_response_blocked_or_failed":
      return "Live request captured but response was blocked or unparseable.";
    case "live_hplan_request_captured":
      return "Live request captured; response not classifiable into vacancy/full/empty.";
    case "live_hplan_request_not_emitted":
      return "Calendar interaction registered but no /hplan/calendar/ request was emitted.";
    case "calendar_click_no_effect":
      return "No calendar link found or click had no observable effect.";
    default:
      return "";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenLiveHplanCapture();
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`rows=${result.rows.length}`);
  console.log(`captured_requests=${result.rows.filter((r) => r.capturedHplanUrl !== "").length}`);
  console.log(`classification_counts=${JSON.stringify(countClassifications(result.rows))}`);
  console.log(`param_gap_count=${result.representativeDiff?.gapCount ?? 0}`);
  if (result.representativeDiff) {
    console.log(`params_only_in_live=${JSON.stringify(result.representativeDiff.onlyInLive.map((p) => p.key))}`);
  }
  console.log(`execution_note=${result.executionNote}`);
  console.log(`feasibility_decision=${result.decision}`);
}

function countClassifications(rows: RakutenLiveHplanRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  return counts;
}

if (process.argv[1]?.endsWith("probeRakutenLiveHplanCapture.ts")) {
  void main();
}

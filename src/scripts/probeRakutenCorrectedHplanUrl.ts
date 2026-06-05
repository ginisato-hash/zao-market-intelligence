import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  buildCorrectedHplanCalendarUrl,
  buildPhase63Comparison,
  classifyCorrectedHplan,
  decideRakutenCorrectedHplan,
  isBasisAmbiguous,
  parseHplanCalendarResponse,
  renderCorrectedHplanCsv,
  renderCorrectedHplanReport,
  sanitizeHplanUrl,
  summarizeVacancyDays,
  type CorrectedHplanClassification,
  type CorrectedHplanRow,
  type HplanCalendarParsed,
  type Phase63Comparison
} from "../services/rakutenCorrectedHplanUrlProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-corrected-hplan-url";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-corrected-hplan-probe/0.1; low-volume feasibility)";

const TARGETS = [
  {
    canonicalPropertyName: "蔵王国際ホテル",
    hotelNo: "5723",
    fSyu: "00",
    fCampId: "6468227",
    fHizuke: "20260601",
    phase63Path: ".data/debug/rakuten-live-hplan-capture/20260601_191550/5723_click_0/captured_requests.json"
  },
  {
    canonicalPropertyName: "名湯リゾート ルーセント",
    hotelNo: "39565",
    fSyu: "honkan-exk",
    fCampId: "5623966",
    fHizuke: "20260601",
    phase63Path: ".data/debug/rakuten-live-hplan-capture/20260601_191550/39565_click_0/captured_requests.json"
  }
] as const;

interface EndpointFetch {
  status: number;
  body: string;
  mode: "direct" | "browser_context" | "none";
  error: string;
}

interface ParsedLiveRequest {
  url: string;
  positiveCount: number;
  isTaxExclusive: boolean;
  chargeType: string;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function checkinFromCompact(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

async function fetchDirect(url: string): Promise<EndpointFetch> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    return { status: response.status, body: await response.text(), mode: "direct", error: "" };
  } catch (error) {
    return {
      status: 0,
      body: "",
      mode: "direct",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchInBrowserContext(
  context: BrowserContext,
  planPageUrl: string,
  endpointUrl: string,
  timeoutMs: number
): Promise<EndpointFetch> {
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(planPageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1_500);
    const result = await page.evaluate(async (urlToFetch: string) => {
      try {
        const response = await fetch(urlToFetch, {
          headers: { "X-Requested-With": "XMLHttpRequest" },
          credentials: "include"
        });
        return { status: response.status, body: await response.text(), error: "" };
      } catch (error) {
        return { status: 0, body: "", error: error instanceof Error ? error.message : String(error) };
      }
    }, endpointUrl);
    return { ...result, mode: "browser_context" };
  } catch (error) {
    return {
      status: 0,
      body: "",
      mode: "browser_context",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

function shouldRetryInBrowser(status: number, parsed: HplanCalendarParsed | null): boolean {
  if (status === 400 || status === 0) return true;
  if (parsed === null) return true;
  return !parsed.ok && parsed.days.length === 0;
}

function parseOrNull(body: string, status: number): HplanCalendarParsed | null {
  const parsed = parseHplanCalendarResponse(body, status);
  if (!parsed.ok && parsed.responseType !== "blocked_or_error" && parsed.responseType !== "empty") return null;
  return parsed;
}

function responseType(parsed: HplanCalendarParsed | null): string {
  return parsed?.responseType ?? "parse_error";
}

function sampleDays(parsed: HplanCalendarParsed | null): {
  viewDay: string;
  day: number;
  stock: number;
  price: number;
  priceWithoutTax: number;
  discountedPrice: number;
  isVacant: boolean;
  isFull: boolean;
  link_present: boolean;
}[] {
  if (parsed === null) return [];
  return parsed.days
    .filter((d) => d.isVacant || d.price > 0 || d.link.trim() !== "")
    .slice(0, 3)
    .map((d) => ({
      viewDay: d.viewDay,
      day: d.epoch,
      stock: d.stock,
      price: d.price,
      priceWithoutTax: d.priceWithoutTax,
      discountedPrice: d.discountedPrice,
      isVacant: d.isVacant,
      isFull: d.isFull,
      link_present: d.link.trim() !== ""
    }));
}

function redactedParsed(parsed: HplanCalendarParsed | null): unknown {
  if (parsed === null) return null;
  return {
    ...parsed,
    days: parsed.days.map((d) => ({
      ...d,
      link: d.link.trim() === "" ? "" : "[redacted]",
      link_present: d.link.trim() !== ""
    }))
  };
}

async function loadPhase63LiveRequest(path: string): Promise<ParsedLiveRequest | null> {
  try {
    const raw = await readFile(resolve(path), "utf8");
    const rows = JSON.parse(raw) as { url?: string; status?: number; body?: string }[];
    const first = rows[0];
    if (!first?.url) return null;
    const parsed = parseHplanCalendarResponse(first.body ?? "", first.status ?? 0);
    const summary = summarizeVacancyDays(parsed);
    return {
      url: first.url,
      positiveCount: summary.vacancyPositiveDays.length,
      isTaxExclusive: parsed.isTaxExclusive,
      chargeType: parsed.chargeType
    };
  } catch {
    return null;
  }
}

async function runRakutenCorrectedHplanUrlProbe(options: { timeoutMs?: number } = {}): Promise<{
  rows: CorrectedHplanRow[];
  reportPath: string;
  csvPath: string;
  debugRootPath: string;
  decision: ReturnType<typeof decideRakutenCorrectedHplan>;
  requestCount: number;
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const rows: CorrectedHplanRow[] = [];
  const comparisons: Phase63Comparison[] = [];
  const classifications: CorrectedHplanClassification[] = [];
  let directReachable = false;
  let browserReachable = false;
  let anyPriceWithoutBasis = false;
  let requestCount = 0;

  for (const target of TARGETS) {
    const artifactDir = join(debugRootPath, `${target.hotelNo}_${target.fSyu}_${target.fHizuke}`);
    await mkdir(artifactDir, { recursive: true });
    const requestUrl = buildCorrectedHplanCalendarUrl({
      hotelNo: target.hotelNo,
      fSyu: target.fSyu,
      fCampId: target.fCampId,
      checkin: checkinFromCompact(target.fHizuke),
      dateScopeMode: "live_blank",
      callback: `cb_${target.hotelNo}_${target.fHizuke}`,
      cacheBust: 0
    });
    const sanitizedUrl = sanitizeHplanUrl(requestUrl);
    await writeFile(join(artifactDir, "corrected_request_url.txt"), sanitizedUrl, "utf8");
    await writeFile(
      join(artifactDir, "corrected_request_params.json"),
      JSON.stringify(Object.fromEntries(new URL(requestUrl).searchParams.entries()), null, 2),
      "utf8"
    );

    let fetched = await fetchDirect(requestUrl);
    requestCount += 1;
    let parsed = parseOrNull(fetched.body, fetched.status);
    directReachable ||= fetched.status > 0 && fetched.status < 400 && parsed !== null && parsed.ok;

    if (shouldRetryInBrowser(fetched.status, parsed) && requestCount < 4) {
      if (browser === null) {
        try {
          const { chromium } = await import("playwright");
          browser = await chromium.launch({ headless: true });
          context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
        } catch (error) {
          fetched = {
            status: fetched.status,
            body: fetched.body,
            mode: fetched.mode,
            error: `${fetched.error || "direct fetch did not produce a usable JSONP response"}; browser_launch_failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          };
        }
      }
      if (context !== null) {
        fetched = await fetchInBrowserContext(
          context,
          `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${target.hotelNo}`,
          requestUrl,
          timeoutMs
        );
        requestCount += 1;
        parsed = parseOrNull(fetched.body, fetched.status);
        browserReachable ||= fetched.status > 0 && fetched.status < 400 && parsed !== null && parsed.ok;
      }
    }

    const classification = classifyCorrectedHplan({
      status: fetched.status,
      parsed,
      networkError: fetched.error !== "" && fetched.status === 0
    });
    classifications.push(classification);
    anyPriceWithoutBasis ||= isBasisAmbiguous(parsed);
    const summary = parsed === null ? null : summarizeVacancyDays(parsed);
    const availableSample = sampleDays(parsed);
    const row: CorrectedHplanRow = {
      canonicalPropertyName: target.canonicalPropertyName,
      hotelNo: target.hotelNo,
      fSyu: target.fSyu,
      fCampId: target.fCampId,
      targetAnchor: target.fHizuke,
      requestUrlSanitized: sanitizedUrl,
      fetchMode: fetched.mode,
      httpStatus: fetched.status,
      responseType: responseType(parsed),
      viewDate: parsed?.viewDate ?? "",
      isEmpty: parsed?.isEmpty ?? true,
      isTaxExclusive: parsed?.isTaxExclusive ?? false,
      chargeType: parsed?.chargeType ?? "",
      dayListLength: parsed?.days.length ?? 0,
      vacantDayCount: summary?.availableDayCount ?? 0,
      pricePositiveCount: summary?.pricePositiveDayCount ?? 0,
      linkPopulatedCount: summary?.populatedLinkCount ?? 0,
      samplePrice: summary?.samplePrice ?? 0,
      classification,
      riskNote: fetched.error || riskNoteFor(parsed, classification),
      debugArtifactPath: artifactDir
    };
    rows.push(row);

    await writeFile(join(artifactDir, "response_body.txt"), fetched.body.slice(0, 250_000), "utf8");
    await writeFile(join(artifactDir, "response_parsed.json"), JSON.stringify(redactedParsed(parsed), null, 2), "utf8");
    await writeFile(join(artifactDir, "available_days_sample.json"), JSON.stringify(availableSample, null, 2), "utf8");
    await writeFile(join(artifactDir, "classification.json"), JSON.stringify({ classification, fetch: fetched }, null, 2), "utf8");
    await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8");

    const live = await loadPhase63LiveRequest(target.phase63Path);
    if (live !== null) {
      comparisons.push(
        buildPhase63Comparison({
          phase63LiveUrl: live.url,
          phase64CorrectedUrl: requestUrl,
          positiveCountPhase63: live.positiveCount,
          positiveCountPhase64: summary?.vacancyPositiveDays.length ?? 0,
          isTaxExclusive: parsed?.isTaxExclusive ?? false,
          chargeType: parsed?.chargeType ?? ""
        })
      );
    }
  }

  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);

  const decision = decideRakutenCorrectedHplan({
    classifications,
    directFetchReachable: directReachable,
    browserFetchReachable: browserReachable,
    anyPriceWithoutBasis
  });
  const csvPath = resolve(REPORT_DIR, `rakuten_corrected_hplan_url_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_corrected_hplan_url_probe_${ts}.md`);
  writeFileSync(csvPath, renderCorrectedHplanCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderCorrectedHplanReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      rows,
      decision,
      executionNote: `completed corrected hplan URL probe; reconstructed_endpoint_requests=${requestCount}`,
      comparison: comparisons[0] ?? null
    }),
    "utf8"
  );
  await writeFile(
    join(debugRootPath, "phase63_live_vs_phase64_corrected_comparison.json"),
    JSON.stringify({ comparisons, request_count_phase64: requestCount }, null, 2),
    "utf8"
  );

  return { rows, reportPath, csvPath, debugRootPath, decision, requestCount };
}

function riskNoteFor(parsed: HplanCalendarParsed | null, classification: CorrectedHplanClassification): string {
  if (parsed === null) return "JSONP response could not be parsed.";
  if (classification === "corrected_hplan_response_positive") return "Vacancy-positive JSONP response reproduced.";
  if (classification === "corrected_hplan_response_all_full") return "Reachable JSONP response, but no vacant priced linked days.";
  if (classification === "corrected_hplan_response_empty") return "Reachable response was empty.";
  if (classification === "corrected_hplan_http_400") return "Endpoint returned HTTP 400.";
  if (classification === "corrected_hplan_basis_unclear") return "Response reached but basis could not be confirmed.";
  return "Unexpected response state.";
}

runRakutenCorrectedHplanUrlProbe()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`debug_root=${result.debugRootPath}`);
    console.log(`request_count=${result.requestCount}`);
    console.log(`classification_counts=${JSON.stringify(countBy(result.rows.map((r) => r.classification)))}`);
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

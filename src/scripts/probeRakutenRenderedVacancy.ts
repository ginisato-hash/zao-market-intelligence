import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import {
  buildRakutenHotelUrl,
  classifyRakutenRenderedProbe,
  decideRakutenRenderedFeasibility,
  detectRakutenRenderedPriceBasis,
  renderRakutenRenderedCsv,
  renderRakutenRenderedReport,
  type RakutenRenderedClassification,
  type RakutenRenderedProbeRow,
  type RakutenRenderedSignals
} from "../services/rakutenRenderedProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-rendered-probe";

const VALIDATION_CSV_PATH = ".data/reports/source-discovery/rakuten_coverage_validation_20260601_075605.csv";
const PRIOR_FEASIBILITY_REPORT_PATH =
  ".data/reports/source-discovery/rakuten_collector_feasibility_20260601_085203.md";

// ─── Hard caps (feasibility only) ────────────────────────────────────────────
const MAX_PROPERTIES = 4;
const MAX_DATES = 2;
const MAX_PROBE_ROWS = 8;

const PROBE_PROPERTIES = [
  { canonicalPropertyName: "蔵王国際ホテル", hotelNo: "5723" },
  { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" },
  { canonicalPropertyName: "YuiLocalZao", hotelNo: "198027" },
  { canonicalPropertyName: "ユニテ蔵王ジョーニダ・リゾート", hotelNo: "187977" }
].slice(0, MAX_PROPERTIES);

const PROBE_DATES = ["2026-08-10", "2026-10-10"].slice(0, MAX_DATES);

const NIGHTS = 1;
const ROOMS = 1;
const ADULTS = 2;

// ─── Rendered access / state detection patterns ──────────────────────────────
const CAPTCHA_PATTERN = /(captcha|recaptcha|ロボットではありません)/iu;
const BLOCK_PATTERN = /(アクセスが集中|不正なアクセス|invalid access|access denied|forbidden|403)/iu;
const LOGIN_PATTERN = /(ログインしてください|サインインが必要|please log ?in|sign ?in required)/iu;
const NOT_FOUND_PATTERN = /(404 not found|指定されたページが見つかりません|ページが見つかりません)/iu;
const NO_PLANS_PATTERN = /(プランがありません|該当するプランがありません|条件に合う.*(?:プラン|宿).*(?:ありません|見つかりません)|空室がありません)/u;
const SOLD_OUT_PATTERN = /(満室|空室なし|予約受付を終了)/u;

interface RenderedObservation {
  reachable: boolean;
  finalUrl: string;
  renderedHotelName: string;
  bodyText: string;
  dateReflected: boolean;
  conditionsSet: { checkin: boolean; rooms: boolean; adults: boolean };
  errorReason?: string;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function checkoutDate(stayDate: string): string {
  const d = new Date(`${stayDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + NIGHTS);
  return d.toISOString().slice(0, 10);
}

function detectDateScope(text: string, finalUrl: string, stayDate: string): boolean {
  const parts = stayDate.split("-");
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const jp = `${year}年${Number(month)}月${Number(day)}日`;
  if (text.includes(stayDate) || text.includes(jp)) {
    return true;
  }
  try {
    const params = new URL(finalUrl).searchParams;
    const slash = `${year}/${month}/${day}`;
    return (
      params.get("f_checkin_date") === slash ||
      params.get("f_hizuke") === `${year}${month}${day}` ||
      (params.get("f_nen1") === year && params.get("f_tuki1") === month && params.get("f_hi1") === day)
    );
  } catch {
    return false;
  }
}

function buildSignals(obs: RenderedObservation, stayDate: string): RakutenRenderedSignals {
  if (!obs.reachable) {
    return {
      reachable: false,
      accessIssue: true,
      noPlans: false,
      soldOut: false,
      dateScopeDetected: false,
      priceBasis: "none"
    };
  }
  const text = obs.bodyText;
  const accessIssue =
    CAPTCHA_PATTERN.test(text) ||
    BLOCK_PATTERN.test(text) ||
    LOGIN_PATTERN.test(text) ||
    NOT_FOUND_PATTERN.test(text);
  const noPlans = NO_PLANS_PATTERN.test(text);
  const soldOut = SOLD_OUT_PATTERN.test(text);
  const dateScopeDetected = detectDateScope(text, obs.finalUrl, stayDate);
  const priceBasis = detectRakutenRenderedPriceBasis(text).basis;
  return { reachable: true, accessIssue, noPlans, soldOut, dateScopeDetected, priceBasis };
}

const AVAILABLE_PATTERN = /(予約する|空室あり|残り[0-9０-９]+室|あと[0-9０-９]+室)/u;

function availabilityLabel(signals: RakutenRenderedSignals, text: string): string {
  if (!signals.reachable) return "unreachable";
  if (signals.accessIssue) return "access_blocked";
  if (signals.soldOut) return "sold_out";
  if (signals.noPlans) return "no_plans";
  if (AVAILABLE_PATTERN.test(text)) return "available";
  return "unknown";
}

async function fillConditions(
  page: Page,
  stayDate: string
): Promise<{ checkin: boolean; rooms: boolean; adults: boolean }> {
  const [year, month, day] = stayDate.split("-");
  const [outYear, outMonth, outDay] = checkoutDate(stayDate).split("-");

  const selectIfPresent = async (selector: string, value: string): Promise<boolean> => {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      return false;
    }
    let ok = true;
    await locator.selectOption(value).catch(async () => {
      await locator.fill(value).catch(() => {
        ok = false;
      });
    });
    return ok;
  };

  const checkinYear = await selectIfPresent("select[name=f_nen1]", year ?? "");
  const checkinMonth = await selectIfPresent("select[name=f_tuki1]", String(Number(month)));
  const checkinDay = await selectIfPresent("select[name=f_hi1]", String(Number(day)));
  await selectIfPresent("select[name=f_nen2]", outYear ?? "");
  await selectIfPresent("select[name=f_tuki2]", String(Number(outMonth)));
  await selectIfPresent("select[name=f_hi2]", String(Number(outDay)));
  const adults = await selectIfPresent("select[name=f_otona_su]", String(ADULTS));
  const rooms = await selectIfPresent("select[name=f_heya_su]", String(ROOMS));

  return { checkin: checkinYear && checkinMonth && checkinDay, rooms, adults };
}

async function probeOne(
  browser: Browser,
  property: { canonicalPropertyName: string; hotelNo: string },
  stayDate: string,
  artifactDir: string,
  timeoutMs: number
): Promise<RenderedObservation> {
  const url = buildRakutenHotelUrl(property.hotelNo);
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (compatible; zao-market-intelligence-feasibility/0.1; low-volume manual verification)"
  });
  page.setDefaultTimeout(timeoutMs);

  const obs: RenderedObservation = {
    reachable: false,
    finalUrl: url,
    renderedHotelName: "",
    bodyText: "",
    dateReflected: false,
    conditionsSet: { checkin: false, rooms: false, adults: false }
  };

  try {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForTimeout(3_000);

    const conditionsSet = await fillConditions(page, stayDate).catch(() => ({
      checkin: false,
      rooms: false,
      adults: false
    }));

    const searchButton = page.locator('button:has-text("検索"), #dh-submit, input[type=submit]').first();
    if ((await searchButton.count()) > 0) {
      await searchButton.click({ timeout: timeoutMs }).catch(() => undefined);
      await page.waitForTimeout(5_000);
    }

    const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const renderedHotelName = (await page.title().catch(() => "")).replace(/\s*宿泊予約.*$/u, "").trim();
    const finalUrl = page.url();

    obs.reachable = true;
    obs.finalUrl = finalUrl;
    obs.renderedHotelName = renderedHotelName;
    obs.bodyText = bodyText;
    obs.conditionsSet = conditionsSet;
    obs.dateReflected = detectDateScope(bodyText, finalUrl, stayDate);

    // Save per-probe debug artifacts (text + DOM excerpt + screenshot best-effort).
    await writeFile(join(artifactDir, "page_text.txt"), bodyText.slice(0, 20_000), "utf8");
    const domExcerpt = await page.content().catch(() => "");
    if (domExcerpt) {
      await writeFile(join(artifactDir, "rendered_dom_excerpt.html"), domExcerpt.slice(0, 40_000), "utf8");
    }
    await page.screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: false }).catch(() => undefined);
  } catch (error) {
    obs.errorReason = error instanceof Error ? error.message : String(error);
  } finally {
    await page.close().catch(() => undefined);
  }

  return obs;
}

export interface RakutenRenderedProbeResult {
  rows: RakutenRenderedProbeRow[];
  decision: ReturnType<typeof decideRakutenRenderedFeasibility>;
  executionNote: string;
  csvPath: string;
  reportPath: string;
  debugRootPath: string;
}

export async function runRakutenRenderedVacancyProbe(options: { timeoutMs?: number } = {}): Promise<RakutenRenderedProbeResult> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const ts = timestamp();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const csvPath = resolve(REPORT_DIR, `rakuten_rendered_vacancy_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_rendered_vacancy_probe_${ts}.md`);

  const targets: { property: { canonicalPropertyName: string; hotelNo: string }; stayDate: string }[] = [];
  for (const property of PROBE_PROPERTIES) {
    for (const stayDate of PROBE_DATES) {
      if (targets.length >= MAX_PROBE_ROWS) break;
      targets.push({ property, stayDate });
    }
  }

  const rows: RakutenRenderedProbeRow[] = [];
  let executionNote = "completed rendered probe";
  let browser: Browser | null = null;

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  for (const target of targets) {
    const artifactDir = join(
      debugRootPath,
      `${target.property.hotelNo}_${target.stayDate}`
    );
    await mkdir(artifactDir, { recursive: true });
    const url = buildRakutenHotelUrl(target.property.hotelNo);

    let obs: RenderedObservation;
    if (browser === null) {
      obs = {
        reachable: false,
        finalUrl: url,
        renderedHotelName: "",
        bodyText: "",
        dateReflected: false,
        conditionsSet: { checkin: false, rooms: false, adults: false },
        errorReason: executionNote
      };
    } else {
      obs = await probeOne(browser, target.property, target.stayDate, artifactDir, timeoutMs);
    }

    const signals = buildSignals(obs, target.stayDate);
    const classification: RakutenRenderedClassification = classifyRakutenRenderedProbe(signals);
    const detection = obs.reachable ? detectRakutenRenderedPriceBasis(obs.bodyText) : { basis: "none" as const };

    const summary = {
      canonicalPropertyName: target.property.canonicalPropertyName,
      hotelNo: target.property.hotelNo,
      stayDate: target.stayDate,
      urlTested: url,
      finalUrl: obs.finalUrl,
      reachable: obs.reachable,
      renderedHotelName: obs.renderedHotelName,
      conditionsSet: obs.conditionsSet,
      dateScopeDetected: signals.dateScopeDetected,
      priceDetection: detection,
      signals,
      classification,
      errorReason: obs.errorReason ?? null
    };
    await writeFile(
      join(artifactDir, "property_date_summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8"
    );

    rows.push({
      canonicalPropertyName: target.property.canonicalPropertyName,
      hotelNo: target.property.hotelNo,
      stayDate: target.stayDate,
      urlTested: url,
      reachable: obs.reachable,
      renderedHotelName: obs.renderedHotelName,
      dateScopeDetected: signals.dateScopeDetected,
      roomCountDetected: obs.conditionsSet.rooms ? String(ROOMS) : "",
      adultCountDetected: obs.conditionsSet.adults ? String(ADULTS) : "",
      nightCountDetected: obs.conditionsSet.checkin ? String(NIGHTS) : "",
      taxIncludedTotalDetected:
        detection.basis === "total_tax_included" ? detection.taxIncludedTotalText ?? "" : "",
      perPersonPriceDetected:
        detection.basis === "per_person_only" ? detection.perPersonText ?? "" : "",
      availabilityStatus: availabilityLabel(signals, obs.bodyText),
      classification,
      riskNote: obs.errorReason
        ? `rendered probe issue: ${obs.errorReason}`
        : riskNoteFor(classification),
      debugArtifactPath: artifactDir
    });
  }

  if (browser !== null) {
    await browser.close().catch(() => undefined);
  }

  const decision = decideRakutenRenderedFeasibility(rows.map((r) => r.classification));
  const csv = renderRakutenRenderedCsv(rows);
  const report = renderRakutenRenderedReport({
    generatedAt: new Date().toISOString(),
    feasibilityCsvPath: csvPath,
    validationCsvPath: VALIDATION_CSV_PATH,
    priorFeasibilityReportPath: PRIOR_FEASIBILITY_REPORT_PATH,
    debugRootPath,
    rows,
    decision,
    executionNote
  });

  writeFileSync(csvPath, csv, "utf8");
  writeFileSync(reportPath, report, "utf8");

  return { rows, decision, executionNote, csvPath, reportPath, debugRootPath };
}

function riskNoteFor(classification: RakutenRenderedClassification): string {
  switch (classification) {
    case "rendered_date_scoped_total_found":
      return "Date-scoped 2-adult/1-room/1-night tax-included total found in rendered DOM; human must confirm selectors before any collector is wired.";
    case "rendered_per_person_only":
      return "Rendered DOM exposed only a per-person figure, not a per-room total; not safe as a price basis.";
    case "rendered_no_plans":
      return "Rendered page clearly reported no plans for this scope; not a failure.";
    case "rendered_sold_out":
      return "Rendered page reported sold-out/満室 for this date.";
    case "date_scope_unverified":
      return "Could not confirm the requested stay date was applied in the rendered DOM/URL.";
    case "basis_unverified":
      return "Page rendered but no clear total or per-person price basis was detected.";
    case "blocked_or_failed":
      return "Rendered probe did not complete (browser unavailable, access blocked, or load failure).";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenRenderedVacancyProbe();
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`probe_rows=${result.rows.length}`);
  console.log(`execution_note=${result.executionNote}`);
  console.log(`feasibility_decision=${result.decision}`);
}

if (process.argv[1]?.endsWith("probeRakutenRenderedVacancy.ts")) {
  void main();
}

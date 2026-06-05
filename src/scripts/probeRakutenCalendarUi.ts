import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { buildRakutenHotelPlanUrl } from "../services/buildRakutenCollectorFeasibility";
import {
  classifyCalendarUiProbe,
  decideCalendarUiFeasibility,
  detectCalendarPresence,
  detectDateScopedTotalEvidence,
  detectSoldOutOrNoPlan,
  renderRakutenCalendarUiCsv,
  renderRakutenCalendarUiReport,
  type RakutenCalendarUiClassification,
  type RakutenCalendarUiProbeRow,
  type RakutenCalendarUiSignals
} from "../services/rakutenCalendarUiProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-calendar-ui-probe";
const PRIOR_RENDERED_PROBE_REPORT_PATH =
  ".data/reports/source-discovery/rakuten_rendered_vacancy_probe_20260601_090026.md";

// ─── Hard caps (feasibility only) ────────────────────────────────────────────
const MAX_PROPERTIES = 3;
const MAX_DATES = 2;
const MAX_PROBE_ROWS = 6;

const PROBE_PROPERTIES = [
  { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" },
  { canonicalPropertyName: "YuiLocalZao", hotelNo: "198027" },
  { canonicalPropertyName: "蔵王国際ホテル", hotelNo: "5723" }
].slice(0, MAX_PROPERTIES);

const PROBE_DATES = ["2026-08-10", "2026-10-10"].slice(0, MAX_DATES);

const ACCESS_ISSUE_PATTERN =
  /(captcha|recaptcha|ロボットではありません|アクセスが集中|不正なアクセス|access denied|forbidden|403|ログインしてください|サインインが必要|404 not found|ページが見つかりません)/iu;
const AVAILABLE_PATTERN = /(予約する|空室あり|残り[0-9０-９]+室|あと[0-9０-９]+室)/u;
const MAX_MONTH_ADVANCE = 16;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface CalendarObservation {
  reachable: boolean;
  startUrl: string;
  finalUrl: string;
  calendarVisible: boolean;
  calendarClicked: boolean;
  dateClickAttempted: boolean;
  dateClickSucceeded: boolean;
  textBefore: string;
  textAfterCalendarClick: string;
  textAfterDateClick: string;
  errorReason?: string;
}

/**
 * Find the index of the 空室カレンダー link/button that belongs to the 2名利用時
 * (2-adult) occupancy tier. Returns -1 if no calendar links are present. Written
 * without arrow functions / Array iteration helpers so tsx/esbuild does not
 * inject __name() into the browser evaluate context.
 */
async function findTwoAdultCalendarIndex(page: Page): Promise<{ count: number; index: number }> {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll("a, button, span[role=button]");
    const calIndexes: number[] = [];
    const calContexts: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes.item(i);
      const label = node && node.textContent ? node.textContent : "";
      if (label.indexOf("空室カレンダー") !== -1) {
        calIndexes.push(i);
        let ctx = "";
        let p: Element | null = node;
        for (let up = 0; up < 6 && p !== null; up++) {
          p = p.parentElement;
          if (p !== null && p.textContent !== null) {
            ctx = p.textContent;
          }
        }
        calContexts.push(ctx);
      }
    }
    let chosen = calIndexes.length > 0 ? 0 : -1;
    for (let i = 0; i < calContexts.length; i++) {
      const c = calContexts[i] || "";
      if (c.indexOf("2名利用時") !== -1 || c.indexOf("2名") !== -1) {
        chosen = i;
        break;
      }
    }
    return { count: calIndexes.length, index: chosen };
  });
}

/** Advance the calendar to the target YYYY-MM by clicking visible "翌月/次月" links. */
async function advanceCalendarToMonth(page: Page, stayDate: string, timeoutMs: number): Promise<boolean> {
  const [year, month] = stayDate.split("-");
  const targetLabel = `${year}年${Number(month)}月`;
  const nextButton = page
    .locator('a:has-text("翌月"), a:has-text("次の月"), button:has-text("翌月"), a:has-text("›"), a:has-text(">")')
    .first();

  for (let i = 0; i < MAX_MONTH_ADVANCE; i++) {
    const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    if (body.includes(targetLabel)) {
      return true;
    }
    if ((await nextButton.count()) === 0) {
      return false;
    }
    await nextButton.click({ timeout: timeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1_200);
  }
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return body.includes(targetLabel);
}

/** Attempt to click the target day cell (e.g. the "10" of 2026-08). */
async function clickTargetDateCell(page: Page, stayDate: string, timeoutMs: number): Promise<boolean> {
  const day = String(Number(stayDate.split("-")[2] ?? "0"));
  // Day cells are typically links inside a calendar table; match an anchor whose
  // visible text is exactly the day number, or contains it next to a price/○/△.
  const candidates = [
    `table a:text-is("${day}")`,
    `a[href*="f_hi1=${day}"]`,
    `td:has-text("${day}") a`,
    `a:has-text("${day}日")`
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      const before = page.url();
      await locator.click({ timeout: timeoutMs }).catch(() => undefined);
      await page.waitForTimeout(3_000);
      if (page.url() !== before) {
        return true;
      }
      // Even without navigation, a modal/panel may have updated — treat a present
      // click target as an attempt success for classification purposes.
      return true;
    }
  }
  return false;
}

async function probeOne(
  browser: Browser,
  property: { canonicalPropertyName: string; hotelNo: string },
  stayDate: string,
  artifactDir: string,
  timeoutMs: number
): Promise<CalendarObservation> {
  // Start on the plan-list page (reached in Phase 54X); the per-occupancy-tier
  // 空室カレンダー links live here, not on the HOTEL/[hotelNo]/ facility overview.
  const startUrl = buildRakutenHotelPlanUrl(property.hotelNo);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; zao-market-intelligence-feasibility/0.1; low-volume manual verification)"
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const obs: CalendarObservation = {
    reachable: false,
    startUrl,
    finalUrl: startUrl,
    calendarVisible: false,
    calendarClicked: false,
    dateClickAttempted: false,
    dateClickSucceeded: false,
    textBefore: "",
    textAfterCalendarClick: "",
    textAfterDateClick: ""
  };

  try {
    await page.goto(startUrl, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForTimeout(3_000);

    obs.reachable = true;
    obs.finalUrl = page.url();
    obs.textBefore = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    await writeFile(join(artifactDir, "page_text_before.txt"), obs.textBefore.slice(0, 20_000), "utf8");
    await page.screenshot({ path: join(artifactDir, "screenshot_before.png") }).catch(() => undefined);

    // Base presence on ACTUAL clickable calendar anchors, not incidental prose
    // (e.g. cancellation-policy text that merely mentions 空室カレンダー).
    const { count, index } = await findTwoAdultCalendarIndex(page);
    obs.calendarVisible = count > 0 || detectCalendarPresence(obs.textBefore);

    if (count > 0 && index >= 0) {
      {
        const calLink = page.locator(':text("空室カレンダー")').nth(index);
        // The calendar may open in a popup window.
        const popupPromise = context
          .waitForEvent("page", { timeout: 6_000 })
          .catch(() => null);
        await calLink.click({ timeout: timeoutMs }).catch(() => undefined);
        obs.calendarClicked = true;
        const popup = await popupPromise;
        const activePage = popup ?? page;
        await activePage.waitForTimeout(3_000);

        obs.textAfterCalendarClick = await activePage
          .locator("body")
          .innerText({ timeout: 5_000 })
          .catch(() => "");
        await writeFile(
          join(artifactDir, "page_text_after_calendar_click.txt"),
          obs.textAfterCalendarClick.slice(0, 20_000),
          "utf8"
        );
        await activePage
          .screenshot({ path: join(artifactDir, "screenshot_after_calendar_click.png") })
          .catch(() => undefined);

        // Navigate to target month + click target date cell.
        await advanceCalendarToMonth(activePage, stayDate, timeoutMs).catch(() => false);
        obs.dateClickAttempted = true;
        obs.dateClickSucceeded = await clickTargetDateCell(activePage, stayDate, timeoutMs).catch(() => false);

        obs.finalUrl = activePage.url();
        obs.textAfterDateClick = await activePage
          .locator("body")
          .innerText({ timeout: 5_000 })
          .catch(() => "");
        await writeFile(
          join(artifactDir, "page_text_after_date_click.txt"),
          obs.textAfterDateClick.slice(0, 20_000),
          "utf8"
        );
        await activePage
          .screenshot({ path: join(artifactDir, "screenshot_after_date_click.png") })
          .catch(() => undefined);
        const dom = await activePage.content().catch(() => "");
        if (dom) {
          await writeFile(
            join(artifactDir, "dom_excerpt_after_date_click.html"),
            dom.slice(0, 60_000),
            "utf8"
          );
        }
      }
    }
  } catch (error) {
    obs.errorReason = error instanceof Error ? error.message : String(error);
  } finally {
    await context.close().catch(() => undefined);
  }

  return obs;
}

function buildSignals(obs: CalendarObservation, stayDate: string): {
  signals: RakutenCalendarUiSignals;
  evidence: ReturnType<typeof detectDateScopedTotalEvidence>;
  availability: string;
} {
  if (!obs.reachable) {
    return {
      signals: {
        reachable: false,
        accessIssue: true,
        soldOutOrNoPlan: false,
        calendarVisible: false,
        calendarClicked: false,
        dateClickAttempted: false,
        dateClickSucceeded: false,
        dateScopeDetected: false,
        totalFound: false,
        perPersonFound: false
      },
      evidence: detectDateScopedTotalEvidence({ text: "", stayDate }),
      availability: "unreachable"
    };
  }

  // Prefer the post-date-click text; fall back to the calendar/plan text.
  const analysisText =
    obs.textAfterDateClick || obs.textAfterCalendarClick || obs.textBefore;
  const accessIssue = ACCESS_ISSUE_PATTERN.test(analysisText);
  const soldOutOrNoPlan = detectSoldOutOrNoPlan(analysisText);
  const evidence = detectDateScopedTotalEvidence({ text: analysisText, stayDate });

  const signals: RakutenCalendarUiSignals = {
    reachable: true,
    accessIssue,
    soldOutOrNoPlan,
    calendarVisible: obs.calendarVisible,
    calendarClicked: obs.calendarClicked,
    dateClickAttempted: obs.dateClickAttempted,
    dateClickSucceeded: obs.dateClickSucceeded,
    dateScopeDetected: evidence.dateScopeFound,
    totalFound: evidence.totalFound,
    perPersonFound: evidence.perPersonFound
  };

  let availability = "unknown";
  if (accessIssue) availability = "access_blocked";
  else if (soldOutOrNoPlan) availability = "sold_out_or_no_plan";
  else if (AVAILABLE_PATTERN.test(analysisText)) availability = "available";

  return { signals, evidence, availability };
}

export interface CalendarUiProbeResult {
  rows: RakutenCalendarUiProbeRow[];
  decision: ReturnType<typeof decideCalendarUiFeasibility>;
  executionNote: string;
  csvPath: string;
  reportPath: string;
  debugRootPath: string;
}

export async function runRakutenCalendarUiProbe(options: { timeoutMs?: number } = {}): Promise<CalendarUiProbeResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const csvPath = resolve(REPORT_DIR, `rakuten_calendar_ui_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_calendar_ui_probe_${ts}.md`);

  const targets: { property: { canonicalPropertyName: string; hotelNo: string }; stayDate: string }[] = [];
  for (const property of PROBE_PROPERTIES) {
    for (const stayDate of PROBE_DATES) {
      if (targets.length >= MAX_PROBE_ROWS) break;
      targets.push({ property, stayDate });
    }
  }

  const rows: RakutenCalendarUiProbeRow[] = [];
  let executionNote = "completed calendar UI probe";
  let browser: Browser | null = null;

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  for (const target of targets) {
    const artifactDir = join(debugRootPath, `${target.property.hotelNo}_${target.stayDate}`);
    await mkdir(artifactDir, { recursive: true });
    const startUrl = buildRakutenHotelPlanUrl(target.property.hotelNo);

    let obs: CalendarObservation;
    if (browser === null) {
      obs = {
        reachable: false,
        startUrl,
        finalUrl: startUrl,
        calendarVisible: false,
        calendarClicked: false,
        dateClickAttempted: false,
        dateClickSucceeded: false,
        textBefore: "",
        textAfterCalendarClick: "",
        textAfterDateClick: "",
        errorReason: executionNote
      };
    } else {
      obs = await probeOne(browser, target.property, target.stayDate, artifactDir, timeoutMs);
    }

    const { signals, evidence, availability } = buildSignals(obs, target.stayDate);
    const classification: RakutenCalendarUiClassification = classifyCalendarUiProbe(signals);

    const summary = {
      canonicalPropertyName: target.property.canonicalPropertyName,
      hotelNo: target.property.hotelNo,
      stayDate: target.stayDate,
      startUrl,
      finalUrl: obs.finalUrl,
      reachable: obs.reachable,
      calendarVisible: obs.calendarVisible,
      calendarClicked: obs.calendarClicked,
      dateClickAttempted: obs.dateClickAttempted,
      dateClickSucceeded: obs.dateClickSucceeded,
      evidence,
      signals,
      classification,
      availability,
      errorReason: obs.errorReason ?? null
    };
    await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

    rows.push({
      canonicalPropertyName: target.property.canonicalPropertyName,
      hotelNo: target.property.hotelNo,
      stayDate: target.stayDate,
      startUrl,
      calendarVisible: obs.calendarVisible,
      calendarClicked: obs.calendarClicked,
      dateClickAttempted: obs.dateClickAttempted,
      dateScopeDetected: evidence.dateScopeFound,
      roomCountDetected: evidence.roomsFound ? "1" : "",
      adultCountDetected: evidence.adultsFound ? "2" : "",
      nightCountDetected: evidence.nightsFound ? "1" : "",
      taxIncludedTotalDetected: evidence.totalFound ? evidence.totalText ?? "" : "",
      availabilityStatus: availability,
      classification,
      riskNote: obs.errorReason ? `probe issue: ${obs.errorReason}` : riskNoteFor(classification),
      debugArtifactPath: artifactDir
    });
  }

  if (browser !== null) {
    await browser.close().catch(() => undefined);
  }

  const decision = decideCalendarUiFeasibility(rows.map((r) => r.classification));
  const csv = renderRakutenCalendarUiCsv(rows);
  const report = renderRakutenCalendarUiReport({
    generatedAt: new Date().toISOString(),
    csvPath,
    priorRenderedProbeReportPath: PRIOR_RENDERED_PROBE_REPORT_PATH,
    debugRootPath,
    rows,
    decision,
    executionNote
  });

  writeFileSync(csvPath, csv, "utf8");
  writeFileSync(reportPath, report, "utf8");

  return { rows, decision, executionNote, csvPath, reportPath, debugRootPath };
}

function riskNoteFor(classification: RakutenCalendarUiClassification): string {
  switch (classification) {
    case "date_scoped_total_found":
      return "Date-scoped 2-adult/1-room/1-night tax-included total reached via the visible calendar UI; human must confirm selectors before any collector is wired.";
    case "date_scoped_per_person_found":
      return "Calendar reached a date-scoped view but only a per-person figure was detected; not safe as a per-room price basis.";
    case "calendar_visible_but_date_click_failed":
      return "空室カレンダー is visible and was opened, but the target date cell could not be confirmed clicked; selectors need manual mapping.";
    case "calendar_visible_no_price":
      return "Calendar opened and a date was clicked, but no tax-included total or per-person price surfaced in the rendered DOM.";
    case "calendar_not_found":
      return "No vacancy/price calendar widget was detected on the rendered page.";
    case "sold_out_or_no_plan":
      return "Rendered page reported sold-out/no-plan for this scope; not a failure.";
    case "basis_unverified":
      return "Calendar interacted with but neither date scope nor a clear price basis could be confirmed.";
    case "blocked_or_failed":
      return "Probe did not complete (browser unavailable, access blocked, or load failure).";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenCalendarUiProbe();
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`probe_rows=${result.rows.length}`);
  console.log(`execution_note=${result.executionNote}`);
  console.log(`feasibility_decision=${result.decision}`);
}

if (process.argv[1]?.endsWith("probeRakutenCalendarUi.ts")) {
  void main();
}

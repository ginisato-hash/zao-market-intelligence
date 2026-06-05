import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import {
  buildAbsoluteRakutenConditionUrl,
  selectFirstAvailableDay
} from "../services/rakutenConditionLinkBasisProbe";
import {
  parseHplanCalendarResponse,
  type HplanCalendarParsed,
  type HplanDay
} from "../services/rakutenCorrectedHplanUrlProbe";
import {
  classifyButtonSafety,
  classifyConditionFlowStep,
  compareFlowBasis,
  decideConditionFlow,
  extractAvailabilitySignals,
  extractDateSignals,
  extractNightSignals,
  extractPeopleSignals,
  extractRoomSignals,
  extractTaxSignals,
  extractYenPriceCandidates,
  renderConditionFlowCsv,
  renderConditionFlowReport,
  sanitizeFlowUrl,
  type BasisComparison,
  type ButtonSummary,
  type ConditionFlowRow,
  type ConditionFlowStep,
  type FormSummary,
  type InputSummary,
  type LinkSummary,
  type NetworkRequestSummary,
  type RakutenConditionFlowPageClassification
} from "../services/rakutenConditionFlowInspectionProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-condition-flow-inspection";
const PHASE64_PRIMARY_DEBUG = ".data/debug/rakuten-corrected-hplan-url/20260601_202308/5723_00_20260601";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-condition-flow-inspection/0.1; read-only feasibility)";

const SOURCE_CONTEXT = {
  canonicalPropertyName: "蔵王国際ホテル",
  hotelNo: "5723",
  fSyu: "00",
  fCampId: "6468227",
  selectedDate: "2026-06-03",
  adultCount: 2,
  roomCount: 1,
  nights: 1,
  expectedTwoAdultTotal: 64790
};

interface RawPageInspection {
  forms: FormSummary[];
  inputs: InputSummary[];
  buttonsRaw: { index: number; text: string; type: string; name: string; value: string; context: string }[];
  linksRaw: { text: string; href: string; context: string }[];
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

async function inspectCurrentPage(input: {
  page: Page;
  stepIndex: number;
  stepName: string;
  debugRootPath: string;
  networkRequests: NetworkRequestSummary[];
  selectedDay: HplanDay;
  transitionAttempted: boolean;
}): Promise<{ step: ConditionFlowStep; comparison: BasisComparison; rowClassification: RakutenConditionFlowPageClassification }> {
  const stepPrefix = `step_${input.stepIndex}`;
  const htmlPath = join(input.debugRootPath, `${stepPrefix}_html.html`);
  const textPath = join(input.debugRootPath, `${stepPrefix}_visible_text.txt`);
  const screenshotPath = join(input.debugRootPath, `${stepPrefix}_screenshot.png`);
  const formsPath = join(input.debugRootPath, `${stepPrefix}_forms.json`);
  const inputsPath = join(input.debugRootPath, `${stepPrefix}_inputs.json`);
  const buttonsPath = join(input.debugRootPath, `${stepPrefix}_buttons.json`);
  const linksPath = join(input.debugRootPath, `${stepPrefix}_links.json`);
  const networkPath = join(input.debugRootPath, `${stepPrefix}_network_requests.json`);
  const pricesPath = join(input.debugRootPath, `${stepPrefix}_price_candidates.json`);
  const classificationPath = join(input.debugRootPath, `${stepPrefix}_classification.json`);

  const html = await input.page.content().catch(() => "");
  const visibleText = await input.page.locator("body").innerText({ timeout: 5_000 }).catch(() => htmlToText(html));
  const title = await input.page.title().catch(() => "");
  await writeFile(htmlPath, html.slice(0, 250_000), "utf8");
  await writeFile(textPath, visibleText.slice(0, 120_000), "utf8");
  await input.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

  const raw = await extractRawPageInspection(input.page);
  const forms = raw.forms.map((f) => ({
    ...f,
    action: sanitizeFlowUrl(f.action),
    unsafeContext: classifyButtonSafety(f.textExcerpt, f.textExcerpt).safety === "unsafe"
  }));
  const buttons: ButtonSummary[] = raw.buttonsRaw.map((b) => {
    const safety = classifyButtonSafety(b.text || b.value || b.name, b.context);
    return { ...b, safety: safety.safety, reason: safety.reason };
  });
  const links: LinkSummary[] = raw.linksRaw.map((l) => {
    const safety = classifyButtonSafety(l.text, l.context);
    return {
      text: l.text,
      hrefSanitized: sanitizeFlowUrl(l.href),
      safety: safety.safety,
      reason: safety.reason
    };
  });
  const priceCandidates = extractYenPriceCandidates(visibleText);
  const comparison = compareFlowBasis({
    day: input.selectedDay,
    text: visibleText,
    adultCount: SOURCE_CONTEXT.adultCount,
    priceCandidates
  });
  const classification = classifyConditionFlowStep({
    priceCandidates,
    comparison,
    buttons,
    networkRequests: input.networkRequests,
    transitionAttempted: input.transitionAttempted,
    renderedBlocked: /captcha|アクセスが集中|ロボット|bot|blocked/iu.test(visibleText)
  });

  await writeFile(formsPath, JSON.stringify(forms, null, 2), "utf8");
  await writeFile(inputsPath, JSON.stringify(raw.inputs, null, 2), "utf8");
  await writeFile(buttonsPath, JSON.stringify(buttons, null, 2), "utf8");
  await writeFile(linksPath, JSON.stringify(links, null, 2), "utf8");
  await writeFile(networkPath, JSON.stringify(input.networkRequests, null, 2), "utf8");
  await writeFile(pricesPath, JSON.stringify(priceCandidates, null, 2), "utf8");
  await writeFile(classificationPath, JSON.stringify({ classification }, null, 2), "utf8");

  return {
    comparison,
    rowClassification: classification,
    step: {
      stepIndex: input.stepIndex,
      stepName: input.stepName,
      urlSanitized: sanitizeFlowUrl(input.page.url()),
      title,
      httpStatusOrNavigationStatus: "loaded",
      visibleDateSignals: extractDateSignals(visibleText),
      visiblePeopleSignals: extractPeopleSignals(visibleText),
      visibleRoomSignals: extractRoomSignals(visibleText),
      visibleNightSignals: extractNightSignals(visibleText),
      visiblePriceCandidates: priceCandidates,
      visibleTaxSignals: extractTaxSignals(visibleText),
      visibleAvailabilitySignals: extractAvailabilitySignals(visibleText),
      formsSummary: forms,
      inputsSummary: raw.inputs,
      buttonsSummary: buttons,
      linksSummary: links,
      networkRequestsSummary: input.networkRequests,
      screenshotPath,
      htmlPath,
      visibleTextPath: textPath,
      classification
    }
  };
}

async function extractRawPageInspection(page: Page): Promise<RawPageInspection> {
  return page.evaluate(`(() => {
    const clean = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const pageText = clean(document.body?.textContent ?? "");
    const forms = Array.from(document.querySelectorAll("form")).map((form, index) => ({
      index,
      action: form.action || "",
      method: (form.method || "get").toUpperCase(),
      textExcerpt: (pageText.slice(0, 350) + " " + clean(form.textContent).slice(0, 500)).trim(),
      unsafeContext: false
    }));
    const inputs = Array.from(document.querySelectorAll("input, select, textarea")).map((el) => {
      return {
        name: el.name || "",
        type: el.tagName.toLowerCase() === "select" ? "select" : (el.type || el.tagName.toLowerCase()),
        value: "value" in el ? String(el.value ?? "") : "",
        tagName: el.tagName.toLowerCase()
      };
    });
    const buttonsRaw = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], input[type='image']")).map(
      (el, index) => {
        const form = el.closest("form");
        return {
          index,
          text: clean(el.textContent) || clean(el.getAttribute("alt")) || clean(el.getAttribute("title")),
          type: "type" in el ? String(el.type ?? "") : "",
          name: el.name || "",
          value: "value" in el ? String(el.value ?? "") : "",
          context: (pageText.slice(0, 500) + " " + clean(form?.textContent ?? el.parentElement?.textContent ?? "").slice(0, 800)).trim()
        };
      }
    );
    const linksRaw = Array.from(document.querySelectorAll("a"))
      .slice(0, 100)
      .map((a) => ({
        text: clean(a.textContent),
        href: a.href || "",
        context: clean(a.closest("form")?.textContent ?? a.parentElement?.textContent ?? "").slice(0, 500)
      }));
    return { forms, inputs, buttonsRaw, linksRaw };
  })()`);
}

async function attemptSafeTransition(page: Page, step: ConditionFlowStep): Promise<boolean> {
  const candidate = step.buttonsSummary.find((b) => b.safety === "potentially_safe");
  if (!candidate) return false;
  await page
    .evaluate(`(index) => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], input[type='image']"));
      if (buttons[index]) buttons[index].click();
    }`, candidate.index)
    .catch(() => undefined);
  await page.waitForTimeout(2_000);
  return true;
}

export async function runRakutenConditionFlowInspection(options: { timeoutMs?: number } = {}): Promise<{
  reportPath: string;
  csvPath: string;
  debugRootPath: string;
  rows: ConditionFlowRow[];
  decision: ReturnType<typeof decideConditionFlow>;
  transitionAttempts: number;
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const parsed = await loadPhase64Parsed();
  const selectedDay = selectFirstAvailableDay(parsed);
  if (selectedDay === null) throw new Error("No populated Phase 64X dayList.link found for 5723.");
  const destinationUrl = buildAbsoluteRakutenConditionUrl(selectedDay.link);
  await writeFile(
    join(debugRootPath, "source_context.json"),
    JSON.stringify({ ...SOURCE_CONTEXT, dayListPrice: selectedDay.price, priceWithoutTax: selectedDay.priceWithoutTax }, null, 2),
    "utf8"
  );
  await writeFile(join(debugRootPath, "selected_destination_url_sanitized.txt"), sanitizeFlowUrl(destinationUrl), "utf8");

  const networkRequests: NetworkRequestSummary[] = [];
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.on("request", (request) => {
    networkRequests.push({
      urlSanitized: sanitizeFlowUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      status: 0
    });
  });
  page.on("response", (response) => {
    const entry = [...networkRequests].reverse().find((r) => r.urlSanitized === sanitizeFlowUrl(response.url()) && r.status === 0);
    if (entry) entry.status = response.status();
  });

  const steps: ConditionFlowStep[] = [];
  const rows: ConditionFlowRow[] = [];
  let latestComparison: BasisComparison | null = null;
  let transitionAttempts = 0;

  try {
    await page.goto(destinationUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1_500);
    let inspected = await inspectCurrentPage({
      page,
      stepIndex: 0,
      stepName: "condition_entry",
      debugRootPath,
      networkRequests,
      selectedDay,
      transitionAttempted: false
    });
    steps.push(inspected.step);
    latestComparison = inspected.comparison;

    if (
      inspected.step.buttonsSummary.some((b) => b.safety === "potentially_safe") &&
      !inspected.step.buttonsSummary.some((b) => b.safety === "unsafe")
    ) {
      transitionAttempts += 1;
      const clicked = await attemptSafeTransition(page, inspected.step);
      if (clicked) {
        inspected = await inspectCurrentPage({
          page,
          stepIndex: 1,
          stepName: "safe_transition_1",
          debugRootPath,
          networkRequests,
          selectedDay,
          transitionAttempted: true
        });
        steps.push(inspected.step);
        latestComparison = inspected.comparison;
      }
    }
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const classifications = steps.map((s) => s.classification);
  const decision = decideConditionFlow(classifications);
  for (const step of steps) {
    rows.push({
      stepIndex: step.stepIndex,
      stepName: step.stepName,
      urlSanitized: step.urlSanitized,
      title: step.title,
      dateDetected: step.visibleDateSignals.length > 0,
      peopleDetected: step.visiblePeopleSignals.some((s) => /2|２/u.test(s)),
      roomDetected: step.visibleRoomSignals.some((s) => /1|１/u.test(s)),
      nightDetected: step.visibleNightSignals.some((s) => /1|１|一/u.test(s)),
      priceCandidateCount: step.visiblePriceCandidates.length,
      taxDetected: step.visibleTaxSignals.length > 0,
      safeTransitionCandidateCount: step.buttonsSummary.filter((b) => b.safety === "potentially_safe").length,
      unsafeTransitionCount: step.buttonsSummary.filter((b) => b.safety === "unsafe").length,
      classification: step.classification,
      decision,
      debugArtifactPath: debugRootPath
    });
  }

  await writeFile(join(debugRootPath, "basis_comparison.json"), JSON.stringify(latestComparison, null, 2), "utf8");
  await writeFile(join(debugRootPath, "summary.json"), JSON.stringify({ decision, transitionAttempts, rows }, null, 2), "utf8");

  const csvPath = resolve(REPORT_DIR, `rakuten_condition_flow_inspection_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_condition_flow_inspection_probe_${ts}.md`);
  writeFileSync(csvPath, renderConditionFlowCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderConditionFlowReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      rows,
      steps,
      comparison: latestComparison,
      decision
    }),
    "utf8"
  );
  return { reportPath, csvPath, debugRootPath, rows, decision, transitionAttempts };
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

runRakutenConditionFlowInspection()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`debug_root=${result.debugRootPath}`);
    console.log(`steps_inspected=${result.rows.length}`);
    console.log(`safe_transition_attempts=${result.transitionAttempts}`);
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

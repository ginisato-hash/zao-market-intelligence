import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import {
  buildRakutenHotelPlanUrl,
  extractTwoPersonCalendarHref,
  parseRakutenIframeParams
} from "../services/rakutenIframeProbe";
import {
  buildMatrixVariants,
  classifyRakutenMatrixProbe,
  decideRakutenMatrixFeasibility,
  detectAvailabilityGrid,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  isUsefulMatrixClassification,
  KNOWN_ZAO_BASE_IFRAME_URL,
  renderRakutenMatrixCsv,
  renderRakutenMatrixReport,
  type MatrixVariant,
  type RakutenMatrixProbeRow
} from "../services/rakutenIframeMatrixProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-iframe-matrix-probe";

const PROPERTY = { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" } as const;
const PRIMARY_DATE = "2026-06-15";
const OPTIONAL_DATE = "2026-06-22";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

interface VariantObservation {
  reachable: boolean;
  pageText: string;
  pageDom: string;
  errorReason: string;
}

async function probeVariant(
  browser: Browser | null,
  variant: MatrixVariant,
  artifactDir: string,
  timeoutMs: number
): Promise<VariantObservation> {
  const obs: VariantObservation = { reachable: false, pageText: "", pageDom: "", errorReason: "" };
  await writeFile(join(artifactDir, "generated_url.txt"), variant.generatedUrl, "utf8").catch(() => undefined);

  if (browser === null) {
    obs.errorReason = "browser_launch_failed";
    await writeVariantArtifacts(artifactDir, obs);
    return obs;
  }

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-iframe-matrix-probe/0.1; low-volume feasibility)"
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(variant.generatedUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(3_000);
    obs.reachable = true;
    obs.pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    obs.pageDom = await page.content().catch(() => "");
    await page.screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: true }).catch(() => undefined);
  } catch (error) {
    obs.errorReason = error instanceof Error ? error.message : String(error);
  } finally {
    await context.close().catch(() => undefined);
  }
  await writeVariantArtifacts(artifactDir, obs);
  return obs;
}

async function writeVariantArtifacts(artifactDir: string, obs: VariantObservation): Promise<void> {
  await writeFile(join(artifactDir, "page_text.txt"), obs.pageText.slice(0, 80_000), "utf8").catch(() => undefined);
  await writeFile(join(artifactDir, "dom_excerpt.html"), obs.pageDom.slice(0, 80_000), "utf8").catch(() => undefined);
}

function toRow(
  variant: MatrixVariant,
  obs: VariantObservation,
  artifactDir: string
): RakutenMatrixProbeRow {
  const evidence = detectIframeDateScopedTotalEvidence({
    text: obs.pageText,
    stayDate: variant.stayDate,
    canonicalPropertyName: PROPERTY.canonicalPropertyName
  });
  const noMatchingRoomType = detectNoMatchingRoomType(obs.pageText);
  const availabilityGridDetected = detectAvailabilityGrid(obs.pageText);
  const classification = classifyRakutenMatrixProbe({
    reachable: obs.reachable,
    noMatchingRoomType,
    availabilityGridDetected,
    evidence
  });
  return {
    canonicalPropertyName: PROPERTY.canonicalPropertyName,
    hotelNo: PROPERTY.hotelNo,
    stayDate: variant.stayDate,
    fSyuVariant: variant.fSyuVariant,
    fSyuValue: variant.fSyuValue,
    fHakVariant: variant.fHakVariant,
    fHakValue: variant.fHakValue,
    generatedUrl: variant.generatedUrl,
    reachable: obs.reachable,
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
}

function artifactName(variant: MatrixVariant): string {
  return `${PROPERTY.hotelNo}_${variant.stayDate}_${variant.fSyuVariant}_${variant.fHakVariant}`;
}

export async function runRakutenIframeMatrixProbe(options: { timeoutMs?: number } = {}): Promise<{
  rows: RakutenMatrixProbeRow[];
  decision: ReturnType<typeof decideRakutenMatrixFeasibility>;
  csvPath: string;
  reportPath: string;
  debugRootPath: string;
  executionNote: string;
  liveExtractedHref: string;
  liveSyuValue: string;
}> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ts = timestamp();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  let browser: Browser | null = null;
  let executionNote = "completed rakuten iframe matrix probe";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  // 1. Live f_syu extraction from the current 2名利用時 空室カレンダー href.
  let liveExtractedHref = "";
  let liveSyuValue = "";
  if (browser !== null) {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-iframe-matrix-probe/0.1; low-volume feasibility)"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    try {
      await page.goto(buildRakutenHotelPlanUrl(PROPERTY.hotelNo), {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs
      });
      await page.waitForTimeout(3_000);
      liveExtractedHref = (await extractLiveCalendarHref(page)) ?? "";
      if (liveExtractedHref) {
        liveSyuValue = parseRakutenIframeParams(liveExtractedHref).fSyu ?? "";
      }
    } catch (error) {
      executionNote = `live_extraction_issue: ${error instanceof Error ? error.message : String(error)}`;
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

  // 2. Build the 8-row initial matrix on a fixed structural base URL so the only
  //    deliberate differences across rows are f_syu and f_hak.
  const variants = buildMatrixVariants({
    baseUrl: KNOWN_ZAO_BASE_IFRAME_URL,
    liveSyuValue,
    stayDate: PRIMARY_DATE
  });

  const rows: RakutenMatrixProbeRow[] = [];
  for (const variant of variants) {
    const artifactDir = join(debugRootPath, artifactName(variant));
    await mkdir(artifactDir, { recursive: true });
    const obs = await probeVariant(browser, variant, artifactDir, timeoutMs);
    const row = toRow(variant, obs, artifactDir);
    await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8");
    rows.push(row);
  }

  // 3. Optional: repeat the single best useful variant for one more date.
  const bestUseful = rows.find((row) => isUsefulMatrixClassification(row.classification));
  if (bestUseful) {
    const optionalVariants = buildMatrixVariants({
      baseUrl: KNOWN_ZAO_BASE_IFRAME_URL,
      liveSyuValue,
      stayDate: OPTIONAL_DATE
    }).filter(
      (v) => v.fSyuVariant === bestUseful.fSyuVariant && v.fHakVariant === bestUseful.fHakVariant
    );
    for (const variant of optionalVariants) {
      const artifactDir = join(debugRootPath, artifactName(variant));
      await mkdir(artifactDir, { recursive: true });
      const obs = await probeVariant(browser, variant, artifactDir, timeoutMs);
      const row = toRow(variant, obs, artifactDir);
      await writeFile(join(artifactDir, "summary.json"), JSON.stringify(row, null, 2), "utf8");
      rows.push(row);
    }
  }

  if (browser !== null) {
    await browser.close().catch(() => undefined);
  }

  const decision = decideRakutenMatrixFeasibility(rows.map((row) => row.classification));
  const csvPath = resolve(REPORT_DIR, `rakuten_iframe_matrix_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_iframe_matrix_probe_${ts}.md`);
  writeFileSync(csvPath, renderRakutenMatrixCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderRakutenMatrixReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      liveExtractedHref,
      liveSyuValue,
      rows,
      decision,
      executionNote
    }),
    "utf8"
  );

  return { rows, decision, csvPath, reportPath, debugRootPath, executionNote, liveExtractedHref, liveSyuValue };
}

function riskNoteFor(classification: string): string {
  switch (classification) {
    case "matrix_date_scoped_total_found":
      return "Variant exposed a date-scoped 2-adult/1-room/1-night total; review selectors before DB collection.";
    case "matrix_date_scoped_per_person_found":
      return "Variant exposed date-scoped per-person evidence, but not a safe total.";
    case "matrix_no_plan_or_sold_out":
      return "Variant reached an explicit no-plan/sold-out state.";
    case "matrix_no_matching_room_type":
      return "Variant returned 該当する部屋タイプが見つかりません; room-type token did not resolve for this f_syu/f_hak combination.";
    case "matrix_date_scope_unverified":
      return "Variant opened but target date could not be confirmed in rendered text.";
    case "matrix_basis_unverified":
      return "Variant opened but adult/room/night/total basis remains unclear.";
    default:
      return "Variant URL failed or did not return usable Rakuten content.";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenIframeMatrixProbe();
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`live_extracted_href=${result.liveExtractedHref || "not_found"}`);
  console.log(`live_f_syu=${result.liveSyuValue || "not_found"}`);
  console.log(`probe_rows=${result.rows.length}`);
  console.log(`execution_note=${result.executionNote}`);
  console.log(`classification_counts=${JSON.stringify(countClassifications(result.rows))}`);
  console.log(`feasibility_decision=${result.decision}`);
}

function countClassifications(rows: RakutenMatrixProbeRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  }
  return counts;
}

if (process.argv[1]?.endsWith("probeRakutenIframeMatrix.ts")) {
  void main();
}

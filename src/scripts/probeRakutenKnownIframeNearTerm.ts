import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import {
  buildRakutenIframeUrlForDate,
  classifyRakutenNearTermProbe,
  decideRakutenNearTermFeasibility,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  KNOWN_ZAO_BASE_IFRAME_URL,
  renderRakutenNearTermCsv,
  renderRakutenNearTermReport,
  type RakutenNearTermProbeRow
} from "../services/rakutenKnownIframeNearTermProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-known-iframe-nearterm-probe";

const PROPERTY = { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" } as const;
const STAY_DATES = ["2026-06-15", "2026-06-22", "2026-07-01", "2026-07-12"] as const;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface ProbeObservation {
  generatedUrl: string;
  reachable: boolean;
  pageText: string;
  pageDom: string;
  errorReason: string;
}

async function probeOne(
  browser: Browser | null,
  stayDate: string,
  artifactDir: string,
  timeoutMs: number
): Promise<ProbeObservation> {
  const generatedUrl = buildRakutenIframeUrlForDate(KNOWN_ZAO_BASE_IFRAME_URL, stayDate);
  const obs: ProbeObservation = {
    generatedUrl,
    reachable: false,
    pageText: "",
    pageDom: "",
    errorReason: ""
  };

  await writeFile(join(artifactDir, "generated_url.txt"), generatedUrl, "utf8").catch(() => undefined);

  if (browser === null) {
    obs.errorReason = "browser_launch_failed";
    await writeRequiredArtifacts(artifactDir, obs);
    return obs;
  }

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-known-iframe-nearterm-probe/0.1; low-volume feasibility)"
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    // domcontentloaded (not "load"): the Thickbox iframe keeps loading widget
    // assets, so waiting for the full load event timed out in Phase 56X.
    await page.goto(obs.generatedUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(3_000);
    obs.reachable = true;
    obs.pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    obs.pageDom = await page.content().catch(() => "");
    await page
      .screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: true })
      .catch(() => undefined);
  } catch (error) {
    obs.errorReason = error instanceof Error ? error.message : String(error);
  } finally {
    await context.close().catch(() => undefined);
  }

  await writeRequiredArtifacts(artifactDir, obs);
  return obs;
}

async function writeRequiredArtifacts(artifactDir: string, obs: ProbeObservation): Promise<void> {
  await writeFile(join(artifactDir, "generated_url.txt"), obs.generatedUrl, "utf8").catch(() => undefined);
  await writeFile(join(artifactDir, "page_text.txt"), obs.pageText.slice(0, 80_000), "utf8").catch(() => undefined);
  await writeFile(join(artifactDir, "dom_excerpt.html"), obs.pageDom.slice(0, 80_000), "utf8").catch(() => undefined);
}

export async function runRakutenKnownIframeNearTermProbe(options: { timeoutMs?: number } = {}): Promise<{
  rows: RakutenNearTermProbeRow[];
  decision: ReturnType<typeof decideRakutenNearTermFeasibility>;
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
  let executionNote = "completed rakuten known iframe near-term probe";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    executionNote = `browser_launch_failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const rows: RakutenNearTermProbeRow[] = [];
  for (const stayDate of STAY_DATES) {
    const artifactDir = join(debugRootPath, `${PROPERTY.hotelNo}_${stayDate}`);
    await mkdir(artifactDir, { recursive: true });
    const obs = await probeOne(browser, stayDate, artifactDir, timeoutMs);
    const evidence = detectIframeDateScopedTotalEvidence({
      text: obs.pageText,
      stayDate,
      canonicalPropertyName: PROPERTY.canonicalPropertyName
    });
    const noMatchingRoomType = detectNoMatchingRoomType(obs.pageText);
    const classification = classifyRakutenNearTermProbe({
      reachable: obs.reachable,
      noMatchingRoomType,
      evidence
    });
    const row: RakutenNearTermProbeRow = {
      canonicalPropertyName: PROPERTY.canonicalPropertyName,
      hotelNo: PROPERTY.hotelNo,
      stayDate,
      knownBaseUrl: KNOWN_ZAO_BASE_IFRAME_URL,
      generatedUrl: obs.generatedUrl,
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
    await writeFile(
      join(artifactDir, "summary.json"),
      JSON.stringify({ ...row, noMatchingRoomType, evidence }, null, 2),
      "utf8"
    );
    rows.push(row);
  }

  if (browser !== null) {
    await browser.close().catch(() => undefined);
  }

  const decision = decideRakutenNearTermFeasibility(rows.map((row) => row.classification));
  const csvPath = resolve(REPORT_DIR, `rakuten_known_iframe_nearterm_probe_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_known_iframe_nearterm_probe_${ts}.md`);
  writeFileSync(csvPath, renderRakutenNearTermCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderRakutenNearTermReport({
      generatedAt: new Date().toISOString(),
      csvPath,
      debugRootPath,
      knownBaseUrl: KNOWN_ZAO_BASE_IFRAME_URL,
      rows,
      decision,
      executionNote
    }),
    "utf8"
  );

  return { rows, decision, csvPath, reportPath, debugRootPath, executionNote };
}

function riskNoteFor(classification: string): string {
  switch (classification) {
    case "near_term_date_scoped_total_found":
      return "Near-term date exposed a date-scoped 2-adult/1-room/1-night total; review selectors before DB collection.";
    case "near_term_date_scoped_per_person_found":
      return "Near-term iframe exposed date-scoped per-person evidence, but not a safe total.";
    case "near_term_no_plan_or_sold_out":
      return "Near-term iframe reached an explicit no-plan/sold-out state.";
    case "near_term_no_matching_room_type":
      return "Near-term iframe returned 該当する部屋タイプが見つかりません for f_syu=zaobase3; room-type token likely stale or date-coupled, not a network failure.";
    case "near_term_date_scope_unverified":
      return "Near-term iframe opened but target date could not be confirmed in rendered text.";
    case "near_term_basis_unverified":
      return "Near-term iframe opened but adult/room/night/total basis remains unclear.";
    default:
      return "Near-term iframe URL failed or did not return usable Rakuten content.";
  }
}

async function main(): Promise<void> {
  const result = await runRakutenKnownIframeNearTermProbe();
  console.log(`csv_path=${result.csvPath}`);
  console.log(`report_path=${result.reportPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`probe_rows=${result.rows.length}`);
  console.log(`execution_note=${result.executionNote}`);
  console.log(`classification_counts=${JSON.stringify(countClassifications(result.rows))}`);
  console.log(`feasibility_decision=${result.decision}`);
}

function countClassifications(rows: RakutenNearTermProbeRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  }
  return counts;
}

if (process.argv[1]?.endsWith("probeRakutenKnownIframeNearTerm.ts")) {
  void main();
}

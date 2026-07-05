// Phase ZMI PRICING-CRITICAL01 — priority-competitor + own-property 90-day
// recrawl runner.
//
// Fixes the REACTIVE-targeting gap: the existing Booking recrawl pipeline only
// ever recrawls a date once BI already has a low-confidence row for it, so a
// date with ZERO rows (e.g. OAKHILL's early August) never surfaces. This runner
// forces a guaranteed D+1..D+90 horizon for a fixed priority-competitor list
// (HAMMOND / OAKHILL / 吉田屋) and a fixed own-property list (三浦屋 / 喜らく),
// Booking-source only (Jalan live collection for these 90-day targets is not
// wired in this pass — see the completion report).
//
// Hard guarantees:
//   - default mode is --preview and is PLAN-ONLY (no live fetch) unless
//     COLLECT_BOOKING=1 is set — same fail-closed gate as the existing pipeline;
//   - target selection is stateless and date-tiered: D+1..D+30 every run,
//     D+31..D+60 within 3 days, D+61..D+90 within 7 days;
//   - live Booking execution remains capped per invocation — never a single
//     burst of hundreds of live page loads;
//   - competitor rows are appended ONLY via the EXISTING, unmodified
//     plan:booking-market-recrawl-append (its own_property_rows===0 gate is
//     exactly the right guard for competitor market evidence integrity);
//   - own-property rows use the SAME underlying primitives (buildProposedHistoryRow
//     + runRealAppend, same 45-column v1 schema, same skip-duplicate/skip-conflict
//     dedup, same lock+backup+atomic-write+rollback) directly, gated behind
//     ZMI_APPEND_OWN_PROPERTY_RECRAWL=1, because the existing script's own=0 gate
//     is specific to ITS competitor-evidence purpose, not a rule against ever
//     recording our own price;
//   - NO Beds24 / PMS / pricing CSV / DB write/sync / publish / launchd change.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  sanitizeBookingUrl,
  type BookingRenderedDomRow
} from "../services/bookingRenderedDomProbe";
import { toPreviewRow, type PreviewRow } from "../services/autoRunnerBookingPreview";
import { buildProposedHistoryRow } from "../services/bookingPreviewAppendProposal";
import { groupRowsToSourceShards } from "../services/bookingPreviewHistoryAppendRealRun";
import { runRealAppend } from "../services/localHistoryRealAppend";
import { HISTORY_CSV_HEADERS, type HistoryRow } from "../services/localHistorySchemaDesign";
import { historyRowFromCsvRecord, parseCsv } from "../services/localHistoryAppendValidationPolicy";
import { backoffDelayMs, classifyBlock, jitterDelayMs, shouldEarlyStop, sleep } from "../services/crawlThrottlePolicy";
import { buildPriorityCompetitorTargets, buildOwnPropertyTargets, todayJstIso, type RecrawlTarget } from "../services/priorityRecrawlTargets";
import { isOwnPropertyName } from "../services/ownPropertyTargets";
import { buildRefreshPlan, todaysSelectedTargets } from "../services/priorityRefreshTiers";
import { validatePrimaryPriceNumeric } from "../services/pricePlausibilityGuard";

const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/source-discovery";
const OUT_DIR = ".data/validation";
const DEBUG_ROOT = ".data/debug/pricing-critical-recrawl";
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-booking-preview/0.1; low-volume bounded preview)";

const MAX_PAGES_PER_BATCH = Number(process.env["ZMI_PRICING_CRITICAL_MAX_PAGES_PER_BATCH"] ?? "8") || 8;
const TARGET_SOURCES = ["booking", "jalan"] as const;
const LIVE_COLLECT_SOURCES = ["booking"] as const;
const NOT_YET_LIVE_COLLECT_SOURCES = ["jalan"] as const;
const PRICE_SOURCE_POLICY = "ota_display_price";
const REFRESH_STRATEGY = {
  near_term: { range: "D+1..D+30", expected_refresh: "every_run" },
  mid_term: { range: "D+31..D+60", expected_refresh: "within_3_days" },
  far_term: { range: "D+61..D+90", expected_refresh: "within_7_days" }
} as const;

function ts(): string { const d = new Date(); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function jstIso(): string { const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); return `${f.replace(" ", "T")}+09:00`; }
function esc(v: string): string { return /[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v; }

// Booking-only cells (Jalan live collection deferred — see report). D+1..D+90 x
// verified sources, but only the "booking" rows are actionable by THIS collector.
function bookingOnly(targets: readonly RecrawlTarget[]): RecrawlTarget[] {
  return targets.filter((t) => t.source === "booking");
}

interface LiveError { property: string; checkin: string; error: string }

async function collectLive(cells: readonly RecrawlTarget[], debugRootPath: string, collectedAtJst: string, timeoutMs: number): Promise<{ rows: PreviewRow[]; errors: LiveError[] }> {
  const rows: PreviewRow[] = [];
  const errors: LiveError[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  let consecutiveBlocks = 0, backoffAttempt = 0, pageCount = 0;
  try {
    for (const cell of cells) {
      if (pageCount >= MAX_PAGES_PER_BATCH) break;
      pageCount += 1;
      if (pageCount > 1) await sleep(jitterDelayMs());
      const target = { canonicalPropertyName: cell.canonical_property_name, slug: cell.property_slug };
      const checkout = checkoutForOneNight(cell.checkin);
      const probeUrl = buildBookingRenderedDomUrl({ ...target, checkin: cell.checkin });
      const artifactDir = join(debugRootPath, `${cell.property_slug}_${cell.checkin}`);
      await mkdir(artifactDir, { recursive: true });
      const screenshotPath = join(artifactDir, "screenshot.png");
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      let loaded = false, httpStatus = 0, finalUrl = probeUrl, pageTitle = "", bodyText = "", error = "";
      try {
        const response = await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        loaded = response !== null; httpStatus = response?.status() ?? 0;
        await page.waitForTimeout(5_000);
        finalUrl = page.url();
        pageTitle = await page.title().catch(() => "");
        bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); finalUrl = page.url() || probeUrl; }
      finally { await page.close().catch(() => undefined); }
      if (error !== "") errors.push({ property: cell.canonical_property_name, checkin: cell.checkin, error });
      const signals = analyzeBookingRenderedDomSignals({ target, checkin: cell.checkin, checkout, loaded, httpStatus, finalUrl, pageTitle, bodyText, error });
      const domRow: BookingRenderedDomRow = buildBookingRenderedDomRow({ target, checkin: cell.checkin, checkout, probeUrl, signals, debugArtifactPath: artifactDir });
      rows.push(toPreviewRow(domRow, { screenshotPath, debugPath: artifactDir, collectedAtJst }));
      await writeFile(join(artifactDir, "probe_url_sanitized.txt"), sanitizeBookingUrl(probeUrl), "utf8");
      const block = classifyBlock(httpStatus, `${pageTitle}\n${bodyText}\n${error}`);
      if (block !== null) { consecutiveBlocks += 1; await sleep(backoffDelayMs(backoffAttempt)); backoffAttempt += 1; if (shouldEarlyStop(consecutiveBlocks)) break; }
      else { consecutiveBlocks = 0; backoffAttempt = 0; }
    }
  } finally { await context.close().catch(() => undefined); await browser.close().catch(() => undefined); }
  return { rows, errors };
}

// No price AND not a confirmed sold-out/unavailable read: an ambiguous
// extraction failure for this specific cell (the target's own room cards
// never rendered — possibly leaving only a related-property carousel behind,
// see selectPrimaryBookingPriceCandidate). This must never be written into
// the competitor artifact runBookingMarketRecrawlAppendPlan.ts reads — that
// script appends ANY new-rowId observation regardless of price, so keeping
// it out of the artifact entirely (rather than trying to gate it inside that
// shared, unmodified script) is what stops it from being recorded as if we
// successfully checked the date.
function isNoUsableRoomPrice(r: PreviewRow): boolean {
  return r.primary_price_numeric === null && r.availability_status !== "sold_out_or_unavailable";
}

function summarize(rows: readonly PreviewRow[]): Record<string, number> {
  const s = { confirmed: 0, probable: 0, unknown: 0, excluded: 0, with_price: 0 };
  for (const r of rows) {
    const rb = r.room_basis ?? "unknown_room_basis";
    const priced = r.primary_price_numeric !== null && r.primary_price_numeric !== undefined;
    if (priced) s.with_price += 1;
    if (rb === "confirmed_two_person_standard_room") s.confirmed += 1;
    else if (rb === "probable_two_person_standard_room") s.probable += 1;
    else if (rb === "unknown_room_basis") s.unknown += 1;
    else s.excluded += 1;
  }
  return s;
}

function readExistingRowHashById(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(HISTORY_DIR)) return m;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const recs = parseCsv(readFileSync(join(HISTORY_DIR, f), "utf8"));
    if (recs.length < 2) continue;
    const header = recs[0]!;
    if (header.join(",") !== HISTORY_CSV_HEADERS.join(",")) continue;
    for (const rec of recs.slice(1)) {
      try { const row = historyRowFromCsvRecord(rec); m.set(row.rowId, row.rowHash); } catch { /* skip unparseable */ }
    }
  }
  return m;
}

// Own-property append: same primitives as the competitor path (buildProposedHistoryRow
// + runRealAppend), own rows explicitly ALLOWED (that gate is specific to the
// competitor-evidence script, not a general prohibition on recording our own price).
function appendOwnPropertyRows(rows: readonly PreviewRow[]): { rowsToAppend: number; dupSkipped: number; dupConflicts: number; implausiblePrice: number; noUsableRoomPrice: number; appendResult: ReturnType<typeof runRealAppend> | null } {
  const existing = readExistingRowHashById();
  const toAppend: HistoryRow[] = [];
  let dupSkipped = 0, dupConflicts = 0, implausiblePrice = 0, noUsableRoomPrice = 0;
  for (const r of rows) {
    // No price AND not a confirmed sold-out/unavailable read: an ambiguous
    // extraction failure (e.g. the target's own room cards never rendered,
    // possibly leaving only a related-property carousel behind — see
    // selectPrimaryBookingPriceCandidate). Never append this as if we
    // successfully checked the date; it must not count toward coverage.
    if (r.primary_price_numeric === null && r.availability_status !== "sold_out_or_unavailable") { noUsableRoomPrice += 1; continue; }
    // Same data-quality guard as the competitor append path: a "priced" row
    // whose price is implausible for Booking (e.g. ¥100) never becomes an
    // append candidate, regardless of dedup outcome.
    const plausibility = validatePrimaryPriceNumeric({ source: r.source, propertyName: r.canonical_property_name, price: r.primary_price_numeric, roomBasis: r.room_basis, roomName: r.primary_room_name, bedHint: r.primary_bed_hint });
    if (r.primary_price_numeric !== null && plausibility.data_quality_suspect) { implausiblePrice += 1; continue; }
    let hRow: HistoryRow;
    try { hRow = buildProposedHistoryRow({ row: r, sourceReportPath: "", sourceCsvPath: "" }); } catch { continue; }
    const prevHash = existing.get(hRow.rowId);
    if (prevHash !== undefined) {
      if (prevHash === hRow.rowHash) dupSkipped += 1;
      else dupConflicts += 1; // never overwrite; conflict is skipped, not appended
      continue;
    }
    toAppend.push(hRow);
  }
  if (toAppend.length === 0) return { rowsToAppend: 0, dupSkipped, dupConflicts, implausiblePrice, noUsableRoomPrice, appendResult: null };
  const runId = `pricing_critical_own_recrawl_${ts()}`;
  const result = runRealAppend({ historyDir: HISTORY_DIR, runId, backupTimestamp: ts(), sourceShards: groupRowsToSourceShards(toAppend) });
  return { rowsToAppend: toAppend.length, dupSkipped, dupConflicts, implausiblePrice, noUsableRoomPrice, appendResult: result };
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const appendMode = args.includes("--append");
  const groupArg = args.find((a) => a.startsWith("--group="))?.split("=")[1] ?? "both";
  const liveGate = process.env["COLLECT_BOOKING"] === "1";
  const todayIso = todayJstIso();

  const competitorTargets = groupArg === "own" ? { targets: [], skipped_no_verified_source: [] } : buildPriorityCompetitorTargets({ todayIso });
  const ownTargets = groupArg === "competitor" ? { targets: [], skipped_no_verified_source: [] } : buildOwnPropertyTargets({ todayIso });
  const competitorPlan = buildRefreshPlan(competitorTargets.targets, todayIso);
  const ownPlan = buildRefreshPlan(ownTargets.targets, todayIso);
  const selectedCompetitorTargets = todaysSelectedTargets(competitorTargets.targets, todayIso);
  const selectedOwnTargets = todaysSelectedTargets(ownTargets.targets, todayIso);
  const competitorLiveQueue = bookingOnly(selectedCompetitorTargets);
  const ownLiveQueue = bookingOnly(selectedOwnTargets);
  const selectedCompetitor = competitorLiveQueue.slice(0, MAX_PAGES_PER_BATCH);
  const selectedOwn = ownLiveQueue.slice(0, MAX_PAGES_PER_BATCH);

  console.log(`decision=pricing_critical_recrawl_${appendMode ? "append" : "preview"}`);
  console.log(`group=${groupArg}`);
  console.log(`today_jst=${todayIso}`);
  console.log(`price_source_policy=${PRICE_SOURCE_POLICY}`);
  console.log(`refresh_strategy=${JSON.stringify(REFRESH_STRATEGY)}`);
  console.log(`target_sources=${JSON.stringify(TARGET_SOURCES)}`);
  console.log(`live_collect_sources=${JSON.stringify(LIVE_COLLECT_SOURCES)}`);
  console.log(`not_yet_live_collect_sources=${JSON.stringify(NOT_YET_LIVE_COLLECT_SOURCES)}`);
  console.log(`priority_competitor_target_count=${competitorTargets.targets.length}`);
  console.log(`own_property_target_count=${ownTargets.targets.length}`);
  console.log(`priority_competitor_near_term_targets=${competitorPlan.near_term.length}`);
  console.log(`priority_competitor_mid_term_selected_today=${competitorPlan.mid_term_selected_today.length}`);
  console.log(`priority_competitor_mid_term_full_universe=${competitorPlan.mid_term_full_universe.length}`);
  console.log(`priority_competitor_far_term_selected_today=${competitorPlan.far_term_selected_today.length}`);
  console.log(`priority_competitor_far_term_full_universe=${competitorPlan.far_term_full_universe.length}`);
  console.log(`own_property_near_term_targets=${ownPlan.near_term.length}`);
  console.log(`own_property_mid_term_selected_today=${ownPlan.mid_term_selected_today.length}`);
  console.log(`own_property_mid_term_full_universe=${ownPlan.mid_term_full_universe.length}`);
  console.log(`own_property_far_term_selected_today=${ownPlan.far_term_selected_today.length}`);
  console.log(`own_property_far_term_full_universe=${ownPlan.far_term_full_universe.length}`);
  console.log(`priority_competitor_selected_target_count=${selectedCompetitorTargets.length}`);
  console.log(`own_property_selected_target_count=${selectedOwnTargets.length}`);
  console.log(`priority_competitor_live_collect_queue_count=${competitorLiveQueue.length}`);
  console.log(`own_property_live_collect_queue_count=${ownLiveQueue.length}`);
  console.log(`priority_competitor_live_collect_page_count=${selectedCompetitor.length}`);
  console.log(`own_property_live_collect_page_count=${selectedOwn.length}`);
  console.log(`max_pages_per_batch=${MAX_PAGES_PER_BATCH}`);
  console.log(`skipped_no_verified_source=${JSON.stringify([...competitorTargets.skipped_no_verified_source, ...ownTargets.skipped_no_verified_source])}`);
  console.log(`jalan_live_collection_wired=false`); // disclosed limitation (see report)
  console.log(`history_append=false`);
  console.log(`db_write=false`);
  console.log(`publish=false`);
  console.log(`pricing_output_generated=false`);
  console.log(`pms_output_generated=false`);

  if (!liveGate) {
    console.log(`decision=pricing_critical_recrawl_plan_only`);
    console.log(`note=set COLLECT_BOOKING=1 to run a live batch`);
    return;
  }

  // Defense in depth: own targets must never leak into the competitor batch and
  // vice versa (§2/§6.2 responsibility split).
  const ownLeak = selectedCompetitor.filter((c) => isOwnPropertyName(c.canonical_property_name)).length;
  if (ownLeak > 0) throw new Error(`circularity guard violated: ${ownLeak} own-property cells in a competitor batch`);

  const collectedAtJst = jstIso();
  const debugPath = resolve(DEBUG_ROOT, ts());
  mkdirSync(debugPath, { recursive: true });
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(resolve(OUT_DIR), { recursive: true });

  let competitorArtifactPath = "";
  let competitorRows: PreviewRow[] = [];
  if (selectedCompetitor.length > 0) {
    const { rows, errors } = await collectLive(selectedCompetitor, join(debugPath, "competitor"), collectedAtJst, 45_000);
    competitorRows = rows;
    const s = summarize(rows);
    const runId = `pricing_critical_competitor_recrawl_${ts()}`;
    const usableRows = rows.filter((r) => !isNoUsableRoomPrice(r));
    const noUsableRoomPrice = rows.length - usableRows.length;
    const result = { generated_at_jst: collectedAtJst, selection_model: "stateless_tiered_date_sla", live_collection_executed: true, errors, rows: usableRows.map((r) => ({ canonical_property_name: r.canonical_property_name, checkin: r.checkin, room_basis: r.room_basis, room_basis_reason: r.room_basis_reason, primary_room_name: r.primary_room_name, primary_bed_hint: r.primary_bed_hint, primary_price_numeric: r.primary_price_numeric, classification: r.classification, availability_status: r.availability_status })) };
    competitorArtifactPath = resolve(REPORT_DIR, `${runId}.json`);
    writeFileSync(competitorArtifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`competitor_pages_collected=${rows.length}`);
    console.log(`competitor_confirmed=${s.confirmed} competitor_probable=${s.probable} competitor_unknown=${s.unknown} competitor_excluded=${s.excluded}`);
    console.log(`competitor_no_usable_room_price_excluded=${noUsableRoomPrice}`);
    console.log(`competitor_preview_json=${competitorArtifactPath}`);
  }

  let ownRows: PreviewRow[] = [];
  if (selectedOwn.length > 0) {
    const { rows, errors } = await collectLive(selectedOwn, join(debugPath, "own"), collectedAtJst, 45_000);
    ownRows = rows;
    const s = summarize(rows);
    const runId = `pricing_critical_own_recrawl_${ts()}`;
    const result = { generated_at_jst: collectedAtJst, selection_model: "stateless_tiered_date_sla", live_collection_executed: true, errors, rows: rows.map((r) => ({ canonical_property_name: r.canonical_property_name, checkin: r.checkin, room_basis: r.room_basis, room_basis_reason: r.room_basis_reason, primary_room_name: r.primary_room_name, primary_bed_hint: r.primary_bed_hint, primary_price_numeric: r.primary_price_numeric, classification: r.classification, availability_status: r.availability_status })) };
    const ownArtifactPath = resolve(OUT_DIR, `${runId}.json`);
    writeFileSync(ownArtifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`own_pages_collected=${rows.length}`);
    console.log(`own_confirmed=${s.confirmed} own_probable=${s.probable} own_unknown=${s.unknown} own_excluded=${s.excluded}`);
    console.log(`own_preview_json=${ownArtifactPath}`);
  }

  if (!appendMode) { console.log(`decision=pricing_critical_recrawl_preview_ready`); return; }

  // Competitor append: reuse the EXISTING, unmodified append-plan script.
  if (competitorRows.length > 0 && competitorArtifactPath !== "") {
    const spawnResult = spawnSync("npm", ["run", "plan:booking-market-recrawl-append"], {
      encoding: "utf8",
      env: { ...process.env, ZMI_RECRAWL_APPEND_ARTIFACT: competitorArtifactPath, ZMI_APPEND_BOOKING_MARKET_RECRAWL: "1", ZMI_APPEND_CONFLICT_POLICY: "skip_conflicts_append_unique" }
    });
    console.log(`competitor_append_exit_code=${spawnResult.status}`);
    console.log(spawnResult.stdout ?? "");
    if (spawnResult.stderr) console.error(spawnResult.stderr);
  }

  // Own-property append: same underlying primitives, gated separately.
  if (ownRows.length > 0) {
    if (process.env["ZMI_APPEND_OWN_PROPERTY_RECRAWL"] === "1") {
      const r = appendOwnPropertyRows(ownRows);
      console.log(`own_rows_to_append=${r.rowsToAppend}`);
      console.log(`own_dup_skipped=${r.dupSkipped}`);
      console.log(`own_dup_conflicts=${r.dupConflicts}`);
      console.log(`own_implausible_price_excluded=${r.implausiblePrice}`);
      console.log(`own_no_usable_room_price_excluded=${r.noUsableRoomPrice}`);
      console.log(`own_append_decision=${r.appendResult?.decision ?? "no_rows_to_append"}`);
      console.log(`own_rows_written=${r.appendResult?.rowsWritten ?? 0}`);
    } else {
      console.log(`own_append_skipped=true`);
      console.log(`note=set ZMI_APPEND_OWN_PROPERTY_RECRAWL=1 to append own-property observations`);
    }
  }

  console.log(`decision=pricing_critical_recrawl_append_ready`);
}

run().catch((e) => { console.error(e); process.exitCode = 1; });

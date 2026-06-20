// Phase ZMI BOOKING-MARKET-RECRAWL — dedicated competitor re-crawl preview runner.
//
// Separate from auto-runner:booking-preview (whose MAX_PROPERTIES=3 / MAX_PAGES=9
// global cap is left untouched). This runner re-crawls the COMPETITOR verified-
// target-gap properties in small batches under its OWN conservative cap so more
// market (non-own) Booking rows can reach confirmed_two_person_standard_room.
//
// Hard guarantees (asserted at runtime):
//   - own properties (三浦屋 / 喜らく) can NEVER enter a batch (circularity guard);
//   - NO history append, NO DB write/sync, NO publish, NO pricing/PMS output;
//   - live fetch only when COLLECT_BOOKING=1 (fail-closed = plan-only otherwise);
//   - one batch per invocation; estimated pages must be <= the batch page cap.
// Reuses the proven rendered-DOM extractor + throttle policy from the existing
// preview runner. Writes .data/crawl-priority + .data/reports/source-discovery.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  sanitizeBookingUrl,
  type BookingRenderedDomRow
} from "../services/bookingRenderedDomProbe";
import { toPreviewRow, VERIFIED_BOOKING_TARGETS, type PreviewRow } from "../services/autoRunnerBookingPreview";
import { canonicalizeName, isOwnProperty } from "../services/biWebDataExport";
import { backoffDelayMs, classifyBlock, jitterDelayMs, shouldEarlyStop, sleep } from "../services/crawlThrottlePolicy";

const CRAWL_DIR = ".data/crawl-priority";
const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/booking-market-recrawl";
const GAP_JSON = join(CRAWL_DIR, "booking_verified_target_gap_review.json");
const TARGETS_CSV = join(CRAWL_DIR, "booking_low_confidence_targets.csv");
const SLUG_RE = /^[a-z0-9-]+$/u;
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-booking-preview/0.1; low-volume bounded preview)";

// Conservative defaults; env-overridable but never the existing global cap.
const MAX_RECRAWL_PROPERTIES_PER_BATCH = Number(process.env["ZMI_RECRAWL_MAX_PROPERTIES_PER_BATCH"] ?? "3") || 3;
const MAX_RECRAWL_DATES_PER_BATCH = Number(process.env["ZMI_RECRAWL_MAX_DATES_PER_BATCH"] ?? "2") || 2;
const MAX_RECRAWL_PAGES_PER_BATCH = Number(process.env["ZMI_RECRAWL_MAX_PAGES_PER_BATCH"] ?? "6") || 6;

function timestamp(): string {
  const d = new Date(); const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function jstIso(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function parseCsvLine(line: string): string[] {
  const cells: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur); return cells;
}
function esc(v: string): string { return /[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v; }

interface DateCand { checkin: string; priority_score: number; priority_bucket: string; target_reason: string }
interface Candidate { canonical_property_name: string; booking_slug: string; market_target_rows: number; dates: DateCand[] }
interface BatchCell { batch_index: number; canonical_property_name: string; booking_slug: string; checkin: string; priority_score: number; priority_bucket: string; target_reason: string; recrawl_reason: string; market_evidence_eligible: boolean; is_own_property: boolean; target_scope: string }

// Per-property market (non-own) re-crawl dates from the full targets CSV.
function readMarketDatesByProperty(): Map<string, DateCand[]> {
  const m = new Map<string, DateCand[]>();
  if (!existsSync(TARGETS_CSV)) return m;
  const lines = readFileSync(TARGETS_CSV, "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
  if (lines.length < 2) return m;
  const h = parseCsvLine(lines[0]!); const idx = (n: string): number => h.indexOf(n);
  const today = todayJst();
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if ((c[idx("target_scope")] ?? "") !== "market_evidence_recrawl") continue;
    if ((c[idx("is_own_property")] ?? "").toLowerCase() === "true") continue;
    const name = (c[idx("canonical_property_name")] ?? "").trim();
    const checkin = (c[idx("checkin")] ?? "").trim();
    if (name === "" || checkin < today) continue;
    const arr = m.get(name) ?? [];
    arr.push({ checkin, priority_score: Number(c[idx("priority_score")] ?? "0") || 0, priority_bucket: c[idx("priority_bucket")] ?? "", target_reason: c[idx("target_reason")] ?? "" });
    m.set(name, arr);
  }
  for (const [, arr] of m) arr.sort((a, b) => b.priority_score - a.priority_score || a.checkin.localeCompare(b.checkin));
  return m;
}

function buildCandidates(): Candidate[] {
  if (!existsSync(GAP_JSON)) throw new Error(`missing ${GAP_JSON} — run review:booking-verified-target-gap first`);
  const gap = JSON.parse(readFileSync(GAP_JSON, "utf8")) as { recommended_market_verified_target_additions?: Array<{ canonical_property_name: string; booking_slug_candidates: string[]; market_target_rows: number; is_own_property: boolean; market_evidence_eligible: boolean }> };
  const recs = gap.recommended_market_verified_target_additions ?? [];
  const datesByProp = readMarketDatesByProperty();
  const out: Candidate[] = [];
  for (const r of recs) {
    // Defense in depth: never admit an own property or a non-eligible row.
    if (r.is_own_property || !r.market_evidence_eligible || isOwnProperty(r.canonical_property_name)) continue;
    const slug = (r.booking_slug_candidates ?? []).find((s) => SLUG_RE.test(s));
    if (!slug) continue;
    const dates = (datesByProp.get(r.canonical_property_name) ?? []).slice(0, MAX_RECRAWL_DATES_PER_BATCH);
    if (dates.length === 0) continue;
    out.push({ canonical_property_name: r.canonical_property_name, booking_slug: slug, market_target_rows: r.market_target_rows, dates });
  }
  out.sort((a, b) => b.market_target_rows - a.market_target_rows || a.canonical_property_name.localeCompare(b.canonical_property_name));
  return out;
}

function buildBatches(cands: Candidate[]): BatchCell[][] {
  const batches: BatchCell[][] = [];
  for (let i = 0; i < cands.length; i += MAX_RECRAWL_PROPERTIES_PER_BATCH) {
    const group = cands.slice(i, i + MAX_RECRAWL_PROPERTIES_PER_BATCH);
    const batchIndex = batches.length;
    const cells: BatchCell[] = [];
    for (const cand of group) {
      for (const d of cand.dates) {
        cells.push({
          batch_index: batchIndex, canonical_property_name: cand.canonical_property_name, booking_slug: cand.booking_slug,
          checkin: d.checkin, priority_score: d.priority_score, priority_bucket: d.priority_bucket, target_reason: d.target_reason,
          recrawl_reason: "market_competitor_room_context_recrawl", market_evidence_eligible: true, is_own_property: false,
          target_scope: "market_evidence_recrawl"
        });
      }
    }
    batches.push(cells);
  }
  return batches;
}

function assertNoOwnInBatches(batches: BatchCell[][]): number {
  let ownCount = 0;
  for (const b of batches) for (const c of b) if (c.is_own_property || isOwnProperty(c.canonical_property_name)) ownCount += 1;
  if (ownCount > 0) throw new Error(`circularity guard violated: ${ownCount} own-property cells found in batches`);
  return ownCount;
}

function writeBatchPlan(batches: BatchCell[][]): { jsonPath: string; csvPath: string } {
  mkdirSync(resolve(CRAWL_DIR), { recursive: true });
  const plan = batches.map((cells, i) => ({
    batch_index: i,
    property_count: new Set(cells.map((c) => c.canonical_property_name)).size,
    date_count: cells.length,
    page_count_estimate: cells.length,
    within_batch_page_cap: cells.length <= MAX_RECRAWL_PAGES_PER_BATCH,
    cells
  }));
  const jsonPath = resolve(CRAWL_DIR, "booking_market_recrawl_batches.json");
  const csvPath = resolve(CRAWL_DIR, "booking_market_recrawl_batches.csv");
  writeFileSync(jsonPath, `${JSON.stringify({ generated_at_jst: jstIso(), caps: { MAX_RECRAWL_PROPERTIES_PER_BATCH, MAX_RECRAWL_DATES_PER_BATCH, MAX_RECRAWL_PAGES_PER_BATCH }, batch_count: plan.length, batches: plan }, null, 2)}\n`, "utf8");
  const COLS = ["batch_index", "property_count", "date_count", "page_count_estimate", "canonical_property_name", "booking_slug", "checkin", "priority_score", "priority_bucket", "target_reason", "market_evidence_eligible", "is_own_property", "target_scope", "recrawl_reason"];
  const rows: string[][] = [COLS];
  for (const b of plan) for (const c of b.cells) rows.push([String(b.batch_index), String(b.property_count), String(b.date_count), String(b.page_count_estimate), c.canonical_property_name, c.booking_slug, c.checkin, String(c.priority_score), c.priority_bucket, c.target_reason, "true", "false", c.target_scope, c.recrawl_reason]);
  writeFileSync(csvPath, rows.map((r) => r.map(esc).join(",")).join("\n") + "\n", "utf8");
  return { jsonPath, csvPath };
}

interface LiveError { property: string; checkin: string; error: string }
async function collectLive(cells: BatchCell[], debugRootPath: string, collectedAtJst: string, timeoutMs: number): Promise<{ rows: PreviewRow[]; errors: LiveError[] }> {
  const rows: PreviewRow[] = [];
  const errors: LiveError[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  let consecutiveBlocks = 0; let backoffAttempt = 0; let pageCount = 0;
  try {
    for (const cell of cells) {
      if (pageCount >= MAX_RECRAWL_PAGES_PER_BATCH) break;
      pageCount += 1;
      if (pageCount > 1) await sleep(jitterDelayMs());
      const target = { canonicalPropertyName: cell.canonical_property_name, slug: cell.booking_slug };
      const checkout = checkoutForOneNight(cell.checkin);
      const probeUrl = buildBookingRenderedDomUrl({ ...target, checkin: cell.checkin });
      const artifactDir = join(debugRootPath, `${cell.booking_slug}_${cell.checkin}`);
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

function summarize(rows: PreviewRow[]): Record<string, number> {
  const s = { confirmed: 0, probable: 0, unknown: 0, excluded: 0, with_price: 0, directional: 0, high_uplift: 0, medium_uplift: 0 };
  for (const r of rows) {
    const rb = r.room_basis ?? "unknown_room_basis";
    const priced = r.primary_price_numeric !== null && r.primary_price_numeric !== undefined;
    if (priced) s.with_price += 1;
    if (r.classification === "directional") s.directional += 1;
    if (rb === "confirmed_two_person_standard_room") { s.confirmed += 1; if (priced) s.high_uplift += 1; }
    else if (rb === "probable_two_person_standard_room") { s.probable += 1; if (priced) s.medium_uplift += 1; }
    else if (rb === "unknown_room_basis") s.unknown += 1;
    else s.excluded += 1;
  }
  return s;
}

async function run(): Promise<void> {
  const planOnly = process.argv.includes("--plan-only") || process.env["ZMI_RECRAWL_PLAN_ONLY"] === "1";
  const liveGate = process.env["COLLECT_BOOKING"] === "1"; // fail-closed live gate
  const batchIndex = Number(process.env["ZMI_RECRAWL_BATCH_INDEX"] ?? "0") || 0;

  const candidates = buildCandidates();
  const batches = buildBatches(candidates);
  const ownExcluded = assertNoOwnInBatches(batches);
  const { jsonPath: planJson, csvPath: planCsv } = writeBatchPlan(batches);

  const selected = batches[batchIndex] ?? [];
  const estimatedPages = selected.length;
  const propsCovered = [...new Set(selected.map((c) => c.canonical_property_name))];
  const checkinsCovered = [...new Set(selected.map((c) => c.checkin))].sort();

  console.log(`batch_count=${batches.length}`);
  console.log(`candidate_properties=${candidates.length}`);
  console.log(`own_properties_excluded_count=${ownExcluded}`);
  console.log(`selected_batch_index=${batchIndex}`);
  console.log(`selected_properties=${JSON.stringify(propsCovered)}`);
  console.log(`selected_checkins=${JSON.stringify(checkinsCovered)}`);
  console.log(`estimated_pages=${estimatedPages}`);
  console.log(`safety_caps=${JSON.stringify({ MAX_RECRAWL_PROPERTIES_PER_BATCH, MAX_RECRAWL_DATES_PER_BATCH, MAX_RECRAWL_PAGES_PER_BATCH })}`);
  console.log(`history_append=false`);
  console.log(`db_write=false`);
  console.log(`publish=false`);
  console.log(`batch_plan_json=${planJson}`);
  console.log(`batch_plan_csv=${planCsv}`);
  console.log(`global_preview_caps_unchanged=MAX_PROPERTIES=${VERIFIED_BOOKING_TARGETS.length === 3 ? 3 : "?"};MAX_PAGES=9`);

  if (estimatedPages > MAX_RECRAWL_PAGES_PER_BATCH) {
    console.log(`decision=booking_market_recrawl_stopped_page_cap_exceeded`);
    process.exitCode = 1;
    return;
  }
  if (planOnly) { console.log(`decision=booking_market_recrawl_plan_only`); return; }
  if (!liveGate) { console.log(`decision=booking_market_recrawl_live_gate_closed_set_COLLECT_BOOKING_1`); return; }
  if (selected.length === 0) { console.log(`decision=booking_market_recrawl_no_cells_for_batch`); return; }

  const ts = timestamp();
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(debugPath, { recursive: true });
  const collectedAtJst = jstIso();
  const { rows, errors } = await collectLive(selected, debugPath, collectedAtJst, 45_000);
  const pageCapRespected = rows.length <= MAX_RECRAWL_PAGES_PER_BATCH;
  const s = summarize(rows);

  const result = {
    generated_at_jst: collectedAtJst,
    live_collection_executed: true,
    selected_batch_index: batchIndex,
    selected_pages: rows.length,
    page_cap_respected: pageCapRespected,
    history_modified: false, db_written: false, db_synced: false, ai_context_refreshed: false,
    pricing_csv_generated: false, pms_output_generated: false,
    own_properties_excluded_count: ownExcluded,
    properties_covered: propsCovered,
    checkins_covered: checkinsCovered,
    with_price_count: s.with_price,
    directional_count: s.directional,
    confirmed_two_person_standard_room_count: s.confirmed,
    probable_two_person_standard_room_count: s.probable,
    unknown_room_basis_count: s.unknown,
    excluded_room_type_count: s.excluded,
    preview_confirmed_count: s.confirmed,
    preview_probable_count: s.probable,
    preview_unknown_count: s.unknown,
    preview_excluded_count: s.excluded,
    preview_price_sample_usable_count: s.with_price,
    preview_high_uplift_potential: s.high_uplift,
    preview_medium_uplift_potential: s.medium_uplift,
    stored_history_confidence_change: "none",
    errors,
    skipped: [] as string[],
    rows: rows.map((r) => ({ canonical_property_name: r.canonical_property_name, checkin: r.checkin, room_basis: r.room_basis, room_basis_reason: r.room_basis_reason, primary_room_name: r.primary_room_name, primary_bed_hint: r.primary_bed_hint, primary_price_numeric: r.primary_price_numeric, classification: r.classification }))
  };

  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const outJson = resolve(REPORT_DIR, `booking_market_recrawl_preview_${ts}.json`);
  const outCsv = resolve(REPORT_DIR, `booking_market_recrawl_preview_${ts}.csv`);
  writeFileSync(outJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const COLS = ["canonical_property_name", "checkin", "room_basis", "room_basis_reason", "primary_room_name", "primary_bed_hint", "primary_price_numeric", "classification"];
  writeFileSync(outCsv, [COLS.join(",")].concat(result.rows.map((r) => COLS.map((k) => esc(String((r as Record<string, unknown>)[k] ?? ""))).join(","))).join("\n") + "\n", "utf8");

  console.log(`decision=booking_market_recrawl_preview_ready`);
  console.log(`live_collection_executed=true`);
  console.log(`selected_pages=${rows.length}`);
  console.log(`page_cap_respected=${pageCapRespected}`);
  console.log(`confirmed=${s.confirmed} probable=${s.probable} unknown=${s.unknown} excluded=${s.excluded}`);
  console.log(`preview_high_uplift_potential=${s.high_uplift}`);
  console.log(`preview_medium_uplift_potential=${s.medium_uplift}`);
  console.log(`with_price_count=${s.with_price}`);
  console.log(`preview_json=${outJson}`);
  console.log(`preview_csv=${outCsv}`);
}

run().catch((e) => { console.error(e); process.exitCode = 1; });

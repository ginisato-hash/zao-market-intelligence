// Phase AUTO-RUNNER16X-B — one-shot manual live pilot (fetch-only).
//
// Live-fetches one rotating-plan slot over VERIFIED live targets only and
// writes a pilot report. EXPLICITLY: NO history append, NO DB sync, NO AI
// context refresh, NO publish, NO pricing/PMS output, NO scheduler/launchd
// change, NO captcha bypass / stealth / proxy / login / cookie injection.
// Blocked or captcha pages are recorded as observations, never retried in a
// storm; a source stops after 2 consecutive blocked pages. This script is a
// standalone manual command — it shares the planner and the proven Booking /
// Jalan collectors with the rotating runner but never enters its
// append->sync->context pipeline.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  buildBookingRenderedDomUrl,
  sanitizeBookingUrl,
  type BookingRenderedDomRow
} from "../services/bookingRenderedDomProbe";
import { toPreviewRow, type PreviewAvailabilityStatus, type PreviewRow as BookingPreviewRow } from "../services/autoRunnerBookingPreview";
import { buildBookingSourceLevelCheck, buildJalanSourceLevelCheck } from "../services/autoRunnerMarketRefresh";
import { buildJalanProbeTarget, type JalanImprovedPreviewRow, type ProbeAvailabilityStatus } from "../services/jalanBoundedCollectionProbeImproved";
import { collectTarget, ensureJalanDebugDirs } from "./probeJalanBoundedCollectionImproved";
import { isLiveVerified, liveTargets, type TargetTier } from "../services/marketRefreshTargetUniverse";
import {
  ROTATING_CAPS,
  buildRotatingPlan,
  type RotatingDemandConfig,
  type RotatingTarget
} from "../services/rotatingCollectionScopePlanner";

const HISTORY_DIR = ".data/history";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const AI_CONTEXT_PATH = ".data/ai-context/latest_market_snapshot.json";
const REPORT_DIR = ".data/reports/auto-runner16x-b-manual-live-pilot";
const DEBUG_ROOT = ".data/debug/auto-runner16x-b-manual-live-pilot";
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-rotating/0.1; low-volume bounded)";
const MAX_CONSECUTIVE_BLOCKED_PER_SOURCE = 2;

// Priority observation targets from the 16X-B work order. All four are
// 16X-A4/A3 verified Booking mappings; they are forced into the booking
// selection so the pilot observes them even when slot rotation would skip them.
export const FORCED_BOOKING_OBSERVATION_SLUGS = [
  "le-vert-zao",
  "winter-season-matsuo-house-room-natsu",
  "ji-tian-wu-shan-xing-shi",
  "kkrzaohakuginso"
] as const;

// Matsuo House Booking listing is a seasonal 民泊 private-room page; identity is
// A-confidence but its price must NOT be read as a property-level price.
export const MATSUO_HOUSE_BOOKING_SLUG = "winter-season-matsuo-house-room-natsu";
export const MATSUO_HOUSE_SEMANTICS_NOTE = "seasonal_room_listing: price_semantics=needs_observation (private-room 民泊 listing; do not interpret as property-level price)";

// Same demand calendar as the rotating runner (kept local: importing the
// rotating runner script would execute its run()).
const DEMAND_CONFIG: RotatingDemandConfig = {
  public_holidays: {
    "2026-07-20": "海の日", "2026-08-11": "山の日", "2026-09-21": "敬老の日",
    "2026-09-22": "国民の休日", "2026-09-23": "秋分の日", "2026-10-12": "スポーツの日",
    "2026-11-03": "文化の日", "2026-11-23": "勤労感謝の日", "2027-01-01": "元日",
    "2027-01-11": "成人の日", "2027-02-11": "建国記念の日", "2027-02-23": "天皇誕生日"
  },
  long_weekend_dates: new Set([
    "2026-07-18", "2026-07-19", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22",
    "2026-10-10", "2026-10-11", "2026-11-21", "2026-11-22", "2027-01-09", "2027-01-10"
  ]),
  peak_periods: [
    { code: "obon", from: "2026-08-08", to: "2026-08-16" },
    { code: "autumn_foliage", from: "2026-10-10", to: "2026-11-08", saturday_only: true },
    { code: "ski_season", from: "2026-12-19", to: "2027-03-15", saturday_only: true },
    { code: "year_end_peak", from: "2026-12-28", to: "2027-01-03" }
  ]
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).

export type PilotStatusBucket = "available" | "sold_out" | "visible_no_safe_price" | "not_listed" | "not_found" | "blocked" | "failed";

export function bookingStatusBucket(status: PreviewAvailabilityStatus): PilotStatusBucket {
  switch (status) {
    case "available_price_basis": return "available";
    case "sold_out_or_unavailable": return "sold_out";
    case "visible_no_safe_price": return "visible_no_safe_price";
    case "blocked_captcha_or_security":
    case "blocked_login_required": return "blocked";
    case "not_found": return "not_found";
    default: return "failed"; // degraded_empty / navigation_failed / unexpected_error
  }
}

export function jalanStatusBucket(status: ProbeAvailabilityStatus): PilotStatusBucket {
  switch (status) {
    case "available": return "available";
    case "sold_out": return "sold_out";
    case "not_listed": return "not_listed";
    case "not_found": return "not_found";
    default: return "failed";
  }
}

export function summarizePilotStatuses(buckets: readonly PilotStatusBucket[]): Record<PilotStatusBucket, number> {
  const out: Record<PilotStatusBucket, number> = { available: 0, sold_out: 0, visible_no_safe_price: 0, not_listed: 0, not_found: 0, blocked: 0, failed: 0 };
  for (const b of buckets) out[b] += 1;
  return out;
}

function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Force the priority observation booking slugs into the plan by replacing the
 * lowest-priority non-forced booking selections (from the end of the list).
 * Page counts never grow; booking distinct-property count never shrinks
 * (each replacement swaps one property for another, or increases diversity
 * when the victim property had two selections). stay_date is inherited from
 * the victim and shifted forward past any cooldown conflict.
 */
export function applyForcedBookingObservationTargets(input: {
  selected: readonly RotatingTarget[];
  forced: readonly { property_slug: string; canonical_property_name: string; tier: TargetTier }[];
  cooledKeys: ReadonlySet<string>; // `${property_slug}|${stay_date}` under 24h cooldown
}): { selected: RotatingTarget[]; forced_added: string[]; replaced: string[] } {
  const selected = input.selected.map((t) => ({ ...t }));
  const forcedSlugs = new Set(input.forced.map((f) => f.property_slug));
  const forcedAdded: string[] = [];
  const replaced: string[] = [];
  for (const force of input.forced) {
    if (selected.some((t) => t.source === "booking" && t.property_slug === force.property_slug)) continue;
    let victimIndex = -1;
    for (let i = selected.length - 1; i >= 0; i--) {
      const t = selected[i]!;
      if (t.source !== "booking") continue;
      if (forcedSlugs.has(t.property_slug)) continue;
      victimIndex = i;
      break;
    }
    if (victimIndex === -1) break; // nothing replaceable; keep plan as-is
    const victim = selected[victimIndex]!;
    let stay = victim.stay_date;
    for (let shift = 0; shift < 7 && input.cooledKeys.has(`${force.property_slug}|${stay}`); shift++) {
      stay = addDaysIso(stay, 1);
    }
    selected[victimIndex] = {
      ...victim,
      property_slug: force.property_slug,
      canonical_property_name: force.canonical_property_name,
      tier: force.tier,
      stay_date: stay,
      checkin: stay,
      reason_codes: [...victim.reason_codes, "forced_pilot_observation"]
    };
    forcedAdded.push(force.property_slug);
    replaced.push(`${victim.property_slug}|${victim.stay_date}`);
  }
  return { selected, forced_added: forcedAdded, replaced };
}

// ---------------------------------------------------------------------------
// Local read-only state helpers (same semantics as the rotating runner).

function parseCsvLine(line: string): string[] {
  const cells: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur);
  return cells;
}

interface StateSummary { history_rows: number; db_rows: number; ai_context_rows: number; duplicate_row_id_count: number }

function readState(): StateSummary {
  let history = 0; const ids = new Map<string, number>();
  if (existsSync(HISTORY_DIR)) {
    for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
      const lines = readFileSync(join(HISTORY_DIR, f), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
      const h = parseCsvLine(lines[0] ?? ""); const ri = h.indexOf("row_id");
      for (const line of lines.slice(1)) { history += 1; const id = parseCsvLine(line)[ri] ?? ""; ids.set(id, (ids.get(id) ?? 0) + 1); }
    }
  }
  let dbRows = 0;
  if (existsSync(DB_PATH)) {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try { dbRows = (db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get() as { c: number }).c; } finally { db.close(); }
  }
  let ai = 0;
  if (existsSync(AI_CONTEXT_PATH)) ai = (JSON.parse(readFileSync(AI_CONTEXT_PATH, "utf8")) as { market_signal_history_row_count?: number }).market_signal_history_row_count ?? 0;
  return { history_rows: history, db_rows: dbRows, ai_context_rows: ai, duplicate_row_id_count: [...ids.values()].filter((n) => n > 1).length };
}

function readLastCollectedAt(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(HISTORY_DIR)) return map;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const lines = readFileSync(join(HISTORY_DIR, f), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const h = parseCsvLine(lines[0]!);
    const si = h.indexOf("source"); const slugI = h.indexOf("source_slug_or_code"); const ci = h.indexOf("checkin"); const atI = h.indexOf("collected_at_jst");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const key = `${c[si]}|${c[slugI]}|${c[ci]}`;
      const at = c[atI] ?? "";
      const prev = map.get(key);
      if (prev === undefined || at > prev) map.set(key, at);
    }
  }
  return map;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function jstParts(): { iso: string; date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  const iso = `${fmt.replace(" ", "T")}+09:00`;
  return { iso, date: iso.slice(0, 10), hour: Number(iso.slice(11, 13)) };
}

// ---------------------------------------------------------------------------
// Live fetch (no append anywhere downstream).

interface BookingObservation { row: BookingPreviewRow; bucket: PilotStatusBucket }
interface JalanObservation { row: JalanImprovedPreviewRow; bucket: PilotStatusBucket }

async function collectBookingPilot(targets: readonly RotatingTarget[], debugPath: string, collectedAtJst: string): Promise<{ observations: BookingObservation[]; stopped_after_consecutive_blocks: boolean }> {
  const observations: BookingObservation[] = [];
  let consecutiveBlocked = 0;
  let stopped = false;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  try {
    for (const t of targets) {
      if (consecutiveBlocked >= MAX_CONSECUTIVE_BLOCKED_PER_SOURCE) { stopped = true; break; }
      const target = { canonicalPropertyName: t.canonical_property_name, slug: t.property_slug };
      const checkout = addDaysIso(t.checkin, 1);
      const probeUrl = buildBookingRenderedDomUrl({ ...target, checkin: t.checkin });
      const artifactDir = join(debugPath, "booking", `${t.property_slug}_${t.checkin}`);
      mkdirSync(artifactDir, { recursive: true });
      const screenshotPath = join(artifactDir, "screenshot.png");
      const page = await context.newPage();
      page.setDefaultTimeout(35_000);
      let loaded = false; let httpStatus = 0; let finalUrl = probeUrl; let pageTitle = ""; let bodyText = ""; let error = "";
      try {
        const resp = await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 35_000 });
        loaded = resp !== null; httpStatus = resp?.status() ?? 0;
        await page.waitForTimeout(5_000);
        finalUrl = page.url(); pageTitle = await page.title().catch(() => ""); bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); finalUrl = page.url() || probeUrl; }
      finally { await page.close().catch(() => undefined); }
      const signals = analyzeBookingRenderedDomSignals({ target, checkin: t.checkin, checkout, loaded, httpStatus, finalUrl, pageTitle, bodyText, error });
      const domRow: BookingRenderedDomRow = buildBookingRenderedDomRow({ target, checkin: t.checkin, checkout, probeUrl, signals, debugArtifactPath: artifactDir });
      const row = toPreviewRow(domRow, { screenshotPath, debugPath: artifactDir, collectedAtJst });
      const bucket = bookingStatusBucket(row.availability_status);
      consecutiveBlocked = bucket === "blocked" ? consecutiveBlocked + 1 : 0;
      observations.push({ row, bucket });
      writeFileSync(join(artifactDir, "probe_url_sanitized.txt"), sanitizeBookingUrl(probeUrl), "utf8");
      await new Promise((r) => setTimeout(r, 1_500));
    }
  } finally { await context.close().catch(() => undefined); await browser.close().catch(() => undefined); }
  return { observations, stopped_after_consecutive_blocks: stopped };
}

async function collectJalanPilot(targets: readonly RotatingTarget[], debugPath: string, runId: string, checkedAt: string): Promise<{ observations: JalanObservation[]; stopped_after_consecutive_blocks: boolean }> {
  // Map planner targets through the CURRENT live universe (16X-A4) — not the
  // legacy VERIFIED_JALAN_TARGETS list — so newly promoted yadIds are usable.
  const universe = new Map(liveTargets("jalan").map((t) => [t.property_slug, t]));
  const observations: JalanObservation[] = [];
  let consecutiveBlocked = 0;
  let stopped = false;
  const browser = await chromium.launch({ headless: true });
  try {
    ensureJalanDebugDirs(resolve(debugPath, "jalan"));
    for (const t of targets) {
      if (consecutiveBlocked >= MAX_CONSECUTIVE_BLOCKED_PER_SOURCE) { stopped = true; break; }
      const mapped = universe.get(t.property_slug);
      if (mapped === undefined || !mapped.source_url) continue; // cannot happen for verified targets; guarded anyway
      const probeTarget = buildJalanProbeTarget({
        canonicalPropertyName: t.canonical_property_name,
        facilityTier: t.tier === "tier_anchor_high" ? "tier_1" : "tier_2",
        jalanYadId: t.property_slug,
        sourceUrl: mapped.source_url,
        checkin: t.stay_date
      });
      const res = await collectTarget({ browser, target: probeTarget, runId, checkedAt, debugPath: resolve(debugPath, "jalan"), reportPath: "", csvPath: "" });
      const blocked = /captcha|block|security/iu.test(`${res.row.error_reason};${res.row.warning_flags}`);
      const bucket: PilotStatusBucket = blocked ? "blocked" : jalanStatusBucket(res.row.availability_status);
      consecutiveBlocked = bucket === "blocked" ? consecutiveBlocked + 1 : 0;
      observations.push({ row: res.row, bucket });
      await new Promise((r) => setTimeout(r, 1_500));
    }
  } finally { await browser.close().catch(() => undefined); }
  return { observations, stopped_after_consecutive_blocks: stopped };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ts = timestamp();
  const runId = `auto_runner16x_b_manual_live_pilot_${ts}`;
  const jst = jstParts();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(debugPath, { recursive: true });

  const before = readState();
  const lastCollectedAt = readLastCollectedAt();
  const plan = buildRotatingPlan({
    runDateIso: jst.date,
    nowIso: jst.iso,
    slotHourJst: jst.hour,
    liveTargets: liveTargets(),
    config: DEMAND_CONFIG,
    lastCollectedAt,
    caps: ROTATING_CAPS
  });

  // Cooldown keys (within 24h of now) for forced-target stay-date shifting.
  const cooled = new Set<string>();
  const nowMs = Date.parse(jst.iso);
  for (const [key, at] of lastCollectedAt) {
    const [source, slug, checkin] = key.split("|");
    if (source !== "booking") continue;
    const atMs = Date.parse(at);
    if (Number.isFinite(atMs) && nowMs - atMs < 24 * 3600 * 1000) cooled.add(`${slug}|${checkin}`);
  }
  const universeBooking = new Map(liveTargets("booking").map((t) => [t.property_slug, t]));
  const forcedDefs = FORCED_BOOKING_OBSERVATION_SLUGS
    .map((slug) => universeBooking.get(slug))
    .filter((t): t is NonNullable<typeof t> => t !== undefined)
    .map((t) => ({ property_slug: t.property_slug, canonical_property_name: t.canonical_property_name, tier: t.tier }));
  const adjusted = applyForcedBookingObservationTargets({ selected: plan.selected, forced: forcedDefs, cooledKeys: cooled });
  const selected = adjusted.selected;

  // Hard safety gate: every selected target must be live-verified (candidate_only never mixes).
  const candidateOnlyMixed = selected.filter((t) => !isLiveVerified(t.source, t.property_slug));
  if (candidateOnlyMixed.length > 0) {
    console.log("decision=manual_live_pilot_aborted_candidate_only_mixed");
    console.log(`candidate_only_mixed=${candidateOnlyMixed.length}`);
    process.exitCode = 1;
    return;
  }

  const bookingTargets = selected.filter((t) => t.source === "booking");
  const jalanTargets = selected.filter((t) => t.source === "jalan");

  const booking = await collectBookingPilot(bookingTargets, debugPath, jst.iso);
  const jalan = await collectJalanPilot(jalanTargets, debugPath, runId, jst.iso);

  const bookingCheck = buildBookingSourceLevelCheck(booking.observations.map((o) => o.row));
  const jalanCheck = buildJalanSourceLevelCheck(jalan.observations.map((o) => o.row));
  const statusCounts = summarizePilotStatuses([...booking.observations, ...jalan.observations].map((o) => o.bucket));

  const after = readState();
  const stateUnchanged = after.history_rows === before.history_rows && after.db_rows === before.db_rows && after.ai_context_rows === before.ai_context_rows;
  const anyBlocked = statusCounts.blocked > 0 || booking.stopped_after_consecutive_blocks || jalan.stopped_after_consecutive_blocks;
  const decision = !stateUnchanged
    ? "manual_live_pilot_failed_state_mutated"
    : anyBlocked
      ? "manual_live_pilot_completed_with_blocks"
      : "manual_live_pilot_complete";

  const newVerifiedObserved = [...booking.observations.map((o) => ({ source: "booking", slug: o.row.property_slug })), ...jalan.observations.map((o) => ({ source: "jalan", slug: o.row.source_slug_or_code }))]
    .filter((x) => liveTargets().some((t) => t.source === x.source && t.property_slug === x.slug && t.verification_note.includes("16X-A4")));

  const observationFor = (slug: string): BookingObservation | undefined => booking.observations.find((o) => o.row.property_slug === slug);
  const leVert = observationFor("le-vert-zao");
  const matsuo = observationFor(MATSUO_HOUSE_BOOKING_SLUG);
  const yoshidaya = observationFor("ji-tian-wu-shan-xing-shi");
  const kkr = observationFor("kkrzaohakuginso");
  const fmtObs = (o: BookingObservation | undefined): string => o === undefined ? "not_selected_in_this_slot" : `status=${o.row.availability_status} bucket=${o.bucket} warnings=[${o.row.warning_flags.join(";")}] checkin=${o.row.checkin}`;

  const out = {
    run_id: runId,
    generated_at_jst: jst.iso,
    decision,
    command: "npm run auto-runner:16x-b:manual-live-pilot",
    env_flags: { dry_run: false, history_append: false, db_sync: false, ai_context_refresh: false, publish: false, pricing_output: false, pms_output: false },
    slot_key: plan.slot_key,
    slot_index: plan.slot_index,
    caps: plan.caps,
    booking_pages: booking.observations.length,
    jalan_pages: jalan.observations.length,
    total_pages: booking.observations.length + jalan.observations.length,
    selected_distinct_stay_dates: new Set(selected.map((t) => t.stay_date)).size,
    selected_distinct_properties_by_source: {
      booking: new Set(bookingTargets.map((t) => t.property_slug)).size,
      jalan: new Set(jalanTargets.map((t) => t.property_slug)).size
    },
    forced_observation_targets: { requested: [...FORCED_BOOKING_OBSERVATION_SLUGS], forced_added: adjusted.forced_added, replaced: adjusted.replaced },
    status_counts: statusCounts,
    blocked_or_captcha_count: statusCounts.blocked,
    failed_count: statusCounts.failed,
    candidate_only_mixed_count: 0,
    duplicate_row_id_count: after.duplicate_row_id_count,
    booking_source_check: bookingCheck,
    jalan_source_check: jalanCheck,
    booking_stopped_after_consecutive_blocks: booking.stopped_after_consecutive_blocks,
    jalan_stopped_after_consecutive_blocks: jalan.stopped_after_consecutive_blocks,
    rows_appended: 0,
    db_synced: false,
    ai_context_refreshed: false,
    pricing_output_generated: false,
    pms_output_generated: false,
    history_rows_before: before.history_rows, history_rows_after: after.history_rows,
    db_rows_before: before.db_rows, db_rows_after: after.db_rows,
    ai_context_rows_before: before.ai_context_rows, ai_context_rows_after: after.ai_context_rows,
    state_unchanged: stateUnchanged,
    new_verified_targets_observed: newVerifiedObserved,
    observations: {
      le_vert_zao: fmtObs(leVert),
      matsuo_house: matsuo === undefined ? "not_selected_in_this_slot" : `${fmtObs(matsuo)}; ${MATSUO_HOUSE_SEMANTICS_NOTE}`,
      yoshidaya_booking: fmtObs(yoshidaya),
      kkr_hakuginso_booking: fmtObs(kkr)
    },
    booking_rows: booking.observations.map((o) => ({ slug: o.row.property_slug, name: o.row.canonical_property_name, checkin: o.row.checkin, status: o.row.availability_status, bucket: o.bucket, price_numeric: o.row.primary_price_numeric, dp_usage: o.row.dp_usage, warnings: o.row.warning_flags })),
    jalan_rows: jalan.observations.map((o) => ({ yad_id: o.row.source_slug_or_code, name: o.row.canonical_property_name, checkin: o.row.checkin, status: o.row.availability_status, bucket: o.bucket, price: o.row.normalized_total_price, identity_match: o.row.property_identity_match, error_reason: o.row.error_reason })),
    report_path: resolve(REPORT_DIR, `${runId}.md`),
    json_path: resolve(REPORT_DIR, `${runId}.json`),
    debug_artifact_path: debugPath
  };

  writeFileSync(out.json_path, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  writeFileSync(out.report_path, renderReport(out), "utf8");

  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "object") continue;
    console.log(`${k}=${v}`);
  }
  console.log(`status_counts=${JSON.stringify(out.status_counts)}`);
  console.log(`distinct_properties=${JSON.stringify(out.selected_distinct_properties_by_source)}`);
}

function renderReport(out: Record<string, unknown>): string {
  const obs = out["observations"] as Record<string, string>;
  const bookingRows = out["booking_rows"] as Array<Record<string, unknown>>;
  const jalanRows = out["jalan_rows"] as Array<Record<string, unknown>>;
  return `# AUTO-RUNNER16X-B Manual Live Pilot

Run: ${out["run_id"]}
Generated at JST: ${out["generated_at_jst"]}
Command: ${out["command"]}

## Decision
- decision: ${out["decision"]}
- state_unchanged (history/db/ai): ${out["state_unchanged"]}
- env_flags: ${JSON.stringify(out["env_flags"])}

## Scope
- slot: ${out["slot_key"]} (index ${out["slot_index"]})
- booking_pages: ${out["booking_pages"]} / jalan_pages: ${out["jalan_pages"]} / total: ${out["total_pages"]}
- distinct stay_dates: ${out["selected_distinct_stay_dates"]}
- distinct properties: ${JSON.stringify(out["selected_distinct_properties_by_source"])}
- forced observation targets: ${JSON.stringify(out["forced_observation_targets"])}

## Status
- status_counts: ${JSON.stringify(out["status_counts"])}
- blocked_or_captcha: ${out["blocked_or_captcha_count"]} (booking stopped early: ${out["booking_stopped_after_consecutive_blocks"]}, jalan stopped early: ${out["jalan_stopped_after_consecutive_blocks"]})
- failed: ${out["failed_count"]}
- candidate_only_mixed: ${out["candidate_only_mixed_count"]}
- duplicate_row_id: ${out["duplicate_row_id_count"]}

## Data safety (all must be unchanged/false)
- rows_appended: ${out["rows_appended"]}
- db_synced: ${out["db_synced"]} / ai_context_refreshed: ${out["ai_context_refreshed"]}
- pricing_output_generated: ${out["pricing_output_generated"]} / pms_output_generated: ${out["pms_output_generated"]}
- history rows: ${out["history_rows_before"]} -> ${out["history_rows_after"]}
- db rows: ${out["db_rows_before"]} -> ${out["db_rows_after"]}
- ai context rows: ${out["ai_context_rows_before"]} -> ${out["ai_context_rows_after"]}

## Priority observations
- le-vert-zao: ${obs["le_vert_zao"]}
- Matsuo House (booking ${MATSUO_HOUSE_BOOKING_SLUG}): ${obs["matsuo_house"]}
- 吉田屋 (booking ji-tian-wu-shan-xing-shi): ${obs["yoshidaya_booking"]}
- KKR蔵王 白銀荘 (booking kkrzaohakuginso): ${obs["kkr_hakuginso_booking"]}

## Booking rows
${bookingRows.map((r) => `- ${r["slug"]} (${r["name"]}) checkin=${r["checkin"]} status=${r["status"]} bucket=${r["bucket"]} price=${r["price_numeric"]} dp_usage=${r["dp_usage"]} warnings=${JSON.stringify(r["warnings"])}`).join("\n")}

## Jalan rows
${jalanRows.map((r) => `- ${r["yad_id"]} (${r["name"]}) checkin=${r["checkin"]} status=${r["status"]} bucket=${r["bucket"]} price=${r["price"]} identity_match=${r["identity_match"]} error=${r["error_reason"]}`).join("\n")}

## New verified targets observed (16X-A4 promotions)
${JSON.stringify(out["new_verified_targets_observed"], null, 2)}

## Safety
- one-shot manual run; verified live targets only; no candidate_only; no captcha bypass / stealth / proxy / login; blocked recorded, never retried aggressively; no history append, no DB sync, no AI context refresh, no publish, no pricing/PMS output, no scheduler change.
`;
}

if (process.argv[1]?.endsWith("runAutoRunner16xBManualLivePilot.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

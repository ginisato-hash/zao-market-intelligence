// Phase AUTO-RUNNER16X — rotating 2-hourly market refresh runner.
//
// Default mode is dry-run: builds the rotating per-slot plan and writes
// report/debug artifacts with ZERO collection/append/sync/publish. Live mode
// requires the full gate set AND PLANNER_ROTATION_ENABLED=1 AND not dry-run; it
// reuses the proven Booking rendered-DOM extractor and Jalan collectTarget, then
// the shared append/sync/context pipeline. Rakuten/Google are never collected.
// No pricing/PMS output. No launchd changes.

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
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
import { toPreviewRow, type PreviewRow as BookingPreviewRow } from "../services/autoRunnerBookingPreview";
import {
  appendHistoryRowsAtomic,
  buildAppendPlan,
  buildBookingSourceLevelCheck,
  buildJalanSourceLevelCheck,
  buildJalanMatrixFromPlannerTargets,
  buildSourceBlockReport,
  type AppendPlan,
  type ExistingHistoryKey,
  type SourceBlockReport
} from "../services/autoRunnerMarketRefresh";
import { type JalanImprovedPreviewRow } from "../services/jalanBoundedCollectionProbeImproved";
import { collectTarget, ensureJalanDebugDirs } from "./probeJalanBoundedCollectionImproved";
import { liveTargets } from "../services/marketRefreshTargetUniverse";
import {
  DAILY_PAGE_CAPACITY,
  ROTATING_CAPS,
  buildRotatingPlan,
  type RotatingDemandConfig,
  type RotatingPlan,
  type RotatingTarget
} from "../services/rotatingCollectionScopePlanner";

const HISTORY_DIR = ".data/history";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const AI_CONTEXT_PATH = ".data/ai-context/latest_market_snapshot.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-market-refresh-rotating";
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-rotating/0.1; low-volume bounded)";

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
function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

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

// Most-recent collected_at per (source|slug|checkin) for 24h cooldown.
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

function runCmd(cmd: string, args: string[], env: Record<string, string | undefined> = {}): { status: number | null; stdout: string; stderr: string; parsed: Record<string, unknown> } {
  const r = spawnSync(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8" });
  const parsed: Record<string, unknown> = {};
  for (const line of (r.stdout ?? "").split(/\r?\n/u)) { const i = line.indexOf("="); if (i > 0) parsed[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", parsed };
}

async function collectBookingLive(targets: readonly RotatingTarget[], debugPath: string, collectedAtJst: string): Promise<BookingPreviewRow[]> {
  const rows: BookingPreviewRow[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  try {
    for (const t of targets) {
      const target = { canonicalPropertyName: t.canonical_property_name, slug: t.property_slug };
      const checkout = nextDay(t.checkin);
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
      rows.push(toPreviewRow(domRow, { screenshotPath, debugPath: artifactDir, collectedAtJst }));
      writeFileSync(join(artifactDir, "probe_url_sanitized.txt"), sanitizeBookingUrl(probeUrl), "utf8");
    }
  } finally { await context.close().catch(() => undefined); await browser.close().catch(() => undefined); }
  return rows;
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function run(): Promise<void> {
  const ts = timestamp();
  const runId = `auto_runner_market_refresh_rotating_${ts}`;
  const jst = jstParts();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(debugPath, { recursive: true });

  const env = process.env;
  const dryRun = env["ZMI_ROTATING_DRY_RUN"] === "1";
  const liveGates = ["ZMI_AUTORUN_ENABLED", "COLLECT_BOOKING", "COLLECT_JALAN", "ALLOW_HISTORY_APPEND", "HISTORY_TO_DB_SYNC", "BUILD_AI_CONTEXT"].every((g) => env[g] === "1");
  const rotationEnabled = env["PLANNER_ROTATION_ENABLED"] === "1";
  const liveMode = !dryRun && liveGates && rotationEnabled;

  const preflight = readState();
  const plan: RotatingPlan = buildRotatingPlan({
    runDateIso: jst.date,
    nowIso: jst.iso,
    slotHourJst: jst.hour,
    liveTargets: liveTargets(),
    config: DEMAND_CONFIG,
    lastCollectedAt: readLastCollectedAt(),
    caps: ROTATING_CAPS
  });

  let decision = dryRun || !liveMode ? "rotating_market_refresh_dry_run_ready" : "rotating_market_refresh_pending";
  let rowsAppended = 0;
  let appendPlan: AppendPlan | null = null;
  let dbSynced = false;
  let aiContextRefreshed = false;
  let chatgptPublished = false;
  let releaseUrl = "";
  let liveExecuted = false;
  // E0: real source-block/captcha reporting. In dry-run no collection happens,
  // so there is no source to be blocked — the flag stays false legitimately.
  let sourceBlockReport: SourceBlockReport = {
    source_block_or_captcha_detected: false,
    booking_source_level_captcha_or_block: false,
    jalan_source_level_captcha_or_block: false,
    blocked_or_captcha_rejected_rows_count: 0
  };

  if (liveMode) {
    liveExecuted = true;
    const bookingTargets = plan.selected.filter((t) => t.source === "booking");
    const jalanRotating = plan.selected.filter((t) => t.source === "jalan");
    const bookingRows = await collectBookingLive(bookingTargets, debugPath, jst.iso);
    const jalanMatrix = buildJalanMatrixFromPlannerTargets(jalanRotating.map((t) => ({ source: "jalan" as const, property_slug: t.property_slug, canonical_property_name: t.canonical_property_name, stay_date: t.stay_date })));
    const jalanRows: JalanImprovedPreviewRow[] = [];
    const browser = await chromium.launch({ headless: true });
    try {
      ensureJalanDebugDirs(resolve(debugPath, "jalan"));
      for (const target of jalanMatrix.targets) {
        const res = await collectTarget({ browser, target, runId, checkedAt: jst.iso, debugPath: resolve(debugPath, "jalan"), reportPath: "", csvPath: "" });
        jalanRows.push(res.row);
      }
    } finally { await browser.close().catch(() => undefined); }

    // Source-level page caps must match the rotating per-run caps (16X-F: 12/12),
    // not the legacy 09:00-runner defaults (Booking 9), or a full source would be
    // rejected as page_cap_exceeded.
    const bookingCheck = buildBookingSourceLevelCheck(bookingRows, ROTATING_CAPS.booking_pages_per_run);
    const jalanCheck = buildJalanSourceLevelCheck(jalanRows, ROTATING_CAPS.jalan_pages_per_run);
    appendPlan = buildAppendPlan({ bookingRows, jalanRows, existingKeys: readExistingKeys(), bookingSourceCheck: bookingCheck, jalanSourceCheck: jalanCheck, bookingReportPath: "", bookingCsvPath: "" });
    sourceBlockReport = buildSourceBlockReport({ bookingSourceCheck: bookingCheck, jalanSourceCheck: jalanCheck, rejectedRows: appendPlan.rejected_rows });

    if (appendPlan.append_allowed && appendPlan.new_row_count > 0) {
      const r = appendHistoryRowsAtomic({ rows: appendPlan.approved_rows, historyDir: HISTORY_DIR, backupDir: resolve(HISTORY_DIR, ".backup", runId), historyBefore: preflight.history_rows });
      rowsAppended = r.rows_written;
      const after = readState();
      const sync = runCmd("npm", ["run", "sync:history-to-db:fresh"], { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(after.history_rows) });
      dbSynced = sync.status === 0 && Number(sync.parsed["db_after_count"]) === after.history_rows;
      if (dbSynced) { const ctx = runCmd("npm", ["run", "build:ai-context-packs"]); aiContextRefreshed = ctx.status === 0; }
    } else {
      dbSynced = true; aiContextRefreshed = true; // no-change run
    }

    const post = readState();
    const aligned = post.history_rows === post.db_rows && post.db_rows === post.ai_context_rows && post.duplicate_row_id_count === 0;
    decision = aligned ? "rotating_market_refresh_success" : "rotating_market_refresh_partial_success";

    // Publish only when gated AND aligned AND gh available.
    if (env["PUBLISH_CHATGPT_DB"] === "1" && aligned) {
      const pub = runCmd("npm", ["run", "publish:chatgpt-db"]);
      chatgptPublished = pub.status === 0 && String(pub.parsed["decision"] ?? "").includes("ready");
      releaseUrl = String(pub.parsed["release_url"] ?? "");
    }
  }

  const post = readState();
  const out = {
    run_id: runId, generated_at_jst: jst.iso, decision, dry_run: dryRun || !liveMode,
    slot_key: plan.slot_key, slot_index: plan.slot_index,
    live_collection_executed: liveExecuted,
    booking_pages: plan.selected.filter((t) => t.source === "booking").length,
    jalan_pages: plan.selected.filter((t) => t.source === "jalan").length,
    rows_appended: rowsAppended,
    skipped_identical_rows: appendPlan?.skipped_identical_rows ?? 0,
    intraday_rows: appendPlan?.intraday_rows?.length ?? 0,
    hard_conflicts: appendPlan?.hard_conflicts?.length ?? 0,
    rejected_rows_by_reason: countRejected(appendPlan),
    price_sanity_excluded_count: appendPlan?.price_sanity_excluded_records.length ?? 0,
    price_sanity_excluded_records: appendPlan?.price_sanity_excluded_records ?? [],
    db_synced: dbSynced, ai_context_refreshed: aiContextRefreshed, chatgpt_db_published: chatgptPublished, release_url: releaseUrl,
    history_rows: post.history_rows, db_rows: post.db_rows, ai_context_rows: post.ai_context_rows, duplicate_row_id_count: post.duplicate_row_id_count,
    selected_targets_by_source: plan.selected_by_source, selected_targets_by_bucket: plan.selected_by_bucket, selected_targets_by_tier: plan.selected_by_tier,
    selected_distinct_properties_by_source: plan.selected_distinct_properties_by_source,
    selected_distinct_stay_dates: plan.selected_distinct_stay_dates,
    selected_targets_by_property: plan.selected_targets_by_property,
    property_diversity_warning: plan.property_diversity_warning,
    excluded_by_cooldown: plan.excluded_by_cooldown.length, excluded_by_cap: plan.excluded_by_cap,
    excluded_by_property_diversity_cap: plan.excluded_by_property_diversity_cap,
    excluded_missing_mapping: 0,
    source_block_or_captcha_detected: sourceBlockReport.source_block_or_captcha_detected,
    booking_source_level_captcha_or_block: sourceBlockReport.booking_source_level_captcha_or_block,
    jalan_source_level_captcha_or_block: sourceBlockReport.jalan_source_level_captcha_or_block,
    blocked_or_captcha_rejected_rows_count: sourceBlockReport.blocked_or_captcha_rejected_rows_count,
    pricing_output_generated: false, pms_output_generated: false,
    caps: plan.caps,
    theoretical_daily_page_capacity: DAILY_PAGE_CAPACITY.theoretical_daily_page_capacity,
    booking_daily_capacity: DAILY_PAGE_CAPACITY.booking_daily_capacity,
    jalan_daily_capacity: DAILY_PAGE_CAPACITY.jalan_daily_capacity,
    selected_targets: plan.selected,
    report_path: resolve(REPORT_DIR, `${runId}.md`), json_path: resolve(REPORT_DIR, `${runId}.json`), csv_path: resolve(REPORT_DIR, `${runId}.csv`), debug_artifact_path: debugPath
  };

  writeJson(out.json_path, out);
  writeFileSync(out.csv_path, renderCsv(plan.selected), "utf8");
  writeFileSync(out.report_path, renderReport(out), "utf8");
  writeJson(resolve(debugPath, "rotating_plan.json"), plan);

  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "object") continue;
    console.log(`${k}=${typeof v === "boolean" ? v : v}`);
  }
}

function readExistingKeys(): ExistingHistoryKey[] {
  const keys: ExistingHistoryKey[] = [];
  if (!existsSync(HISTORY_DIR)) return keys;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const lines = readFileSync(join(HISTORY_DIR, f), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
    const h = parseCsvLine(lines[0] ?? "");
    const ri = h.indexOf("row_id"); const hi = h.indexOf("row_hash"); const si = h.indexOf("shard_month");
    const pi = h.indexOf("normalized_total_price"); const ai = h.indexOf("availability_status"); const bi = h.indexOf("basis_confidence");
    const ddi = h.indexOf("is_price_usable_for_dp_directional"); const dei = h.indexOf("is_price_excluded_from_dp");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const rawPrice = pi >= 0 ? (c[pi] ?? "") : "";
      keys.push({ row_id: c[ri] ?? "", row_hash: c[hi] ?? "", shard_month: c[si] ?? "", normalized_total_price: rawPrice.trim() === "" ? null : Number(rawPrice), availability_status: ai >= 0 ? c[ai] : undefined, basis_confidence: bi >= 0 ? c[bi] : undefined, dp_directional: ddi >= 0 ? (c[ddi] ?? "").toLowerCase() === "true" : undefined, dp_excluded: dei >= 0 ? (c[dei] ?? "").toLowerCase() === "true" : undefined });
    }
  }
  return keys;
}

function countRejected(plan: AppendPlan | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of plan?.rejected_rows ?? []) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}

function renderCsv(targets: readonly RotatingTarget[]): string {
  const header = ["source", "property_slug", "canonical_property_name", "stay_date", "bucket", "tier", "priority_score", "reason_codes"];
  const body = targets.map((t) => [t.source, t.property_slug, t.canonical_property_name, t.stay_date, t.bucket, t.tier, String(t.priority_score), t.reason_codes.join("|")].map((c) => (/[",\n]/u.test(c) ? `"${c.replace(/"/gu, '""')}"` : c)).join(","));
  return [header.join(","), ...body].join("\n") + "\n";
}

function renderReport(out: Record<string, unknown>): string {
  return `# Rotating Market Refresh (AUTO-RUNNER16X)

Generated at JST: ${out["generated_at_jst"]}
Slot: ${out["slot_key"]} (index ${out["slot_index"]})

## Decision
- decision: ${out["decision"]}
- dry_run: ${out["dry_run"]}
- live_collection_executed: ${out["live_collection_executed"]}

## Selection
- booking_pages: ${out["booking_pages"]} / jalan_pages: ${out["jalan_pages"]}
- by_source: ${JSON.stringify(out["selected_targets_by_source"])}
- by_bucket: ${JSON.stringify(out["selected_targets_by_bucket"])}
- by_tier: ${JSON.stringify(out["selected_targets_by_tier"])}
- distinct_properties_by_source: ${JSON.stringify(out["selected_distinct_properties_by_source"])}
- distinct_stay_dates: ${out["selected_distinct_stay_dates"]}
- by_property: ${JSON.stringify(out["selected_targets_by_property"])}
- property_diversity_warning: ${JSON.stringify(out["property_diversity_warning"])}
- excluded_by_cooldown: ${out["excluded_by_cooldown"]} / excluded_by_cap: ${out["excluded_by_cap"]} / excluded_by_property_diversity_cap: ${out["excluded_by_property_diversity_cap"]}

## Append / Sync / Publish
- rows_appended: ${out["rows_appended"]} / skipped_identical: ${out["skipped_identical_rows"]} / intraday: ${out["intraday_rows"]} / hard_conflicts: ${out["hard_conflicts"]}
- price_sanity_excluded_count: ${out["price_sanity_excluded_count"]}
- db_synced: ${out["db_synced"]} / ai_context_refreshed: ${out["ai_context_refreshed"]} / chatgpt_db_published: ${out["chatgpt_db_published"]}
- history/db/ai: ${out["history_rows"]}/${out["db_rows"]}/${out["ai_context_rows"]} / duplicate_row_id: ${out["duplicate_row_id_count"]}

## Safety
- pricing_output_generated: ${out["pricing_output_generated"]}
- pms_output_generated: ${out["pms_output_generated"]}
- source_block_or_captcha_detected: ${out["source_block_or_captcha_detected"]}
- booking_source_level_captcha_or_block: ${out["booking_source_level_captcha_or_block"]}
- jalan_source_level_captcha_or_block: ${out["jalan_source_level_captcha_or_block"]}
- blocked_or_captcha_rejected_rows_count: ${out["blocked_or_captcha_rejected_rows_count"]}
`;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

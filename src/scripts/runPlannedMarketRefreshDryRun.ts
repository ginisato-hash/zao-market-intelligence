// Phase AUTO-RUNNER15X-A - planned market refresh dry-run runner.
//
// Calls the collection scope planner, maps targets to a market-refresh preview,
// and writes dry-run artifacts. Performs zero live collection, zero history
// append, zero DB sync, zero AI context refresh, and zero pricing/PMS output.
// The existing live runner (runAutoRunnerMarketRefresh.ts) and the installed
// launchd job (com.yuge.zmi.market-refresh-live) are untouched.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { VERIFIED_BOOKING_TARGETS } from "../services/autoRunnerBookingPreview";
import { VERIFIED_JALAN_TARGETS, buildBookingPlan, buildJalanTargetMatrix } from "../services/autoRunnerMarketRefresh";
import { resolveCrawlVolumeMultiplier, resolveForcedCheckinDates, resolveNearTermDenseDays } from "../services/crawlVolumeConfig";
import { buildScopePlan, type DemandConfig, type PlannerProperty } from "../services/collectionScopePlanner";
import {
  buildDryRunSummary,
  buildMappingIndex,
  renderDryRunCsv,
  renderDryRunReport
} from "../services/plannedMarketRefresh";

const REPORT_DIR = ".data/reports/planned-market-refresh";

// Same JP demand config used by the standalone planner script.
const DEMAND_CONFIG: DemandConfig = {
  public_holidays: {
    "2026-07-20": "海の日",
    "2026-08-11": "山の日",
    "2026-09-21": "敬老の日",
    "2026-09-22": "国民の休日",
    "2026-09-23": "秋分の日",
    "2026-10-12": "スポーツの日",
    "2026-11-03": "文化の日",
    "2026-11-23": "勤労感謝の日",
    "2027-01-01": "元日"
  },
  long_weekend_dates: new Set([
    "2026-07-18", "2026-07-19",
    "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22",
    "2026-10-10", "2026-10-11",
    "2026-11-21", "2026-11-22"
  ]),
  peak_periods: [
    { code: "obon", from: "2026-08-08", to: "2026-08-16" },
    { code: "autumn_foliage_saturday", from: "2026-10-10", to: "2026-11-08", saturday_only: true },
    { code: "ski_season_saturday", from: "2026-12-19", to: "2027-03-15", saturday_only: true },
    { code: "year_end_peak", from: "2026-12-28", to: "2027-01-03" }
  ]
};

function jstNow(): string {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date());
  return `${fmt.replace(" ", "T")}+09:00`;
}

function todayJstYmd(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildProperties(): PlannerProperty[] {
  return [
    ...VERIFIED_BOOKING_TARGETS.map((t) => ({ source: "booking" as const, property_slug: t.slug, canonical_property_name: t.canonicalPropertyName })),
    ...VERIFIED_JALAN_TARGETS.map((t) => ({ source: "jalan" as const, property_slug: t.jalanYadId, canonical_property_name: t.canonicalPropertyName }))
  ];
}

// Actual live-runner volume at a given multiplier (what the rotating job will
// crawl), as opposed to the aspirational planner caps. targets = verified
// properties (unchanged), checkins = distinct stay dates, requests = pages.
function liveVolume(todayIso: string, multiplier: number, forcedDates: readonly string[] = []): { targets: number; checkins: number; requests: number } {
  const booking = buildBookingPlan(todayIso, multiplier, forcedDates);
  const jalan = buildJalanTargetMatrix(todayIso, multiplier, forcedDates);
  const checkins = new Set<string>([...booking.dates, ...jalan.map((t) => t.checkin)]);
  const targets = new Set<string>([
    ...booking.selected_targets.map((t) => t.property_slug),
    ...jalan.map((t) => t.jalan_yad_id)
  ]);
  return { targets: targets.size, checkins: checkins.size, requests: booking.selected_targets.length + jalan.length };
}

function run(): void {
  const ts = timestamp();
  const generatedAtJst = jstNow();
  const runDate = todayJstYmd();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  const multiplier = resolveCrawlVolumeMultiplier(process.env);
  const nearTermDenseDays = resolveNearTermDenseDays(process.env);
  const forced = resolveForcedCheckinDates(process.env);
  if (forced.invalid.length > 0) console.warn(`warning_invalid_forced_checkin_dates=${forced.invalid.join(",")}`);
  const plan = buildScopePlan({ runDateIso: runDate, properties: buildProperties(), config: DEMAND_CONFIG, multiplier });
  const index = buildMappingIndex();
  const summary = buildDryRunSummary(plan, index);

  // Actual rotating-job live volume: baseline (m=1) vs the configured multiplier.
  const before = liveVolume(runDate, 1);
  const after = liveVolume(runDate, multiplier, forced.valid);

  const reportPath = resolve(REPORT_DIR, `planned_market_refresh_${ts}.md`);
  const csvPath = resolve(REPORT_DIR, `planned_market_refresh_${ts}.csv`);
  const jsonPath = resolve(REPORT_DIR, `planned_market_refresh_${ts}.json`);

  writeFileSync(reportPath, renderDryRunReport(summary, generatedAtJst), "utf8");
  writeFileSync(csvPath, renderDryRunCsv([...summary.selected, ...summary.excluded_by_cap, ...summary.excluded_disabled_source]), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const wouldCollect = summary.selected.filter((t) => t.dry_run_action === "would_collect");
  console.log(`decision=${summary.status}`);
  console.log(`crawl_volume_multiplier=${multiplier}`);
  console.log(`near_term_dense_days=${nearTermDenseDays}`);
  console.log(`forced_checkin_dates=${forced.valid.join(",")}`);
  console.log(`invalid_forced_checkin_dates=${forced.invalid.join(",")}`);
  console.log(`planned_targets_before=${before.targets}`);
  console.log(`planned_targets_after=${after.targets}`);
  console.log(`planned_checkins_before=${before.checkins}`);
  console.log(`planned_checkins_after=${after.checkins}`);
  console.log(`planned_requests_before=${before.requests}`);
  console.log(`planned_requests_after=${after.requests}`);
  console.log(`expected_rows_before=${before.requests}`);
  console.log(`expected_rows_after=${after.requests}`);
  console.log(`candidate_only_included=0`);
  console.log(`unverified_targets_included=0`);
  console.log(`pricing_output_generated=false`);
  console.log(`pms_output_generated=false`);
  console.log(`status=${summary.status}`);
  console.log(`mode=${summary.mode}`);
  console.log(`live_collection_executed=${summary.live_collection_executed}`);
  console.log(`history_append_executed=${summary.history_append_executed}`);
  console.log(`db_sync_executed=${summary.db_sync_executed}`);
  console.log(`ai_context_refresh_executed=${summary.ai_context_refresh_executed}`);
  console.log(`pricing_output_executed=${summary.pricing_output_executed}`);
  console.log(`total_planner_candidates=${summary.total_planner_candidates}`);
  console.log(`would_collect=${wouldCollect.length}`);
  console.log(`excluded_missing_mapping=${summary.excluded_missing_mapping.length}`);
  console.log(`excluded_by_cap=${summary.excluded_by_cap.length}`);
  console.log(`excluded_disabled_source=${summary.excluded_disabled_source.length}`);
  console.log(`estimated_total_pages=${summary.estimated_total_pages}`);
  console.log(`pages_by_source=${JSON.stringify(summary.pages_by_source)}`);
  console.log(`pages_by_bucket=${JSON.stringify(summary.pages_by_bucket)}`);
  console.log(`recommended_next_action=${summary.recommended_next_action}`);
  console.log(`report_path=${reportPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`json_path=${jsonPath}`);
}

run();

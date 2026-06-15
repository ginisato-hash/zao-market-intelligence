// Phase AUTO-RUNNER14X - collection scope planner runner (dry-run only).
//
// Assembles planner properties from the existing verified Booking/Jalan collector
// targets, applies a default JP demand config, and writes a dry-run plan. It runs
// no collectors, appends no history, syncs no DB, refreshes no AI context, writes
// no property master, and emits no pricing/PMS output.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { VERIFIED_BOOKING_TARGETS } from "../services/autoRunnerBookingPreview";
import { VERIFIED_JALAN_TARGETS } from "../services/autoRunnerMarketRefresh";
import { resolveCrawlVolumeMultiplier } from "../services/crawlVolumeConfig";
import {
  buildScopePlan,
  renderPlanCsv,
  renderPlanReport,
  type DemandConfig,
  type PlannerProperty
} from "../services/collectionScopePlanner";

const REPORT_DIR = ".data/reports/collection-scope";

// Default JP 2026 demand config (public holidays + named peak periods). Injected
// here so the pure planner stays config-driven and fully testable.
const DEFAULT_DEMAND_CONFIG: DemandConfig = {
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
    "2026-07-18", "2026-07-19", // 海の日 3連休
    "2026-09-19", "2026-09-20", // 敬老の日 連休
    "2026-09-21", "2026-09-22",
    "2026-10-10", "2026-10-11", // スポーツの日 3連休
    "2026-11-21", "2026-11-22"  // 勤労感謝 3連休
  ]),
  peak_periods: [
    { code: "obon", from: "2026-08-08", to: "2026-08-16" },
    { code: "autumn_foliage_saturday", from: "2026-10-10", to: "2026-11-08", saturday_only: true },
    { code: "ski_season_saturday", from: "2026-12-19", to: "2027-03-15", saturday_only: true },
    { code: "year_end_peak", from: "2026-12-28", to: "2027-01-03" }
  ]
};

function jstNow(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
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
  const booking: PlannerProperty[] = VERIFIED_BOOKING_TARGETS.map((t) => ({
    source: "booking",
    property_slug: t.slug,
    canonical_property_name: t.canonicalPropertyName
  }));
  const jalan: PlannerProperty[] = VERIFIED_JALAN_TARGETS.map((t) => ({
    source: "jalan",
    property_slug: t.jalanYadId,
    canonical_property_name: t.canonicalPropertyName
  }));
  return [...booking, ...jalan];
}

function run(): void {
  const ts = timestamp();
  const generatedAtJst = jstNow();
  const runDate = todayJstYmd();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  const multiplier = resolveCrawlVolumeMultiplier(process.env);
  const plan = buildScopePlan({ runDateIso: runDate, properties: buildProperties(), config: DEFAULT_DEMAND_CONFIG, multiplier });

  const reportPath = resolve(REPORT_DIR, `collection_scope_plan_${ts}.md`);
  const csvPath = resolve(REPORT_DIR, `collection_scope_plan_${ts}.csv`);
  const jsonPath = resolve(REPORT_DIR, `collection_scope_plan_${ts}.json`);
  writeFileSync(reportPath, renderPlanReport(plan, generatedAtJst), "utf8");
  writeFileSync(csvPath, renderPlanCsv([...plan.selected, ...plan.excluded_by_cap, ...plan.excluded_by_disabled_source]), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  console.log(`run_date_jst=${plan.run_date_jst}`);
  console.log(`crawl_volume_multiplier=${multiplier}`);
  console.log(`page_caps=${JSON.stringify(plan.page_caps)}`);
  console.log(`total_candidates=${plan.total_candidates}`);
  console.log(`selected=${plan.selected.length}`);
  console.log(`excluded_by_cap=${plan.excluded_by_cap.length}`);
  console.log(`excluded_by_disabled_source=${plan.excluded_by_disabled_source.length}`);
  console.log(`estimated_total_pages=${plan.estimated_total_pages}`);
  console.log(`selected_pages_by_source=${JSON.stringify(plan.selected_pages_by_source)}`);
  console.log(`selected_pages_by_bucket=${JSON.stringify(plan.selected_pages_by_bucket)}`);
  console.log(`report_path=${reportPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`json_path=${jsonPath}`);
}

run();

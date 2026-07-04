// Phase ZMI PRICING-CRITICAL01 — coverage report runner (read-only).
//
// Reports, for the priority competitors AND own properties, how much of the
// D+1..D+90 window actually has an observation. No collection, no append, no DB
// write, no publish, no pricing/PMS output.
//   --group=competitor   priority competitors only
//   --group=own          own properties only
//   (no flag)            both (the combined "pricing-critical" view)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseHistoryForPriceHistory } from "../services/priceHistorySignals";
import { PRIORITY_COMPETITORS } from "../services/priorityCompetitors";
import { OWN_PROPERTY_TARGETS } from "../services/ownPropertyTargets";
import { buildJstDateRange } from "../services/priorityRecrawlTargets";
import { liveTargets } from "../services/marketRefreshTargetUniverse";
import {
  OWN_PROPERTY_THRESHOLDS,
  PRIORITY_COMPETITOR_THRESHOLDS,
  computeCoverageForProperties,
  type PropertyCoverageResult
} from "../services/priorityCoverageReport";

const HISTORY_DIR = ".data/history";
const OUT_DIR = ".data/validation";
// Booking-only in this pass — Jalan live collection is not yet wired into the
// pricing-critical recrawl runner (see PRICING-CRITICAL02 report). Never
// counted as a coverage success for jalan/rakuten.
const LIVE_COLLECT_SOURCES = new Set(["booking"]);

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function readHistoryFiles(): { filename: string; content: string }[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR).filter((f) => /^zao_signals_.*\.csv$/u.test(f)).sort().map((f) => ({ filename: f, content: readFileSync(join(HISTORY_DIR, f), "utf8") }));
}

function verifiedSourcesFor(canonicalPropertyName: string): string[] {
  return [...new Set(liveTargets().filter((t) => t.canonical_property_name === canonicalPropertyName).map((t) => t.source))];
}

function printTable(label: string, rows: PropertyCoverageResult[]): void {
  console.log(`--- ${label} coverage ---`);
  for (const r of rows) {
    console.log(`property=${r.property} coverage_30d=${r.coverage_30d} coverage_45d=${r.coverage_45d} coverage_90d=${r.coverage_90d} status=${r.status} latest_collected_at_jst=${r.latest_collected_at_jst ?? "null"} missing_dates_30d=${JSON.stringify(r.missing_dates_30d)} reasons=${JSON.stringify(r.reasons)} warnings=${JSON.stringify(r.warnings)}`);
    for (const src of ["booking", "jalan", "rakuten"]) {
      const sc = r.coverage[src];
      if (sc) console.log(`  ${src}: coverage_30d=${sc.coverage_30d} coverage_45d=${sc.coverage_45d} coverage_90d=${sc.coverage_90d} live_supported=${sc.live_supported} latest=${sc.latest_collected_at_jst ?? "null"}`);
    }
  }
}

function run(): void {
  const args = process.argv.slice(2);
  const groupArg = args.find((a) => a.startsWith("--group="))?.split("=")[1] ?? "both";
  const parsed = parseHistoryForPriceHistory(readHistoryFiles());
  const dateRange90d = buildJstDateRange();
  const todayIso = todayJst();

  const competitorCoverage = computeCoverageForProperties({
    rows: parsed.rows,
    properties: PRIORITY_COMPETITORS.map((c) => ({ canonical_property_key: c.canonical_property_key, display_name: c.display_name, canonical_property_name: c.canonical_property_name, verified_sources: verifiedSourcesFor(c.canonical_property_name) })),
    dateRange90d,
    thresholds: PRIORITY_COMPETITOR_THRESHOLDS,
    liveCollectSources: LIVE_COLLECT_SOURCES,
    todayIso
  });
  const ownCoverage = computeCoverageForProperties({
    rows: parsed.rows,
    properties: OWN_PROPERTY_TARGETS.map((p) => ({ canonical_property_key: p.canonical_property_key, display_name: p.display_name, canonical_property_name: p.canonical_property_name, verified_sources: verifiedSourcesFor(p.canonical_property_name) })),
    dateRange90d,
    thresholds: OWN_PROPERTY_THRESHOLDS,
    liveCollectSources: LIVE_COLLECT_SOURCES,
    todayIso
  });

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const generatedAtJst = jstNow();

  if (groupArg === "competitor" || groupArg === "both") {
    printTable("priority_competitor", competitorCoverage);
    writeFileSync(resolve(OUT_DIR, "priority_competitor_coverage.json"), `${JSON.stringify({ generated_at_jst: generatedAtJst, priority_competitor_coverage: competitorCoverage }, null, 2)}\n`, "utf8");
  }
  if (groupArg === "own" || groupArg === "both") {
    printTable("own_property", ownCoverage);
    writeFileSync(resolve(OUT_DIR, "own_property_coverage.json"), `${JSON.stringify({ generated_at_jst: generatedAtJst, own_property_coverage: ownCoverage }, null, 2)}\n`, "utf8");
  }

  const criticalCompetitors = competitorCoverage.filter((r) => r.status === "critical").length;
  const criticalOwn = ownCoverage.filter((r) => r.status === "critical").length;
  console.log(`decision=pricing_critical_coverage_report`);
  console.log(`group=${groupArg}`);
  console.log(`priority_competitor_critical_count=${criticalCompetitors}`);
  console.log(`own_property_critical_count=${criticalOwn}`);
  console.log(`pricing_output_generated=false`);
  console.log(`pms_output_generated=false`);
}

run();

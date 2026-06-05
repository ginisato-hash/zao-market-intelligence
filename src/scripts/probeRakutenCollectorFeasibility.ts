import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildRakutenDateScopedPlanUrl,
  buildRakutenHotelPlanUrl,
  renderRakutenFeasibilityCsv,
  renderRakutenFeasibilityReport,
  type RakutenFeasibilityDecision,
  type RakutenFeasibilityProbeRow
} from "../services/buildRakutenCollectorFeasibility";

const REPORT_DIR = ".data/reports/source-discovery";

/** Latest Phase 52X coverage artifacts used as the read-only inputs for this probe. */
const VALIDATION_CSV_PATH = ".data/reports/source-discovery/rakuten_coverage_validation_20260601_075605.csv";
const VALIDATION_REPORT_PATH =
  ".data/reports/source-discovery/rakuten_coverage_validation_report_20260601_075605.md";

/** Date-scoped probe basis (request level only): 2 adults / 1 room / 1 night. */
const PROBE_NIGHTS = 1;
const PROBE_ROOMS = 1;
const PROBE_ADULTS = 2;

/** One high-demand date + one normal date, per the Phase 53X spec. */
const PROBE_DATES = ["2026-08-10", "2026-10-10"] as const;

/** Max 3 properties. hotelNo identities confirmed reachable in Phase 52X. */
const PROBE_PROPERTIES = [
  { canonicalPropertyName: "ZAO BASE", hotelNo: "197787" },
  { canonicalPropertyName: "YuiLocalZao", hotelNo: "198027" },
  { canonicalPropertyName: "蔵王国際ホテル", hotelNo: "5723" }
] as const;

/**
 * Read-only observations captured by opening the public Rakuten plan pages (and
 * their date-parameterized variants) by hand. Every probed page was reachable
 * (HTTP 200) but only ever exposed per-person guideline ranges, never a
 * date-scoped per-room total. No prices/availability were persisted anywhere.
 */
function buildProbeRows(probeDate: string): RakutenFeasibilityProbeRow[] {
  return PROBE_PROPERTIES.map((property) => ({
    canonicalPropertyName: property.canonicalPropertyName,
    hotelNo: property.hotelNo,
    probeDate,
    planPageReachable: true,
    dateParamApplied: false,
    dateScopedRateAvailable: false,
    rateBasisObserved: "per_person_guideline_range",
    perRoomTotalExtractable: false,
    soldOutDetectable: false,
    notes:
      "Static plan page returns a next-30-days per-person tax-included guideline range; date params accepted but ignored, so no date-scoped per-room total."
  }));
}

const FEASIBILITY_DECISION: RakutenFeasibilityDecision = "manual_probe_needed";

function urlPatternsTested(): string[] {
  const sampleHotelNo = PROBE_PROPERTIES[0].hotelNo;
  const sampleDate = PROBE_DATES[0];
  return [
    `${buildRakutenHotelPlanUrl(sampleHotelNo)} (canonical static plan page — reachable, parseable)`,
    `${buildRakutenDateScopedPlanUrl({
      hotelNo: sampleHotelNo,
      checkInDate: sampleDate,
      nights: PROBE_NIGHTS,
      rooms: PROBE_ROOMS,
      adults: PROBE_ADULTS
    })} (date params accepted but NOT honored by the static page)`,
    "https://travel.rakuten.co.jp/dsearch/... ds/yado/plan per-hotel+date search (returned 0 results / generic search shell)",
    `https://hotel.travel.rakuten.co.jp/hotelinfo/vacant/${sampleHotelNo} (HTTP 404)`,
    "空室カレンダー / 検索 vacancy widget (JavaScript-rendered; not retrievable as static HTML; backing request would be a hidden/internal API — out of policy)"
  ];
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function runRakutenCollectorFeasibilityProbe(input: {
  csvPath: string;
  reportPath: string;
  generatedAt?: string;
}): { csv: string; report: string; rowCount: number; decision: RakutenFeasibilityDecision } {
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  const rows = PROBE_DATES.flatMap((date) => buildProbeRows(date));
  const csv = renderRakutenFeasibilityCsv(rows);
  const report = renderRakutenFeasibilityReport({
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    validationCsvPath: VALIDATION_CSV_PATH,
    validationReportPath: VALIDATION_REPORT_PATH,
    csvPath: input.csvPath,
    rows,
    urlPatternsTested: urlPatternsTested(),
    decision: FEASIBILITY_DECISION
  });

  writeFileSync(resolve(input.csvPath), csv, "utf-8");
  writeFileSync(resolve(input.reportPath), report, "utf-8");

  return { csv, report, rowCount: rows.length, decision: FEASIBILITY_DECISION };
}

function main(): void {
  const ts = timestamp();
  const csvPath = resolve(REPORT_DIR, `rakuten_collector_feasibility_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_collector_feasibility_${ts}.md`);

  const result = runRakutenCollectorFeasibilityProbe({ csvPath, reportPath });

  console.log(`csv_path=${csvPath}`);
  console.log(`report_path=${reportPath}`);
  console.log(`probe_rows=${result.rowCount}`);
  console.log(`feasibility_decision=${result.decision}`);
}

if (process.argv[1]?.endsWith("probeRakutenCollectorFeasibility.ts")) {
  main();
}

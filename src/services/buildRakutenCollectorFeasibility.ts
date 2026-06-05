/**
 * Rakuten collector feasibility probe (Phase 53X).
 *
 * Pure helpers + renderers for a tiny read-only feasibility probe: can a
 * date-scoped, 2-adult / 1-room / 1-night, tax-included TOTAL be safely
 * extracted from public Rakuten Travel pages without JS execution, paid APIs,
 * proxies, login cookies, or hidden/internal APIs?
 *
 * This module performs NO network calls and NO database writes. It only builds
 * URLs and renders local debug artifacts from observations captured by hand.
 */
export { extractRakutenHotelNo } from "./enrichZaoMissingSourceCandidates";

export type RakutenFeasibilityDecision =
  | "not_ready"
  | "manual_probe_needed"
  | "limited_collector_ready";

export interface RakutenDateScopedPlanParams {
  hotelNo: string;
  checkInDate: string; // YYYY-MM-DD
  nights: number;
  rooms: number;
  adults: number;
}

/** Canonical first-party hotel page for a Rakuten hotelNo. */
export function buildRakutenHotelPlanUrl(hotelNo: string): string {
  if (!/^\d+$/u.test(hotelNo)) {
    throw new Error(`invalid Rakuten hotelNo: ${hotelNo}`);
  }
  return `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${hotelNo}`;
}

/**
 * Build the date-scoped plan URL using Rakuten's documented public query
 * parameters (check-in year/month/day, nights, rooms, adults). NOTE: the probe
 * found these params are accepted but NOT honored by the static plan page, so
 * this URL is only useful as a probe target, not a price source.
 */
export function buildRakutenDateScopedPlanUrl(params: RakutenDateScopedPlanParams): string {
  if (!/^\d+$/u.test(params.hotelNo)) {
    throw new Error(`invalid Rakuten hotelNo: ${params.hotelNo}`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(params.checkInDate);
  if (!match) {
    throw new Error(`checkInDate must be YYYY-MM-DD: ${params.checkInDate}`);
  }
  const [, year, month, day] = match;
  for (const [label, value] of [
    ["nights", params.nights],
    ["rooms", params.rooms],
    ["adults", params.adults]
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive integer`);
    }
  }
  const query = new URLSearchParams({
    f_nen1: year as string,
    f_tuki1: month as string,
    f_hi1: day as string,
    f_hak: String(params.nights),
    f_heya_su: String(params.rooms),
    f_otona_su: String(params.adults)
  });
  return `${buildRakutenHotelPlanUrl(params.hotelNo)}?${query.toString()}`;
}

export const RAKUTEN_FEASIBILITY_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "probe_date",
  "plan_page_reachable",
  "date_param_applied",
  "date_scoped_rate_available",
  "rate_basis_observed",
  "per_room_total_extractable",
  "sold_out_detectable",
  "notes"
] as const;

export type RakutenFeasibilityCsvHeader = (typeof RAKUTEN_FEASIBILITY_CSV_HEADERS)[number];
export type RakutenFeasibilityCsvRecord = Record<RakutenFeasibilityCsvHeader, string>;

export interface RakutenFeasibilityProbeRow {
  canonicalPropertyName: string;
  hotelNo: string;
  probeDate: string;
  planPageReachable: boolean;
  dateParamApplied: boolean;
  dateScopedRateAvailable: boolean;
  rateBasisObserved: string;
  perRoomTotalExtractable: boolean;
  soldOutDetectable: boolean;
  notes: string;
}

const yn = (value: boolean): string => (value ? "yes" : "no");

export function renderRakutenFeasibilityCsv(rows: RakutenFeasibilityProbeRow[]): string {
  const header = RAKUTEN_FEASIBILITY_CSV_HEADERS.join(",");
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.probeDate,
      yn(row.planPageReachable),
      yn(row.dateParamApplied),
      yn(row.dateScopedRateAvailable),
      row.rateBasisObserved,
      yn(row.perRoomTotalExtractable),
      yn(row.soldOutDetectable),
      row.notes
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header, ...body].join("\n") + "\n";
}

export function renderRakutenFeasibilityReport(input: {
  generatedAt: string;
  validationCsvPath: string;
  validationReportPath: string;
  csvPath: string;
  rows: RakutenFeasibilityProbeRow[];
  urlPatternsTested: string[];
  decision: RakutenFeasibilityDecision;
}): string {
  const probeLines = input.rows.map(
    (row) =>
      `- ${row.canonicalPropertyName} / ${row.hotelNo} / ${row.probeDate}: reachable=${yn(row.planPageReachable)}, date_scoped_rate=${yn(row.dateScopedRateAvailable)}, basis=${row.rateBasisObserved}, per_room_total=${yn(row.perRoomTotalExtractable)}`
  );

  return [
    "# Rakuten Collector Feasibility Probe",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- feasibility_decision=${input.decision}`,
    "- Rakuten hotelNo identities and first-party URL patterns are stable and machine-extractable (validated in Phase 52X).",
    "- Public hotel plan pages are reachable and parseable from static HTML.",
    "- BLOCKER: static plan pages return only generic per-person guideline ranges; a date-scoped 2-adult/1-room/1-night tax-included TOTAL is not available without executing the JavaScript vacancy search.",
    "",
    "## 2. Inputs used",
    "",
    `- validation_csv=${input.validationCsvPath}`,
    `- validation_report=${input.validationReportPath}`,
    `- feasibility_csv=${input.csvPath}`,
    "- Method: opened public Rakuten pages only (no login, no paid API, no proxy, no hidden API). No DB writes; no price/availability snapshots.",
    "",
    "## 3. Probe properties / dates",
    "",
    ...probeLines,
    "",
    "## 4. URL patterns tested",
    "",
    ...input.urlPatternsTested.map((pattern) => `- ${pattern}`),
    "",
    "## 5. Can reach plan page?",
    "",
    "- Yes. https://hotel.travel.rakuten.co.jp/hotelinfo/plan/[hotelNo] returns a full static plan page for every probed hotelNo (HTTP 200).",
    "",
    "## 6. Can set / check date?",
    "",
    "- Partially. The documented query params (f_nen1/f_tuki1/f_hi1 check-in, f_hak nights, f_heya_su rooms, f_otona_su adults) are accepted but NOT honored by the static plan page.",
    '- The plan page explicitly labels its prices as a guideline over "the next 30 days from today" (本日より最短で設定されている直近30日間の目安), so the requested check-in date is not reflected.',
    "- True date-scoped results sit behind the 空室カレンダー / 検索 vacancy search, which is JavaScript-rendered and not retrievable as static HTML.",
    "",
    "## 7. Can identify target hotel scope?",
    "",
    "- Yes. The hotelNo in the URL path uniquely scopes a single hotel; Phase 52X confirmed each hotelNo resolves to the correct Zao Onsen property.",
    "",
    "## 8. Can identify 2-adult / 1-room / 1-night basis?",
    "",
    "- Only at the request level (the f_otona_su=2 / f_heya_su=1 / f_hak=1 params express the intended basis).",
    "- The returned static content does NOT lock to that basis: it shows per-occupancy tiers (1名利用時 / 2名利用時 ...) as per-person ranges, not a single 1-room/2-adult/1-night total.",
    "",
    "## 9. Can extract tax-included total price safely?",
    "",
    "- No (from static HTML). Only per-person tax-included guideline ranges are shown, e.g. \"5,455円/人 (消費税込6,000円/人)\".",
    "- Deriving a per-room total by multiplying per-person × 2 is unsafe: figures are undated ranges, vary by plan/meal/occupancy tier, and carry no availability lock for the target date.",
    "",
    "## 10. Failure modes",
    "",
    "- Date query params ignored on the static plan page (generic 30-day guideline returned).",
    "- ds/yado/plan search endpoint returned 0 results / a generic search shell for the per-hotel+date query.",
    "- hotelinfo/vacant/[hotelNo] returned HTTP 404.",
    "- Per-person occupancy-tier basis cannot be converted to a reliable per-room total.",
    "- The real date-scoped price is behind a JS vacancy widget; scraping its backing request would be a hidden/internal API, which is out of policy.",
    "",
    "## 11. Feasibility decision",
    "",
    `- ${input.decision}`,
    "- Rationale: identity + URL layer is ready, but the date-scoped tax-included per-room total is not safely extractable from public static HTML within the allowed constraints.",
    "",
    "## 12. Recommended next step",
    "",
    "- Run a one-off MANUAL browser probe (human-driven) of the 空室カレンダー / vacancy result for 1-2 hotelNos and one date to capture the exact date-scoped per-room total markup and its public (non-login, non-hidden) URL, if one exists.",
    "- Decide explicitly whether a JS-capable but policy-compliant fetch (e.g. a headless render of a public page, no login/proxy) is acceptable for Rakuten; if not, keep Rakuten as identity-coverage only and continue Jalan as the sole DP price source.",
    "- Do not enable any Rakuten price collection until a date-scoped tax-included per-room total is proven extractable within policy.",
    ""
  ].join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }
  return value;
}

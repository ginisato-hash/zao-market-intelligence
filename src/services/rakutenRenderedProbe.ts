/**
 * Rakuten rendered vacancy-calendar probe (Phase 54X).
 *
 * Pure, network-free helpers + renderers for a tiny feasibility probe that asks
 * one question: can a public, Playwright-RENDERED Rakuten page expose a safe
 * date-scoped 2-adult / 1-room / 1-night tax-included TOTAL price (with property
 * identity, date scope, and availability state) using only the visible public
 * UI — no login, no paid proxy, no CAPTCHA bypass, no private/internal APIs?
 *
 * This module performs NO network calls and NO database writes. The Playwright
 * interaction lives in src/scripts/probeRakutenRenderedVacancy.ts; here we only
 * build URLs, classify rendered DOM text, and render local debug reports.
 */
export { extractRakutenHotelNo } from "./enrichZaoMissingSourceCandidates";

export type RakutenRenderedClassification =
  | "rendered_date_scoped_total_found"
  | "rendered_per_person_only"
  | "rendered_no_plans"
  | "rendered_sold_out"
  | "date_scope_unverified"
  | "basis_unverified"
  | "blocked_or_failed";

export type RakutenRenderedFeasibilityDecision =
  | "limited_rendered_collector_ready"
  | "manual_browser_flow_needed"
  | "not_ready";

export type RakutenRenderedPriceBasis = "total_tax_included" | "per_person_only" | "none";

/** Canonical first-party Rakuten hotel overview page for a hotelNo. */
export function buildRakutenHotelUrl(hotelNo: string): string {
  if (!/^\d+$/u.test(hotelNo)) {
    throw new Error(`invalid Rakuten hotelNo: ${hotelNo}`);
  }
  return `https://travel.rakuten.co.jp/HOTEL/${hotelNo}/`;
}

/**
 * Parse the first plausible JPY amount out of a price fragment. NFKC folds
 * full-width digits/commas (６，０００ → 6,000) so rendered Rakuten markup is
 * handled. Returns null when no positive amount is present.
 */
export function normalizeRakutenPriceText(text: string): number | null {
  const normalized = text.normalize("NFKC");
  const match = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,})/u.exec(normalized);
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw.replace(/,/gu, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface RakutenRenderedPriceDetection {
  basis: RakutenRenderedPriceBasis;
  taxIncludedTotalText?: string;
  taxIncludedTotalValue?: number;
  perPersonText?: string;
  perPersonValue?: number;
}

// A genuine per-room total appears next to an explicit 合計/総額（税込）or a
// "2名合計 / 2名で…税込" label in the rendered plan results.
const TOTAL_TAX_PATTERN = /(合計\s*[（(]税込[)）]|総額\s*[（(]税込[)）]|2名合計|2名で[^。\n]{0,24}税込)/u;
// A per-person basis is signalled by 円/人 ranges or per-occupancy tier labels.
const PER_PERSON_PATTERN = /([0-9,]+\s*円\s*[／/]\s*人|1名あたり|お一人様|大人1名|[0-9]名利用時)/u;
const PRICE_NEAR_PATTERN = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u;

/**
 * Decide whether the rendered text exposes a per-room tax-included TOTAL, only
 * a per-person figure, or no extractable price basis at all. Total takes
 * precedence: if an explicit 合計（税込）total is present we trust it over any
 * incidental per-person range elsewhere on the page.
 */
export function detectRakutenRenderedPriceBasis(rawText: string): RakutenRenderedPriceDetection {
  const text = rawText.normalize("NFKC");

  const totalMatch = TOTAL_TAX_PATTERN.exec(text);
  if (totalMatch && totalMatch.index !== undefined) {
    const window = text.slice(totalMatch.index, totalMatch.index + 140);
    const priceMatch = PRICE_NEAR_PATTERN.exec(window);
    if (priceMatch?.[0] !== undefined) {
      const value = normalizeRakutenPriceText(priceMatch[0]);
      return {
        basis: "total_tax_included",
        taxIncludedTotalText: priceMatch[0],
        ...(value !== null ? { taxIncludedTotalValue: value } : {})
      };
    }
  }

  const perPersonMatch = PER_PERSON_PATTERN.exec(text);
  if (perPersonMatch && perPersonMatch.index !== undefined) {
    const window = text.slice(Math.max(0, perPersonMatch.index - 48), perPersonMatch.index + 64);
    const priceMatch = PRICE_NEAR_PATTERN.exec(window);
    const value = priceMatch?.[0] !== undefined ? normalizeRakutenPriceText(priceMatch[0]) : null;
    return {
      basis: "per_person_only",
      ...(priceMatch?.[0] !== undefined ? { perPersonText: priceMatch[0] } : {}),
      ...(value !== null ? { perPersonValue: value } : {})
    };
  }

  return { basis: "none" };
}

export interface RakutenRenderedSignals {
  /** Page loaded and rendered (HTTP-OK, DOM available). */
  reachable: boolean;
  /** captcha / block / rate-limit / login / 404 — any hard access failure. */
  accessIssue: boolean;
  /** Page clearly states no plans / no matching plans for the scope. */
  noPlans: boolean;
  /** Page clearly states the date is sold out / 満室. */
  soldOut: boolean;
  /** Requested stay date is reflected in the rendered DOM or result URL. */
  dateScopeDetected: boolean;
  /** Price basis detected in the rendered DOM. */
  priceBasis: RakutenRenderedPriceBasis;
}

/**
 * Pure classification, never throws. Precedence:
 *   1. access failure / not loaded  → blocked_or_failed
 *   2. explicit no-plans            → rendered_no_plans
 *   3. explicit sold-out            → rendered_sold_out
 *   4. date scope not confirmed     → date_scope_unverified
 *   5. total tax-included present   → rendered_date_scoped_total_found
 *   6. per-person only present      → rendered_per_person_only
 *   7. otherwise                    → basis_unverified
 */
export function classifyRakutenRenderedProbe(signals: RakutenRenderedSignals): RakutenRenderedClassification {
  if (!signals.reachable || signals.accessIssue) {
    return "blocked_or_failed";
  }
  if (signals.noPlans) {
    return "rendered_no_plans";
  }
  if (signals.soldOut) {
    return "rendered_sold_out";
  }
  if (!signals.dateScopeDetected) {
    return "date_scope_unverified";
  }
  if (signals.priceBasis === "total_tax_included") {
    return "rendered_date_scoped_total_found";
  }
  if (signals.priceBasis === "per_person_only") {
    return "rendered_per_person_only";
  }
  return "basis_unverified";
}

/**
 * Overall feasibility decision from the per-row classifications.
 * - limited_rendered_collector_ready: at least one row exposed a date-scoped
 *   2-adult/1-room/1-night tax-included total in the rendered DOM.
 * - manual_browser_flow_needed: no total found, but at least one page rendered
 *   far enough that the flow looks possible with manual selector observation.
 * - not_ready: nothing rendered usefully (all blocked/failed or no-plans only).
 */
export function decideRakutenRenderedFeasibility(
  classifications: RakutenRenderedClassification[]
): RakutenRenderedFeasibilityDecision {
  if (classifications.includes("rendered_date_scoped_total_found")) {
    return "limited_rendered_collector_ready";
  }
  const flowLooksPossible = classifications.some((c) =>
    c === "rendered_per_person_only" ||
    c === "date_scope_unverified" ||
    c === "basis_unverified" ||
    c === "rendered_sold_out"
  );
  return flowLooksPossible ? "manual_browser_flow_needed" : "not_ready";
}

export const RAKUTEN_RENDERED_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "stay_date",
  "url_tested",
  "reachable",
  "rendered_hotel_name",
  "date_scope_detected",
  "room_count_detected",
  "adult_count_detected",
  "night_count_detected",
  "tax_included_total_detected",
  "per_person_price_detected",
  "availability_status",
  "classification",
  "risk_note",
  "debug_artifact_path"
] as const;

export type RakutenRenderedCsvHeader = (typeof RAKUTEN_RENDERED_CSV_HEADERS)[number];

export interface RakutenRenderedProbeRow {
  canonicalPropertyName: string;
  hotelNo: string;
  stayDate: string;
  urlTested: string;
  reachable: boolean;
  renderedHotelName: string;
  dateScopeDetected: boolean;
  roomCountDetected: string;
  adultCountDetected: string;
  nightCountDetected: string;
  taxIncludedTotalDetected: string;
  perPersonPriceDetected: string;
  availabilityStatus: string;
  classification: RakutenRenderedClassification;
  riskNote: string;
  debugArtifactPath: string;
}

const yn = (value: boolean): string => (value ? "yes" : "no");

export function renderRakutenRenderedCsv(rows: RakutenRenderedProbeRow[]): string {
  const header = RAKUTEN_RENDERED_CSV_HEADERS.join(",");
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.stayDate,
      row.urlTested,
      yn(row.reachable),
      row.renderedHotelName,
      yn(row.dateScopeDetected),
      row.roomCountDetected,
      row.adultCountDetected,
      row.nightCountDetected,
      row.taxIncludedTotalDetected,
      row.perPersonPriceDetected,
      row.availabilityStatus,
      row.classification,
      row.riskNote,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header, ...body].join("\n") + "\n";
}

export function renderRakutenRenderedReport(input: {
  generatedAt: string;
  feasibilityCsvPath: string;
  validationCsvPath: string;
  priorFeasibilityReportPath: string;
  debugRootPath: string;
  rows: RakutenRenderedProbeRow[];
  decision: RakutenRenderedFeasibilityDecision;
  executionNote: string;
}): string {
  const counts = new Map<RakutenRenderedClassification, number>();
  for (const row of input.rows) {
    counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  }
  const countLine = (c: RakutenRenderedClassification): string => `- ${c}=${counts.get(c) ?? 0}`;

  const probeLines = input.rows.map(
    (row) =>
      `- ${row.canonicalPropertyName} / ${row.hotelNo} / ${row.stayDate}: classification=${row.classification}, reachable=${yn(row.reachable)}, date_scope=${yn(row.dateScopeDetected)}, total=${row.taxIncludedTotalDetected || "—"}, per_person=${row.perPersonPriceDetected || "—"}, availability=${row.availabilityStatus || "—"}`
  );

  return [
    "# Rakuten Rendered Vacancy-Calendar Probe (Phase 54X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- feasibility_decision=${input.decision}`,
    "- Goal: test whether a public, Playwright-RENDERED Rakuten page exposes a date-scoped 2-adult / 1-room / 1-night tax-included TOTAL with property identity, date scope, and availability state.",
    "- Method: public-browser rendering only (no login, no paid proxy, no CAPTCHA bypass, no stealth, no private/internal API). No DB writes; no price/availability snapshots.",
    `- Execution: ${input.executionNote}`,
    "",
    "## 2. Inputs used",
    "",
    `- prior_coverage_validation_csv=${input.validationCsvPath}`,
    `- prior_static_feasibility_report=${input.priorFeasibilityReportPath}`,
    `- rendered_feasibility_csv=${input.feasibilityCsvPath}`,
    `- debug_artifact_root=${input.debugRootPath}`,
    "",
    "## 3. Probe properties / dates",
    "",
    ...probeLines,
    "",
    "## 4. Classification counts",
    "",
    countLine("rendered_date_scoped_total_found"),
    countLine("rendered_per_person_only"),
    countLine("rendered_no_plans"),
    countLine("rendered_sold_out"),
    countLine("date_scope_unverified"),
    countLine("basis_unverified"),
    countLine("blocked_or_failed"),
    "",
    "## 5. Rendered flow observations",
    "",
    "- Each probe opened the public HOTEL/[hotelNo]/ overview page, then attempted the visible 検索 / 空室 search flow (set check-in date, 1 night, 1 room, 2 adults) and read the rendered DOM text.",
    "- A date-scoped per-room total is only credited when an explicit 合計（税込）/ 2名合計 figure is present alongside the requested stay date in the rendered DOM.",
    "",
    "## 6. Feasibility decision",
    "",
    `- ${input.decision}`,
    decisionRationale(input.decision),
    "",
    "## 7. Recommended next step",
    "",
    ...recommendedNextStep(input.decision),
    ""
  ].join("\n");
}

function decisionRationale(decision: RakutenRenderedFeasibilityDecision): string {
  switch (decision) {
    case "limited_rendered_collector_ready":
      return "- Rationale: at least one property/date exposed a date-scoped 2-adult/1-room/1-night tax-included total in the rendered public DOM with property identity and date scope.";
    case "manual_browser_flow_needed":
      return "- Rationale: the rendered public flow appears reachable but no date-scoped per-room total was confirmed automatically; selectors/steps need manual browser observation before a collector can be wired.";
    case "not_ready":
      return "- Rationale: rendered public pages did not expose a date-scoped per-room total (blocked, failed, or no usable plan results within the allowed constraints).";
  }
}

function recommendedNextStep(decision: RakutenRenderedFeasibilityDecision): string[] {
  switch (decision) {
    case "limited_rendered_collector_ready":
      return [
        "- Capture the exact rendered selectors for the date-scoped total and gate a separate, explicitly-approved read-only rendered collector behind human sign-off.",
        "- Keep DB writes, snapshots, and PMS upload OUT of scope until that collector is approved."
      ];
    case "manual_browser_flow_needed":
      return [
        "- Run a human-driven browser session on 1-2 hotelNos + one date to record the exact visible UI path and selectors that surface the date-scoped per-room total and availability.",
        "- Re-run this probe with the observed selectors before deciding on a rendered collector. Do not enable any Rakuten price collection until a date-scoped tax-included per-room total is proven extractable within policy."
      ];
    case "not_ready":
      return [
        "- Re-run in a browser-capable environment if execution was blocked here; otherwise keep Rakuten as identity-coverage only and continue Jalan as the sole DP price source.",
        "- Do not enable any Rakuten price collection until a date-scoped tax-included per-room total is proven extractable within policy."
      ];
  }
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }
  return value;
}

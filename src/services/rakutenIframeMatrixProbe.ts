/**
 * Rakuten iframe f_syu × f_hak matrix probe (Phase 59X).
 *
 * Phase 58X isolated the failure to the f_syu room-type token: near-term and
 * far-future dates failed identically with 「該当する部屋タイプが見つかりません」.
 * This phase builds a controlled matrix for ZAO BASE / 197787 to disambiguate
 * whether the cause is the f_syu token value, the f_hak value, or both:
 *   f_syu ∈ { live-extracted, known zaobase3, all, omitted }
 *   f_hak ∈ { blank, 1 }
 *
 * Pure helpers + renderers only. No network calls, no DB writes. The Playwright
 * rendering (incl. live f_syu extraction) lives in
 * src/scripts/probeRakutenIframeMatrix.ts.
 */
import {
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  type RakutenIframeEvidence
} from "./rakutenKnownIframeNearTermProbe";

export {
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  type RakutenIframeEvidence
};

const AVAILABILITY_GRID_PATTERN = /(残室\s*1\s*以上|残室なし|空室数をクリック|空室数をクリックすると)/u;

/**
 * True when the rendered text is the actual month vacancy calendar widget
 * (availability legend / "click the vacancy count" instruction), as opposed to
 * a no-matching-room-type page or the undated per-person guideline.
 */
export function detectAvailabilityGrid(text: string): boolean {
  return AVAILABILITY_GRID_PATTERN.test(text.normalize("NFKC"));
}

export const F_SYU_VARIANTS = [
  "live_extracted_f_syu",
  "known_zaobase3",
  "all",
  "omitted_f_syu"
] as const;
export type FSyuVariant = (typeof F_SYU_VARIANTS)[number];

export const F_HAK_VARIANTS = ["blank_f_hak", "f_hak_1"] as const;
export type FHakVariant = (typeof F_HAK_VARIANTS)[number];

export interface MatrixVariant {
  fSyuVariant: FSyuVariant;
  fSyuValue: string;
  fHakVariant: FHakVariant;
  fHakValue: string;
  stayDate: string;
  generatedUrl: string;
}

export type RakutenMatrixClassification =
  | "matrix_date_scoped_total_found"
  | "matrix_date_scoped_per_person_found"
  | "matrix_no_plan_or_sold_out"
  | "matrix_no_matching_room_type"
  | "matrix_date_scope_unverified"
  | "matrix_basis_unverified"
  | "matrix_url_failed";

export type RakutenMatrixDecision =
  | "rakuten_matrix_ready"
  | "rakuten_matrix_basis_mapping_needed"
  | "rakuten_matrix_not_ready";

export interface RakutenMatrixProbeRow {
  canonicalPropertyName: string;
  hotelNo: string;
  stayDate: string;
  fSyuVariant: FSyuVariant;
  fSyuValue: string;
  fHakVariant: FHakVariant;
  fHakValue: string;
  generatedUrl: string;
  reachable: boolean;
  dateScopeDetected: boolean;
  roomCountDetected: boolean;
  adultCountDetected: boolean;
  nightCountDetected: boolean;
  taxIncludedTotalDetected: string;
  perPersonPriceDetected: string;
  availabilityStatus: string;
  classification: RakutenMatrixClassification;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_MATRIX_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "stay_date",
  "f_syu_variant",
  "f_syu_value",
  "f_hak_variant",
  "f_hak_value",
  "generated_url",
  "reachable",
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

function stayDateToRakutenDate(stayDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(stayDate);
  if (!match) throw new Error(`stayDate must be YYYY-MM-DD: ${stayDate}`);
  return `${match[1]}${match[2]}${match[3]}`;
}

function resolveSyuValue(variant: FSyuVariant, liveSyuValue: string): string | null {
  switch (variant) {
    case "live_extracted_f_syu":
      return liveSyuValue;
    case "known_zaobase3":
      return "zaobase3";
    case "all":
      return "all";
    case "omitted_f_syu":
      return null;
  }
}

function resolveHakValue(variant: FHakVariant): string {
  return variant === "f_hak_1" ? "1" : "";
}

/**
 * Build one matrix iframe URL from a structural base URL. Preserves identity
 * params (f_no, f_otona_su=2, f_heya_su=1, TB_iframe=true, f_thick=1), sets
 * f_hizuke, and applies the requested f_syu / f_hak variant. f_syu=null removes
 * the param entirely; f_hak="" leaves a blank f_hak.
 */
export function buildMatrixIframeUrl(input: {
  baseUrl: string;
  fSyuValue: string | null;
  fHakValue: string;
  stayDate: string;
}): string {
  const url = new URL(input.baseUrl.replace(/&amp;/gu, "&"));
  const params = url.searchParams;
  params.set("TB_iframe", "true");
  params.set("f_thick", "1");
  params.set("f_otona_su", "2");
  params.set("f_heya_su", "1");
  params.set("f_hizuke", stayDateToRakutenDate(input.stayDate));
  if (input.fSyuValue === null) {
    params.delete("f_syu");
  } else {
    params.set("f_syu", input.fSyuValue);
  }
  params.set("f_hak", input.fHakValue);
  return url.toString();
}

/** Build the 8-row initial matrix (4 f_syu × 2 f_hak) for a single date. */
export function buildMatrixVariants(input: {
  baseUrl: string;
  liveSyuValue: string;
  stayDate: string;
}): MatrixVariant[] {
  const variants: MatrixVariant[] = [];
  for (const fSyuVariant of F_SYU_VARIANTS) {
    const fSyuValueOrNull = resolveSyuValue(fSyuVariant, input.liveSyuValue);
    for (const fHakVariant of F_HAK_VARIANTS) {
      const fHakValue = resolveHakValue(fHakVariant);
      const generatedUrl = buildMatrixIframeUrl({
        baseUrl: input.baseUrl,
        fSyuValue: fSyuValueOrNull,
        fHakValue,
        stayDate: input.stayDate
      });
      variants.push({
        fSyuVariant,
        fSyuValue: fSyuValueOrNull ?? "",
        fHakVariant,
        fHakValue,
        stayDate: input.stayDate,
        generatedUrl
      });
    }
  }
  return variants;
}

export function classifyRakutenMatrixProbe(input: {
  reachable: boolean;
  noMatchingRoomType: boolean;
  availabilityGridDetected: boolean;
  evidence: RakutenIframeEvidence;
}): RakutenMatrixClassification {
  const e = input.evidence;
  if (!input.reachable) return "matrix_url_failed";
  if (input.noMatchingRoomType) return "matrix_no_matching_room_type";
  if (e.soldOutOrNoPlanDetected) return "matrix_no_plan_or_sold_out";
  // A rendered month vacancy calendar (availability grid) is useful non-empty
  // evidence even when no single date-scoped total is confirmed: the basis just
  // needs further mapping (the total sits one click deeper).
  if (input.availabilityGridDetected) return "matrix_basis_unverified";
  // Without a confirmed date scope we cannot trust that any total/per-person
  // figure is scoped to the requested stay date.
  if (!e.dateScopeDetected) return "matrix_date_scope_unverified";
  if (
    e.propertyDetected &&
    e.adultCountDetected &&
    e.roomCountDetected &&
    e.nightCountDetected &&
    e.taxIncludedTotalDetected &&
    e.availabilityStatus === "available"
  ) {
    return "matrix_date_scoped_total_found";
  }
  if (e.propertyDetected && e.perPersonPriceDetected && !e.taxIncludedTotalDetected) {
    return "matrix_date_scoped_per_person_found";
  }
  return "matrix_basis_unverified";
}

/** A classification carrying useful non-empty date/price/availability evidence. */
export function isUsefulMatrixClassification(c: RakutenMatrixClassification): boolean {
  return (
    c === "matrix_date_scoped_total_found" ||
    c === "matrix_date_scoped_per_person_found" ||
    c === "matrix_no_plan_or_sold_out" ||
    c === "matrix_basis_unverified"
  );
}

export function decideRakutenMatrixFeasibility(
  classifications: RakutenMatrixClassification[]
): RakutenMatrixDecision {
  if (classifications.includes("matrix_date_scoped_total_found")) {
    return "rakuten_matrix_ready";
  }
  const usefulEvidence = classifications.some(
    (c) =>
      c === "matrix_date_scoped_per_person_found" ||
      c === "matrix_no_plan_or_sold_out" ||
      c === "matrix_basis_unverified"
  );
  return usefulEvidence ? "rakuten_matrix_basis_mapping_needed" : "rakuten_matrix_not_ready";
}

export function renderRakutenMatrixCsv(rows: RakutenMatrixProbeRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.stayDate,
      row.fSyuVariant,
      row.fSyuValue,
      row.fHakVariant,
      row.fHakValue,
      row.generatedUrl,
      yn(row.reachable),
      yn(row.dateScopeDetected),
      yn(row.roomCountDetected),
      yn(row.adultCountDetected),
      yn(row.nightCountDetected),
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
  return [RAKUTEN_MATRIX_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenMatrixReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  liveExtractedHref: string;
  liveSyuValue: string;
  rows: RakutenMatrixProbeRow[];
  decision: RakutenMatrixDecision;
  executionNote: string;
}): string {
  const counts = new Map<RakutenMatrixClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);

  return [
    "# Rakuten Iframe f_syu × f_hak Matrix Probe (Phase 59X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- probe_rows=${input.rows.length}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "- Goal: disambiguate whether the 該当する部屋タイプが見つかりません failure is caused by the f_syu token, the f_hak value, or both, for ZAO BASE / 197787.",
    "",
    "## 2. Live f_syu extraction",
    "",
    `- live_extracted_href=${input.liveExtractedHref || "not_found"}`,
    `- live_f_syu=${input.liveSyuValue || "not_found"}`,
    "",
    "## 3. Matrix variants tested",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.fSyuVariant} (f_syu=${row.fSyuValue || "<omitted>"}) × ${row.fHakVariant} (f_hak=${row.fHakValue || "<blank>"}) / ${row.stayDate}: ${row.classification}`
    ),
    "",
    "## 4. Generated URLs",
    "",
    ...input.rows.map((row) => `- ${row.fSyuVariant}/${row.fHakVariant}/${row.stayDate}: ${row.generatedUrl}`),
    "",
    "## 5. Date-scope findings",
    "",
    ...input.rows.map((row) => `- ${row.fSyuVariant}/${row.fHakVariant}: date_scope=${yn(row.dateScopeDetected)}`),
    "",
    "## 6. Adult/room/night basis findings",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.fSyuVariant}/${row.fHakVariant}: adults=${yn(row.adultCountDetected)}, rooms=${yn(row.roomCountDetected)}, nights=${yn(row.nightCountDetected)}`
    ),
    "",
    "## 7. Tax-included total findings",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.fSyuVariant}/${row.fHakVariant}: total=${row.taxIncludedTotalDetected || "none"}, per_person=${row.perPersonPriceDetected || "none"}`
    ),
    "",
    "## 8. Classification counts",
    "",
    `- ${JSON.stringify(Object.fromEntries(counts))}`,
    "",
    "## 9. Feasibility decision",
    "",
    `- ${input.decision}`,
    "",
    "## 10. Risk notes",
    "",
    ...input.rows.map((row) => `- ${row.fSyuVariant}/${row.fHakVariant}: ${row.riskNote}`),
    "",
    "## 11. Debug artifact paths",
    "",
    `- ${input.debugRootPath}`,
    ...input.rows.map((row) => `- ${row.debugArtifactPath}`),
    "",
    "## 12. Safety confirmation",
    "",
    "- Public rendered pages only; no login, no cookies, no CAPTCHA bypass, no stealth, no paid APIs, no proxies, no private/internal APIs.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 13. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: RakutenMatrixDecision): string {
  if (decision === "rakuten_matrix_ready") {
    return "- A matrix variant exposed a date-scoped 2-adult/1-room/1-night tax-included total; record the winning f_syu/f_hak combination and gate a tiny read-only collector prototype behind explicit review.";
  }
  if (decision === "rakuten_matrix_basis_mapping_needed") {
    return "- A variant returned useful non-empty date/price/availability evidence; inspect saved DOM/screenshots for that variant and map total/per-person/date selectors before any DB-writing collector.";
  }
  return "- No f_syu/f_hak combination returned a date-scoped priced result; the iframe likely requires its parent Thickbox/calendar JS context to mint a valid room-type token. Conclude the standalone iframe URL is not a viable collector entry point, or escalate to a human-driven capture of the calendar's own network/DOM flow.";
}

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }
  return value;
}

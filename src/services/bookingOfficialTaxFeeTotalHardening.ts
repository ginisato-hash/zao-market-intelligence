// Phase B04A — Booking.com official tax/fee adder total hardening.
//
// SUPERSEDES the Phase B03X `base × 1.1` tax-multiplier logic, which is rejected
// because Booking.com's official adder (e.g. ＋税・手数料（￥X）) may already include
// consumption tax — applying base × 1.1 AND adding the official adder double-counts tax.
//
// Official policy (booking_official_visible_adder_v1):
//   computed_total_with_tax_fee = primary_price_numeric + official_tax_fee_adder_numeric
// No synthetic 1.1 multiplier. No inferred tax percentage. No estimated fees.
// Only Booking.com's visible numeric amounts are used.
//
// Still feasibility/prototype only: local artifacts only, NO DB writes.

import {
  buildBookingRateCardRow,
  type BookingBasisConfidence,
  type BookingRateCardRow,
  type SelectorPresence
} from "./bookingRateCardExtractionProbe";
import {
  detectFeeMention,
  detectTaxFeeIncludedExplicit
} from "./bookingLimitedExtractorPrototype";
import { type BookingRenderedDomTarget } from "./bookingRenderedDomProbe";

export const BOOKING_PRICE_POLICY_VERSION = "booking_official_visible_adder_v1";

export type OfficialTaxFeeAdderExtractionStatus =
  | "numeric_extracted"
  | "included_or_not_required"
  | "mentioned_non_numeric"
  | "unknown";

export type B04ATaxBasisClassification =
  | "booking_room_total_official_base_plus_tax_fee_adder"
  | "booking_room_total_tax_fee_included_confirmed"
  | "booking_room_total_tax_fee_adder_missing_numeric"
  | "booking_room_total_tax_fee_basis_unclear"
  | "booking_no_price_available";

export type B04AClassification =
  | "booking_b04a_official_total_confirmed"
  | "booking_b04a_official_base_plus_adder_numeric"
  | "booking_b04a_official_adder_non_numeric"
  | "booking_b04a_price_basis_unclear"
  | "booking_b04a_sold_out"
  | "booking_b04a_property_mismatch"
  | "booking_b04a_blocked"
  | "booking_b04a_navigation_failed"
  | "booking_b04a_unexpected_error";

export type B04ADecision =
  | "booking_official_tax_fee_total_ready"
  | "booking_official_tax_fee_total_basis_caution"
  | "booking_official_tax_fee_total_not_ready";

export interface OfficialTaxFeeAdderPart {
  label: string;
  value: number;
  raw: string;
}

export interface OfficialTaxFeeExtraction {
  total: number | null;
  parts: OfficialTaxFeeAdderPart[];
}

export interface OfficialTaxFeeNormalization {
  officialTaxFeeAdderNumeric: number | null;
  officialTaxFeeAdderExtractionStatus: OfficialTaxFeeAdderExtractionStatus;
  computedTotalWithTaxFee: number | null;
  taxBasisClassification: B04ATaxBasisClassification;
  basisConfidence: BookingBasisConfidence;
  basisNote: string;
  adderParts: OfficialTaxFeeAdderPart[];
}

export interface B04ARow {
  runId: string;
  collectedAtJst: string;
  source: "booking";
  collectorStage: "prototype_read_only_b04a";
  pricePolicyVersion: string;
  propertyNameExpected: string;
  propertyNameDetected: string;
  propertyIdentityMatch: boolean;
  bookingSlug: string;
  checkin: string;
  checkout: string;
  stayNights: number;
  groupAdults: number;
  noRooms: number;
  groupChildren: number;
  selectedCurrency: "JPY";
  lang: "ja";
  urlSanitized: string;
  finalUrlSanitized: string;
  pageTitle: string;
  rateCardPresent: boolean;
  hprtTablePresent: boolean;
  availabilityAlertPresent: boolean;
  soldOutTextPresent: boolean;
  primaryRoomName: string;
  primaryRateName: string;
  primaryRoomCardText: string;
  primaryOccupancyHint: string;
  primaryBedHint: string;
  primaryPriceRaw: string;
  primaryPriceNumeric: number | null;
  officialTaxFeeTextRaw: string;
  officialTaxFeeAdderNumeric: number | null;
  officialTaxFeeAdderExtractionStatus: OfficialTaxFeeAdderExtractionStatus;
  computedTotalWithTaxFee: number | null;
  taxBasisClassification: B04ATaxBasisClassification;
  basisConfidence: BookingBasisConfidence;
  basisNote: string;
  isRoomTotalCandidate: boolean;
  is2AdultScopeConfirmed: boolean;
  is1RoomScopeConfirmed: boolean;
  is1NightScopeConfirmed: boolean;
  currencyDetected: boolean;
  languageDetected: boolean;
  blockingOrModalState: string;
  classification: B04AClassification;
  debugArtifactPath: string;
}

export const BOOKING_B04A_CSV_HEADERS = [
  "run_id",
  "collected_at_jst",
  "source",
  "collector_stage",
  "price_policy_version",
  "property_name_expected",
  "property_name_detected",
  "property_identity_match",
  "booking_slug",
  "checkin",
  "checkout",
  "stay_nights",
  "group_adults",
  "no_rooms",
  "group_children",
  "selected_currency",
  "lang",
  "url_sanitized",
  "final_url_sanitized",
  "page_title",
  "rate_card_present",
  "hprt_table_present",
  "availability_alert_present",
  "sold_out_text_present",
  "primary_room_name",
  "primary_rate_name",
  "primary_room_card_text",
  "primary_occupancy_hint",
  "primary_bed_hint",
  "primary_price_raw",
  "primary_price_numeric",
  "official_tax_fee_text_raw",
  "official_tax_fee_adder_numeric",
  "official_tax_fee_adder_extraction_status",
  "computed_total_with_tax_fee",
  "tax_basis_classification",
  "basis_confidence",
  "basis_note",
  "is_room_total_candidate",
  "is_2_adult_scope_confirmed",
  "is_1_room_scope_confirmed",
  "is_1_night_scope_confirmed",
  "currency_detected",
  "language_detected",
  "blocking_or_modal_state",
  "classification",
  "debug_artifact_path"
] as const;

const FINAL_ALL_IN_TOTAL = /合計金額|お支払い総額|総合計|総額|合計\s*[（(]?\s*(?:￥|¥)/u;

const OFFICIAL_FEE_GLOBAL =
  /(税・手数料|税金・手数料|税および手数料|税、手数料|清掃料金|清掃料|清掃費|サービス料金|サービス料|宿泊税|入湯税)\s*[（(]?\s*(?:￥|¥|JPY\s*)?\s*([0-9０-９,，]+)\s*(?:円)?\s*[)）]?/gu;

export function extractOfficialTaxFeeAdder(text: string): OfficialTaxFeeExtraction {
  const parts: OfficialTaxFeeAdderPart[] = [];
  const seen = new Set<string>();
  const re = new RegExp(OFFICIAL_FEE_GLOBAL.source, "gu");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const label = match[1] ?? "";
    const value = Number(toHalfWidth(match[2] ?? "").replace(/[，,]/gu, ""));
    if (!Number.isFinite(value) || value <= 0) continue;
    const key = `${label}:${value}`;
    if (seen.has(key)) continue; // avoid double-counting the same combined adder repeated in one context
    seen.add(key);
    parts.push({ label, value, raw: (match[0] ?? "").replace(/\s+/gu, " ").trim() });
  }
  if (parts.length === 0) return { total: null, parts: [] };
  return { total: parts.reduce((sum, part) => sum + part.value, 0), parts };
}

export function detectFinalAllInTotalVisible(text: string): boolean {
  return FINAL_ALL_IN_TOTAL.test(text);
}

export function normalizeOfficialTaxFeeTotal(input: {
  primaryPriceNumeric: number | null;
  officialTaxFeeText: string;
  finalAllInTotalVisible?: boolean;
  is2AdultScopeConfirmed: boolean;
  is1RoomScopeConfirmed: boolean;
  is1NightScopeConfirmed: boolean;
  propertyIdentityMatch: boolean;
}): OfficialTaxFeeNormalization {
  const price = input.primaryPriceNumeric;
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return {
      officialTaxFeeAdderNumeric: null,
      officialTaxFeeAdderExtractionStatus: "unknown",
      computedTotalWithTaxFee: null,
      taxBasisClassification: "booking_no_price_available",
      basisConfidence: "none",
      basisNote: "No usable primary price candidate was visible.",
      adderParts: []
    };
  }

  const text = input.officialTaxFeeText;
  const scopeStrong = input.is2AdultScopeConfirmed && input.is1RoomScopeConfirmed && input.is1NightScopeConfirmed;
  const strongAndMatched = scopeStrong && input.propertyIdentityMatch;
  const adder = extractOfficialTaxFeeAdder(text);
  const finalAllInVisible = input.finalAllInTotalVisible ?? false;

  // Numeric official adder visible: total = base + official adder (NO 1.1 multiplier).
  if (adder.total !== null) {
    return {
      officialTaxFeeAdderNumeric: adder.total,
      officialTaxFeeAdderExtractionStatus: "numeric_extracted",
      computedTotalWithTaxFee: price + adder.total,
      taxBasisClassification: "booking_room_total_official_base_plus_tax_fee_adder",
      basisConfidence: finalAllInVisible && strongAndMatched ? "A" : strongAndMatched ? "B" : "C",
      basisNote:
        "Computed total = Booking.com official visible base price + official visible tax/fee adder; no synthetic 1.1 multiplier applied.",
      adderParts: adder.parts
    };
  }

  // Explicit tax/fees-included text and no separate numeric adder.
  if (detectTaxFeeIncludedExplicit(text)) {
    return {
      officialTaxFeeAdderNumeric: 0,
      officialTaxFeeAdderExtractionStatus: "included_or_not_required",
      computedTotalWithTaxFee: price,
      taxBasisClassification: "booking_room_total_tax_fee_included_confirmed",
      basisConfidence: strongAndMatched ? "A" : "C",
      basisNote:
        "Visible text indicates tax/fees included; computed total equals Booking.com base price with no adder and no 1.1 multiplier.",
      adderParts: []
    };
  }

  // Adder label present but no numeric amount extractable.
  if (detectFeeMention(text)) {
    return {
      officialTaxFeeAdderNumeric: null,
      officialTaxFeeAdderExtractionStatus: "mentioned_non_numeric",
      computedTotalWithTaxFee: null,
      taxBasisClassification: "booking_room_total_tax_fee_adder_missing_numeric",
      basisConfidence: strongAndMatched ? "B" : "C",
      basisNote:
        "Booking.com showed a tax/fee adder label but no numeric official amount was visible/extractable; computed total left null (no estimate, no 1.1 multiplier).",
      adderParts: []
    };
  }

  // Ambiguous / absent tax-fee context.
  return {
    officialTaxFeeAdderNumeric: null,
    officialTaxFeeAdderExtractionStatus: "unknown",
    computedTotalWithTaxFee: null,
    taxBasisClassification: "booking_room_total_tax_fee_basis_unclear",
    basisConfidence: "C",
    basisNote: "Tax/fee basis ambiguous; no official numeric adder visible; computed total left null (no estimate, no 1.1 multiplier).",
    adderParts: []
  };
}

export function classifyB04ARow(input: {
  propertyIdentityMatch: boolean;
  soldOutTextPresent: boolean;
  blockingOrModalState: string;
  primaryPriceNumeric: number | null;
  taxBasisClassification: B04ATaxBasisClassification;
  officialTaxFeeAdderExtractionStatus: OfficialTaxFeeAdderExtractionStatus;
}): B04AClassification {
  if (input.blockingOrModalState === "navigation_failed") return "booking_b04a_navigation_failed";
  if (input.blockingOrModalState !== "none") return "booking_b04a_blocked";
  if (!input.propertyIdentityMatch) return "booking_b04a_property_mismatch";
  if (input.soldOutTextPresent && input.primaryPriceNumeric === null) return "booking_b04a_sold_out";
  if (input.primaryPriceNumeric === null) return "booking_b04a_price_basis_unclear";
  if (input.taxBasisClassification === "booking_room_total_tax_fee_included_confirmed") {
    return "booking_b04a_official_total_confirmed";
  }
  if (input.officialTaxFeeAdderExtractionStatus === "numeric_extracted") return "booking_b04a_official_base_plus_adder_numeric";
  if (input.officialTaxFeeAdderExtractionStatus === "mentioned_non_numeric") return "booking_b04a_official_adder_non_numeric";
  return "booking_b04a_price_basis_unclear";
}

export function mapRateCardRowToB04ARow(
  rateCardRow: BookingRateCardRow,
  options: { officialTaxFeeText?: string; finalAllInTotalVisible?: boolean } = {}
): B04ARow {
  const officialTaxFeeText = options.officialTaxFeeText ?? rateCardRow.primaryTaxChargeText;
  const normalization = normalizeOfficialTaxFeeTotal({
    primaryPriceNumeric: rateCardRow.primaryPriceNumeric,
    officialTaxFeeText,
    finalAllInTotalVisible: options.finalAllInTotalVisible ?? false,
    is2AdultScopeConfirmed: rateCardRow.is2AdultScopeConfirmed,
    is1RoomScopeConfirmed: rateCardRow.is1RoomScopeConfirmed,
    is1NightScopeConfirmed: rateCardRow.is1NightScopeConfirmed,
    propertyIdentityMatch: rateCardRow.propertyIdentityMatch
  });
  const classification = classifyB04ARow({
    propertyIdentityMatch: rateCardRow.propertyIdentityMatch,
    soldOutTextPresent: rateCardRow.soldOutTextPresent,
    blockingOrModalState: rateCardRow.blockingOrModalState,
    primaryPriceNumeric: rateCardRow.primaryPriceNumeric,
    taxBasisClassification: normalization.taxBasisClassification,
    officialTaxFeeAdderExtractionStatus: normalization.officialTaxFeeAdderExtractionStatus
  });
  return {
    runId: rateCardRow.runId,
    collectedAtJst: rateCardRow.collectedAtJst,
    source: "booking",
    collectorStage: "prototype_read_only_b04a",
    pricePolicyVersion: BOOKING_PRICE_POLICY_VERSION,
    propertyNameExpected: rateCardRow.propertyNameExpected,
    propertyNameDetected: rateCardRow.propertyHeadlineName,
    propertyIdentityMatch: rateCardRow.propertyIdentityMatch,
    bookingSlug: rateCardRow.bookingSlug,
    checkin: rateCardRow.checkin,
    checkout: rateCardRow.checkout,
    stayNights: 1,
    groupAdults: rateCardRow.groupAdults,
    noRooms: rateCardRow.noRooms,
    groupChildren: rateCardRow.groupChildren,
    selectedCurrency: "JPY",
    lang: "ja",
    urlSanitized: rateCardRow.urlSanitized,
    finalUrlSanitized: rateCardRow.finalUrlSanitized,
    pageTitle: rateCardRow.pageTitle,
    rateCardPresent: rateCardRow.rateCardPresent,
    hprtTablePresent: rateCardRow.hprtTablePresent,
    availabilityAlertPresent: rateCardRow.availabilityAlertPresent,
    soldOutTextPresent: rateCardRow.soldOutTextPresent,
    primaryRoomName: rateCardRow.primaryRoomName,
    primaryRateName: rateCardRow.primaryRateName,
    primaryRoomCardText: rateCardRow.primaryRoomCardText,
    primaryOccupancyHint: rateCardRow.primaryOccupancyHint,
    primaryBedHint: rateCardRow.primaryBedHint,
    primaryPriceRaw: rateCardRow.primaryPriceRaw,
    primaryPriceNumeric: rateCardRow.primaryPriceNumeric,
    officialTaxFeeTextRaw: rateCardRow.primaryTaxChargeText,
    officialTaxFeeAdderNumeric: normalization.officialTaxFeeAdderNumeric,
    officialTaxFeeAdderExtractionStatus: normalization.officialTaxFeeAdderExtractionStatus,
    computedTotalWithTaxFee: normalization.computedTotalWithTaxFee,
    taxBasisClassification: normalization.taxBasisClassification,
    basisConfidence: normalization.basisConfidence,
    basisNote: normalization.basisNote,
    isRoomTotalCandidate: rateCardRow.primaryPriceNumeric !== null && rateCardRow.is1RoomScopeConfirmed,
    is2AdultScopeConfirmed: rateCardRow.is2AdultScopeConfirmed,
    is1RoomScopeConfirmed: rateCardRow.is1RoomScopeConfirmed,
    is1NightScopeConfirmed: rateCardRow.is1NightScopeConfirmed,
    currencyDetected: rateCardRow.currencyDetected,
    languageDetected: rateCardRow.languageDetected,
    blockingOrModalState: rateCardRow.blockingOrModalState,
    classification,
    debugArtifactPath: rateCardRow.debugArtifactPath
  };
}

export function buildB04ARow(input: {
  runId: string;
  collectedAtJst: string;
  target: BookingRenderedDomTarget;
  checkin: string;
  finalUrl: string;
  httpStatus: number;
  pageTitle: string;
  propertyHeadlineName: string;
  visibleText: string;
  selectorPresence: SelectorPresence;
  debugArtifactPath: string;
  officialTaxFeeText?: string;
  finalAllInTotalVisible?: boolean;
}): B04ARow {
  const rateCardRow = buildBookingRateCardRow({
    runId: input.runId,
    collectedAtJst: input.collectedAtJst,
    target: input.target,
    checkin: input.checkin,
    finalUrl: input.finalUrl,
    httpStatus: input.httpStatus,
    pageTitle: input.pageTitle,
    propertyHeadlineName: input.propertyHeadlineName,
    visibleText: input.visibleText,
    selectorPresence: input.selectorPresence,
    debugArtifactPath: input.debugArtifactPath
  });
  const options: { officialTaxFeeText?: string; finalAllInTotalVisible?: boolean } = {
    finalAllInTotalVisible: input.finalAllInTotalVisible ?? false
  };
  if (input.officialTaxFeeText !== undefined) options.officialTaxFeeText = input.officialTaxFeeText;
  return mapRateCardRowToB04ARow(rateCardRow, options);
}

export function decideB04A(rows: B04ARow[]): B04ADecision {
  const usable = rows.filter(
    (row) =>
      row.primaryPriceNumeric !== null &&
      row.computedTotalWithTaxFee !== null &&
      (row.basisConfidence === "A" || row.basisConfidence === "B")
  ).length;
  if (usable >= 3) return "booking_official_tax_fee_total_ready";
  if (rows.some((row) => row.primaryPriceNumeric !== null)) return "booking_official_tax_fee_total_basis_caution";
  return "booking_official_tax_fee_total_not_ready";
}

export function renderB04ACsv(rows: B04ARow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.collectedAtJst,
      row.source,
      row.collectorStage,
      row.pricePolicyVersion,
      row.propertyNameExpected,
      row.propertyNameDetected,
      bool(row.propertyIdentityMatch),
      row.bookingSlug,
      row.checkin,
      row.checkout,
      String(row.stayNights),
      String(row.groupAdults),
      String(row.noRooms),
      String(row.groupChildren),
      row.selectedCurrency,
      row.lang,
      row.urlSanitized,
      row.finalUrlSanitized,
      row.pageTitle,
      bool(row.rateCardPresent),
      bool(row.hprtTablePresent),
      bool(row.availabilityAlertPresent),
      bool(row.soldOutTextPresent),
      row.primaryRoomName,
      row.primaryRateName,
      row.primaryRoomCardText,
      row.primaryOccupancyHint,
      row.primaryBedHint,
      row.primaryPriceRaw,
      row.primaryPriceNumeric === null ? "" : String(row.primaryPriceNumeric),
      row.officialTaxFeeTextRaw,
      row.officialTaxFeeAdderNumeric === null ? "" : String(row.officialTaxFeeAdderNumeric),
      row.officialTaxFeeAdderExtractionStatus,
      row.computedTotalWithTaxFee === null ? "" : String(row.computedTotalWithTaxFee),
      row.taxBasisClassification,
      row.basisConfidence,
      row.basisNote,
      bool(row.isRoomTotalCandidate),
      bool(row.is2AdultScopeConfirmed),
      bool(row.is1RoomScopeConfirmed),
      bool(row.is1NightScopeConfirmed),
      bool(row.currencyDetected),
      bool(row.languageDetected),
      row.blockingOrModalState,
      row.classification,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [BOOKING_B04A_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderB04AReport(input: {
  generatedAt: string;
  rows: B04ARow[];
  decision: B04ADecision;
  pageLoadCount: number;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): string {
  return [
    "# Booking.com Official Tax/Fee Adder Total Hardening (Phase B04A)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Policy",
    "",
    `- price_policy_version=${BOOKING_PRICE_POLICY_VERSION}`,
    "- B04A SUPERSEDES the Phase B03X `base × 1.1` tax-multiplier logic, which is rejected as overcount-risk.",
    "- Official rule: computed_total_with_tax_fee = primary_price_numeric + official_tax_fee_adder_numeric.",
    "- No synthetic 1.1 multiplier, no inferred tax percentage, no estimated fees. Only Booking.com visible numeric amounts.",
    "",
    "## 2. Summary",
    "",
    `- decision=${input.decision}`,
    `- rows=${input.rows.length}`,
    `- page_load_count=${input.pageLoadCount}`,
    `- classification_counts=${JSON.stringify(countBy(input.rows.map((r) => r.classification)))}`,
    `- basis_confidence_counts=${JSON.stringify(countBy(input.rows.map((r) => r.basisConfidence)))}`,
    `- adder_status_counts=${JSON.stringify(countBy(input.rows.map((r) => r.officialTaxFeeAdderExtractionStatus)))}`,
    "",
    "## 3. Row results",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.propertyNameExpected} ${row.checkin}: identity=${bool(row.propertyIdentityMatch)}, base=${row.primaryPriceNumeric ?? "n/a"}, official_adder=${row.officialTaxFeeAdderNumeric ?? "n/a"} (${row.officialTaxFeeAdderExtractionStatus}), total=${row.computedTotalWithTaxFee ?? "n/a"}, basis=${row.taxBasisClassification}, conf=${row.basisConfidence}, class=${row.classification}`
    ),
    "",
    "## 4. Basis notes",
    "",
    ...input.rows.map((row) => `- ${row.propertyNameExpected} ${row.checkin}: ${row.basisNote}`),
    "",
    "## 5. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 6. Safety confirmation",
    "",
    "- Read-only correction over the same six public Booking.com rows (B02X/B03X matrix).",
    "- No DB writes, no collector_runs, no rate_snapshots, no inventory_snapshots.",
    "- No login, no private data, no cookie injection, no stealth, no CAPTCHA bypass, no paid proxy/API.",
    "- No Beds24/AirHost/PMS/OTA upload output.",
    "",
    "## 7. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: B04ADecision): string {
  if (decision === "booking_official_tax_fee_total_ready") {
    return "- Proceed to Phase B04X market-signal normalization (unify B04A official totals with Jalan/Rakuten local schema). Keep DB writes disabled.";
  }
  if (decision === "booking_official_tax_fee_total_basis_caution") {
    return "- Usable prices exist but official adders are mostly missing/non-numeric; inspect debug artifacts before unifying schemas. Do not estimate tax.";
  }
  return "- Not ready. Do not revert to base×1.1, do not estimate tax; document extraction failure and keep Booking experimental.";
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function toHalfWidth(text: string): string {
  return text.replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

// Phase B03X — Booking.com limited read-only extractor prototype.
//
// Wraps the Phase B02X rate-card extraction (bookingRateCardExtractionProbe) and
// normalizes each row into a collector-like local market-signal schema with an
// explicit, project-mandated tax/fee normalization rule:
//
//   tax_included_price = round(primary_price_numeric * 1.1)   (unless text says tax/fees included)
//   computed_total_with_tax_fee = tax_included_price + fee_adder_numeric (when a numeric adder is visible)
//
// Still feasibility/prototype only: local artifacts only, NO DB writes.

import {
  buildBookingRateCardRow,
  type BookingBasisConfidence,
  type BookingRateCardRow,
  type BookingTaxBasisClassification,
  type SelectorPresence
} from "./bookingRateCardExtractionProbe";
import { type BookingRenderedDomTarget } from "./bookingRenderedDomProbe";

export const BOOKING_TAX_MULTIPLIER = 1.1;
export const BOOKING_TAX_NORMALIZATION_RULE =
  "primary_price_numeric * 1.1, plus visible fee/cleaning/service adder when numeric";

export type FeeAdderExtractionStatus =
  | "numeric_extracted"
  | "mentioned_non_numeric"
  | "included_or_not_required"
  | "unknown";

export type TaxFeeExtractionConfidence = "numeric" | "text_only" | "included" | "none";

export type BookingLimitedClassification =
  | "booking_limited_row_tax_included_total_confirmed"
  | "booking_limited_row_price_plus_tax_fee_numeric"
  | "booking_limited_row_price_plus_tax_fee_non_numeric"
  | "booking_limited_row_price_basis_unclear"
  | "booking_limited_row_sold_out"
  | "booking_limited_row_property_mismatch"
  | "booking_limited_row_blocked"
  | "booking_limited_row_navigation_failed"
  | "booking_limited_row_unexpected_error";

export type BookingLimitedDecision =
  | "booking_limited_extractor_prototype_ready"
  | "booking_limited_extractor_basis_caution"
  | "booking_limited_extractor_not_ready";

export interface BookingTaxFeeNormalization {
  taxMultiplier: number;
  taxIncludedPrice: number | null;
  feeAdderNumeric: number | null;
  feeAdderExtractionStatus: FeeAdderExtractionStatus;
  taxFeeExtractionConfidence: TaxFeeExtractionConfidence;
  computedTotalWithTaxFee: number | null;
  taxBasisClassification: BookingTaxBasisClassification;
  basisConfidence: BookingBasisConfidence;
  basisNote: string;
}

export interface BookingLimitedRow {
  runId: string;
  collectedAtJst: string;
  source: "booking";
  collectorStage: "prototype_read_only";
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
  primaryPriceRaw: string;
  primaryPriceNumeric: number | null;
  taxMultiplier: number;
  taxIncludedPrice: number | null;
  taxNormalizationRule: string;
  taxFeeTextRaw: string;
  feeAdderNumeric: number | null;
  feeAdderExtractionStatus: FeeAdderExtractionStatus;
  taxFeeExtractionConfidence: TaxFeeExtractionConfidence;
  computedTotalWithTaxFee: number | null;
  taxBasisClassification: BookingTaxBasisClassification;
  basisConfidence: BookingBasisConfidence;
  basisNote: string;
  isRoomTotalCandidate: boolean;
  is2AdultScopeConfirmed: boolean;
  is1RoomScopeConfirmed: boolean;
  is1NightScopeConfirmed: boolean;
  currencyDetected: boolean;
  languageDetected: boolean;
  blockingOrModalState: string;
  classification: BookingLimitedClassification;
  debugArtifactPath: string;
}

export const BOOKING_LIMITED_CSV_HEADERS = [
  "run_id",
  "collected_at_jst",
  "source",
  "collector_stage",
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
  "primary_price_raw",
  "primary_price_numeric",
  "tax_multiplier",
  "tax_included_price",
  "tax_normalization_rule",
  "tax_fee_text_raw",
  "fee_adder_numeric",
  "fee_adder_extraction_status",
  "tax_fee_extraction_confidence",
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

const TAX_FEE_INCLUDED_EXPLICIT =
  /税・手数料込み|税金・手数料込み|料金・税・サービス料込み|料金・税込み|総額|すべて込み|全て込み|all[-\s]?inclusive|taxes and fees included/iu;

const SEPARATE_ADDER_MARKER = /(?:＋|\+)\s*税・手数料|別途|追加料金|料金に含まれません/u;

const FEE_MENTION =
  /(?:＋|\+)?\s*税・手数料|税および手数料|税、手数料|別途|料金に含まれません|追加料金|清掃料金|清掃料|清掃費|サービス料|宿泊税|入湯税|税金・手数料/u;

const FEE_ADDER_NUMERIC =
  /(?:＋|\+)?\s*(?:税・手数料|税金・手数料|税および手数料|税、手数料|清掃料金|清掃料|清掃費|サービス料金|サービス料|宿泊税|入湯税)\s*[（(]?\s*(?:￥|¥|JPY\s*)?\s*([0-9０-９,，]+)\s*[)）]?/u;

export function extractFeeAdderNumeric(text: string): { value: number; matchedText: string } | null {
  const match = FEE_ADDER_NUMERIC.exec(text);
  if (!match) return null;
  const raw = match[1] ?? "";
  const value = Number(toHalfWidth(raw).replace(/[，,]/gu, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, matchedText: (match[0] ?? "").replace(/\s+/gu, " ").trim() };
}

export function detectTaxFeeIncludedExplicit(text: string): boolean {
  return TAX_FEE_INCLUDED_EXPLICIT.test(text);
}

export function detectFeeMention(text: string): boolean {
  return FEE_MENTION.test(text);
}

export function normalizeBookingTaxFee(input: {
  primaryPriceNumeric: number | null;
  taxFeeText: string;
  is2AdultScopeConfirmed: boolean;
  is1RoomScopeConfirmed: boolean;
  is1NightScopeConfirmed: boolean;
  propertyIdentityMatch: boolean;
}): BookingTaxFeeNormalization {
  const price = input.primaryPriceNumeric;
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return {
      taxMultiplier: BOOKING_TAX_MULTIPLIER,
      taxIncludedPrice: null,
      feeAdderNumeric: null,
      feeAdderExtractionStatus: "unknown",
      taxFeeExtractionConfidence: "none",
      computedTotalWithTaxFee: null,
      taxBasisClassification: "booking_no_price_available",
      basisConfidence: "none",
      basisNote: "No usable primary price candidate was visible."
    };
  }

  const text = input.taxFeeText;
  const scopeStrong = input.is2AdultScopeConfirmed && input.is1RoomScopeConfirmed && input.is1NightScopeConfirmed;
  const strongAndMatched = scopeStrong && input.propertyIdentityMatch;
  const fee = extractFeeAdderNumeric(text);
  const includedExplicit = detectTaxFeeIncludedExplicit(text);
  const separateMarker = SEPARATE_ADDER_MARKER.test(text);
  const taxIncludedByPolicy = Math.round(price * BOOKING_TAX_MULTIPLIER);

  // Branch 3: visible text explicitly says tax/fees included (and no separate adder shown).
  if (includedExplicit && fee === null && !separateMarker) {
    return {
      taxMultiplier: 1,
      taxIncludedPrice: price,
      feeAdderNumeric: 0,
      feeAdderExtractionStatus: "included_or_not_required",
      taxFeeExtractionConfidence: "included",
      computedTotalWithTaxFee: price,
      taxBasisClassification: "booking_room_total_tax_included_confirmed",
      basisConfidence: strongAndMatched ? "A" : "C",
      basisNote: "Visible text indicates tax/fees included; no 1.1 multiplier applied."
    };
  }

  // Branch 2: numeric fee/cleaning/service adder is extractable.
  if (fee !== null) {
    return {
      taxMultiplier: BOOKING_TAX_MULTIPLIER,
      taxIncludedPrice: taxIncludedByPolicy,
      feeAdderNumeric: fee.value,
      feeAdderExtractionStatus: "numeric_extracted",
      taxFeeExtractionConfidence: "numeric",
      computedTotalWithTaxFee: taxIncludedByPolicy + fee.value,
      taxBasisClassification: "booking_room_total_tax_excluded_requires_adder",
      basisConfidence: strongAndMatched ? "B" : "C",
      basisNote: "Applied 1.1 tax multiplier and added visible numeric fee/tax adder."
    };
  }

  // Branch 1: separate tax/fee text exists but no numeric adder is extractable.
  if (detectFeeMention(text)) {
    return {
      taxMultiplier: BOOKING_TAX_MULTIPLIER,
      taxIncludedPrice: taxIncludedByPolicy,
      feeAdderNumeric: null,
      feeAdderExtractionStatus: "mentioned_non_numeric",
      taxFeeExtractionConfidence: "text_only",
      computedTotalWithTaxFee: null,
      taxBasisClassification: "booking_room_total_tax_excluded_requires_adder",
      basisConfidence: strongAndMatched ? "B" : "C",
      basisNote:
        "Applied 1.1 tax multiplier to primary Booking.com price; additional fee/tax text exists but numeric adder was not visible/extractable."
    };
  }

  // Branch 4: price exists but tax/fee text is ambiguous/absent.
  return {
    taxMultiplier: BOOKING_TAX_MULTIPLIER,
    taxIncludedPrice: taxIncludedByPolicy,
    feeAdderNumeric: null,
    feeAdderExtractionStatus: "unknown",
    taxFeeExtractionConfidence: "none",
    computedTotalWithTaxFee: null,
    taxBasisClassification: "booking_room_total_tax_and_charges_unclear",
    basisConfidence: "C",
    basisNote:
      "Applied 1.1 tax multiplier as project policy, but tax/fee visibility remains ambiguous; no fee adder estimated."
  };
}

export function classifyBookingLimitedRow(input: {
  propertyIdentityMatch: boolean;
  rateCardPresent: boolean;
  soldOutTextPresent: boolean;
  blockingOrModalState: string;
  primaryPriceNumeric: number | null;
  taxBasisClassification: BookingTaxBasisClassification;
  feeAdderExtractionStatus: FeeAdderExtractionStatus;
}): BookingLimitedClassification {
  if (input.blockingOrModalState === "navigation_failed") return "booking_limited_row_navigation_failed";
  if (input.blockingOrModalState !== "none") return "booking_limited_row_blocked";
  if (!input.propertyIdentityMatch) return "booking_limited_row_property_mismatch";
  if (input.soldOutTextPresent && input.primaryPriceNumeric === null) return "booking_limited_row_sold_out";
  if (input.primaryPriceNumeric === null) return "booking_limited_row_price_basis_unclear";
  if (input.taxBasisClassification === "booking_room_total_tax_included_confirmed") {
    return "booking_limited_row_tax_included_total_confirmed";
  }
  if (input.feeAdderExtractionStatus === "numeric_extracted") return "booking_limited_row_price_plus_tax_fee_numeric";
  if (input.feeAdderExtractionStatus === "mentioned_non_numeric") return "booking_limited_row_price_plus_tax_fee_non_numeric";
  return "booking_limited_row_price_basis_unclear";
}

export function mapRateCardRowToLimitedRow(
  rateCardRow: BookingRateCardRow,
  options: { feeSourceText?: string } = {}
): BookingLimitedRow {
  const feeSourceText = options.feeSourceText ?? rateCardRow.primaryTaxChargeText;
  const normalization = normalizeBookingTaxFee({
    primaryPriceNumeric: rateCardRow.primaryPriceNumeric,
    taxFeeText: feeSourceText,
    is2AdultScopeConfirmed: rateCardRow.is2AdultScopeConfirmed,
    is1RoomScopeConfirmed: rateCardRow.is1RoomScopeConfirmed,
    is1NightScopeConfirmed: rateCardRow.is1NightScopeConfirmed,
    propertyIdentityMatch: rateCardRow.propertyIdentityMatch
  });
  const classification = classifyBookingLimitedRow({
    propertyIdentityMatch: rateCardRow.propertyIdentityMatch,
    rateCardPresent: rateCardRow.rateCardPresent,
    soldOutTextPresent: rateCardRow.soldOutTextPresent,
    blockingOrModalState: rateCardRow.blockingOrModalState,
    primaryPriceNumeric: rateCardRow.primaryPriceNumeric,
    taxBasisClassification: normalization.taxBasisClassification,
    feeAdderExtractionStatus: normalization.feeAdderExtractionStatus
  });
  return {
    runId: rateCardRow.runId,
    collectedAtJst: rateCardRow.collectedAtJst,
    source: "booking",
    collectorStage: "prototype_read_only",
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
    primaryPriceRaw: rateCardRow.primaryPriceRaw,
    primaryPriceNumeric: rateCardRow.primaryPriceNumeric,
    taxMultiplier: normalization.taxMultiplier,
    taxIncludedPrice: normalization.taxIncludedPrice,
    taxNormalizationRule: BOOKING_TAX_NORMALIZATION_RULE,
    taxFeeTextRaw: rateCardRow.primaryTaxChargeText,
    feeAdderNumeric: normalization.feeAdderNumeric,
    feeAdderExtractionStatus: normalization.feeAdderExtractionStatus,
    taxFeeExtractionConfidence: normalization.taxFeeExtractionConfidence,
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

export function buildBookingLimitedRow(input: {
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
  feeSourceText?: string;
}): BookingLimitedRow {
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
  const mapOptions = input.feeSourceText === undefined ? {} : { feeSourceText: input.feeSourceText };
  return mapRateCardRowToLimitedRow(rateCardRow, mapOptions);
}

export function decideBookingLimited(rows: BookingLimitedRow[]): BookingLimitedDecision {
  const usableAB = rows.filter(
    (row) => row.primaryPriceNumeric !== null && (row.basisConfidence === "A" || row.basisConfidence === "B")
  ).length;
  if (usableAB >= 3) return "booking_limited_extractor_prototype_ready";
  if (rows.some((row) => row.primaryPriceNumeric !== null)) return "booking_limited_extractor_basis_caution";
  return "booking_limited_extractor_not_ready";
}

export function renderBookingLimitedCsv(rows: BookingLimitedRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.collectedAtJst,
      row.source,
      row.collectorStage,
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
      row.primaryPriceRaw,
      row.primaryPriceNumeric === null ? "" : String(row.primaryPriceNumeric),
      String(row.taxMultiplier),
      row.taxIncludedPrice === null ? "" : String(row.taxIncludedPrice),
      row.taxNormalizationRule,
      row.taxFeeTextRaw,
      row.feeAdderNumeric === null ? "" : String(row.feeAdderNumeric),
      row.feeAdderExtractionStatus,
      row.taxFeeExtractionConfidence,
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
  return [BOOKING_LIMITED_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderBookingLimitedReport(input: {
  generatedAt: string;
  rows: BookingLimitedRow[];
  decision: BookingLimitedDecision;
  pageLoadCount: number;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): string {
  return [
    "# Booking.com Limited Read-Only Extractor Prototype (Phase B03X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.decision}`,
    `- rows=${input.rows.length}`,
    `- page_load_count=${input.pageLoadCount}`,
    `- classification_counts=${JSON.stringify(countBy(input.rows.map((r) => r.classification)))}`,
    `- basis_confidence_counts=${JSON.stringify(countBy(input.rows.map((r) => r.basisConfidence)))}`,
    `- fee_adder_status_counts=${JSON.stringify(countBy(input.rows.map((r) => r.feeAdderExtractionStatus)))}`,
    "",
    "## 2. Normalization rule",
    "",
    `- tax_multiplier=${BOOKING_TAX_MULTIPLIER}`,
    `- tax_normalization_rule=${BOOKING_TAX_NORMALIZATION_RULE}`,
    "",
    "## 3. Row results",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.propertyNameExpected} ${row.checkin}: identity=${bool(row.propertyIdentityMatch)}, base=${row.primaryPriceNumeric ?? "n/a"}, tax_incl=${row.taxIncludedPrice ?? "n/a"}, fee_adder=${row.feeAdderNumeric ?? "n/a"} (${row.feeAdderExtractionStatus}), total=${row.computedTotalWithTaxFee ?? "n/a"}, basis=${row.taxBasisClassification}, conf=${row.basisConfidence}, class=${row.classification}`
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
    "- Read-only prototype over the same six public Booking.com rows (B02X matrix).",
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

function recommendedNextAction(decision: BookingLimitedDecision): string {
  if (decision === "booking_limited_extractor_prototype_ready") {
    return "- Proceed to Phase B04X market-signal normalization design (unify with Jalan/Rakuten local schema). Keep DB writes disabled.";
  }
  if (decision === "booking_limited_extractor_basis_caution") {
    return "- Usable prices exist but basis is mostly weak; inspect debug artifacts and harden scope/tax detection before unifying schemas.";
  }
  return "- Prototype not ready. Do not broaden scraping or bypass blocking; document blocking mode and keep Booking experimental.";
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

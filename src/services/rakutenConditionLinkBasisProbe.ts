import type { HplanCalendarParsed, HplanDay } from "./rakutenCorrectedHplanUrlProbe";

export type RakutenConditionBasisClassification =
  | "condition_link_basis_confirmed_total_matches_price_times_adults"
  | "condition_link_basis_confirmed_per_person_only"
  | "condition_link_basis_price_mismatch"
  | "condition_link_basis_date_scope_mismatch"
  | "condition_link_basis_people_scope_mismatch"
  | "condition_link_basis_tax_scope_unclear"
  | "condition_link_basis_destination_unreachable"
  | "condition_link_basis_render_blocked"
  | "condition_link_basis_parse_ambiguous"
  | "condition_link_basis_unexpected_error";

export type RakutenConditionBasisDecision =
  | "rakuten_price_basis_confirmed"
  | "rakuten_price_basis_needs_manual_review"
  | "rakuten_price_basis_not_ready";

export type PriceCandidateType =
  | "total_2_adult_tax_included"
  | "per_person_tax_included"
  | "tax_excluded"
  | "discounted_total"
  | "unknown";

export interface PriceCandidate {
  rawText: string;
  numericValue: number;
  contextBeforeAfter: string;
  candidateTypeGuess: PriceCandidateType;
}

export interface ConditionPageSignals {
  pageTitle: string;
  propertyNameVisible: boolean;
  roomOrPlanNameVisible: boolean;
  checkinDateVisible: boolean;
  checkoutDateVisible: boolean;
  nightsVisible: boolean;
  adultCountVisible: boolean;
  roomCountVisible: boolean;
  taxIncludedTextPresent: boolean;
  couponOrDiscountTextPresent: boolean;
  serviceFeeOrTaxNotes: string;
  onsenTaxOrBathTaxNotes: string;
  availabilityOrRemainingRoomText: string;
  buttonOrBookingStateText: string;
  totalPriceCandidates: PriceCandidate[];
  perPersonPriceCandidates: PriceCandidate[];
  currency: string;
}

export interface BasisComparison {
  dayListPrice: number;
  dayListPriceWithoutTax: number;
  dayListDiscountedPrice: number;
  expectedPerPersonTaxIncluded: number;
  expectedTwoAdultTotalTaxIncluded: number;
  anyVisiblePriceEqualsDayListPrice: boolean;
  anyVisiblePriceEqualsPriceTimesAdults: boolean;
  dateMatches: boolean;
  adultScopeMatches: boolean;
  roomScopeMatches: boolean;
  nightScopeMatches: boolean;
  taxIncludedConfirmed: boolean;
  extraFeeNotes: string[];
}

export interface RakutenConditionBasisRow {
  canonicalPropertyName: string;
  hotelNo: string;
  fSyu: string;
  fCampId: string;
  sourceViewDate: string;
  selectedViewDay: string;
  selectedEpoch: number;
  dayListPrice: number;
  expectedTwoAdultTotal: number;
  destinationHttpStatus: number;
  destinationFinalUrlSanitized: string;
  fetchMode: string;
  pageTitle: string;
  dateScopeDetected: boolean;
  adultCountDetected: boolean;
  roomCountDetected: boolean;
  nightCountDetected: boolean;
  taxIncludedTextPresent: boolean;
  totalMatchDetected: boolean;
  perPersonMatchDetected: boolean;
  classification: RakutenConditionBasisClassification;
  decision: RakutenConditionBasisDecision;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_CONDITION_BASIS_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "f_syu",
  "f_camp_id",
  "source_view_date",
  "selected_view_day",
  "selected_epoch",
  "day_list_price",
  "expected_2_adult_total",
  "destination_http_status",
  "destination_final_url_sanitized",
  "fetch_mode",
  "page_title",
  "date_scope_detected",
  "adult_count_detected",
  "room_count_detected",
  "night_count_detected",
  "tax_included_text_present",
  "total_match_detected",
  "per_person_match_detected",
  "classification",
  "decision",
  "risk_note",
  "debug_artifact_path"
] as const;

export function selectFirstAvailableDay(parsed: HplanCalendarParsed, skip = 0): HplanDay | null {
  return parsed.days.filter((d) => d.isVacant && d.price > 0 && d.link.trim() !== "")[skip] ?? null;
}

export function buildAbsoluteRakutenConditionUrl(link: string): string {
  return new URL(link, "https://rsvh.travel.rakuten.co.jp").toString();
}

export function sanitizeRakutenConditionUrl(url: string): string {
  try {
    const u = new URL(url);
    const allow = new Set([
      "f_hotel_no",
      "f_syu",
      "f_camp_id",
      "f_nen1",
      "f_tuki1",
      "f_hi1",
      "f_otona_su",
      "f_heya_su",
      "f_flg"
    ]);
    for (const key of Array.from(u.searchParams.keys())) {
      if (!allow.has(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return "[invalid_url]";
  }
}

export function extractYenPriceCandidates(text: string): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  const normalized = text.replace(/\s+/gu, " ");
  const patterns = [
    /(?:税込|合計|総額|料金|お支払い|1名|一名|大人)[^。\n]{0,40}?([0-9０-９,，]{4,})\s*円/giu,
    /([0-9０-９,，]{4,})\s*円[^。\n]{0,30}?(?:税込|合計|総額|1名|一名|大人)/giu,
    /([0-9０-９,，]{4,})\s*円/giu
  ];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      const rawNumber = match[1] ?? "";
      const numericValue = Number(rawNumber.replace(/[０-９]/gu, (c) => String(c.charCodeAt(0) - 0xff10)).replace(/[，,]/gu, ""));
      if (!Number.isFinite(numericValue) || numericValue <= 0) continue;
      const start = Math.max(0, match.index - 45);
      const end = Math.min(normalized.length, match.index + match[0].length + 45);
      const context = normalized.slice(start, end);
      const key = `${numericValue}:${context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        rawText: match[0].trim(),
        numericValue,
        contextBeforeAfter: context.trim(),
        candidateTypeGuess: guessCandidateType(context)
      });
    }
  }
  return candidates;
}

export function extractConditionPageSignals(input: {
  text: string;
  title: string;
  canonicalPropertyName: string;
  roomCode: string;
  selectedDay: HplanDay;
}): ConditionPageSignals {
  const text = input.text.replace(/\s+/gu, " ");
  const prices = extractYenPriceCandidates(text);
  const serviceFeeOrTaxNotes = findJoined(text, /(サービス料[^。]{0,50}|消費税[^。]{0,50}|税[^。]{0,30})/gu);
  const onsenTaxOrBathTaxNotes = findJoined(text, /(入湯税[^。]{0,80}|浴場税[^。]{0,80}|宿泊税[^。]{0,80})/gu);
  return {
    pageTitle: input.title,
    propertyNameVisible: text.includes(input.canonicalPropertyName) || text.includes("蔵王国際ホテル"),
    roomOrPlanNameVisible: input.roomCode !== "" && text.includes(input.roomCode),
    checkinDateVisible: detectSelectedDate(text, input.selectedDay),
    checkoutDateVisible: /チェックアウト|OUT|翌日|1泊|１泊/u.test(text),
    nightsVisible: /1\s*泊|１\s*泊|一泊/u.test(text),
    adultCountVisible: /大人\s*2|大人２|2\s*名|２\s*名|2\s*人|２\s*人/u.test(text),
    roomCountVisible: /1\s*室|１\s*室/u.test(text),
    taxIncludedTextPresent: /税込|消費税込|税金込|税サ込/u.test(text),
    couponOrDiscountTextPresent: /クーポン|割引|discount|値引/u.test(text),
    serviceFeeOrTaxNotes,
    onsenTaxOrBathTaxNotes,
    availabilityOrRemainingRoomText: findJoined(text, /(残り[^。]{0,40}|空室[^。]{0,40}|予約可能[^。]{0,40})/gu),
    buttonOrBookingStateText: findJoined(text, /(予約|申し込|次へ|空室|満室|受付終了)[^。]{0,40}/gu),
    totalPriceCandidates: prices.filter((p) => p.candidateTypeGuess !== "per_person_tax_included"),
    perPersonPriceCandidates: prices.filter((p) => p.candidateTypeGuess === "per_person_tax_included"),
    currency: prices.length > 0 ? "JPY" : ""
  };
}

export function compareConditionBasis(input: {
  day: HplanDay;
  adultCount: number;
  signals: ConditionPageSignals;
}): BasisComparison {
  const allPrices = [...input.signals.totalPriceCandidates, ...input.signals.perPersonPriceCandidates];
  const expectedTotal = input.day.price * input.adultCount;
  const extraFeeNotes = [input.signals.onsenTaxOrBathTaxNotes, input.signals.serviceFeeOrTaxNotes].filter(Boolean);
  return {
    dayListPrice: input.day.price,
    dayListPriceWithoutTax: input.day.priceWithoutTax,
    dayListDiscountedPrice: input.day.discountedPrice,
    expectedPerPersonTaxIncluded: input.day.price,
    expectedTwoAdultTotalTaxIncluded: expectedTotal,
    anyVisiblePriceEqualsDayListPrice: allPrices.some((p) => p.numericValue === input.day.price),
    anyVisiblePriceEqualsPriceTimesAdults: allPrices.some((p) => p.numericValue === expectedTotal),
    dateMatches: input.signals.checkinDateVisible,
    adultScopeMatches: input.signals.adultCountVisible,
    roomScopeMatches: input.signals.roomCountVisible,
    nightScopeMatches: input.signals.nightsVisible,
    taxIncludedConfirmed: input.signals.taxIncludedTextPresent,
    extraFeeNotes
  };
}

export function classifyConditionBasis(input: {
  reachable: boolean;
  renderedBlocked: boolean;
  comparison: BasisComparison | null;
}): RakutenConditionBasisClassification {
  if (!input.reachable) return "condition_link_basis_destination_unreachable";
  if (input.renderedBlocked) return "condition_link_basis_render_blocked";
  const c = input.comparison;
  if (c === null) return "condition_link_basis_parse_ambiguous";
  if (!c.dateMatches) return "condition_link_basis_date_scope_mismatch";
  if (!c.adultScopeMatches || !c.roomScopeMatches || !c.nightScopeMatches) {
    return "condition_link_basis_people_scope_mismatch";
  }
  if (!c.taxIncludedConfirmed) return "condition_link_basis_tax_scope_unclear";
  if (c.anyVisiblePriceEqualsPriceTimesAdults) {
    return "condition_link_basis_confirmed_total_matches_price_times_adults";
  }
  if (c.anyVisiblePriceEqualsDayListPrice) return "condition_link_basis_confirmed_per_person_only";
  return "condition_link_basis_price_mismatch";
}

export function decideConditionBasis(
  classification: RakutenConditionBasisClassification
): RakutenConditionBasisDecision {
  if (classification === "condition_link_basis_confirmed_total_matches_price_times_adults") {
    return "rakuten_price_basis_confirmed";
  }
  if (
    classification === "condition_link_basis_destination_unreachable" ||
    classification === "condition_link_basis_render_blocked" ||
    classification === "condition_link_basis_unexpected_error"
  ) {
    return "rakuten_price_basis_not_ready";
  }
  return "rakuten_price_basis_needs_manual_review";
}

export function renderConditionBasisCsv(rows: RakutenConditionBasisRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.fSyu,
      row.fCampId,
      row.sourceViewDate,
      row.selectedViewDay,
      String(row.selectedEpoch),
      String(row.dayListPrice),
      String(row.expectedTwoAdultTotal),
      String(row.destinationHttpStatus),
      row.destinationFinalUrlSanitized,
      row.fetchMode,
      row.pageTitle,
      yn(row.dateScopeDetected),
      yn(row.adultCountDetected),
      yn(row.roomCountDetected),
      yn(row.nightCountDetected),
      yn(row.taxIncludedTextPresent),
      yn(row.totalMatchDetected),
      yn(row.perPersonMatchDetected),
      row.classification,
      row.decision,
      row.riskNote,
      row.debugArtifactPath
    ].map(csvEscape).join(",")
  );
  return [RAKUTEN_CONDITION_BASIS_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderConditionBasisReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  rows: RakutenConditionBasisRow[];
  selectedDay: HplanDay | null;
  comparison: BasisComparison | null;
  priceCandidates: PriceCandidate[];
  destinationUrlSanitized: string;
}): string {
  const row = input.rows[0];
  return [
    "# Rakuten Populated Condition-Link Basis Probe (Phase 65X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${row?.decision ?? "rakuten_price_basis_not_ready"}`,
    `- classification=${row?.classification ?? "condition_link_basis_unexpected_error"}`,
    `- followed_links=${input.rows.length}`,
    "- Scope: one populated condition link from the Phase 64X positive JSONP response.",
    "",
    "## 2. Source JSONP context",
    "",
    `- selected_view_day=${input.selectedDay?.viewDay ?? "none"}`,
    `- dayList.price=${input.selectedDay?.price ?? 0}`,
    `- dayList.priceWithoutTax=${input.selectedDay?.priceWithoutTax ?? 0}`,
    `- dayList.discountedPrice=${input.selectedDay?.discountedPrice ?? 0}`,
    `- destination_url_sanitized=${input.destinationUrlSanitized}`,
    "",
    "## 3. Destination page signals",
    "",
    ...(row
      ? [
          `- http_status=${row.destinationHttpStatus}`,
          `- page_title=${row.pageTitle}`,
          `- date_scope_detected=${yn(row.dateScopeDetected)}`,
          `- adult_count_detected=${yn(row.adultCountDetected)}`,
          `- room_count_detected=${yn(row.roomCountDetected)}`,
          `- night_count_detected=${yn(row.nightCountDetected)}`,
          `- tax_included_text_present=${yn(row.taxIncludedTextPresent)}`
        ]
      : ["- No row generated."]),
    "",
    "## 4. Price candidates",
    "",
    ...input.priceCandidates.slice(0, 20).map((p) => `- ${p.numericValue} JPY / ${p.candidateTypeGuess}: ${p.rawText}`),
    ...(input.priceCandidates.length === 0 ? ["- none"] : []),
    "",
    "## 5. JSONP vs destination comparison",
    "",
    ...(input.comparison
      ? [
          `- expected_per_person_tax_included=${input.comparison.expectedPerPersonTaxIncluded}`,
          `- expected_2_adult_total_tax_included=${input.comparison.expectedTwoAdultTotalTaxIncluded}`,
          `- visible_price_equals_dayList.price=${yn(input.comparison.anyVisiblePriceEqualsDayListPrice)}`,
          `- visible_price_equals_dayList.price_times_2=${yn(input.comparison.anyVisiblePriceEqualsPriceTimesAdults)}`,
          `- date_matches=${yn(input.comparison.dateMatches)}`,
          `- adult_scope_matches=${yn(input.comparison.adultScopeMatches)}`,
          `- room_scope_matches=${yn(input.comparison.roomScopeMatches)}`,
          `- night_scope_matches=${yn(input.comparison.nightScopeMatches)}`,
          `- tax_included_confirmed=${yn(input.comparison.taxIncludedConfirmed)}`,
          `- extra_fee_notes=${input.comparison.extraFeeNotes.join(" / ") || "none"}`
        ]
      : ["- comparison unavailable"]),
    "",
    "## 6. Safety confirmation",
    "",
    "- Read-only public condition-link inspection; no login, no cookie injection, no form submission, no booking/payment actions, no paid APIs/proxies, no stealth, no CAPTCHA bypass.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 7. Recommended next action",
    "",
    row?.decision === "rakuten_price_basis_confirmed"
      ? "- Proceed to Phase 66X: limited read-only Rakuten collector prototype for 2 properties x 2 months, local output only, still no DB writes."
      : "- Do not guess. Run the narrow Phase 65Y manual screenshot/HTML basis review or follow one additional condition link from 39565.",
    "",
    `CSV: ${input.csvPath}`,
    `Debug: ${input.debugRootPath}`,
    ""
  ].join("\n");
}

function guessCandidateType(context: string): PriceCandidateType {
  if (/税抜|税別/u.test(context)) return "tax_excluded";
  if (/割引|クーポン|discount/u.test(context)) return "discounted_total";
  if (/1\s*名|１\s*名|一名|大人1名|お一人|1人|１人/u.test(context)) return "per_person_tax_included";
  if (/合計|総額|お支払い|2\s*名|２\s*名|2人|２人/u.test(context) && /税込/u.test(context)) {
    return "total_2_adult_tax_included";
  }
  return "unknown";
}

function detectSelectedDate(text: string, day: HplanDay): boolean {
  const date = new Date(day.epoch);
  if (!Number.isFinite(date.getTime())) return false;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const d = date.getDate();
  const paddedMonth = String(month).padStart(2, "0");
  const paddedDay = String(d).padStart(2, "0");
  const patterns = [
    `${year}年${month}月${d}日`,
    `${year}年${paddedMonth}月${paddedDay}日`,
    `${year}/${paddedMonth}/${paddedDay}`,
    `${year}-${paddedMonth}-${paddedDay}`,
    `${month}月${d}日`,
    `${paddedMonth}月${paddedDay}日`
  ];
  return patterns.some((p) => text.includes(p));
}

function findJoined(text: string, pattern: RegExp): string {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = (match[0] ?? "").trim();
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= 3) break;
  }
  return out.join(" / ");
}

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

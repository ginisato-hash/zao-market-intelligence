import {
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  extractBookingPriceCandidates,
  sanitizeBookingUrl,
  type BookingPriceCandidate,
  type BookingRenderedDomTarget
} from "./bookingRenderedDomProbe";

export type BookingTaxBasisClassification =
  | "booking_room_total_tax_included_confirmed"
  | "booking_room_total_tax_excluded_requires_adder"
  | "booking_room_total_tax_and_charges_unclear"
  | "booking_price_candidate_basis_unclear"
  | "booking_no_price_available";

export type BookingBasisConfidence = "A" | "B" | "C" | "none";

export type BookingRateCardClassification =
  | "booking_rate_card_price_basis_confirmed"
  | "booking_rate_card_price_basis_likely"
  | "booking_rate_card_price_basis_unclear"
  | "booking_rate_card_sold_out"
  | "booking_rate_card_table_missing"
  | "booking_rate_card_property_mismatch"
  | "booking_rate_card_blocked"
  | "booking_rate_card_navigation_failed"
  | "booking_rate_card_unexpected_error";

export type BookingRateCardDecision =
  | "booking_rate_card_extraction_ready"
  | "booking_rate_card_basis_hardening_needed"
  | "booking_rate_card_not_ready";

export interface SelectorPresence {
  propertyHeadlineName: number;
  hprtTableId: number;
  hprtTableTestId: number;
  availabilityAlert: number;
  priceAndDiscountedPrice: number;
  priceChargesAndTaxes: number;
  availabilityRateInformation: number;
  recommendedUnits: number;
  roomCard: number;
  propertyCard: number;
}

export interface BookingRateCardCandidate {
  roomName: string;
  rateName: string;
  roomCardText: string;
  occupancyHint: string;
  bedHint: string;
  priceRaw: string;
  priceNumeric: number;
  taxChargeText: string;
  context: string;
}

export interface BookingRateCardRow {
  runId: string;
  collectedAtJst: string;
  source: "booking";
  propertyNameExpected: string;
  bookingSlug: string;
  checkin: string;
  checkout: string;
  groupAdults: number;
  noRooms: number;
  groupChildren: number;
  selectedCurrency: "JPY";
  lang: "ja";
  urlSanitized: string;
  finalUrlSanitized: string;
  pageTitle: string;
  propertyHeadlineName: string;
  propertyIdentityMatch: boolean;
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
  primaryTaxChargeText: string;
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
  classification: BookingRateCardClassification;
  debugArtifactPath: string;
}

export const BOOKING_RATE_CARD_CSV_HEADERS = [
  "run_id",
  "collected_at_jst",
  "source",
  "property_name_expected",
  "booking_slug",
  "checkin",
  "checkout",
  "group_adults",
  "no_rooms",
  "group_children",
  "selected_currency",
  "lang",
  "url_sanitized",
  "final_url_sanitized",
  "page_title",
  "property_headline_name",
  "property_identity_match",
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
  "primary_tax_charge_text",
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

export const REQUIRED_BOOKING_SELECTORS = {
  propertyHeadlineName: '[data-testid="property-headline-name"]',
  hprtTableId: "#hprt-table",
  hprtTableTestId: '[data-testid="hprt-table"]',
  availabilityAlert: '[data-testid="availability-alert"]',
  priceAndDiscountedPrice: '[data-testid="price-and-discounted-price"]',
  priceChargesAndTaxes: '[data-testid="price-charges-and-taxes"]',
  availabilityRateInformation: '[data-testid="availability-rate-information"]',
  recommendedUnits: '[data-testid="recommended-units"]',
  roomCard: '[data-testid="room-card"]',
  propertyCard: '[data-testid="property-card"]'
} as const;

export function buildBookingRateCardUrl(input: BookingRenderedDomTarget & { checkin: string }): string {
  return buildBookingRenderedDomUrl(input);
}

export function summarizeSelectorPresence(counts: Partial<SelectorPresence>): SelectorPresence {
  return {
    propertyHeadlineName: counts.propertyHeadlineName ?? 0,
    hprtTableId: counts.hprtTableId ?? 0,
    hprtTableTestId: counts.hprtTableTestId ?? 0,
    availabilityAlert: counts.availabilityAlert ?? 0,
    priceAndDiscountedPrice: counts.priceAndDiscountedPrice ?? 0,
    priceChargesAndTaxes: counts.priceChargesAndTaxes ?? 0,
    availabilityRateInformation: counts.availabilityRateInformation ?? 0,
    recommendedUnits: counts.recommendedUnits ?? 0,
    roomCard: counts.roomCard ?? 0,
    propertyCard: counts.propertyCard ?? 0
  };
}

export function matchBookingPropertyIdentity(expected: string, headline: string, pageTitle: string, finalUrl: string, slug: string): boolean {
  const expectedNorm = normalizeName(expected);
  const headlineNorm = normalizeName(headline);
  const titleNorm = normalizeName(pageTitle);
  if (expectedNorm !== "" && (headlineNorm.includes(expectedNorm) || titleNorm.includes(expectedNorm))) return true;
  return finalUrl.includes(`/hotel/jp/${slug}`);
}

export function detectBlockingOrModalState(text: string, httpStatus: number): string {
  const t = normalizeText(text);
  if (httpStatus === 0) return "navigation_failed";
  if (/(captcha|recaptcha|are you a robot|ロボットではありません|セキュリティチェック)/iu.test(t)) return "captcha_or_security";
  if (/(cookie|クッキー|同意|consent)/iu.test(t) && t.length < 1_000) return "consent_or_cookie_modal";
  if (/(ログインが必要|サインインが必要|sign in required|login required|must sign in)/iu.test(t)) return "login_required";
  return "none";
}

export function detectSoldOutText(text: string): boolean {
  return /(売り切れ|満室|空室なし|予約できません|ご利用いただけません|not available|sold out)/iu.test(text);
}

export function extractPrimaryRateCardCandidate(text: string): BookingRateCardCandidate | null {
  const normalized = normalizeText(text);
  const candidates = extractBookingPriceCandidates(normalized).filter((c) => c.numericValue >= 1_000);
  const preferred =
    candidates.find((c) => /人数:\s*2|大人\s*2|大人2名|2名/u.test(c.contextBeforeAfter) && /料金|部屋数を選択/u.test(c.contextBeforeAfter)) ??
    candidates.find((c) => /人数:\s*2|大人\s*2|大人2名|2名/u.test(c.contextBeforeAfter)) ??
    candidates[0];
  if (!preferred) return null;
  const roomContext = extractRoomContextAroundPrice(normalized, preferred);
  return {
    roomName: roomContext.roomName,
    rateName: extractRateNameAroundPrice(preferred.contextBeforeAfter),
    roomCardText: roomContext.roomCardText,
    occupancyHint: roomContext.occupancyHint,
    bedHint: roomContext.bedHint,
    priceRaw: preferred.rawText,
    priceNumeric: preferred.numericValue,
    taxChargeText: extractTaxChargeText(preferred.contextBeforeAfter),
    context: preferred.contextBeforeAfter
  };
}

export function classifyBookingTaxBasis(input: {
  candidate: BookingRateCardCandidate | null;
  is2AdultScopeConfirmed: boolean;
  is1RoomScopeConfirmed: boolean;
  is1NightScopeConfirmed: boolean;
}): { taxBasisClassification: BookingTaxBasisClassification; basisConfidence: BookingBasisConfidence; basisNote: string } {
  if (!input.candidate) {
    return {
      taxBasisClassification: "booking_no_price_available",
      basisConfidence: "none",
      basisNote: "No usable primary price candidate was visible."
    };
  }

  const context = input.candidate.context;
  const scopeStrong = input.is2AdultScopeConfirmed && input.is1RoomScopeConfirmed && input.is1NightScopeConfirmed;
  if (/税・手数料込み|税込|taxes and fees included/iu.test(context) && scopeStrong) {
    return {
      taxBasisClassification: "booking_room_total_tax_included_confirmed",
      basisConfidence: "A",
      basisNote: "Visible text explicitly indicates tax/fee included price with 2-adult / 1-room / 1-night scope."
    };
  }
  if (/＋税・手数料|税・手数料（|taxes and charges|taxes and fees/iu.test(context) && scopeStrong) {
    return {
      taxBasisClassification: "booking_room_total_tax_excluded_requires_adder",
      basisConfidence: "B",
      basisNote: "Visible text confirms 2-adult / 1-room / 1-night scope, but price has separate taxes/fees that require an adder."
    };
  }
  if (/込\s*消費税|消費税\/VAT|VAT/iu.test(context) && scopeStrong) {
    return {
      taxBasisClassification: "booking_room_total_tax_and_charges_unclear",
      basisConfidence: "B",
      basisNote: "Visible text suggests VAT is included, but separate charges/taxes may still apply."
    };
  }
  return {
    taxBasisClassification: "booking_price_candidate_basis_unclear",
    basisConfidence: "C",
    basisNote: "A price candidate is visible, but tax/fee or occupancy scope is not explicit enough."
  };
}

export function classifyBookingRateCardRow(input: {
  propertyIdentityMatch: boolean;
  rateCardPresent: boolean;
  soldOutTextPresent: boolean;
  blockingOrModalState: string;
  candidate: BookingRateCardCandidate | null;
  basisConfidence: BookingBasisConfidence;
}): BookingRateCardClassification {
  if (input.blockingOrModalState !== "none") return "booking_rate_card_blocked";
  if (!input.propertyIdentityMatch) return "booking_rate_card_property_mismatch";
  if (input.soldOutTextPresent && !input.candidate) return "booking_rate_card_sold_out";
  if (!input.rateCardPresent) return "booking_rate_card_table_missing";
  if (!input.candidate) return "booking_rate_card_price_basis_unclear";
  if (input.basisConfidence === "A") return "booking_rate_card_price_basis_confirmed";
  if (input.basisConfidence === "B") return "booking_rate_card_price_basis_likely";
  return "booking_rate_card_price_basis_unclear";
}

export function buildBookingRateCardRow(input: {
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
}): BookingRateCardRow {
  const checkout = checkoutForOneNight(input.checkin);
  const url = buildBookingRateCardUrl({ ...input.target, checkin: input.checkin });
  const blockingOrModalState = detectBlockingOrModalState(input.visibleText, input.httpStatus);
  const soldOutTextPresent = detectSoldOutText(input.visibleText);
  const candidate = extractPrimaryRateCardCandidate(input.visibleText);
  const propertyIdentityMatch = matchBookingPropertyIdentity(
    input.target.canonicalPropertyName,
    input.propertyHeadlineName,
    input.pageTitle,
    input.finalUrl,
    input.target.slug
  );
  const rateCardPresent =
    input.selectorPresence.hprtTableId > 0 ||
    input.selectorPresence.hprtTableTestId > 0 ||
    /部屋タイプ\s+宿泊人数|部屋数を選択|数を選択/u.test(input.visibleText);
  const is2AdultScopeConfirmed = /大人\s*2\s*名|大人2名|人数:\s*2|2\s*名/u.test(input.visibleText);
  const is1RoomScopeConfirmed = /1\s*部屋|1\s*室|部屋数を選択|数を選択/u.test(input.visibleText);
  const is1NightScopeConfirmed = /1\s*泊|1泊|1泊に最適/u.test(input.visibleText);
  const basis = classifyBookingTaxBasis({ candidate, is2AdultScopeConfirmed, is1RoomScopeConfirmed, is1NightScopeConfirmed });
  const classification = classifyBookingRateCardRow({
    propertyIdentityMatch,
    rateCardPresent,
    soldOutTextPresent,
    blockingOrModalState,
    candidate,
    basisConfidence: basis.basisConfidence
  });
  return {
    runId: input.runId,
    collectedAtJst: input.collectedAtJst,
    source: "booking",
    propertyNameExpected: input.target.canonicalPropertyName,
    bookingSlug: input.target.slug,
    checkin: input.checkin,
    checkout,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    selectedCurrency: "JPY",
    lang: "ja",
    urlSanitized: sanitizeBookingUrl(url),
    finalUrlSanitized: sanitizeBookingUrl(input.finalUrl),
    pageTitle: input.pageTitle,
    propertyHeadlineName: input.propertyHeadlineName,
    propertyIdentityMatch,
    rateCardPresent,
    hprtTablePresent: input.selectorPresence.hprtTableId > 0 || input.selectorPresence.hprtTableTestId > 0,
    availabilityAlertPresent: input.selectorPresence.availabilityAlert > 0,
    soldOutTextPresent,
    primaryRoomName: candidate?.roomName ?? "",
    primaryRateName: candidate?.rateName ?? "",
    primaryRoomCardText: candidate?.roomCardText ?? "",
    primaryOccupancyHint: candidate?.occupancyHint ?? "",
    primaryBedHint: candidate?.bedHint ?? "",
    primaryPriceRaw: candidate?.priceRaw ?? "",
    primaryPriceNumeric: candidate?.priceNumeric ?? null,
    primaryTaxChargeText: candidate?.taxChargeText ?? "",
    taxBasisClassification: basis.taxBasisClassification,
    basisConfidence: basis.basisConfidence,
    basisNote: basis.basisNote,
    isRoomTotalCandidate: candidate !== null && is1RoomScopeConfirmed,
    is2AdultScopeConfirmed,
    is1RoomScopeConfirmed,
    is1NightScopeConfirmed,
    currencyDetected: /JPY|￥|¥|円/u.test(input.visibleText),
    languageDetected: /予約|空室|料金|部屋/u.test(input.visibleText),
    blockingOrModalState,
    classification,
    debugArtifactPath: input.debugArtifactPath
  };
}

export function decideBookingRateCardExtraction(rows: BookingRateCardRow[]): BookingRateCardDecision {
  const usableAB = rows.filter((row) => row.primaryPriceNumeric !== null && (row.basisConfidence === "A" || row.basisConfidence === "B")).length;
  if (usableAB >= 3) return "booking_rate_card_extraction_ready";
  const usableAny = rows.some((row) => row.primaryPriceNumeric !== null);
  if (usableAny) return "booking_rate_card_basis_hardening_needed";
  return "booking_rate_card_not_ready";
}

export function renderBookingRateCardCsv(rows: BookingRateCardRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.collectedAtJst,
      row.source,
      row.propertyNameExpected,
      row.bookingSlug,
      row.checkin,
      row.checkout,
      String(row.groupAdults),
      String(row.noRooms),
      String(row.groupChildren),
      row.selectedCurrency,
      row.lang,
      row.urlSanitized,
      row.finalUrlSanitized,
      row.pageTitle,
      row.propertyHeadlineName,
      bool(row.propertyIdentityMatch),
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
      row.primaryTaxChargeText,
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
  return [BOOKING_RATE_CARD_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderBookingRateCardReport(input: {
  generatedAt: string;
  rows: BookingRateCardRow[];
  selectorPresenceByRow: Array<{ rowKey: string; selectorPresence: SelectorPresence }>;
  decision: BookingRateCardDecision;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): string {
  const selectorTotals = totalSelectorPresence(input.selectorPresenceByRow.map((r) => r.selectorPresence));
  return [
    "# Booking.com Rate Card Extraction Probe (Phase B02X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.decision}`,
    `- rows_tested=${input.rows.length}`,
    `- classification_counts=${JSON.stringify(countBy(input.rows.map((r) => r.classification)))}`,
    `- basis_confidence_counts=${JSON.stringify(countBy(input.rows.map((r) => r.basisConfidence)))}`,
    "",
    "## 2. Selector presence summary",
    "",
    `- ${JSON.stringify(selectorTotals)}`,
    "",
    "## 3. Row results",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.propertyNameExpected} ${row.checkin}: identity=${bool(row.propertyIdentityMatch)}, rate_card=${bool(row.rateCardPresent)}, price=${row.primaryPriceNumeric ?? "n/a"}, tax_basis=${row.taxBasisClassification}, confidence=${row.basisConfidence}, class=${row.classification}`
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
    "- Read-only rendered DOM probe over the same six public Booking.com rows.",
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

export function totalSelectorPresence(items: SelectorPresence[]): SelectorPresence {
  const out = summarizeSelectorPresence({});
  for (const item of items) {
    for (const key of Object.keys(out) as Array<keyof SelectorPresence>) out[key] += item[key];
  }
  return out;
}

export function extractRoomContextAroundPrice(text: string, candidate: BookingPriceCandidate): {
  roomName: string;
  roomCardText: string;
  occupancyHint: string;
  bedHint: string;
} {
  const idx = text.indexOf(candidate.rawText);
  const before = idx >= 0 ? text.slice(Math.max(0, idx - 700), idx) : candidate.contextBeforeAfter;
  const after = idx >= 0 ? text.slice(idx, Math.min(text.length, idx + candidate.rawText.length + 260)) : candidate.contextBeforeAfter;
  const roomCardText = compactRoomContext(`${before} ${after}`).slice(0, 900);
  return {
    roomName: extractRoomNameBeforePrice(roomCardText, candidate),
    roomCardText,
    occupancyHint: extractOccupancyHint(roomCardText),
    bedHint: extractBedHint(roomCardText)
  };
}

function extractRoomNameBeforePrice(text: string, candidate: BookingPriceCandidate): string {
  const idx = text.indexOf(candidate.rawText);
  const before = idx >= 0 ? text.slice(Math.max(0, idx - 500), idx) : text;
  const markers = before.split(/部屋タイプ\s+宿泊人数\s+本日の料金\s+(?:確認事項\s+)?(?:部屋数を選択|数を選択)|部屋数を選択\s+0\s+1\s+\([^)]+\)/u);
  const segment = markers.at(-1) ?? before;
  const direct = extractRoomNameByToken(segment);
  if (direct) return direct;
  const lines = segment.split(/\s{2,}|\t|\n/u).map((part) => part.trim()).filter(Boolean);
  return lines.find((line) => /ツイン|ダブル|クイーン|キング|シングル|セミダブル|トリプル|ファミリー|スイート|Twin|Double|Queen|King|Single|Triple|Family|Suite/iu.test(line))?.slice(0, 160) ?? "";
}

function extractRoomNameByToken(text: string): string {
  const jp = /([^\s]{0,24}(?:ツイン|ダブル|クイーン|キング|シングル|セミダブル|トリプル|ファミリー|スイート|ドミトリー|カプセル)[^\s]{0,32}(?:ルーム|客室|部屋)?[^\s]{0,16})/u.exec(text);
  if (jp?.[1]) return cleanupRoomName(jp[1]);
  const en = /([A-Za-z][A-Za-z0-9\s-]{0,48}(?:Twin|Double|Queen|King|Single|Semi-Double|Small Double|Triple|Family|Suite|Dormitory|Capsule)[A-Za-z0-9\s-]{0,36}(?:Room|Suite)?)/iu.exec(text);
  return en?.[1] ? cleanupRoomName(en[1]) : "";
}

function extractOccupancyHint(text: string): string {
  const match = /(人数:\s*\d+|大人\s*\d+\s*名|宿泊人数\s*\d+|定員\s*\d+\s*名|sleeps\s*\d+|guests?:\s*\d+)/iu.exec(text);
  return match?.[0]?.slice(0, 80) ?? "";
}

function extractBedHint(text: string): string {
  const match = /(ツインベッド|ダブルベッド|クイーンベッド|キングベッド|シングルベッド|セミダブルベッド|2\s*beds?|two\s*beds?|1\s*queen|1\s*king|twin\s*beds?|double\s*beds?|queen\s*beds?|king\s*beds?|small\s*double\s*beds?)/iu.exec(text);
  return match?.[0]?.slice(0, 120) ?? "";
}

function cleanupRoomName(text: string): string {
  return text
    .replace(/^(?:部屋タイプ|客室タイプ|ルームタイプ)\s*/u, "")
    .replace(/\s*(?:人数:\s*\d+|大人\s*\d+\s*名|宿泊人数).*$/u, "")
    .trim()
    .slice(0, 160);
}

function compactRoomContext(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function extractRateNameAroundPrice(context: string): string {
  const match = /(食事なし|朝食込[^ ]*|朝食\+夕食込み|返金不可|キャンセル無料|パートナー・オファー|オンライン決済)/u.exec(context);
  return match?.[0] ?? "";
}

function extractTaxChargeText(context: string): string {
  const match = /(＋税・手数料（[^）]+）(?:\s*込\s*消費税\/VAT10\s*%)?|税・手数料込み|込\s*消費税\/VAT10\s*%|税込)/u.exec(context);
  return match?.[0] ?? "";
}

function normalizeName(value: string): string {
  return normalizeText(value).replace(/[\s　・'’\-‐ー()（）]/gu, "").toLowerCase();
}

function normalizeText(value: string): string {
  return value.replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\s+/gu, " ").trim();
}

function recommendedNextAction(decision: BookingRateCardDecision): string {
  if (decision === "booking_rate_card_extraction_ready") {
    return "- Proceed to a limited read-only Booking extractor prototype with local output only. Keep DB writes disabled until selector stability is reviewed.";
  }
  if (decision === "booking_rate_card_basis_hardening_needed") {
    return "- Harden basis parsing with one more selector-focused pass; do not promote to DB collector yet.";
  }
  return "- Booking rate-card extraction is not ready. Do not broaden scraping; inspect blocking/table-missing rows manually.";
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

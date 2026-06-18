import { extractBookingRoomContextAroundPrice } from "./bookingRoomContextExtraction";
import { classifyRoomBasisFromParts, type RoomBasis } from "./roomBasisClassification";

export type BookingRenderedDomClassification =
  | "booking_rendered_price_basis_candidate_found"
  | "booking_rendered_sold_out_or_unavailable"
  | "booking_rendered_content_visible_no_safe_price"
  | "booking_rendered_empty_or_near_empty"
  | "booking_rendered_captcha_or_security"
  | "booking_rendered_login_required"
  | "booking_rendered_not_found"
  | "booking_rendered_navigation_failed"
  | "booking_rendered_unexpected_error";

export type BookingRenderedDomDecision =
  | "booking_rendered_dom_feasibility_price_candidate_found"
  | "booking_rendered_dom_feasibility_needs_manual_review"
  | "booking_rendered_dom_feasibility_not_ready";

export interface BookingRenderedDomTarget {
  canonicalPropertyName: string;
  slug: string;
}

export interface BookingRenderedDomProbeInput extends BookingRenderedDomTarget {
  checkin: string; // YYYY-MM-DD
}

export interface BookingPriceCandidate {
  rawText: string;
  numericValue: number;
  contextBeforeAfter: string;
  candidateTypeGuess: "total_tax_included" | "per_night_or_room" | "tax_excluded" | "unknown";
}

export interface BookingRenderedDomSignals {
  loaded: boolean;
  httpStatus: number;
  finalUrl: string;
  pageTitle: string;
  bodyText: string;
  bodyTextLength: number;
  propertyNameDetected: boolean;
  checkinDetected: boolean;
  checkoutDetected: boolean;
  adultCountDetected: boolean;
  roomCountDetected: boolean;
  nightCountDetected: boolean;
  jpyCurrencyDetected: boolean;
  priceCandidates: BookingPriceCandidate[];
  soldOutOrUnavailableDetected: boolean;
  captchaOrSecurityDetected: boolean;
  loginRequiredDetected: boolean;
  notFoundDetected: boolean;
  // Room context extracted around the first price candidate (room-basis input).
  primaryRoomName: string;
  primaryRoomCardText: string;
  primaryOccupancyHint: string;
  primaryBedHint: string;
  error: string;
}

export interface BookingRenderedDomRow {
  canonicalPropertyName: string;
  slug: string;
  checkin: string;
  checkout: string;
  probeUrlSanitized: string;
  loaded: boolean;
  httpStatus: number;
  finalUrlSanitized: string;
  pageTitle: string;
  bodyTextLength: number;
  propertyNameDetected: boolean;
  checkinDetected: boolean;
  checkoutDetected: boolean;
  adultCountDetected: boolean;
  roomCountDetected: boolean;
  nightCountDetected: boolean;
  jpyCurrencyDetected: boolean;
  priceCandidateCount: number;
  firstPriceCandidateValue: number | null;
  soldOutOrUnavailableDetected: boolean;
  // Room context + room-basis classification (room-only two-person standard gate).
  primaryRoomName: string;
  primaryRoomCardText: string;
  primaryOccupancyHint: string;
  primaryBedHint: string;
  roomBasis: RoomBasis;
  roomBasisReason: string;
  classification: BookingRenderedDomClassification;
  riskNote: string;
  debugArtifactPath: string;
}

export const BOOKING_RENDERED_DOM_CSV_HEADERS = [
  "canonical_property_name",
  "slug",
  "checkin",
  "checkout",
  "probe_url_sanitized",
  "loaded",
  "http_status",
  "final_url_sanitized",
  "page_title",
  "body_text_length",
  "property_name_detected",
  "checkin_detected",
  "checkout_detected",
  "adult_count_detected",
  "room_count_detected",
  "night_count_detected",
  "jpy_currency_detected",
  "price_candidate_count",
  "first_price_candidate_value",
  "sold_out_or_unavailable_detected",
  "primary_room_name",
  "primary_room_card_text",
  "primary_occupancy_hint",
  "primary_bed_hint",
  "room_basis",
  "room_basis_reason",
  "classification",
  "risk_note",
  "debug_artifact_path"
] as const;

export function checkoutForOneNight(checkin: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(checkin)) throw new Error(`checkin must be YYYY-MM-DD: ${checkin}`);
  const [year, month, day] = checkin.split("-").map((part) => Number(part));
  const d = new Date(Date.UTC(year!, month! - 1, day!));
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function buildBookingRenderedDomUrl(input: BookingRenderedDomProbeInput): string {
  if (!/^[a-z0-9-]+$/u.test(input.slug)) throw new Error(`invalid Booking slug: ${input.slug}`);
  const checkout = checkoutForOneNight(input.checkin);
  const params = new URLSearchParams({
    checkin: input.checkin,
    checkout,
    group_adults: "2",
    no_rooms: "1",
    group_children: "0",
    selected_currency: "JPY",
    lang: "ja"
  });
  return `https://www.booking.com/hotel/jp/${input.slug}.ja.html?${params.toString()}`;
}

export function sanitizeBookingUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/aid|label|sid|auth|token|utm_|gclid|yclid/iu.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function extractBookingPriceCandidates(text: string): BookingPriceCandidate[] {
  const candidates: BookingPriceCandidate[] = [];
  const yenRe = /(?:￥|¥|JPY\s*)\s*([0-9０-９,，]+)|([0-9０-９,，]+)\s*円/giu;
  let match: RegExpExecArray | null;
  while ((match = yenRe.exec(text)) !== null) {
    const rawNumber = match[1] ?? match[2] ?? "";
    const numericValue = Number(toHalfWidth(rawNumber).replace(/[，,]/gu, ""));
    if (!Number.isFinite(numericValue) || numericValue <= 0) continue;
    const start = Math.max(0, match.index - 70);
    const end = Math.min(text.length, match.index + (match[0]?.length ?? 0) + 70);
    const context = text.slice(start, end).replace(/\s+/gu, " ").trim();
    candidates.push({
      rawText: match[0] ?? "",
      numericValue,
      contextBeforeAfter: context,
      candidateTypeGuess: guessPriceCandidateType(context)
    });
  }
  return dedupePriceCandidates(candidates).slice(0, 20);
}

export function analyzeBookingRenderedDomSignals(input: {
  target: BookingRenderedDomTarget;
  checkin: string;
  checkout: string;
  loaded: boolean;
  httpStatus: number;
  finalUrl: string;
  pageTitle: string;
  bodyText: string;
  error?: string;
}): BookingRenderedDomSignals {
  const text = normalizeText(input.bodyText);
  const priceCandidates = extractBookingPriceCandidates(text);
  const roomContext = extractBookingRoomContextAroundPrice({
    bodyText: text,
    priceValue: priceCandidates[0]?.numericValue ?? null,
    priceRawText: priceCandidates[0]?.rawText,
    contextBeforeAfter: priceCandidates[0]?.contextBeforeAfter
  });
  return {
    loaded: input.loaded,
    httpStatus: input.httpStatus,
    finalUrl: input.finalUrl,
    pageTitle: input.pageTitle,
    bodyText: input.bodyText,
    bodyTextLength: text.length,
    propertyNameDetected:
      looseIncludes(text, input.target.canonicalPropertyName) ||
      looseIncludes(text, input.target.slug) ||
      input.finalUrl.includes(`/hotel/jp/${input.target.slug}`),
    checkinDetected: detectDate(text, input.checkin),
    checkoutDetected: detectDate(text, input.checkout),
    adultCountDetected: /大人\s*2\s*名|大人２名|2\s*名の大人|２\s*名の大人|group_adults=2/iu.test(text),
    roomCountDetected: /1\s*室|１\s*室|1\s*部屋|１\s*部屋|no_rooms=1/iu.test(text),
    nightCountDetected: /1\s*泊|１\s*泊|1\s*泊分|１\s*泊分/iu.test(text),
    jpyCurrencyDetected: /￥|¥|JPY|円/u.test(text),
    priceCandidates,
    soldOutOrUnavailableDetected: /(売り切れ|満室|空室なし|予約できません|ご利用いただけません|not available|sold out)/iu.test(text),
    captchaOrSecurityDetected: /(captcha|recaptcha|are you a robot|ロボットではありません|セキュリティチェック)/iu.test(text),
    loginRequiredDetected: /(ログイン|サインイン|sign in|log in)/iu.test(text),
    notFoundDetected: /(page not found|ページが見つかりません|お探しのページ)/iu.test(text),
    primaryRoomName: roomContext.primaryRoomName,
    primaryRoomCardText: roomContext.primaryRoomCardText,
    primaryOccupancyHint: roomContext.primaryOccupancyHint,
    primaryBedHint: roomContext.primaryBedHint,
    error: input.error ?? ""
  };
}

export function classifyBookingRenderedDom(signals: BookingRenderedDomSignals): BookingRenderedDomClassification {
  if (!signals.loaded) return "booking_rendered_navigation_failed";
  if (signals.captchaOrSecurityDetected) return "booking_rendered_captcha_or_security";
  if (signals.notFoundDetected || signals.httpStatus === 404) return "booking_rendered_not_found";
  if (signals.loginRequiredDetected && signals.bodyTextLength < 1_000) return "booking_rendered_login_required";
  if (signals.bodyTextLength < 300) return "booking_rendered_empty_or_near_empty";
  if (signals.soldOutOrUnavailableDetected && signals.priceCandidates.length === 0) {
    return "booking_rendered_sold_out_or_unavailable";
  }
  if (
    signals.propertyNameDetected &&
    signals.checkinDetected &&
    signals.checkoutDetected &&
    signals.adultCountDetected &&
    signals.roomCountDetected &&
    signals.nightCountDetected &&
    signals.jpyCurrencyDetected &&
    signals.priceCandidates.length > 0
  ) {
    return "booking_rendered_price_basis_candidate_found";
  }
  return "booking_rendered_content_visible_no_safe_price";
}

export function buildBookingRenderedDomRow(input: {
  target: BookingRenderedDomTarget;
  checkin: string;
  checkout: string;
  probeUrl: string;
  signals: BookingRenderedDomSignals;
  debugArtifactPath: string;
}): BookingRenderedDomRow {
  const classification = classifyBookingRenderedDom(input.signals);
  // Classify room basis from the extracted room context (card text is already
  // sanitized so "シングルベッド2台" reads as a twin, not a single room).
  const roomBasis = classifyRoomBasisFromParts({
    roomName: input.signals.primaryRoomName,
    blockText: input.signals.primaryRoomCardText
  });
  return {
    canonicalPropertyName: input.target.canonicalPropertyName,
    slug: input.target.slug,
    checkin: input.checkin,
    checkout: input.checkout,
    probeUrlSanitized: sanitizeBookingUrl(input.probeUrl),
    loaded: input.signals.loaded,
    httpStatus: input.signals.httpStatus,
    finalUrlSanitized: sanitizeBookingUrl(input.signals.finalUrl),
    pageTitle: input.signals.pageTitle,
    bodyTextLength: input.signals.bodyTextLength,
    propertyNameDetected: input.signals.propertyNameDetected,
    checkinDetected: input.signals.checkinDetected,
    checkoutDetected: input.signals.checkoutDetected,
    adultCountDetected: input.signals.adultCountDetected,
    roomCountDetected: input.signals.roomCountDetected,
    nightCountDetected: input.signals.nightCountDetected,
    jpyCurrencyDetected: input.signals.jpyCurrencyDetected,
    priceCandidateCount: input.signals.priceCandidates.length,
    firstPriceCandidateValue: input.signals.priceCandidates[0]?.numericValue ?? null,
    soldOutOrUnavailableDetected: input.signals.soldOutOrUnavailableDetected,
    primaryRoomName: input.signals.primaryRoomName,
    primaryRoomCardText: input.signals.primaryRoomCardText,
    primaryOccupancyHint: input.signals.primaryOccupancyHint,
    primaryBedHint: input.signals.primaryBedHint,
    roomBasis: roomBasis.roomBasis,
    roomBasisReason: roomBasis.reason,
    classification,
    riskNote: riskNoteForBooking(signalsForRisk(input.signals), classification),
    debugArtifactPath: input.debugArtifactPath
  };
}

export function decideBookingRenderedDomFeasibility(rows: BookingRenderedDomRow[]): BookingRenderedDomDecision {
  if (rows.some((row) => row.classification === "booking_rendered_price_basis_candidate_found")) {
    return "booking_rendered_dom_feasibility_price_candidate_found";
  }
  if (rows.some((row) => row.loaded && row.bodyTextLength >= 300)) {
    return "booking_rendered_dom_feasibility_needs_manual_review";
  }
  return "booking_rendered_dom_feasibility_not_ready";
}

export function renderBookingRenderedDomCsv(rows: BookingRenderedDomRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.slug,
      row.checkin,
      row.checkout,
      row.probeUrlSanitized,
      bool(row.loaded),
      String(row.httpStatus),
      row.finalUrlSanitized,
      row.pageTitle,
      String(row.bodyTextLength),
      bool(row.propertyNameDetected),
      bool(row.checkinDetected),
      bool(row.checkoutDetected),
      bool(row.adultCountDetected),
      bool(row.roomCountDetected),
      bool(row.nightCountDetected),
      bool(row.jpyCurrencyDetected),
      String(row.priceCandidateCount),
      row.firstPriceCandidateValue === null ? "" : String(row.firstPriceCandidateValue),
      bool(row.soldOutOrUnavailableDetected),
      row.primaryRoomName,
      row.primaryRoomCardText,
      row.primaryOccupancyHint,
      row.primaryBedHint,
      row.roomBasis,
      row.roomBasisReason,
      row.classification,
      row.riskNote,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [BOOKING_RENDERED_DOM_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderBookingRenderedDomReport(input: {
  generatedAt: string;
  rows: BookingRenderedDomRow[];
  decision: BookingRenderedDomDecision;
  reportPath: string;
  csvPath: string;
  debugRootPath: string;
}): string {
  const counts = countBy(input.rows.map((row) => row.classification));
  return [
    "# Booking.com Rendered DOM Feasibility Probe (Phase B01X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.decision}`,
    `- rows_tested=${input.rows.length}`,
    `- classification_counts=${JSON.stringify(counts)}`,
    "- Scope: fixed public Booking.com hotel slug URLs, 2 adults, 1 room, 1 night, JPY, Japanese.",
    "",
    "## 2. Rows tested",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.canonicalPropertyName} (${row.slug}) ${row.checkin}: loaded=${bool(row.loaded)}, status=${row.httpStatus}, price_candidates=${row.priceCandidateCount}, class=${row.classification}`
    ),
    "",
    "## 3. Basis signals",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.canonicalPropertyName} ${row.checkin}: property=${bool(row.propertyNameDetected)}, checkin=${bool(row.checkinDetected)}, checkout=${bool(row.checkoutDetected)}, adults=${bool(row.adultCountDetected)}, rooms=${bool(row.roomCountDetected)}, nights=${bool(row.nightCountDetected)}, jpy=${bool(row.jpyCurrencyDetected)}, first_price=${row.firstPriceCandidateValue ?? "n/a"}`
    ),
    "",
    "## 4. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 5. Safety confirmation",
    "",
    "- Read-only Playwright rendered DOM probe; no login, no cookies injected, no stealth, no CAPTCHA bypass, no paid API/proxy.",
    "- No DB writes, no collector_runs, no rate_snapshots, no inventory_snapshots.",
    "- No Beds24/AirHost/PMS/OTA upload output.",
    "",
    "## 6. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function detectDate(text: string, iso: string): boolean {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return false;
  const numericMonth = String(Number(m));
  const numericDay = String(Number(d));
  return (
    text.includes(iso) ||
    text.includes(`${y}年${m}月${d}日`) ||
    text.includes(`${y}年${numericMonth}月${numericDay}日`) ||
    text.includes(`${numericMonth}月${numericDay}日`)
  );
}

function guessPriceCandidateType(context: string): BookingPriceCandidate["candidateTypeGuess"] {
  if (/税・手数料込み|税込|税金・手数料込|込\s*消費税|taxes and fees included|includes taxes/iu.test(context)) return "total_tax_included";
  if (/税抜|税別|taxes excluded|excludes taxes/iu.test(context)) return "tax_excluded";
  if (/1泊|部屋|room|night/iu.test(context)) return "per_night_or_room";
  return "unknown";
}

function dedupePriceCandidates(candidates: BookingPriceCandidate[]): BookingPriceCandidate[] {
  const seen = new Set<string>();
  const out: BookingPriceCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.numericValue}:${candidate.contextBeforeAfter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function riskNoteForBooking(
  signals: Pick<BookingRenderedDomSignals, "error" | "priceCandidates" | "soldOutOrUnavailableDetected">,
  classification: BookingRenderedDomClassification
): string {
  if (signals.error) return signals.error;
  if (classification === "booking_rendered_price_basis_candidate_found") {
    return "Rendered page exposed candidate price and date/person/room basis signals; still feasibility-only, not DB-safe collector output.";
  }
  if (classification === "booking_rendered_sold_out_or_unavailable") return "Rendered page indicates sold-out/unavailable without a safe price.";
  if (classification === "booking_rendered_content_visible_no_safe_price") return "Content visible, but safe price/date/person/room basis was not fully detected.";
  if (classification === "booking_rendered_captcha_or_security") return "CAPTCHA/security challenge detected; no bypass attempted.";
  if (classification === "booking_rendered_empty_or_near_empty") return "Empty or near-empty rendered body.";
  return "No safe price extraction.";
}

function signalsForRisk(signals: BookingRenderedDomSignals): Pick<BookingRenderedDomSignals, "error" | "priceCandidates" | "soldOutOrUnavailableDetected"> {
  return {
    error: signals.error,
    priceCandidates: signals.priceCandidates,
    soldOutOrUnavailableDetected: signals.soldOutOrUnavailableDetected
  };
}

function looseIncludes(text: string, needle: string): boolean {
  const normalizedText = normalizeText(text).toLowerCase();
  const normalizedNeedle = normalizeText(needle).toLowerCase();
  return normalizedNeedle !== "" && normalizedText.includes(normalizedNeedle);
}

function normalizeText(text: string): string {
  return toHalfWidth(text).replace(/\s+/gu, " ").trim();
}

function toHalfWidth(text: string): string {
  return text.replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function recommendedNextAction(decision: BookingRenderedDomDecision): string {
  if (decision === "booking_rendered_dom_feasibility_price_candidate_found") {
    return "- Review debug screenshots/text manually, then design a still-read-only extractor with explicit basis validation. Do not write DB rows yet.";
  }
  if (decision === "booking_rendered_dom_feasibility_needs_manual_review") {
    return "- Keep Booking in feasibility mode. Inspect debug artifacts for selectors or visible states before attempting another narrow rendered probe.";
  }
  return "- Booking rendered DOM is not ready. Do not broaden scraping; either adjust fixed URL/browser context narrowly or return to source coverage work.";
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

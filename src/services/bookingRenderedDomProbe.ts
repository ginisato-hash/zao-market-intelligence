import { extractBookingRoomContextAroundPrice, type BookingRoomContext } from "./bookingRoomContextExtraction";
import { classifyBookingRoomBasis, type RoomBasis } from "./roomBasisClassification";
import { MIN_PLAUSIBLE_BOOKING_PRICE_JPY } from "./pricePlausibilityGuard";

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

// What this specific yen amount represents, from the text immediately
// adjacent to it (NOT the wider ±70 contextBeforeAfter window, which for a
// discounted room card contains BOTH "元の料金"/"現在の料金" labels for
// EITHER number — narrow adjacency is what actually distinguishes them).
export type BookingPriceRole = "effective_price" | "original_price" | "tax_or_fee" | "unknown";

// Which page section this candidate's price appears in. Booking renders a
// "similar/related properties" carousel — OTHER hotels' prices — when the
// target property has zero availability for the searched date; those prices
// are plausible-looking (unlike the ¥100 defect) and would otherwise sail
// straight past the plausibility guard as if they were the target's own
// price. main_room_card = no related-property marker precedes this candidate
// anywhere in the page; related_property = a marker was found at or before
// this candidate's position (conservative: everything from that point
// forward is treated as out-of-scope, since the carousel is observed to run
// to the end of the page once the target itself has no rooms left to list).
export type BookingPriceBlock = "main_room_card" | "related_property";

export interface BookingPriceCandidate {
  rawText: string;
  numericValue: number;
  contextBeforeAfter: string;
  candidateTypeGuess: "total_tax_included" | "per_night_or_room" | "tax_excluded" | "unknown";
  roleGuess: BookingPriceRole;
  blockGuess: BookingPriceBlock;
}

// Real Booking.com UI text observed on a genuinely sold-out property page
// ("...ご提供できるこの宿泊施設の空室がありません。...選択した日程で予約可能な
// 類似施設..."), immediately followed by a "similar properties" carousel of
// OTHER hotels' names/ratings/prices. English equivalents included
// defensively (locale/UI copy can vary; not yet observed on a live page).
const RELATED_PROPERTY_SECTION_RE =
  /この宿泊施設の空室がありません|空室がありません|類似施設|類似の宿泊施設|関連ホテル|周辺の宿泊施設|こちらもおすすめ|おすすめ施設|他の宿泊施設|近くのホテル|他のホテル|related\s*propert(?:y|ies)|similar\s*propert(?:y|ies)|nearby\s*propert(?:y|ies)|you\s*may\s*also\s*like|other\s*propert(?:y|ies)|other\s*hotels?/iu;

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
  // The candidate selectPrimaryBookingPriceCandidate chose as the room price —
  // NOT necessarily priceCandidates[0] (document order can put a stray badge/
  // promo/loyalty yen-amount before the real room-card price; see that
  // function's selection order). null when there are no candidates at all.
  primaryPriceCandidate: BookingPriceCandidate | null;
  // Diagnostics only (not persisted to the history/BI CSV schema): the
  // crossed-out reference price when primaryPriceCandidate is a detected
  // "現在の料金" sale price, and whether a discount pairing was found at all.
  originalPriceNumeric: number | null;
  priceDiscountDetected: boolean;
  // null when primaryPriceCandidate !== null. See selectPrimaryBookingPriceCandidate.
  noUsableRoomPriceReason: NoUsableRoomPriceReason | null;
  relatedPropertyPriceExcludedCount: number;
  soldOutOrUnavailableDetected: boolean;
  captchaOrSecurityDetected: boolean;
  loginRequiredDetected: boolean;
  notFoundDetected: boolean;
  // Room context extracted around the SELECTED price candidate (room-basis input).
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
  // Despite the name (kept for compatibility with existing consumers/CSV
  // columns), this is the SELECTED primary candidate's value, not literally
  // priceCandidates[0] — see selectPrimaryBookingPriceCandidate.
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
  const relatedMarker = RELATED_PROPERTY_SECTION_RE.exec(text);
  const relatedMarkerIndex = relatedMarker ? relatedMarker.index : -1;
  const yenRe = /(?:￥|¥|JPY\s*)\s*([0-9０-９,，]+)|([0-9０-９,，]+)\s*円/giu;
  let match: RegExpExecArray | null;
  while ((match = yenRe.exec(text)) !== null) {
    const rawNumber = match[1] ?? match[2] ?? "";
    const numericValue = Number(toHalfWidth(rawNumber).replace(/[，,]/gu, ""));
    if (!Number.isFinite(numericValue) || numericValue <= 0) continue;
    const matchLen = match[0]?.length ?? 0;
    const start = Math.max(0, match.index - 70);
    const end = Math.min(text.length, match.index + matchLen + 70);
    const context = text.slice(start, end).replace(/\s+/gu, " ").trim();
    const precedingLabel = text.slice(Math.max(0, match.index - 24), match.index);
    const followingLabel = text.slice(match.index + matchLen, Math.min(text.length, match.index + matchLen + 20));
    candidates.push({
      rawText: match[0] ?? "",
      numericValue,
      contextBeforeAfter: context,
      candidateTypeGuess: guessPriceCandidateType(context),
      roleGuess: guessPriceRole(precedingLabel, followingLabel),
      blockGuess: relatedMarkerIndex !== -1 && match.index >= relatedMarkerIndex ? "related_property" : "main_room_card"
    });
  }
  return dedupePriceCandidates(candidates).slice(0, 20);
}

// Distinguishes "元の料金 ¥14,245" (crossed-out reference price) from
// "現在の料金 ¥11,019" (the actual payable/sale price) from a standalone tax
// or fee line item like "1泊につき¥150の入湯税". Effective/original label
// checks run FIRST because Booking often renders the fee-inclusive disclaimer
// ("税・手数料込") right after the effective price's own number — without
// priority ordering that phrase would wrongly reclassify the effective price
// itself as a tax/fee line.
function guessPriceRole(precedingLabel: string, followingLabel: string): BookingPriceRole {
  if (/(現在の料金|現在価格|セール価格|割引後|discounted\s*price|current\s*price|sale\s*price)\s*$/iu.test(precedingLabel)) return "effective_price";
  if (/(元の料金|元の価格|通常料金|通常価格|original\s*price|standard\s*price)\s*$/iu.test(precedingLabel)) return "original_price";
  if (/^\s*の?(入湯税|宿泊税|温泉税|手数料(?!込))/u.test(followingLabel)) return "tax_or_fee";
  return "unknown";
}

export interface ScoredBookingPriceCandidate extends BookingPriceCandidate {
  roomContext: BookingRoomContext;
  hasRoomContext: boolean;
  isPlausible: boolean;
}

export type NoUsableRoomPriceReason = "related_property_price_excluded" | "room_context_missing" | "no_main_room_card_price_candidate";

export interface BookingPriceCandidateSelection {
  selected: BookingPriceCandidate | null;
  roomContext: BookingRoomContext;
  scored: ScoredBookingPriceCandidate[];
  // The guest's actual payable price ("現在の料金"/セール価格) when this room
  // card is discounted AND its original/reference price differs — null when
  // no discount pairing was found (regular, non-sale listing).
  originalPriceNumeric: number | null;
  priceDiscountDetected: boolean;
  // null when selected !== null. Otherwise explains WHY no candidate was
  // usable as the target property's own price — used by callers to decide
  // whether this observation should ever be treated as "we successfully
  // checked this date" (it should not, when the failure is ambiguous).
  noUsableRoomPriceReason: NoUsableRoomPriceReason | null;
  relatedPropertyPriceExcludedCount: number;
}

const NO_ROOM_CONTEXT: BookingRoomContext = { primaryRoomName: "", primaryRoomCardText: "", primaryOccupancyHint: "", primaryBedHint: "" };

// Document order is NOT selection order: a Booking page can render a
// promo/loyalty/cashback yen-amount before the real room-card price, so
// candidates[0] is not reliably "the room price" (this is the root cause of
// the HAMMOND ¥100 extraction defect — candidates[0] was a stray small yen
// amount with no room card nearby, so its room-context window came up empty
// and the row fell to the classifier's no-evidence default). A SECOND, more
// dangerous defect discovered while verifying live: when the target property
// has ZERO availability, Booking replaces its room list with a "similar
// properties" carousel of OTHER hotels — those prices are plausible-looking
// and would otherwise pass every check below as if they were the target's
// own. Score every candidate by its OWN local evidence instead of trusting
// position OR mere plausibility, in priority order:
//   1) main_room_card block, plausible, WITH room name/bed hint nearby, AND
//      explicitly labeled "現在の料金" — the guest's real payable/sale price;
//   2) main_room_card block, plausible, WITH room name/bed hint nearby (any
//      other role — a regular non-discounted room, or the sale label wasn't
//      detected);
//   3) nothing usable — returns selected=null with a reason. There is
//      DELIBERATELY no further fallback: neither "plausible price with no
//      room evidence" nor "candidates[0] regardless" are acceptable any
//      more, because either could silently be a related property's price.
//      Downstream callers must treat this as "we don't know" (not
//      "confirmed sold out", not a market price sample, not counted as
//      successfully-covered), unless they independently detected a genuine
//      sold-out state some other way.
// For a property whose candidates[0] IS already the room-card price (the
// common case today), this resolves to the same candidate — no regression.
export function selectPrimaryBookingPriceCandidate(bodyText: string, candidates: readonly BookingPriceCandidate[]): BookingPriceCandidateSelection {
  if (candidates.length === 0) {
    return { selected: null, roomContext: { ...NO_ROOM_CONTEXT }, scored: [], originalPriceNumeric: null, priceDiscountDetected: false, noUsableRoomPriceReason: "no_main_room_card_price_candidate", relatedPropertyPriceExcludedCount: 0 };
  }
  const scored: ScoredBookingPriceCandidate[] = candidates.map((c) => {
    const roomContext = extractBookingRoomContextAroundPrice({ bodyText, priceValue: c.numericValue, priceRawText: c.rawText, contextBeforeAfter: c.contextBeforeAfter });
    return {
      ...c,
      roomContext,
      hasRoomContext: roomContext.primaryRoomName !== "" || roomContext.primaryBedHint !== "",
      isPlausible: c.numericValue >= MIN_PLAUSIBLE_BOOKING_PRICE_JPY
    };
  });
  const relatedPropertyPriceExcludedCount = scored.filter((s) => s.blockGuess === "related_property" && s.isPlausible).length;
  const eligible = (s: ScoredBookingPriceCandidate): boolean => s.blockGuess === "main_room_card" && s.isPlausible && s.hasRoomContext;
  const effective = scored.find((s) => eligible(s) && s.roleGuess === "effective_price");
  const best = effective ?? scored.find((s) => eligible(s));

  if (best === undefined) {
    const mainPlausible = scored.filter((s) => s.blockGuess === "main_room_card" && s.isPlausible);
    const reason: NoUsableRoomPriceReason =
      mainPlausible.length > 0 ? "room_context_missing" : relatedPropertyPriceExcludedCount > 0 ? "related_property_price_excluded" : "no_main_room_card_price_candidate";
    return { selected: null, roomContext: { ...NO_ROOM_CONTEXT }, scored, originalPriceNumeric: null, priceDiscountDetected: false, noUsableRoomPriceReason: reason, relatedPropertyPriceExcludedCount };
  }
  const original = effective ? scored.find((s) => eligible(s) && s.roleGuess === "original_price") : undefined;
  const originalPriceNumeric = original !== undefined && original.numericValue !== effective!.numericValue ? original.numericValue : null;
  return { selected: best, roomContext: best.roomContext, scored, originalPriceNumeric, priceDiscountDetected: originalPriceNumeric !== null, noUsableRoomPriceReason: null, relatedPropertyPriceExcludedCount };
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
  const { selected: primaryPriceCandidate, roomContext, originalPriceNumeric, priceDiscountDetected, noUsableRoomPriceReason, relatedPropertyPriceExcludedCount } = selectPrimaryBookingPriceCandidate(text, priceCandidates);
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
    primaryPriceCandidate,
    originalPriceNumeric,
    priceDiscountDetected,
    noUsableRoomPriceReason,
    relatedPropertyPriceExcludedCount,
    soldOutOrUnavailableDetected: /(売り切れ|満室|空室なし|空室がありません|予約できません|ご利用いただけません|not available|sold out)/iu.test(text),
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
  // Both checks key off primaryPriceCandidate (the SELECTED, verified-usable
  // price for THIS property), not the raw priceCandidates list — a page can
  // have plenty of raw yen amounts (a "similar properties" carousel of OTHER
  // hotels, tax line items, promo badges) with zero of them usable as this
  // property's own room price.
  if (signals.soldOutOrUnavailableDetected && signals.primaryPriceCandidate === null) {
    return "booking_rendered_sold_out_or_unavailable";
  }
  // KIRAKU-BOOKING-FIX01 (2026-07-13): nightCountDetected (a literal "1泊" text
  // match) is NOT required here — live verification against 喜らく/ホテル喜らく's
  // real Booking page found it never renders that label at all (the search
  // widget shows only the "7月14日(火) — 7月15日(水)" date range, no separate
  // night-count text), while an otherwise fully-verified, room-confirmed,
  // correctly-priced observation was being discarded solely because of this
  // absent, redundant label. checkinDetected + checkoutDetected already confirm
  // the SPECIFIC target date range is present — two adjacent calendar dates a
  // day apart IS a 1-night stay, a strictly stronger check than a generic "1泊"
  // text match. signals.nightCountDetected is kept (still computed, still
  // reported in the CSV/report for diagnostics) — just no longer a blocking
  // gate. General fix: this Booking UI variance is not specific to Kiraku.
  if (
    signals.propertyNameDetected &&
    signals.checkinDetected &&
    signals.checkoutDetected &&
    signals.adultCountDetected &&
    signals.roomCountDetected &&
    signals.jpyCurrencyDetected &&
    signals.primaryPriceCandidate !== null
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
  // Classify room basis from the FULL extracted room context — room name, the
  // sanitized card text, the bed hint ("シングルベッド2台"/"2 single beds" = twin),
  // and the occupancy hint. Passing bed/occupancy hints lets a priced, available
  // 2-adult Booking row be CONFIRMED via its beds even when the room name was
  // not surfaced, and otherwise fall to probable (not unknown). Confirmed and
  // excluded text always win over the probable default.
  const hasPrice = input.signals.primaryPriceCandidate !== null;
  const available = hasPrice && !input.signals.soldOutOrUnavailableDetected;
  const roomBasis = classifyBookingRoomBasis({
    roomName: input.signals.primaryRoomName,
    blockText: input.signals.primaryRoomCardText,
    bedHint: input.signals.primaryBedHint,
    occupancyHint: input.signals.primaryOccupancyHint,
    available,
    hasPrice
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
    firstPriceCandidateValue: input.signals.primaryPriceCandidate?.numericValue ?? null,
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

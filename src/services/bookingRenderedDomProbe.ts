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

export interface BookingPriceCandidate {
  rawText: string;
  numericValue: number;
  contextBeforeAfter: string;
  candidateTypeGuess: "total_tax_included" | "per_night_or_room" | "tax_excluded" | "unknown";
  roleGuess: BookingPriceRole;
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
      roleGuess: guessPriceRole(precedingLabel, followingLabel)
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

export interface BookingPriceCandidateSelection {
  selected: BookingPriceCandidate | null;
  roomContext: BookingRoomContext;
  scored: ScoredBookingPriceCandidate[];
  // The guest's actual payable price ("現在の料金"/セール価格) when this room
  // card is discounted AND its original/reference price differs — null when
  // no discount pairing was found (regular, non-sale listing).
  originalPriceNumeric: number | null;
  priceDiscountDetected: boolean;
}

const NO_ROOM_CONTEXT: BookingRoomContext = { primaryRoomName: "", primaryRoomCardText: "", primaryOccupancyHint: "", primaryBedHint: "" };

// Document order is NOT selection order: a Booking page can render a
// promo/loyalty/cashback yen-amount before the real room-card price, so
// candidates[0] is not reliably "the room price" (this is the root cause of
// the HAMMOND ¥100 extraction defect — candidates[0] was a stray small yen
// amount with no room card nearby, so its room-context window came up empty
// and the row fell to the classifier's no-evidence default). Score every
// candidate by its OWN local room context instead of trusting position, in
// priority order:
//   1) plausible price WITH a room name/bed hint nearby AND explicitly
//      labeled "現在の料金" (the guest's real payable/sale price) — ZMI's
//      price-strategy use case wants what the guest actually pays, not the
//      crossed-out reference price;
//   2) plausible price with a nearby room name/bed hint (no explicit sale
//      label — either a regular non-discounted room, or the label wasn't
//      detected; same behavior as before this pass);
//   3) plausible price with no nearby room evidence (lower-confidence room
//      basis, unchanged from before);
//   4) first candidate — nothing plausible was found; keep it for the
//      downstream plausibility guard to reject rather than fabricating an
//      empty result (conservative: never invents a candidate that doesn't
//      exist in the text).
// For a property whose candidates[0] IS already the room-card price (the
// common case today), this resolves to the same candidate — no regression.
export function selectPrimaryBookingPriceCandidate(bodyText: string, candidates: readonly BookingPriceCandidate[]): BookingPriceCandidateSelection {
  if (candidates.length === 0) return { selected: null, roomContext: { ...NO_ROOM_CONTEXT }, scored: [], originalPriceNumeric: null, priceDiscountDetected: false };
  const scored: ScoredBookingPriceCandidate[] = candidates.map((c) => {
    const roomContext = extractBookingRoomContextAroundPrice({ bodyText, priceValue: c.numericValue, priceRawText: c.rawText, contextBeforeAfter: c.contextBeforeAfter });
    return {
      ...c,
      roomContext,
      hasRoomContext: roomContext.primaryRoomName !== "" || roomContext.primaryBedHint !== "",
      isPlausible: c.numericValue >= MIN_PLAUSIBLE_BOOKING_PRICE_JPY
    };
  });
  const eligible = (s: ScoredBookingPriceCandidate): boolean => s.isPlausible && s.hasRoomContext;
  const effective = scored.find((s) => eligible(s) && s.roleGuess === "effective_price");
  const best = effective ?? scored.find((s) => eligible(s)) ?? scored.find((s) => s.isPlausible) ?? scored[0]!;
  const original = effective ? scored.find((s) => eligible(s) && s.roleGuess === "original_price") : undefined;
  const originalPriceNumeric = original !== undefined && original.numericValue !== effective!.numericValue ? original.numericValue : null;
  return { selected: best, roomContext: best.roomContext, scored, originalPriceNumeric, priceDiscountDetected: originalPriceNumeric !== null };
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
  const { selected: primaryPriceCandidate, roomContext, originalPriceNumeric, priceDiscountDetected } = selectPrimaryBookingPriceCandidate(text, priceCandidates);
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
  // Classify room basis from the FULL extracted room context — room name, the
  // sanitized card text, the bed hint ("シングルベッド2台"/"2 single beds" = twin),
  // and the occupancy hint. Passing bed/occupancy hints lets a priced, available
  // 2-adult Booking row be CONFIRMED via its beds even when the room name was
  // not surfaced, and otherwise fall to probable (not unknown). Confirmed and
  // excluded text always win over the probable default.
  const hasPrice = input.signals.priceCandidates.length > 0;
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

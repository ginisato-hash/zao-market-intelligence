// ZMI room-basis classification (pure).
//
// Confirmed policy (room-basis hardening): DP price samples must come from a
// TWO-PERSON STANDARD ROOM — twin / double / queen / king / 2-beds. Single,
// semi-double, triple/quad/large, family/suite, and unknown room types are
// excluded from DP pricing (availability/inventory signal is still kept by the
// callers). No I/O, no network. Token matching is NFKC-normalized, lowercased,
// and whitespace-collapsed. Exclusion ALWAYS wins over an accepted token.

export type RoomBasis =
  | "confirmed_two_person_standard_room"
  | "probable_two_person_standard_room"
  | "excluded_single_room"
  | "excluded_semi_double_room"
  | "excluded_large_room"
  | "excluded_family_or_suite_room"
  | "excluded_other_room_type"
  | "unknown_room_basis";

export type RoomBasisConfidence = "high" | "medium" | "low" | "none";

export interface RoomBasisClassification {
  roomBasis: RoomBasis;
  roomBasisConfidence: RoomBasisConfidence;
  reason: string;
}

// Two-person standard room positives.
export const TWO_PERSON_STANDARD_ROOM_TOKENS = [
  "ツイン", "ダブル", "洋室ツイン", "洋室ダブル",
  "twin", "double", "queen", "king",
  "2 beds", "two beds", "2 bed", "two bed",
  "1 queen", "1 king"
] as const;

// Single-room exclusions.
export const SINGLE_ROOM_TOKENS = [
  "シングル", "single", "1名", "1 person", "one person"
] as const;

// Semi-double exclusions. Cheaper than a twin/double standard and brittle for
// comparison, so excluded even though it can sleep two.
export const SEMI_DOUBLE_ROOM_TOKENS = [
  "セミダブル", "semi double", "semi-double", "semidouble", "small double"
] as const;

// Triple / quad / large-capacity / large tatami exclusions.
export const LARGE_ROOM_TOKENS = [
  "トリプル", "triple", "3名", "3 person", "three person",
  "フォース", "quad", "quadruple", "4名", "4 person", "four person",
  "5名", "6名",
  "大部屋", "和室10畳", "和室12畳"
] as const;

// Family / suite / special-room exclusions.
export const FAMILY_OR_SUITE_ROOM_TOKENS = [
  "ファミリー", "family", "スイート", "suite",
  "特別室", "special room", "deluxe suite", "junior suite"
] as const;

export function normalizeRoomText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function containsAny(haystack: string, tokens: readonly string[]): boolean {
  return tokens.some((tok) => haystack.includes(normalizeRoomText(tok)));
}

// "シングルベッド2台" / "2 single beds" / "two single beds" / "single beds 2" /
// "シングルベッド×2" describe a TWIN (two single beds = two-person standard) room.
// The substring "シングル"/"single" would otherwise trip the single-room
// exclusion, so scrub these phrases to a positive " twin " token BEFORE any
// token matching. Single-bed counts other than two (e.g. "シングルベッド1台")
// are left untouched and keep classifying as single.
const TWO_SINGLE_BEDS_RE =
  /シングルベッド\s*2\s*台|シングル\s*ベッド\s*2\s*台|シングルベッド\s*[×x]\s*2|2\s*single\s*beds?|two\s*single\s*beds?|single\s*beds?\s*2|single\s*beds?\s*two/gu;

function scrubTwoSingleBeds(text: string): string {
  return text.replace(TWO_SINGLE_BEDS_RE, " twin ");
}

// Per-head price labels ("大人1名(税込)", "大人2名", "1名あたり") appear in almost
// every Jalan/Booking price block and are NOT room-occupancy signals. Strip them
// before token matching so they never false-trigger the "1名"/"N名" single/large
// room tokens. Genuine room-capacity phrases ("1名利用", "シングル", bare "3名")
// are not preceded by 大人/小人/子供 and survive.
function stripPerHeadPriceLabels(text: string): string {
  return text
    .replace(/大人\s*\d+\s*名/gu, " ")
    .replace(/小人\s*\d+\s*名/gu, " ")
    .replace(/子供\s*\d+\s*名/gu, " ")
    .replace(/子ども\s*\d+\s*名/gu, " ")
    .replace(/\d+\s*名\s*あたり/gu, " ");
}

// Classify a combined room/plan/block text into a room basis. Exclusion wins
// over an accepted token; among exclusions the priority is family/suite →
// large → semi-double → single (most-specific "definitely not a standard
// two-person room" first).
export function classifyRoomBasis(text: string): RoomBasisClassification {
  const raw = normalizeRoomText(text);
  if (raw === "") {
    return { roomBasis: "unknown_room_basis", roomBasisConfidence: "low", reason: "room_basis_text_empty" };
  }
  const norm = stripPerHeadPriceLabels(scrubTwoSingleBeds(raw));

  const hasFamilyOrSuite = containsAny(norm, FAMILY_OR_SUITE_ROOM_TOKENS);
  const hasLarge = containsAny(norm, LARGE_ROOM_TOKENS);
  const hasSemiDouble = containsAny(norm, SEMI_DOUBLE_ROOM_TOKENS);
  const hasSingle = containsAny(norm, SINGLE_ROOM_TOKENS);
  const hasTwoPersonStandard = containsAny(norm, TWO_PERSON_STANDARD_ROOM_TOKENS);

  // Exclusion always wins over an accepted token (e.g. "ツイン スイート",
  // "ダブル 3名", "small double").
  if (hasFamilyOrSuite) {
    return { roomBasis: "excluded_family_or_suite_room", roomBasisConfidence: "high", reason: "family_or_suite_room_token_detected" };
  }
  if (hasLarge) {
    return { roomBasis: "excluded_large_room", roomBasisConfidence: "high", reason: "large_or_triple_or_quad_room_token_detected" };
  }
  if (hasSemiDouble) {
    return { roomBasis: "excluded_semi_double_room", roomBasisConfidence: "high", reason: "semi_double_room_token_detected" };
  }
  if (hasSingle) {
    return { roomBasis: "excluded_single_room", roomBasisConfidence: "high", reason: "single_room_token_detected" };
  }
  if (hasTwoPersonStandard) {
    return { roomBasis: "confirmed_two_person_standard_room", roomBasisConfidence: "high", reason: "two_person_standard_room_token_detected" };
  }
  return { roomBasis: "unknown_room_basis", roomBasisConfidence: "low", reason: "room_basis_unknown" };
}

export interface RoomBasisInput {
  roomName?: string | undefined;
  planName?: string | undefined;
  blockText?: string | undefined;
  priceText?: string | undefined;
  rateName?: string | undefined;
  bedHint?: string | undefined;
}

// Join the available room/plan/rate/bed texts and classify. Used by the Booking
// and Jalan gates so the same evidence is considered everywhere.
//
// Positive room-NAME evidence wins over negative bed-hint tokens (req. §3): if
// the room name alone is unambiguously a two-person standard room (e.g. "ツイン
// ルーム"), a "シングルベッド…" bed hint must not demote it to single/semi-double.
// A room name that is itself an excluded type (セミダブル / シングルルーム / suite
// / triple) is NOT confirmed, so those keep excluding as before.
export function classifyRoomBasisFromParts(input: RoomBasisInput): RoomBasisClassification {
  const name = (input.roomName ?? "").trim();
  if (name !== "") {
    const nameClass = classifyRoomBasis(name);
    if (nameClass.roomBasis === "confirmed_two_person_standard_room") {
      return { ...nameClass, reason: "two_person_standard_room_name_evidence" };
    }
  }
  const combined = [input.roomName, input.planName, input.rateName, input.blockText, input.priceText, input.bedHint]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" \n ");
  return classifyRoomBasis(combined);
}

export function isTwoPersonStandardRoom(classification: RoomBasisClassification): boolean {
  return classification.roomBasis === "confirmed_two_person_standard_room";
}

export function isProbableOrConfirmedTwoPersonStandardRoom(classification: RoomBasisClassification): boolean {
  return classification.roomBasis === "confirmed_two_person_standard_room" || classification.roomBasis === "probable_two_person_standard_room";
}

// Booking-centric room-basis: when the room NAME/text is not confirmed and not
// excluded, an available, priced Booking row searched at 2 adults / 1 room is a
// PROBABLE two-person standard room (req. §3.3). Confirmed and excluded text
// always win. ZMI's Booking collector always searches 2 adults, so an absent
// occupancy hint is treated as the 2-adult default.
export function classifyBookingRoomBasis(input: {
  roomName?: string | undefined;
  blockText?: string | undefined;
  bedHint?: string | undefined;
  occupancyHint?: string | undefined;
  available: boolean;
  hasPrice: boolean;
}): RoomBasisClassification {
  const base = classifyRoomBasisFromParts({ roomName: input.roomName, blockText: input.blockText, bedHint: input.bedHint });
  if (base.roomBasis !== "unknown_room_basis") return base; // confirmed or excluded wins
  const occ = normalizeRoomText(input.occupancyHint ?? "");
  const twoAdults = occ === "" || /2\s*adults|2\s*名|two adults|2名様/u.test(occ);
  if (input.available && input.hasPrice && twoAdults) {
    return { roomBasis: "probable_two_person_standard_room", roomBasisConfidence: "medium", reason: "booking_two_adult_search_no_exclusion" };
  }
  return base;
}

// Map a room basis to the dp_exclusion_reason encoded into the existing v1
// columns. confirmed_two_person_standard_room has no exclusion reason (null).
export function roomBasisDpExclusionReason(roomBasis: RoomBasis): string | null {
  switch (roomBasis) {
    case "confirmed_two_person_standard_room":
    case "probable_two_person_standard_room":
      return null; // usable for DP (probable lifts confidence to medium, not excluded)
    case "excluded_single_room":
      return "excluded_room_type_single";
    case "excluded_semi_double_room":
      return "excluded_room_type_semi_double";
    case "excluded_large_room":
      return "excluded_room_type_large";
    case "excluded_family_or_suite_room":
      return "excluded_room_type_family_or_suite";
    case "excluded_other_room_type":
      return "excluded_room_type_other";
    case "unknown_room_basis":
      return "unknown_room_basis_excluded";
    default:
      return "unknown_room_basis_excluded";
  }
}

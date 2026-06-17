// ZMI meal-basis classification (pure).
//
// Confirmed policy:
//  - Booking rows are treated as assumed_room_only (Booking is used as room-only).
//  - Jalan price rows are DP-usable only when a selected plan is CONFIRMED room-only.
//    Meal-included / unknown-meal-basis Jalan prices are excluded from DP.
// No I/O, no network. Token matching is NFKC-normalized and case-insensitive.

export type MealBasis =
  | "assumed_room_only"
  | "confirmed_room_only"
  | "meal_included"
  | "unknown_meal_basis";

export type MealBasisConfidence = "high" | "medium" | "low" | "none";

export interface MealBasisClassification {
  mealBasis: MealBasis;
  mealBasisConfidence: MealBasisConfidence;
  reason: string;
}

// Positive room-only signals. "朝食なし" / "夕食なし" are room-only positives.
export const ROOM_ONLY_TOKENS = [
  "素泊まり", "素泊り", "すどまり",
  "食事なし", "食事無し", "お食事なし", "お食事無し",
  "朝食なし", "朝食無し", "夕食なし", "夕食無し",
  "room only", "without meals", "no meals", "no meal"
] as const;

// Meal-included exclusion signals. "朝食付き" / "夕食付き" etc.
export const MEAL_INCLUDED_TOKENS = [
  "朝食付き", "朝食付", "朝食あり", "朝食有", "朝食込",
  "夕食付き", "夕食付", "夕食あり", "夕食有", "夕食込",
  "2食付き", "二食付き", "2食付", "二食付",
  "一泊二食", "1泊2食", "夕朝食",
  "会席", "御膳", "膳", "バイキング", "ビュッフェ",
  "breakfast included", "dinner included", "half board", "full board",
  "with breakfast", "with dinner"
] as const;

export function normalizeMealText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function containsAny(haystack: string, tokens: readonly string[]): boolean {
  return tokens.some((tok) => haystack.includes(normalizeMealText(tok)));
}

export const BOOKING_MEAL_BASIS: MealBasisClassification = {
  mealBasis: "assumed_room_only",
  mealBasisConfidence: "medium",
  reason: "booking_assumed_room_only_by_policy"
};

// Classify a Jalan plan/room/block text into a meal basis.
export function classifyJalanMealBasis(text: string): MealBasisClassification {
  const norm = normalizeMealText(text);
  const hasMealIncluded = containsAny(norm, MEAL_INCLUDED_TOKENS);
  const hasRoomOnly = containsAny(norm, ROOM_ONLY_TOKENS);

  // Ambiguous: both meal-included and room-only signals present in the same text.
  // Never DP-usable — fall to unknown so the room-only DP path rejects it.
  if (hasMealIncluded && hasRoomOnly) {
    return { mealBasis: "unknown_meal_basis", mealBasisConfidence: "medium", reason: "jalan_ambiguous_meal_and_room_only_tokens" };
  }
  if (hasMealIncluded) {
    return { mealBasis: "meal_included", mealBasisConfidence: "high", reason: "jalan_meal_included_token_detected" };
  }
  if (hasRoomOnly) {
    return { mealBasis: "confirmed_room_only", mealBasisConfidence: "high", reason: "jalan_room_only_token_detected" };
  }
  return { mealBasis: "unknown_meal_basis", mealBasisConfidence: "low", reason: "jalan_meal_basis_unknown" };
}

export interface MealBasisInput {
  source: "booking" | "jalan" | "rakuten" | string;
  blockText?: string;
  planName?: string;
  roomName?: string;
  priceText?: string;
  mealCondition?: string;
}

// Unified entry point. Booking is assumed_room_only by policy; Jalan is classified
// from the combined plan/room/block/price/meal-condition text; everything else is
// unknown (conservative — not room-only-confirmed).
export function classifyMealBasis(input: MealBasisInput): MealBasisClassification {
  if (input.source === "booking") return BOOKING_MEAL_BASIS;
  if (input.source === "jalan") {
    const combined = [input.blockText, input.planName, input.roomName, input.priceText, input.mealCondition]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" \n ");
    return classifyJalanMealBasis(combined);
  }
  return { mealBasis: "unknown_meal_basis", mealBasisConfidence: "low", reason: `${input.source}_meal_basis_unknown` };
}

export function isConfirmedRoomOnly(classification: MealBasisClassification): boolean {
  return classification.mealBasis === "confirmed_room_only";
}

// Booking assumed_room_only OR Jalan confirmed_room_only are DP-eligible for
// room-only pricing. meal_included / unknown_meal_basis are not.
export function isRoomOnlyDpEligible(classification: MealBasisClassification): boolean {
  return classification.mealBasis === "assumed_room_only" || classification.mealBasis === "confirmed_room_only";
}

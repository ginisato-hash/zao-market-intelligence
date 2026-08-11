// Phase ZMI-MKT-OBS01 — product identity stabilization (pure). §8.
//
// Neither Booking nor Jalan currently exposes a machine room/rate-plan ID to
// this collector (both are text-scraped) — so a stable product key is
// derived from NORMALIZED room + rate attributes rather than the raw UI
// string. Normalization collapses trivial formatting noise (whitespace,
// full/half-width, casing) WITHOUT merging genuinely different room types —
// the exact balance point in §8: "UI文言の微変更だけで別商品化しない。ただし
// 異なる商品を誤ってmergeしない". When a source DOES provide a stable
// source-side ID in the future, pass it in and it wins outright (no
// normalization needed, and it survives UI wording changes completely).
//
// No I/O, no network.

export interface ProductIdentityInput {
  sourceProductId?: string | undefined; // e.g. a future Booking/Jalan room/rate ID
  roomTypeName: string;
  bedHint?: string | undefined;
  ratePlanName?: string | undefined;
}

function normalizeAttributeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/gu, " ")
    .trim();
}

// Room-type key: source ID wins if present; otherwise normalized room name +
// bed hint (bed hint disambiguates same-named rooms with different bedding,
// e.g. "ツインルーム" vs "ツインルーム（シングルベッド2台）").
export function buildRoomProductKey(input: ProductIdentityInput): string {
  if (input.sourceProductId && input.sourceProductId.trim() !== "") {
    return `id:${input.sourceProductId.trim()}`;
  }
  const room = normalizeAttributeText(input.roomTypeName ?? "");
  if (room === "") return "";
  const bed = input.bedHint ? normalizeAttributeText(input.bedHint) : "";
  return bed === "" ? `text:${room}` : `text:${room}|bed:${bed}`;
}

// Rate-plan key: source ID wins if present; otherwise normalized plan name.
// "" (unknown) is a legitimate, honest result — never invent a plan name.
export function buildRatePlanKey(input: { sourceRatePlanId?: string | undefined; ratePlanName?: string | undefined }): string {
  if (input.sourceRatePlanId && input.sourceRatePlanId.trim() !== "") {
    return `id:${input.sourceRatePlanId.trim()}`;
  }
  const plan = input.ratePlanName ? normalizeAttributeText(input.ratePlanName) : "";
  return plan === "" ? "" : `text:${plan}`;
}

// §8 does-it-merge check: two product keys refer to "the same product" only
// on exact match post-normalization. Never fuzzy/partial-match — a false
// merge (two different rooms treated as one) is worse than a false split
// (the same room treated as two, which just looks like two separate,
// low-repeat comparison keys instead of corrupting a real comparison).
export function isSameRoomProduct(a: string, b: string): boolean {
  return a !== "" && a === b;
}

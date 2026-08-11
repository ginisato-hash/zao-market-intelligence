// Phase ZMI-MKT-OBS01 — inventory scarcity extraction (pure). §3/§4/§5.
//
// Source capability audit finding: neither Booking nor Jalan expose a true
// numeric "rooms remaining" API field to this text-scraped collector, but
// BOTH sometimes render a public UI scarcity badge next to a specific room
// card — confirmed live: Booking "当サイトでは残り3室" (Kiraku, 2026-07-13),
// Jalan "あと3部屋" / "あと2部屋" (ONSEN & STAY OAKHILL, 2026-08-17/25). Jalan
// also renders a qualitative, non-numeric scarcity phrase "空室わずか" with no
// count at all. This module extracts exactly what's there and nothing more:
// a numeric badge -> PUBLIC_SCARCITY_COUNT with the number; a qualitative
// phrase -> UNKNOWN count (never invent a number for "わずか"); nothing found
// -> BINARY_AVAILABILITY (the property is available/sold-out but no
// inventory-related text exists at all).
//
// inventory_scope is ALWAYS PRODUCT or SEARCH_CONTEXT for these badges: they
// sit next to one specific room/rate card for one specific search, never the
// property as a whole (§5's explicit example). This module never returns
// PROPERTY scope — nothing in the current source capability supports it.
//
// No I/O, no network.

import type { InventoryCountSemantics, InventoryScope } from "./marketObservationSchema";

export interface InventoryScarcitySignal {
  inventoryCount: number | null;
  inventoryCountSemantics: InventoryCountSemantics;
  inventoryScope: InventoryScope;
  rawText: string; // "" when nothing found
}

const NONE: InventoryScarcitySignal = {
  inventoryCount: null,
  inventoryCountSemantics: "BINARY_AVAILABILITY",
  inventoryScope: "UNKNOWN",
  rawText: ""
};

// Numeric scarcity badges observed live on Booking and Jalan room cards.
const NUMERIC_SCARCITY_RE = /(?:当サイトでは)?残り\s*([0-9０-９]+)\s*室|あと\s*([0-9０-９]+)\s*部屋|残り\s*([0-9０-９]+)\s*部屋/u;
// Qualitative-only scarcity phrases: scarcity IS indicated, but no number is
// given — must not be treated as count=0 or any invented digit.
const QUALITATIVE_SCARCITY_RE = /空室わずか|残りわずか/u;

function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// Extract a scarcity signal from the text immediately around one specific
// room/rate card (the SAME bounded window already used to extract that
// card's room name/price — never the whole page, or a badge for a DIFFERENT
// room card could be misattributed to this one).
export function extractInventoryScarcitySignal(cardText: string): InventoryScarcitySignal {
  const text = cardText ?? "";
  if (text.trim() === "") return { ...NONE };

  const numeric = NUMERIC_SCARCITY_RE.exec(text);
  if (numeric) {
    const digits = numeric[1] ?? numeric[2] ?? numeric[3] ?? "";
    const count = Number(toHalfWidthDigits(digits));
    if (Number.isFinite(count) && count >= 0) {
      return {
        inventoryCount: count,
        inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT",
        inventoryScope: "PRODUCT",
        rawText: numeric[0]
      };
    }
  }

  const qualitative = QUALITATIVE_SCARCITY_RE.exec(text);
  if (qualitative) {
    // Scarcity is indicated but not quantified — count stays null/UNKNOWN
    // semantics; never infer a specific number from a qualitative phrase.
    return { inventoryCount: null, inventoryCountSemantics: "UNKNOWN", inventoryScope: "PRODUCT", rawText: qualitative[0] };
  }

  return { ...NONE };
}

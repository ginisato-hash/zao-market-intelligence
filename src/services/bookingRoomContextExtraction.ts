// Booking room-context extraction (pure).
//
// Extracts the room/rate context around the chosen Booking price so the live
// AutoRunner path can classify room basis (two-person standard vs excluded).
// No I/O, no network. Conservative: it never invents a room name; when there is
// no evidence it returns empty strings (which classify as unknown_room_basis).
//
// IMPORTANT trap: "シングルベッド2台" / "ベッド2台" (two single beds) is a TWIN /
// two-person room, but the substring "シングル" would otherwise trip the
// single-room exclusion. extractBookingRoomContextAroundPrice therefore emits a
// classification-safe primaryRoomCardText where two-bed phrases are normalized to
// a positive "two beds twin" token (the raw phrase is kept in primaryBedHint).

export interface BookingRoomContext {
  primaryRoomName: string;
  primaryRoomCardText: string;
  primaryOccupancyHint: string;
  primaryBedHint: string;
}

const EMPTY: BookingRoomContext = {
  primaryRoomName: "",
  primaryRoomCardText: "",
  primaryOccupancyHint: "",
  primaryBedHint: ""
};

// Two single beds / a pair of beds = a twin (two-person standard) room.
// Includes the "single beds" phrasings (シングルベッド2台 / 2 single beds / two
// single beds / single beds 2 / シングルベッド×2) whose "シングル"/"single"
// substring would otherwise trip the single-room exclusion downstream.
const TWO_BED_RE = /シングルベッド\s*[2２]\s*台|シングルベッド\s*[×xX]\s*[2２]|ベッド\s*[2２]\s*台|ベッド\s*[×xX]\s*[2２]|ツインベッド|[2２]\s*single\s+beds?|two\s+single\s+beds?|single\s+beds?\s*[2２]|[2２]\s*beds|two\s+beds|twin\s+beds/u;
const DOUBLE_BED_RE = /ダブルベッド|ダブルサイズベッド|double\s+bed|queen\s+bed|king\s+bed/u;
const OCCUPANCY_RE = /大人\s*[2２]\s*名|[2２]\s*名様|2\s*adults|two\s+adults/u;
// A room-name-like phrase ending in a room keyword (bounded length).
const ROOM_NAME_RE = /[^\s。、,，\n|/]{0,28}?(?:ルーム|ROOM|room|和室|洋室|スイート|suite)/u;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Build a bounded text window around the chosen price. Room cards put the room
// name BEFORE the price, so the window reaches further back than forward.
function priceWindow(bodyText: string, priceRawText?: string, contextBeforeAfter?: string): string {
  if (priceRawText && priceRawText.length > 0) {
    const idx = bodyText.indexOf(priceRawText);
    if (idx >= 0) {
      return bodyText.slice(Math.max(0, idx - 280), Math.min(bodyText.length, idx + priceRawText.length + 120));
    }
  }
  if (contextBeforeAfter && contextBeforeAfter.length > 0) return contextBeforeAfter;
  const m = /(?:￥|¥|JPY)\s*[0-9０-９,，]+|[0-9０-９,，]+\s*円/u.exec(bodyText);
  if (m) {
    return bodyText.slice(Math.max(0, m.index - 280), Math.min(bodyText.length, m.index + 120));
  }
  return bodyText.slice(0, 600);
}

// Normalize the window so the room-basis classifier reads two-bed phrases as a
// positive twin signal instead of tripping the "シングル" single-room exclusion.
function classificationSafe(window: string): string {
  return window.replace(new RegExp(TWO_BED_RE, "gu"), " two beds twin ");
}

export function extractBookingRoomContextAroundPrice(input: {
  bodyText: string;
  priceValue: number | null;
  priceRawText?: string | undefined;
  contextBeforeAfter?: string | undefined;
}): BookingRoomContext {
  const body = input.bodyText ?? "";
  if (body.trim() === "") return { ...EMPTY };
  const window = priceWindow(body, input.priceRawText, input.contextBeforeAfter).replace(/\s+/gu, " ").trim();
  if (window === "") return { ...EMPTY };

  const bed = TWO_BED_RE.exec(window) ?? DOUBLE_BED_RE.exec(window);
  const occupancy = OCCUPANCY_RE.exec(window);
  const roomName = ROOM_NAME_RE.exec(window);

  return {
    primaryRoomName: roomName ? roomName[0].trim() : "",
    primaryRoomCardText: clip(classificationSafe(window), 400),
    primaryOccupancyHint: occupancy ? occupancy[0].trim() : "",
    primaryBedHint: bed ? bed[0].trim() : ""
  };
}

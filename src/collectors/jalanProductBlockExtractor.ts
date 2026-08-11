// Phase ZMI-MKT-OBS02 — Jalan PRODUCT-unit extraction (pure). PART A.
//
// Replaces plan-level block extraction for the market-observation path. The
// old jalanPlanBlockExtractor.ts emits ONE text block per plan section, but a
// Jalan plan section lists EVERY room type underneath it — so taking "the
// cheapest price in the block" and "a room name from somewhere in the block"
// could pair Room A's price with Room B's name and Room C's scarcity badge.
// Confirmed live (ONSEN & STAY OAKHILL 2026-08-13): three plans x four room
// types = twelve real products in one page, collapsed into one garbled record
// whose "room name" was actually the FIRST PLAN's title (【朝食無料サービス】).
//
// Invariant enforced here: 1 record = 1 room product x 1 rate plan, and
// room name / price / scarcity / availability all come from that product's
// OWN row segment. Plan name + meal basis come from the NEAREST ENCLOSING
// plan header only — never from a different plan.
//
// Two structural traps this module handles, both confirmed in real captures
// (see tests/fixtures/jalan/*.txt):
//   1. Plan headers ALSO use 【...】 brackets (【素泊まりプラン】), and so do
//      plan marketing blurbs (【岩＆檜露天風呂】). A naive "first/any 【】 is
//      the room name" rule picks a plan title. Room rows are therefore only
//      recognized AFTER the "部屋タイプ・詳細" table header inside a plan.
//   2. Jalan appends a "この宿をみた人は他にこんな宿をみています" carousel of
//      OTHER properties with their own prices (e.g. ホテル喜らく 30,135円 on
//      HAMMOND's page) — the same cross-property contamination already
//      guarded for Booking. That region is cut before any parsing.
//
// No I/O, no network.

import { classifyJalanMealBasis, type MealBasis } from "../services/mealBasisClassification";
import { extractInventoryScarcitySignal } from "../services/inventoryScarcityExtraction";
import type { InventoryCountSemantics, InventoryScope } from "../services/marketObservationSchema";

// Everything from here on belongs to OTHER properties, not the target.
const RELATED_PROPERTY_BOUNDARY_RE =
  /この宿をみた人は他にこんな宿をみています|ページの先頭に戻る|山形県の宿・ホテル\[PR\]|注目の宿・ホテル/u;

// The per-plan table header that separates a plan's own header/blurb from its
// list of bookable room rows. Room 【】 brackets only exist after this.
const ROOM_TABLE_HEADER_RE = /部屋タイプ\s*・\s*詳細/u;

// A plan header line carries a meal condition ("食事： 食事なし"). This is the
// reliable plan-boundary marker — plan titles themselves vary wildly
// (【...】, ≪...≫, or plain text).
const MEAL_LINE_RE = /食事[：:]\s*([^\n\r]{1,40})/u;

// Prices that are NOT stay prices: coupon face values ("2,000円クーポン",
// "1,000 円分") and per-night tax line items.
const COUPON_OR_FEE_PRICE_RE = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円\s*(?:クーポン|分|引|OFF|off)/u;
const PRICE_TOKEN_RE = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/gu;

// Room category label Jalan renders as its own cell just before the points
// column (和室 / 和洋室 / ツイン / トリプル / ダブル / シングル ...). Doubles as a
// bed/occupancy hint for room-basis classification.
const ROOM_CATEGORY_RE = /^(和洋室|和室|洋室|ツイン|トリプル|ダブル|シングル|フォース|スイート)$/u;

// "人数: 1 定員1名のみ" — the row is single-occupancy only, so it does NOT
// satisfy a 2-adult search context even though it renders a price.
const SINGLE_OCCUPANCY_ONLY_RE = /定員\s*1\s*名のみ|定員1名のみ/u;

export interface JalanPlanContext {
  planName: string;
  mealText: string;
  mealBasis: MealBasis;
  planIndex: number;
}

export interface JalanProductRecord {
  // Identity
  roomName: string;
  roomCategory: string;
  planName: string;
  mealText: string;
  mealBasis: MealBasis;
  // Price (from THIS row only)
  totalPriceTaxIncluded: number | null;
  perPersonPriceTaxIncluded: number | null;
  // Inventory (from THIS row only — never a sibling row's badge)
  inventoryCount: number | null;
  inventoryCountSemantics: InventoryCountSemantics;
  inventoryScope: InventoryScope;
  scarcityText: string;
  // Context / provenance
  singleOccupancyOnly: boolean;
  planIndex: number;
  rowIndex: number;
  rawRowText: string;
}

export function stripRelatedPropertySections(pageText: string): string {
  const m = RELATED_PROPERTY_BOUNDARY_RE.exec(pageText ?? "");
  return m ? (pageText ?? "").slice(0, m.index) : (pageText ?? "");
}

function normalize(text: string): string {
  return (text ?? "").normalize("NFKC").replace(/[\s　]+/gu, " ").trim();
}

// Page furniture that appears between a plan title and its meal line. Note
// 【予約受付期間】 is a booking-window METADATA line, not a plan title — it is
// bracketed exactly like a title and sits directly above the meal line, so
// without excluding it the "last bracketed line" rule names the plan after
// its reservation window (confirmed on 吉田屋, where the real title
// 【蔵王を遊びつくそう】… sits one line higher).
const PLAN_HEADER_NOISE_RE =
  /^(?:オンラインカード決済(?:専用|可)|【予約受付期間】.*|[0-9]+名?がこの(?:宿|プラン)を見ています|[0-9]+時間?前に予約されました|前に予約されました|おすすめ順|料金が(?:安|高)い順|[0-9,]+件の宿泊プランがありました。?)$/u;

// Extract the plan title from the header segment preceding the meal line.
//
// Returns the whole title LINE (capped), and scans from the END of the region:
//   - "last, not first" because for every plan after the first, the region
//     necessarily begins inside the PREVIOUS plan's trailing room rows (which
//     are themselves 【bracketed】) — the first bracket found would be a
//     previous plan's ROOM name.
//   - the whole LINE, not just the bracket contents, because Jalan
//     distinguishes otherwise-identical plans by a ≪...≫ prefix outside the
//     【...】 group: "≪じゃらん限定ポイント10%≫【朝食無料サービス】…" and
//     "【朝食無料サービス】～ONSEN＆STAY～…" are two DIFFERENT rate plans
//     (confirmed live on OAKHILL: same room, ¥38,000 vs ¥39,900). Keying on
//     bracket contents alone merged them into one product (an A3/J3
//     violation); keying on the full title line keeps them distinct.
const PLAN_NAME_MAX_LENGTH = 120;
function parsePlanName(headerText: string): string {
  const lines = headerText
    .split(/\r?\n/u)
    .map((l) => normalize(l))
    .filter((l) => l.length > 0 && !PLAN_HEADER_NOISE_RE.test(l) && !/^[0-9]+$/u.test(l));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (/【[^】]{2,80}】|≪[^≫]{2,80}≫/u.test(line)) {
      return line.length > PLAN_NAME_MAX_LENGTH ? line.slice(0, PLAN_NAME_MAX_LENGTH) : line;
    }
  }
  const substantial = lines.filter((l) => l.length >= 6);
  if (substantial.length === 0) return "";
  const last = substantial[substantial.length - 1]!;
  return last.length > PLAN_NAME_MAX_LENGTH ? last.slice(0, PLAN_NAME_MAX_LENGTH) : last;
}

// Jalan's "食事：" field is a CONTROLLED vocabulary (食事なし / 朝のみ / 夕のみ /
// 朝・夕), unlike free-text plan titles. Mapping it explicitly is strictly
// more accurate than running it through the free-text token classifier, which
// has no entry for "朝のみ"/"朝・夕" and therefore returned unknown_meal_basis
// for genuinely breakfast- and half-board-included plans. Free-text
// classification of the plan TITLE remains the fallback when the field is
// absent or unrecognized — never a guess.
function mealBasisFromJalanMealField(mealText: string, planName: string): MealBasis {
  const t = normalize(mealText);
  if (/食事なし|食事無し/u.test(t)) return "confirmed_room_only";
  if (/朝\s*[・･]\s*夕|夕\s*[・･]\s*朝|朝夕|2食|２食/u.test(t)) return "meal_included";
  if (/朝のみ|朝食のみ/u.test(t)) return "meal_included";
  if (/夕のみ|夕食のみ/u.test(t)) return "meal_included";
  return classifyJalanMealBasis(`${planName} ${t}`).mealBasis;
}

// Split the (related-property-stripped) page text into plan blocks. A plan
// block = [header ... meal line ... room table header ... room rows] and ends
// where the next plan's header begins.
export function splitJalanPlanBlocks(pageText: string): Array<{ headerText: string; roomListText: string; context: JalanPlanContext }> {
  const text = stripRelatedPropertySections(pageText);
  const mealMatches = [...text.matchAll(new RegExp(MEAL_LINE_RE, "gu"))];
  if (mealMatches.length === 0) return [];

  const blocks: Array<{ headerText: string; roomListText: string; context: JalanPlanContext }> = [];
  for (let i = 0; i < mealMatches.length; i += 1) {
    const meal = mealMatches[i]!;
    const mealIdx = meal.index ?? 0;
    // Header region: from the end of the PREVIOUS plan's room list (or the
    // start of the plan area) up to this meal line.
    const prevEnd = i === 0 ? 0 : (mealMatches[i - 1]!.index ?? 0);
    const headerSearchStart = i === 0 ? 0 : prevEnd;
    const headerRegionRaw = text.slice(headerSearchStart, mealIdx);
    // For plans after the first, the header is only the tail after the
    // previous plan's last room row — take the last ~400 chars to avoid
    // absorbing the previous plan's rooms into this plan's title.
    const headerText = i === 0 ? headerRegionRaw : headerRegionRaw.slice(-400);

    // This plan's region ends where the NEXT plan's own header begins, not at
    // the next meal line: the next plan's title sits between the two, so
    // cutting at the meal line would leak that title into this plan's room
    // list and produce a phantom "room" named after the next plan.
    const nextMealIdx = i + 1 < mealMatches.length ? (mealMatches[i + 1]!.index ?? text.length) : text.length;
    const afterMealFull = text.slice(mealIdx, nextMealIdx);
    const tableHeader = ROOM_TABLE_HEADER_RE.exec(afterMealFull);
    let roomListText = "";
    if (tableHeader) {
      const roomRegion = afterMealFull.slice(tableHeader.index + tableHeader[0].length);
      // Drop everything from the last bracketed title onwards IF that title is
      // the next plan's header (i.e. it is followed by no price of its own).
      const brackets = [...roomRegion.matchAll(/【[^】]{2,60}】|≪[^≫]{2,60}≫/gu)];
      let cut = roomRegion.length;
      if (brackets.length > 0 && i + 1 < mealMatches.length) {
        const last = brackets[brackets.length - 1]!;
        const tail = roomRegion.slice(last.index ?? 0);
        if (rowPrices(tail).length === 0) cut = last.index ?? roomRegion.length;
      }
      roomListText = roomRegion.slice(0, cut);
    }

    const mealText = normalize(meal[1] ?? "");
    const planName = parsePlanName(headerText);
    blocks.push({
      headerText,
      roomListText,
      context: {
        planName,
        mealText,
        // Meal basis is decided from the plan's OWN meal field plus its own
        // title — both belong to this plan, never to a sibling plan.
        mealBasis: mealBasisFromJalanMealField(mealText, planName),
        planIndex: i
      }
    });
  }
  return blocks;
}

// Split one plan's room-list region into per-product row segments. Each row
// starts at a 【room name】 and runs until the next one — so a row carries its
// own price and its own scarcity badge, and nothing else's.
export function splitJalanProductRows(roomListText: string): string[] {
  const text = roomListText ?? "";
  const starts: number[] = [];
  const re = /【[^】]{2,60}】/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];
  const rows: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1]! : text.length;
    rows.push(text.slice(starts[i]!, end));
  }
  return rows;
}

// All non-coupon, non-fee stay prices in a single row, in document order.
function rowPrices(rowText: string): number[] {
  const out: number[] = [];
  const re = new RegExp(PRICE_TOKEN_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowText)) !== null) {
    const tail = rowText.slice(m.index, m.index + m[0].length + 8);
    if (COUPON_OR_FEE_PRICE_RE.test(tail)) continue;
    const value = Number((m[1] ?? "").replace(/,/gu, ""));
    if (Number.isFinite(value) && value > 0) out.push(value);
  }
  return out;
}

function parseRoomCategory(rowText: string): string {
  for (const line of rowText.split(/\r?\n/u).map((l) => l.trim())) {
    if (ROOM_CATEGORY_RE.test(line)) return line;
  }
  return "";
}

export function parseJalanProductRow(rowText: string, context: JalanPlanContext, rowIndex: number): JalanProductRecord | null {
  const nameMatch = /【([^】]{2,60})】/u.exec(rowText);
  if (nameMatch === null) return null;
  const roomName = normalize(nameMatch[1] ?? "");
  if (roomName === "") return null;

  const prices = rowPrices(rowText);
  // Jalan renders 大人1名(税込) then 合計(税込) — the LAST stay price in the row
  // is the total. With a single price present, that price IS the total.
  const totalPriceTaxIncluded = prices.length > 0 ? prices[prices.length - 1]! : null;
  const perPersonPriceTaxIncluded = prices.length >= 2 ? prices[prices.length - 2]! : null;

  // Scarcity is read from THIS row's text only (A4) — a sibling row's badge
  // is physically outside rowText, so it cannot leak in.
  const scarcity = extractInventoryScarcitySignal(rowText);

  return {
    roomName,
    roomCategory: parseRoomCategory(rowText),
    planName: context.planName,
    mealText: context.mealText,
    mealBasis: context.mealBasis,
    totalPriceTaxIncluded,
    perPersonPriceTaxIncluded,
    inventoryCount: scarcity.inventoryCount,
    inventoryCountSemantics: scarcity.inventoryCountSemantics,
    inventoryScope: scarcity.inventoryScope,
    scarcityText: scarcity.rawText,
    singleOccupancyOnly: SINGLE_OCCUPANCY_ONLY_RE.test(rowText),
    planIndex: context.planIndex,
    rowIndex,
    rawRowText: rowText
  };
}

// Full page text -> one record per (room product x rate plan).
//
// A bracketed segment with NO stay price of its own is not a bookable product
// row — it is a leaked heading (a plan title, a marketing blurb, a note). Those
// are dropped rather than emitted as phantom rooms with null prices. Jalan does
// not list sold-out rooms as priceless rows for a searched date (a fully booked
// date renders a 満室 page instead), so requiring a price loses no real
// observation while removing every phantom.
export function extractJalanProductRecords(pageText: string): JalanProductRecord[] {
  const records: JalanProductRecord[] = [];
  for (const block of splitJalanPlanBlocks(pageText)) {
    const rows = splitJalanProductRows(block.roomListText);
    rows.forEach((rowText, rowIndex) => {
      const record = parseJalanProductRow(rowText, block.context, rowIndex);
      if (record === null) return;
      if (record.totalPriceTaxIncluded === null) return;
      records.push(record);
    });
  }
  return records;
}

// A3 — product identity from normalized room + plan + meal basis + search
// context. Room and plan are normalized to absorb UI wording noise
// (whitespace/width/casing) WITHOUT merging genuinely different rooms: the
// comparison is exact-match on the normalized tuple, never fuzzy.
export function buildJalanProductKey(input: {
  roomName: string;
  planName: string;
  mealBasis: MealBasis;
  searchAdults: number;
  searchChildren: number;
  searchRooms: number;
  lengthOfStay: number;
}): string {
  const room = normalize(input.roomName).toLowerCase();
  const plan = normalize(input.planName).toLowerCase();
  if (room === "") return "";
  return [
    `room:${room}`,
    `plan:${plan}`,
    `meal:${input.mealBasis}`,
    `occ:${input.searchAdults}a${input.searchChildren}c${input.searchRooms}r`,
    `los:${input.lengthOfStay}`
  ].join("|");
}

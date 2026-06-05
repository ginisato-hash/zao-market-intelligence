import type { Page } from "playwright";
import type { JalanExtractionEvidence, JalanPriceBasis } from "./jalanEvidence";
import { isNearCouponToken } from "./jalanPriceParser";

export interface JalanPlanBlockCandidate {
  blockText: string;
  planName?: string;
  roomName?: string;
  priceText?: string;
  priceValue?: number;
  priceBasis: JalanPriceBasis | "tax_included_unknown_total";
  hasTotalTaxIncludedEvidence: boolean;
  hasStayConditionEvidence: boolean;
  hasPlanOrRoomEvidence: boolean;
  confidence: "high" | "medium" | "low";
  rejectionReason?: string;
}

export interface JalanPlanBlockExtractionResult {
  candidates: JalanPlanBlockCandidate[];
  acceptedCandidate?: JalanPlanBlockCandidate;
  rejectedCount: number;
  rejectionReasons: Record<string, number>;
}

export interface JalanPlanBlockDebugSummary {
  candidateCount: number;
  rejectedCount: number;
  rejectionReasons: Record<string, number>;
  topCandidates: Array<{
    planName?: string;
    roomName?: string;
    priceText?: string;
    priceValue?: number;
    priceBasis: string;
    confidence: string;
    hasTotalTaxIncludedEvidence: boolean;
    hasStayConditionEvidence: boolean;
    hasPlanOrRoomEvidence: boolean;
    rejectionReason?: string;
    blockTextExcerpt: string;
  }>;
}

const PLAN_OR_ROOM_PATTERN = /(宿泊プラン|プラン|部屋タイプ|客室|部屋|和室|洋室|禁煙|喫煙|ツイン|ダブル|シングル)/u;
const TOTAL_TAX_INCLUDED_PATTERN = /(合計\s*[\(（]税込[\)）]|合計|総額|税込)/u;
const PER_PERSON_ONLY_PATTERN = /(大人1名\s*[\(（]税込[\)）]|大人1名|1名\s*[\(（]税込[\)）]|お一人様)/u;
const PRICE_PATTERN = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u;
const PLAN_NAME_PATTERN = /^(.{4,120}(?:プラン|満喫|温泉|朝食|夕食|チェックアウト|ランク).*)$/mu;
const ROOM_NAME_PATTERN = /(◇?[^\n]{0,40}(?:和室|洋室|ツイン|ダブル|シングル)[^\n]{0,40})/u;

export async function collectVisibleJalanPlanBlockTexts(page: Page): Promise<string[]> {
  return page.locator("body").evaluate((body) => {
    const candidates = Array.from(body.querySelectorAll("div, section, article, li, tr, table"))
      .map((element) => {
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        return { element, text };
      })
      .filter(({ text }) => text.includes("合計") && text.includes("円") && text.length >= 40 && text.length <= 2_500);

    const compact = new Map<string, string>();
    for (const { element, text } of candidates) {
      let current: Element | null = element;
      let best = text;
      for (let depth = 0; depth < 4 && current.parentElement !== null; depth += 1) {
        current = current.parentElement;
        const parentText = (current.textContent ?? "").replace(/\s+/g, " ").trim();
        if (
          parentText.includes("部屋タイプ") &&
          parentText.includes("合計") &&
          parentText.includes("円") &&
          parentText.length <= 2_500
        ) {
          best = parentText;
        }
      }
      compact.set(best, best);
    }

    return Array.from(compact.values()).slice(0, 20);
  });
}

export function extractJalanPlanBlocks(input: {
  blockTexts: string[];
  pageUrl: string;
  stayDate: string;
  adults: number;
  rooms: number;
  nights: number;
}): JalanPlanBlockExtractionResult {
  const hasStayConditionEvidence = urlHasStayCondition(input.pageUrl, input.stayDate, input.adults, input.nights);
  const candidates = input.blockTexts.map((blockText) => analyzePlanBlock(blockText, hasStayConditionEvidence));
  const acceptedCandidate = candidates.find((candidate) => candidate.rejectionReason === undefined);
  const rejectionReasons: Record<string, number> = {};

  for (const candidate of candidates) {
    if (candidate.rejectionReason !== undefined) {
      rejectionReasons[candidate.rejectionReason] = (rejectionReasons[candidate.rejectionReason] ?? 0) + 1;
    }
  }

  return {
    candidates,
    ...(acceptedCandidate === undefined ? {} : { acceptedCandidate }),
    rejectedCount: candidates.filter((candidate) => candidate.rejectionReason !== undefined).length,
    rejectionReasons
  };
}

export function planBlockToEvidence(
  extraction: JalanPlanBlockExtractionResult,
  stayDate: string
): JalanExtractionEvidence | null {
  const candidate = extraction.acceptedCandidate;
  return candidate === undefined ? null : planBlockCandidateToEvidence(candidate, stayDate);
}

export function planBlockCandidateToEvidence(
  candidate: JalanPlanBlockCandidate,
  stayDate: string
): JalanExtractionEvidence | null {
  if (candidate === undefined || candidate.priceValue === undefined || candidate.priceText === undefined) {
    return null;
  }

  return {
    stayDate,
    selectedDateTextFound: candidate.hasStayConditionEvidence,
    availabilityMarkerFound: true,
    availabilityMarkerText: "plan_block_price_available",
    priceFound: true,
    priceValue: candidate.priceValue,
    priceText: candidate.priceText,
    priceBasis: "total_tax_included",
    surroundingText: candidate.blockText.slice(0, 700),
    confidence: candidate.confidence
  };
}

export function buildPlanBlockDebugSummary(extraction: JalanPlanBlockExtractionResult): JalanPlanBlockDebugSummary {
  return {
    candidateCount: extraction.candidates.length,
    rejectedCount: extraction.rejectedCount,
    rejectionReasons: extraction.rejectionReasons,
    topCandidates: extraction.candidates.slice(0, 5).map((candidate) => ({
      ...(candidate.planName === undefined ? {} : { planName: candidate.planName }),
      ...(candidate.roomName === undefined ? {} : { roomName: candidate.roomName }),
      ...(candidate.priceText === undefined ? {} : { priceText: candidate.priceText }),
      ...(candidate.priceValue === undefined ? {} : { priceValue: candidate.priceValue }),
      priceBasis: candidate.priceBasis,
      confidence: candidate.confidence,
      hasTotalTaxIncludedEvidence: candidate.hasTotalTaxIncludedEvidence,
      hasStayConditionEvidence: candidate.hasStayConditionEvidence,
      hasPlanOrRoomEvidence: candidate.hasPlanOrRoomEvidence,
      ...(candidate.rejectionReason === undefined ? {} : { rejectionReason: candidate.rejectionReason }),
      blockTextExcerpt: candidate.blockText.slice(0, 500)
    }))
  };
}

function analyzePlanBlock(blockText: string, hasStayConditionEvidence: boolean): JalanPlanBlockCandidate {
  const normalized = blockText.replace(/\s+/gu, " ").trim();
  const totalPrice = extractTotalTaxIncludedPrice(normalized);
  const hasTotalTaxIncludedEvidence = TOTAL_TAX_INCLUDED_PATTERN.test(normalized);
  const hasPlanOrRoomEvidence = PLAN_OR_ROOM_PATTERN.test(normalized);
  const perPersonOnly = PER_PERSON_ONLY_PATTERN.test(normalized) && !/合計\s*[\(（]税込[\)）]|合計|総額/u.test(normalized);
  const priceBasis = determinePriceBasis(normalized, hasTotalTaxIncludedEvidence, perPersonOnly);
  const planName = extractPlanName(normalized);
  const roomName = extractRoomName(normalized);
  const candidate: JalanPlanBlockCandidate = {
    blockText: normalized,
    ...(planName === undefined ? {} : { planName }),
    ...(roomName === undefined ? {} : { roomName }),
    ...(totalPrice === null ? {} : { priceText: totalPrice.text, priceValue: totalPrice.value }),
    priceBasis,
    hasTotalTaxIncludedEvidence,
    hasStayConditionEvidence,
    hasPlanOrRoomEvidence,
    confidence: "low"
  };

  const rejectionReason = getRejectionReason(candidate, perPersonOnly);
  if (rejectionReason !== undefined) {
    return { ...candidate, rejectionReason };
  }

  return { ...candidate, confidence: candidate.roomName === undefined ? "medium" : "high" };
}

function getRejectionReason(candidate: JalanPlanBlockCandidate, perPersonOnly: boolean): string | undefined {
  if (!candidate.hasStayConditionEvidence) {
    return "stay_condition_not_found";
  }
  if (!isTightlyScopedPlanBlock(candidate.blockText)) {
    return "block_not_tightly_scoped";
  }
  if (!candidate.hasPlanOrRoomEvidence) {
    return "plan_or_room_context_not_found";
  }
  if (perPersonOnly || candidate.priceBasis === "per_person_tax_included") {
    return "per_person_price_without_total";
  }
  if (!candidate.hasTotalTaxIncludedEvidence || candidate.priceBasis !== "total_tax_included") {
    return "total_tax_included_basis_not_found";
  }
  if (candidate.priceText === undefined || candidate.priceValue === undefined) {
    return "price_not_found";
  }
  return undefined;
}

function determinePriceBasis(
  text: string,
  hasTotalTaxIncludedEvidence: boolean,
  perPersonOnly: boolean
): JalanPlanBlockCandidate["priceBasis"] {
  if (perPersonOnly) {
    return "per_person_tax_included";
  }
  if (/合計\s*[\(（]税込[\)）]|総額\s*[\(（]税込[\)）]/u.test(text)) {
    return "total_tax_included";
  }
  if (hasTotalTaxIncludedEvidence && /合計|総額/u.test(text)) {
    return "total_tax_included";
  }
  if (hasTotalTaxIncludedEvidence) {
    return "tax_included_unknown_total";
  }
  return "unknown";
}

function extractTotalTaxIncludedPrice(text: string): { text: string; value: number } | null {
  const totalLabelIndex = text.search(/合計\s*[\(（]税込[\)）]|総額\s*[\(（]税込[\)）]/u);
  if (totalLabelIndex < 0) {
    return null;
  }

  const afterTotalLabel = text.slice(totalLabelIndex);
  const prices = Array.from(afterTotalLabel.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/gu)).filter(
    (match) => match.index === undefined || !isNearCouponToken(afterTotalLabel, match.index, match[0].length)
  );
  if (prices.length === 0) {
    return null;
  }

  const hasPerPersonColumnBeforeTotal = /大人1名\s*[\(（]税込[\)）][\s\S]{0,80}合計\s*[\(（]税込[\)）]/u.test(text);
  const chosen = hasPerPersonColumnBeforeTotal && prices[1] !== undefined ? prices[1] : prices[0];
  if (chosen === undefined) {
    return null;
  }
  const priceText = chosen[0];
  const valueText = chosen[1];
  if (valueText === undefined) {
    return null;
  }

  return { text: priceText, value: Number(valueText.replace(/,/g, "")) };
}

function extractPlanName(text: string): string | undefined {
  const beforeReservation = text.split(/オンラインカード決済可|【予約受付期間】/u)[0]?.trim();
  const source = beforeReservation === undefined || beforeReservation.length < 4 ? text : beforeReservation;
  return source.match(PLAN_NAME_PATTERN)?.[1]?.slice(0, 140);
}

function extractRoomName(text: string): string | undefined {
  const markedRoom = text.match(/[◆◇][^◆◇]{1,40}[◆◇]\s*(?:禁煙|喫煙)?/u)?.[0]?.trim();
  if (markedRoom !== undefined) {
    return markedRoom.slice(0, 100);
  }
  return text.match(ROOM_NAME_PATTERN)?.[1]?.slice(0, 100);
}

function urlHasStayCondition(pageUrl: string, stayDate: string, adults: number, nights: number): boolean {
  const [year, month, day] = stayDate.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }

  try {
    const url = new URL(pageUrl);
    const roomCrack = url.searchParams.get("roomCrack") ?? "";
    return (
      url.pathname.includes("/plan/") &&
      url.searchParams.get("stayYear") === year &&
      url.searchParams.get("stayMonth") === month &&
      url.searchParams.get("stayDay") === day &&
      url.searchParams.get("stayCount") === String(nights) &&
      roomCrack.startsWith(String(adults))
    );
  } catch {
    return false;
  }
}

function isTightlyScopedPlanBlock(text: string): boolean {
  const roomDetailCount = (text.match(/部屋タイプ・詳細/gu) ?? []).length;
  const totalLabelCount = (text.match(/合計\s*[\(（]税込[\)）]/gu) ?? []).length;
  return roomDetailCount <= 1 && totalLabelCount <= 1;
}

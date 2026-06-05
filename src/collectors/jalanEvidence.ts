export type JalanPriceBasis = "total_tax_included" | "per_person_tax_included" | "unknown";
export type JalanEvidenceConfidence = "high" | "medium" | "low";

export interface JalanExtractionEvidence {
  stayDate: string;
  availabilityMarkerFound: boolean;
  availabilityMarkerText?: string | undefined;
  priceFound: boolean;
  priceValue?: number | undefined;
  priceText?: string | undefined;
  priceBasis: JalanPriceBasis;
  surroundingText?: string | undefined;
  selectedDateTextFound: boolean;
  confidence: JalanEvidenceConfidence;
  rejectionReason?: string | undefined;
}

const TOTAL_TAX_INCLUDED_PATTERNS = [
  /(合計|総額)[^\n]{0,40}(税込|税・サービス料込|税サ込)[^\d¥￥]{0,12}[¥￥]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u,
  /(税込|税・サービス料込|税サ込)[^\n]{0,40}(合計|総額)[^\d¥￥]{0,12}[¥￥]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u,
  /[¥￥]\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})[^\n]{0,40}(合計|総額)[^\n]{0,20}(税込|税・サービス料込|税サ込)/u,
  /合計\s*[\(（]税込[\)）][\s\S]{0,80}([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u
];

const PER_PERSON_TAX_INCLUDED_PATTERNS = [
  /(大人1名|1名|お一人様|一人)[^\n]{0,40}(税込|税・サービス料込|税サ込)[^\d¥￥]{0,12}[¥￥]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u,
  /[¥￥]\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})[^\n]{0,40}(大人1名|1名|お一人様|一人)[^\n]{0,20}(税込|税・サービス料込|税サ込)/u
];

const BOOKING_CONTEXT_PATTERN = /(宿泊プラン|プラン|客室|部屋|予約|空室|チェックイン|チェックアウト|合計|総額)/u;
const AVAILABILITY_MARKER_PATTERN = /(○|▲|空室あり|予約可|残り[0-9０-９]+室)/u;

export function analyzeJalanExtractionEvidence(text: string, stayDate: string): JalanExtractionEvidence {
  const dateEvidence = findSelectedDateEvidence(text, stayDate);

  if (!dateEvidence.selectedDateTextFound) {
    return {
      stayDate,
      availabilityMarkerFound: false,
      priceFound: false,
      priceBasis: "unknown",
      selectedDateTextFound: false,
      confidence: "low",
      rejectionReason: "selected_date_not_found"
    };
  }

  if (!dateEvidence.availabilityMarkerFound) {
    return {
      stayDate,
      availabilityMarkerFound: false,
      priceFound: false,
      priceBasis: "unknown",
      surroundingText: dateEvidence.surroundingText,
      selectedDateTextFound: true,
      confidence: "low",
      rejectionReason: "availability_marker_not_found"
    };
  }

  const scopedBlock = findScopedPriceBlock(text, stayDate);
  if (scopedBlock === null) {
    return {
      stayDate,
      availabilityMarkerFound: true,
      availabilityMarkerText: dateEvidence.availabilityMarkerText,
      priceFound: false,
      priceBasis: "unknown",
      surroundingText: dateEvidence.surroundingText,
      selectedDateTextFound: true,
      confidence: "low",
      rejectionReason: "price_basis_or_date_scope_unclear"
    };
  }

  const totalPrice = findTotalTaxIncludedPrice(scopedBlock);
  if (totalPrice !== null) {
    return {
      stayDate,
      availabilityMarkerFound: true,
      availabilityMarkerText: dateEvidence.availabilityMarkerText,
      priceFound: true,
      priceValue: totalPrice.value,
      priceText: totalPrice.text,
      priceBasis: "total_tax_included",
      surroundingText: excerptAround(scopedBlock, totalPrice.text),
      selectedDateTextFound: true,
      confidence: "high"
    };
  }

  const perPersonPrice = findPerPersonTaxIncludedPrice(scopedBlock);
  return {
    stayDate,
    availabilityMarkerFound: true,
    availabilityMarkerText: dateEvidence.availabilityMarkerText,
    priceFound: perPersonPrice !== null,
    ...(perPersonPrice === null ? {} : { priceValue: perPersonPrice.value, priceText: perPersonPrice.text }),
    priceBasis: perPersonPrice === null ? "unknown" : "per_person_tax_included",
    surroundingText: perPersonPrice === null ? scopedBlock.slice(0, 500) : excerptAround(scopedBlock, perPersonPrice.text),
    selectedDateTextFound: true,
    confidence: "low",
    rejectionReason: "price_basis_or_date_scope_unclear"
  };
}

export function analyzeJalanPlanPageExtractionEvidence(text: string, stayDate: string, pageUrl: string): JalanExtractionEvidence {
  if (!urlHasSelectedStayDate(pageUrl, stayDate) || !new URL(pageUrl).pathname.includes("/plan/")) {
    return analyzeJalanExtractionEvidence(text, stayDate);
  }

  const scopedBlock = findPlanPageScopedPriceBlock(text);
  if (scopedBlock === null) {
    return {
      stayDate,
      availabilityMarkerFound: hasPlanPageAvailability(text),
      ...(hasPlanPageAvailability(text) ? { availabilityMarkerText: "plan_page_availability" } : {}),
      priceFound: false,
      priceBasis: "unknown",
      surroundingText: `selected_date_encoded_in_url:${stayDate}`,
      selectedDateTextFound: true,
      confidence: "low",
      rejectionReason: "price_basis_or_date_scope_unclear"
    };
  }

  const totalPrice = findTotalTaxIncludedPrice(scopedBlock);
  if (totalPrice !== null && hasPlanPageAvailability(scopedBlock)) {
    return {
      stayDate,
      availabilityMarkerFound: true,
      availabilityMarkerText: "plan_page_availability",
      priceFound: true,
      priceValue: totalPrice.value,
      priceText: totalPrice.text,
      priceBasis: "total_tax_included",
      surroundingText: `selected_date_encoded_in_url:${stayDate}\n${excerptAround(scopedBlock, totalPrice.text)}`,
      selectedDateTextFound: true,
      confidence: "medium"
    };
  }

  return {
    stayDate,
    availabilityMarkerFound: hasPlanPageAvailability(scopedBlock),
    ...(hasPlanPageAvailability(scopedBlock) ? { availabilityMarkerText: "plan_page_availability" } : {}),
    priceFound: false,
    priceBasis: "unknown",
    surroundingText: `selected_date_encoded_in_url:${stayDate}\n${scopedBlock.slice(0, 500)}`,
    selectedDateTextFound: true,
    confidence: "low",
    rejectionReason: "price_basis_or_date_scope_unclear"
  };
}

export function buildJalanRawTextExcerpt(evidence: JalanExtractionEvidence, errorReason?: string): string {
  return JSON.stringify({
    stayDate: evidence.stayDate,
    selectedDateTextFound: evidence.selectedDateTextFound,
    availabilityMarkerFound: evidence.availabilityMarkerFound,
    availabilityMarkerText: evidence.availabilityMarkerText,
    priceFound: evidence.priceFound,
    priceValue: evidence.priceValue,
    priceText: evidence.priceText,
    priceBasis: evidence.priceBasis,
    confidence: evidence.confidence,
    rejectionReason: evidence.rejectionReason,
    errorReason,
    surroundingText: evidence.surroundingText?.slice(0, 700)
  });
}

function findSelectedDateEvidence(text: string, stayDate: string): {
  selectedDateTextFound: boolean;
  availabilityMarkerFound: boolean;
  availabilityMarkerText?: string;
  surroundingText?: string;
} {
  const [year, monthRaw, dayRaw] = stayDate.split("-");
  if (year === undefined || monthRaw === undefined || dayRaw === undefined) {
    return { selectedDateTextFound: false, availabilityMarkerFound: false };
  }

  const month = String(Number(monthRaw));
  const day = String(Number(dayRaw));
  const calendarPattern = new RegExp(`${year}年\\s*${month}月[\\s\\S]{0,900}(?:^|\\n|\\s)${day}(?:\\n|\\s)+(?<marker>○|▲|空室あり|予約可|残り[0-9０-９]+室)`, "u");
  const calendarMatch = text.match(calendarPattern);
  const calendarMarker = calendarMatch?.groups?.marker;
  if (calendarMarker !== undefined) {
    return {
      selectedDateTextFound: true,
      availabilityMarkerFound: true,
      availabilityMarkerText: calendarMarker,
      surroundingText: excerptAround(text, calendarMarker, 500)
    };
  }

  const compactDatePatterns = [
    new RegExp(`${year}[-/]${monthRaw}[-/]${dayRaw}`, "u"),
    new RegExp(`${year}年\\s*${month}月\\s*${day}日`, "u"),
    new RegExp(`${month}月\\s*${day}日`, "u")
  ];
  const dateIndex = compactDatePatterns.map((pattern) => text.search(pattern)).find((index) => index >= 0);
  if (dateIndex === undefined) {
    return { selectedDateTextFound: false, availabilityMarkerFound: false };
  }

  const surroundingText = text.slice(Math.max(0, dateIndex - 300), dateIndex + 500);
  const marker = surroundingText.match(AVAILABILITY_MARKER_PATTERN)?.[0];
  return {
    selectedDateTextFound: true,
    availabilityMarkerFound: marker !== undefined,
    ...(marker === undefined ? {} : { availabilityMarkerText: marker }),
    surroundingText
  };
}

function findScopedPriceBlock(text: string, stayDate: string): string | null {
  const dateBlocks = splitCandidateBlocks(text).filter((block) => block.includes(stayDate) || includesJapaneseDate(block, stayDate));
  const contextualBlocks = dateBlocks.filter((block) => BOOKING_CONTEXT_PATTERN.test(block));
  return contextualBlocks.find((block) => hasAnyPrice(block)) ?? null;
}

function findPlanPageScopedPriceBlock(text: string): string | null {
  const contextualBlocks = splitCandidateBlocks(text).filter(
    (block) =>
      /宿泊プラン|料金・宿泊プラン|部屋タイプ|客室/u.test(block) &&
      /合計\s*[\(（]税込[\)）]|合計|総額/u.test(block) &&
      /1泊|大人[0-9０-９]+名|部屋|室/u.test(block) &&
      hasAnyPrice(block)
  );
  return contextualBlocks.find((block) => hasPlanPageAvailability(block)) ?? null;
}

function splitCandidateBlocks(text: string): string[] {
  return text
    .split(/\n{2,}|\t{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && block.length <= 2_000);
}

function includesJapaneseDate(text: string, stayDate: string): boolean {
  const [year, monthRaw, dayRaw] = stayDate.split("-");
  if (year === undefined || monthRaw === undefined || dayRaw === undefined) {
    return false;
  }
  return text.includes(`${year}年${Number(monthRaw)}月${Number(dayRaw)}日`) || text.includes(`${Number(monthRaw)}月${Number(dayRaw)}日`);
}

function urlHasSelectedStayDate(pageUrl: string, stayDate: string): boolean {
  const [year, month, day] = stayDate.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  try {
    const url = new URL(pageUrl);
    return (
      url.searchParams.get("stayYear") === year &&
      url.searchParams.get("stayMonth") === month &&
      url.searchParams.get("stayDay") === day
    );
  } catch {
    return false;
  }
}

function hasPlanPageAvailability(text: string): boolean {
  return /(空室わずか|あと[0-9０-９]+部屋|残り[0-9０-９]+室|予約可|空室あり)/u.test(text);
}

function hasAnyPrice(text: string): boolean {
  return /[¥￥]?\s*[0-9]{1,3}(?:,[0-9]{3})+\s*円?/u.test(text) || /[0-9]{4,}\s*円/u.test(text);
}

function findTotalTaxIncludedPrice(text: string): { value: number; text: string } | null {
  for (const pattern of TOTAL_TAX_INCLUDED_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0] !== undefined) {
      return { value: Number(extractPriceText(match[0]).replace(/,/g, "")), text: match[0] };
    }
  }
  return null;
}

function findPerPersonTaxIncludedPrice(text: string): { value: number; text: string } | null {
  for (const pattern of PER_PERSON_TAX_INCLUDED_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0] !== undefined) {
      return { value: Number(extractPriceText(match[0]).replace(/,/g, "")), text: match[0] };
    }
  }
  return null;
}

function extractPriceText(text: string): string {
  return text.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})/u)?.[1] ?? "0";
}

function excerptAround(text: string, needle: string, radius = 300): string {
  const index = text.indexOf(needle);
  if (index < 0) {
    return text.slice(0, radius * 2);
  }
  return text.slice(Math.max(0, index - radius), index + needle.length + radius);
}

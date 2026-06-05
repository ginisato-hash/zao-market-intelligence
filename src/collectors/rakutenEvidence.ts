export type RakutenPriceBasis = "total_tax_included" | "per_person_tax_included" | "unknown";
export type RakutenEvidenceConfidence = "high" | "medium" | "low";

export interface RakutenExtractionEvidence {
  stayDate: string;
  selectedDateEvidenceFound: boolean;
  availabilityMarkerFound: boolean;
  availabilityMarkerText?: string;
  priceFound: boolean;
  priceValue?: number;
  priceText?: string;
  priceBasis: RakutenPriceBasis;
  surroundingText?: string;
  confidence: RakutenEvidenceConfidence;
  rejectionReason?: string;
}

const AVAILABILITY_PATTERN = /(空室|予約可|残り[0-9０-９]+室|あと[0-9０-９]+室|予約する)/u;
const PER_PERSON_PATTERN = /(1名あたり|お一人様|大人1名)/u;
const TOTAL_PATTERN = /(合計\s*[\(（]税込[\)）]|総額\s*[\(（]税込[\)）]|2名合計|2名で)/u;
const PRICE_PATTERN = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u;
// Price-range filter label only appears on the hotel overview/search-form page, not on plan-results pages
const OVERVIEW_FORM_PATTERN = /合計料金\s*※1部屋あたりの税込金額/u;
// Distinguishes whether the URL was the /PLAN/ path (we expected plan results) or the overview path
const PLAN_URL_PATTERN = /\/HOTEL\/\d+\/PLAN\//u;

export function analyzeRakutenExtractionEvidence(input: {
  text: string;
  stayDate: string;
  attemptUrl?: string;
}): RakutenExtractionEvidence {
  const selectedDateEvidenceFound = hasDateScope(input.text, input.stayDate, input.attemptUrl);
  if (!selectedDateEvidenceFound) {
    return baseRejected(input.stayDate, "selected_date_not_found");
  }

  if (OVERVIEW_FORM_PATTERN.test(input.text)) {
    const rejectionReason =
      input.attemptUrl !== undefined && PLAN_URL_PATTERN.test(input.attemptUrl)
        ? "rakuten_plan_results_not_reached"
        : "rakuten_overview_page_no_plan_results";
    return {
      ...baseRejected(input.stayDate, rejectionReason),
      selectedDateEvidenceFound: true
    };
  }

  const availabilityMarker = input.text.match(AVAILABILITY_PATTERN)?.[0];
  if (availabilityMarker === undefined) {
    return {
      ...baseRejected(input.stayDate, "availability_marker_not_found"),
      selectedDateEvidenceFound: true
    };
  }

  const totalMatch = findTotalPrice(input.text);
  if (totalMatch === null) {
    return {
      stayDate: input.stayDate,
      selectedDateEvidenceFound: true,
      availabilityMarkerFound: true,
      availabilityMarkerText: availabilityMarker,
      priceFound: false,
      priceBasis: PER_PERSON_PATTERN.test(input.text) ? "per_person_tax_included" : "unknown",
      confidence: "low",
      rejectionReason: "total_tax_included_price_not_found"
    };
  }

  return {
    stayDate: input.stayDate,
    selectedDateEvidenceFound: true,
    availabilityMarkerFound: true,
    availabilityMarkerText: availabilityMarker,
    priceFound: true,
    priceValue: totalMatch.value,
    priceText: totalMatch.text,
    priceBasis: "total_tax_included",
    surroundingText: totalMatch.surroundingText,
    confidence: "high"
  };
}

function baseRejected(stayDate: string, rejectionReason: string): RakutenExtractionEvidence {
  return {
    stayDate,
    selectedDateEvidenceFound: false,
    availabilityMarkerFound: false,
    priceFound: false,
    priceBasis: "unknown",
    confidence: "low",
    rejectionReason
  };
}

function hasDateScope(text: string, stayDate: string, attemptUrl?: string): boolean {
  const [year, monthRaw, dayRaw] = stayDate.split("-");
  if (year === undefined || monthRaw === undefined || dayRaw === undefined) {
    return false;
  }
  if (text.includes(stayDate) || text.includes(`${year}年${Number(monthRaw)}月${Number(dayRaw)}日`)) {
    return true;
  }
  if (attemptUrl !== undefined) {
    try {
      return new URL(attemptUrl).searchParams.get("f_checkin_date") === `${year}/${monthRaw}/${dayRaw}`;
    } catch {
      return false;
    }
  }
  return false;
}

function findTotalPrice(text: string): { value: number; text: string; surroundingText: string } | null {
  const totalMatch = text.match(TOTAL_PATTERN);
  if (totalMatch?.[0] === undefined) {
    return null;
  }
  const index = totalMatch.index ?? 0;
  const surroundingText = text.slice(Math.max(0, index - 160), index + 260);
  const price = surroundingText.match(PRICE_PATTERN);
  if (price?.[0] === undefined || price[1] === undefined) {
    return null;
  }
  if (PER_PERSON_PATTERN.test(surroundingText) && !TOTAL_PATTERN.test(surroundingText)) {
    return null;
  }
  return {
    value: Number(price[1].replace(/,/g, "")),
    text: price[0],
    surroundingText
  };
}

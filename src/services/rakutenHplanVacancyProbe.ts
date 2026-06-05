/**
 * Rakuten /hplan/calendar/ vacancy-positive probe (Phase 62X).
 *
 * Phase 61X proved the /hplan/calendar/ JSONP feed is reachable and parser-ready
 * but found no vacant day for ZAO BASE / f_syu=zaobase across the probed months.
 * Phase 62X widens the search to a small set of higher-coverage Rakuten properties
 * and the room codes their plan pages expose, looking for at least one day where
 * isVacant=true, price>0, and link is populated — the signal that the feed can
 * drive a limited rendered collector.
 *
 * Pure helpers + renderers only. No network, no DB writes. The Playwright
 * plan-page room-code extraction + in-context JSONP fetch + link following lives
 * in src/scripts/probeRakutenHplanVacancyPositive.ts.
 */
import {
  buildHplanCalendarUrl,
  detectConditionPage,
  detectHplanResponseType,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  parseHplanCalendarResponse,
  stripJsonpWrapper,
  type HplanCalendarParsed,
  type HplanDay,
  type HplanResponseType,
  type RakutenIframeEvidence
} from "./rakutenHplanCalendarProbe";

export {
  buildHplanCalendarUrl,
  detectConditionPage,
  detectHplanResponseType,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  parseHplanCalendarResponse,
  stripJsonpWrapper,
  type HplanCalendarParsed,
  type HplanDay,
  type HplanResponseType,
  type RakutenIframeEvidence
};

export const MAX_ROOM_CODES_PER_PROPERTY = 3;

export type HplanVacancyEndpointClassification =
  | "hplan_vacancy_positive"
  | "hplan_price_positive_no_link"
  | "hplan_no_available_dates"
  | "hplan_sold_out_or_no_plan"
  | "hplan_empty"
  | "hplan_blocked_or_failed"
  | "hplan_basis_unverified";

export type HplanFollowedClassification =
  | "hplan_followed_total_found"
  | "hplan_followed_per_person_found"
  | "hplan_followed_condition_page_reached"
  | "hplan_followed_no_plan_or_sold_out"
  | "hplan_followed_basis_unverified"
  | "hplan_followed_navigation_failed";

export type RakutenHplanVacancyDecision =
  | "rakuten_hplan_vacancy_ready"
  | "rakuten_hplan_vacancy_basis_mapping_needed"
  | "rakuten_hplan_vacancy_not_found"
  | "rakuten_hplan_vacancy_not_ready";

export interface PlanPageRoomCode {
  fSyu: string;
  context: string;
  prefersTwoAdults: boolean;
}

export interface RakutenHplanVacancyRow {
  canonicalPropertyName: string;
  hotelNo: string;
  fSyu: string;
  monthAnchor: string;
  endpointUrl: string;
  reachable: boolean;
  responseType: HplanResponseType;
  isTaxExclusive: boolean;
  chargeType: string;
  availableDayCount: number;
  pricePositiveDayCount: number;
  populatedLinkCount: number;
  sampleAvailableDate: string;
  samplePrice: number;
  sampleLink: string;
  classification: HplanVacancyEndpointClassification;
  followedLinksCount: number;
  bestFollowedClassification: string;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_HPLAN_VACANCY_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "f_syu",
  "month_anchor",
  "endpoint_url",
  "reachable",
  "response_type",
  "is_tax_exclusive",
  "charge_type",
  "available_day_count",
  "price_positive_day_count",
  "populated_link_count",
  "sample_available_date",
  "sample_price",
  "sample_link",
  "classification",
  "followed_links_count",
  "best_followed_classification",
  "risk_note",
  "debug_artifact_path"
] as const;

/**
 * Extract candidate f_syu room codes from a Rakuten plan page by reading the
 * 空室カレンダー (vacancy calendar) hrefs. Room codes whose surrounding context
 * mentions 2 adults are prioritized (stable sort keeps document order otherwise).
 */
export function extractRoomCodesFromPlanPage(html: string): PlanPageRoomCode[] {
  const decoded = html.replace(/&amp;/gu, "&");
  const results: PlanPageRoomCode[] = [];
  const anchorRe = /<a\b[^>]*href=(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a>/giu;
  let m: RegExpExecArray | null;
  let prevAnchorEnd = 0;
  while ((m = anchorRe.exec(decoded)) !== null) {
    // Isolate this room block's own text (everything since the previous anchor)
    // so a wide window does not bleed 2名 markers in from neighbouring rooms.
    const segStart = prevAnchorEnd;
    prevAnchorEnd = m.index + (m[0]?.length ?? 0);
    const href = m[2] ?? "";
    const anchorText = m[3] ?? "";
    const fSyuMatch = /[?&]f_syu=([^&"'#\s]+)/u.exec(href);
    if (!fSyuMatch) continue;
    const isCalendar = /calendar/iu.test(href) || /空室カレンダー/u.test(anchorText);
    if (!isCalendar) continue;
    let fSyu = fSyuMatch[1] ?? "";
    try {
      fSyu = decodeURIComponent(fSyu);
    } catch {
      // keep raw value when not URI-encoded
    }
    if (fSyu === "") continue;
    const context = stripTags(decoded.slice(segStart, m.index));
    const prefersTwoAdults = /2\s*名|２名|大人\s*2|大人２/u.test(context);
    const existing = results.find((r) => r.fSyu === fSyu);
    if (existing) {
      if (prefersTwoAdults) existing.prefersTwoAdults = true;
      continue;
    }
    results.push({ fSyu, context: context.slice(-200), prefersTwoAdults });
  }
  return results.sort((a, b) => Number(b.prefersTwoAdults) - Number(a.prefersTwoAdults));
}

/** Limit to the first `max` distinct room codes (cap on probe breadth). */
export function limitRoomCodes(codes: string[], max: number = MAX_ROOM_CODES_PER_PROPERTY): string[] {
  const unique: string[] = [];
  for (const code of codes) {
    if (code && !unique.includes(code)) unique.push(code);
    if (unique.length >= max) break;
  }
  return unique;
}

export interface VacancyDaySummary {
  availableDayCount: number;
  pricePositiveDayCount: number;
  populatedLinkCount: number;
  sampleAvailableDate: string;
  samplePrice: number;
  sampleLink: string;
  vacancyPositiveDays: HplanDay[];
}

function isVacancyPositive(day: HplanDay): boolean {
  return day.isVacant && day.price > 0 && day.link.trim() !== "";
}

export function summarizeVacancyDays(parsed: HplanCalendarParsed): VacancyDaySummary {
  const days = parsed.days;
  const availableDayCount = days.filter((d) => d.isVacant).length;
  const pricePositiveDayCount = days.filter((d) => d.price > 0).length;
  const populatedLinkCount = days.filter((d) => d.link.trim() !== "").length;
  const vacancyPositiveDays = days.filter(isVacancyPositive);
  const sample = vacancyPositiveDays[0] ?? days.find((d) => d.price > 0);
  return {
    availableDayCount,
    pricePositiveDayCount,
    populatedLinkCount,
    sampleAvailableDate: sample?.viewDay ?? "",
    samplePrice: sample?.price ?? 0,
    sampleLink: sample?.link ?? "",
    vacancyPositiveDays
  };
}

export function classifyHplanVacancyEndpoint(input: {
  reachable: boolean;
  parsed: HplanCalendarParsed;
}): HplanVacancyEndpointClassification {
  if (!input.reachable) return "hplan_blocked_or_failed";
  const p = input.parsed;
  if (p.responseType === "blocked_or_error") return "hplan_blocked_or_failed";
  if (p.responseType === "empty" || (!p.ok && p.days.length === 0)) return "hplan_empty";
  if (p.isEmpty && p.days.length === 0) return "hplan_empty";

  if (p.days.some(isVacancyPositive)) return "hplan_vacancy_positive";
  if (p.days.some((d) => d.price > 0 && d.link.trim() === "")) return "hplan_price_positive_no_link";

  const anyFull = p.days.some((d) => d.isFull);
  const anyVacant = p.days.some((d) => d.isVacant);
  if (anyFull && !anyVacant) return "hplan_sold_out_or_no_plan";
  if (p.days.length > 0) return "hplan_no_available_dates";
  return "hplan_basis_unverified";
}

export function classifyHplanFollowedLink(input: {
  reachable: boolean;
  conditionPageReached: boolean;
  noMatchingRoomType: boolean;
  evidence: RakutenIframeEvidence;
}): HplanFollowedClassification {
  if (!input.reachable) return "hplan_followed_navigation_failed";
  const e = input.evidence;
  if (input.noMatchingRoomType || e.soldOutOrNoPlanDetected) return "hplan_followed_no_plan_or_sold_out";
  if (
    e.propertyDetected &&
    e.dateScopeDetected &&
    e.adultCountDetected &&
    e.roomCountDetected &&
    e.nightCountDetected &&
    e.taxIncludedTotalDetected &&
    e.availabilityStatus === "available"
  ) {
    return "hplan_followed_total_found";
  }
  if (e.propertyDetected && e.perPersonPriceDetected && !e.taxIncludedTotalDetected) {
    return "hplan_followed_per_person_found";
  }
  if (input.conditionPageReached) return "hplan_followed_condition_page_reached";
  return "hplan_followed_basis_unverified";
}

export function decideRakutenHplanVacancy(input: {
  endpointClassifications: HplanVacancyEndpointClassification[];
  followedClassifications: HplanFollowedClassification[];
}): RakutenHplanVacancyDecision {
  const hasVacancyPositive = input.endpointClassifications.includes("hplan_vacancy_positive");
  const hasFollowedBasis = input.followedClassifications.some(
    (c) => c === "hplan_followed_total_found" || c === "hplan_followed_per_person_found"
  );
  if (hasVacancyPositive && hasFollowedBasis) return "rakuten_hplan_vacancy_ready";

  const anyPositiveData = input.endpointClassifications.some(
    (c) => c === "hplan_vacancy_positive" || c === "hplan_price_positive_no_link"
  );
  if (anyPositiveData) return "rakuten_hplan_vacancy_basis_mapping_needed";

  const anyEndpointWorked = input.endpointClassifications.some((c) => c !== "hplan_blocked_or_failed");
  if (input.endpointClassifications.length > 0 && anyEndpointWorked) {
    return "rakuten_hplan_vacancy_not_found";
  }
  return "rakuten_hplan_vacancy_not_ready";
}

export function renderRakutenHplanVacancyCsv(rows: RakutenHplanVacancyRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.fSyu,
      row.monthAnchor,
      row.endpointUrl,
      yn(row.reachable),
      row.responseType,
      yn(row.isTaxExclusive),
      row.chargeType,
      String(row.availableDayCount),
      String(row.pricePositiveDayCount),
      String(row.populatedLinkCount),
      row.sampleAvailableDate,
      String(row.samplePrice),
      row.sampleLink,
      row.classification,
      String(row.followedLinksCount),
      row.bestFollowedClassification,
      row.riskNote,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [RAKUTEN_HPLAN_VACANCY_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenHplanVacancyReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  rows: RakutenHplanVacancyRow[];
  decision: RakutenHplanVacancyDecision;
  executionNote: string;
  propertiesTested: { canonicalPropertyName: string; hotelNo: string; roomCodes: string[] }[];
  monthAnchors: string[];
}): string {
  const counts = new Map<HplanVacancyEndpointClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  const vacancyPositiveRows = input.rows.filter((r) => r.classification === "hplan_vacancy_positive");
  const pricePositiveRows = input.rows.filter(
    (r) => r.classification === "hplan_vacancy_positive" || r.classification === "hplan_price_positive_no_link"
  );
  const totalFollowed = input.rows.reduce((acc, r) => acc + r.followedLinksCount, 0);

  return [
    "# Rakuten /hplan/calendar/ Vacancy-Positive Probe (Phase 62X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- endpoint_urls_tested=${input.rows.length}`,
    `- vacancy_positive_rows=${vacancyPositiveRows.length}`,
    `- price_positive_rows=${pricePositiveRows.length}`,
    `- followed_links_total=${totalFollowed}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "- Goal: find at least one /hplan/calendar/ day with isVacant=true, price>0, and a populated link, then follow it to inspect the date-scoped price basis.",
    "",
    "## 2. Properties / room codes / months tested",
    "",
    ...input.propertiesTested.map(
      (p) => `- ${p.canonicalPropertyName} (${p.hotelNo}): room_codes=[${p.roomCodes.join(", ") || "none"}]`
    ),
    `- month_anchors=[${input.monthAnchors.join(", ")}]`,
    "",
    "## 3. Endpoint response results",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.hotelNo}/${r.fSyu || "(none)"}/${r.monthAnchor}: reachable=${yn(r.reachable)}, type=${r.responseType}, is_tax_exclusive=${yn(r.isTaxExclusive)}, charge_type=${r.chargeType || "n/a"}, class=${r.classification}`
    ),
    "",
    "## 4. Vacancy-positive rows",
    "",
    vacancyPositiveRows.length === 0
      ? "- none"
      : vacancyPositiveRows
          .map(
            (r) =>
              `- ${r.hotelNo}/${r.fSyu}/${r.monthAnchor}: sample_date=${r.sampleAvailableDate}, sample_price=${r.samplePrice}, sample_link=${r.sampleLink}`
          )
          .join("\n"),
    "",
    "## 5. Price-positive rows",
    "",
    pricePositiveRows.length === 0
      ? "- none"
      : pricePositiveRows
          .map(
            (r) =>
              `- ${r.hotelNo}/${r.fSyu}/${r.monthAnchor}: price_positive_days=${r.pricePositiveDayCount}, populated_links=${r.populatedLinkCount}`
          )
          .join("\n"),
    "",
    "## 6. Followed links",
    "",
    totalFollowed === 0
      ? "- none followed (no vacancy-positive day links to follow)"
      : input.rows
          .filter((r) => r.followedLinksCount > 0)
          .map((r) => `- ${r.hotelNo}/${r.fSyu}/${r.monthAnchor}: followed=${r.followedLinksCount}, best=${r.bestFollowedClassification || "n/a"}`)
          .join("\n"),
    "",
    "## 7. Price / date / basis findings",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.hotelNo}/${r.fSyu || "(none)"}/${r.monthAnchor}: available=${r.availableDayCount}, price>0=${r.pricePositiveDayCount}, links=${r.populatedLinkCount}, sample_price=${r.samplePrice}`
    ),
    "",
    "## 8. Feasibility decision",
    "",
    `- ${input.decision}`,
    "",
    "## 9. Risk notes",
    "",
    ...input.rows.map((r) => `- ${r.hotelNo}/${r.fSyu || "(none)"}/${r.monthAnchor}: ${r.riskNote}`),
    "",
    "## 10. Debug artifact paths",
    "",
    `- ${input.debugRootPath}`,
    "",
    "## 11. Safety confirmation",
    "",
    "- Public plan pages + the public /hplan/calendar/ JSONP feed surfaced in the rendered DOM; no login, no cookies beyond the public session, no CAPTCHA bypass, no stealth, no paid APIs, no proxies, no private/internal APIs.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 12. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: RakutenHplanVacancyDecision): string {
  if (decision === "rakuten_hplan_vacancy_ready") {
    return "- A vacancy-positive day was found AND a followed link exposed a date-scoped 2-adult/1-room/1-night price basis. The /hplan/calendar/ feed + day link is a viable read-only collector entry point — gate a tiny prototype behind explicit review and map dayList.price (tax-inclusive when isTaxExclusive=false) to the collector price field.";
  }
  if (decision === "rakuten_hplan_vacancy_basis_mapping_needed") {
    return "- At least one endpoint returned vacancy/price/link-positive day data, but the followed condition page did not cleanly confirm a date-scoped total. Map the dayList.price/link → condition-page total selectors (re-run the follow step with refined selectors) before any DB-writing collector.";
  }
  if (decision === "rakuten_hplan_vacancy_not_found") {
    return "- The /hplan/calendar/ feed is reachable and parser-ready across the probed properties/room codes/months, but none returned a vacant day with price>0 + link. Widen the property/room/month set or probe nearer high-demand dates (weekends/holidays) where Rakuten inventory is more likely open.";
  }
  return "- The /hplan/calendar/ endpoints were blocked/empty/unusable for the probed set; re-capture the live widget's exact JSONP request (params + headers + session seeding) under human review before proceeding.";
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }
  return value;
}

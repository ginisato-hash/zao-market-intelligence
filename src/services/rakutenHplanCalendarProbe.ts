/**
 * Rakuten /hplan/calendar/ endpoint probe (Phase 61X).
 *
 * Phase 60X established that the standalone vacancy-calendar iframe renders the
 * month grid skeleton but never populates per-day vacancy links — those load via
 * an AJAX call to https://hotel.travel.rakuten.co.jp/hplan/calendar/, which the
 * rendered DOM surfaced. That endpoint is a JSONP feed: called with the full
 * widget param set (+ render=jsonp&callback=...) it returns 200 with a structured
 * payload whose `dayList` carries, per in-month day: viewDay, stock, price
 * (tax-inclusive when isTaxExclusive=false), discountedPrice, link, vacantCondition,
 * isPast / isFull / isVacant. An available day has isVacant=true + a non-null link.
 *
 * Pure helpers + renderers only. No network calls, no DB writes. The Playwright
 * in-context fetch + link following lives in src/scripts/probeRakutenHplanCalendar.ts.
 */
import {
  detectConditionPage,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  type RakutenIframeEvidence
} from "./rakutenDayLinkProbe";

export {
  detectConditionPage,
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  type RakutenIframeEvidence
};

export const HPLAN_CALENDAR_BASE = "https://hotel.travel.rakuten.co.jp/hplan/calendar/";

export type HplanResponseType =
  | "jsonp"
  | "json"
  | "html_fragment"
  | "full_html"
  | "plain_text"
  | "blocked_or_error"
  | "empty";

export interface HplanDay {
  viewDay: string;
  epoch: number;
  stock: number;
  price: number;
  priceWithoutTax: number;
  discountedPrice: number;
  link: string;
  vacantCondition: string;
  monthClass: string;
  isPast: boolean;
  isFull: boolean;
  isVacant: boolean;
  /** True when the day is bookable: isVacant with a usable condition-page link. */
  enabled: boolean;
}

export interface HplanCalendarParsed {
  ok: boolean;
  responseType: HplanResponseType;
  viewDate: string;
  isEmpty: boolean;
  isTaxExclusive: boolean;
  vacantRoomCount: number;
  hotelNo: string;
  roomCode: string;
  chargeType: string;
  nextMonthCalendarUrl: string;
  days: HplanDay[];
}

export type HplanCalendarClassification =
  | "hplan_calendar_with_available_links"
  | "hplan_calendar_no_available_dates"
  | "hplan_calendar_sold_out_or_no_plan"
  | "hplan_calendar_empty"
  | "hplan_calendar_blocked_or_failed"
  | "hplan_calendar_basis_unverified";

export type HplanDayLinkClassification =
  | "hplan_day_link_total_found"
  | "hplan_day_link_per_person_found"
  | "hplan_day_link_condition_page_reached"
  | "hplan_day_link_no_plan_or_sold_out"
  | "hplan_day_link_basis_unverified"
  | "hplan_day_link_navigation_failed";

export type RakutenHplanDecision =
  | "rakuten_hplan_ready"
  | "rakuten_hplan_basis_mapping_needed"
  | "rakuten_hplan_no_available_dates"
  | "rakuten_hplan_not_ready";

export interface RakutenHplanProbeRow {
  canonicalPropertyName: string;
  hotelNo: string;
  fSyu: string;
  monthAnchor: string;
  endpointUrl: string;
  reachable: boolean;
  responseType: HplanResponseType;
  availableDayLinksCount: number;
  soldOutDayCount: number;
  noPlanDayCount: number;
  priceTextDetected: string;
  classification: HplanCalendarClassification;
  followedLinksCount: number;
  bestFollowedClassification: string;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_HPLAN_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "f_syu",
  "month_anchor",
  "endpoint_url",
  "reachable",
  "response_type",
  "available_day_links_count",
  "sold_out_day_count",
  "no_plan_day_count",
  "price_text_detected",
  "classification",
  "followed_links_count",
  "best_followed_classification",
  "risk_note",
  "debug_artifact_path"
] as const;

/**
 * Build the public /hplan/calendar/ JSONP URL using the full param set the live
 * calendar widget sends. f_calendar is anchored to the requested month, and the
 * person/room basis is forced to 2 adults / 1 room.
 */
export function buildHplanCalendarUrl(input: {
  hotelNo: string;
  fSyu: string;
  monthAnchor: string; // YYYYMMDD
  fOtonaSu?: string;
  fHeyaSu?: string;
  callback?: string;
  cacheBust?: number;
}): string {
  if (!/^\d+$/u.test(input.hotelNo)) throw new Error(`invalid hotelNo: ${input.hotelNo}`);
  if (!/^\d{8}$/u.test(input.monthAnchor)) throw new Error(`monthAnchor must be YYYYMMDD: ${input.monthAnchor}`);
  const url = new URL(HPLAN_CALENDAR_BASE);
  const p = url.searchParams;
  p.set("f_no", input.hotelNo);
  p.set("f_syu", input.fSyu);
  p.set("f_flg", "PLAN");
  p.set("f_hizuke", input.monthAnchor);
  p.set("f_otona_su", input.fOtonaSu ?? "2");
  p.set("f_s1", "0");
  p.set("f_s2", "0");
  p.set("f_y1", "0");
  p.set("f_y2", "0");
  p.set("f_y3", "0");
  p.set("f_y4", "0");
  p.set("f_heya_su", input.fHeyaSu ?? "1");
  p.set("f_calendar", input.monthAnchor);
  p.set("f_thick", "1");
  p.set("render", "jsonp");
  p.set("callback", input.callback ?? "cb");
  p.set("_", String(input.cacheBust ?? 0));
  return url.toString();
}

export function detectHplanResponseType(text: string, status: number): HplanResponseType {
  if (status >= 400 || status === 0) return "blocked_or_error";
  const t = text.trim();
  if (t === "") return "empty";
  if (/^[\w$.]+\s*\(\s*[{[]/u.test(t) || (/\)\s*;?$/u.test(t) && /dayList|roomInfoDto/u.test(t))) {
    return "jsonp";
  }
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (/<html[\s>]/iu.test(t)) return "full_html";
  if (/<td|<table|roomCalendar/iu.test(t)) return "html_fragment";
  return "plain_text";
}

/** Strip a JSONP wrapper to its inner JSON text, or return the text unchanged. */
export function stripJsonpWrapper(text: string): string {
  const t = text.trim();
  const open = t.indexOf("(");
  const close = t.lastIndexOf(")");
  if (open !== -1 && close > open) return t.slice(open + 1, close);
  return t;
}

interface RawHplanDay {
  viewDay?: unknown;
  day?: unknown;
  stock?: unknown;
  price?: unknown;
  priceWithoutTax?: unknown;
  discountedPrice?: unknown;
  link?: unknown;
  vacantCondition?: unknown;
  monthClass?: unknown;
  isPast?: unknown;
  isFull?: unknown;
  isVacant?: unknown;
}

function toHplanDay(raw: RawHplanDay): HplanDay {
  const link = typeof raw.link === "string" ? raw.link : "";
  const isVacant = raw.isVacant === true;
  const day: HplanDay = {
    viewDay: String(raw.viewDay ?? ""),
    epoch: typeof raw.day === "number" ? raw.day : 0,
    stock: typeof raw.stock === "number" ? raw.stock : 0,
    price: typeof raw.price === "number" ? raw.price : 0,
    priceWithoutTax: typeof raw.priceWithoutTax === "number" ? raw.priceWithoutTax : 0,
    discountedPrice: typeof raw.discountedPrice === "number" ? raw.discountedPrice : 0,
    link,
    vacantCondition: typeof raw.vacantCondition === "string" ? raw.vacantCondition : "",
    monthClass: typeof raw.monthClass === "string" ? raw.monthClass : "",
    isPast: raw.isPast === true,
    isFull: raw.isFull === true,
    isVacant,
    enabled: isVacant && link.trim() !== ""
  };
  return day;
}

/**
 * Parse a /hplan/calendar/ response. Primary path is the JSONP/JSON payload
 * (dayList). Falls back to extracting day cells from an HTML fragment.
 */
export function parseHplanCalendarResponse(text: string, status = 200): HplanCalendarParsed {
  const responseType = detectHplanResponseType(text, status);
  const empty: HplanCalendarParsed = {
    ok: false,
    responseType,
    viewDate: "",
    isEmpty: true,
    isTaxExclusive: false,
    vacantRoomCount: 0,
    hotelNo: "",
    roomCode: "",
    chargeType: "",
    nextMonthCalendarUrl: "",
    days: []
  };
  if (responseType === "blocked_or_error" || responseType === "empty") return empty;

  if (responseType === "html_fragment" || responseType === "full_html") {
    return { ...empty, ok: true, days: parseHplanDaysFromHtml(text), isEmpty: false };
  }

  try {
    const json = JSON.parse(stripJsonpWrapper(text)) as Record<string, unknown>;
    const dayListRaw = Array.isArray(json.dayList) ? (json.dayList as RawHplanDay[]) : [];
    const roomInfo = (json.roomInfoDto ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      responseType,
      viewDate: typeof json.viewDate === "string" ? json.viewDate : "",
      isEmpty: json.isEmpty === true,
      isTaxExclusive: json.isTaxExclusive === true,
      vacantRoomCount: typeof json.vacantRoomCount === "number" ? json.vacantRoomCount : 0,
      hotelNo: json.hotelNo === undefined ? "" : String(json.hotelNo),
      roomCode: typeof json.roomCode === "string" ? json.roomCode : "",
      chargeType: typeof roomInfo.chargeType === "string" ? roomInfo.chargeType : "",
      nextMonthCalendarUrl: typeof json.nextMonthCalendarUrl === "string" ? json.nextMonthCalendarUrl : "",
      days: dayListRaw.map(toHplanDay)
    };
  } catch {
    return { ...empty, responseType, ok: false };
  }
}

/** Extract day cells from an HTML calendar fragment (fallback path). */
export function parseHplanDaysFromHtml(html: string): HplanDay[] {
  const decoded = html.replace(/&amp;/gu, "&");
  const days: HplanDay[] = [];
  const tdPattern = /<td\b[^>]*>([\s\S]*?)<\/td>/giu;
  let match: RegExpExecArray | null;
  while ((match = tdPattern.exec(decoded)) !== null) {
    const inner = match[1] ?? "";
    const dayMatch = /<span\b[^>]*class="[^"]*thisMonth[^"]*"[^>]*>\s*(\d{1,2})\s*<\/span>/iu.exec(inner);
    if (!dayMatch) continue;
    const anchor = /<a\b[^>]*href=(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a>/iu.exec(inner);
    const link = anchor?.[2]?.replace(/&amp;/gu, "&").trim() ?? "";
    const symbol = anchor ? stripTags(anchor[3] ?? "") : stripTags(inner.replace(dayMatch[0], ""));
    const isVacant = /[○◯]/u.test(symbol) || /\d/u.test(symbol);
    const isFull = /[×✕]/u.test(symbol);
    days.push({
      viewDay: dayMatch[1] ?? "",
      epoch: 0,
      stock: 0,
      price: 0,
      priceWithoutTax: 0,
      discountedPrice: 0,
      link,
      vacantCondition: "",
      monthClass: "thisMonth",
      isPast: !anchor && symbol.trim() === "-",
      isFull,
      isVacant: isVacant && !isFull,
      enabled: isVacant && !isFull && link !== ""
    });
  }
  return days;
}

export interface HplanDaySummary {
  availableCount: number;
  soldOutCount: number;
  noPlanCount: number;
  priceText: string;
  enabledDays: HplanDay[];
}

export function summarizeHplanDays(parsed: HplanCalendarParsed): HplanDaySummary {
  const inMonth = parsed.days.filter((d) => d.monthClass === "" || d.monthClass === "thisMonth");
  const enabledDays = parsed.days.filter((d) => d.enabled);
  const availableCount = parsed.days.filter((d) => d.isVacant).length;
  const soldOutCount = inMonth.filter((d) => d.isFull).length;
  const noPlanCount = inMonth.filter((d) => !d.isVacant && !d.isFull).length;
  const pricedDay = parsed.days.find((d) => d.price > 0);
  const priceText = pricedDay ? `${pricedDay.price.toLocaleString("en-US")}円` : "";
  return { availableCount, soldOutCount, noPlanCount, priceText, enabledDays };
}

export function classifyHplanCalendarEndpoint(input: {
  reachable: boolean;
  parsed: HplanCalendarParsed;
  availableLinkCount: number;
}): HplanCalendarClassification {
  if (!input.reachable) return "hplan_calendar_blocked_or_failed";
  const p = input.parsed;
  if (p.responseType === "blocked_or_error") return "hplan_calendar_blocked_or_failed";
  if (p.responseType === "empty" || (!p.ok && p.days.length === 0)) return "hplan_calendar_empty";
  if (p.isEmpty && p.days.length === 0) return "hplan_calendar_empty";
  if (input.availableLinkCount > 0) return "hplan_calendar_with_available_links";
  const anyFull = p.days.some((d) => d.isFull);
  const anyVacant = p.days.some((d) => d.isVacant);
  if (anyFull && !anyVacant) return "hplan_calendar_sold_out_or_no_plan";
  if (p.days.length > 0) return "hplan_calendar_no_available_dates";
  return "hplan_calendar_basis_unverified";
}

export function classifyHplanDayLink(input: {
  reachable: boolean;
  conditionPageReached: boolean;
  noMatchingRoomType: boolean;
  evidence: RakutenIframeEvidence;
}): HplanDayLinkClassification {
  if (!input.reachable) return "hplan_day_link_navigation_failed";
  const e = input.evidence;
  if (input.noMatchingRoomType || e.soldOutOrNoPlanDetected) return "hplan_day_link_no_plan_or_sold_out";
  if (
    e.propertyDetected &&
    e.dateScopeDetected &&
    e.adultCountDetected &&
    e.roomCountDetected &&
    e.nightCountDetected &&
    e.taxIncludedTotalDetected &&
    e.availabilityStatus === "available"
  ) {
    return "hplan_day_link_total_found";
  }
  if (e.propertyDetected && e.perPersonPriceDetected && !e.taxIncludedTotalDetected) {
    return "hplan_day_link_per_person_found";
  }
  if (input.conditionPageReached) return "hplan_day_link_condition_page_reached";
  return "hplan_day_link_basis_unverified";
}

export function decideRakutenHplanFeasibility(input: {
  endpointClassifications: HplanCalendarClassification[];
  followedClassifications: HplanDayLinkClassification[];
}): RakutenHplanDecision {
  if (input.followedClassifications.includes("hplan_day_link_total_found")) {
    return "rakuten_hplan_ready";
  }
  const usefulFollow = input.followedClassifications.some(
    (c) =>
      c === "hplan_day_link_condition_page_reached" ||
      c === "hplan_day_link_per_person_found" ||
      c === "hplan_day_link_no_plan_or_sold_out" ||
      c === "hplan_day_link_basis_unverified"
  );
  if (input.endpointClassifications.includes("hplan_calendar_with_available_links") || usefulFollow) {
    return "rakuten_hplan_basis_mapping_needed";
  }
  if (
    input.endpointClassifications.some(
      (c) => c === "hplan_calendar_no_available_dates" || c === "hplan_calendar_sold_out_or_no_plan"
    )
  ) {
    return "rakuten_hplan_no_available_dates";
  }
  return "rakuten_hplan_not_ready";
}

export function renderRakutenHplanCsv(rows: RakutenHplanProbeRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.fSyu,
      row.monthAnchor,
      row.endpointUrl,
      yn(row.reachable),
      row.responseType,
      String(row.availableDayLinksCount),
      String(row.soldOutDayCount),
      String(row.noPlanDayCount),
      row.priceTextDetected,
      row.classification,
      String(row.followedLinksCount),
      row.bestFollowedClassification,
      row.riskNote,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [RAKUTEN_HPLAN_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenHplanReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  liveFSyu: string;
  rows: RakutenHplanProbeRow[];
  decision: RakutenHplanDecision;
  executionNote: string;
}): string {
  const counts = new Map<HplanCalendarClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  const totalFollowed = input.rows.reduce((acc, r) => acc + r.followedLinksCount, 0);

  return [
    "# Rakuten /hplan/calendar/ Endpoint Probe (Phase 61X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- endpoint_urls_tested=${input.rows.length}`,
    `- f_syu=${input.liveFSyu || "zaobase"}`,
    `- followed_links_total=${totalFollowed}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "- Goal: determine whether the public /hplan/calendar/ feed (surfaced by the rendered calendar DOM) returns usable day-level availability / link / price data for ZAO BASE / 197787.",
    "",
    "## 2. Endpoint URLs tested",
    "",
    ...input.rows.map((r) => `- ${r.monthAnchor}: ${r.endpointUrl}`),
    "",
    "## 3. Response types",
    "",
    ...input.rows.map((r) => `- ${r.monthAnchor}: reachable=${yn(r.reachable)}, response_type=${r.responseType}, classification=${r.classification}`),
    "",
    "## 4. Parsed day links",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.monthAnchor}: available=${r.availableDayLinksCount}, sold_out=${r.soldOutDayCount}, no_plan=${r.noPlanDayCount}, price=${r.priceTextDetected || "none"}`
    ),
    "",
    "## 5. Followed links",
    "",
    ...input.rows.map(
      (r) => `- ${r.monthAnchor}: followed=${r.followedLinksCount}, best=${r.bestFollowedClassification || "n/a"}`
    ),
    "",
    "## 6. Classification counts",
    "",
    `- ${JSON.stringify(Object.fromEntries(counts))}`,
    "",
    "## 7. Price / date / basis findings",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.monthAnchor}: price_text=${r.priceTextDetected || "none"}, available_day_links=${r.availableDayLinksCount}`
    ),
    "",
    "## 8. Feasibility decision",
    "",
    `- ${input.decision}`,
    "",
    "## 9. Risk notes",
    "",
    ...input.rows.map((r) => `- ${r.monthAnchor}: ${r.riskNote}`),
    "",
    "## 10. Debug artifact paths",
    "",
    `- ${input.debugRootPath}`,
    ...input.rows.map((r) => `- ${r.debugArtifactPath}`),
    "",
    "## 11. Safety confirmation",
    "",
    "- Public rendered pages + the public /hplan/calendar/ JSONP feed surfaced in the rendered DOM; no login, no cookies beyond the public session, no CAPTCHA bypass, no stealth, no paid APIs, no proxies, no private/internal APIs.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 12. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: RakutenHplanDecision): string {
  if (decision === "rakuten_hplan_ready") {
    return "- A followed day link exposed a date-scoped 2-adult/1-room/1-night tax-included total; the /hplan/calendar/ feed plus its day link is a viable collector entry point — gate a tiny read-only collector prototype behind explicit review.";
  }
  if (decision === "rakuten_hplan_basis_mapping_needed") {
    return "- The /hplan/calendar/ feed returns usable day-level data (price/link/stock fields parse cleanly); map the dayList.price (tax-inclusive when isTaxExclusive=false) + dayList.link → condition-page total selectors before any DB-writing collector.";
  }
  if (decision === "rakuten_hplan_no_available_dates") {
    return "- The /hplan/calendar/ feed is reachable and returns a clean structured dayList, but for this f_syu room type every probed month had no vacant day (all isPast/non-vacant). Re-probe on a property/room type with known Rakuten vacancy to confirm the dayList.price/link populate, then map the price basis.";
  }
  return "- The /hplan/calendar/ endpoint was blocked/empty/unparseable; re-capture the live widget's exact JSONP request (params + headers) under human review before proceeding.";
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim();
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

import type { HplanCalendarParsed, HplanDay } from "./rakutenCorrectedHplanUrlProbe";

export const RAKUTEN_LIMITED_COLLECTOR_SOURCE_PRICE_BASIS = "per_person_tax_included_unconfirmed_total" as const;
export const RAKUTEN_LIMITED_COLLECTOR_BASIS_CONFIDENCE = "B" as const;
export const RAKUTEN_LIMITED_COLLECTOR_STAGE = "prototype_read_only" as const;
export const RAKUTEN_LIMITED_COLLECTOR_BASIS_NOTE =
  "isTaxExclusive=false and CHARGE_PER_HUMAN confirmed; final 2-adult total page not visible without reservation-adjacent transition";

export type RakutenPrototypeDayClassification =
  | "rakuten_day_available_price_link"
  | "rakuten_day_available_price_no_link"
  | "rakuten_day_available_no_price"
  | "rakuten_day_full"
  | "rakuten_day_past"
  | "rakuten_day_no_plan"
  | "rakuten_day_basis_uncertain"
  | "rakuten_day_unexpected";

export type RakutenPrototypeRequestClassification =
  | "rakuten_request_positive"
  | "rakuten_request_all_full"
  | "rakuten_request_empty"
  | "rakuten_request_http_error"
  | "rakuten_request_jsonp_parse_error"
  | "rakuten_request_basis_unexpected";

export type RakutenLimitedCollectorPrototypeDecision =
  | "rakuten_limited_collector_prototype_ready"
  | "rakuten_limited_collector_prototype_basis_caution"
  | "rakuten_limited_collector_prototype_not_ready";

export interface RakutenPrototypeRequestTarget {
  propertyName: string;
  hotelNo: string;
  fSyu: string;
  fCampId: string;
  monthAnchor: string; // YYYYMMDD
}

export interface RakutenPrototypeDayRow {
  runId: string;
  collectedAtJst: string;
  source: "rakuten";
  propertyName: string;
  hotelNo: string;
  fSyu: string;
  fCampId: string;
  monthAnchor: string;
  viewDate: string;
  viewDay: string;
  dateIso: string;
  dayOfWeek: string;
  isPast: boolean;
  isFull: boolean;
  isVacant: boolean;
  vacantCondition: string;
  stock: number;
  rawPrice: number;
  priceWithoutTax: number;
  discountedPrice: number;
  isTaxExclusive: boolean;
  chargeType: string;
  sourcePriceBasis: typeof RAKUTEN_LIMITED_COLLECTOR_SOURCE_PRICE_BASIS;
  basisConfidence: typeof RAKUTEN_LIMITED_COLLECTOR_BASIS_CONFIDENCE;
  basisNote: string;
  computed2AdultTotal: number | null;
  linkPresent: boolean;
  classification: RakutenPrototypeDayClassification;
  collectorStage: typeof RAKUTEN_LIMITED_COLLECTOR_STAGE;
  debugArtifactPath: string;
}

export interface RakutenPrototypeRequestSummary {
  propertyName: string;
  hotelNo: string;
  fSyu: string;
  fCampId: string;
  monthAnchor: string;
  httpStatus: number;
  responseType: string;
  viewDate: string;
  isEmpty: boolean;
  isTaxExclusive: boolean;
  chargeType: string;
  dayListLength: number;
  availablePriceLinkCount: number;
  availableCount: number;
  fullCount: number;
  noPlanCount: number;
  pastCount: number;
  classification: RakutenPrototypeRequestClassification;
  debugArtifactPath: string;
}

export interface RakutenLimitedCollectorPrototypeSummary {
  runId: string;
  collectedAtJst: string;
  requestCount: number;
  dayRowCount: number;
  requestCountsByClassification: Record<string, number>;
  dayCountsByClassification: Record<string, number>;
  availableCount: number;
  fullCount: number;
  noPlanCount: number;
  positivePriceLinkCount: number;
  decision: RakutenLimitedCollectorPrototypeDecision;
}

export const RAKUTEN_LIMITED_COLLECTOR_CSV_HEADERS = [
  "run_id",
  "collected_at_jst",
  "source",
  "property_name",
  "hotel_no",
  "f_syu",
  "f_camp_id",
  "month_anchor",
  "view_date",
  "view_day",
  "date_iso",
  "day_of_week",
  "is_past",
  "is_full",
  "is_vacant",
  "vacant_condition",
  "stock",
  "raw_price",
  "price_without_tax",
  "discounted_price",
  "is_tax_exclusive",
  "charge_type",
  "source_price_basis",
  "basis_confidence",
  "basis_note",
  "computed_2_adult_total",
  "link_present",
  "classification",
  "collector_stage",
  "debug_artifact_path"
] as const;

export function classifyRakutenPrototypeDay(day: HplanDay): RakutenPrototypeDayClassification {
  if (day.isPast) return "rakuten_day_past";
  if (day.isFull) return "rakuten_day_full";
  if (day.isVacant && day.price > 0 && day.link.trim() !== "") return "rakuten_day_available_price_link";
  if (day.isVacant && day.price > 0) return "rakuten_day_available_price_no_link";
  if (day.isVacant) return "rakuten_day_available_no_price";
  if (day.price > 0) return "rakuten_day_basis_uncertain";
  if (day.viewDay.trim() !== "") return "rakuten_day_no_plan";
  return "rakuten_day_unexpected";
}

export function classifyRakutenPrototypeRequest(input: {
  httpStatus: number;
  parsed: HplanCalendarParsed | null;
  dayRows?: RakutenPrototypeDayRow[];
}): RakutenPrototypeRequestClassification {
  if (input.httpStatus === 0 || input.httpStatus >= 400) return "rakuten_request_http_error";
  const parsed = input.parsed;
  if (parsed === null || (!parsed.ok && parsed.days.length === 0)) return "rakuten_request_jsonp_parse_error";
  if (parsed.isEmpty || parsed.days.length === 0) return "rakuten_request_empty";

  const dayRows = input.dayRows ?? [];
  if (
    parsed.days.some((d) => d.price > 0) &&
    (parsed.isTaxExclusive !== false || parsed.chargeType !== "CHARGE_PER_HUMAN")
  ) {
    return "rakuten_request_basis_unexpected";
  }
  if (dayRows.some((r) => r.classification === "rakuten_day_available_price_link")) {
    return "rakuten_request_positive";
  }
  if (parsed.days.length > 0 && parsed.days.every((d) => d.isFull || d.isPast || !d.isVacant)) {
    return "rakuten_request_all_full";
  }
  return "rakuten_request_empty";
}

export function mapHplanDayToPrototypeRow(input: {
  runId: string;
  collectedAtJst: string;
  target: RakutenPrototypeRequestTarget;
  parsed: HplanCalendarParsed;
  day: HplanDay;
  debugArtifactPath: string;
}): RakutenPrototypeDayRow {
  const rawPrice = input.day.price;
  const computed2AdultTotal =
    rawPrice > 0 && input.parsed.chargeType === "CHARGE_PER_HUMAN" ? rawPrice * 2 : null;
  const dateIso = dateIsoFromViewDateAndViewDay(input.parsed.viewDate, input.day.viewDay);
  return {
    runId: input.runId,
    collectedAtJst: input.collectedAtJst,
    source: "rakuten",
    propertyName: input.target.propertyName,
    hotelNo: input.target.hotelNo,
    fSyu: input.target.fSyu,
    fCampId: input.target.fCampId,
    monthAnchor: input.target.monthAnchor,
    viewDate: input.parsed.viewDate,
    viewDay: input.day.viewDay,
    dateIso,
    dayOfWeek: dayOfWeek(dateIso),
    isPast: input.day.isPast,
    isFull: input.day.isFull,
    isVacant: input.day.isVacant,
    vacantCondition: input.day.vacantCondition,
    stock: input.day.stock,
    rawPrice,
    priceWithoutTax: input.day.priceWithoutTax,
    discountedPrice: input.day.discountedPrice,
    isTaxExclusive: input.parsed.isTaxExclusive,
    chargeType: input.parsed.chargeType,
    sourcePriceBasis: RAKUTEN_LIMITED_COLLECTOR_SOURCE_PRICE_BASIS,
    basisConfidence: RAKUTEN_LIMITED_COLLECTOR_BASIS_CONFIDENCE,
    basisNote: RAKUTEN_LIMITED_COLLECTOR_BASIS_NOTE,
    computed2AdultTotal,
    linkPresent: input.day.link.trim() !== "",
    classification: classifyRakutenPrototypeDay(input.day),
    collectorStage: RAKUTEN_LIMITED_COLLECTOR_STAGE,
    debugArtifactPath: input.debugArtifactPath
  };
}

export function buildRakutenPrototypeRequestSummary(input: {
  target: RakutenPrototypeRequestTarget;
  httpStatus: number;
  parsed: HplanCalendarParsed | null;
  dayRows: RakutenPrototypeDayRow[];
  debugArtifactPath: string;
}): RakutenPrototypeRequestSummary {
  const rows = input.dayRows;
  return {
    propertyName: input.target.propertyName,
    hotelNo: input.target.hotelNo,
    fSyu: input.target.fSyu,
    fCampId: input.target.fCampId,
    monthAnchor: input.target.monthAnchor,
    httpStatus: input.httpStatus,
    responseType: input.parsed?.responseType ?? "parse_error",
    viewDate: input.parsed?.viewDate ?? "",
    isEmpty: input.parsed?.isEmpty ?? true,
    isTaxExclusive: input.parsed?.isTaxExclusive ?? false,
    chargeType: input.parsed?.chargeType ?? "",
    dayListLength: input.parsed?.days.length ?? 0,
    availablePriceLinkCount: rows.filter((r) => r.classification === "rakuten_day_available_price_link").length,
    availableCount: rows.filter((r) => r.isVacant).length,
    fullCount: rows.filter((r) => r.isFull).length,
    noPlanCount: rows.filter((r) => r.classification === "rakuten_day_no_plan").length,
    pastCount: rows.filter((r) => r.isPast).length,
    classification: classifyRakutenPrototypeRequest({
      httpStatus: input.httpStatus,
      parsed: input.parsed,
      dayRows: rows
    }),
    debugArtifactPath: input.debugArtifactPath
  };
}

export function decideRakutenLimitedCollectorPrototype(input: {
  requestSummaries: RakutenPrototypeRequestSummary[];
  dayRows: RakutenPrototypeDayRow[];
  basisConfidence?: string;
}): RakutenLimitedCollectorPrototypeDecision {
  const hasPositive = input.dayRows.some((r) => r.classification === "rakuten_day_available_price_link");
  if (!hasPositive) return "rakuten_limited_collector_prototype_not_ready";
  if (input.basisConfidence === "A") return "rakuten_limited_collector_prototype_ready";
  return "rakuten_limited_collector_prototype_basis_caution";
}

export function buildRakutenLimitedCollectorPrototypeSummary(input: {
  runId: string;
  collectedAtJst: string;
  requestSummaries: RakutenPrototypeRequestSummary[];
  dayRows: RakutenPrototypeDayRow[];
  decision: RakutenLimitedCollectorPrototypeDecision;
}): RakutenLimitedCollectorPrototypeSummary {
  return {
    runId: input.runId,
    collectedAtJst: input.collectedAtJst,
    requestCount: input.requestSummaries.length,
    dayRowCount: input.dayRows.length,
    requestCountsByClassification: countBy(input.requestSummaries.map((r) => r.classification)),
    dayCountsByClassification: countBy(input.dayRows.map((r) => r.classification)),
    availableCount: input.dayRows.filter((r) => r.isVacant).length,
    fullCount: input.dayRows.filter((r) => r.isFull).length,
    noPlanCount: input.dayRows.filter((r) => r.classification === "rakuten_day_no_plan").length,
    positivePriceLinkCount: input.dayRows.filter((r) => r.classification === "rakuten_day_available_price_link").length,
    decision: input.decision
  };
}

export function renderRakutenLimitedCollectorPrototypeCsv(rows: RakutenPrototypeDayRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.collectedAtJst,
      row.source,
      row.propertyName,
      row.hotelNo,
      row.fSyu,
      row.fCampId,
      row.monthAnchor,
      row.viewDate,
      row.viewDay,
      row.dateIso,
      row.dayOfWeek,
      bool(row.isPast),
      bool(row.isFull),
      bool(row.isVacant),
      row.vacantCondition,
      String(row.stock),
      String(row.rawPrice),
      String(row.priceWithoutTax),
      String(row.discountedPrice),
      bool(row.isTaxExclusive),
      row.chargeType,
      row.sourcePriceBasis,
      row.basisConfidence,
      row.basisNote,
      row.computed2AdultTotal === null ? "" : String(row.computed2AdultTotal),
      bool(row.linkPresent),
      row.classification,
      row.collectorStage,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [RAKUTEN_LIMITED_COLLECTOR_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenLimitedCollectorPrototypeReport(input: {
  generatedAt: string;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
  targets: RakutenPrototypeRequestTarget[];
  requestSummaries: RakutenPrototypeRequestSummary[];
  dayRows: RakutenPrototypeDayRow[];
  summary: RakutenLimitedCollectorPrototypeSummary;
}): string {
  const sampleRows = input.dayRows
    .filter((r) => r.classification === "rakuten_day_available_price_link")
    .slice(0, 5);
  return [
    "# Rakuten Limited Collector Prototype (Phase 66X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.summary.decision}`,
    `- request_count=${input.summary.requestCount}`,
    `- day_row_count=${input.summary.dayRowCount}`,
    `- positive_price_link_count=${input.summary.positivePriceLinkCount}`,
    `- request_classification_counts=${JSON.stringify(input.summary.requestCountsByClassification)}`,
    `- day_classification_counts=${JSON.stringify(input.summary.dayCountsByClassification)}`,
    "",
    "## 2. Matrix tested",
    "",
    ...input.targets.map((t) => `- ${t.propertyName} hotelNo=${t.hotelNo}, f_syu=${t.fSyu}, f_camp_id=${t.fCampId}, month_anchor=${t.monthAnchor}`),
    "",
    "## 3. Request-level results",
    "",
    ...input.requestSummaries.map(
      (r) =>
        `- ${r.propertyName} ${r.monthAnchor}: status=${r.httpStatus}, response=${r.responseType}, days=${r.dayListLength}, available=${r.availableCount}, full=${r.fullCount}, no_plan=${r.noPlanCount}, positive=${r.availablePriceLinkCount}, class=${r.classification}`
    ),
    "",
    "## 4. Day-level counts",
    "",
    `- available_count=${input.summary.availableCount}`,
    `- full_count=${input.summary.fullCount}`,
    `- no_plan_count=${input.summary.noPlanCount}`,
    `- positive_price_link_count=${input.summary.positivePriceLinkCount}`,
    "",
    "## 5. Price basis handling",
    "",
    `- source_price_basis=${RAKUTEN_LIMITED_COLLECTOR_SOURCE_PRICE_BASIS}`,
    `- basis_confidence=${RAKUTEN_LIMITED_COLLECTOR_BASIS_CONFIDENCE}`,
    `- basis_note=${RAKUTEN_LIMITED_COLLECTOR_BASIS_NOTE}`,
    "- computed_2_adult_total is raw_price * 2 only when raw_price > 0 and chargeType=CHARGE_PER_HUMAN.",
    "- This prototype does not claim confirmed 2-adult total basis. Phase 65Y left final total basis unconfirmed because the next price-visible transition was reservation-adjacent.",
    "",
    "## 6. Sample positive rows",
    "",
    ...(sampleRows.length > 0
      ? sampleRows.map(
          (r) =>
            `- ${r.propertyName} ${r.dateIso}: raw_price=${r.rawPrice}, computed_2_adult_total=${r.computed2AdultTotal ?? "n/a"}, stock=${r.stock}, link_present=${bool(r.linkPresent)}, class=${r.classification}`
        )
      : ["- none"]),
    "",
    "## 7. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 8. Safety confirmation",
    "",
    "- Read-only prototype using at most four public /hplan/calendar/ JSONP endpoint requests.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No reservation-adjacent condition links followed.",
    "- No login, no session cookie injection, no stealth, no CAPTCHA bypass, no paid proxy/API.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 9. Recommended next action",
    "",
    "- If this prototype has positive day rows, proceed to Booking.com Phase B01X as requested: fixed slug URLs, rendered DOM probe, 3 properties x 2 dates, no DB writes.",
    ""
  ].join("\n");
}

export function dateIsoFromViewDateAndViewDay(viewDate: string, viewDay: string): string {
  const ym = /(\d{4})\D+(\d{1,2})/u.exec(viewDate);
  if (!ym) return "";
  let year = Number(ym[1]);
  let month = Number(ym[2]);
  let dayText = viewDay.trim();
  const slash = /^(\d{1,2})\/(\d{1,2})$/u.exec(dayText);
  if (slash) {
    const explicitMonth = Number(slash[1]);
    dayText = slash[2] ?? "";
    if (explicitMonth === 12 && month === 1) year -= 1;
    if (explicitMonth === 1 && month === 12) year += 1;
    month = explicitMonth;
  }
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || day < 1) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dayOfWeek(dateIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateIso)) return "";
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] ?? "";
}

export function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

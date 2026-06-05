/**
 * Rakuten vacancy-calendar UI interaction probe (Phase 55X).
 *
 * Pure, network-free helpers + renderers for a feasibility probe that drives the
 * VISIBLE public 空室カレンダー (vacancy calendar) widget on a Rakuten plan-list
 * page and checks whether interacting with it exposes a date-scoped
 * 2-adult / 1-room / 1-night tax-included TOTAL with property identity and
 * availability state — using only the public rendered UI (no login, no proxy,
 * no CAPTCHA bypass, no stealth, no private/internal API).
 *
 * This module performs NO network calls and NO database writes. The Playwright
 * interaction lives in src/scripts/probeRakutenCalendarUi.ts.
 */
export { extractRakutenHotelNo } from "./enrichZaoMissingSourceCandidates";

export type RakutenCalendarUiClassification =
  | "date_scoped_total_found"
  | "date_scoped_per_person_found"
  | "calendar_visible_but_date_click_failed"
  | "calendar_visible_no_price"
  | "calendar_not_found"
  | "sold_out_or_no_plan"
  | "basis_unverified"
  | "blocked_or_failed";

export type RakutenCalendarUiDecision =
  | "limited_rendered_collector_ready"
  | "manual_selector_mapping_needed"
  | "not_ready";

const CALENDAR_PATTERN = /(空室カレンダー|料金カレンダー|空室照会|カレンダーから探す|カレンダー)/u;
const TOTAL_TAX_PATTERN = /(合計\s*[（(]税込[)）]|総額\s*[（(]税込[)）]|2名合計|2名で[^。\n]{0,24}税込|お支払い総額)/u;
const PER_PERSON_PATTERN = /([0-9,]+\s*円\s*[／/]\s*人|1名あたり|お一人様|大人1名|[0-9]名利用時)/u;
const PRICE_NEAR_PATTERN = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u;
const SOLD_OUT_PATTERN = /(満室|空室なし|予約受付を終了|プランがありません|該当するプランがありません)/u;

/** Parse the first plausible JPY amount; NFKC folds full-width digits/commas. */
export function normalizeRakutenRenderedPrice(text: string): number | null {
  const normalized = text.normalize("NFKC");
  const match = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,})/u.exec(normalized);
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw.replace(/,/gu, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** True when the rendered text/HTML mentions a vacancy/price calendar widget. */
export function detectCalendarPresence(textOrHtml: string): boolean {
  return CALENDAR_PATTERN.test(textOrHtml.normalize("NFKC"));
}

/**
 * Extract distinct visible calendar-related button/link labels from rendered
 * text or HTML. Returns deduplicated labels in first-seen order (e.g.
 * "空室カレンダー", "料金カレンダー").
 */
export function extractCalendarLinksOrButtons(textOrHtml: string): string[] {
  const normalized = textOrHtml.normalize("NFKC");
  const labels = ["空室カレンダー", "料金カレンダー", "空室照会", "カレンダーから探す"];
  const found: string[] = [];
  for (const label of labels) {
    if (normalized.includes(label) && !found.includes(label)) {
      found.push(label);
    }
  }
  return found;
}

export interface DateScopedTotalEvidence {
  dateScopeFound: boolean;
  adultsFound: boolean;
  roomsFound: boolean;
  nightsFound: boolean;
  totalFound: boolean;
  totalText?: string;
  totalValue?: number;
  perPersonFound: boolean;
  perPersonText?: string;
}

/**
 * Inspect rendered text for date-scoped 2-adult / 1-room / 1-night tax-included
 * total evidence. A "total" is only credited when an explicit 合計（税込）/
 * 2名合計 / お支払い総額 label sits next to a JPY amount.
 */
export function detectDateScopedTotalEvidence(input: { text: string; stayDate: string }): DateScopedTotalEvidence {
  const text = input.text.normalize("NFKC");

  const dateScopeFound = hasDateScope(text, input.stayDate);
  const adultsFound = /(大人\s*2\s*名|2\s*名|2\s*人|大人2)/u.test(text);
  const roomsFound = /(1\s*室|1\s*部屋)/u.test(text);
  const nightsFound = /(1\s*泊|1\s*日間|1\s*night)/iu.test(text);

  let totalFound = false;
  let totalText: string | undefined;
  let totalValue: number | undefined;
  const totalMatch = TOTAL_TAX_PATTERN.exec(text);
  if (totalMatch && totalMatch.index !== undefined) {
    const window = text.slice(totalMatch.index, totalMatch.index + 140);
    const priceMatch = PRICE_NEAR_PATTERN.exec(window);
    if (priceMatch?.[0] !== undefined) {
      totalFound = true;
      totalText = priceMatch[0];
      const value = normalizeRakutenRenderedPrice(priceMatch[0]);
      if (value !== null) {
        totalValue = value;
      }
    }
  }

  let perPersonFound = false;
  let perPersonText: string | undefined;
  const perPersonMatch = PER_PERSON_PATTERN.exec(text);
  if (perPersonMatch?.[0] !== undefined) {
    perPersonFound = true;
    perPersonText = perPersonMatch[0];
  }

  return {
    dateScopeFound,
    adultsFound,
    roomsFound,
    nightsFound,
    totalFound,
    ...(totalText !== undefined ? { totalText } : {}),
    ...(totalValue !== undefined ? { totalValue } : {}),
    perPersonFound,
    ...(perPersonText !== undefined ? { perPersonText } : {})
  };
}

function hasDateScope(text: string, stayDate: string): boolean {
  const [year, month, day] = stayDate.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const jp = `${year}年${Number(month)}月${Number(day)}日`;
  const jpShort = `${Number(month)}月${Number(day)}日`;
  return text.includes(stayDate) || text.includes(jp) || text.includes(jpShort);
}

export function detectSoldOutOrNoPlan(text: string): boolean {
  return SOLD_OUT_PATTERN.test(text.normalize("NFKC"));
}

export interface RakutenCalendarUiSignals {
  reachable: boolean;
  accessIssue: boolean;
  soldOutOrNoPlan: boolean;
  calendarVisible: boolean;
  calendarClicked: boolean;
  dateClickAttempted: boolean;
  dateClickSucceeded: boolean;
  dateScopeDetected: boolean;
  totalFound: boolean;
  perPersonFound: boolean;
}

/**
 * Pure classification, never throws. Precedence:
 *   1. access failure / not loaded        → blocked_or_failed
 *   2. explicit sold-out / no-plan         → sold_out_or_no_plan
 *   3. no calendar widget at all           → calendar_not_found
 *   4. date scope + tax-included total     → date_scoped_total_found
 *   5. date scope + per-person only        → date_scoped_per_person_found
 *   6. could not complete a date click     → calendar_visible_but_date_click_failed
 *   7. date click but no price surfaced    → calendar_visible_no_price
 *   8. otherwise                           → basis_unverified
 */
export function classifyCalendarUiProbe(signals: RakutenCalendarUiSignals): RakutenCalendarUiClassification {
  if (!signals.reachable || signals.accessIssue) {
    return "blocked_or_failed";
  }
  if (signals.soldOutOrNoPlan) {
    return "sold_out_or_no_plan";
  }
  if (!signals.calendarVisible) {
    return "calendar_not_found";
  }
  if (signals.dateScopeDetected && signals.totalFound) {
    return "date_scoped_total_found";
  }
  if (signals.dateScopeDetected && signals.perPersonFound) {
    return "date_scoped_per_person_found";
  }
  if (!signals.dateClickSucceeded) {
    return "calendar_visible_but_date_click_failed";
  }
  if (!signals.totalFound && !signals.perPersonFound) {
    return "calendar_visible_no_price";
  }
  return "basis_unverified";
}

export function decideCalendarUiFeasibility(
  classifications: RakutenCalendarUiClassification[]
): RakutenCalendarUiDecision {
  if (classifications.includes("date_scoped_total_found")) {
    return "limited_rendered_collector_ready";
  }
  const calendarReached = classifications.some((c) =>
    c === "date_scoped_per_person_found" ||
    c === "calendar_visible_but_date_click_failed" ||
    c === "calendar_visible_no_price" ||
    c === "basis_unverified"
  );
  return calendarReached ? "manual_selector_mapping_needed" : "not_ready";
}

export const RAKUTEN_CALENDAR_UI_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "stay_date",
  "start_url",
  "calendar_visible",
  "calendar_clicked",
  "date_click_attempted",
  "date_scope_detected",
  "room_count_detected",
  "adult_count_detected",
  "night_count_detected",
  "tax_included_total_detected",
  "availability_status",
  "classification",
  "risk_note",
  "debug_artifact_path"
] as const;

export type RakutenCalendarUiCsvHeader = (typeof RAKUTEN_CALENDAR_UI_CSV_HEADERS)[number];

export interface RakutenCalendarUiProbeRow {
  canonicalPropertyName: string;
  hotelNo: string;
  stayDate: string;
  startUrl: string;
  calendarVisible: boolean;
  calendarClicked: boolean;
  dateClickAttempted: boolean;
  dateScopeDetected: boolean;
  roomCountDetected: string;
  adultCountDetected: string;
  nightCountDetected: string;
  taxIncludedTotalDetected: string;
  availabilityStatus: string;
  classification: RakutenCalendarUiClassification;
  riskNote: string;
  debugArtifactPath: string;
}

const yn = (value: boolean): string => (value ? "yes" : "no");

export function renderRakutenCalendarUiCsv(rows: RakutenCalendarUiProbeRow[]): string {
  const header = RAKUTEN_CALENDAR_UI_CSV_HEADERS.join(",");
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.stayDate,
      row.startUrl,
      yn(row.calendarVisible),
      yn(row.calendarClicked),
      yn(row.dateClickAttempted),
      yn(row.dateScopeDetected),
      row.roomCountDetected,
      row.adultCountDetected,
      row.nightCountDetected,
      row.taxIncludedTotalDetected,
      row.availabilityStatus,
      row.classification,
      row.riskNote,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header, ...body].join("\n") + "\n";
}

export function renderRakutenCalendarUiReport(input: {
  generatedAt: string;
  csvPath: string;
  priorRenderedProbeReportPath: string;
  debugRootPath: string;
  rows: RakutenCalendarUiProbeRow[];
  decision: RakutenCalendarUiDecision;
  executionNote: string;
}): string {
  const counts = new Map<RakutenCalendarUiClassification, number>();
  for (const row of input.rows) {
    counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  }
  const countLine = (c: RakutenCalendarUiClassification): string => `- ${c}=${counts.get(c) ?? 0}`;

  const probeLines = input.rows.map(
    (row) =>
      `- ${row.canonicalPropertyName} / ${row.hotelNo} / ${row.stayDate}: classification=${row.classification}, calendar_visible=${yn(row.calendarVisible)}, calendar_clicked=${yn(row.calendarClicked)}, date_click=${yn(row.dateClickAttempted)}, date_scope=${yn(row.dateScopeDetected)}, total=${row.taxIncludedTotalDetected || "—"}, availability=${row.availabilityStatus || "—"}`
  );

  return [
    "# Rakuten Vacancy-Calendar UI Interaction Probe (Phase 55X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- feasibility_decision=${input.decision}`,
    "- Goal: drive the VISIBLE public 空室カレンダー widget and check whether it exposes a date-scoped 2-adult / 1-room / 1-night tax-included TOTAL with property identity and availability state.",
    "- Method: public-browser rendering + clicking visible UI only (no login, no paid proxy, no CAPTCHA bypass, no stealth, no private/internal API). No DB writes; no price/availability snapshots.",
    `- Execution: ${input.executionNote}`,
    "",
    "## 2. Inputs used",
    "",
    `- prior_rendered_probe_report=${input.priorRenderedProbeReportPath}`,
    `- calendar_ui_probe_csv=${input.csvPath}`,
    `- debug_artifact_root=${input.debugRootPath}`,
    "",
    "## 3. Probe properties / dates",
    "",
    ...probeLines,
    "",
    "## 4. Classification counts",
    "",
    countLine("date_scoped_total_found"),
    countLine("date_scoped_per_person_found"),
    countLine("calendar_visible_but_date_click_failed"),
    countLine("calendar_visible_no_price"),
    countLine("calendar_not_found"),
    countLine("sold_out_or_no_plan"),
    countLine("basis_unverified"),
    countLine("blocked_or_failed"),
    "",
    "## 5. Calendar interaction findings",
    "",
    "- Each probe opened the public plan-list page, detected the per-occupancy-tier 空室カレンダー links, and attempted to open the calendar for the 2名利用時 (2-adult) tier, then navigate to the target month and click the target date cell.",
    "",
    "## 6. Feasibility decision",
    "",
    `- ${input.decision}`,
    decisionRationale(input.decision),
    "",
    "## 7. Recommended next step",
    "",
    ...recommendedNextStep(input.decision),
    ""
  ].join("\n");
}

function decisionRationale(decision: RakutenCalendarUiDecision): string {
  switch (decision) {
    case "limited_rendered_collector_ready":
      return "- Rationale: at least one property/date reached a date-scoped 2-adult/1-room/1-night tax-included total via the visible calendar UI with stable, observed selectors.";
    case "manual_selector_mapping_needed":
      return "- Rationale: the visible calendar UI path exists and is reachable, but the date cells / total selectors require manual mapping before a collector can reliably extract a date-scoped total.";
    case "not_ready":
      return "- Rationale: the calendar flow did not expose a date-scoped price in the rendered public UI (blocked, no calendar, or no usable result within the allowed constraints).";
  }
}

function recommendedNextStep(decision: RakutenCalendarUiDecision): string[] {
  switch (decision) {
    case "limited_rendered_collector_ready":
      return [
        "- Record the observed calendar/date-cell/total selectors and gate a separate, explicitly-approved read-only rendered collector behind human sign-off.",
        "- Keep DB writes, snapshots, and PMS upload OUT of scope until that collector is approved."
      ];
    case "manual_selector_mapping_needed":
      return [
        "- Open the saved screenshots/DOM excerpts and map the exact calendar-cell and total-price selectors for one property/date by hand.",
        "- Re-run this probe wired with the observed selectors before deciding on a rendered collector. Do not enable any Rakuten price collection until a date-scoped tax-included per-room total is proven extractable within policy."
      ];
    case "not_ready":
      return [
        "- Re-run in a browser-capable environment if execution was blocked; otherwise keep Rakuten as identity-coverage only and continue Jalan as the sole DP price source.",
        "- Do not enable any Rakuten price collection until a date-scoped tax-included per-room total is proven extractable within policy."
      ];
  }
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }
  return value;
}

/**
 * Rakuten vacancy-calendar day-cell link probe (Phase 60X).
 *
 * Phase 59X established that the live room-type token is f_syu=zaobase (the
 * hardcoded zaobase3 was stale) and that f_syu=zaobase renders the genuine month
 * vacancy calendar grid (legend "○：残室 1 以上，×：残室なし", "空室数をクリック
 * …条件設定ページに移動"). The date-scoped 2-adult/1-room/1-night total sits one
 * click deeper — behind the available day-cell / vacancy-count links.
 *
 * This module holds pure helpers + renderers only. No network calls, no DB
 * writes. The Playwright rendering and link-following live in
 * src/scripts/probeRakutenDayLinks.ts.
 */
import {
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  type RakutenIframeEvidence
} from "./rakutenIframeMatrixProbe";

export {
  detectIframeDateScopedTotalEvidence,
  detectNoMatchingRoomType,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  type RakutenIframeEvidence
};

/** One day cell extracted from the rendered month vacancy calendar grid. */
export interface CalendarDayCell {
  /** Visible day-of-month number, e.g. "15". Empty for padding cells. */
  day: string;
  /** Visible vacancy marker / count, e.g. "○", "×", "-", "3". */
  visibleText: string;
  /** Click target href (resolved/normalized), or "" when the cell is not a link. */
  href: string;
  /** onclick attribute when present, or "". */
  onclick: string;
  /** Truncated outerHTML of the cell for debugging. */
  outerHtml: string;
  /** True when the cell is a clickable, available (non "-"/"×") vacancy link. */
  enabled: boolean;
}

export type RakutenDayLinkClassification =
  | "day_link_total_found"
  | "day_link_per_person_found"
  | "day_link_condition_page_reached"
  | "day_link_no_plan_or_sold_out"
  | "day_link_disabled_or_unavailable"
  | "day_link_basis_unverified"
  | "day_link_navigation_failed";

export type RakutenDayLinkDecision =
  | "rakuten_day_link_ready"
  | "rakuten_day_link_basis_mapping_needed"
  | "rakuten_day_link_no_available_dates"
  | "rakuten_day_link_not_ready";

export interface RakutenDayLinkProbeRow {
  canonicalPropertyName: string;
  hotelNo: string;
  liveFSyu: string;
  calendarMonth: string;
  day: string;
  dayLinkVisibleText: string;
  dayLinkHref: string;
  dayLinkOnclick: string;
  dayLinkEnabled: boolean;
  followedUrl: string;
  reachable: boolean;
  dateScopeDetected: boolean;
  roomCountDetected: boolean;
  adultCountDetected: boolean;
  nightCountDetected: boolean;
  taxIncludedTotalDetected: string;
  perPersonPriceDetected: string;
  availabilityStatus: string;
  classification: RakutenDayLinkClassification;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_DAY_LINK_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "live_f_syu",
  "calendar_month",
  "day",
  "day_link_visible_text",
  "day_link_href",
  "day_link_onclick",
  "day_link_enabled",
  "followed_url",
  "reachable",
  "date_scope_detected",
  "room_count_detected",
  "adult_count_detected",
  "night_count_detected",
  "tax_included_total_detected",
  "per_person_price_detected",
  "availability_status",
  "classification",
  "risk_note",
  "debug_artifact_path"
] as const;

const CALENDAR_MONTH_PATTERN = /(\d{4})年\s*0?(\d{1,2})月/u;
const CONDITION_PAGE_PATTERN =
  /(予約条件|条件設定|ご予約条件|宿泊予約|予約手続き|お申し込み|お申込み|宿泊プラン一覧|お部屋・プラン|チェックイン日|宿泊日|ご利用人数|利用人数|ご宿泊条件)/u;

/** Extract the calendar's target month label, e.g. "2026年06月" → "2026-06". */
export function extractCalendarMonth(text: string): string {
  const match = CALENDAR_MONTH_PATTERN.exec(text.normalize("NFKC"));
  if (!match) return "";
  const year = match[1];
  const month = String(Number(match[2])).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * A vacancy marker indicates availability when it is a circle (○/◯) or a
 * non-zero room count — not a blank, dash ("-"/"−"), or cross ("×"/"✕").
 */
export function vacancyIndicatesAvailable(visibleText: string): boolean {
  const t = visibleText.normalize("NFKC").trim();
  if (t === "" || t === "-" || t === "−" || t === "×" || t === "✕" || t === "x") return false;
  if (/[○◯]/u.test(t)) return true;
  const digits = /(\d+)/u.exec(t);
  return digits !== null && Number(digits[1]) > 0;
}

function hasClickTarget(href: string, onclick: string): boolean {
  const h = href.trim();
  const realHref = h !== "" && !/^javascript:/iu.test(h) && h !== "#";
  return realHref || onclick.trim() !== "";
}

/** True when a day cell is a clickable, available vacancy link. */
export function isCalendarDayCellEnabled(cell: {
  visibleText: string;
  href: string;
  onclick: string;
}): boolean {
  return hasClickTarget(cell.href, cell.onclick) && vacancyIndicatesAvailable(cell.visibleText);
}

/**
 * Parse the rendered month vacancy calendar HTML (the `#roomCalendar` table) and
 * return one CalendarDayCell per in-month day. Pure string parsing so it can be
 * unit-tested with sample HTML and used as a fallback to DOM extraction.
 */
export function extractDayLinksFromCalendarHtml(html: string): CalendarDayCell[] {
  const decoded = html.replace(/&amp;/gu, "&");
  const calendarRegion = isolateCalendarRegion(decoded);
  const cells: CalendarDayCell[] = [];
  const tdPattern = /<td\b[^>]*>([\s\S]*?)<\/td>/giu;
  let match: RegExpExecArray | null;
  while ((match = tdPattern.exec(calendarRegion)) !== null) {
    const inner = match[1] ?? "";
    const day = extractThisMonthDay(inner);
    if (day === "") continue; // skip padding / header cells without an in-month day
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/iu.exec(inner);
    let href = "";
    let onclick = "";
    let visibleText: string;
    if (anchor) {
      href = attr(anchor[1] ?? "", "href");
      onclick = attr(anchor[1] ?? "", "onclick");
      visibleText = stripTags(anchor[2] ?? "");
    } else {
      visibleText = vacancyMarkerText(inner);
    }
    const cell: CalendarDayCell = {
      day,
      visibleText,
      href: href ? normalizeCalendarHref(href) : "",
      onclick,
      outerHtml: (match[0] ?? "").slice(0, 600),
      enabled: false
    };
    cell.enabled = isCalendarDayCellEnabled(cell);
    cells.push(cell);
  }
  return cells;
}

function isolateCalendarRegion(html: string): string {
  const idx = html.indexOf('id="roomCalendar"');
  if (idx === -1) return html;
  return html.slice(idx);
}

function extractThisMonthDay(cellInner: string): string {
  const m = /<span\b[^>]*class="[^"]*thisMonth[^"]*"[^>]*>\s*(\d{1,2})\s*<\/span>/iu.exec(cellInner);
  return m?.[1] ?? "";
}

function vacancyMarkerText(cellInner: string): string {
  // Text after stripping the day-number span; collapse to the vacancy marker.
  const withoutDay = cellInner.replace(
    /<span\b[^>]*class="[^"]*(?:thisMonth|lastMonth|nextMonth)[^"]*"[^>]*>[\s\S]*?<\/span>/giu,
    ""
  );
  const text = stripTags(withoutDay);
  return text;
}

export function classifyRakutenDayLink(input: {
  enabled: boolean;
  followed: boolean;
  reachable: boolean;
  conditionPageReached: boolean;
  noMatchingRoomType: boolean;
  evidence: RakutenIframeEvidence;
}): RakutenDayLinkClassification {
  if (!input.enabled || !input.followed) return "day_link_disabled_or_unavailable";
  if (!input.reachable) return "day_link_navigation_failed";
  const e = input.evidence;
  if (input.noMatchingRoomType || e.soldOutOrNoPlanDetected) return "day_link_no_plan_or_sold_out";
  if (
    e.propertyDetected &&
    e.dateScopeDetected &&
    e.adultCountDetected &&
    e.roomCountDetected &&
    e.nightCountDetected &&
    e.taxIncludedTotalDetected &&
    e.availabilityStatus === "available"
  ) {
    return "day_link_total_found";
  }
  if (e.propertyDetected && e.perPersonPriceDetected && !e.taxIncludedTotalDetected) {
    return "day_link_per_person_found";
  }
  if (input.conditionPageReached) return "day_link_condition_page_reached";
  return "day_link_basis_unverified";
}

/** True when the rendered text reaches a reservation condition-setting page. */
export function detectConditionPage(text: string): boolean {
  return CONDITION_PAGE_PATTERN.test(text.normalize("NFKC"));
}

export function decideRakutenDayLinkFeasibility(input: {
  gridRendered: boolean;
  enabledLinkCount: number;
  classifications: RakutenDayLinkClassification[];
}): RakutenDayLinkDecision {
  if (input.classifications.includes("day_link_total_found")) {
    return "rakuten_day_link_ready";
  }
  const usefulEvidence = input.classifications.some(
    (c) =>
      c === "day_link_condition_page_reached" ||
      c === "day_link_per_person_found" ||
      c === "day_link_no_plan_or_sold_out" ||
      c === "day_link_basis_unverified"
  );
  if (usefulEvidence) return "rakuten_day_link_basis_mapping_needed";
  if (input.gridRendered && input.enabledLinkCount === 0) {
    return "rakuten_day_link_no_available_dates";
  }
  return "rakuten_day_link_not_ready";
}

export function renderRakutenDayLinkCsv(rows: RakutenDayLinkProbeRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.liveFSyu,
      row.calendarMonth,
      row.day,
      row.dayLinkVisibleText,
      row.dayLinkHref,
      row.dayLinkOnclick,
      yn(row.dayLinkEnabled),
      row.followedUrl,
      yn(row.reachable),
      yn(row.dateScopeDetected),
      yn(row.roomCountDetected),
      yn(row.adultCountDetected),
      yn(row.nightCountDetected),
      row.taxIncludedTotalDetected,
      row.perPersonPriceDetected,
      row.availabilityStatus,
      row.classification,
      row.riskNote,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [RAKUTEN_DAY_LINK_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenDayLinkReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  liveExtractedHref: string;
  liveSyuValue: string;
  calendarMonth: string;
  gridRendered: boolean;
  allDayCells: CalendarDayCell[];
  rows: RakutenDayLinkProbeRow[];
  decision: RakutenDayLinkDecision;
  executionNote: string;
}): string {
  const counts = new Map<RakutenDayLinkClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  const enabledCells = input.allDayCells.filter((c) => c.enabled);

  return [
    "# Rakuten Vacancy-Calendar Day-Cell Link Probe (Phase 60X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- calendar_month=${input.calendarMonth || "not_found"}`,
    `- grid_rendered=${yn(input.gridRendered)}`,
    `- day_cells_extracted=${input.allDayCells.length}`,
    `- enabled_day_links=${enabledCells.length}`,
    `- followed_link_rows=${input.rows.filter((r) => r.followedUrl !== "").length}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "- Goal: follow available vacancy-calendar day-cell links into the 条件設定ページ and test whether a date-scoped 2-adult/1-room/1-night tax-included total is reachable from the public rendered flow for ZAO BASE / 197787.",
    "",
    "## 2. Live f_syu and calendar grid findings",
    "",
    `- live_extracted_href=${input.liveExtractedHref || "not_found"}`,
    `- live_f_syu=${input.liveSyuValue || "not_found"}`,
    `- calendar_month=${input.calendarMonth || "not_found"}`,
    `- grid_rendered=${yn(input.gridRendered)}`,
    "",
    "## 3. Extracted day links",
    "",
    ...(input.allDayCells.length === 0
      ? ["- (no in-month day cells parsed from the rendered calendar)"]
      : input.allDayCells.map(
          (c) =>
            `- day ${c.day}: visible="${c.visibleText}" enabled=${yn(c.enabled)} href=${c.href || "<none>"}`
        )),
    "",
    "## 4. Links followed",
    "",
    ...(input.rows.filter((r) => r.followedUrl !== "").length === 0
      ? ["- (no enabled/available day links to follow)"]
      : input.rows
          .filter((r) => r.followedUrl !== "")
          .map((r) => `- day ${r.day} → ${r.followedUrl}: ${r.classification}`)),
    "",
    "## 5. Classification counts",
    "",
    `- ${JSON.stringify(Object.fromEntries(counts))}`,
    "",
    "## 6. Date-scope findings",
    "",
    ...input.rows.map((r) => `- day ${r.day || "(none)"}: date_scope=${yn(r.dateScopeDetected)}`),
    "",
    "## 7. Adult/room/night basis findings",
    "",
    ...input.rows.map(
      (r) =>
        `- day ${r.day || "(none)"}: adults=${yn(r.adultCountDetected)}, rooms=${yn(r.roomCountDetected)}, nights=${yn(r.nightCountDetected)}`
    ),
    "",
    "## 8. Tax-included total findings",
    "",
    ...input.rows.map(
      (r) => `- day ${r.day || "(none)"}: total=${r.taxIncludedTotalDetected || "none"}, per_person=${r.perPersonPriceDetected || "none"}`
    ),
    "",
    "## 9. Feasibility decision",
    "",
    `- ${input.decision}`,
    "",
    "## 10. Risk notes",
    "",
    ...input.rows.map((r) => `- day ${r.day || "(none)"}: ${r.riskNote}`),
    "",
    "## 11. Debug artifact paths",
    "",
    `- ${input.debugRootPath}`,
    ...input.rows.filter((r) => r.debugArtifactPath).map((r) => `- ${r.debugArtifactPath}`),
    "",
    "## 12. Safety confirmation",
    "",
    "- Public rendered pages only; no login, no cookies, no CAPTCHA bypass, no stealth, no paid APIs, no proxies, no private/internal APIs.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 13. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: RakutenDayLinkDecision): string {
  if (decision === "rakuten_day_link_ready") {
    return "- A day-cell link exposed a date-scoped 2-adult/1-room/1-night tax-included total; record the followed URL pattern and gate a tiny read-only collector prototype behind explicit review.";
  }
  if (decision === "rakuten_day_link_basis_mapping_needed") {
    return "- A followed day link reached the condition-setting page or useful price/date evidence; map the total/per-person/date selectors on that page (or capture its /hplan/calendar/ AJAX source) before any DB-writing collector.";
  }
  if (decision === "rakuten_day_link_no_available_dates") {
    return "- The vacancy calendar rendered but every day cell was '-'/'×' (no bookable vacancy in the probed month); retry on a month with known availability, or capture the calendar's /hplan/calendar/ AJAX response to confirm the day-cell link shape before mapping.";
  }
  return "- The calendar grid could not be parsed or its day links could not be followed; capture the calendar widget's network/DOM flow (e.g. the /hplan/calendar/ endpoint) under human review before proceeding.";
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu").exec(attrs);
  return m?.[2]?.trim() ?? "";
}

function normalizeCalendarHref(href: string): string {
  const decoded = href.replace(/&amp;/gu, "&").trim();
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("/")) return `https://hotel.travel.rakuten.co.jp${decoded}`;
  return decoded;
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

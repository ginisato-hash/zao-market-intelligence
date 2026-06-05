/**
 * Rakuten corrected reconstructed /hplan/calendar/ URL probe (Phase 64X).
 *
 * Phase 63X captured the live widget's request and proved the Phase 62X all-full
 * result came from our reconstruction (a) wrongly adding f_calendar and (b) omitting
 * f_camp_id (the per-room plan/campaign id) plus the live blank-passthrough params.
 *
 * Inspecting the captured positive requests
 *   .data/debug/rakuten-live-hplan-capture/20260601_191550/5723_click_0/captured_requests.json
 *   .data/debug/rakuten-live-hplan-capture/20260601_191550/39565_click_0/captured_requests.json
 * shows the working request sent f_hak= and f_nen1..f_hi2= as BLANK, with f_s1..f_y4=0,
 * f_camp_id populated, f_syu populated, and NO f_calendar. So the faithful reconstruction
 * (default dateScopeMode="live_blank") leaves those blank; an "explicit" mode populates
 * f_hak=1 and the checkin/checkout date components for callers that want a date-scoped form.
 *
 * Pure helpers + renderers only. No network, no DB writes. The fetch (direct then
 * Playwright browser-context fallback) lives in src/scripts/probeRakutenCorrectedHplanUrl.ts.
 */
import {
  parseHplanCalendarResponse,
  summarizeVacancyDays,
  type HplanCalendarParsed,
  type HplanDay,
  type VacancyDaySummary
} from "./rakutenHplanVacancyProbe";

export { parseHplanCalendarResponse, summarizeVacancyDays, type HplanCalendarParsed, type HplanDay, type VacancyDaySummary };

export const CORRECTED_HPLAN_BASE = "https://hotel.travel.rakuten.co.jp/hplan/calendar/";

export type CorrectedHplanClassification =
  | "corrected_hplan_response_positive"
  | "corrected_hplan_response_all_full"
  | "corrected_hplan_response_empty"
  | "corrected_hplan_http_400"
  | "corrected_hplan_http_error"
  | "corrected_hplan_jsonp_parse_error"
  | "corrected_hplan_basis_unclear"
  | "corrected_hplan_unexpected_error";

export type RakutenCorrectedHplanDecision =
  | "rakuten_corrected_hplan_reconstruction_ready"
  | "rakuten_corrected_hplan_needs_browser_context"
  | "rakuten_corrected_hplan_still_not_ready"
  | "rakuten_corrected_hplan_basis_mapping_needed";

export type DateScopeMode = "live_blank" | "explicit";

export interface CorrectedHplanUrlInput {
  hotelNo: string;
  fSyu: string;
  fCampId: string;
  checkin: string; // YYYY-MM-DD
  nights?: number; // default 1
  dateScopeMode?: DateScopeMode; // default "live_blank" (faithful to the proven-positive live request)
  callback?: string;
  cacheBust?: number;
}

export interface DateComponents {
  checkin: { year: string; month: string; day: string; compact: string };
  checkout: { year: string; month: string; day: string };
}

/** Compute checkin/checkout date components for a stay of `nights` nights. */
export function computeDateComponents(checkin: string, nights = 1): DateComponents {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(checkin)) throw new Error(`checkin must be YYYY-MM-DD: ${checkin}`);
  const [cy, cm, cd] = checkin.split("-").map((n) => Number(n));
  const inDate = new Date(Date.UTC(cy!, cm! - 1, cd!));
  const outDate = new Date(inDate.getTime() + nights * 86_400_000);
  const compact = `${String(cy).padStart(4, "0")}${String(cm).padStart(2, "0")}${String(cd).padStart(2, "0")}`;
  return {
    checkin: { year: String(cy), month: String(cm), day: String(cd), compact },
    checkout: {
      year: String(outDate.getUTCFullYear()),
      month: String(outDate.getUTCMonth() + 1),
      day: String(outDate.getUTCDate())
    }
  };
}

/**
 * Build the corrected /hplan/calendar/ URL. Param order mirrors the captured live
 * request for fidelity. NEVER includes f_calendar. Always includes f_camp_id and the
 * live blank-passthrough params.
 */
export function buildCorrectedHplanUrl(input: CorrectedHplanUrlInput): string {
  if (!/^\d+$/u.test(input.hotelNo)) throw new Error(`invalid hotelNo: ${input.hotelNo}`);
  const nights = input.nights ?? 1;
  const dc = computeDateComponents(input.checkin, nights);
  const explicit = (input.dateScopeMode ?? "live_blank") === "explicit";

  const url = new URL(CORRECTED_HPLAN_BASE);
  const p = url.searchParams;
  p.set("f_no", input.hotelNo);
  p.set("f_teikei", "");
  p.set("f_campaign", "");
  p.set("f_flg", "PLAN");
  p.set("f_hizuke", dc.checkin.compact);
  p.set("f_otona_su", "2");
  p.set("f_s1", "0");
  p.set("f_s2", "0");
  p.set("f_y1", "0");
  p.set("f_y2", "0");
  p.set("f_y3", "0");
  p.set("f_y4", "0");
  p.set("upperPriceLimit", "");
  p.set("f_heya_su", "1");
  p.set("f_hak", explicit ? String(nights) : "");
  p.set("f_tel", "");
  p.set("f_tscm_flg", "");
  p.set("f_nen1", explicit ? dc.checkin.year : "");
  p.set("f_tuki1", explicit ? dc.checkin.month : "");
  p.set("f_hi1", explicit ? dc.checkin.day : "");
  p.set("f_nen2", explicit ? dc.checkout.year : "");
  p.set("f_tuki2", explicit ? dc.checkout.month : "");
  p.set("f_hi2", explicit ? dc.checkout.day : "");
  p.set("f_p_no", "");
  p.set("f_custom_code", "");
  p.set("send", "");
  p.set("f_clip_flg", "");
  p.set("f_thick", "1");
  p.set("f_camp_id", input.fCampId);
  p.set("f_syu", input.fSyu);
  p.set("f_service", "");
  p.set("callback", input.callback ?? "cb");
  p.set("render", "jsonp");
  p.set("_", String(input.cacheBust ?? 0));
  return url.toString();
}

export const buildCorrectedHplanCalendarUrl = buildCorrectedHplanUrl;

/** Strip the JSONP callback token and cache-bust param so reports carry no session-like data. */
export function sanitizeHplanUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("callback");
    u.searchParams.delete("_");
    return u.toString();
  } catch {
    return url;
  }
}

export function classifyCorrectedHplan(input: {
  status: number;
  parsed: HplanCalendarParsed | null;
  networkError?: boolean;
}): CorrectedHplanClassification {
  if (input.networkError) return "corrected_hplan_unexpected_error";
  if (input.status === 400) return "corrected_hplan_http_400";
  if (input.status === 0 || input.status >= 500) return "corrected_hplan_http_error";
  const p = input.parsed;
  if (p === null) return "corrected_hplan_jsonp_parse_error";
  if (p.responseType === "blocked_or_error") return "corrected_hplan_http_error";
  if (p.responseType === "empty" || (p.isEmpty && p.days.length === 0)) return "corrected_hplan_response_empty";
  if (!p.ok && p.days.length === 0) return "corrected_hplan_jsonp_parse_error";
  if (p.days.some((d) => d.isVacant && d.price > 0 && d.link.trim() !== "")) {
    return "corrected_hplan_response_positive";
  }
  if (p.days.length > 0) return "corrected_hplan_response_all_full";
  return "corrected_hplan_basis_unclear";
}

/** A priced response whose tax/charge basis cannot be confirmed needs explicit mapping. */
export function isBasisAmbiguous(parsed: HplanCalendarParsed | null): boolean {
  if (parsed === null || !parsed.ok) return false;
  const hasPrice = parsed.days.some((d) => d.price > 0);
  if (!hasPrice) return false;
  return parsed.chargeType.trim() === "";
}

export function decideRakutenCorrectedHplan(input: {
  classifications: CorrectedHplanClassification[];
  directFetchReachable: boolean;
  browserFetchReachable: boolean;
  anyPriceWithoutBasis: boolean;
}): RakutenCorrectedHplanDecision {
  if (input.classifications.includes("corrected_hplan_response_positive")) {
    return "rakuten_corrected_hplan_reconstruction_ready";
  }
  if (input.anyPriceWithoutBasis) return "rakuten_corrected_hplan_basis_mapping_needed";
  if (input.classifications.includes("corrected_hplan_response_all_full")) {
    return "rakuten_corrected_hplan_still_not_ready";
  }
  if (!input.directFetchReachable && input.browserFetchReachable) {
    return "rakuten_corrected_hplan_needs_browser_context";
  }
  return "rakuten_corrected_hplan_still_not_ready";
}

export interface CorrectedHplanRow {
  canonicalPropertyName: string;
  hotelNo: string;
  fSyu: string;
  fCampId: string;
  targetAnchor: string;
  requestUrlSanitized: string;
  fetchMode: string;
  httpStatus: number;
  responseType: string;
  viewDate: string;
  isEmpty: boolean;
  isTaxExclusive: boolean;
  chargeType: string;
  dayListLength: number;
  vacantDayCount: number;
  pricePositiveCount: number;
  linkPopulatedCount: number;
  samplePrice: number;
  classification: CorrectedHplanClassification;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_CORRECTED_HPLAN_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "f_syu",
  "f_camp_id",
  "target_anchor",
  "request_url_sanitized",
  "fetch_mode",
  "http_status",
  "response_type",
  "view_date",
  "is_empty",
  "is_tax_exclusive",
  "charge_type",
  "day_list_length",
  "vacant_day_count",
  "price_positive_count",
  "link_populated_count",
  "sample_price",
  "classification",
  "risk_note",
  "debug_artifact_path"
] as const;

export function renderCorrectedHplanCsv(rows: CorrectedHplanRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.fSyu,
      row.fCampId,
      row.targetAnchor,
      row.requestUrlSanitized,
      row.fetchMode,
      String(row.httpStatus),
      row.responseType,
      row.viewDate,
      yn(row.isEmpty),
      yn(row.isTaxExclusive),
      row.chargeType,
      String(row.dayListLength),
      String(row.vacantDayCount),
      String(row.pricePositiveCount),
      String(row.linkPopulatedCount),
      String(row.samplePrice),
      row.classification,
      row.riskNote,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [RAKUTEN_CORRECTED_HPLAN_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export interface Phase63Comparison {
  same_host: boolean;
  same_path: boolean;
  params_only_in_phase63_live: string[];
  params_only_in_phase64_corrected: string[];
  params_different_values: { key: string; phase63_live: string; phase64_corrected: string }[];
  positive_count_phase63: number;
  positive_count_phase64: number;
  same_basis_flags: { isTaxExclusive: boolean; chargeType: string };
  notes: string;
}

const NON_CAUSAL_PARAMS = new Set(["callback", "_"]);

export function buildPhase63Comparison(input: {
  phase63LiveUrl: string;
  phase64CorrectedUrl: string;
  positiveCountPhase63: number;
  positiveCountPhase64: number;
  isTaxExclusive: boolean;
  chargeType: string;
}): Phase63Comparison {
  const live = paramMap(input.phase63LiveUrl);
  const corrected = paramMap(input.phase64CorrectedUrl);
  const onlyLive: string[] = [];
  const onlyCorrected: string[] = [];
  const different: { key: string; phase63_live: string; phase64_corrected: string }[] = [];

  for (const [k, v] of live.params.entries()) {
    if (NON_CAUSAL_PARAMS.has(k)) continue;
    if (!corrected.params.has(k)) onlyLive.push(k);
    else if (corrected.params.get(k) !== v) {
      different.push({ key: k, phase63_live: v, phase64_corrected: corrected.params.get(k) ?? "" });
    }
  }
  for (const [k] of corrected.params.entries()) {
    if (NON_CAUSAL_PARAMS.has(k)) continue;
    if (!live.params.has(k)) onlyCorrected.push(k);
  }

  const notesParts: string[] = [];
  if (onlyLive.length === 0 && onlyCorrected.length === 0 && different.length === 0) {
    notesParts.push("Corrected reconstruction matches the live positive request param-for-param (excluding callback/_).");
  } else {
    if (onlyCorrected.includes("f_calendar")) notesParts.push("f_calendar still wrongly present in corrected URL.");
    if (onlyLive.length > 0) notesParts.push(`Corrected URL omits live params: ${onlyLive.join(", ")}.`);
    if (onlyCorrected.length > 0) notesParts.push(`Corrected URL adds params not in live: ${onlyCorrected.join(", ")}.`);
    if (different.length > 0) {
      notesParts.push(`Value mismatches: ${different.map((d) => `${d.key}(live=${d.phase63_live}|corrected=${d.phase64_corrected})`).join(", ")}.`);
    }
  }
  notesParts.push(
    input.positiveCountPhase64 > 0
      ? "Corrected reconstruction reproduced vacancy-positive results."
      : "Corrected reconstruction did NOT reproduce vacancy-positive results."
  );

  return {
    same_host: live.host === corrected.host && live.host !== "",
    same_path: live.path === corrected.path && live.path !== "",
    params_only_in_phase63_live: onlyLive,
    params_only_in_phase64_corrected: onlyCorrected,
    params_different_values: different,
    positive_count_phase63: input.positiveCountPhase63,
    positive_count_phase64: input.positiveCountPhase64,
    same_basis_flags: { isTaxExclusive: input.isTaxExclusive, chargeType: input.chargeType },
    notes: notesParts.join(" ")
  };
}

export function renderCorrectedHplanReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  rows: CorrectedHplanRow[];
  decision: RakutenCorrectedHplanDecision;
  executionNote: string;
  comparison: Phase63Comparison | null;
}): string {
  const counts = new Map<CorrectedHplanClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  const positiveRows = input.rows.filter((r) => r.classification === "corrected_hplan_response_positive");

  const comparisonLines: string[] = [];
  if (input.comparison) {
    const c = input.comparison;
    comparisonLines.push(
      `- same_host=${yn(c.same_host)}, same_path=${yn(c.same_path)}`,
      `- params_only_in_phase63_live=[${c.params_only_in_phase63_live.join(", ") || "none"}]`,
      `- params_only_in_phase64_corrected=[${c.params_only_in_phase64_corrected.join(", ") || "none"}]`,
      `- params_different_values=${c.params_different_values.map((d) => d.key).join(", ") || "none"}`,
      `- positive_count_phase63=${c.positive_count_phase63}, positive_count_phase64=${c.positive_count_phase64}`,
      `- same_basis_flags: isTaxExclusive=${yn(c.same_basis_flags.isTaxExclusive)}, chargeType=${c.same_basis_flags.chargeType || "n/a"}`,
      `- notes: ${c.notes}`
    );
  } else {
    comparisonLines.push("- No comparison available (no corrected request captured a parseable response).");
  }

  return [
    "# Rakuten Corrected Reconstructed /hplan/calendar/ URL Probe (Phase 64X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- targets=${input.rows.length}`,
    `- positive_rows=${positiveRows.length}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "- Goal: reproduce Phase 63X vacancy-positive results from a corrected reconstructed URL (no f_calendar; f_camp_id + live blank-passthrough params added).",
    "",
    "## 2. Corrected param set",
    "",
    "- Removed wrong param: f_calendar (never sent).",
    "- Added: f_camp_id (per-room plan id), f_teikei, f_campaign, upperPriceLimit, f_hak, f_tel, f_tscm_flg, f_nen1, f_tuki1, f_hi1, f_nen2, f_tuki2, f_hi2, f_p_no, f_custom_code, send, f_clip_flg, f_service.",
    "- Core: f_no, f_syu, f_hizuke, f_flg=PLAN, f_otona_su=2, f_heya_su=1, f_s1..f_y4=0, f_thick=1, render=jsonp.",
    "- dateScopeMode=live_blank reproduces the proven-positive live request exactly (f_hak and f_nen1..f_hi2 sent blank, matching the captured request).",
    "",
    "## 3. Targets / results",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.canonicalPropertyName} (${r.hotelNo}/${r.fSyu}/camp=${r.fCampId}) ${r.targetAnchor}: mode=${r.fetchMode}, status=${r.httpStatus}, type=${r.responseType}, vacant=${r.vacantDayCount}, price>0=${r.pricePositiveCount}, links=${r.linkPopulatedCount}, class=${r.classification}`
    ),
    "",
    "## 4. Basis findings",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.hotelNo}/${r.fSyu} ${r.targetAnchor}: isTaxExclusive=${yn(r.isTaxExclusive)}, chargeType=${r.chargeType || "n/a"}, sample_price=${r.samplePrice} (price is tax-inclusive when isTaxExclusive=false)`
    ),
    "",
    "## 5. Phase 63X (live) vs Phase 64X (corrected) comparison",
    "",
    ...comparisonLines,
    "",
    "## 6. Classification counts",
    "",
    `- ${JSON.stringify(Object.fromEntries(counts))}`,
    "",
    "## 7. Feasibility decision",
    "",
    `- ${input.decision}`,
    "",
    "## 8. Sanitized request URLs",
    "",
    ...input.rows.map((r) => `- ${r.hotelNo}/${r.fSyu} ${r.targetAnchor}: ${r.requestUrlSanitized}`),
    "",
    "## 9. Risk notes",
    "",
    ...input.rows.map((r) => `- ${r.hotelNo}/${r.fSyu} ${r.targetAnchor}: ${r.riskNote}`),
    "",
    "## 10. Debug artifact path",
    "",
    `- ${input.debugRootPath}`,
    "",
    "## 11. Safety confirmation",
    "",
    "- Read-only public probe; max 4 reconstructed requests. Browser context (if used) only seeds a public session — no login, no cookie injection, no stealth, no CAPTCHA bypass, no paid proxy/APIs, no private/internal APIs. Sanitized URLs strip the JSONP callback token and cache-bust value; booking links are recorded as presence-only in debug JSON.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 12. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: RakutenCorrectedHplanDecision): string {
  if (decision === "rakuten_corrected_hplan_reconstruction_ready") {
    return "- The corrected reconstructed URL reproduces vacancy-positive day data (price>0 + link, tax-inclusive). Proceed to Phase 65X: follow ONE populated booking/condition link to confirm the date-scoped 2-adult/1-room/1-night tax-included total and map dayList.price basis. Still no DB writes.";
  }
  if (decision === "rakuten_corrected_hplan_needs_browser_context") {
    return "- Direct fetch failed but the Playwright browser context reached the endpoint; the reconstruction works only from same-origin browser context. Keep the browser-context fetch and re-confirm vacancy data, then proceed to link-following.";
  }
  if (decision === "rakuten_corrected_hplan_basis_mapping_needed") {
    return "- Prices are present but the tax/charge basis is ambiguous; map chargeType/isTaxExclusive against a followed condition page before relying on dayList.price.";
  }
  return "- Corrected reconstruction is reachable but still all-full / not positive. Do NOT brute force. Inspect the live request context more narrowly (Referer, Sec-Fetch headers, request initiator, public-page-set cookies, same-page-context requirement) before the next attempt.";
}

function paramMap(url: string): { host: string; path: string; params: Map<string, string> } {
  try {
    const u = new URL(url);
    const params = new Map<string, string>();
    for (const [k, v] of u.searchParams.entries()) params.set(k, v);
    return { host: u.host, path: u.pathname, params };
  } catch {
    return { host: "", path: "", params: new Map() };
  }
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

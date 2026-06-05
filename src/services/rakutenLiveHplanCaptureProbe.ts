/**
 * Rakuten live /hplan/calendar/ network-request capture probe (Phase 63X).
 *
 * Phase 62X reconstructed the /hplan/calendar/ JSONP URL by hand and got 48/48
 * all-full responses (isFull=true, price=0, empty link) across 4 properties — an
 * implausible market-wide sellout that points to a missing/incorrect parameter in
 * our reconstructed request rather than genuine inventory. This phase captures the
 * EXACT request the live Rakuten vacancy-calendar widget emits, then diffs it
 * against our Phase 62X reconstruction to surface the parameter gap.
 *
 * Pure helpers + renderers only. No network, no DB writes. The Playwright capture
 * (network listeners + calendar-link clicks) lives in
 * src/scripts/probeRakutenLiveHplanCapture.ts.
 */
import {
  buildHplanCalendarUrl,
  parseHplanCalendarResponse,
  summarizeVacancyDays,
  type HplanCalendarParsed
} from "./rakutenHplanVacancyProbe";

export {
  buildHplanCalendarUrl,
  parseHplanCalendarResponse,
  summarizeVacancyDays,
  type HplanCalendarParsed
};

export const HPLAN_CALENDAR_PATH = "/hplan/calendar/";

export type LiveHplanClassification =
  | "live_hplan_request_captured"
  | "live_hplan_request_not_emitted"
  | "live_hplan_response_positive"
  | "live_hplan_response_all_full"
  | "live_hplan_response_empty"
  | "live_hplan_response_blocked_or_failed"
  | "calendar_click_no_effect";

export type RakutenLiveHplanDecision =
  | "rakuten_live_hplan_capture_ready"
  | "rakuten_live_hplan_param_gap_identified"
  | "rakuten_live_hplan_no_positive_inventory"
  | "rakuten_live_hplan_not_ready";

export interface ParamDiff {
  hostDiffers: boolean;
  pathDiffers: boolean;
  liveHost: string;
  reconstructedHost: string;
  livePath: string;
  reconstructedPath: string;
  onlyInLive: { key: string; value: string }[];
  onlyInReconstructed: { key: string; value: string }[];
  differentValues: { key: string; live: string; reconstructed: string }[];
  /** Params live sends that we omit + params we send with the wrong value. */
  gapCount: number;
}

export interface RakutenLiveHplanRow {
  canonicalPropertyName: string;
  hotelNo: string;
  clickIndex: number;
  calendarLinkText: string;
  calendarLinkHref: string;
  capturedHplanUrl: string;
  capturedStatus: number;
  capturedResponseType: string;
  liveAvailableDayCount: number;
  livePricePositiveDayCount: number;
  livePopulatedLinkCount: number;
  phase62ParamGapCount: number;
  classification: LiveHplanClassification;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_LIVE_HPLAN_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "click_index",
  "calendar_link_text",
  "calendar_link_href",
  "captured_hplan_url",
  "captured_status",
  "captured_response_type",
  "live_available_day_count",
  "live_price_positive_day_count",
  "live_populated_link_count",
  "phase62_param_gap_count",
  "classification",
  "risk_note",
  "debug_artifact_path"
] as const;

/** True when a URL targets the public /hplan/calendar/ JSONP endpoint. */
export function isHplanCalendarUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes(HPLAN_CALENDAR_PATH);
  } catch {
    return url.includes(HPLAN_CALENDAR_PATH);
  }
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

/**
 * Diff a live captured /hplan/calendar/ URL against our reconstructed URL.
 * gapCount counts params the live widget sends that we omit, plus params we send
 * with a different value — i.e. the candidate cause of the Phase 62X all-full result.
 */
export function computeParamDiff(liveUrl: string, reconstructedUrl: string): ParamDiff {
  const live = paramMap(liveUrl);
  const recon = paramMap(reconstructedUrl);
  const onlyInLive: { key: string; value: string }[] = [];
  const onlyInReconstructed: { key: string; value: string }[] = [];
  const differentValues: { key: string; live: string; reconstructed: string }[] = [];

  for (const [k, v] of live.params.entries()) {
    if (!recon.params.has(k)) {
      onlyInLive.push({ key: k, value: v });
    } else if (recon.params.get(k) !== v) {
      differentValues.push({ key: k, live: v, reconstructed: recon.params.get(k) ?? "" });
    }
  }
  for (const [k, v] of recon.params.entries()) {
    if (!live.params.has(k)) onlyInReconstructed.push({ key: k, value: v });
  }

  return {
    hostDiffers: live.host !== recon.host,
    pathDiffers: live.path !== recon.path,
    liveHost: live.host,
    reconstructedHost: recon.host,
    livePath: live.path,
    reconstructedPath: recon.path,
    onlyInLive,
    onlyInReconstructed,
    differentValues,
    gapCount: onlyInLive.length + differentValues.length
  };
}

export function classifyLiveHplanCapture(input: {
  requestCaptured: boolean;
  clickRegisteredEffect: boolean;
  parsed: HplanCalendarParsed | null;
}): LiveHplanClassification {
  if (!input.requestCaptured) {
    return input.clickRegisteredEffect ? "live_hplan_request_not_emitted" : "calendar_click_no_effect";
  }
  const p = input.parsed;
  if (p === null) return "live_hplan_response_blocked_or_failed";
  if (p.responseType === "blocked_or_error") return "live_hplan_response_blocked_or_failed";
  if (p.responseType === "empty" || (!p.ok && p.days.length === 0)) return "live_hplan_response_empty";
  if (p.isEmpty && p.days.length === 0) return "live_hplan_response_empty";
  if (p.days.some((d) => d.isVacant && d.price > 0 && d.link.trim() !== "")) {
    return "live_hplan_response_positive";
  }
  if (p.days.length > 0) return "live_hplan_response_all_full";
  return "live_hplan_request_captured";
}

export function decideRakutenLiveHplan(input: {
  classifications: LiveHplanClassification[];
  anyParamGap: boolean;
}): RakutenLiveHplanDecision {
  if (input.classifications.includes("live_hplan_response_positive")) {
    return "rakuten_live_hplan_capture_ready";
  }
  const hasAllFull = input.classifications.includes("live_hplan_response_all_full");
  const hasCapture = hasAllFull || input.classifications.includes("live_hplan_request_captured");
  if (hasCapture && input.anyParamGap) return "rakuten_live_hplan_param_gap_identified";
  if (hasAllFull) return "rakuten_live_hplan_no_positive_inventory";
  return "rakuten_live_hplan_not_ready";
}

export function renderRakutenLiveHplanCsv(rows: RakutenLiveHplanRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      String(row.clickIndex),
      row.calendarLinkText,
      row.calendarLinkHref,
      row.capturedHplanUrl,
      String(row.capturedStatus),
      row.capturedResponseType,
      String(row.liveAvailableDayCount),
      String(row.livePricePositiveDayCount),
      String(row.livePopulatedLinkCount),
      String(row.phase62ParamGapCount),
      row.classification,
      row.riskNote,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [RAKUTEN_LIVE_HPLAN_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenLiveHplanReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  rows: RakutenLiveHplanRow[];
  decision: RakutenLiveHplanDecision;
  executionNote: string;
  propertiesTested: { canonicalPropertyName: string; hotelNo: string }[];
  representativeDiff: ParamDiff | null;
}): string {
  const counts = new Map<LiveHplanClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  const capturedRows = input.rows.filter((r) => r.capturedHplanUrl !== "");

  const diffLines: string[] = [];
  if (input.representativeDiff) {
    const d = input.representativeDiff;
    diffLines.push(
      `- host_differs=${yn(d.hostDiffers)} (live=${d.liveHost || "n/a"} reconstructed=${d.reconstructedHost || "n/a"})`,
      `- path_differs=${yn(d.pathDiffers)} (live=${d.livePath || "n/a"} reconstructed=${d.reconstructedPath || "n/a"})`,
      `- params_only_in_live (we omit): ${d.onlyInLive.map((p) => `${p.key}=${p.value}`).join(", ") || "none"}`,
      `- params_only_in_reconstructed (we add): ${d.onlyInReconstructed.map((p) => p.key).join(", ") || "none"}`,
      `- params_different_value: ${d.differentValues.map((p) => `${p.key}(live=${p.live}|recon=${p.reconstructed})`).join(", ") || "none"}`,
      `- param_gap_count=${d.gapCount}`
    );
  } else {
    diffLines.push("- No live /hplan/calendar/ request was captured, so no parameter diff is available.");
  }

  return [
    "# Rakuten Live /hplan/calendar/ Request Capture (Phase 63X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- rows=${input.rows.length}`,
    `- captured_requests=${capturedRows.length}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "- Goal: capture the exact /hplan/calendar/ request the live Rakuten widget emits and diff it against the Phase 62X reconstruction to find the missing parameter(s).",
    "",
    "## 2. Properties tested",
    "",
    ...input.propertiesTested.map((p) => `- ${p.canonicalPropertyName} (${p.hotelNo})`),
    "",
    "## 3. Calendar links clicked / captured requests",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.hotelNo} click#${r.clickIndex} "${r.calendarLinkText || "n/a"}": captured=${r.capturedHplanUrl ? "yes" : "no"}, status=${r.capturedStatus}, type=${r.capturedResponseType || "n/a"}, class=${r.classification}`
    ),
    "",
    "## 4. Captured /hplan/calendar/ URLs",
    "",
    capturedRows.length === 0
      ? "- none captured"
      : capturedRows.map((r) => `- ${r.hotelNo} click#${r.clickIndex}: ${r.capturedHplanUrl}`).join("\n"),
    "",
    "## 5. Param diff (live vs Phase 62X reconstructed)",
    "",
    ...diffLines,
    "",
    "## 6. Vacancy / price / link findings",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.hotelNo} click#${r.clickIndex}: available=${r.liveAvailableDayCount}, price>0=${r.livePricePositiveDayCount}, links=${r.livePopulatedLinkCount}`
    ),
    "",
    "## 7. Classification counts",
    "",
    `- ${JSON.stringify(Object.fromEntries(counts))}`,
    "",
    "## 8. Feasibility decision",
    "",
    `- ${input.decision}`,
    "",
    "## 9. Risk notes",
    "",
    ...input.rows.map((r) => `- ${r.hotelNo} click#${r.clickIndex}: ${r.riskNote}`),
    "",
    "## 10. Debug artifact path",
    "",
    `- ${input.debugRootPath}`,
    "",
    "## 11. Safety confirmation",
    "",
    "- Observed the public browser making requests from a rendered public plan page; the only direct call is an exact replay of the captured public request, labeled captured_request_replay. No login, no cookies beyond the public session, no CAPTCHA bypass, no stealth, no paid APIs, no proxies, no private/internal APIs.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 12. Recommended next action",
    "",
    recommendedNextAction(input.decision, input.representativeDiff),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: RakutenLiveHplanDecision, diff: ParamDiff | null): string {
  if (decision === "rakuten_live_hplan_capture_ready") {
    return "- The live widget request was captured and returned vacancy-positive day data; replay the captured request shape (with our 2-adult/1-room basis) across target dates and map dayList.price (tax-inclusive) → collector price before gating a read-only prototype behind explicit review.";
  }
  if (decision === "rakuten_live_hplan_param_gap_identified") {
    const missing = diff?.onlyInLive.map((p) => p.key).join(", ") || "(see param_diff.json)";
    return `- The live request differs from our Phase 62X reconstruction; the missing/changed params are the likely cause of the all-full result. Add the live-only params [${missing}] to buildHplanCalendarUrl and re-run the vacancy probe to confirm vacant days surface.`;
  }
  if (decision === "rakuten_live_hplan_no_positive_inventory") {
    return "- Live requests were captured cleanly and match our reconstruction, yet responses are still all-full — this points to genuine no-open-inventory for the probed dates rather than a param bug. Re-capture against confirmed-bookable high-demand dates before concluding.";
  }
  return "- No usable live /hplan/calendar/ request could be captured (widget did not emit, was blocked, or the click had no effect). Re-run with a non-headless browser or longer waits under human review, and confirm the calendar widget actually renders for these properties.";
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

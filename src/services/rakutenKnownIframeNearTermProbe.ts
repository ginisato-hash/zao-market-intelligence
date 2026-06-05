/**
 * Rakuten KNOWN ZAO BASE iframe near-term availability probe (Phase 58X).
 *
 * Phase 57X proved the exact ZAO BASE Thickbox iframe URL (f_syu=zaobase3) is a
 * working endpoint that accepts/echoes our params, but returned
 * 「該当する部屋タイプが見つかりません」 for far-future dates. This phase keeps the
 * same known URL path and tests NEAR-TERM dates more likely to have open
 * inventory, distinguishing the "no matching room type" response from a true
 * sold-out / no-plan state and from a priced result.
 *
 * Pure helpers + renderers only. No network calls, no DB writes. The Playwright
 * rendering lives in src/scripts/probeRakutenKnownIframeNearTerm.ts.
 */
import {
  buildRakutenIframeUrlForDate,
  detectIframeDateScopedTotalEvidence,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  type RakutenIframeEvidence
} from "./rakutenKnownIframeProbe";

export {
  buildRakutenIframeUrlForDate,
  detectIframeDateScopedTotalEvidence,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  type RakutenIframeEvidence
};

const NO_MATCHING_ROOM_TYPE_PATTERN = /該当する部屋タイプが見つかりません|部屋タイプが見つかりません/u;

/** True only for the specific "no matching room type" response. */
export function detectNoMatchingRoomType(text: string): boolean {
  return NO_MATCHING_ROOM_TYPE_PATTERN.test(text.normalize("NFKC"));
}

export type RakutenNearTermClassification =
  | "near_term_date_scoped_total_found"
  | "near_term_date_scoped_per_person_found"
  | "near_term_no_plan_or_sold_out"
  | "near_term_no_matching_room_type"
  | "near_term_date_scope_unverified"
  | "near_term_basis_unverified"
  | "near_term_url_failed";

export type RakutenNearTermDecision =
  | "near_term_iframe_ready"
  | "near_term_iframe_basis_mapping_needed"
  | "near_term_iframe_not_ready";

export interface RakutenNearTermProbeRow {
  canonicalPropertyName: string;
  hotelNo: string;
  stayDate: string;
  knownBaseUrl: string;
  generatedUrl: string;
  reachable: boolean;
  dateScopeDetected: boolean;
  roomCountDetected: boolean;
  adultCountDetected: boolean;
  nightCountDetected: boolean;
  taxIncludedTotalDetected: string;
  perPersonPriceDetected: string;
  availabilityStatus: string;
  classification: RakutenNearTermClassification;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_NEAR_TERM_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "stay_date",
  "known_base_url",
  "generated_url",
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

export function classifyRakutenNearTermProbe(input: {
  reachable: boolean;
  noMatchingRoomType: boolean;
  evidence: RakutenIframeEvidence;
}): RakutenNearTermClassification {
  const e = input.evidence;
  if (!input.reachable) return "near_term_url_failed";
  // The specific "no matching room type" message is distinguished from a true
  // sold-out/no-plan state and checked before date-scope (a definitive endpoint
  // answer is stronger than the absence of a rendered date string).
  if (input.noMatchingRoomType) return "near_term_no_matching_room_type";
  if (e.soldOutOrNoPlanDetected) return "near_term_no_plan_or_sold_out";
  if (!e.dateScopeDetected) return "near_term_date_scope_unverified";
  if (
    e.propertyDetected &&
    e.adultCountDetected &&
    e.roomCountDetected &&
    e.nightCountDetected &&
    e.taxIncludedTotalDetected &&
    e.availabilityStatus === "available"
  ) {
    return "near_term_date_scoped_total_found";
  }
  if (e.propertyDetected && e.perPersonPriceDetected && !e.taxIncludedTotalDetected) {
    return "near_term_date_scoped_per_person_found";
  }
  return "near_term_basis_unverified";
}

export function decideRakutenNearTermFeasibility(
  classifications: RakutenNearTermClassification[]
): RakutenNearTermDecision {
  if (classifications.includes("near_term_date_scoped_total_found")) {
    return "near_term_iframe_ready";
  }
  const usefulEvidence = classifications.some(
    (c) =>
      c === "near_term_date_scoped_per_person_found" ||
      c === "near_term_no_plan_or_sold_out" ||
      c === "near_term_basis_unverified"
  );
  return usefulEvidence ? "near_term_iframe_basis_mapping_needed" : "near_term_iframe_not_ready";
}

export function renderRakutenNearTermCsv(rows: RakutenNearTermProbeRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.stayDate,
      row.knownBaseUrl,
      row.generatedUrl,
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
  return [RAKUTEN_NEAR_TERM_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenNearTermReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  knownBaseUrl: string;
  rows: RakutenNearTermProbeRow[];
  decision: RakutenNearTermDecision;
  executionNote: string;
}): string {
  const counts = new Map<RakutenNearTermClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);

  return [
    "# Rakuten Known ZAO BASE Iframe Near-Term Availability Probe (Phase 58X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- probe_rows=${input.rows.length}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "- Goal: test the exact ZAO BASE iframe URL (f_syu=zaobase3) on NEAR-TERM dates to see whether the endpoint returns a priced/date-scoped room result when inventory is likely open.",
    "",
    "## 2. Known base URL",
    "",
    `- ${input.knownBaseUrl}`,
    "",
    "## 3. Dates tested",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.hotelNo} / ${row.stayDate}`),
    "",
    "## 4. Generated URLs",
    "",
    ...input.rows.map((row) => `- ${row.stayDate}: ${row.generatedUrl || "not_generated"}`),
    "",
    "## 5. Reachability results",
    "",
    ...input.rows.map((row) => `- ${row.stayDate}: reachable=${yn(row.reachable)}, classification=${row.classification}`),
    "",
    "## 6. Date-scope findings",
    "",
    ...input.rows.map((row) => `- ${row.stayDate}: date_scope=${yn(row.dateScopeDetected)}`),
    "",
    "## 7. Adult/room/night basis findings",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.stayDate}: adults=${yn(row.adultCountDetected)}, rooms=${yn(row.roomCountDetected)}, nights=${yn(row.nightCountDetected)}`
    ),
    "",
    "## 8. Tax-included total findings",
    "",
    ...input.rows.map(
      (row) => `- ${row.stayDate}: total=${row.taxIncludedTotalDetected || "none"}, per_person=${row.perPersonPriceDetected || "none"}`
    ),
    "",
    "## 9. Classification counts",
    "",
    `- ${JSON.stringify(Object.fromEntries(counts))}`,
    "",
    "## 10. Feasibility decision",
    "",
    `- ${input.decision}`,
    "",
    "## 11. Risk notes",
    "",
    ...input.rows.map((row) => `- ${row.stayDate}: ${row.riskNote}`),
    "",
    "## 12. Debug artifact paths",
    "",
    `- ${input.debugRootPath}`,
    ...input.rows.map((row) => `- ${row.debugArtifactPath}`),
    "",
    "## 13. Safety confirmation",
    "",
    "- Public rendered pages only; no login, no cookies, no CAPTCHA bypass, no stealth, no paid APIs, no proxies, no private/internal APIs.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 14. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: RakutenNearTermDecision): string {
  if (decision === "near_term_iframe_ready") {
    return "- A near-term date exposed a date-scoped 2-adult/1-room/1-night tax-included total; record selectors and gate a tiny read-only collector prototype behind explicit review.";
  }
  if (decision === "near_term_iframe_basis_mapping_needed") {
    return "- The iframe opened and showed useful date/price evidence on near-term dates; inspect saved DOM/screenshots and map total/per-person/date selectors before any DB-writing collector.";
  }
  return "- Near-term dates still returned no matching room type / no date-scoped price for f_syu=zaobase3; the static room-type token is likely stale or date-coupled — next, re-extract the live f_syu per date from the plan page, or confirm whether this room type is bookable on Rakuten at all.";
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

/**
 * Rakuten KNOWN ZAO BASE Thickbox iframe URL probe (Phase 57X).
 *
 * Narrow feasibility probe of the exact public Thickbox iframe URL the user
 * manually discovered from the ZAO BASE 2名利用時 空室カレンダー link
 * (f_syu=zaobase3). Unlike Phase 56X, this does NOT re-derive the href from the
 * plan page; it tests the known-good URL directly with controlled date variants.
 *
 * Pure helpers + renderers only. No network calls, no DB writes. The Playwright
 * rendering lives in src/scripts/probeRakutenKnownIframeUrl.ts.
 */
import {
  buildRakutenIframeUrlForDate,
  detectIframeDateScopedTotalEvidence,
  parseRakutenIframeParams,
  type RakutenIframeEvidence,
  type RakutenIframeParams
} from "./rakutenIframeProbe";

export {
  buildRakutenIframeUrlForDate,
  detectIframeDateScopedTotalEvidence,
  parseRakutenIframeParams,
  type RakutenIframeEvidence,
  type RakutenIframeParams
};

/**
 * Exact public Thickbox iframe URL discovered by the user from the ZAO BASE
 * 2名利用時 空室カレンダー link on
 * https://hotel.travel.rakuten.co.jp/hotelinfo/plan/197787 .
 */
export const KNOWN_ZAO_BASE_IFRAME_URL =
  "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?TB_iframe=true&f_campaign=&f_clip_flg=&f_custom_code=&f_flg=PLAN&f_hak=&f_heya_su=1&f_hizuke=20260426&f_kin=&f_kin2=&f_no=197787&f_otona_su=2&f_p_no=&f_service=&f_static=&f_syu=zaobase3&f_teikei=&f_tel=&f_thick=1&f_tscm_flg=&height=768&send=&width=1024";

export type RakutenKnownIframeClassification =
  | "known_iframe_date_scoped_total_found"
  | "known_iframe_date_scoped_per_person_found"
  | "known_iframe_no_plan_or_sold_out"
  | "known_iframe_date_scope_unverified"
  | "known_iframe_basis_unverified"
  | "known_iframe_url_failed";

export type RakutenKnownIframeDecision =
  | "known_iframe_ready"
  | "known_iframe_basis_mapping_needed"
  | "known_iframe_not_ready";

export interface RakutenKnownIframeProbeRow {
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
  classification: RakutenKnownIframeClassification;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_KNOWN_IFRAME_CSV_HEADERS = [
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

export function classifyRakutenKnownIframeProbe(input: {
  reachable: boolean;
  evidence: RakutenIframeEvidence;
}): RakutenKnownIframeClassification {
  const e = input.evidence;
  if (!input.reachable) return "known_iframe_url_failed";
  // A definitive "no matching room type / no plan / sold out" message is a real
  // Rakuten response and a stronger signal than the absence of a rendered date
  // string, so it is checked before date-scope.
  if (e.soldOutOrNoPlanDetected) return "known_iframe_no_plan_or_sold_out";
  if (!e.dateScopeDetected) return "known_iframe_date_scope_unverified";
  if (
    e.propertyDetected &&
    e.adultCountDetected &&
    e.roomCountDetected &&
    e.nightCountDetected &&
    e.taxIncludedTotalDetected &&
    e.availabilityStatus === "available"
  ) {
    return "known_iframe_date_scoped_total_found";
  }
  if (e.propertyDetected && e.perPersonPriceDetected && !e.taxIncludedTotalDetected) {
    return "known_iframe_date_scoped_per_person_found";
  }
  return "known_iframe_basis_unverified";
}

export function decideRakutenKnownIframeFeasibility(
  classifications: RakutenKnownIframeClassification[]
): RakutenKnownIframeDecision {
  if (classifications.includes("known_iframe_date_scoped_total_found")) {
    return "known_iframe_ready";
  }
  const usefulEvidence = classifications.some(
    (c) =>
      c === "known_iframe_date_scoped_per_person_found" ||
      c === "known_iframe_no_plan_or_sold_out" ||
      c === "known_iframe_basis_unverified"
  );
  return usefulEvidence ? "known_iframe_basis_mapping_needed" : "known_iframe_not_ready";
}

export function renderRakutenKnownIframeCsv(rows: RakutenKnownIframeProbeRow[]): string {
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
  return [RAKUTEN_KNOWN_IFRAME_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenKnownIframeReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  knownBaseUrl: string;
  rows: RakutenKnownIframeProbeRow[];
  decision: RakutenKnownIframeDecision;
  executionNote: string;
}): string {
  const counts = new Map<RakutenKnownIframeClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);

  return [
    "# Rakuten Known ZAO BASE Iframe URL Probe (Phase 57X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- probe_rows=${input.rows.length}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "- Goal: test the EXACT user-discovered ZAO BASE Thickbox iframe URL (f_syu=zaobase3) directly, with controlled f_hizuke date variants, rather than re-deriving the href.",
    "",
    "## 2. Known base URL",
    "",
    `- ${input.knownBaseUrl}`,
    "",
    "## 3. Properties/dates tested",
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

function recommendedNextAction(decision: RakutenKnownIframeDecision): string {
  if (decision === "known_iframe_ready") {
    return "- The known ZAO BASE iframe URL exposes a date-scoped 2-adult/1-room/1-night tax-included total; record selectors and gate a tiny read-only collector prototype behind explicit review.";
  }
  if (decision === "known_iframe_basis_mapping_needed") {
    return "- The known iframe URL opened and showed useful date/price evidence; inspect the saved DOM/screenshots and map total/per-person/date selectors before any DB-writing collector.";
  }
  return "- The known iframe URL did not expose usable date/price evidence; inspect the debug artifact and decide whether the iframe needs parent-page (Thickbox) context or a different calendar endpoint.";
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

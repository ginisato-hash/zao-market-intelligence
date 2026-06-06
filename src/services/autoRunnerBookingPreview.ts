// Phase AUTO-RUNNER08X - gated Booking collector preview runner (pure helpers).
//
// This module contains NO browser/network code. It builds the bounded target
// matrix, enforces the page cap, maps proven Booking rendered-DOM rows into
// preview rows under existing Booking policy, and renders artifacts. The live
// chromium driver lives in src/scripts/runAutoRunnerBookingPreview.ts and reuses
// the proven src/services/bookingRenderedDomProbe.ts extractor.
//
// It never appends history, never writes/syncs the DB, never refreshes AI
// context, and never emits pricing/PMS output. Booking rows are directional or
// excluded only — never "direct".

import {
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  sanitizeBookingUrl,
  type BookingRenderedDomClassification,
  type BookingRenderedDomRow,
  type BookingRenderedDomTarget
} from "./bookingRenderedDomProbe";

export const SOURCE_PHASE = "AUTO-RUNNER08X";
export const STAY_SCOPE = "2_adults_1_room_1_night";
export const GATE_NAME = "COLLECT_BOOKING";
export const MAX_PROPERTIES = 3;
export const MAX_DATES_PER_PROPERTY = 3;
export const MAX_PAGES = 9;

export type AutoRunnerBookingPreviewDecision =
  | "auto_runner_booking_preview_ready"
  | "auto_runner_booking_preview_basis_caution"
  | "auto_runner_booking_preview_ready_not_run"
  | "auto_runner_booking_preview_not_ready";

export type PreviewClassification = "directional" | "excluded" | "not_ready";

// Verified Booking slugs (same fixed set used by the proven rendered-DOM probe).
export const VERIFIED_BOOKING_TARGETS: readonly BookingRenderedDomTarget[] = [
  { canonicalPropertyName: "蔵王国際ホテル", slug: "zao-kokusai" },
  { canonicalPropertyName: "蔵王四季のホテル", slug: "zao-shiki-no" },
  { canonicalPropertyName: "深山荘 高見屋", slug: "shinzanso-takamiya" }
] as const;

export interface GateResult {
  gate_name: string;
  raw_value: string;
  enabled: boolean;
  live_collection_authorized: boolean;
}

export function readGate(env: Record<string, string | undefined>): GateResult {
  const raw = env[GATE_NAME] ?? "";
  const enabled = raw === "1";
  return { gate_name: GATE_NAME, raw_value: raw, enabled, live_collection_authorized: enabled };
}

export interface TargetCell {
  source: "booking";
  property_slug: string;
  canonical_property_name: string;
  checkin: string;
  checkout: string;
  url_sanitized: string;
}

// Next two upcoming Saturdays (strictly after today) plus one peak date, capped
// to MAX_DATES_PER_PROPERTY. Deterministic and testable.
export function selectPreviewDates(todayIso: string, peakDateIso: string): string[] {
  const dates = [...nextSaturdays(todayIso, 2), peakDateIso];
  const unique: string[] = [];
  for (const d of dates) {
    if (!unique.includes(d)) unique.push(d);
  }
  return unique.slice(0, MAX_DATES_PER_PROPERTY);
}

export function buildTargetMatrix(
  targets: readonly BookingRenderedDomTarget[],
  dates: readonly string[]
): TargetCell[] {
  const boundedTargets = targets.slice(0, MAX_PROPERTIES);
  const boundedDates = dates.slice(0, MAX_DATES_PER_PROPERTY);
  const cells: TargetCell[] = [];
  for (const target of boundedTargets) {
    if (!/^[a-z0-9-]+$/u.test(target.slug)) continue; // only verified-shaped Booking slugs
    for (const checkin of boundedDates) {
      const checkout = checkoutForOneNight(checkin);
      cells.push({
        source: "booking",
        property_slug: target.slug,
        canonical_property_name: target.canonicalPropertyName,
        checkin,
        checkout,
        url_sanitized: sanitizeBookingUrl(buildBookingRenderedDomUrl({ ...target, checkin }))
      });
    }
  }
  return cells;
}

export interface PageCapResult {
  requested: number;
  max_pages: number;
  selected: TargetCell[];
  capped: boolean;
  respected: boolean;
}

export function enforcePageCap(cells: readonly TargetCell[]): PageCapResult {
  const selected = cells.slice(0, MAX_PAGES);
  return {
    requested: cells.length,
    max_pages: MAX_PAGES,
    selected,
    capped: cells.length > MAX_PAGES,
    respected: selected.length <= MAX_PAGES
  };
}

export type PreviewAvailabilityStatus =
  | "available_price_basis"
  | "sold_out_or_unavailable"
  | "visible_no_safe_price"
  | "degraded_empty"
  | "blocked_captcha_or_security"
  | "blocked_login_required"
  | "not_found"
  | "navigation_failed"
  | "unexpected_error";

const AVAILABILITY_BY_CLASSIFICATION: Record<BookingRenderedDomClassification, PreviewAvailabilityStatus> = {
  booking_rendered_price_basis_candidate_found: "available_price_basis",
  booking_rendered_sold_out_or_unavailable: "sold_out_or_unavailable",
  booking_rendered_content_visible_no_safe_price: "visible_no_safe_price",
  booking_rendered_empty_or_near_empty: "degraded_empty",
  booking_rendered_captcha_or_security: "blocked_captcha_or_security",
  booking_rendered_login_required: "blocked_login_required",
  booking_rendered_not_found: "not_found",
  booking_rendered_navigation_failed: "navigation_failed",
  booking_rendered_unexpected_error: "unexpected_error"
};

export interface PreviewRow {
  source: "booking";
  property_slug: string;
  canonical_property_name: string;
  checkin: string;
  checkout: string;
  stay_scope: string;
  availability_status: PreviewAvailabilityStatus;
  primary_price_numeric: number | null;
  official_tax_fee_adder_numeric: number | null;
  computed_total_with_tax_fee: number | null;
  basis_confidence: "directional_candidate_basis" | "insufficient";
  dp_usage: "directional_only" | "audit_only";
  classification: PreviewClassification;
  screenshot_path: string;
  debug_path: string;
  warning_flags: string[];
  collected_at_jst: string;
  source_phase: string;
}

// Maps a proven Booking rendered-DOM row into a preview row under existing
// Booking policy: direct is never produced; directional requires a detected
// price and an acceptable directional basis; everything else is audit-only
// excluded. No synthetic ten-percent tax multiplier — the official visible adder
// is not extracted by this probe, so it stays null (computed total stays null too).
export function toPreviewRow(
  domRow: BookingRenderedDomRow,
  opts: { screenshotPath: string; debugPath: string; collectedAtJst: string }
): PreviewRow {
  const availability = AVAILABILITY_BY_CLASSIFICATION[domRow.classification];
  const hasUsablePrice =
    domRow.classification === "booking_rendered_price_basis_candidate_found" &&
    domRow.firstPriceCandidateValue !== null;
  const classification: PreviewClassification = hasUsablePrice ? "directional" : "excluded";
  const warning: string[] = [];
  if (domRow.soldOutOrUnavailableDetected) warning.push("sold_out_or_unavailable_detected");
  if (domRow.classification === "booking_rendered_captcha_or_security") warning.push("captcha_or_security_detected");
  if (domRow.classification === "booking_rendered_login_required") warning.push("login_required_detected");
  if (!domRow.loaded) warning.push("navigation_failed");
  if (domRow.riskNote) warning.push(domRow.riskNote);
  return {
    source: "booking",
    property_slug: domRow.slug,
    canonical_property_name: domRow.canonicalPropertyName,
    checkin: domRow.checkin,
    checkout: domRow.checkout,
    stay_scope: STAY_SCOPE,
    availability_status: availability,
    primary_price_numeric: hasUsablePrice ? domRow.firstPriceCandidateValue : null,
    official_tax_fee_adder_numeric: null,
    computed_total_with_tax_fee: null,
    basis_confidence: hasUsablePrice ? "directional_candidate_basis" : "insufficient",
    dp_usage: hasUsablePrice ? "directional_only" : "audit_only",
    classification,
    screenshot_path: opts.screenshotPath,
    debug_path: opts.debugPath,
    warning_flags: warning,
    collected_at_jst: opts.collectedAtJst,
    source_phase: SOURCE_PHASE
  };
}

export interface ClassificationSummary {
  total: number;
  directional: number;
  excluded: number;
  not_ready: number;
  direct: number;
  with_price: number;
}

export function summarizeClassification(rows: readonly PreviewRow[]): ClassificationSummary {
  return {
    total: rows.length,
    directional: rows.filter((r) => r.classification === "directional").length,
    excluded: rows.filter((r) => r.classification === "excluded").length,
    not_ready: rows.filter((r) => r.classification === "not_ready").length,
    direct: 0,
    with_price: rows.filter((r) => r.primary_price_numeric !== null).length
  };
}

export interface SafetyConfirmation {
  history_modified: false;
  db_written: false;
  db_synced: false;
  ai_context_refreshed: false;
  pricing_csv_generated: false;
  pms_output_generated: false;
  live_collection_executed: boolean;
  page_cap_respected: boolean;
  no_paid_sources: true;
  no_login_cookies: true;
  no_stealth: true;
  no_captcha_bypass: true;
  jalan_collected: false;
  rakuten_collected: false;
  google_hotels_collected: false;
}

export function buildSafetyConfirmation(input: { liveExecuted: boolean; pageCapRespected: boolean }): SafetyConfirmation {
  return {
    history_modified: false,
    db_written: false,
    db_synced: false,
    ai_context_refreshed: false,
    pricing_csv_generated: false,
    pms_output_generated: false,
    live_collection_executed: input.liveExecuted,
    page_cap_respected: input.pageCapRespected,
    no_paid_sources: true,
    no_login_cookies: true,
    no_stealth: true,
    no_captcha_bypass: true,
    jalan_collected: false,
    rakuten_collected: false,
    google_hotels_collected: false
  };
}

export function decidePreview(input: {
  liveExecuted: boolean;
  pageCapRespected: boolean;
  implementationSafe: boolean;
  rows: readonly PreviewRow[];
}): AutoRunnerBookingPreviewDecision {
  if (!input.implementationSafe || !input.pageCapRespected) return "auto_runner_booking_preview_not_ready";
  if (!input.liveExecuted) return "auto_runner_booking_preview_ready_not_run";
  if (input.rows.some((r) => r.classification === "directional")) return "auto_runner_booking_preview_ready";
  return "auto_runner_booking_preview_basis_caution";
}

export const PREVIEW_CSV_HEADERS = [
  "source",
  "property_slug",
  "canonical_property_name",
  "checkin",
  "checkout",
  "stay_scope",
  "availability_status",
  "primary_price_numeric",
  "official_tax_fee_adder_numeric",
  "computed_total_with_tax_fee",
  "basis_confidence",
  "dp_usage",
  "classification",
  "warning_flags",
  "collected_at_jst",
  "source_phase"
] as const;

export function renderPreviewCsv(rows: readonly PreviewRow[]): string {
  const body = rows.map((r) =>
    [
      r.source,
      r.property_slug,
      r.canonical_property_name,
      r.checkin,
      r.checkout,
      r.stay_scope,
      r.availability_status,
      r.primary_price_numeric === null ? "" : String(r.primary_price_numeric),
      r.official_tax_fee_adder_numeric === null ? "" : String(r.official_tax_fee_adder_numeric),
      r.computed_total_with_tax_fee === null ? "" : String(r.computed_total_with_tax_fee),
      r.basis_confidence,
      r.dp_usage,
      r.classification,
      r.warning_flags.join("; "),
      r.collected_at_jst,
      r.source_phase
    ]
      .map(csvCell)
      .join(",")
  );
  return [PREVIEW_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export interface PreviewResult {
  run_id: string;
  generated_at_jst: string;
  decision: AutoRunnerBookingPreviewDecision;
  source_phase: string;
  gate: GateResult;
  max_pages: number;
  page_cap: PageCapResult;
  target_matrix: TargetCell[];
  selected_targets: TargetCell[];
  preview_rows: PreviewRow[];
  classification_summary: ClassificationSummary;
  safety_confirmation: SafetyConfirmation;
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
}

export function renderReport(result: PreviewResult): string {
  return `# Booking Collector Preview (AUTO-RUNNER08X)

Generated at JST: ${result.generated_at_jst}

## 1. Decision

${result.decision}

## 2. Gate

- gate: ${result.gate.gate_name}=${result.gate.raw_value || "(unset)"}
- live_collection_authorized: ${result.gate.live_collection_authorized}

## 3. Page Cap

- max_pages: ${result.max_pages}
- requested: ${result.page_cap.requested}
- selected: ${result.page_cap.selected.length}
- capped: ${result.page_cap.capped}
- respected: ${result.page_cap.respected}

## 4. Target Matrix (Booking only, verified slugs)

${result.target_matrix.map((c) => `- ${c.canonical_property_name} (${c.property_slug}) ${c.checkin}→${c.checkout}`).join("\n") || "- (none)"}

## 5. Preview Rows

${
    result.preview_rows.length === 0
      ? "- (no live rows — ready_not_run / dry-run)"
      : result.preview_rows
          .map(
            (r) =>
              `- ${r.canonical_property_name} (${r.property_slug}) ${r.checkin}: ${r.classification} / ${r.availability_status} / price=${r.primary_price_numeric ?? "n/a"} / basis=${r.basis_confidence}`
          )
          .join("\n")
  }

## 6. Classification Summary

${JSON.stringify(result.classification_summary, null, 2)}

## 7. Safety Confirmation

${JSON.stringify(result.safety_confirmation, null, 2)}

## 8. Output Paths

- report_path: ${result.report_path}
- json_path: ${result.json_path}
- csv_path: ${result.csv_path}
- debug_artifact_path: ${result.debug_artifact_path}

## 9. Recommended Next Action

AUTO-RUNNER08Y — Booking preview review and history append proposal. Do not append
to history until 08Y/08Z explicitly approves it.
`;
}

function nextSaturdays(todayIso: string, count: number): string[] {
  const base = parseYmd(todayIso);
  const out: string[] = [];
  let cursor = base;
  // Saturday = day 6 (UTC). Advance strictly past today to the next Saturday.
  do {
    cursor = addDays(cursor, 1);
  } while (cursor.getUTCDay() !== 6);
  for (let i = 0; i < count; i += 1) {
    out.push(toYmd(cursor));
    cursor = addDays(cursor, 7);
  }
  return out;
}

function parseYmd(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) throw new Error(`expected YYYY-MM-DD: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function toYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function csvCell(value: string): string {
  if (!/[",\n\r]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

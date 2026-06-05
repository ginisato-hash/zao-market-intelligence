import {
  compareConditionBasis,
  extractYenPriceCandidates,
  sanitizeRakutenConditionUrl,
  type BasisComparison,
  type PriceCandidate
} from "./rakutenConditionLinkBasisProbe";
import type { HplanDay } from "./rakutenCorrectedHplanUrlProbe";

export { extractYenPriceCandidates, type BasisComparison };

export type ButtonSafety = "unsafe" | "potentially_safe" | "ambiguous";

export type RakutenConditionFlowPageClassification =
  | "condition_flow_price_basis_confirmed"
  | "condition_flow_price_visible_basis_ambiguous"
  | "condition_flow_condition_input_only"
  | "condition_flow_safe_transition_available_not_taken"
  | "condition_flow_safe_transition_attempted_no_price"
  | "condition_flow_unsafe_transition_required"
  | "condition_flow_login_or_personal_info_required"
  | "condition_flow_render_blocked"
  | "condition_flow_unexpected_error";

export type RakutenConditionFlowDecision =
  | "rakuten_price_basis_confirmed"
  | "rakuten_price_basis_needs_manual_review"
  | "rakuten_price_basis_requires_different_public_endpoint"
  | "rakuten_price_basis_not_ready";

export interface ButtonSummary {
  index: number;
  text: string;
  type: string;
  name: string;
  value: string;
  safety: ButtonSafety;
  reason: string;
}

export interface FormSummary {
  index: number;
  action: string;
  method: string;
  textExcerpt: string;
  unsafeContext: boolean;
}

export interface InputSummary {
  name: string;
  type: string;
  value: string;
  tagName: string;
}

export interface LinkSummary {
  text: string;
  hrefSanitized: string;
  safety: ButtonSafety;
  reason: string;
}

export interface NetworkRequestSummary {
  urlSanitized: string;
  method: string;
  resourceType: string;
  status: number;
}

export interface ConditionFlowStep {
  stepIndex: number;
  stepName: string;
  urlSanitized: string;
  title: string;
  httpStatusOrNavigationStatus: string;
  visibleDateSignals: string[];
  visiblePeopleSignals: string[];
  visibleRoomSignals: string[];
  visibleNightSignals: string[];
  visiblePriceCandidates: PriceCandidate[];
  visibleTaxSignals: string[];
  visibleAvailabilitySignals: string[];
  formsSummary: FormSummary[];
  inputsSummary: InputSummary[];
  buttonsSummary: ButtonSummary[];
  linksSummary: LinkSummary[];
  networkRequestsSummary: NetworkRequestSummary[];
  screenshotPath: string;
  htmlPath: string;
  visibleTextPath: string;
  classification: RakutenConditionFlowPageClassification;
}

export interface ConditionFlowRow {
  stepIndex: number;
  stepName: string;
  urlSanitized: string;
  title: string;
  dateDetected: boolean;
  peopleDetected: boolean;
  roomDetected: boolean;
  nightDetected: boolean;
  priceCandidateCount: number;
  taxDetected: boolean;
  safeTransitionCandidateCount: number;
  unsafeTransitionCount: number;
  classification: RakutenConditionFlowPageClassification;
  decision: RakutenConditionFlowDecision;
  debugArtifactPath: string;
}

export const RAKUTEN_CONDITION_FLOW_CSV_HEADERS = [
  "step_index",
  "step_name",
  "url_sanitized",
  "title",
  "date_detected",
  "people_detected",
  "room_detected",
  "night_detected",
  "price_candidate_count",
  "tax_detected",
  "safe_transition_candidate_count",
  "unsafe_transition_count",
  "classification",
  "decision",
  "debug_artifact_path"
] as const;

const UNSAFE_RE =
  /予約を確定|予約確定|予約する|この内容で予約|決済|支払い|ログイン|会員登録|個人情報|お客様情報|予約申し込み|予約申込|申し込み画面/u;
const SAFE_RE = /検索|空室検索|条件を変更|条件を設定|再検索|次へ|プランを選択|詳細|料金を確認/u;

export function classifyButtonSafety(text: string, context = ""): { safety: ButtonSafety; reason: string } {
  const joined = `${text} ${context}`.replace(/\s+/gu, " ").trim();
  if (UNSAFE_RE.test(joined)) return { safety: "unsafe", reason: "reservation/login/payment/personal-info context detected" };
  if (SAFE_RE.test(text)) return { safety: "potentially_safe", reason: "non-final search/condition/price wording detected" };
  return { safety: "ambiguous", reason: "button text is not in the safe allow-list" };
}

export function extractDateSignals(text: string): string[] {
  return uniqueMatches(text, /\d{4}年\d{1,2}月\d{1,2}日(?:\([^)]+\))?|\d{4}[/-]\d{1,2}[/-]\d{1,2}/gu);
}

export function extractPeopleSignals(text: string): string[] {
  return uniqueMatches(text, /大人\s*[0-9０-９]+|[0-9０-９]+\s*名利用|[0-9０-９]+\s*名|[0-9０-９]+\s*人/gu);
}

export function extractRoomSignals(text: string): string[] {
  return uniqueMatches(text, /[0-9０-９]+\s*室|部屋数[^。]{0,20}/gu);
}

export function extractNightSignals(text: string): string[] {
  return uniqueMatches(text, /[0-9０-９]+\s*泊|一泊|宿泊数[^。]{0,20}/gu);
}

export function extractTaxSignals(text: string): string[] {
  return uniqueMatches(text, /税込|税金込|消費税込|税サ込|税別|税抜|入湯税[^。]{0,50}|宿泊税[^。]{0,50}/gu);
}

export function extractAvailabilitySignals(text: string): string[] {
  return uniqueMatches(text, /残り[^。]{0,40}|空室[^。]{0,40}|予約可能[^。]{0,40}|満室|受付終了/gu);
}

export function compareFlowBasis(input: {
  day: HplanDay;
  text: string;
  adultCount: number;
  priceCandidates: PriceCandidate[];
}): BasisComparison {
  return compareConditionBasis({
    day: input.day,
    adultCount: input.adultCount,
    signals: {
      pageTitle: "",
      propertyNameVisible: /蔵王国際ホテル/u.test(input.text),
      roomOrPlanNameVisible: true,
      checkinDateVisible: extractDateSignals(input.text).length > 0,
      checkoutDateVisible: /チェックアウト|OUT|翌日/u.test(input.text),
      nightsVisible: extractNightSignals(input.text).some((s) => /1|１|一/u.test(s)),
      adultCountVisible: extractPeopleSignals(input.text).some((s) => /2|２/u.test(s)),
      roomCountVisible: extractRoomSignals(input.text).some((s) => /1|１/u.test(s)),
      taxIncludedTextPresent: /税込|税金込|消費税込|税サ込/u.test(input.text),
      couponOrDiscountTextPresent: /クーポン|割引/u.test(input.text),
      serviceFeeOrTaxNotes: extractTaxSignals(input.text).join(" / "),
      onsenTaxOrBathTaxNotes: extractTaxSignals(input.text).filter((s) => /入湯税|宿泊税/u.test(s)).join(" / "),
      availabilityOrRemainingRoomText: extractAvailabilitySignals(input.text).join(" / "),
      buttonOrBookingStateText: "",
      totalPriceCandidates: input.priceCandidates.filter((p) => p.candidateTypeGuess !== "per_person_tax_included"),
      perPersonPriceCandidates: input.priceCandidates.filter((p) => p.candidateTypeGuess === "per_person_tax_included"),
      currency: input.priceCandidates.length > 0 ? "JPY" : ""
    }
  });
}

export function classifyConditionFlowStep(input: {
  priceCandidates: PriceCandidate[];
  comparison: BasisComparison;
  buttons: ButtonSummary[];
  networkRequests: NetworkRequestSummary[];
  transitionAttempted: boolean;
  renderedBlocked: boolean;
}): RakutenConditionFlowPageClassification {
  if (input.renderedBlocked) return "condition_flow_render_blocked";
  if (
    input.comparison.dateMatches &&
    input.comparison.adultScopeMatches &&
    input.comparison.roomScopeMatches &&
    input.comparison.nightScopeMatches &&
    input.comparison.taxIncludedConfirmed &&
    input.comparison.anyVisiblePriceEqualsPriceTimesAdults
  ) {
    return "condition_flow_price_basis_confirmed";
  }
  if (input.priceCandidates.length > 0) return "condition_flow_price_visible_basis_ambiguous";
  if (input.transitionAttempted) return "condition_flow_safe_transition_attempted_no_price";
  if (input.buttons.some((b) => b.safety === "potentially_safe")) return "condition_flow_safe_transition_available_not_taken";
  if (input.buttons.some((b) => b.safety === "unsafe")) {
    return input.buttons.some((b) => /ログイン|会員登録|個人情報|お客様情報/u.test(b.text))
      ? "condition_flow_login_or_personal_info_required"
      : "condition_flow_unsafe_transition_required";
  }
  if (input.networkRequests.some((r) => /price|condition|stay|plan|rsvh/u.test(r.urlSanitized))) {
    return "condition_flow_condition_input_only";
  }
  return "condition_flow_condition_input_only";
}

export function decideConditionFlow(classifications: RakutenConditionFlowPageClassification[]): RakutenConditionFlowDecision {
  if (classifications.includes("condition_flow_price_basis_confirmed")) return "rakuten_price_basis_confirmed";
  if (classifications.includes("condition_flow_price_visible_basis_ambiguous")) return "rakuten_price_basis_needs_manual_review";
  if (classifications.includes("condition_flow_condition_input_only")) return "rakuten_price_basis_requires_different_public_endpoint";
  if (
    classifications.includes("condition_flow_unsafe_transition_required") ||
    classifications.includes("condition_flow_login_or_personal_info_required") ||
    classifications.includes("condition_flow_safe_transition_available_not_taken") ||
    classifications.includes("condition_flow_safe_transition_attempted_no_price")
  ) {
    return "rakuten_price_basis_needs_manual_review";
  }
  return "rakuten_price_basis_not_ready";
}

export function sanitizeFlowUrl(url: string): string {
  return sanitizeRakutenConditionUrl(url);
}

export function renderConditionFlowCsv(rows: ConditionFlowRow[]): string {
  const body = rows.map((row) =>
    [
      String(row.stepIndex),
      row.stepName,
      row.urlSanitized,
      row.title,
      yn(row.dateDetected),
      yn(row.peopleDetected),
      yn(row.roomDetected),
      yn(row.nightDetected),
      String(row.priceCandidateCount),
      yn(row.taxDetected),
      String(row.safeTransitionCandidateCount),
      String(row.unsafeTransitionCount),
      row.classification,
      row.decision,
      row.debugArtifactPath
    ].map(csvEscape).join(",")
  );
  return [RAKUTEN_CONDITION_FLOW_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderConditionFlowReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  rows: ConditionFlowRow[];
  steps: ConditionFlowStep[];
  comparison: BasisComparison | null;
  decision: RakutenConditionFlowDecision;
}): string {
  const counts = countBy(input.rows.map((r) => r.classification));
  return [
    "# Rakuten Condition-Page Flow Inspection Probe (Phase 65Y)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.decision}`,
    `- steps_inspected=${input.rows.length}`,
    `- classification_counts=${JSON.stringify(counts)}`,
    "- Scope: one property, one condition-entry page, max two safe transitions.",
    "",
    "## 2. Pages / steps inspected",
    "",
    ...input.rows.map(
      (r) =>
        `- step_${r.stepIndex} ${r.stepName}: ${r.classification}, date=${yn(r.dateDetected)}, people=${yn(r.peopleDetected)}, room=${yn(r.roomDetected)}, night=${yn(r.nightDetected)}, prices=${r.priceCandidateCount}, safe_buttons=${r.safeTransitionCandidateCount}, unsafe_buttons=${r.unsafeTransitionCount}`
    ),
    "",
    "## 3. Buttons / forms / inputs found",
    "",
    ...input.steps.flatMap((s) => [
      `- step_${s.stepIndex}: forms=${s.formsSummary.length}, inputs=${s.inputsSummary.length}, buttons=${s.buttonsSummary.length}, links=${s.linksSummary.length}`,
      `  - buttons=${s.buttonsSummary.map((b) => `${b.text || b.value || b.name || "(blank)"}:${b.safety}`).join(" | ") || "none"}`,
      `  - form_actions=${s.formsSummary.map((f) => `${f.method} ${f.action}`).join(" | ") || "none"}`
    ]),
    "",
    "## 4. Basis comparison",
    "",
    ...(input.comparison
      ? [
          `- expected_per_person_tax_included=${input.comparison.expectedPerPersonTaxIncluded}`,
          `- expected_2_adult_total_tax_included=${input.comparison.expectedTwoAdultTotalTaxIncluded}`,
          `- visible_price_equals_dayList.price=${yn(input.comparison.anyVisiblePriceEqualsDayListPrice)}`,
          `- visible_price_equals_dayList.price_times_2=${yn(input.comparison.anyVisiblePriceEqualsPriceTimesAdults)}`,
          `- date_matches=${yn(input.comparison.dateMatches)}`,
          `- adult_scope_matches=${yn(input.comparison.adultScopeMatches)}`,
          `- room_scope_matches=${yn(input.comparison.roomScopeMatches)}`,
          `- night_scope_matches=${yn(input.comparison.nightScopeMatches)}`,
          `- tax_included_confirmed=${yn(input.comparison.taxIncludedConfirmed)}`
        ]
      : ["- comparison unavailable"]),
    "",
    "## 5. Safety confirmation",
    "",
    "- Read-only page inspection; no login, no cookie injection, no personal data entry, no booking/payment confirmation, no paid APIs/proxies, no stealth, no CAPTCHA bypass.",
    "- Unsafe or ambiguous reservation-adjacent buttons are recorded, not clicked.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 6. Recommended next action",
    "",
    input.decision === "rakuten_price_basis_confirmed"
      ? "- Proceed to Phase 66X: limited read-only Rakuten collector prototype, local output only."
      : input.decision === "rakuten_price_basis_requires_different_public_endpoint"
        ? "- Proceed to Phase 65Z: one-call public endpoint replay for the identified condition/price path, no DB writes."
        : "- Do not guess. Either perform a manual screenshot/HTML review or proceed with a conservative Rakuten basis flag if product risk is acceptable.",
    "",
    `CSV: ${input.csvPath}`,
    `Debug: ${input.debugRootPath}`,
    ""
  ].join("\n");
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const normalized = text.replace(/\s+/gu, " ");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const value = (match[0] ?? "").trim();
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= 10) break;
  }
  return out;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

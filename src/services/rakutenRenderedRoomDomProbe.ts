// Phase RAKUTEN-ROOM04X — Lucent rendered DOM feasibility probe + Rakuten Go/No-Go.
//
// Pure analysis layer for a single rendered (Playwright) Lucent Rakuten
// room-list page. Given the rendered DOM (HTML + visible text + links + script
// state), it extracts room identifier candidates, decides whether stable
// identifiers (f_syu / room detail URLs / plan IDs) were exposed, and produces a
// Rakuten Go / No-Go prioritization decision.
//
// This module does NOT launch a browser, call /hplan/calendar, follow room/plan
// detail links, write DB rows, mutate history, refresh AI context, run
// collectors, use stealth/cookie/login, or use any paid-source tooling. All of
// those are out of scope for both this module and its orchestrating script.

import {
  evaluateSingleContextSoldOut,
  extractRakutenLinks,
  htmlToVisibleText,
  parseRakutenHotelNoFromUrl,
  type ParsedRakutenLink,
  type RakutenSoldOutGuard
} from "./rakutenRoomTypeLearning";

export const ROOM01X_ARTIFACT_PATH =
  ".data/reports/source-discovery/rakuten_room_type_learning_20260604_111400.json";
export const ROOM02X_ARTIFACT_PATH =
  ".data/reports/source-discovery/rakuten_room_list_learning_20260604_112335.json";
export const ROOM03X_ARTIFACT_PATH =
  ".data/reports/source-discovery/rakuten_room_detail_learning_proposal_20260604_113046.json";

export const LUCENT_CANONICAL_PROPERTY_NAME = "名湯リゾート ルーセント";
export const LUCENT_RAKUTEN_HOTEL_NO = "39565";

// AUTO08X used these f_syu values as if they were property-level. They must NOT
// be treated as freshly learned identifiers unless they appear in rendered DOM.
export const KNOWN_BUG_F_SYU_VALUES = ["honkan-exk", "00"] as const;

export type RakutenRenderedRoomDomDecision =
  | "rakuten_rendered_room_dom_probe_ready"
  | "rakuten_rendered_room_dom_probe_basis_caution"
  | "rakuten_rendered_room_dom_probe_not_ready";

export type RakutenPriorityDecision =
  | "GO_FOR_ROOM_MASTER_BUILD"
  | "CONDITIONAL_CONTINUE"
  | "NO_GO_FREEZE_RAKUTEN";

export type RakutenRenderedCandidateType =
  | "room_detail_link"
  | "plan_link"
  | "room_card"
  | "data_attribute"
  | "script_state"
  | "text_only"
  | "unknown";

export type RakutenRenderedConfidence = "A" | "B" | "C";

export type RakutenLearnedFrom =
  | "learned_from_rendered_dom"
  | "known_from_previous_bug_artifact"
  | "requires_follow_up";

export interface Room02xArtifactLike {
  decision?: string;
  room_list_url?: string;
  hotel_context?: {
    canonical_property_name?: string;
    rakuten_hotel_no?: string;
    source_url?: string;
  };
}

export interface RenderedDataAttribute {
  name: string;
  value: string;
  looks_like_room_id: boolean;
}

export interface RenderedScriptStateCandidate {
  key: string;
  value: string;
  evidence: string;
}

export interface BlockedOrCaptchaState {
  blocked: boolean;
  captcha_detected: boolean;
  http_forbidden: boolean;
  consent_wall_detected: boolean;
  signals: string[];
}

export interface RenderedRoomDomInput {
  loaded: boolean;
  httpStatus: number;
  finalUrl: string;
  pageTitle: string;
  bodyText: string;
  bodyHtml: string;
  sourceUrl: string;
  error?: string;
}

export interface RenderedRoomDomSignals {
  loaded: boolean;
  httpStatus: number;
  finalUrl: string;
  pageTitle: string;
  bodyTextLength: number;
  hotelNo: string;
  hotelNameDetected: boolean;
  links: ParsedRakutenLink[];
  roomDetailLinks: ParsedRakutenLink[];
  planLinks: ParsedRakutenLink[];
  fSyuValues: string[];
  fCampIdValues: string[];
  planIdValues: string[];
  roomNames: string[];
  dataAttributes: RenderedDataAttribute[];
  scriptStateCandidates: RenderedScriptStateCandidate[];
  blocked: BlockedOrCaptchaState;
  error: string;
}

export interface RakutenRenderedRoomDomCandidate {
  canonical_property_name: string;
  rakuten_hotel_no: string;
  source_url: string;
  candidate_room_name: string;
  candidate_url: string;
  candidate_type: RakutenRenderedCandidateType;
  visible_f_syu: string;
  visible_f_camp_id: string;
  visible_plan_id: string;
  visible_data_attributes: string;
  learned_from: RakutenLearnedFrom;
  confidence: RakutenRenderedConfidence;
  recommended_next_action: string;
  extraction_warning: string;
}

export interface RakutenRenderedRoomDomResult {
  run_id: string;
  generated_at_jst: string;
  decision: RakutenRenderedRoomDomDecision;
  rakuten_priority_decision: RakutenPriorityDecision;
  source_room01x_artifact: string;
  source_room02x_artifact: string;
  source_room03x_artifact: string;
  probe_target_url: string;
  rendered_page_status: {
    loaded: boolean;
    http_status: number;
    final_url: string;
    page_title: string;
    body_text_length: number;
    error: string;
  };
  hotel_context: {
    canonical_property_name: string;
    rakuten_hotel_no: string;
    hotel_name_detected: boolean;
  };
  room_identifier_candidates: RakutenRenderedRoomDomCandidate[];
  f_syu_values: string[];
  f_camp_id_values: string[];
  plan_id_values: string[];
  data_attribute_count: number;
  script_state_candidate_count: number;
  blocked_or_captcha: BlockedOrCaptchaState;
  sold_out_semantics_guard: RakutenSoldOutGuard;
  strategic_recommendation: string[];
  recommended_next_action: string;
  extraction_warnings: string[];
  safety_confirmation: Record<string, boolean>;
}

export const RAKUTEN_RENDERED_ROOM_DOM_CSV_HEADERS = [
  "canonical_property_name",
  "rakuten_hotel_no",
  "source_url",
  "candidate_room_name",
  "candidate_url",
  "candidate_type",
  "visible_f_syu",
  "visible_f_camp_id",
  "visible_plan_id",
  "visible_data_attributes",
  "learned_from",
  "confidence",
  "recommended_next_action",
  "extraction_warning"
] as const;

const ROOM_NAME_PATTERN =
  /(?:禁煙|喫煙|和室|洋室|和洋室|ツイン|ダブル|シングル|スイート|ベッド|客室|倶楽部ルーム|クラブルーム|バス付|本館|別館|ゲスト棟|南館|離れ|ジャグジー)/u;

const GENERIC_TEXT = new Set([
  "部屋一覧",
  "宿泊",
  "プラン一覧",
  "詳細",
  "予約",
  "予約する",
  "空室カレンダー",
  "詳細を見る"
]);

export function extractProbeTargetUrl(artifact: Room02xArtifactLike): string {
  const direct = artifact.room_list_url ?? artifact.hotel_context?.source_url ?? "";
  if (isRoomListUrl(direct)) return direct;
  return "";
}

export function parseRenderedLinks(html: string, baseUrl: string): ParsedRakutenLink[] {
  return extractRakutenLinks(html, baseUrl);
}

export function extractFSyuFromLinks(links: ParsedRakutenLink[]): string[] {
  return uniqueNonEmpty(links.map((link) => link.f_syu));
}

export function extractFCampIdFromLinks(links: ParsedRakutenLink[]): string[] {
  return uniqueNonEmpty(links.map((link) => link.f_camp_id));
}

export function extractPlanIdsFromLinks(links: ParsedRakutenLink[]): string[] {
  const ids: string[] = [];
  for (const link of links) {
    const planId = planIdFromUrl(link.absolute_url);
    if (planId) ids.push(planId);
  }
  return uniqueNonEmpty(ids);
}

export function extractRoomNamesFromDom(html: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const text = htmlToVisibleText(html);
  for (const rawLine of text.split(/\n| {2,}/u)) {
    const name = roomNameFromText(rawLine);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function extractDataAttributes(html: string): RenderedDataAttribute[] {
  const out: RenderedDataAttribute[] = [];
  const seen = new Set<string>();
  const attrRe = /\bdata-([a-z0-9-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
  for (const match of html.matchAll(attrRe)) {
    const name = `data-${match[1] ?? ""}`;
    const value = (match[2] ?? match[3] ?? "").trim();
    if (!value) continue;
    const key = `${name}\n${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      value,
      looks_like_room_id: looksLikeRoomId(name, value)
    });
  }
  return out;
}

export function extractScriptStateCandidates(html: string): RenderedScriptStateCandidate[] {
  const out: RenderedScriptStateCandidate[] = [];
  const seen = new Set<string>();
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/giu;
  const keyRe = /["']?(f_syu|f_camp_id|f_no|roomTypeId|roomId|planId|room_type_id|plan_id|heyaCode)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{1,64})["']?/giu;
  for (const scriptMatch of html.matchAll(scriptRe)) {
    const body = scriptMatch[1] ?? "";
    for (const m of body.matchAll(keyRe)) {
      const key = m[1] ?? "";
      const value = m[2] ?? "";
      if (!key || !value) continue;
      const dedupe = `${key}\n${value}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const start = Math.max(0, (m.index ?? 0) - 40);
      const end = Math.min(body.length, (m.index ?? 0) + (m[0]?.length ?? 0) + 40);
      out.push({
        key,
        value,
        evidence: body.slice(start, end).replace(/\s+/gu, " ").trim()
      });
    }
  }
  return out;
}

export function detectBlockedOrCaptcha(input: {
  loaded: boolean;
  httpStatus: number;
  bodyText: string;
  pageTitle: string;
  error?: string;
}): BlockedOrCaptchaState {
  const text = `${input.pageTitle}\n${input.bodyText}`;
  const signals: string[] = [];
  const captcha = /(captcha|recaptcha|hcaptcha|are you a robot|ロボットではありません|画像認証|セキュリティチェック|不正なアクセス)/iu.test(text);
  const forbidden = input.httpStatus === 403 || input.httpStatus === 429 || /access denied|forbidden|アクセスが拒否/iu.test(text);
  const consent = /(同意して進む|cookieの利用|プライバシー設定に同意|consent|同意します)/iu.test(text) && input.bodyText.length < 1_500;
  if (captcha) signals.push("captcha/security challenge text detected");
  if (forbidden) signals.push(`http forbidden/limited status=${input.httpStatus}`);
  if (consent) signals.push("consent/cookie wall blocking content");
  if (!input.loaded) signals.push("page did not load");
  if (input.error) signals.push(`navigation error: ${input.error}`);
  return {
    blocked: captcha || forbidden || consent || !input.loaded,
    captcha_detected: captcha,
    http_forbidden: forbidden,
    consent_wall_detected: consent,
    signals
  };
}

export function analyzeRenderedRoomDom(input: RenderedRoomDomInput): RenderedRoomDomSignals {
  const html = input.bodyHtml ?? "";
  const links = parseRenderedLinks(html, input.sourceUrl);
  const roomDetailLinks = links.filter(
    (link) => /\/hotelinfo\/room\/\d+/u.test(link.absolute_url) && !link.absolute_url.includes("/hplan/calendar/")
  );
  const planLinks = links.filter(
    (link) => /\/hotelinfo\/plan\/\d+\//u.test(link.absolute_url) && !link.absolute_url.includes("/hplan/calendar/")
  );
  const visibleText = htmlToVisibleText(html) || input.bodyText;
  return {
    loaded: input.loaded,
    httpStatus: input.httpStatus,
    finalUrl: input.finalUrl,
    pageTitle: input.pageTitle,
    bodyTextLength: visibleText.length,
    hotelNo: parseRakutenHotelNoFromUrl(input.finalUrl) || parseRakutenHotelNoFromUrl(input.sourceUrl),
    hotelNameDetected: /ルーセント|蔵王/u.test(`${input.pageTitle}\n${visibleText}`),
    links,
    roomDetailLinks,
    planLinks,
    fSyuValues: extractFSyuFromLinks(links),
    fCampIdValues: extractFCampIdFromLinks(links),
    planIdValues: extractPlanIdsFromLinks(links),
    roomNames: extractRoomNamesFromDom(html),
    dataAttributes: extractDataAttributes(html),
    scriptStateCandidates: extractScriptStateCandidates(html),
    blocked: detectBlockedOrCaptcha({
      loaded: input.loaded,
      httpStatus: input.httpStatus,
      bodyText: input.bodyText,
      pageTitle: input.pageTitle,
      error: input.error ?? ""
    }),
    error: input.error ?? ""
  };
}

export function classifyLearnedFrom(value: string, presentInRenderedDom: boolean): RakutenLearnedFrom {
  // A known-bad AUTO08X f_syu value only counts as learned if it actually
  // appears in the rendered DOM; otherwise it is flagged as bug-artifact lineage.
  if (presentInRenderedDom) return "learned_from_rendered_dom";
  if ((KNOWN_BUG_F_SYU_VALUES as readonly string[]).includes(value)) return "known_from_previous_bug_artifact";
  return "requires_follow_up";
}

export function buildRoomIdentifierCandidates(signals: RenderedRoomDomSignals): RakutenRenderedRoomDomCandidate[] {
  const candidates: RakutenRenderedRoomDomCandidate[] = [];
  const seen = new Set<string>();
  const hotelNo = signals.hotelNo || LUCENT_RAKUTEN_HOTEL_NO;

  const push = (candidate: RakutenRenderedRoomDomCandidate): void => {
    const key = [candidate.candidate_room_name, candidate.candidate_url, candidate.candidate_type, candidate.visible_f_syu].join("\n");
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const link of signals.roomDetailLinks) {
    const roomName = roomNameFromText(link.text);
    push(
      buildCandidate({
        hotelNo,
        sourceUrl: signals.finalUrl,
        roomName,
        candidateUrl: link.absolute_url,
        candidateType: "room_detail_link",
        fSyu: link.f_syu,
        fCampId: link.f_camp_id,
        planId: "",
        dataAttrs: ""
      })
    );
  }

  for (const link of signals.planLinks) {
    const roomName = roomNameFromText(link.text);
    const planId = planIdFromUrl(link.absolute_url);
    push(
      buildCandidate({
        hotelNo,
        sourceUrl: signals.finalUrl,
        roomName,
        candidateUrl: link.absolute_url,
        candidateType: "plan_link",
        fSyu: link.f_syu,
        fCampId: link.f_camp_id,
        planId,
        dataAttrs: ""
      })
    );
  }

  for (const attr of signals.dataAttributes.filter((a) => a.looks_like_room_id)) {
    push(
      buildCandidate({
        hotelNo,
        sourceUrl: signals.finalUrl,
        roomName: "",
        candidateUrl: "",
        candidateType: "data_attribute",
        fSyu: "",
        fCampId: "",
        planId: "",
        dataAttrs: `${attr.name}=${attr.value}`
      })
    );
  }

  for (const state of signals.scriptStateCandidates) {
    push(
      buildCandidate({
        hotelNo,
        sourceUrl: signals.finalUrl,
        roomName: "",
        candidateUrl: "",
        candidateType: "script_state",
        fSyu: state.key === "f_syu" ? state.value : "",
        fCampId: state.key === "f_camp_id" ? state.value : "",
        planId: state.key === "planId" || state.key === "plan_id" ? state.value : "",
        dataAttrs: `${state.key}=${state.value}`
      })
    );
  }

  // Text-only room names that were not already covered by a link/card.
  const namedAlready = new Set(candidates.map((c) => c.candidate_room_name).filter(Boolean));
  for (const roomName of signals.roomNames) {
    if (namedAlready.has(roomName)) continue;
    push(
      buildCandidate({
        hotelNo,
        sourceUrl: signals.finalUrl,
        roomName,
        candidateUrl: "",
        candidateType: "text_only",
        fSyu: "",
        fCampId: "",
        planId: "",
        dataAttrs: ""
      })
    );
  }

  return candidates;
}

export function classifyCandidateConfidence(candidate: {
  candidate_room_name: string;
  candidate_url: string;
  visible_f_syu: string;
}): RakutenRenderedConfidence {
  if (candidate.candidate_room_name && candidate.visible_f_syu) return "A";
  if (candidate.candidate_room_name && candidate.candidate_url) return "B";
  return "C";
}

export function decideRakutenRenderedRoomDom(input: {
  signals: RenderedRoomDomSignals;
  candidates: RakutenRenderedRoomDomCandidate[];
}): RakutenRenderedRoomDomDecision {
  if (input.signals.blocked.blocked || input.signals.bodyTextLength < 300) {
    return "rakuten_rendered_room_dom_probe_not_ready";
  }
  if (input.candidates.some((c) => c.confidence === "A" && c.learned_from === "learned_from_rendered_dom")) {
    return "rakuten_rendered_room_dom_probe_ready";
  }
  return "rakuten_rendered_room_dom_probe_basis_caution";
}

export function decideRakutenPriority(input: {
  decision: RakutenRenderedRoomDomDecision;
  signals: RenderedRoomDomSignals;
  candidates: RakutenRenderedRoomDomCandidate[];
  forbiddenMethodUsed: boolean;
}): RakutenPriorityDecision {
  if (input.signals.blocked.blocked || input.forbiddenMethodUsed) return "NO_GO_FREEZE_RAKUTEN";
  const hasStableIdentifier = input.candidates.some(
    (c) => c.confidence === "A" && c.learned_from === "learned_from_rendered_dom"
  );
  if (hasStableIdentifier && input.decision === "rakuten_rendered_room_dom_probe_ready") {
    return "GO_FOR_ROOM_MASTER_BUILD";
  }
  const hasUniqueUrlOrScriptHint =
    input.candidates.some((c) => c.candidate_url && (c.candidate_type === "room_detail_link" || c.candidate_type === "plan_link")) ||
    input.signals.scriptStateCandidates.length > 0;
  if (hasUniqueUrlOrScriptHint) return "CONDITIONAL_CONTINUE";
  return "NO_GO_FREEZE_RAKUTEN";
}

export function recommendedNextActionForPriority(priority: RakutenPriorityDecision): string {
  if (priority === "GO_FOR_ROOM_MASTER_BUILD") {
    return "RAKUTEN-ROOM05X — Build Lucent room_type_master from rendered DOM identifiers. Do not start without explicit instruction.";
  }
  if (priority === "CONDITIONAL_CONTINUE") {
    return "Produce a proposal for 1–3 bounded follow-up pages only. Do not proceed automatically.";
  }
  return "Freeze Rakuten room-mapping work. Redirect effort to Jalan daily accumulation, Booking.com B05X / broader normalized collection, and DB mirror + AI context refresh automation.";
}

export function buildSoldOutSemanticsGuard(): RakutenSoldOutGuard {
  return evaluateSingleContextSoldOut({
    f_syu: "rendered_or_future_f_syu",
    room_name: "rendered_or_future_room_name",
    known_context_count: 1,
    all_known_contexts_full: false,
    plan_list_no_availability: false,
    explicit_property_no_vacancy: false
  });
}

export function strategicRecommendation(): string[] {
  return [
    "Rakuten is useful only if stable room identifiers can be learned cheaply and safely.",
    "If this probe does not expose stable identifiers, continuing to dig through Rakuten is lower ROI than accelerating Jalan + Booking.com automation.",
    "Jalan remains the strongest domestic/direct-capable source.",
    "Booking.com remains the stronger near-term source for inbound/directional pricing signals.",
    "Jalan + Booking.com together cover the major domestic/inbound demand signals (core decision-support signals).",
    "Rakuten should be frozen if this probe cannot identify stable room context."
  ];
}

export function buildRakutenRenderedRoomDomResult(input: {
  runId: string;
  generatedAtJst: string;
  room02xArtifact: Room02xArtifactLike;
  probeTargetUrl: string;
  rendered: RenderedRoomDomInput;
  forbiddenMethodUsed?: boolean;
}): RakutenRenderedRoomDomResult {
  const signals = analyzeRenderedRoomDom(input.rendered);
  const candidates = buildRoomIdentifierCandidates(signals);
  const decision = decideRakutenRenderedRoomDom({ signals, candidates });
  const priority = decideRakutenPriority({
    decision,
    signals,
    candidates,
    forbiddenMethodUsed: input.forbiddenMethodUsed ?? false
  });
  const canonicalName =
    input.room02xArtifact.hotel_context?.canonical_property_name ?? LUCENT_CANONICAL_PROPERTY_NAME;
  const hotelNo = signals.hotelNo || input.room02xArtifact.hotel_context?.rakuten_hotel_no || LUCENT_RAKUTEN_HOTEL_NO;
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision,
    rakuten_priority_decision: priority,
    source_room01x_artifact: ROOM01X_ARTIFACT_PATH,
    source_room02x_artifact: ROOM02X_ARTIFACT_PATH,
    source_room03x_artifact: ROOM03X_ARTIFACT_PATH,
    probe_target_url: input.probeTargetUrl,
    rendered_page_status: {
      loaded: signals.loaded,
      http_status: signals.httpStatus,
      final_url: signals.finalUrl,
      page_title: signals.pageTitle,
      body_text_length: signals.bodyTextLength,
      error: signals.error
    },
    hotel_context: {
      canonical_property_name: canonicalName,
      rakuten_hotel_no: hotelNo,
      hotel_name_detected: signals.hotelNameDetected
    },
    room_identifier_candidates: candidates,
    f_syu_values: signals.fSyuValues,
    f_camp_id_values: signals.fCampIdValues,
    plan_id_values: signals.planIdValues,
    data_attribute_count: signals.dataAttributes.length,
    script_state_candidate_count: signals.scriptStateCandidates.length,
    blocked_or_captcha: signals.blocked,
    sold_out_semantics_guard: buildSoldOutSemanticsGuard(),
    strategic_recommendation: strategicRecommendation(),
    recommended_next_action: recommendedNextActionForPriority(priority),
    extraction_warnings: buildExtractionWarnings(signals, candidates),
    safety_confirmation: {
      db_writes: false,
      history_modified: false,
      ai_context_refreshed: false,
      broad_collector_run: false,
      hplan_calendar_called: false,
      room_detail_link_followed: false,
      plan_detail_link_followed: false,
      stealth_or_cookie_or_login_used: false,
      captcha_bypass_attempted: false,
      paid_source_tooling_used: false,
      booking_used: false,
      single_page_only: true
    }
  };
}

export function renderRakutenRenderedRoomDomCsv(result: RakutenRenderedRoomDomResult): string {
  const lines = [RAKUTEN_RENDERED_ROOM_DOM_CSV_HEADERS.join(",")];
  for (const row of result.room_identifier_candidates) {
    lines.push(
      RAKUTEN_RENDERED_ROOM_DOM_CSV_HEADERS.map((key) =>
        csvEscape(String(row[key as keyof RakutenRenderedRoomDomCandidate] ?? ""))
      ).join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderRakutenRenderedRoomDomReport(result: RakutenRenderedRoomDomResult): string {
  const guard = result.sold_out_semantics_guard;
  return [
    "# Rakuten Rendered Room DOM Feasibility Probe (Phase RAKUTEN-ROOM04X)",
    "",
    `Generated at: ${result.generated_at_jst}`,
    `Decision: ${result.decision}`,
    `Rakuten priority decision: ${result.rakuten_priority_decision}`,
    "",
    "## 1. Summary",
    `- decision = ${result.decision}`,
    `- rakuten_priority_decision = ${result.rakuten_priority_decision}`,
    `- probe_target_url = ${result.probe_target_url || "(missing)"}`,
    `- room_identifier_candidates = ${result.room_identifier_candidates.length}`,
    `- f_syu_values = ${result.f_syu_values.join(", ") || "(none)"}`,
    `- f_camp_id_values = ${result.f_camp_id_values.join(", ") || "(none)"}`,
    `- plan_id_values = ${result.plan_id_values.join(", ") || "(none)"}`,
    "",
    "## 2. Source artifacts",
    `- ROOM01X = ${result.source_room01x_artifact}`,
    `- ROOM02X = ${result.source_room02x_artifact}`,
    `- ROOM03X = ${result.source_room03x_artifact}`,
    "",
    "## 3. Rendered page status",
    `- loaded = ${result.rendered_page_status.loaded}`,
    `- http_status = ${result.rendered_page_status.http_status}`,
    `- final_url = ${result.rendered_page_status.final_url}`,
    `- page_title = ${result.rendered_page_status.page_title}`,
    `- body_text_length = ${result.rendered_page_status.body_text_length}`,
    `- error = ${result.rendered_page_status.error || "(none)"}`,
    "",
    "## 4. Room identifier candidates",
    ...(result.room_identifier_candidates.length === 0
      ? ["- none"]
      : result.room_identifier_candidates
          .slice(0, 40)
          .map(
            (c) =>
              `- ${c.candidate_room_name || "(no room name)"} | type=${c.candidate_type} | url=${c.candidate_url || "(none)"} | f_syu=${c.visible_f_syu || "(none)"} | learned_from=${c.learned_from} | confidence=${c.confidence}`
          )),
    "",
    "## 5. f_syu / f_camp_id / plan candidates",
    `- f_syu = ${result.f_syu_values.join(", ") || "(none)"}`,
    `- f_camp_id = ${result.f_camp_id_values.join(", ") || "(none)"}`,
    `- plan_id = ${result.plan_id_values.join(", ") || "(none)"}`,
    `- data_attribute_count = ${result.data_attribute_count}`,
    `- script_state_candidate_count = ${result.script_state_candidate_count}`,
    "",
    "## 6. Block / CAPTCHA assessment",
    `- blocked = ${result.blocked_or_captcha.blocked}`,
    `- captcha_detected = ${result.blocked_or_captcha.captcha_detected}`,
    `- http_forbidden = ${result.blocked_or_captcha.http_forbidden}`,
    `- consent_wall_detected = ${result.blocked_or_captcha.consent_wall_detected}`,
    ...result.blocked_or_captcha.signals.map((s) => `- signal: ${s}`),
    "",
    "## 7. Rakuten Go / No-Go decision",
    `- rakuten_priority_decision = ${result.rakuten_priority_decision}`,
    `- recommended_next_action = ${result.recommended_next_action}`,
    "",
    "## Strategic Recommendation: Rakuten vs Jalan / Booking.com",
    ...result.strategic_recommendation.map((line) => `- ${line}`),
    "",
    "## 8. Sold-out semantics guard",
    "- Even if rendered DOM exposes f_syu, this still only enables room-context calendar collection.",
    "- It does not allow property-level sold_out inference from one f_syu.",
    `- classification_for_single_full_context = ${guard.classification_for_single_full_context}`,
    `- property_level_sold_out = ${guard.property_level_sold_out}`,
    `- usable_for_property_sold_out_pressure = ${guard.usable_for_property_sold_out_pressure}`,
    ...guard.property_level_requirements.map((r) => `- property_level_requirement: ${r}`),
    "",
    "## 9. Extraction warnings",
    ...(result.extraction_warnings.length === 0 ? ["- none"] : result.extraction_warnings.map((w) => `- ${w}`)),
    "",
    "## 10. Safety confirmation",
    ...Object.entries(result.safety_confirmation).map(([key, value]) => `- ${key} = ${value}`),
    ""
  ].join("\n");
}

function buildCandidate(input: {
  hotelNo: string;
  sourceUrl: string;
  roomName: string;
  candidateUrl: string;
  candidateType: RakutenRenderedCandidateType;
  fSyu: string;
  fCampId: string;
  planId: string;
  dataAttrs: string;
}): RakutenRenderedRoomDomCandidate {
  const presentInRenderedDom = Boolean(input.fSyu);
  const learnedFrom = input.fSyu
    ? classifyLearnedFrom(input.fSyu, presentInRenderedDom)
    : input.candidateUrl || input.dataAttrs
      ? "learned_from_rendered_dom"
      : "requires_follow_up";
  const confidence = classifyCandidateConfidence({
    candidate_room_name: input.roomName,
    candidate_url: input.candidateUrl,
    visible_f_syu: input.fSyu
  });
  return {
    canonical_property_name: LUCENT_CANONICAL_PROPERTY_NAME,
    rakuten_hotel_no: input.hotelNo,
    source_url: input.sourceUrl,
    candidate_room_name: input.roomName,
    candidate_url: input.candidateUrl,
    candidate_type: input.candidateType,
    visible_f_syu: input.fSyu,
    visible_f_camp_id: input.fCampId,
    visible_plan_id: input.planId,
    visible_data_attributes: input.dataAttrs,
    learned_from: learnedFrom,
    confidence,
    recommended_next_action:
      confidence === "A"
        ? "Usable as a stable room identifier candidate for room_type_master (still room-context only)."
        : confidence === "B"
          ? "Unique URL found but no f_syu; would require a bounded follow-up to confirm a stable identifier."
          : "Text-only candidate; not a stable identifier. Do not invent f_syu.",
    extraction_warning:
      input.fSyu
        ? ""
        : "f_syu not visible in rendered DOM for this candidate; do not invent it."
  };
}

function buildExtractionWarnings(
  signals: RenderedRoomDomSignals,
  candidates: RakutenRenderedRoomDomCandidate[]
): string[] {
  const warnings: string[] = [];
  if (signals.error) warnings.push(signals.error);
  if (signals.blocked.blocked) warnings.push("Rendered page was blocked/limited; results may be incomplete.");
  if (!signals.hotelNo) warnings.push("hotelNo 39565 was not detected from rendered final URL.");
  if (signals.fSyuValues.length === 0) warnings.push("No f_syu values visible in rendered DOM; do not invent f_syu.");
  if (candidates.every((c) => c.confidence !== "A")) warnings.push("No confidence-A (room name + f_syu) candidate was learned from rendered DOM.");
  if (candidates.length === 0) warnings.push("No room identifier candidates were extracted from rendered DOM.");
  return warnings;
}

function roomNameFromText(value: string): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (!cleaned || GENERIC_TEXT.has(cleaned)) return "";
  if (!ROOM_NAME_PATTERN.test(cleaned)) return "";
  return cleaned
    .replace(/この部屋で選択できる宿泊プラン|宿泊プラン一覧|空室カレンダー|詳細を見る|予約する/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function looksLikeRoomId(name: string, value: string): boolean {
  if (/room|heya|syu|type|plan|camp/iu.test(name)) return true;
  if (/^[A-Za-z0-9]{2,}-[A-Za-z0-9-]+$/u.test(value) && /room|syu|plan/iu.test(name)) return true;
  return false;
}

function planIdFromUrl(url: string): string {
  const parsed = safeUrl(url);
  if (!parsed) return "";
  return (
    parsed.searchParams.get("f_plan_id") ??
    parsed.searchParams.get("f_plan") ??
    parsed.pathname.match(/\/hotelinfo\/plan\/\d+\/([A-Za-z0-9_-]+)/u)?.[1] ??
    ""
  );
}

function isRoomListUrl(url: string): boolean {
  const parsed = safeUrl(url);
  return parsed?.searchParams.get("f_flg") === "ROOM" || /\/hotelinfo\/room\/\d+/u.test(url);
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter((value) => value && value.trim() !== ""))];
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/u.test(value)) return value;
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

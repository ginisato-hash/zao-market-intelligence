// Phase RAKUTEN-ROOM01X — Rakuten room-type learning.
//
// Read-only discovery helpers for learning Rakuten plan-list / room-list
// structure before any calendar collection. This module does not write DB rows,
// mutate history, refresh AI context, run broad collectors, or use Playwright.

export type RakutenRoomTypeLearningDecision =
  | "rakuten_room_type_learning_ready"
  | "rakuten_room_type_learning_basis_caution"
  | "rakuten_room_type_learning_not_ready";

export type RakutenContextType =
  | "property_level"
  | "room_type_level"
  | "f_syu_level"
  | "plan_level"
  | "campaign_level"
  | "unknown";

export type RakutenRoomTypeConfidence = "A" | "B" | "C";

export interface ParsedRakutenLink {
  text: string;
  href: string;
  absolute_url: string;
  f_syu: string;
  f_camp_id: string;
}

export interface RakutenRoomTypeCandidate {
  detected_room_name: string;
  normalized_room_name: string;
  source: "link_text" | "visible_text";
  evidence: string;
  confidence: RakutenRoomTypeConfidence;
  warning: string;
}

export interface RakutenPlanCandidate {
  plan_name: string;
  plan_url: string;
  f_syu: string;
  f_camp_id: string;
  detected_room_name: string;
  confidence: RakutenRoomTypeConfidence;
  evidence: string;
  warning: string;
}

export interface RakutenParamCandidate {
  param_name: "f_syu" | "f_camp_id";
  value: string;
  source_url: string;
  link_text: string;
}

export interface RakutenRoomTypeMasterRow {
  canonical_property_name: string;
  rakuten_hotel_no: string;
  source_page_type: string;
  source_url: string;
  detected_room_name: string;
  normalized_room_name: string;
  f_syu: string;
  f_camp_id: string;
  plan_name: string;
  plan_url: string;
  room_url: string;
  context_type: RakutenContextType;
  confidence: RakutenRoomTypeConfidence;
  evidence: string;
  first_seen_at_jst: string;
  last_seen_at_jst: string;
  extraction_warning: string;
}

export interface RakutenHotelContext {
  canonical_property_name: string;
  rakuten_hotel_no: string;
  hotel_name: string;
  source_url: string;
  source_page_type: string;
  plan_list_context_detected: boolean;
  plan_list_signals: string[];
  room_list_link: string;
  room_list_link_text: string;
}

export interface RakutenSoldOutGuard {
  calendar_context_type: RakutenContextType;
  classification_for_single_full_context: string;
  property_level_sold_out: boolean;
  usable_for_property_sold_out_pressure: boolean;
  property_level_requirements: string[];
}

export interface RakutenRoomTypeLearningResult {
  run_id: string;
  generated_at_jst: string;
  decision: RakutenRoomTypeLearningDecision;
  source_url: string;
  hotel_context: RakutenHotelContext;
  parsed_links: ParsedRakutenLink[];
  room_type_candidates: RakutenRoomTypeCandidate[];
  plan_candidates: RakutenPlanCandidate[];
  f_syu_candidates: RakutenParamCandidate[];
  f_camp_id_candidates: RakutenParamCandidate[];
  room_type_master_preview: RakutenRoomTypeMasterRow[];
  sold_out_semantics_guard: RakutenSoldOutGuard;
  auto08x_bug_prevention_statement: string[];
  extraction_warnings: string[];
  safety_confirmation: Record<string, boolean>;
}

export const RAKUTEN_ROOM_TYPE_MASTER_COLUMNS = [
  "canonical_property_name",
  "rakuten_hotel_no",
  "source_page_type",
  "source_url",
  "detected_room_name",
  "normalized_room_name",
  "f_syu",
  "f_camp_id",
  "plan_name",
  "plan_url",
  "room_url",
  "context_type",
  "confidence",
  "evidence",
  "first_seen_at_jst",
  "last_seen_at_jst",
  "extraction_warning"
];

const ROOM_TEXT_PATTERNS = [
  /(?:禁煙|喫煙|和室|洋室|和洋室|ツイン|ダブル|シングル|スイート|ベッド|客室|倶楽部ルーム|クラブルーム|バス付|本館|別館|ゲスト棟|南館)/u
];

const GENERIC_LINK_TEXT = new Set([
  "詳細",
  "予約",
  "予約する",
  "プラン一覧",
  "宿泊プラン一覧",
  "部屋一覧",
  "ホテル・旅館の宿泊予約",
  "トップ"
]);

export function parseRakutenHotelNoFromUrl(url: string): string {
  const pathMatch = url.match(/\/hotelinfo\/(?:plan|room)\/(\d+)/u);
  if (pathMatch?.[1]) return pathMatch[1];
  const parsed = safeUrl(url);
  return parsed?.searchParams.get("f_no") ?? parsed?.searchParams.get("f_hotel_no") ?? "";
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

export function htmlToVisibleText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|tr|h1|h2|h3|section)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[ \t\r\f\v]+/gu, " ")
    .replace(/\n\s+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function normalizeRoomName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(/[【】\[\]「」]/gu, "")
    .replace(/※/gu, "")
    .replace(/／/gu, "/")
    .trim();
}

export function extractRakutenLinks(html: string, baseUrl: string): ParsedRakutenLink[] {
  const links: ParsedRakutenLink[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(anchorRe)) {
    const attrs = match[1] ?? "";
    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu);
    if (!hrefMatch) continue;
    const href = decodeHtmlEntities(hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "").trim();
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) continue;
    const absolute = toAbsoluteUrl(href, baseUrl);
    if (!absolute) continue;
    const text = htmlToVisibleText(match[2] ?? "").replace(/\s+/gu, " ").trim();
    const parsed = safeUrl(absolute);
    const key = `${absolute}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      text,
      href,
      absolute_url: absolute,
      f_syu: parsed?.searchParams.get("f_syu") ?? "",
      f_camp_id: parsed?.searchParams.get("f_camp_id") ?? ""
    });
  }
  return links;
}

export function detectHotelName(html: string, visibleText = htmlToVisibleText(html)): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/iu)?.[1];
  const candidates = [h1, title, ...visibleText.split(/\n/gu).slice(0, 12)]
    .filter((x): x is string => Boolean(x))
    .map((x) => htmlToVisibleText(x).replace(/宿泊プラン一覧|宿泊予約|楽天トラベル|ホテル・旅館の宿泊予約/gu, "").trim())
    .filter((x) => /ルーセント|蔵王|ホテル|旅館|温泉/u.test(x));
  return candidates[0] ?? "";
}

export function detectPlanListContext(html: string, sourceUrl: string): { detected: boolean; signals: string[]; sourcePageType: string } {
  const text = htmlToVisibleText(html);
  const signals: string[] = [];
  if (/\/hotelinfo\/plan\/\d+/u.test(sourceUrl)) signals.push("URL path is /hotelinfo/plan/{hotelNo}");
  if (text.includes("宿泊プラン一覧")) signals.push("visible text contains 宿泊プラン一覧");
  if (text.includes("合計料金")) signals.push("visible text contains 合計料金");
  if (text.includes("1部屋あたりの税込金額")) signals.push("visible text contains 1部屋あたりの税込金額");
  if (sourceUrl.includes("f_camp_id=&") || sourceUrl.endsWith("f_camp_id=")) signals.push("plan-list search context has f_camp_id empty");
  return {
    detected: signals.some((s) => s.includes("/hotelinfo/plan")) && signals.length >= 2,
    signals,
    sourcePageType: signals.some((s) => s.includes("/hotelinfo/plan")) ? "plan_list" : "unknown"
  };
}

export function findRoomListLink(links: ParsedRakutenLink[]): ParsedRakutenLink | undefined {
  return links.find((link) => link.text.includes("部屋一覧") || /\/hotelinfo\/room\/\d+/u.test(link.absolute_url));
}

export function extractParamCandidates(links: ParsedRakutenLink[], paramName: "f_syu" | "f_camp_id"): RakutenParamCandidate[] {
  const seen = new Set<string>();
  const candidates: RakutenParamCandidate[] = [];
  for (const link of links) {
    const value = paramName === "f_syu" ? link.f_syu : link.f_camp_id;
    if (!value) continue;
    const key = `${value}\n${link.absolute_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      param_name: paramName,
      value,
      source_url: link.absolute_url,
      link_text: link.text
    });
  }
  return candidates;
}

export function extractRoomTypeCandidates(html: string, links: ParsedRakutenLink[]): RakutenRoomTypeCandidate[] {
  const candidates: RakutenRoomTypeCandidate[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const roomName = roomNameFromText(link.text);
    if (!roomName) continue;
    pushRoomCandidate(candidates, seen, {
      detected_room_name: roomName,
      normalized_room_name: normalizeRoomName(roomName),
      source: "link_text",
      evidence: link.absolute_url,
      confidence: link.f_syu || link.f_camp_id ? "A" : "B",
      warning: link.f_syu ? "" : "Room-like link text found, but f_syu was not visible in this link."
    });
  }

  const text = htmlToVisibleText(html);
  const roomTypeBlock = text.match(/部屋タイプ([\s\S]{0,1200})(?:食事|料金|プラン|条件|合計料金|空室|$)/u)?.[1] ?? "";
  for (const line of roomTypeBlock.split(/\n| {2,}/u)) {
    const roomName = roomNameFromText(line);
    if (!roomName) continue;
    pushRoomCandidate(candidates, seen, {
      detected_room_name: roomName,
      normalized_room_name: normalizeRoomName(roomName),
      source: "visible_text",
      evidence: line.trim(),
      confidence: "C",
      warning: "Weak visible room-type text; f_syu/plan relationship is not directly visible."
    });
  }

  return candidates;
}

export function extractPlanCandidates(links: ParsedRakutenLink[]): RakutenPlanCandidate[] {
  const plans: RakutenPlanCandidate[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const isPlanLink = /\/hotelinfo\/plan\/\d+/u.test(link.absolute_url);
    const parsed = safeUrl(link.absolute_url);
    if (parsed?.searchParams.get("f_flg") === "ROOM") continue;
    const hasPlanParam = Boolean(link.f_camp_id);
    const looksLikePlan = /プラン|食|泊|温泉|料金|特典|限定|素泊|朝食|夕食/u.test(link.text);
    if (!isPlanLink || (!hasPlanParam && !looksLikePlan && !link.f_syu)) continue;
    const key = `${link.absolute_url}\n${link.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const roomName = roomNameFromText(link.text);
    plans.push({
      plan_name: link.text || "(plan link text unavailable)",
      plan_url: link.absolute_url,
      f_syu: link.f_syu,
      f_camp_id: link.f_camp_id,
      detected_room_name: roomName,
      confidence: roomName && (link.f_syu || link.f_camp_id) ? "A" : link.f_camp_id ? "B" : "C",
      evidence: link.absolute_url,
      warning: link.f_syu ? "" : "f_syu is not visible on this static plan-list link; do not invent it."
    });
  }
  return plans;
}

export function buildRoomTypeMasterRows(input: {
  canonicalPropertyName: string;
  rakutenHotelNo: string;
  sourcePageType: string;
  sourceUrl: string;
  roomListUrl: string;
  roomCandidates: RakutenRoomTypeCandidate[];
  planCandidates: RakutenPlanCandidate[];
  generatedAtJst: string;
}): RakutenRoomTypeMasterRow[] {
  const rows: RakutenRoomTypeMasterRow[] = [];
  const seen = new Set<string>();

  for (const plan of input.planCandidates) {
    const detectedRoomName = plan.detected_room_name;
    const contextType: RakutenContextType = plan.f_syu
      ? "f_syu_level"
      : plan.f_camp_id
        ? "campaign_level"
        : "plan_level";
    pushMasterRow(rows, seen, {
      canonical_property_name: input.canonicalPropertyName,
      rakuten_hotel_no: input.rakutenHotelNo,
      source_page_type: input.sourcePageType,
      source_url: input.sourceUrl,
      detected_room_name: detectedRoomName,
      normalized_room_name: normalizeRoomName(detectedRoomName),
      f_syu: plan.f_syu,
      f_camp_id: plan.f_camp_id,
      plan_name: plan.plan_name,
      plan_url: plan.plan_url,
      room_url: input.roomListUrl,
      context_type: contextType,
      confidence: plan.confidence,
      evidence: plan.evidence,
      first_seen_at_jst: input.generatedAtJst,
      last_seen_at_jst: input.generatedAtJst,
      extraction_warning: plan.warning
    });
  }

  for (const room of input.roomCandidates) {
    pushMasterRow(rows, seen, {
      canonical_property_name: input.canonicalPropertyName,
      rakuten_hotel_no: input.rakutenHotelNo,
      source_page_type: input.sourcePageType,
      source_url: input.sourceUrl,
      detected_room_name: room.detected_room_name,
      normalized_room_name: room.normalized_room_name,
      f_syu: "",
      f_camp_id: "",
      plan_name: "",
      plan_url: "",
      room_url: input.roomListUrl,
      context_type: "room_type_level",
      confidence: room.confidence === "A" ? "B" : room.confidence,
      evidence: room.evidence,
      first_seen_at_jst: input.generatedAtJst,
      last_seen_at_jst: input.generatedAtJst,
      extraction_warning: room.warning || "Room name extracted, but f_syu/plan mapping is not confirmed from this row."
    });
  }

  return rows;
}

export function classifyRakutenCalendarContext(input: { f_syu: string; room_name: string; f_camp_id: string }): RakutenContextType {
  if (input.room_name.trim()) return "room_type_level";
  if (input.f_syu.trim()) return "f_syu_level";
  if (input.f_camp_id.trim()) return "campaign_level";
  return "unknown";
}

export function evaluateSingleContextSoldOut(input: {
  f_syu: string;
  room_name: string;
  known_context_count: number;
  all_known_contexts_full: boolean;
  plan_list_no_availability: boolean;
  explicit_property_no_vacancy: boolean;
}): RakutenSoldOutGuard {
  const calendarContextType = classifyRakutenCalendarContext({
    f_syu: input.f_syu,
    room_name: input.room_name,
    f_camp_id: ""
  });
  const propertyConfirmed = input.plan_list_no_availability ||
    input.explicit_property_no_vacancy ||
    (input.known_context_count > 1 && input.all_known_contexts_full);
  return {
    calendar_context_type: calendarContextType,
    classification_for_single_full_context: propertyConfirmed
      ? "rakuten_property_sold_out_confirmed"
      : "rakuten_room_type_context_sold_out",
    property_level_sold_out: propertyConfirmed,
    usable_for_property_sold_out_pressure: propertyConfirmed,
    property_level_requirements: propertyLevelSoldOutRequirements()
  };
}

export function propertyLevelSoldOutRequirements(): string[] {
  return [
    "plan-list page says no plans available for the search condition",
    "all learned room types / f_syu contexts independently show sold_out",
    "multiple plan contexts confirm no availability",
    "explicit property-level no-vacancy indicator is extracted"
  ];
}

export function auto08xBugPreventionStatement(): string[] {
  return [
    "AUTO08X bug: f_syu-level full was treated as property-level sold_out.",
    "Prevention: no /hplan/calendar call should run before room_type_master exists for the hotel.",
    "Prevention: every future calendar row must carry f_syu, room_name, source_context_type, and plan/campaign context when available.",
    "Prevention: context packs must aggregate only property-level confirmed sold_out into sold_out pressure."
  ];
}

export function buildRakutenRoomTypeLearningResult(input: {
  runId: string;
  generatedAtJst: string;
  canonicalPropertyName: string;
  sourceUrl: string;
  html: string;
  fetchWarning?: string;
}): RakutenRoomTypeLearningResult {
  const hotelNo = parseRakutenHotelNoFromUrl(input.sourceUrl);
  const links = extractRakutenLinks(input.html, input.sourceUrl);
  const planContext = detectPlanListContext(input.html, input.sourceUrl);
  const roomListLink = findRoomListLink(links);
  const roomCandidates = extractRoomTypeCandidates(input.html, links);
  const planCandidates = extractPlanCandidates(links);
  const fSyuCandidates = extractParamCandidates(links, "f_syu");
  const fCampCandidates = extractParamCandidates(links, "f_camp_id");
  const masterRows = buildRoomTypeMasterRows({
    canonicalPropertyName: input.canonicalPropertyName,
    rakutenHotelNo: hotelNo,
    sourcePageType: planContext.sourcePageType,
    sourceUrl: input.sourceUrl,
    roomListUrl: roomListLink?.absolute_url ?? "",
    roomCandidates,
    planCandidates,
    generatedAtJst: input.generatedAtJst
  });
  const warnings = extractionWarnings({
    fetchWarning: input.fetchWarning ?? "",
    hotelNo,
    planContextDetected: planContext.detected,
    roomCandidateCount: roomCandidates.length,
    planCandidateCount: planCandidates.length,
    fSyuCandidateCount: fSyuCandidates.length,
    fCampCandidateCount: fCampCandidates.length,
    roomListLink: roomListLink?.absolute_url ?? ""
  });
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: decideRakutenRoomTypeLearning({
      hotelNo,
      planListContextDetected: planContext.detected,
      roomTypeMasterRows: masterRows.length,
      warnings
    }),
    source_url: input.sourceUrl,
    hotel_context: {
      canonical_property_name: input.canonicalPropertyName,
      rakuten_hotel_no: hotelNo,
      hotel_name: detectHotelName(input.html),
      source_url: input.sourceUrl,
      source_page_type: planContext.sourcePageType,
      plan_list_context_detected: planContext.detected,
      plan_list_signals: planContext.signals,
      room_list_link: roomListLink?.absolute_url ?? "",
      room_list_link_text: roomListLink?.text ?? ""
    },
    parsed_links: links,
    room_type_candidates: roomCandidates,
    plan_candidates: planCandidates,
    f_syu_candidates: fSyuCandidates,
    f_camp_id_candidates: fCampCandidates,
    room_type_master_preview: masterRows,
    sold_out_semantics_guard: evaluateSingleContextSoldOut({
      f_syu: "honkan-exk",
      room_name: "ザ・ゲスト棟 和室ベッド ＜倶楽部ルーム＞",
      known_context_count: 1,
      all_known_contexts_full: false,
      plan_list_no_availability: false,
      explicit_property_no_vacancy: false
    }),
    auto08x_bug_prevention_statement: auto08xBugPreventionStatement(),
    extraction_warnings: warnings,
    safety_confirmation: {
      db_writes: false,
      history_modified: false,
      ai_context_refreshed: false,
      broad_collector_run: false,
      playwright_used: false,
      calendar_called: false,
      paid_source_tooling_used: false,
      booking_used: false
    }
  };
}

export function decideRakutenRoomTypeLearning(input: {
  hotelNo: string;
  planListContextDetected: boolean;
  roomTypeMasterRows: number;
  warnings: string[];
}): RakutenRoomTypeLearningDecision {
  if (!input.hotelNo || !input.planListContextDetected || input.roomTypeMasterRows === 0) {
    return "rakuten_room_type_learning_not_ready";
  }
  return input.warnings.length > 0
    ? "rakuten_room_type_learning_basis_caution"
    : "rakuten_room_type_learning_ready";
}

export function renderRakutenRoomTypeLearningCsv(result: RakutenRoomTypeLearningResult): string {
  const lines = [RAKUTEN_ROOM_TYPE_MASTER_COLUMNS.join(",")];
  for (const row of result.room_type_master_preview) {
    lines.push(RAKUTEN_ROOM_TYPE_MASTER_COLUMNS.map((key) => csvEscape(String(row[key as keyof RakutenRoomTypeMasterRow] ?? ""))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function renderRakutenRoomTypeLearningMarkdown(result: RakutenRoomTypeLearningResult): string {
  return [
    "# Rakuten Room-Type Learning",
    "",
    "## 1. Summary",
    `- decision = ${result.decision}`,
    `- source_url = ${result.source_url}`,
    `- hotel_no = ${result.hotel_context.rakuten_hotel_no}`,
    `- hotel_name = ${result.hotel_context.hotel_name || "(not detected)"}`,
    `- room_type_master_rows = ${result.room_type_master_preview.length}`,
    `- f_syu_candidates = ${result.f_syu_candidates.length}`,
    `- f_camp_id_candidates = ${result.f_camp_id_candidates.length}`,
    "",
    "## 2. Extracted Hotel Context",
    `- canonical_property_name = ${result.hotel_context.canonical_property_name}`,
    `- source_page_type = ${result.hotel_context.source_page_type}`,
    `- plan_list_context_detected = ${result.hotel_context.plan_list_context_detected}`,
    `- room_list_link = ${result.hotel_context.room_list_link || "(not detected)"}`,
    ...result.hotel_context.plan_list_signals.map((signal) => `- signal: ${signal}`),
    "",
    "## 3. Room Type Candidates",
    ...result.room_type_candidates.slice(0, 20).map((row) => `- ${row.detected_room_name} | confidence=${row.confidence} | warning=${row.warning || "none"}`),
    result.room_type_candidates.length === 0 ? "- none" : "",
    "",
    "## 4. Plan / f_syu / f_camp_id Candidates",
    ...result.plan_candidates.slice(0, 20).map((row) => `- ${row.plan_name} | f_syu=${row.f_syu || "(missing)"} | f_camp_id=${row.f_camp_id || "(missing)"} | confidence=${row.confidence}`),
    result.plan_candidates.length === 0 ? "- none" : "",
    "",
    "## 5. Room Type Master Preview",
    ...result.room_type_master_preview.slice(0, 30).map((row) => `- ${row.normalized_room_name || "(room not linked)"} | context=${row.context_type} | f_syu=${row.f_syu || "(missing)"} | f_camp_id=${row.f_camp_id || "(missing)"} | confidence=${row.confidence}`),
    result.room_type_master_preview.length === 0 ? "- none" : "",
    "",
    "## 6. AUTO08X Bug Prevention",
    ...result.auto08x_bug_prevention_statement.map((line) => `- ${line}`),
    `- single_f_syu_full_property_level_sold_out = ${result.sold_out_semantics_guard.property_level_sold_out}`,
    `- usable_for_property_sold_out_pressure = ${result.sold_out_semantics_guard.usable_for_property_sold_out_pressure}`,
    "",
    "## 7. Remaining Extraction Gaps",
    ...result.extraction_warnings.map((warning) => `- ${warning}`),
    result.extraction_warnings.length === 0 ? "- none" : "",
    "",
    "## 8. Safety Confirmation",
    ...Object.entries(result.safety_confirmation).map(([key, value]) => `- ${key} = ${value}`),
    ""
  ].filter((line) => line !== undefined).join("\n");
}

function extractionWarnings(input: {
  fetchWarning: string;
  hotelNo: string;
  planContextDetected: boolean;
  roomCandidateCount: number;
  planCandidateCount: number;
  fSyuCandidateCount: number;
  fCampCandidateCount: number;
  roomListLink: string;
}): string[] {
  const warnings: string[] = [];
  if (input.fetchWarning) warnings.push(input.fetchWarning);
  if (!input.hotelNo) warnings.push("hotelNo was not detected from source URL.");
  if (!input.planContextDetected) warnings.push("Plan-list context was not strongly detected.");
  if (input.roomCandidateCount === 0) warnings.push("No visible room type candidates were extracted from static HTML.");
  if (input.planCandidateCount === 0) warnings.push("No plan candidates were extracted from static HTML.");
  if (input.fSyuCandidateCount === 0) warnings.push("No f_syu candidates were visible in static plan-list HTML; do not invent f_syu.");
  if (input.fCampCandidateCount === 0) warnings.push("No f_camp_id candidates were visible in static plan-list HTML.");
  if (!input.roomListLink) warnings.push("Room-list link was not detected; include as follow-up only if later explicitly allowed.");
  return warnings;
}

function roomNameFromText(value: string): string {
  const cleaned = decodeHtmlEntities(value).replace(/\s+/gu, " ").trim();
  if (!cleaned || GENERIC_LINK_TEXT.has(cleaned)) return "";
  if (!ROOM_TEXT_PATTERNS.some((pattern) => pattern.test(cleaned))) return "";
  return cleaned
    .replace(/この部屋で選択できる宿泊プラン|空室カレンダー|予約する|詳細を見る/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function pushRoomCandidate(
  rows: RakutenRoomTypeCandidate[],
  seen: Set<string>,
  row: RakutenRoomTypeCandidate
): void {
  const key = row.normalized_room_name;
  if (!key || seen.has(key)) return;
  seen.add(key);
  rows.push(row);
}

function pushMasterRow(
  rows: RakutenRoomTypeMasterRow[],
  seen: Set<string>,
  row: RakutenRoomTypeMasterRow
): void {
  const key = [
    row.normalized_room_name,
    row.f_syu,
    row.f_camp_id,
    row.plan_url,
    row.context_type
  ].join("\n");
  if (seen.has(key)) return;
  seen.add(key);
  rows.push(row);
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/u.test(value)) return value;
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

function toAbsoluteUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Phase RAKUTEN-ROOM02X — bounded Lucent room-list learning.
//
// Read-only static HTML parsing for the Lucent Rakuten room-list follow-up URL
// discovered in ROOM01X. This module does not call /hplan/calendar, write DB
// rows, mutate history, refresh AI context, run collectors, or use Playwright.

import {
  decodeHtmlEntities,
  detectHotelName,
  evaluateSingleContextSoldOut,
  extractParamCandidates,
  extractRakutenLinks,
  htmlToVisibleText,
  normalizeRoomName,
  parseRakutenHotelNoFromUrl,
  type ParsedRakutenLink,
  type RakutenContextType,
  type RakutenParamCandidate,
  type RakutenRoomTypeConfidence,
  type RakutenSoldOutGuard
} from "./rakutenRoomTypeLearning";

export type RakutenRoomListLearningDecision =
  | "rakuten_room_list_learning_ready"
  | "rakuten_room_list_learning_basis_caution"
  | "rakuten_room_list_learning_not_ready";

export interface Room01xArtifactLike {
  decision?: string;
  hotel_context?: {
    canonical_property_name?: string;
    rakuten_hotel_no?: string;
    hotel_name?: string;
    room_list_link?: string;
  };
  parsed_links?: ParsedRakutenLink[];
}

export interface RakutenRoomListCandidate {
  detected_room_name: string;
  normalized_room_name: string;
  room_url: string;
  f_syu: string;
  f_camp_id: string;
  source: "room_link" | "visible_text";
  confidence: RakutenRoomTypeConfidence;
  evidence: string;
  requires_follow_up: boolean;
  warning: string;
}

export interface RakutenRoomListMasterRow {
  canonical_property_name: string;
  rakuten_hotel_no: string;
  source_page_type: string;
  source_url: string;
  detected_room_name: string;
  normalized_room_name: string;
  f_syu: string;
  f_camp_id: string;
  room_url: string;
  plan_url: string;
  context_type: RakutenContextType;
  confidence: RakutenRoomTypeConfidence;
  evidence: string;
  learned_from: string;
  requires_follow_up: string;
  first_seen_at_jst: string;
  last_seen_at_jst: string;
  extraction_warning: string;
}

export interface RakutenRoomListHotelContext {
  canonical_property_name: string;
  rakuten_hotel_no: string;
  hotel_name: string;
  source_url: string;
  source_page_type: string;
  room_list_context_detected: boolean;
  room_list_signals: string[];
  f_syu_visible_in_room_list_html: boolean;
  next_required_step: string;
}

export interface RakutenRoomListLearningResult {
  run_id: string;
  generated_at_jst: string;
  decision: RakutenRoomListLearningDecision;
  source_room01x_artifact: string;
  room_list_url: string;
  hotel_context: RakutenRoomListHotelContext;
  parsed_room_links: ParsedRakutenLink[];
  room_type_candidates: RakutenRoomListCandidate[];
  f_syu_candidates: RakutenParamCandidate[];
  f_camp_id_candidates: RakutenParamCandidate[];
  room_type_master_preview: RakutenRoomListMasterRow[];
  sold_out_semantics_guard: RakutenSoldOutGuard;
  extraction_warnings: string[];
  safety_confirmation: Record<string, boolean>;
}

export const ROOM01X_ARTIFACT_PATH = ".data/reports/source-discovery/rakuten_room_type_learning_20260604_111400.json";

export const RAKUTEN_ROOM_LIST_MASTER_COLUMNS = [
  "canonical_property_name",
  "rakuten_hotel_no",
  "source_page_type",
  "source_url",
  "detected_room_name",
  "normalized_room_name",
  "f_syu",
  "f_camp_id",
  "room_url",
  "plan_url",
  "context_type",
  "confidence",
  "evidence",
  "learned_from",
  "requires_follow_up",
  "first_seen_at_jst",
  "last_seen_at_jst",
  "extraction_warning"
];

const ROOM_NAME_PATTERN =
  /(?:禁煙|喫煙|和室|洋室|和洋室|ツイン|ダブル|シングル|スイート|ベッド|客室|倶楽部ルーム|クラブルーム|バス付|本館|別館|ゲスト棟|南館|離れ|ジャグジー)/u;

const GENERIC_ROOM_LIST_TEXT = new Set([
  "部屋一覧",
  "宿泊",
  "プラン一覧",
  "詳細",
  "予約",
  "予約する",
  "空室カレンダー"
]);

export function extractRoomListUrlFromRoom01xArtifact(artifact: Room01xArtifactLike): string {
  const direct = artifact.hotel_context?.room_list_link ?? "";
  if (isDirectRoomListUrl(direct)) return direct;
  const link = artifact.parsed_links?.find((candidate) => (
    candidate.text.includes("部屋一覧") &&
    isDirectRoomListUrl(candidate.absolute_url)
  ));
  return link?.absolute_url ?? "";
}

export function detectRoomListContext(html: string, sourceUrl: string): { detected: boolean; signals: string[]; sourcePageType: string } {
  const text = htmlToVisibleText(html);
  const parsed = safeUrl(sourceUrl);
  const signals: string[] = [];
  if (parsed?.searchParams.get("f_flg") === "ROOM") signals.push("URL query has f_flg=ROOM");
  if (/\/hotelinfo\/room\/\d+/u.test(sourceUrl)) signals.push("URL path is /hotelinfo/room/{hotelNo}");
  if (text.includes("部屋一覧")) signals.push("visible text contains 部屋一覧");
  if (text.includes("客室") || text.includes("部屋タイプ")) signals.push("visible text contains room/guestroom wording");
  return {
    detected: signals.some((signal) => signal.includes("ROOM") || signal.includes("/hotelinfo/room")) && signals.length >= 2,
    signals,
    sourcePageType: "room_list"
  };
}

export function extractRoomLinksFromRoomListHtml(html: string, sourceUrl: string): ParsedRakutenLink[] {
  return extractRakutenLinks(html, sourceUrl).filter((link) => {
    if (isLoginOrReservationLink(link.absolute_url)) return false;
    if (link.absolute_url.includes("/hplan/calendar/")) return false;
    if (/\/hotelinfo\/room\/\d+/u.test(link.absolute_url)) return true;
    if (ROOM_NAME_PATTERN.test(link.text) && /\/hotelinfo\/(?:plan|room)\/\d+/u.test(link.absolute_url)) return true;
    return false;
  });
}

export function extractRoomListCandidates(html: string, sourceUrl: string): RakutenRoomListCandidate[] {
  const links = extractRoomLinksFromRoomListHtml(html, sourceUrl);
  const rows: RakutenRoomListCandidate[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const roomName = roomNameFromText(link.text);
    if (!roomName) continue;
    pushCandidate(rows, seen, {
      detected_room_name: roomName,
      normalized_room_name: normalizeRoomName(roomName),
      room_url: link.absolute_url,
      f_syu: link.f_syu,
      f_camp_id: link.f_camp_id,
      source: "room_link",
      confidence: link.f_syu ? "A" : "B",
      evidence: link.absolute_url,
      requires_follow_up: !link.f_syu,
      warning: link.f_syu ? "" : "Room name and room URL were extracted, but f_syu is not visible; do not invent it."
    });
  }

  const textBlock = htmlToVisibleText(html).match(/部屋一覧([\s\S]{0,3000})(?:宿泊プラン|条件|検索|料金|$)/u)?.[1] ?? "";
  for (const line of textBlock.split(/\n| {2,}/u)) {
    const roomName = roomNameFromText(line);
    if (!roomName) continue;
    pushCandidate(rows, seen, {
      detected_room_name: roomName,
      normalized_room_name: normalizeRoomName(roomName),
      room_url: "",
      f_syu: "",
      f_camp_id: "",
      source: "visible_text",
      confidence: "C",
      evidence: line.trim(),
      requires_follow_up: true,
      warning: "Weak text-only room candidate; room URL and f_syu are not directly visible."
    });
  }
  return rows;
}

export function buildRoomListMasterRows(input: {
  canonicalPropertyName: string;
  rakutenHotelNo: string;
  sourceUrl: string;
  candidates: RakutenRoomListCandidate[];
  generatedAtJst: string;
}): RakutenRoomListMasterRow[] {
  return input.candidates.map((candidate) => ({
    canonical_property_name: input.canonicalPropertyName,
    rakuten_hotel_no: input.rakutenHotelNo,
    source_page_type: "room_list",
    source_url: input.sourceUrl,
    detected_room_name: candidate.detected_room_name,
    normalized_room_name: candidate.normalized_room_name,
    f_syu: candidate.f_syu,
    f_camp_id: candidate.f_camp_id,
    room_url: candidate.room_url,
    plan_url: "",
    context_type: candidate.f_syu ? "f_syu_level" : candidate.room_url ? "room_type_level" : "unknown",
    confidence: candidate.confidence,
    evidence: candidate.evidence,
    learned_from: "room_list",
    requires_follow_up: String(candidate.requires_follow_up),
    first_seen_at_jst: input.generatedAtJst,
    last_seen_at_jst: input.generatedAtJst,
    extraction_warning: candidate.warning
  }));
}

export function buildRakutenRoomListLearningResult(input: {
  runId: string;
  generatedAtJst: string;
  sourceRoom01xArtifact: string;
  room01xArtifact: Room01xArtifactLike;
  html: string;
  fetchWarning?: string;
}): RakutenRoomListLearningResult {
  const roomListUrl = extractRoomListUrlFromRoom01xArtifact(input.room01xArtifact);
  const hotelNo = parseRakutenHotelNoFromUrl(roomListUrl);
  const canonicalName = input.room01xArtifact.hotel_context?.canonical_property_name ?? "名湯リゾート ルーセント";
  const roomListContext = detectRoomListContext(input.html, roomListUrl);
  const parsedRoomLinks = extractRoomLinksFromRoomListHtml(input.html, roomListUrl);
  const allLinks = extractRakutenLinks(input.html, roomListUrl);
  const fSyuCandidates = extractParamCandidates(allLinks, "f_syu");
  const fCampCandidates = extractParamCandidates(allLinks, "f_camp_id");
  const roomCandidates = extractRoomListCandidates(input.html, roomListUrl);
  const masterRows = buildRoomListMasterRows({
    canonicalPropertyName: canonicalName,
    rakutenHotelNo: hotelNo,
    sourceUrl: roomListUrl,
    candidates: roomCandidates,
    generatedAtJst: input.generatedAtJst
  });
  const warnings = extractionWarnings({
    fetchWarning: input.fetchWarning ?? "",
    roomListUrl,
    hotelNo,
    contextDetected: roomListContext.detected,
    roomCandidateCount: roomCandidates.length,
    fSyuCandidateCount: fSyuCandidates.length,
    roomUrlCount: roomCandidates.filter((row) => row.room_url).length
  });
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: decideRakutenRoomListLearning({
      hotelNo,
      contextDetected: roomListContext.detected,
      masterRows,
      warnings
    }),
    source_room01x_artifact: input.sourceRoom01xArtifact,
    room_list_url: roomListUrl,
    hotel_context: {
      canonical_property_name: canonicalName,
      rakuten_hotel_no: hotelNo,
      hotel_name: detectHotelName(input.html) || input.room01xArtifact.hotel_context?.hotel_name || "",
      source_url: roomListUrl,
      source_page_type: "room_list",
      room_list_context_detected: roomListContext.detected,
      room_list_signals: roomListContext.signals,
      f_syu_visible_in_room_list_html: fSyuCandidates.length > 0,
      next_required_step: fSyuCandidates.length > 0 ? "none" : "bounded room-detail learning proposal"
    },
    parsed_room_links: parsedRoomLinks,
    room_type_candidates: roomCandidates,
    f_syu_candidates: fSyuCandidates,
    f_camp_id_candidates: fCampCandidates,
    room_type_master_preview: masterRows,
    sold_out_semantics_guard: evaluateSingleContextSoldOut({
      f_syu: "known_or_future_f_syu",
      room_name: "known_or_future_room_name",
      known_context_count: 1,
      all_known_contexts_full: false,
      plan_list_no_availability: false,
      explicit_property_no_vacancy: false
    }),
    extraction_warnings: warnings,
    safety_confirmation: {
      db_writes: false,
      history_modified: false,
      ai_context_refreshed: false,
      broad_collector_run: false,
      hplan_calendar_called: false,
      playwright_used: false,
      paid_source_tooling_used: false,
      booking_used: false
    }
  };
}

export function decideRakutenRoomListLearning(input: {
  hotelNo: string;
  contextDetected: boolean;
  masterRows: RakutenRoomListMasterRow[];
  warnings: string[];
}): RakutenRoomListLearningDecision {
  if (!input.hotelNo || !input.contextDetected || input.masterRows.length === 0) {
    return "rakuten_room_list_learning_not_ready";
  }
  if (input.masterRows.some((row) => row.confidence === "A" && row.f_syu)) {
    return "rakuten_room_list_learning_ready";
  }
  return "rakuten_room_list_learning_basis_caution";
}

export function renderRakutenRoomListLearningCsv(result: RakutenRoomListLearningResult): string {
  const lines = [RAKUTEN_ROOM_LIST_MASTER_COLUMNS.join(",")];
  for (const row of result.room_type_master_preview) {
    lines.push(RAKUTEN_ROOM_LIST_MASTER_COLUMNS.map((key) => csvEscape(String(row[key as keyof RakutenRoomListMasterRow] ?? ""))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function renderRakutenRoomListLearningMarkdown(result: RakutenRoomListLearningResult): string {
  return [
    "# Rakuten Room-List Learning",
    "",
    "## 1. Summary",
    `- decision = ${result.decision}`,
    `- source_room01x_artifact = ${result.source_room01x_artifact}`,
    `- room_list_url = ${result.room_list_url || "(missing)"}`,
    `- hotel_no = ${result.hotel_context.rakuten_hotel_no}`,
    `- hotel_name = ${result.hotel_context.hotel_name || "(not detected)"}`,
    `- room_type_master_rows = ${result.room_type_master_preview.length}`,
    `- f_syu_candidates = ${result.f_syu_candidates.length}`,
    `- f_camp_id_candidates = ${result.f_camp_id_candidates.length}`,
    "",
    "## 2. Extracted Hotel Context",
    `- canonical_property_name = ${result.hotel_context.canonical_property_name}`,
    `- source_page_type = ${result.hotel_context.source_page_type}`,
    `- room_list_context_detected = ${result.hotel_context.room_list_context_detected}`,
    `- f_syu_visible_in_room_list_html = ${result.hotel_context.f_syu_visible_in_room_list_html}`,
    `- next_required_step = ${result.hotel_context.next_required_step}`,
    ...result.hotel_context.room_list_signals.map((signal) => `- signal: ${signal}`),
    "",
    "## 3. Room Type Candidates",
    ...result.room_type_candidates.slice(0, 30).map((row) => `- ${row.detected_room_name} | room_url=${row.room_url || "(missing)"} | f_syu=${row.f_syu || "(missing)"} | confidence=${row.confidence}`),
    result.room_type_candidates.length === 0 ? "- none" : "",
    "",
    "## 4. f_syu / f_camp_id Candidates",
    `- f_syu_values = ${result.f_syu_candidates.map((row) => row.value).join(", ") || "(none)"}`,
    `- f_camp_id_values = ${result.f_camp_id_candidates.map((row) => row.value).join(", ") || "(none)"}`,
    "",
    "## 5. Room Type Master Preview",
    ...result.room_type_master_preview.slice(0, 30).map((row) => `- ${row.normalized_room_name || "(room not detected)"} | context=${row.context_type} | f_syu=${row.f_syu || "(missing)"} | confidence=${row.confidence} | follow_up=${row.requires_follow_up}`),
    result.room_type_master_preview.length === 0 ? "- none" : "",
    "",
    "## 6. Sold-out Semantics Guard",
    "- A Rakuten /hplan/calendar response tied to f_syu or a room name is room_type_level evidence.",
    "- It must not become property-level sold_out.",
    "- Future property-level sold_out requires plan-list no-availability, all learned room types sold_out, multiple independent contexts, or explicit property-level no-vacancy text.",
    `- classification_if_one_room_type_full = ${result.sold_out_semantics_guard.classification_for_single_full_context}`,
    `- property_level_sold_out = ${result.sold_out_semantics_guard.property_level_sold_out}`,
    `- usable_for_property_sold_out_pressure = ${result.sold_out_semantics_guard.usable_for_property_sold_out_pressure}`,
    "",
    "## 7. Remaining Extraction Gaps",
    ...result.extraction_warnings.map((warning) => `- ${warning}`),
    result.extraction_warnings.length === 0 ? "- none" : "",
    "",
    "## 8. Safety Confirmation",
    ...Object.entries(result.safety_confirmation).map(([key, value]) => `- ${key} = ${value}`),
    ""
  ].join("\n");
}

function extractionWarnings(input: {
  fetchWarning: string;
  roomListUrl: string;
  hotelNo: string;
  contextDetected: boolean;
  roomCandidateCount: number;
  fSyuCandidateCount: number;
  roomUrlCount: number;
}): string[] {
  const warnings: string[] = [];
  if (input.fetchWarning) warnings.push(input.fetchWarning);
  if (!input.roomListUrl) warnings.push("ROOM01X room-list URL was not found.");
  if (!input.hotelNo) warnings.push("hotelNo 39565 was not detected from room-list URL.");
  if (!input.contextDetected) warnings.push("Room-list page context was not strongly detected.");
  if (input.roomCandidateCount === 0) warnings.push("No room candidates were extracted from static room-list HTML.");
  if (input.roomUrlCount === 0) warnings.push("No room URLs were extracted from static room-list HTML.");
  if (input.fSyuCandidateCount === 0) warnings.push("No f_syu candidates were visible in static room-list HTML; do not invent f_syu.");
  return warnings;
}

function roomNameFromText(value: string): string {
  const cleaned = decodeHtmlEntities(value).replace(/\s+/gu, " ").trim();
  if (!cleaned || GENERIC_ROOM_LIST_TEXT.has(cleaned)) return "";
  if (!ROOM_NAME_PATTERN.test(cleaned)) return "";
  return cleaned
    .replace(/この部屋で選択できる宿泊プラン|宿泊プラン一覧|空室カレンダー|詳細を見る|予約する/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function pushCandidate(rows: RakutenRoomListCandidate[], seen: Set<string>, row: RakutenRoomListCandidate): void {
  const key = [row.normalized_room_name, row.room_url, row.f_syu, row.source].join("\n");
  if (!row.normalized_room_name || seen.has(key)) return;
  seen.add(key);
  rows.push(row);
}

function isDirectRoomListUrl(url: string): boolean {
  const parsed = safeUrl(url);
  return parsed?.searchParams.get("f_flg") === "ROOM" || /\/hotelinfo\/room\/\d+/u.test(url);
}

function isLoginOrReservationLink(url: string): boolean {
  return /auth\.travel\.rakuten|reservation|login|memberDispatcher/u.test(url);
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

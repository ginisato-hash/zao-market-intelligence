// Phase RAKUTEN-ROOM03X — bounded room-detail learning proposal.
//
// Proposal-only. Reads saved ROOM01X/ROOM02X evidence and proposes the safest
// next extraction path. It does not fetch room-detail pages, call /hplan/calendar,
// write DB rows, mutate history, refresh AI context, or use Playwright.

import {
  evaluateSingleContextSoldOut,
  extractRakutenLinks,
  normalizeRoomName,
  type ParsedRakutenLink,
  type RakutenRoomTypeConfidence,
  type RakutenSoldOutGuard
} from "./rakutenRoomTypeLearning";
import type { RakutenRoomListLearningResult, RakutenRoomListCandidate } from "./rakutenRoomListLearning";

export type RakutenRoomDetailLearningProposalDecision =
  | "rakuten_room_detail_learning_proposal_ready"
  | "rakuten_room_detail_learning_proposal_basis_caution"
  | "rakuten_room_detail_learning_proposal_not_ready";

export interface Room01xSourceSummary {
  path: string;
  decision: string;
  hotel_no: string;
  hotel_name: string;
  room_list_link: string;
}

export interface Room02xSourceSummary {
  path: string;
  decision: string;
  room_list_url: string;
  room_type_master_rows: number;
  f_syu_candidates: number;
  f_camp_id_candidates: number;
}

export interface HiddenIdentifierCandidate {
  identifier_type: "f_syu" | "f_camp_id" | "room_identifier";
  value: string;
  evidence: string;
  confidence: RakutenRoomTypeConfidence;
}

export interface RoomDetailLearningPlanRow {
  canonical_property_name: string;
  rakuten_hotel_no: string;
  source_room_list_url: string;
  candidate_room_name: string;
  candidate_room_url: string;
  candidate_rank: number;
  candidate_reason: string;
  visible_f_syu: string;
  visible_f_camp_id: string;
  hidden_identifier_evidence: string;
  recommended_for_follow_up: string;
  future_fetch_allowed_only_after_approval: string;
  confidence: RakutenRoomTypeConfidence;
  extraction_warning: string;
}

export interface SavedRoomListHtmlInspection {
  debug_html_path: string;
  inspected_bytes: number;
  contains_room_list_marker: boolean;
  contains_hotel_info_js: boolean;
  contains_hplan_calendar_reference: boolean;
  visible_room_candidate_count_from_room02x: number;
}

export interface RoomDetailRiskAssessment {
  risk_level: "low" | "medium" | "high";
  risks: string[];
  mitigations: string[];
}

export interface RakutenRoomDetailLearningProposal {
  run_id: string;
  generated_at_jst: string;
  decision: RakutenRoomDetailLearningProposalDecision;
  source_room01x_artifact: Room01xSourceSummary;
  source_room02x_artifact: Room02xSourceSummary;
  saved_room_list_html_inspection: SavedRoomListHtmlInspection;
  room_detail_candidate_count: number;
  hidden_f_syu_candidate_count: number;
  hidden_f_camp_id_candidate_count: number;
  hidden_identifier_candidates: HiddenIdentifierCandidate[];
  room_detail_candidates: RoomDetailLearningPlanRow[];
  proposed_follow_up_targets: RoomDetailLearningPlanRow[];
  recommended_next_action: string;
  max_future_room_detail_fetches: number;
  expected_confidence_upgrade: string;
  risk_assessment: RoomDetailRiskAssessment;
  sold_out_semantics_guard: RakutenSoldOutGuard;
  safety_confirmation: Record<string, boolean>;
}

export const ROOM01X_ARTIFACT_PATH = ".data/reports/source-discovery/rakuten_room_type_learning_20260604_111400.json";
export const ROOM02X_ARTIFACT_PATH = ".data/reports/source-discovery/rakuten_room_list_learning_20260604_112335.json";
export const ROOM02X_RAW_HTML_PATH = ".data/debug/rakuten-room-list-learning/20260604_112335/raw_html_excerpt.txt";
export const MAX_FUTURE_ROOM_DETAIL_FETCHES = 3;

export const RAKUTEN_ROOM_DETAIL_PLAN_COLUMNS = [
  "canonical_property_name",
  "rakuten_hotel_no",
  "source_room_list_url",
  "candidate_room_name",
  "candidate_room_url",
  "candidate_rank",
  "candidate_reason",
  "visible_f_syu",
  "visible_f_camp_id",
  "hidden_identifier_evidence",
  "recommended_for_follow_up",
  "future_fetch_allowed_only_after_approval",
  "confidence",
  "extraction_warning"
];

export interface Room01xLike {
  decision?: string;
  hotel_context?: {
    rakuten_hotel_no?: string;
    hotel_name?: string;
    room_list_link?: string;
  };
}

export function summarizeRoom01xArtifact(path: string, artifact: Room01xLike): Room01xSourceSummary {
  return {
    path,
    decision: artifact.decision ?? "",
    hotel_no: artifact.hotel_context?.rakuten_hotel_no ?? "",
    hotel_name: artifact.hotel_context?.hotel_name ?? "",
    room_list_link: artifact.hotel_context?.room_list_link ?? ""
  };
}

export function summarizeRoom02xArtifact(path: string, artifact: RakutenRoomListLearningResult): Room02xSourceSummary {
  return {
    path,
    decision: artifact.decision,
    room_list_url: artifact.room_list_url,
    room_type_master_rows: artifact.room_type_master_preview.length,
    f_syu_candidates: artifact.f_syu_candidates.length,
    f_camp_id_candidates: artifact.f_camp_id_candidates.length
  };
}

export function inspectSavedRoomListHtml(path: string, html: string, room02x: RakutenRoomListLearningResult): SavedRoomListHtmlInspection {
  return {
    debug_html_path: path,
    inspected_bytes: Buffer.byteLength(html, "utf8"),
    contains_room_list_marker: /部屋一覧|f_flg=ROOM/u.test(html),
    contains_hotel_info_js: /var\s+hotelInfo\s*=/u.test(html),
    contains_hplan_calendar_reference: /\/hplan\/calendar\//u.test(html),
    visible_room_candidate_count_from_room02x: room02x.room_type_candidates.length
  };
}

export function detectHiddenIdentifierCandidates(html: string): HiddenIdentifierCandidate[] {
  const candidates: HiddenIdentifierCandidate[] = [];
  const seen = new Set<string>();
  const inputRe = /<input\b[^>]*>/giu;
  for (const inputMatch of html.matchAll(inputRe)) {
    const tag = inputMatch[0] ?? "";
    const name = attrValue(tag, "name");
    const value = attrValue(tag, "value");
    if (!name || !value) continue;
    const identifierType = name === "f_syu"
      ? "f_syu"
      : name === "f_camp_id"
        ? "f_camp_id"
        : /roomId|room_id|roomCd|room_cd|ryHeyaKihon/u.test(name)
          ? "room_identifier"
          : "";
    if (!identifierType) continue;
    const key = `${identifierType}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      identifier_type: identifierType,
      value,
      evidence: tag,
      confidence: identifierType === "room_identifier" ? "B" : "A"
    });
  }
  const patterns: Array<[HiddenIdentifierCandidate["identifier_type"], RegExp]> = [
    ["f_syu", /[?&]f_syu=([^&#"'<>]+)/giu],
    ["f_camp_id", /[?&]f_camp_id=([^&#"'<>]+)/giu],
    ["room_identifier", /\b(?:roomId|room_id|roomCd|room_cd|ryHeyaKihon)\b(?:["'\]\s:=]+)([A-Za-z0-9_-]{2,80})/giu]
  ];
  for (const [identifierType, pattern] of patterns) {
    for (const match of html.matchAll(pattern)) {
      const rawValue = match[1] ?? "";
      const value = decodeURIComponentSafe(rawValue).replace(/[",';<>]/gu, "").trim();
      if (!value || value === "ROOM") continue;
      const key = `${identifierType}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        identifier_type: identifierType,
        value,
        evidence: snippetAround(html, match.index ?? 0),
        confidence: identifierType === "room_identifier" ? "B" : "A"
      });
    }
  }
  return candidates;
}

function attrValue(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

export function detectRoomDetailLinkCandidates(input: {
  html: string;
  room02x: RakutenRoomListLearningResult;
}): RoomDetailLearningPlanRow[] {
  const url = input.room02x.room_list_url;
  const links = extractRakutenLinks(input.html, url);
  const hidden = detectHiddenIdentifierCandidates(input.html);
  const rows: RoomDetailLearningPlanRow[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    if (!isRoomDetailLikeLink(link, url)) continue;
    const roomName = roomNameFromLinkText(link.text) || matchingRoomNameFromRoom02x(link.text, input.room02x.room_type_candidates);
    if (!roomName) continue;
    const row = buildPlanRow({
      canonicalPropertyName: input.room02x.hotel_context.canonical_property_name,
      hotelNo: input.room02x.hotel_context.rakuten_hotel_no,
      roomListUrl: url,
      roomName,
      roomUrl: link.absolute_url,
      visibleFSyu: link.f_syu,
      visibleFCampId: link.f_camp_id,
      hiddenEvidence: hidden.map((candidate) => `${candidate.identifier_type}=${candidate.value}`).join("; "),
      source: "link"
    });
    const key = `${row.candidate_room_name}\n${row.candidate_room_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  if (rows.length === 0) {
    for (const candidate of input.room02x.room_type_candidates) {
      const row = buildPlanRow({
        canonicalPropertyName: input.room02x.hotel_context.canonical_property_name,
        hotelNo: input.room02x.hotel_context.rakuten_hotel_no,
        roomListUrl: url,
        roomName: candidate.detected_room_name,
        roomUrl: candidate.room_url,
        visibleFSyu: candidate.f_syu,
        visibleFCampId: candidate.f_camp_id,
        hiddenEvidence: hidden.map((hiddenCandidate) => `${hiddenCandidate.identifier_type}=${hiddenCandidate.value}`).join("; "),
        source: "room02x"
      });
      rows.push(row);
    }
  }

  return rankRoomDetailCandidates(rows);
}

export function selectFutureFetchTargets(candidates: RoomDetailLearningPlanRow[], max = MAX_FUTURE_ROOM_DETAIL_FETCHES): RoomDetailLearningPlanRow[] {
  return candidates
    .filter((candidate) => candidate.candidate_room_url)
    .slice(0, max)
    .map((candidate) => ({
      ...candidate,
      recommended_for_follow_up: "true",
      future_fetch_allowed_only_after_approval: "true"
    }));
}

export function buildRakutenRoomDetailLearningProposal(input: {
  runId: string;
  generatedAtJst: string;
  room01xPath: string;
  room01x: Room01xLike;
  room02xPath: string;
  room02x: RakutenRoomListLearningResult;
  savedHtmlPath: string;
  savedHtml: string;
}): RakutenRoomDetailLearningProposal {
  const hidden = detectHiddenIdentifierCandidates(input.savedHtml);
  const roomDetailCandidates = detectRoomDetailLinkCandidates({ html: input.savedHtml, room02x: input.room02x });
  const followUpTargets = selectFutureFetchTargets(roomDetailCandidates);
  const hiddenFSyuCount = hidden.filter((candidate) => candidate.identifier_type === "f_syu").length;
  const hiddenFCampCount = hidden.filter((candidate) => candidate.identifier_type === "f_camp_id").length;
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: decideRakutenRoomDetailLearningProposal(roomDetailCandidates, hidden, followUpTargets),
    source_room01x_artifact: summarizeRoom01xArtifact(input.room01xPath, input.room01x),
    source_room02x_artifact: summarizeRoom02xArtifact(input.room02xPath, input.room02x),
    saved_room_list_html_inspection: inspectSavedRoomListHtml(input.savedHtmlPath, input.savedHtml, input.room02x),
    room_detail_candidate_count: roomDetailCandidates.filter((candidate) => candidate.candidate_room_url).length,
    hidden_f_syu_candidate_count: hiddenFSyuCount,
    hidden_f_camp_id_candidate_count: hiddenFCampCount,
    hidden_identifier_candidates: hidden,
    room_detail_candidates: roomDetailCandidates,
    proposed_follow_up_targets: followUpTargets,
    recommended_next_action: recommendedNextAction(roomDetailCandidates, hidden, followUpTargets),
    max_future_room_detail_fetches: MAX_FUTURE_ROOM_DETAIL_FETCHES,
    expected_confidence_upgrade: expectedConfidenceUpgrade(followUpTargets, hidden),
    risk_assessment: buildRiskAssessment(followUpTargets, hidden),
    sold_out_semantics_guard: evaluateSingleContextSoldOut({
      f_syu: "future_learned_f_syu",
      room_name: "future_learned_room_name",
      known_context_count: 1,
      all_known_contexts_full: false,
      plan_list_no_availability: false,
      explicit_property_no_vacancy: false
    }),
    safety_confirmation: {
      db_writes: false,
      history_modified: false,
      ai_context_refreshed: false,
      broad_collector_run: false,
      hplan_calendar_called: false,
      room_detail_live_fetch: false,
      playwright_used: false,
      paid_source_tooling_used: false,
      booking_used: false
    }
  };
}

export function decideRakutenRoomDetailLearningProposal(
  candidates: RoomDetailLearningPlanRow[],
  hidden: HiddenIdentifierCandidate[],
  followUpTargets: RoomDetailLearningPlanRow[]
): RakutenRoomDetailLearningProposalDecision {
  if (followUpTargets.length > 0 || hidden.length > 0) return "rakuten_room_detail_learning_proposal_ready";
  if (candidates.length > 0) return "rakuten_room_detail_learning_proposal_basis_caution";
  return "rakuten_room_detail_learning_proposal_not_ready";
}

export function renderRakutenRoomDetailLearningProposalCsv(proposal: RakutenRoomDetailLearningProposal): string {
  const lines = [RAKUTEN_ROOM_DETAIL_PLAN_COLUMNS.join(",")];
  for (const row of proposal.room_detail_candidates) {
    lines.push(RAKUTEN_ROOM_DETAIL_PLAN_COLUMNS.map((key) => csvEscape(String(row[key as keyof RoomDetailLearningPlanRow] ?? ""))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function renderRakutenRoomDetailLearningProposalMarkdown(proposal: RakutenRoomDetailLearningProposal): string {
  return [
    "# Rakuten Room-Detail Learning Proposal",
    "",
    "## 1. Summary",
    `- decision = ${proposal.decision}`,
    `- room_detail_candidate_count = ${proposal.room_detail_candidate_count}`,
    `- hidden_f_syu_candidate_count = ${proposal.hidden_f_syu_candidate_count}`,
    `- hidden_f_camp_id_candidate_count = ${proposal.hidden_f_camp_id_candidate_count}`,
    `- max_future_room_detail_fetches = ${proposal.max_future_room_detail_fetches}`,
    `- recommended_next_action = ${proposal.recommended_next_action}`,
    "",
    "## 2. Source Artifacts",
    `- ROOM01X = ${proposal.source_room01x_artifact.path}`,
    `- ROOM02X = ${proposal.source_room02x_artifact.path}`,
    `- saved_html = ${proposal.saved_room_list_html_inspection.debug_html_path}`,
    "",
    "## 3. Room-list Evidence Inspected",
    `- inspected_bytes = ${proposal.saved_room_list_html_inspection.inspected_bytes}`,
    `- contains_room_list_marker = ${proposal.saved_room_list_html_inspection.contains_room_list_marker}`,
    `- contains_hotel_info_js = ${proposal.saved_room_list_html_inspection.contains_hotel_info_js}`,
    `- visible_room_candidate_count_from_room02x = ${proposal.saved_room_list_html_inspection.visible_room_candidate_count_from_room02x}`,
    "",
    "## 4. Room-detail Candidates",
    ...proposal.room_detail_candidates.slice(0, 20).map((row) => `- rank=${row.candidate_rank} | ${row.candidate_room_name} | url=${row.candidate_room_url || "(missing)"} | confidence=${row.confidence} | reason=${row.candidate_reason}`),
    proposal.room_detail_candidates.length === 0 ? "- none" : "",
    "",
    "## 5. Hidden Identifier Candidates",
    ...proposal.hidden_identifier_candidates.map((row) => `- ${row.identifier_type}=${row.value} | confidence=${row.confidence}`),
    proposal.hidden_identifier_candidates.length === 0 ? "- none" : "",
    "",
    "## 6. Proposed Follow-up Targets",
    ...proposal.proposed_follow_up_targets.map((row) => `- rank=${row.candidate_rank} | ${row.candidate_room_name} | ${row.candidate_room_url}`),
    proposal.proposed_follow_up_targets.length === 0 ? "- none; no static room-detail URL was found in saved ROOM02X evidence." : "",
    "",
    "## 7. Sold-out Semantics Guard",
    "- No /hplan/calendar call is allowed until room-context mapping is learned.",
    "- A room-detail page may identify room context, but it still does not prove property-level sold_out.",
    "- Even after f_syu is learned, f_syu full = room_type_context_sold_out only.",
    "- Property-level sold_out requires plan-list-level or all-room-type confirmation.",
    `- property_level_sold_out = ${proposal.sold_out_semantics_guard.property_level_sold_out}`,
    `- usable_for_property_sold_out_pressure = ${proposal.sold_out_semantics_guard.usable_for_property_sold_out_pressure}`,
    "",
    "## 8. Risk Assessment",
    `- risk_level = ${proposal.risk_assessment.risk_level}`,
    ...proposal.risk_assessment.risks.map((risk) => `- risk: ${risk}`),
    ...proposal.risk_assessment.mitigations.map((mitigation) => `- mitigation: ${mitigation}`),
    "",
    "## 9. Safety Confirmation",
    ...Object.entries(proposal.safety_confirmation).map(([key, value]) => `- ${key} = ${value}`),
    ""
  ].join("\n");
}

function buildPlanRow(input: {
  canonicalPropertyName: string;
  hotelNo: string;
  roomListUrl: string;
  roomName: string;
  roomUrl: string;
  visibleFSyu: string;
  visibleFCampId: string;
  hiddenEvidence: string;
  source: "link" | "room02x";
}): RoomDetailLearningPlanRow {
  const hasStableIdentifier = Boolean(input.visibleFSyu || /(?:roomId|room_id|roomCd|room_cd|ryHeyaKihon|f_syu=)/u.test(input.roomUrl));
  const hasUniqueUrl = Boolean(input.roomUrl);
  return {
    canonical_property_name: input.canonicalPropertyName,
    rakuten_hotel_no: input.hotelNo,
    source_room_list_url: input.roomListUrl,
    candidate_room_name: input.roomName,
    candidate_room_url: input.roomUrl,
    candidate_rank: 999,
    candidate_reason: "",
    visible_f_syu: input.visibleFSyu,
    visible_f_camp_id: input.visibleFCampId,
    hidden_identifier_evidence: input.hiddenEvidence,
    recommended_for_follow_up: "false",
    future_fetch_allowed_only_after_approval: "true",
    confidence: hasStableIdentifier ? "A" : hasUniqueUrl ? "B" : "C",
    extraction_warning: hasStableIdentifier
      ? ""
      : hasUniqueUrl
        ? "Room-detail URL is unique, but f_syu is absent; follow-up must verify identifiers."
        : "Weak candidate / generic text only; no room-detail URL is available in saved evidence."
  };
}

function rankRoomDetailCandidates(rows: RoomDetailLearningPlanRow[]): RoomDetailLearningPlanRow[] {
  return rows
    .map((row) => {
      const reasons: string[] = [];
      let score = 0;
      if (row.candidate_room_name && row.candidate_room_url) {
        score += 100;
        reasons.push("explicit room name and unique URL");
      }
      if (/ゲスト棟|倶楽部ルーム|和室ベッド/u.test(row.candidate_room_name)) {
        score += 80;
        reasons.push("matches known AUTO08X bug room context");
      }
      if (row.visible_f_syu || row.visible_f_camp_id) {
        score += 60;
        reasons.push("URL contains useful query params");
      }
      if (row.candidate_room_name && !/禁煙$|喫煙$|和室$|ツイン$|ダブル$|シングル$/u.test(row.candidate_room_name)) {
        score += 20;
        reasons.push("non-generic room type text");
      }
      return { row, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.row.candidate_room_name.localeCompare(b.row.candidate_room_name))
    .map((entry, index) => ({
      ...entry.row,
      candidate_rank: index + 1,
      candidate_reason: entry.reasons.join("; ") || "weak ROOM02X text-only candidate"
    }));
}

function recommendedNextAction(
  candidates: RoomDetailLearningPlanRow[],
  hidden: HiddenIdentifierCandidate[],
  followUpTargets: RoomDetailLearningPlanRow[]
): string {
  if (followUpTargets.length > 0) {
    return "Recommend RAKUTEN-ROOM04X: approved bounded room-detail fetch for 1-3 selected Lucent room pages, static HTML only, no Playwright, no /hplan/calendar.";
  }
  if (hidden.length > 0) {
    return "Recommend RAKUTEN-ROOM04X-P: hidden identifier validation proposal before any live room-detail fetch.";
  }
  if (candidates.length > 0) {
    return "Recommend A: rendered DOM proposal only, because saved static room-list evidence has room text but no room-detail URLs or f_syu identifiers.";
  }
  return "Recommend C: stop Rakuten room mapping until source provides stable identifiers.";
}

function expectedConfidenceUpgrade(followUpTargets: RoomDetailLearningPlanRow[], hidden: HiddenIdentifierCandidate[]): string {
  if (followUpTargets.some((target) => target.confidence === "A") || hidden.some((candidate) => candidate.identifier_type === "f_syu")) {
    return "Potential A if future approved detail fetch confirms room name + f_syu in static HTML.";
  }
  if (followUpTargets.length > 0) return "Potential B/A if future detail HTML exposes f_syu or equivalent room identifier.";
  return "No confidence upgrade from ROOM03X alone; current evidence remains C.";
}

function buildRiskAssessment(followUpTargets: RoomDetailLearningPlanRow[], hidden: HiddenIdentifierCandidate[]): RoomDetailRiskAssessment {
  const noTargets = followUpTargets.length === 0;
  return {
    risk_level: noTargets && hidden.length === 0 ? "medium" : "low",
    risks: [
      "Static ROOM02X evidence may be truncated or may omit links that rendered DOM would expose.",
      "Room-detail pages, if later fetched, may still omit f_syu or use unstable JavaScript-only identifiers.",
      "Learning f_syu does not make single-room sold_out a property-level signal."
    ],
    mitigations: [
      "ROOM03X does not fetch any room-detail page.",
      "Future ROOM04X must cap external room-detail fetches to <= 3 and require explicit approval.",
      "Keep /hplan/calendar blocked until room-context mapping exists and preserve room_type_context sold-out semantics."
    ]
  };
}

function isRoomDetailLikeLink(link: ParsedRakutenLink, roomListUrl: string): boolean {
  if (!link.absolute_url || link.absolute_url === roomListUrl) return false;
  if (/\/hplan\/calendar\//u.test(link.absolute_url)) return false;
  if (/auth\.travel\.rakuten|login|reservation|memberDispatcher/u.test(link.absolute_url)) return false;
  return /\/hotelinfo\/room\/\d+|f_flg=ROOM|room/i.test(link.absolute_url);
}

function roomNameFromLinkText(value: string): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (!/(禁煙|喫煙|和室|洋室|和洋室|ツイン|ダブル|シングル|スイート|ベッド|客室|倶楽部ルーム|ゲスト棟|ジャグジー|離れ)/u.test(cleaned)) {
    return "";
  }
  return normalizeRoomName(cleaned);
}

function matchingRoomNameFromRoom02x(text: string, candidates: RakutenRoomListCandidate[]): string {
  return candidates.find((candidate) => text.includes(candidate.detected_room_name) || text.includes(candidate.normalized_room_name))?.detected_room_name ?? "";
}

function snippetAround(value: string, index: number): string {
  return value.slice(Math.max(0, index - 80), Math.min(value.length, index + 160)).replace(/\s+/gu, " ").trim();
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/u.test(value)) return value;
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

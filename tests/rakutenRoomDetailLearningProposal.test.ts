import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRakutenRoomDetailLearningProposal,
  decideRakutenRoomDetailLearningProposal,
  detectHiddenIdentifierCandidates,
  detectRoomDetailLinkCandidates,
  inspectSavedRoomListHtml,
  renderRakutenRoomDetailLearningProposalCsv,
  renderRakutenRoomDetailLearningProposalMarkdown,
  selectFutureFetchTargets,
  summarizeRoom01xArtifact,
  summarizeRoom02xArtifact
} from "../src/services/rakutenRoomDetailLearningProposal";
import type { RakutenRoomListLearningResult } from "../src/services/rakutenRoomListLearning";

const SERVICE_SOURCE = readFileSync(resolve("src/services/rakutenRoomDetailLearningProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/buildRakutenRoomDetailLearningProposal.ts"), "utf8");

const ROOM_LIST_URL = "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/39565?f_flg=ROOM&f_static=1";

const ROOM01X = {
  decision: "rakuten_room_type_learning_basis_caution",
  hotel_context: {
    rakuten_hotel_no: "39565",
    hotel_name: "蔵王温泉　名湯リゾート　ルーセントタカミヤ",
    room_list_link: ROOM_LIST_URL
  }
};

const ROOM02X: RakutenRoomListLearningResult = {
  run_id: "room02x",
  generated_at_jst: "2026-06-04T12:00:00+09:00",
  decision: "rakuten_room_list_learning_basis_caution",
  source_room01x_artifact: "room01x.json",
  room_list_url: ROOM_LIST_URL,
  hotel_context: {
    canonical_property_name: "名湯リゾート ルーセント",
    rakuten_hotel_no: "39565",
    hotel_name: "蔵王温泉　名湯リゾート　ルーセントタカミヤ 部屋一覧",
    source_url: ROOM_LIST_URL,
    source_page_type: "room_list",
    room_list_context_detected: true,
    room_list_signals: ["URL query has f_flg=ROOM"],
    f_syu_visible_in_room_list_html: false,
    next_required_step: "bounded room-detail learning proposal"
  },
  parsed_room_links: [],
  room_type_candidates: [
    {
      detected_room_name: "※禁煙※【ザ・ゲスト棟】和室ベッド／バス付 ＜倶楽部ルーム＞",
      normalized_room_name: "禁煙ザ・ゲスト棟和室ベッド/バス付 <倶楽部ルーム>",
      room_url: "",
      f_syu: "",
      f_camp_id: "",
      source: "visible_text",
      confidence: "C",
      evidence: "club room text",
      requires_follow_up: true,
      warning: "weak"
    },
    {
      detected_room_name: "和室",
      normalized_room_name: "和室",
      room_url: "",
      f_syu: "",
      f_camp_id: "",
      source: "visible_text",
      confidence: "C",
      evidence: "和室",
      requires_follow_up: true,
      warning: "weak"
    }
  ],
  f_syu_candidates: [],
  f_camp_id_candidates: [],
  room_type_master_preview: [],
  sold_out_semantics_guard: {
    calendar_context_type: "room_type_level",
    classification_for_single_full_context: "rakuten_room_type_context_sold_out",
    property_level_sold_out: false,
    usable_for_property_sold_out_pressure: false,
    property_level_requirements: []
  },
  extraction_warnings: [],
  safety_confirmation: {}
};

const HTML_WITH_DETAIL_LINKS = `
<html>
<head><title>部屋一覧</title></head>
<body>
  <h1>部屋一覧</h1>
  <script>var hotelInfo = {"flg":"ROOM"};</script>
  <a href="/hotelinfo/room/39565?roomId=abc001">和室</a>
  <a href="/hotelinfo/room/39565?f_syu=honkan-exk">※禁煙※【ザ・ゲスト棟】和室ベッド／バス付 ＜倶楽部ルーム＞</a>
  <a href="/hotelinfo/room/39565?roomId=abc002">ツインルーム</a>
  <a href="/hotelinfo/room/39565/detail/double">ダブルルーム</a>
  <input type="hidden" name="f_camp_id" value="5623966">
</body>
</html>
`;

const HTML_WITHOUT_DETAIL_LINKS = `
<html><body><h1>部屋一覧</h1><script>var hotelInfo = {"flg":"ROOM"};</script><p>※禁煙※【ザ・ゲスト棟】和室ベッド／バス付 ＜倶楽部ルーム＞</p></body></html>
`;

describe("rakuten room-detail learning proposal", () => {
  it("loads ROOM01X artifact summary", () => {
    expect(summarizeRoom01xArtifact("room01x.json", ROOM01X).hotel_no).toBe("39565");
  });

  it("loads ROOM02X artifact summary", () => {
    expect(summarizeRoom02xArtifact("room02x.json", ROOM02X).room_type_master_rows).toBe(0);
  });

  it("parses saved room-list evidence", () => {
    const inspection = inspectSavedRoomListHtml("debug.html", HTML_WITH_DETAIL_LINKS, ROOM02X);
    expect(inspection.contains_room_list_marker).toBe(true);
    expect(inspection.contains_hotel_info_js).toBe(true);
  });

  it("detects room-detail link candidates when present", () => {
    const rows = detectRoomDetailLinkCandidates({ html: HTML_WITH_DETAIL_LINKS, room02x: ROOM02X });
    expect(rows.some((row) => row.candidate_room_url.includes("/hotelinfo/room/39565"))).toBe(true);
  });

  it("detects hidden f_syu candidates when present", () => {
    expect(detectHiddenIdentifierCandidates(`<input name="f_syu" value="honkan-exk">`).map((row) => row.value)).toContain("honkan-exk");
  });

  it("detects hidden f_camp_id candidates when present", () => {
    expect(detectHiddenIdentifierCandidates(HTML_WITH_DETAIL_LINKS).map((row) => row.value)).toContain("5623966");
  });

  it("does not invent f_syu when absent", () => {
    expect(detectHiddenIdentifierCandidates(HTML_WITHOUT_DETAIL_LINKS).filter((row) => row.identifier_type === "f_syu")).toHaveLength(0);
  });

  it("ranks candidate matching known club-room name higher", () => {
    const rows = detectRoomDetailLinkCandidates({ html: HTML_WITH_DETAIL_LINKS, room02x: ROOM02X });
    expect(rows[0]?.candidate_room_name).toContain("倶楽部ルーム");
  });

  it("limits future fetch proposal to <= 3 pages", () => {
    const rows = detectRoomDetailLinkCandidates({ html: HTML_WITH_DETAIL_LINKS, room02x: ROOM02X });
    expect(selectFutureFetchTargets(rows).length).toBeLessThanOrEqual(3);
  });

  it("produces follow-up plan but does not fetch", () => {
    const proposal = buildRakutenRoomDetailLearningProposal({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room01xPath: "room01x.json",
      room01x: ROOM01X,
      room02xPath: "room02x.json",
      room02x: ROOM02X,
      savedHtmlPath: "debug.html",
      savedHtml: HTML_WITH_DETAIL_LINKS
    });
    expect(proposal.proposed_follow_up_targets.length).toBeGreaterThan(0);
    expect(proposal.safety_confirmation.room_detail_live_fetch).toBe(false);
  });

  it("produces confidence A/B/C", () => {
    const rows = detectRoomDetailLinkCandidates({ html: HTML_WITH_DETAIL_LINKS, room02x: ROOM02X });
    const weak = detectRoomDetailLinkCandidates({ html: HTML_WITHOUT_DETAIL_LINKS, room02x: ROOM02X });
    expect(rows.map((row) => row.confidence)).toContain("A");
    expect(rows.map((row) => row.confidence)).toContain("B");
    expect(weak.map((row) => row.confidence)).toContain("C");
  });

  it("includes sold-out semantics guard", () => {
    const proposal = buildRakutenRoomDetailLearningProposal({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room01xPath: "room01x.json",
      room01x: ROOM01X,
      room02xPath: "room02x.json",
      room02x: ROOM02X,
      savedHtmlPath: "debug.html",
      savedHtml: HTML_WITHOUT_DETAIL_LINKS
    });
    expect(proposal.sold_out_semantics_guard.property_level_sold_out).toBe(false);
  });

  it("renders markdown and csv", () => {
    const proposal = buildRakutenRoomDetailLearningProposal({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room01xPath: "room01x.json",
      room01x: ROOM01X,
      room02xPath: "room02x.json",
      room02x: ROOM02X,
      savedHtmlPath: "debug.html",
      savedHtml: HTML_WITHOUT_DETAIL_LINKS
    });
    expect(renderRakutenRoomDetailLearningProposalMarkdown(proposal)).toContain("No /hplan/calendar call is allowed");
    expect(renderRakutenRoomDetailLearningProposalCsv(proposal)).not.toMatch(/roomid|inventory|minstay|maxstay|price1|Beds24|AirHost|PMS/i);
  });

  it("does not call /hplan/calendar", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/buildHplanCalendarUrl|\/hplan\/calendar\/\?/u);
  });

  it("does not write DB", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/better-sqlite3|openLocalDatabase|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|CREATE\s+TABLE/i);
  });

  it("does not modify .data/history", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/u);
  });

  it("does not refresh AI context", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("aiContextPackGenerator");
  });

  it("does not run live room-detail fetch", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\bfetch\s*\(/u);
  });

  it("does not use Playwright", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium\.|firefox\.|webkit\./i);
  });

  it("has no paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/i);
  });

  it("decision ready/basis_caution/not_ready", () => {
    expect([
      "rakuten_room_detail_learning_proposal_ready",
      "rakuten_room_detail_learning_proposal_basis_caution",
      "rakuten_room_detail_learning_proposal_not_ready"
    ]).toContain(decideRakutenRoomDetailLearningProposal([], [], []));
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRakutenRoomListLearningResult,
  buildRoomListMasterRows,
  detectRoomListContext,
  extractRoomLinksFromRoomListHtml,
  extractRoomListCandidates,
  extractRoomListUrlFromRoom01xArtifact,
  renderRakutenRoomListLearningCsv,
  renderRakutenRoomListLearningMarkdown,
  type Room01xArtifactLike
} from "../src/services/rakutenRoomListLearning";
import { extractParamCandidates, extractRakutenLinks } from "../src/services/rakutenRoomTypeLearning";

const SERVICE_SOURCE = readFileSync(resolve("src/services/rakutenRoomListLearning.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/buildRakutenRoomListLearning.ts"), "utf8");

const ROOM_LIST_URL =
  "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/39565?f_flg=ROOM&f_static=1&f_page_no=1&f_sort=minNo";

const ROOM01X: Room01xArtifactLike = {
  decision: "rakuten_room_type_learning_basis_caution",
  hotel_context: {
    canonical_property_name: "名湯リゾート ルーセント",
    rakuten_hotel_no: "39565",
    hotel_name: "蔵王温泉　名湯リゾート　ルーセントタカミヤ",
    room_list_link: ROOM_LIST_URL
  },
  parsed_links: []
};

const ROOM_LIST_HTML = `
<!doctype html>
<html lang="ja">
<head><title>蔵王温泉 名湯リゾート ルーセントタカミヤ 部屋一覧【楽天トラベル】</title></head>
<body>
  <h1>蔵王温泉 名湯リゾート ルーセントタカミヤ</h1>
  <h2>部屋一覧</h2>
  <section class="room">
    <a href="/hotelinfo/room/39565?f_syu=honkan-exk">※禁煙※【ザ・ゲスト棟】和室ベッド／バス付 ＜倶楽部ルーム＞</a>
  </section>
  <section class="room">
    <a href="/hotelinfo/room/39565?f_syu=honkan-twn&amp;f_camp_id=222">ツインルーム／バス付</a>
  </section>
  <section class="room">和洋室 露天風呂付</section>
</body>
</html>
`;

const ROOM_LIST_HTML_NO_FSYU = `
<!doctype html>
<html lang="ja">
<head><title>蔵王温泉 名湯リゾート ルーセントタカミヤ 部屋一覧【楽天トラベル】</title></head>
<body>
  <h1>蔵王温泉 名湯リゾート ルーセントタカミヤ</h1>
  <h2>部屋一覧</h2>
  <section class="room">
    <a href="/hotelinfo/room/39565?id=abc">※禁煙※【ザ・ゲスト棟】和室ベッド／バス付 ＜倶楽部ルーム＞</a>
  </section>
  <section class="room">和洋室 露天風呂付</section>
</body>
</html>
`;

describe("rakuten room-list learning", () => {
  it("loads ROOM01X artifact shape and extracts room-list URL", () => {
    expect(extractRoomListUrlFromRoom01xArtifact(ROOM01X)).toBe(ROOM_LIST_URL);
  });

  it("extracts room-list URL from parsed ROOM01X links when direct field is absent", () => {
    const artifact: Room01xArtifactLike = {
      hotel_context: { canonical_property_name: "名湯リゾート ルーセント" },
      parsed_links: [{
        text: "部屋一覧",
        href: ROOM_LIST_URL,
        absolute_url: ROOM_LIST_URL,
        f_syu: "",
        f_camp_id: ""
      }]
    };
    expect(extractRoomListUrlFromRoom01xArtifact(artifact)).toBe(ROOM_LIST_URL);
  });

  it("parses hotelNo 39565 from room-list URL through result builder", () => {
    const result = buildRakutenRoomListLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      sourceRoom01xArtifact: "room01x.json",
      room01xArtifact: ROOM01X,
      html: ROOM_LIST_HTML
    });
    expect(result.hotel_context.rakuten_hotel_no).toBe("39565");
  });

  it("detects room-list page context", () => {
    const context = detectRoomListContext(ROOM_LIST_HTML, ROOM_LIST_URL);
    expect(context.detected).toBe(true);
    expect(context.sourcePageType).toBe("room_list");
    expect(context.signals.join("\n")).toContain("f_flg=ROOM");
  });

  it("extracts room names from sample room-list HTML", () => {
    const names = extractRoomListCandidates(ROOM_LIST_HTML, ROOM_LIST_URL).map((row) => row.detected_room_name);
    expect(names.join("\n")).toContain("倶楽部ルーム");
    expect(names.join("\n")).toContain("ツインルーム");
  });

  it("extracts room URLs from sample room-list HTML", () => {
    const urls = extractRoomLinksFromRoomListHtml(ROOM_LIST_HTML, ROOM_LIST_URL).map((row) => row.absolute_url);
    expect(urls.some((url) => url.includes("/hotelinfo/room/39565"))).toBe(true);
  });

  it("extracts f_syu params when present in sample links", () => {
    const links = extractRakutenLinks(ROOM_LIST_HTML, ROOM_LIST_URL);
    expect(extractParamCandidates(links, "f_syu").map((row) => row.value)).toEqual(["honkan-exk", "honkan-twn"]);
  });

  it("does not invent f_syu when absent", () => {
    const result = buildRakutenRoomListLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      sourceRoom01xArtifact: "room01x.json",
      room01xArtifact: ROOM01X,
      html: ROOM_LIST_HTML_NO_FSYU
    });
    expect(result.f_syu_candidates).toHaveLength(0);
    expect(result.room_type_master_preview.every((row) => row.f_syu === "")).toBe(true);
    expect(result.extraction_warnings.join("\n")).toContain("do not invent f_syu");
  });

  it("builds room_type_master rows", () => {
    const rows = buildRoomListMasterRows({
      canonicalPropertyName: "名湯リゾート ルーセント",
      rakutenHotelNo: "39565",
      sourceUrl: ROOM_LIST_URL,
      candidates: extractRoomListCandidates(ROOM_LIST_HTML, ROOM_LIST_URL),
      generatedAtJst: "2026-06-04T12:00:00+09:00"
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.learned_from === "room_list")).toBe(true);
  });

  it("assigns confidence A when room name + f_syu are present", () => {
    expect(extractRoomListCandidates(ROOM_LIST_HTML, ROOM_LIST_URL).some((row) => row.confidence === "A" && row.f_syu)).toBe(true);
  });

  it("assigns confidence B when room name + URL are present but f_syu absent", () => {
    expect(extractRoomListCandidates(ROOM_LIST_HTML_NO_FSYU, ROOM_LIST_URL).some((row) => row.confidence === "B" && !row.f_syu && row.room_url)).toBe(true);
  });

  it("assigns confidence C for weak text-only candidates", () => {
    expect(extractRoomListCandidates(ROOM_LIST_HTML_NO_FSYU, ROOM_LIST_URL).some((row) => row.confidence === "C" && !row.room_url)).toBe(true);
  });

  it("marks next_required_step when f_syu absent", () => {
    const result = buildRakutenRoomListLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      sourceRoom01xArtifact: "room01x.json",
      room01xArtifact: ROOM01X,
      html: ROOM_LIST_HTML_NO_FSYU
    });
    expect(result.hotel_context.next_required_step).toBe("bounded room-detail learning proposal");
  });

  it("prevents f_syu/room-type sold_out from property-level sold_out", () => {
    const result = buildRakutenRoomListLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      sourceRoom01xArtifact: "room01x.json",
      room01xArtifact: ROOM01X,
      html: ROOM_LIST_HTML
    });
    expect(result.sold_out_semantics_guard.property_level_sold_out).toBe(false);
    expect(result.sold_out_semantics_guard.usable_for_property_sold_out_pressure).toBe(false);
  });

  it("renders report and CSV", () => {
    const result = buildRakutenRoomListLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      sourceRoom01xArtifact: "room01x.json",
      room01xArtifact: ROOM01X,
      html: ROOM_LIST_HTML
    });
    expect(renderRakutenRoomListLearningMarkdown(result)).toContain("Sold-out Semantics Guard");
    expect(renderRakutenRoomListLearningCsv(result)).not.toMatch(/roomid|inventory|minstay|maxstay|price1|Beds24|AirHost|PMS/i);
  });

  it("does not call /hplan/calendar", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/fetchStaticHtml\([^)]*hplan\/calendar/u);
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

  it("does not use Playwright", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium\.|firefox\.|webkit\./i);
  });

  it("has no paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/i);
  });

  it("decision is ready/basis_caution", () => {
    const result = buildRakutenRoomListLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      sourceRoom01xArtifact: "room01x.json",
      room01xArtifact: ROOM01X,
      html: ROOM_LIST_HTML_NO_FSYU
    });
    expect(["rakuten_room_list_learning_ready", "rakuten_room_list_learning_basis_caution"]).toContain(result.decision);
  });
});

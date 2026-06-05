import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auto08xBugPreventionStatement,
  buildRakutenRoomTypeLearningResult,
  buildRoomTypeMasterRows,
  classifyRakutenCalendarContext,
  detectHotelName,
  detectPlanListContext,
  evaluateSingleContextSoldOut,
  extractParamCandidates,
  extractPlanCandidates,
  extractRakutenLinks,
  extractRoomTypeCandidates,
  normalizeRoomName,
  parseRakutenHotelNoFromUrl,
  propertyLevelSoldOutRequirements,
  renderRakutenRoomTypeLearningCsv,
  renderRakutenRoomTypeLearningMarkdown
} from "../src/services/rakutenRoomTypeLearning";

const SERVICE_SOURCE = readFileSync(resolve("src/services/rakutenRoomTypeLearning.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/buildRakutenRoomTypeLearning.ts"), "utf8");

const PLAN_LIST_URL =
  "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/39565?f_flg=PLAN&f_camp_id=&f_static=1&f_hi1=24&f_tuki1=6&f_nen1=2026&f_hi2=25&f_tuki2=6&f_nen2=2026&f_heya_su=1&f_otona_su=2";

const FIXTURE_HTML = `
<!doctype html>
<html lang="ja">
<head><title>蔵王温泉 名湯リゾート ルーセントタカミヤ 宿泊プラン一覧【楽天トラベル】</title></head>
<body>
  <h1>蔵王温泉 名湯リゾート ルーセントタカミヤ</h1>
  <h2>宿泊プラン一覧</h2>
  <a href="/hotelinfo/room/39565">部屋一覧</a>
  <section>部屋タイプ
    <span>※禁煙※【ザ・ゲスト棟】和室ベッド／バス付 ＜倶楽部ルーム＞</span>
  </section>
  <a href="/hotelinfo/plan/39565?f_syu=honkan-exk&amp;f_camp_id=5623966">
    【ザ・ゲスト棟】和室ベッド ＜倶楽部ルーム＞ 夕食付プラン
  </a>
  <a href="/hotelinfo/plan/39565?f_camp_id=1234567">米沢牛を味わう温泉プラン</a>
  <p>合計料金 ※1部屋あたりの税込金額</p>
</body>
</html>
`;

describe("rakuten room-type learning", () => {
  it("parses hotelNo from Rakuten plan-list URL", () => {
    expect(parseRakutenHotelNoFromUrl(PLAN_LIST_URL)).toBe("39565");
  });

  it("detects hotel name", () => {
    expect(detectHotelName(FIXTURE_HTML)).toContain("ルーセントタカミヤ");
  });

  it("detects plan-list context", () => {
    const context = detectPlanListContext(FIXTURE_HTML, PLAN_LIST_URL);
    expect(context.detected).toBe(true);
    expect(context.sourcePageType).toBe("plan_list");
    expect(context.signals.join("\n")).toContain("宿泊プラン一覧");
  });

  it("detects room-list link if present", () => {
    const links = extractRakutenLinks(FIXTURE_HTML, PLAN_LIST_URL);
    expect(links.some((link) => link.text === "部屋一覧" && link.absolute_url.includes("/hotelinfo/room/39565"))).toBe(true);
  });

  it("extracts f_syu params from sample links", () => {
    const links = extractRakutenLinks(FIXTURE_HTML, PLAN_LIST_URL);
    expect(extractParamCandidates(links, "f_syu").map((row) => row.value)).toEqual(["honkan-exk"]);
  });

  it("extracts f_camp_id params from sample links", () => {
    const links = extractRakutenLinks(FIXTURE_HTML, PLAN_LIST_URL);
    expect(extractParamCandidates(links, "f_camp_id").map((row) => row.value)).toEqual(["5623966", "1234567"]);
  });

  it("normalizes room names", () => {
    expect(normalizeRoomName("※禁煙※【ザ・ゲスト棟】和室ベッド／バス付 ＜倶楽部ルーム＞")).toBe(
      "禁煙ザ・ゲスト棟和室ベッド/バス付 <倶楽部ルーム>"
    );
  });

  it("builds room_type_master rows", () => {
    const links = extractRakutenLinks(FIXTURE_HTML, PLAN_LIST_URL);
    const rows = buildRoomTypeMasterRows({
      canonicalPropertyName: "名湯リゾート ルーセント",
      rakutenHotelNo: "39565",
      sourcePageType: "plan_list",
      sourceUrl: PLAN_LIST_URL,
      roomListUrl: "https://hotel.travel.rakuten.co.jp/hotelinfo/room/39565",
      roomCandidates: extractRoomTypeCandidates(FIXTURE_HTML, links),
      planCandidates: extractPlanCandidates(links),
      generatedAtJst: "2026-06-04T12:00:00+09:00"
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.f_syu === "honkan-exk")).toBe(true);
    expect(rows.some((row) => row.f_camp_id === "5623966")).toBe(true);
  });

  it("does not invent f_syu when absent", () => {
    const html = `<h1>蔵王温泉 名湯リゾート ルーセントタカミヤ</h1><h2>宿泊プラン一覧</h2><p>合計料金 ※1部屋あたりの税込金額</p><a href="/hotelinfo/plan/39565?f_camp_id=111">和室ベッド 温泉プラン</a>`;
    const result = buildRakutenRoomTypeLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      canonicalPropertyName: "名湯リゾート ルーセント",
      sourceUrl: PLAN_LIST_URL,
      html
    });
    expect(result.room_type_master_preview.every((row) => row.f_syu === "")).toBe(true);
    expect(result.extraction_warnings.join("\n")).toContain("do not invent f_syu");
  });

  it("marks weak extraction as confidence B/C", () => {
    const html = `<h1>蔵王温泉 名湯リゾート ルーセントタカミヤ</h1><h2>宿泊プラン一覧</h2><p>部屋タイプ 和室ベッド 禁煙</p><p>合計料金 ※1部屋あたりの税込金額</p>`;
    const links = extractRakutenLinks(html, PLAN_LIST_URL);
    expect(extractRoomTypeCandidates(html, links).map((row) => row.confidence)).toContain("C");
  });

  it("marks f_syu calendar context as room_type/f_syu level", () => {
    expect(classifyRakutenCalendarContext({ f_syu: "honkan-exk", room_name: "", f_camp_id: "" })).toBe("f_syu_level");
    expect(classifyRakutenCalendarContext({ f_syu: "honkan-exk", room_name: "和室ベッド", f_camp_id: "" })).toBe("room_type_level");
  });

  it("prevents f_syu full from property-level sold_out", () => {
    const guard = evaluateSingleContextSoldOut({
      f_syu: "honkan-exk",
      room_name: "ザ・ゲスト棟 和室ベッド ＜倶楽部ルーム＞",
      known_context_count: 1,
      all_known_contexts_full: false,
      plan_list_no_availability: false,
      explicit_property_no_vacancy: false
    });
    expect(guard.property_level_sold_out).toBe(false);
    expect(guard.usable_for_property_sold_out_pressure).toBe(false);
    expect(guard.classification_for_single_full_context).toBe("rakuten_room_type_context_sold_out");
  });

  it("requires multiple contexts for property-level sold_out", () => {
    expect(propertyLevelSoldOutRequirements().join("\n")).toContain("all learned room types");
    expect(evaluateSingleContextSoldOut({
      f_syu: "honkan-exk",
      room_name: "和室ベッド",
      known_context_count: 3,
      all_known_contexts_full: true,
      plan_list_no_availability: false,
      explicit_property_no_vacancy: false
    }).property_level_sold_out).toBe(true);
  });

  it("includes AUTO08X bug-prevention statement", () => {
    expect(auto08xBugPreventionStatement().join("\n")).toContain("AUTO08X bug");
    expect(auto08xBugPreventionStatement().join("\n")).toContain("room_type_master");
  });

  it("renders report and CSV without forbidden PMS columns", () => {
    const result = buildRakutenRoomTypeLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      canonicalPropertyName: "名湯リゾート ルーセント",
      sourceUrl: PLAN_LIST_URL,
      html: FIXTURE_HTML
    });
    const md = renderRakutenRoomTypeLearningMarkdown(result);
    const csv = renderRakutenRoomTypeLearningCsv(result);
    expect(md).toContain("single_f_syu_full_property_level_sold_out = false");
    expect(csv).not.toMatch(/roomid|inventory|minstay|maxstay|price1|Beds24|AirHost|PMS/i);
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

  it("does not run broad collectors", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("real-run:auto-history-append");
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("collect:jalan");
  });

  it("does not use Playwright by default", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium\.|firefox\.|webkit\./i);
  });

  it("has no paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/i);
  });

  it("decision is ready/basis_caution when static extraction has candidates", () => {
    const result = buildRakutenRoomTypeLearningResult({
      runId: "run",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      canonicalPropertyName: "名湯リゾート ルーセント",
      sourceUrl: PLAN_LIST_URL,
      html: FIXTURE_HTML
    });
    expect(["rakuten_room_type_learning_ready", "rakuten_room_type_learning_basis_caution"]).toContain(result.decision);
  });
});

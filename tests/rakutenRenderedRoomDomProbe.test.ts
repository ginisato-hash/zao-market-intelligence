import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRenderedRoomDom,
  buildRakutenRenderedRoomDomResult,
  classifyCandidateConfidence,
  classifyLearnedFrom,
  decideRakutenPriority,
  decideRakutenRenderedRoomDom,
  detectBlockedOrCaptcha,
  extractDataAttributes,
  extractFCampIdFromLinks,
  extractFSyuFromLinks,
  extractProbeTargetUrl,
  extractRoomNamesFromDom,
  extractScriptStateCandidates,
  parseRenderedLinks,
  renderRakutenRenderedRoomDomReport,
  ROOM01X_ARTIFACT_PATH,
  ROOM02X_ARTIFACT_PATH,
  ROOM03X_ARTIFACT_PATH,
  type RenderedRoomDomInput
} from "../src/services/rakutenRenderedRoomDomProbe";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/rakutenRenderedRoomDomProbe.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/probeRakutenRenderedRoomDom.ts"), "utf8");

const ROOM_LIST_URL =
  "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/39565?f_flg=ROOM&f_static=1&f_nen1=2026&f_tuki1=6&f_hi1=24";

const PAD = "蔵王温泉 名湯リゾート ルーセントタカミヤ 部屋一覧 のページです。".repeat(20);

function renderedInput(overrides: Partial<RenderedRoomDomInput> = {}): RenderedRoomDomInput {
  return {
    loaded: true,
    httpStatus: 200,
    finalUrl: ROOM_LIST_URL,
    pageTitle: "蔵王温泉　名湯リゾート　ルーセントタカミヤ 部屋一覧",
    bodyText: PAD,
    bodyHtml: `<html><body><h1>名湯リゾート ルーセント 部屋一覧</h1><p>${PAD}</p></body></html>`,
    sourceUrl: ROOM_LIST_URL,
    error: "",
    ...overrides
  };
}

// A rendered room-list page that exposes a room-detail link WITH f_syu.
const HTML_WITH_FSYU = `<html><body><h1>名湯リゾート ルーセント 部屋一覧</h1>
<ul>
  <li><a href="https://hotel.travel.rakuten.co.jp/hotelinfo/room/39565?f_syu=guest-twin&f_otona_su=2">※禁煙※【ザ・ゲスト棟】和室ベッド付　＜倶楽部ルーム＞</a></li>
</ul>
<p>${PAD}</p>
</body></html>`;

// A rendered room-list page with a unique room URL but NO f_syu.
const HTML_URL_NO_FSYU = `<html><body><h1>名湯リゾート ルーセント 部屋一覧</h1>
<ul>
  <li><a href="https://hotel.travel.rakuten.co.jp/hotelinfo/room/39565?f_page_no=1">南館和室【14畳+広縁】</a></li>
</ul>
<p>${PAD}</p>
</body></html>`;

// A rendered room-list page with text-only room names, no links.
const HTML_TEXT_ONLY = `<html><body><h1>名湯リゾート ルーセント 部屋一覧</h1>
<ul>
  <li>南館和室【14畳+広縁】</li>
  <li>本館ツインルーム</li>
</ul>
<p>${PAD}</p>
</body></html>`;

describe("ROOM04X source artifact loading", () => {
  it("1. loads ROOM01X artifact", () => {
    const artifact = JSON.parse(readFileSync(resolve(ROOM01X_ARTIFACT_PATH), "utf8"));
    expect(artifact.decision).toBeDefined();
    expect(artifact.hotel_context).toBeDefined();
  });

  it("2. loads ROOM02X artifact", () => {
    const artifact = JSON.parse(readFileSync(resolve(ROOM02X_ARTIFACT_PATH), "utf8"));
    expect(artifact.room_list_url).toContain("39565");
  });

  it("3. loads ROOM03X artifact", () => {
    const artifact = JSON.parse(readFileSync(resolve(ROOM03X_ARTIFACT_PATH), "utf8"));
    expect(artifact.decision).toBeDefined();
  });

  it("4. extracts probe target URL from ROOM02X artifact", () => {
    expect(extractProbeTargetUrl({ room_list_url: ROOM_LIST_URL })).toBe(ROOM_LIST_URL);
    expect(extractProbeTargetUrl({ room_list_url: "https://example.com/no-room-flag" })).toBe("");
  });
});

describe("ROOM04X rendered DOM extraction", () => {
  it("5. parses rendered links from sample DOM", () => {
    const links = parseRenderedLinks(HTML_WITH_FSYU, ROOM_LIST_URL);
    expect(links.length).toBeGreaterThan(0);
  });

  it("6. extracts f_syu from rendered links when present", () => {
    const links = parseRenderedLinks(HTML_WITH_FSYU, ROOM_LIST_URL);
    expect(extractFSyuFromLinks(links)).toContain("guest-twin");
  });

  it("7. extracts f_camp_id from rendered links when present", () => {
    const html = `<a href="https://hotel.travel.rakuten.co.jp/hotelinfo/room/39565?f_camp_id=999888&f_syu=x">和室プラン</a>`;
    const links = parseRenderedLinks(html, ROOM_LIST_URL);
    expect(extractFCampIdFromLinks(links)).toContain("999888");
  });

  it("8. extracts room names from rendered DOM", () => {
    const names = extractRoomNamesFromDom(HTML_TEXT_ONLY);
    expect(names.some((n) => n.includes("和室"))).toBe(true);
  });

  it("9. detects data attributes from rendered DOM", () => {
    const html = `<div data-room-id="abc123" data-unrelated="x">room</div>`;
    const attrs = extractDataAttributes(html);
    expect(attrs.some((a) => a.name === "data-room-id" && a.looks_like_room_id)).toBe(true);
  });

  it("10. detects script-state candidates from rendered DOM", () => {
    const html = `<script>var state = {"f_syu":"guest-twin","planId":"PLAN42"};</script>`;
    const candidates = extractScriptStateCandidates(html);
    expect(candidates.some((c) => c.key === "f_syu" && c.value === "guest-twin")).toBe(true);
  });

  it("11. does not invent f_syu when absent", () => {
    const links = parseRenderedLinks(HTML_URL_NO_FSYU, ROOM_LIST_URL);
    expect(extractFSyuFromLinks(links)).toEqual([]);
    const signals = analyzeRenderedRoomDom(renderedInput({ bodyHtml: HTML_URL_NO_FSYU }));
    expect(signals.fSyuValues).toEqual([]);
  });

  it("12. separates learned_from_rendered_dom from known_from_previous_bug_artifact", () => {
    expect(classifyLearnedFrom("guest-twin", true)).toBe("learned_from_rendered_dom");
    expect(classifyLearnedFrom("honkan-exk", false)).toBe("known_from_previous_bug_artifact");
    expect(classifyLearnedFrom("honkan-exk", true)).toBe("learned_from_rendered_dom");
  });

  it("13. produces confidence A/B/C", () => {
    expect(classifyCandidateConfidence({ candidate_room_name: "和室", candidate_url: "u", visible_f_syu: "x" })).toBe("A");
    expect(classifyCandidateConfidence({ candidate_room_name: "和室", candidate_url: "u", visible_f_syu: "" })).toBe("B");
    expect(classifyCandidateConfidence({ candidate_room_name: "", candidate_url: "", visible_f_syu: "" })).toBe("C");
  });

  it("14. detects blocked/CAPTCHA/403 state", () => {
    expect(detectBlockedOrCaptcha({ loaded: true, httpStatus: 403, bodyText: "x", pageTitle: "" }).http_forbidden).toBe(true);
    expect(
      detectBlockedOrCaptcha({ loaded: true, httpStatus: 200, bodyText: "ロボットではありません", pageTitle: "" }).captcha_detected
    ).toBe(true);
    expect(detectBlockedOrCaptcha({ loaded: false, httpStatus: 0, bodyText: "", pageTitle: "" }).blocked).toBe(true);
  });
});

describe("ROOM04X safety scans", () => {
  it("15. does not call /hplan/calendar", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(goto|fetch|request)\s*\([^)]*hplan/iu);
    expect(SERVICE_SOURCE).not.toMatch(/(goto|fetch|request)\s*\([^)]*hplan/iu);
  });

  it("16. does not follow room detail links (single navigation, no clicks)", () => {
    expect((SCRIPT_SOURCE.match(/\.goto\(/gu) ?? []).length).toBeLessThanOrEqual(1);
    expect(SCRIPT_SOURCE).not.toMatch(/\.click\(/u);
  });

  it("17. does not write DB", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/better-sqlite3|new Database\(|INSERT\s+INTO|\.prepare\(/iu);
    }
  });

  it("18. does not modify .data/history", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFile|writeFileSync|appendFile|appendFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/u);
    }
  });

  it("19. does not refresh AI context", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/build:ai-context|buildAiContextPacks|execFileSync|execSync|spawnSync/u);
    }
  });

  it("20. does not use stealth/cookie/login", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/addCookies|setCookie|playwright-extra|puppeteer-extra|stealth\s*\(|\.fill\(|page\.type\(/iu);
    }
  });

  it("21. no paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/from\s+["'][^"']*(serpapi|apify|oxylabs|dataforseo|brightdata)/iu);
    }
  });
});

describe("ROOM04X decisions and report", () => {
  it("22. produces GO_FOR_ROOM_MASTER_BUILD when stable identifiers are found", () => {
    const result = buildRakutenRenderedRoomDomResult({
      runId: "t",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room02xArtifact: { room_list_url: ROOM_LIST_URL },
      probeTargetUrl: ROOM_LIST_URL,
      rendered: renderedInput({ bodyHtml: HTML_WITH_FSYU })
    });
    expect(result.decision).toBe("rakuten_rendered_room_dom_probe_ready");
    expect(result.rakuten_priority_decision).toBe("GO_FOR_ROOM_MASTER_BUILD");
  });

  it("23. produces CONDITIONAL_CONTINUE when only unique URLs / script hints are found", () => {
    const signals = analyzeRenderedRoomDom(renderedInput({ bodyHtml: HTML_URL_NO_FSYU }));
    const result = buildRakutenRenderedRoomDomResult({
      runId: "t",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room02xArtifact: { room_list_url: ROOM_LIST_URL },
      probeTargetUrl: ROOM_LIST_URL,
      rendered: renderedInput({ bodyHtml: HTML_URL_NO_FSYU })
    });
    expect(signals.fSyuValues).toEqual([]);
    expect(result.decision).toBe("rakuten_rendered_room_dom_probe_basis_caution");
    expect(result.rakuten_priority_decision).toBe("CONDITIONAL_CONTINUE");
  });

  it("24. produces NO_GO_FREEZE_RAKUTEN when no stable identifiers are found", () => {
    const result = buildRakutenRenderedRoomDomResult({
      runId: "t",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room02xArtifact: { room_list_url: ROOM_LIST_URL },
      probeTargetUrl: ROOM_LIST_URL,
      rendered: renderedInput({ bodyHtml: HTML_TEXT_ONLY })
    });
    expect(result.rakuten_priority_decision).toBe("NO_GO_FREEZE_RAKUTEN");

    // Blocked pages are always No-Go.
    const blocked = buildRakutenRenderedRoomDomResult({
      runId: "t",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room02xArtifact: { room_list_url: ROOM_LIST_URL },
      probeTargetUrl: ROOM_LIST_URL,
      rendered: renderedInput({ httpStatus: 403, bodyText: "Access Denied" })
    });
    expect(blocked.decision).toBe("rakuten_rendered_room_dom_probe_not_ready");
    expect(blocked.rakuten_priority_decision).toBe("NO_GO_FREEZE_RAKUTEN");
  });

  it("25. includes strategic recommendation comparing Rakuten vs Jalan / Booking.com", () => {
    const result = buildRakutenRenderedRoomDomResult({
      runId: "t",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room02xArtifact: { room_list_url: ROOM_LIST_URL },
      probeTargetUrl: ROOM_LIST_URL,
      rendered: renderedInput({ bodyHtml: HTML_TEXT_ONLY })
    });
    const report = renderRakutenRenderedRoomDomReport(result);
    expect(report).toContain("## Strategic Recommendation: Rakuten vs Jalan / Booking.com");
    expect(report).toContain("Jalan");
    expect(report).toContain("Booking.com");
  });

  it("26. decision is ready/basis_caution/not_ready", () => {
    const result = buildRakutenRenderedRoomDomResult({
      runId: "t",
      generatedAtJst: "2026-06-04T12:00:00+09:00",
      room02xArtifact: { room_list_url: ROOM_LIST_URL },
      probeTargetUrl: ROOM_LIST_URL,
      rendered: renderedInput({ bodyHtml: HTML_TEXT_ONLY })
    });
    expect([
      "rakuten_rendered_room_dom_probe_ready",
      "rakuten_rendered_room_dom_probe_basis_caution",
      "rakuten_rendered_room_dom_probe_not_ready"
    ]).toContain(result.decision);

    // Sold-out semantics guard never asserts property-level sold_out from one context.
    expect(result.sold_out_semantics_guard.property_level_sold_out).toBe(false);
    expect(result.sold_out_semantics_guard.usable_for_property_sold_out_pressure).toBe(false);

    // decideRakutenRenderedRoomDom / decideRakutenPriority are consistent.
    const signals = analyzeRenderedRoomDom(renderedInput({ bodyHtml: HTML_TEXT_ONLY }));
    const decision = decideRakutenRenderedRoomDom({ signals, candidates: result.room_identifier_candidates });
    expect(decision).toBe("rakuten_rendered_room_dom_probe_basis_caution");
    expect(
      decideRakutenPriority({ decision, signals, candidates: result.room_identifier_candidates, forbiddenMethodUsed: false })
    ).toBe("NO_GO_FREEZE_RAKUTEN");
  });
});

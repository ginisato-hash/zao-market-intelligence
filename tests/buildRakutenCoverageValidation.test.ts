import { describe, expect, it } from "vitest";
import {
  buildRakutenCoverageRows,
  classifyIdentityMatch,
  extractRakutenHotelNo,
  normalizeName,
  RAKUTEN_COVERAGE_HEADERS,
  renderRakutenCoverageCsv,
  type RakutenPageObservation
} from "../src/services/buildRakutenCoverageValidation";

const baseObservation = (overrides: Partial<RakutenPageObservation> = {}): RakutenPageObservation => ({
  hotelNo: "198027",
  reachable: true,
  pageTitle: "ＹｕｉＬｏｃａｌＺａｏ 宿泊予約【楽天トラベル】",
  pagePropertyName: "ＹｕｉＬｏｃａｌＺａｏ",
  addressExcerpt: "〒990-2301山形県山形市蔵王温泉字三度川219-1",
  ...overrides
});

describe("extractRakutenHotelNo", () => {
  it("extracts the hotelNo from a Rakuten HOTEL URL", () => {
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/198027/")).toBe("198027");
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/5097/")).toBe("5097");
  });

  it("rejects non-Rakuten URLs", () => {
    expect(extractRakutenHotelNo("https://www.jalan.net/yad328232/")).toBeNull();
    expect(extractRakutenHotelNo("https://www.booking.com/hotel/jp/yuilocalzao.ja.html")).toBeNull();
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/abc/")).toBeNull();
  });
});

describe("classifyIdentityMatch", () => {
  it("returns likely_match for a reachable Zao Onsen page whose name matches", () => {
    expect(classifyIdentityMatch("YuiLocalZao", baseObservation())).toBe("likely_match");
  });

  it("folds full-width Latin and middle dots when comparing names", () => {
    expect(normalizeName("ユニテ蔵王ジョーニダ・リゾート")).toBe(
      normalizeName("ユニテ蔵王ジョーニダリゾート")
    );
    expect(
      classifyIdentityMatch("ユニテ蔵王ジョーニダ・リゾート", baseObservation({
        pagePropertyName: "ユニテ蔵王ジョーニダリゾート",
        addressExcerpt: "〒990-2301山形県山形市蔵王温泉丈二田752-2"
      }))
    ).toBe("likely_match");
  });

  it("returns needs_review when a katakana variant differs from the canonical name", () => {
    expect(
      classifyIdentityMatch("ロッジスガノ", baseObservation({
        pagePropertyName: "蔵王温泉　暖炉の宿　ロッヂスガノ",
        addressExcerpt: "〒990-2301山形県山形市蔵王温泉878-25"
      }))
    ).toBe("needs_review");
  });

  it("returns wrong_property when the address is outside Zao Onsen", () => {
    expect(
      classifyIdentityMatch("三浦屋", baseObservation({
        pagePropertyName: "三浦屋",
        addressExcerpt: "〒669-6563兵庫県美方郡香美町香住区矢田945-1"
      }))
    ).toBe("wrong_property");
  });

  it("returns unreachable when the page did not resolve", () => {
    expect(
      classifyIdentityMatch("YuiLocalZao", baseObservation({ reachable: false }))
    ).toBe("unreachable");
  });
});

describe("buildRakutenCoverageRows", () => {
  it("never recommends an approved/confirmed decision and emits no price/upload columns", () => {
    const rows = buildRakutenCoverageRows(
      [
        {
          canonicalPropertyName: "YuiLocalZao",
          hotelNo: "198027",
          rakutenUrl: "https://travel.rakuten.co.jp/HOTEL/198027/"
        },
        {
          canonicalPropertyName: "Ghost Property",
          hotelNo: "999999",
          rakutenUrl: "https://travel.rakuten.co.jp/HOTEL/999999/"
        }
      ],
      [baseObservation()]
    );

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.recommended_review_decision).toBe("needs_change");
      expect(row.recommended_review_decision).not.toBe("approved");
      expect(row.recommended_review_decision).not.toBe("confirmed");
      expect(row.identity_match_status).not.toBe("confirmed");
      expect(row.identity_match_status).not.toBe("approved");
    }
    // Row without an observation falls back to unreachable, still needs_change.
    expect(rows[1]?.identity_match_status).toBe("unreachable");

    const header = renderRakutenCoverageCsv(rows).split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_COVERAGE_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price|beds24|airhost|upload|availability/iu);
  });
});

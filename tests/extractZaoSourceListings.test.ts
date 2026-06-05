import { describe, expect, it } from "vitest";
import {
  extractJalanYadId,
  extractRakutenHotelNo,
  extractJalanListingsFromHtmlOrText,
  extractRakutenListingsFromHtmlOrText
} from "../src/services/extractZaoSourceListings";

describe("extractJalanYadId", () => {
  it("reads the id from an openYadoSyosai call", () => {
    expect(extractJalanYadId("javascript:openYadoSyosai('327282', '56_1_1', '1')")).toBe("327282");
  });
  it("reads the id from a detail URL", () => {
    expect(extractJalanYadId("https://www.jalan.net/yad328232/")).toBe("328232");
  });
  it("reads a bare id", () => {
    expect(extractJalanYadId("302145")).toBe("302145");
  });
  it("returns null when no id is present", () => {
    expect(extractJalanYadId("no digits here")).toBeNull();
  });
});

describe("extractRakutenHotelNo", () => {
  it("reads the number from a HOTEL path", () => {
    expect(extractRakutenHotelNo("//travel.rakuten.co.jp/HOTEL/40033/40033.html")).toBe("40033");
  });
  it("reads the number from a hotelinfo plan path", () => {
    expect(extractRakutenHotelNo("//hotel.travel.rakuten.co.jp/hotelinfo/plan/196554?f_teikei=ONSEN")).toBe(
      "196554"
    );
  });
  it("returns null when no number is present", () => {
    expect(extractRakutenHotelNo("nothing")).toBeNull();
  });
});

describe("extractJalanListingsFromHtmlOrText", () => {
  const html = `
    <a href="javascript:openYadoSyosai('327282', '56_1_1', '1')" data-href="javascript:openYadoSyosai('327282', '56_1_1', '1')">
    <h2 class="p-searchResultItem__facilityName">蔵王温泉　吉田屋</h2>
    <a href="javascript:openYadoSyosai('328232', '56_1_2', '1')" data-href="javascript:openYadoSyosai('328232', '56_1_2', '1')">
    <h2 class="p-searchResultItem__facilityName">ル・ベール蔵王</h2>
  `;
  const listings = extractJalanListingsFromHtmlOrText(html, "https://jalan.example/");

  it("pairs ids with names and dedupes the href/data-href duplicate", () => {
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      source: "jalan",
      propertyNameRaw: "蔵王温泉 吉田屋",
      sourcePropertyId: "327282",
      propertyUrl: "https://www.jalan.net/yad327282/",
      extractionStatus: "extracted"
    });
    expect(listings[1]).toMatchObject({
      sourcePropertyId: "328232",
      propertyNameRaw: "ル・ベール蔵王",
      propertyUrl: "https://www.jalan.net/yad328232/"
    });
  });

  it("does not extract price text as a listing", () => {
    const pricedHtml = `
      <a href="javascript:openYadoSyosai('327282', '56_1_1', '1')">
      <h2 class="p-searchResultItem__facilityName">蔵王温泉　吉田屋</h2>
      <p>合計(税込) 12,000円</p>
    `;
    const pricedListings = extractJalanListingsFromHtmlOrText(pricedHtml, "https://jalan.example/");
    expect(pricedListings).toHaveLength(1);
    expect(JSON.stringify(pricedListings)).not.toContain("12,000");
    expect(JSON.stringify(pricedListings)).not.toContain("円");
  });
});

describe("extractRakutenListingsFromHtmlOrText", () => {
  const html = `
    <div class="hotelBox" id="hotel_1">
      <h3><span>蔵王温泉</span><a href="//travel.rakuten.co.jp/HOTEL/14585/14585.html">蔵王温泉　ＪＵＲＩＮ</a></h3>
    </div>
    <div class="hotelBox" id="hotel_2">
      <h3><span>蔵王温泉</span><a href="//travel.rakuten.co.jp/HOTEL/38534/38534.html">深山荘　高見屋</a></h3>
    </div>
  `;
  const listings = extractRakutenListingsFromHtmlOrText(html, "https://rakuten.example/");

  it("takes the anchor text (not the doubled onsen-area label) as the name", () => {
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      source: "rakuten",
      sourcePropertyId: "14585",
      propertyNameRaw: "蔵王温泉 ＪＵＲＩＮ",
      propertyUrl: "https://travel.rakuten.co.jp/HOTEL/14585/",
      extractionStatus: "extracted"
    });
    expect(listings[1]).toMatchObject({
      sourcePropertyId: "38534",
      propertyNameRaw: "深山荘 高見屋"
    });
  });
});

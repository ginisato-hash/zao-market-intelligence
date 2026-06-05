import { describe, expect, it } from "vitest";
import { buildRakutenPlanAttemptUrl } from "../src/collectors/rakutenPlanUrl";
import type { CollectorInput } from "../src/domain/types";

function makeInput(overrides: Partial<CollectorInput> = {}): CollectorInput {
  return {
    runId: "run_test",
    propertyId: "property_test",
    propertyName: "蔵王温泉 ル・ベール蔵王",
    ota: "rakuten",
    propertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
    stayDate: "2026-08-08",
    guests: 2,
    adults: 2,
    rooms: 1,
    nights: 1,
    ...overrides
  };
}

describe("buildRakutenPlanAttemptUrl", () => {
  it("builds /PLAN/ URL path from hotelNo", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput());

    expect(url).toContain("/HOTEL/29465/PLAN/");
  });

  it("includes correct checkin date param", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput());

    expect(url).toContain("f_checkin_date=2026%2F08%2F08");
  });

  it("includes correct checkout date for 1-night stay", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput());

    expect(url).toContain("f_checkout_date=2026%2F08%2F09");
  });

  it("includes correct checkout date for multi-night stay", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput({ nights: 3 }));

    expect(url).toContain("f_checkout_date=2026%2F08%2F11");
  });

  it("includes adult count", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput({ adults: 2 }));

    expect(url).toContain("f_adult_num=2");
  });

  it("includes room count", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput({ rooms: 1 }));

    expect(url).toContain("f_room_num=1");
  });

  it("includes nights (f_stay)", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput({ nights: 1 }));

    expect(url).toContain("f_stay=1");
  });

  it("starts with travel.rakuten.co.jp base", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput());

    expect(url).toMatch(/^https:\/\/travel\.rakuten\.co\.jp\//u);
  });

  it("throws on null propertyUrl", () => {
    expect(() =>
      buildRakutenPlanAttemptUrl(makeInput({ propertyUrl: null as unknown as string }))
    ).toThrow(/must match/i);
  });

  it("throws on non-Rakuten URL", () => {
    expect(() =>
      buildRakutenPlanAttemptUrl(makeInput({ propertyUrl: "https://www.jalan.net/yad328232/" }))
    ).toThrow(/must match/i);
  });

  it("throws on Rakuten URL missing hotelNo", () => {
    expect(() =>
      buildRakutenPlanAttemptUrl(makeInput({ propertyUrl: "https://travel.rakuten.co.jp/" }))
    ).toThrow();
  });

  it("extracts hotelNo correctly from URL with no trailing slash", () => {
    const url = buildRakutenPlanAttemptUrl(makeInput({
      propertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465"
    }));

    expect(url).toContain("/HOTEL/29465/PLAN/");
  });
});

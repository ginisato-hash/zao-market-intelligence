import { describe, expect, it } from "vitest";
import { buildRakutenAttemptUrl } from "../src/collectors/rakutenUrl";
import type { CollectorInput } from "../src/domain/types";

describe("Rakuten attempt URL", () => {
  it("builds checkin, checkout, adult, room, and stay params", () => {
    const url = new URL(buildRakutenAttemptUrl(input()));

    expect(url.pathname).toBe("/HOTEL/12345/");
    expect(url.searchParams.get("f_checkin_date")).toBe("2026/08/08");
    expect(url.searchParams.get("f_checkout_date")).toBe("2026/08/09");
    expect(url.searchParams.get("f_adult_num")).toBe("2");
    expect(url.searchParams.get("f_room_num")).toBe("1");
    expect(url.searchParams.get("f_stay")).toBe("1");
  });

  it("rejects non-Rakuten HOTEL URLs", () => {
    expect(() => buildRakutenAttemptUrl({ ...input(), propertyUrl: "https://example.com/HOTEL/12345/" })).toThrow();
  });
});

function input(): CollectorInput {
  return {
    runId: "run_test",
    propertyId: "property_test",
    propertyName: "Test",
    ota: "rakuten",
    stayDate: "2026-08-08",
    guests: 2,
    adults: 2,
    children: 0,
    rooms: 1,
    nights: 1,
    propertyUrl: "https://travel.rakuten.co.jp/HOTEL/12345/"
  };
}

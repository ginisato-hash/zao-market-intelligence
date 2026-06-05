import { describe, expect, it } from "vitest";
import {
  buildBookingProbeUrl,
  classifyBookingFreeDirectProbe,
  type BookingFreeDirectSignals
} from "../src/feasibility/bookingFreeDirectProbe";

function signals(overrides: Partial<BookingFreeDirectSignals> = {}): BookingFreeDirectSignals {
  const bodyText = overrides.bodyText ?? "a".repeat(2000);
  return {
    loaded: true,
    bodyText,
    bodyTextLength: overrides.bodyTextLength ?? bodyText.trim().length,
    finalUrl: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html",
    ...overrides
  };
}

describe("buildBookingProbeUrl", () => {
  it("includes the fixed date-scoped, JPY, Japanese parameters", () => {
    const url = buildBookingProbeUrl();
    expect(url).toContain("/hotel/jp/le-vert-zao.ja.html");
    expect(url).toContain("checkin=2026-08-08");
    expect(url).toContain("checkout=2026-08-09");
    expect(url).toContain("group_adults=2");
    expect(url).toContain("no_rooms=1");
    expect(url).toContain("selected_currency=JPY");
    expect(url).toContain("lang=ja");
  });
});

describe("classifyBookingFreeDirectProbe", () => {
  it("treats an empty / near-empty body as blocked (expected outcome)", () => {
    const result = classifyBookingFreeDirectProbe(signals({ bodyText: "", bodyTextLength: 0 }));
    expect(result.status).toBe("blocked");
    expect(result.accessStatus).toBe("empty_or_near_empty_body");
  });

  it("treats a non-loaded page as blocked", () => {
    expect(classifyBookingFreeDirectProbe(signals({ loaded: false })).status).toBe("blocked");
  });

  it("classifies captcha", () => {
    expect(classifyBookingFreeDirectProbe(signals({ bodyText: "Are you a robot? captcha" })).status).toBe("captcha");
  });

  it("classifies login_required", () => {
    const text = `please log in to continue ${"x".repeat(400)}`;
    expect(classifyBookingFreeDirectProbe(signals({ bodyText: text })).status).toBe("login_required");
  });

  it("classifies a visible content page without safe price as needs_review", () => {
    const result = classifyBookingFreeDirectProbe(signals({ bodyText: "ル・ベール蔵王 ".repeat(200) }));
    expect(result.status).toBe("needs_review");
    expect(result.accessStatus).toBe("content_visible_no_safe_price");
  });
});

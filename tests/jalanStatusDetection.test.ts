import { describe, expect, it } from "vitest";
import { detectJalanStatus } from "../src/collectors/jalanStatusDetection";

describe("detectJalanStatus", () => {
  it("detects sold out Japanese text", () => {
    expect(detectJalanStatus("この日は満室です").status).toBe("sold_out");
    expect(detectJalanStatus("空室なし").status).toBe("sold_out");
  });

  it("detects captcha or blocked access text", () => {
    const result = detectJalanStatus("captcha verification required");

    expect(result.status).toBe("failed");
    expect(result.errorReason).toContain("blocked");
  });

  it("detects not listed text", () => {
    expect(detectJalanStatus("該当なし プランなし").status).toBe("not_listed");
  });

  it("treats reservation-suspended and no-bookable-plan pages as sold_out, not failed", () => {
    expect(detectJalanStatus("この施設は現在予約受付を停止中です").status).toBe("sold_out");
    expect(detectJalanStatus("ご利用できるプランがありません").status).toBe("sold_out");
    expect(detectJalanStatus("ご利用できるプランがございません").status).toBe("sold_out");
    expect(detectJalanStatus("ご利用できるプランがない状態です").status).toBe("sold_out");
  });
});

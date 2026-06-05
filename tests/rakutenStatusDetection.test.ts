import { describe, expect, it } from "vitest";
import { detectRakutenStatus } from "../src/collectors/rakutenStatusDetection";

describe("Rakuten status detection", () => {
  it("detects sold_out text", () => {
    expect(detectRakutenStatus("この条件では満室です").status).toBe("sold_out");
    expect(detectRakutenStatus("空室なし").status).toBe("sold_out");
  });

  it("detects not_listed text", () => {
    expect(detectRakutenStatus("条件に合うプランはありません").status).toBe("not_listed");
    expect(detectRakutenStatus("該当なし").status).toBe("not_listed");
  });

  it("detects blocked text", () => {
    const detection = detectRakutenStatus("アクセスが集中しています CAPTCHA");

    expect(detection.status).toBe("failed");
    expect(detection.errorReason).toBe("rakuten_access_blocked_or_captcha");
  });

  it("detects hotel overview search-form page (no plan results loaded)", () => {
    const overviewText =
      "宿泊プラン\nチェックイン\nチェックアウト\n合計料金 ※1部屋あたりの税込金額\n検索";

    const detection = detectRakutenStatus(overviewText);

    expect(detection.status).toBe("failed");
    expect(detection.errorReason).toBe("rakuten_overview_page_no_plan_results");
  });

  it("overview pattern does not fire when sold_out text is also present", () => {
    const text = "満室\n合計料金 ※1部屋あたりの税込金額";

    expect(detectRakutenStatus(text).status).toBe("sold_out");
  });

  it("detects Rakuten 404 page by Japanese error text", () => {
    const text = "指定されたページが見つかりません\nエラー ： 404 Not Found";

    const detection = detectRakutenStatus(text);

    expect(detection.status).toBe("failed");
    expect(detection.errorReason).toBe("rakuten_plan_url_404_not_found");
  });

  it("detects Rakuten 404 page by English error text alone", () => {
    const detection = detectRakutenStatus("404 Not Found");

    expect(detection.status).toBe("failed");
    expect(detection.errorReason).toBe("rakuten_plan_url_404_not_found");
  });
});

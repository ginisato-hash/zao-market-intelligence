import { describe, expect, it, vi } from "vitest";
import {
  isRakutenSearchButtonText,
  isRakutenSearchFormText,
  isRakutenConditionsBlank,
  extractRakutenPageSignals,
  performRakutenSearchInteraction
} from "../src/collectors/rakutenSearchInteraction";
import type { RakutenSearchConditions } from "../src/collectors/rakutenSearchInteraction";

// ─── Pure helper tests ───────────────────────────────────────────────────────

describe("isRakutenSearchButtonText", () => {
  it("returns true for exactly '検索'", () => {
    expect(isRakutenSearchButtonText("検索")).toBe(true);
  });

  it("returns true for '検索' with leading/trailing whitespace", () => {
    expect(isRakutenSearchButtonText("  検索  ")).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(isRakutenSearchButtonText("予約する")).toBe(false);
  });

  it("returns false for partial match", () => {
    expect(isRakutenSearchButtonText("検索する")).toBe(false);
  });
});

describe("isRakutenSearchFormText", () => {
  it("returns true when overview price filter label is present", () => {
    const text = "チェックイン\n合計料金 ※1部屋あたりの税込金額\n大人2名";
    expect(isRakutenSearchFormText(text)).toBe(true);
  });

  it("returns true when the label has no space between 合計料金 and ※", () => {
    expect(isRakutenSearchFormText("合計料金※1部屋あたりの税込金額")).toBe(true);
  });

  it("returns false when the label is absent", () => {
    expect(isRakutenSearchFormText("24,000円 予約する 空室")).toBe(false);
  });

  it("returns false for 404 page text", () => {
    expect(isRakutenSearchFormText("404 Not Found 指定されたページが見つかりません")).toBe(false);
  });
});

describe("isRakutenConditionsBlank", () => {
  it("returns true when '日付指定なし' is present", () => {
    expect(isRakutenConditionsBlank("チェックイン 日付指定なし")).toBe(true);
  });

  it("returns false when dates appear to be set", () => {
    expect(isRakutenConditionsBlank("チェックイン 2026/08/08")).toBe(false);
  });
});

describe("extractRakutenPageSignals", () => {
  it("extracts '予約する' signal", () => {
    expect(extractRakutenPageSignals("今すぐ予約する")).toContain("予約する");
  });

  it("extracts '空室' signal", () => {
    expect(extractRakutenPageSignals("空室あり")).toContain("空室");
  });

  it("extracts '満室' signal", () => {
    expect(extractRakutenPageSignals("満室です")).toContain("満室");
  });

  it("extracts 'overview_form_visible' when the overview price label is present", () => {
    const text = "合計料金 ※1部屋あたりの税込金額";
    expect(extractRakutenPageSignals(text)).toContain("overview_form_visible");
  });

  it("extracts 'date_not_set' when '日付指定なし' is present", () => {
    expect(extractRakutenPageSignals("日付指定なし")).toContain("date_not_set");
  });

  it("extracts 'total_price_visible' for '2名合計'", () => {
    expect(extractRakutenPageSignals("2名合計 24,000円")).toContain("total_price_visible");
  });

  it("extracts 'total_price_visible' for '合計（税込）'", () => {
    expect(extractRakutenPageSignals("合計（税込）24,000円")).toContain("total_price_visible");
  });

  it("extracts 'no_plans_found' for 'プランなし'", () => {
    expect(extractRakutenPageSignals("プランなし")).toContain("no_plans_found");
  });

  it("returns empty array for unrelated text", () => {
    expect(extractRakutenPageSignals("こんにちは")).toHaveLength(0);
  });
});

// ─── performRakutenSearchInteraction (mocked Page) ───────────────────────────

const CONDITIONS: RakutenSearchConditions = {
  checkinDate: "2026/08/08",
  checkoutDate: "2026/08/09",
  adults: 2,
  rooms: 1
};

/** Canonical evaluate results matching the new checkAndSetConditions object format. */
const EVAL_ALREADY_SET = { checkinSet: true, checkoutSet: true, adultsSet: true, roomsSet: true, changedAny: false };
const EVAL_SET_OK      = { checkinSet: true, checkoutSet: true, adultsSet: true, roomsSet: true, changedAny: true };
const EVAL_NOT_FOUND   = { checkinSet: false, checkoutSet: false, adultsSet: false, roomsSet: false, changedAny: false };

function makeMockPage(overrides: {
  buttonCount?: number;
  evaluateResult?: typeof EVAL_ALREADY_SET | typeof EVAL_NOT_FOUND;
  afterUrl?: string;
  bodyText?: string;
} = {}): ReturnType<typeof buildMockPage> {
  return buildMockPage(overrides);
}

function buildMockPage(opts: {
  buttonCount?: number;
  evaluateResult?: object;
  afterUrl?: string;
  bodyText?: string;
}) {
  const buttonCount = opts.buttonCount ?? 1;
  const evaluateResult = opts.evaluateResult ?? EVAL_ALREADY_SET;
  const afterUrl = opts.afterUrl ?? "https://travel.rakuten.co.jp/HOTEL/29465/";
  const bodyText = opts.bodyText ?? "空室 予約する 24,000円";

  const mockButton = {
    count: vi.fn().mockResolvedValue(buttonCount),
    click: vi.fn().mockResolvedValue(undefined)
  };

  const mockLocator = vi.fn().mockImplementation((selector: string) => {
    if (selector === 'button:has-text("検索")') {
      return { first: () => mockButton };
    }
    // body locator for innerText
    return { innerText: vi.fn().mockResolvedValue(bodyText) };
  });

  return {
    url: vi.fn().mockReturnValue("https://travel.rakuten.co.jp/HOTEL/29465/"),
    locator: mockLocator,
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    _mockButton: mockButton
  };
}

describe("performRakutenSearchInteraction", () => {
  it("returns not_attempted with errorReason when search button is not found", async () => {
    const page = makeMockPage({ buttonCount: 0 });

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("rakuten_search_button_not_found");
  });

  it("returns not_attempted with errorReason when conditions inputs not found in DOM", async () => {
    const page = makeMockPage({ buttonCount: 1, evaluateResult: EVAL_NOT_FOUND });

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("rakuten_search_conditions_not_set");
  });

  it("includes searchConditions with checkinSet:false when date inputs not found", async () => {
    const page = makeMockPage({ buttonCount: 1, evaluateResult: EVAL_NOT_FOUND });

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.searchConditions).toBeDefined();
    expect(result.searchConditions?.checkinSet).toBe(false);
    expect(result.searchConditions?.checkoutSet).toBe(false);
    expect(result.searchConditions?.reason).toBe("date_inputs_not_found");
  });

  it("returns success with strategy 'click_visible_search_button' when conditions already set (changedAny=false)", async () => {
    const page = makeMockPage({ buttonCount: 1, evaluateResult: EVAL_ALREADY_SET });

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("click_visible_search_button");
    expect(result.errorReason).toBeUndefined();
    expect(page._mockButton.click).toHaveBeenCalledOnce();
  });

  it("returns success with strategy 'fill_conditions_then_click_search' when conditions are changed (changedAny=true)", async () => {
    const page = makeMockPage({ buttonCount: 1, evaluateResult: EVAL_SET_OK });

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("fill_conditions_then_click_search");
    expect(page._mockButton.click).toHaveBeenCalledOnce();
  });

  it("includes searchConditions with all fields set on success", async () => {
    const page = makeMockPage({ buttonCount: 1, evaluateResult: EVAL_ALREADY_SET });

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.searchConditions).toBeDefined();
    expect(result.searchConditions?.checkinSet).toBe(true);
    expect(result.searchConditions?.checkoutSet).toBe(true);
    expect(result.searchConditions?.adultsSet).toBe(true);
    expect(result.searchConditions?.roomsSet).toBe(true);
    expect(result.searchConditions?.reason).toBeUndefined();
  });

  it("includes visibleSignals in successful result", async () => {
    const page = makeMockPage({
      buttonCount: 1,
      evaluateResult: EVAL_ALREADY_SET,
      bodyText: "空室 予約する"
    });

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.success).toBe(true);
    expect(result.visibleSignals).toContain("空室");
    expect(result.visibleSignals).toContain("予約する");
  });

  it("includes afterUrl in successful result", async () => {
    const afterUrl = "https://travel.rakuten.co.jp/HOTEL/29465/?f_checkin_date=2026%2F08%2F08";
    const page = makeMockPage({ buttonCount: 1, evaluateResult: EVAL_ALREADY_SET });
    (page.url as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("https://travel.rakuten.co.jp/HOTEL/29465/") // beforeUrl
      .mockReturnValueOnce(afterUrl); // afterUrl

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.success).toBe(true);
    expect(result.afterUrl).toBe(afterUrl);
  });

  it("returns failed with errorReason on unexpected exception", async () => {
    const page = makeMockPage({ buttonCount: 1, evaluateResult: EVAL_ALREADY_SET });
    page._mockButton.click = vi.fn().mockRejectedValue(new Error("element detached"));

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.errorReason).toMatch(/rakuten_search_interaction_failed/);
    expect(result.errorReason).toMatch(/element detached/);
  });

  it("does not click search if only adults can be set but dates cannot", async () => {
    const partialResult = { checkinSet: false, checkoutSet: false, adultsSet: true, roomsSet: true, changedAny: true };
    const page = makeMockPage({ buttonCount: 1, evaluateResult: partialResult });

    const result = await performRakutenSearchInteraction(page as never, CONDITIONS, 5_000);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("rakuten_search_conditions_not_set");
    expect(page._mockButton.click).not.toHaveBeenCalled();
  });
});

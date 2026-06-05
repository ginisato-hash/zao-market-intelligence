import { describe, expect, it } from "vitest";
import {
  chooseJalanNavigationCandidate,
  inspectJalanCandidate,
  isSafeJalanPlanNavigationTarget
} from "../src/collectors/jalanLinkInspector";

describe("Jalan link inspector", () => {
  const currentUrl = "https://www.jalan.net/yad328232/";

  it("denies help, login, review, coupon, photo, map, and access URLs", () => {
    const denied = [
      "/jalan/doc/howto/03yoyaku.html",
      "/login/",
      "/help/",
      "/kuchikomi/YAD_328232.html",
      "/coupon/",
      "/photo/",
      "/map/",
      "/access/"
    ];

    for (const href of denied) {
      const candidate = inspectJalanCandidate({ tagName: "a", text: "予約 ヘルプ", href }, currentUrl);
      expect(candidate.pathDisallowed).toBe(true);
      expect(candidate.pathAllowed).toBe(false);
    }
  });

  it("allows clearly plan, reserve, or search-related same-origin Jalan URLs", () => {
    expect(isSafeJalanPlanNavigationTarget("宿泊プランを見る", "/yad328232/plan/", currentUrl)).toBe(true);
    expect(isSafeJalanPlanNavigationTarget("空室検索・予約", "/yad328232/plan/?stayYear=2026", currentUrl)).toBe(true);
    expect(isSafeJalanPlanNavigationTarget("予約する", "https://www.jalan.net/yad328232/plan/", currentUrl)).toBe(true);
  });

  it("lets deny rules win over allow-looking text", () => {
    expect(isSafeJalanPlanNavigationTarget("予約方法・宿泊プラン", "/jalan/doc/howto/03yoyaku.html", currentUrl)).toBe(false);
  });

  it("does not choose the help URL when a safe plan URL exists", () => {
    const candidates = [
      inspectJalanCandidate({ index: 0, tagName: "a", text: "予約方法", href: "/jalan/doc/howto/03yoyaku.html" }, currentUrl),
      inspectJalanCandidate({ index: 1, tagName: "a", text: "宿泊プランを見る", href: "/yad328232/plan/" }, currentUrl)
    ];

    const { chosen, diagnostics } = chooseJalanNavigationCandidate(candidates);

    expect(chosen?.href).toBe("/yad328232/plan/");
    expect(diagnostics.rejectedDisallowedExamples[0]?.href).toBe("/jalan/doc/howto/03yoyaku.html");
  });

  it("allows a selector-specific search button only with lodging search context", () => {
    const safeButton = inspectJalanCandidate(
      {
        tagName: "button",
        text: "再検索",
        href: null,
        type: "submit",
        nearbyText: "チェックイン 2026年8月8日 部屋数 1 大人 2"
      },
      currentUrl
    );
    const vagueButton = inspectJalanCandidate({ tagName: "button", text: "再検索", href: null, type: "submit" }, currentUrl);

    expect(safeButton.pathAllowed).toBe(true);
    expect(vagueButton.pathAllowed).toBe(false);
  });
});

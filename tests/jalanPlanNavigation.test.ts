import { describe, expect, it } from "vitest";
import { chooseJalanNavigationCandidate, inspectJalanCandidate } from "../src/collectors/jalanLinkInspector";
import { isSafeJalanPlanNavigationTarget } from "../src/collectors/jalanPlanNavigation";

describe("Jalan plan navigation target filtering", () => {
  const currentUrl = "https://www.jalan.net/yad328232/";

  it("rejects arbitrary links", () => {
    expect(isSafeJalanPlanNavigationTarget("観光ガイド", "/kankou/", currentUrl)).toBe(false);
    expect(isSafeJalanPlanNavigationTarget("ログイン", "/login/", currentUrl)).toBe(false);
    expect(isSafeJalanPlanNavigationTarget("予約方法", "/jalan/doc/howto/03yoyaku.html", currentUrl)).toBe(false);
    expect(isSafeJalanPlanNavigationTarget("予約", "https://example.com/reserve", currentUrl)).toBe(false);
  });

  it("accepts clearly related plan or reservation text on same host", () => {
    expect(isSafeJalanPlanNavigationTarget("宿泊プランを見る", "/yad328232/plan/", currentUrl)).toBe(true);
    expect(isSafeJalanPlanNavigationTarget("空室検索・予約", "/yad328232/plan/", currentUrl)).toBe(true);
    expect(isSafeJalanPlanNavigationTarget("このプランを予約", null, currentUrl)).toBe(false);
  });

  it("returns not attempted diagnostics when no safe candidate exists", () => {
    const { chosen, diagnostics } = chooseJalanNavigationCandidate([
      inspectJalanCandidate({ tagName: "a", text: "予約方法", href: "/jalan/doc/howto/03yoyaku.html" }, currentUrl),
      inspectJalanCandidate({ tagName: "a", text: "クチコミ", href: "/kuchikomi/YAD_328232.html" }, currentUrl)
    ]);

    expect(chosen).toBeNull();
    expect(diagnostics.finalNavigationDecision).toBe("not_attempted");
    expect(diagnostics.rejectedDisallowedExamples.length).toBeGreaterThan(0);
  });
});

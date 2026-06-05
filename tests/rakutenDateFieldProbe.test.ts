import { describe, expect, it } from "vitest";
import {
  classifyRakutenDateFieldProbe,
  rakutenDateReflectedInUrl,
  type RakutenDateFieldSignals
} from "../src/feasibility/rakutenDateFieldProbe";

function signals(overrides: Partial<RakutenDateFieldSignals> = {}): RakutenDateFieldSignals {
  return {
    loaded: true,
    bodyText: "宿泊プラン一覧",
    finalUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
    expectedFieldsPresent: true,
    dateReflectedInUrl: false,
    ...overrides
  };
}

describe("rakutenDateReflectedInUrl", () => {
  it("returns true when a recognized date param is present and non-empty", () => {
    expect(rakutenDateReflectedInUrl("https://travel.rakuten.co.jp/HOTEL/29465/?f_nen1=2026&f_tuki1=8&f_hi1=8")).toBe(true);
    expect(rakutenDateReflectedInUrl("https://x/?f_checkin_date=2026-08-08")).toBe(true);
  });

  it("returns false when no date param or empty values", () => {
    expect(rakutenDateReflectedInUrl("https://travel.rakuten.co.jp/HOTEL/29465/")).toBe(false);
    expect(rakutenDateReflectedInUrl("https://x/?f_nen1=")).toBe(false);
  });

  it("returns false for an unparseable URL", () => {
    expect(rakutenDateReflectedInUrl("not a url")).toBe(false);
  });
});

describe("classifyRakutenDateFieldProbe", () => {
  it("classifies captcha", () => {
    expect(classifyRakutenDateFieldProbe(signals({ bodyText: "私はロボットではありません reCAPTCHA" })).status).toBe(
      "captcha"
    );
  });

  it("classifies blocked", () => {
    expect(classifyRakutenDateFieldProbe(signals({ bodyText: "アクセスが集中しています" })).status).toBe("blocked");
  });

  it("classifies login_required", () => {
    expect(classifyRakutenDateFieldProbe(signals({ bodyText: "ログインしてください" })).status).toBe("login_required");
  });

  it("classifies not_found", () => {
    expect(classifyRakutenDateFieldProbe(signals({ bodyText: "指定されたページが見つかりません" })).status).toBe(
      "not_found"
    );
  });

  it("flags missing form fields as needs_review", () => {
    const result = classifyRakutenDateFieldProbe(signals({ expectedFieldsPresent: false }));
    expect(result.status).toBe("needs_review");
    expect(result.accessStatus).toBe("expected_fields_missing");
  });

  it("classifies a reflected date write as needs_review/date_write_reflected", () => {
    const result = classifyRakutenDateFieldProbe(signals({ dateReflectedInUrl: true }));
    expect(result.status).toBe("needs_review");
    expect(result.accessStatus).toBe("date_write_reflected");
  });

  it("classifies an unreflected date write as needs_review/date_write_not_reflected", () => {
    const result = classifyRakutenDateFieldProbe(signals({ dateReflectedInUrl: false }));
    expect(result.status).toBe("needs_review");
    expect(result.accessStatus).toBe("date_write_not_reflected");
  });

  it("treats a page that did not load as inconclusive needs_review", () => {
    const result = classifyRakutenDateFieldProbe(signals({ loaded: false }));
    expect(result.status).toBe("needs_review");
    expect(result.accessStatus).toBe("page_not_loaded");
  });
});

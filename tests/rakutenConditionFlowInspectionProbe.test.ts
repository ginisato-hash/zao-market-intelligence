import { describe, expect, it } from "vitest";
import {
  classifyButtonSafety,
  classifyConditionFlowStep,
  compareFlowBasis,
  decideConditionFlow,
  extractDateSignals,
  extractNightSignals,
  extractPeopleSignals,
  extractRoomSignals,
  extractYenPriceCandidates,
  RAKUTEN_CONDITION_FLOW_CSV_HEADERS,
  renderConditionFlowCsv,
  renderConditionFlowReport,
  type ButtonSummary,
  type ConditionFlowRow,
  type ConditionFlowStep
} from "../src/services/rakutenConditionFlowInspectionProbe";
import type { HplanDay } from "../src/services/rakutenCorrectedHplanUrlProbe";

const day = (overrides: Partial<HplanDay> = {}): HplanDay => ({
  viewDay: "3",
  epoch: Date.UTC(2026, 5, 3),
  stock: 2,
  price: 32395,
  priceWithoutTax: 29450,
  discountedPrice: 0,
  link: "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723&track=secret",
  vacantCondition: "2室",
  monthClass: "thisMonth",
  isPast: false,
  isFull: false,
  isVacant: true,
  enabled: true,
  ...overrides
});

const button = (text: string, safety: ButtonSummary["safety"] = "ambiguous"): ButtonSummary => ({
  index: 0,
  text,
  type: "submit",
  name: "",
  value: "",
  safety,
  reason: "test"
});

const row = (overrides: Partial<ConditionFlowRow> = {}): ConditionFlowRow => ({
  stepIndex: 0,
  stepName: "condition_entry",
  urlSanitized: "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723",
  title: "蔵王温泉 蔵王国際ホテル",
  dateDetected: true,
  peopleDetected: true,
  roomDetected: true,
  nightDetected: true,
  priceCandidateCount: 1,
  taxDetected: true,
  safeTransitionCandidateCount: 0,
  unsafeTransitionCount: 0,
  classification: "condition_flow_price_basis_confirmed",
  decision: "rakuten_price_basis_confirmed",
  debugArtifactPath: ".data/debug/rakuten-condition-flow-inspection/x",
  ...overrides
});

const step = (overrides: Partial<ConditionFlowStep> = {}): ConditionFlowStep => ({
  stepIndex: 0,
  stepName: "condition_entry",
  urlSanitized: row().urlSanitized,
  title: row().title,
  httpStatusOrNavigationStatus: "loaded",
  visibleDateSignals: ["2026年06月03日(水)"],
  visiblePeopleSignals: ["大人2名"],
  visibleRoomSignals: ["1室"],
  visibleNightSignals: ["1泊"],
  visiblePriceCandidates: extractYenPriceCandidates("合計（税込）64,790円"),
  visibleTaxSignals: ["税込"],
  visibleAvailabilitySignals: ["空室"],
  formsSummary: [],
  inputsSummary: [],
  buttonsSummary: [],
  linksSummary: [],
  networkRequestsSummary: [],
  screenshotPath: "/tmp/step_0.png",
  htmlPath: "/tmp/step_0.html",
  visibleTextPath: "/tmp/step_0.txt",
  classification: "condition_flow_price_basis_confirmed",
  ...overrides
});

describe("button safety", () => {
  it("detects unsafe buttons", () => {
    for (const text of ["予約を確定", "予約する", "決済", "ログイン", "個人情報"]) {
      expect(classifyButtonSafety(text).safety).toBe("unsafe");
    }
  });

  it("detects potentially safe buttons", () => {
    for (const text of ["検索", "空室検索", "条件を設定", "料金を確認"]) {
      expect(classifyButtonSafety(text).safety).toBe("potentially_safe");
    }
  });

  it("falls back to ambiguous for unknown buttons and unsafe for reservation context", () => {
    expect(classifyButtonSafety("進む").safety).toBe("ambiguous");
    expect(classifyButtonSafety("次へ", "予約申し込み画面へ進みます").safety).toBe("unsafe");
  });
});

describe("signal extraction", () => {
  const text = "蔵王国際ホテル 2026年06月03日(水) 大人2名 2名利用 1室 1泊 合計（税込）64,790円";

  it("extracts yen prices from Japanese text", () => {
    expect(extractYenPriceCandidates(text).map((p) => p.numericValue)).toContain(64790);
  });

  it("extracts date / people / room / night signals", () => {
    expect(extractDateSignals(text)).toContain("2026年06月03日(水)");
    expect(extractPeopleSignals(text).join(" ")).toMatch(/大人2|2名/);
    expect(extractRoomSignals(text)).toContain("1室");
    expect(extractNightSignals(text)).toContain("1泊");
  });
});

describe("basis comparison and classification", () => {
  it("detects exact 64790 total match", () => {
    const prices = extractYenPriceCandidates("2026年06月03日 大人2名 1室 1泊 合計（税込）64,790円");
    const comparison = compareFlowBasis({
      day: day(),
      text: "2026年06月03日 大人2名 1室 1泊 合計（税込）64,790円",
      adultCount: 2,
      priceCandidates: prices
    });
    expect(comparison.anyVisiblePriceEqualsPriceTimesAdults).toBe(true);
    expect(
      classifyConditionFlowStep({
        priceCandidates: prices,
        comparison,
        buttons: [],
        networkRequests: [],
        transitionAttempted: false,
        renderedBlocked: false
      })
    ).toBe("condition_flow_price_basis_confirmed");
  });

  it("detects per-person 32395 only as ambiguous visible price", () => {
    const prices = extractYenPriceCandidates("2026年06月03日 大人2名 1室 1泊 お一人様（税込）32,395円");
    const comparison = compareFlowBasis({
      day: day(),
      text: "2026年06月03日 大人2名 1室 1泊 お一人様（税込）32,395円",
      adultCount: 2,
      priceCandidates: prices
    });
    expect(comparison.anyVisiblePriceEqualsDayListPrice).toBe(true);
    expect(
      classifyConditionFlowStep({
        priceCandidates: prices,
        comparison,
        buttons: [],
        networkRequests: [],
        transitionAttempted: false,
        renderedBlocked: false
      })
    ).toBe("condition_flow_price_visible_basis_ambiguous");
  });

  it("returns condition input only when no price exists", () => {
    const comparison = compareFlowBasis({
      day: day(),
      text: "2026年06月03日 チェックイン日を変更する チェックアウト、ご利用部屋数、人数をご入力ください",
      adultCount: 2,
      priceCandidates: []
    });
    expect(
      classifyConditionFlowStep({
        priceCandidates: [],
        comparison,
        buttons: [],
        networkRequests: [],
        transitionAttempted: false,
        renderedBlocked: false
      })
    ).toBe("condition_flow_condition_input_only");
  });

  it("decision function follows rules", () => {
    expect(decideConditionFlow(["condition_flow_price_basis_confirmed"])).toBe("rakuten_price_basis_confirmed");
    expect(decideConditionFlow(["condition_flow_price_visible_basis_ambiguous"])).toBe(
      "rakuten_price_basis_needs_manual_review"
    );
    expect(decideConditionFlow(["condition_flow_condition_input_only"])).toBe(
      "rakuten_price_basis_requires_different_public_endpoint"
    );
    expect(decideConditionFlow(["condition_flow_render_blocked"])).toBe("rakuten_price_basis_not_ready");
  });
});

describe("renderers", () => {
  it("report renderer sanitizes URLs and documents safety", () => {
    const report = renderConditionFlowReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      csvPath: "/tmp/out.csv",
      debugRootPath: "/tmp/debug",
      rows: [row({ urlSanitized: "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723" })],
      steps: [step()],
      comparison: compareFlowBasis({
        day: day(),
        text: "2026年06月03日 大人2名 1室 1泊 合計（税込）64,790円",
        adultCount: 2,
        priceCandidates: extractYenPriceCandidates("合計（税込）64,790円")
      }),
      decision: "rakuten_price_basis_confirmed"
    });
    expect(report).not.toContain("track=secret");
    expect(report).toContain("Unsafe or ambiguous");
  });

  it("CSV renderer excludes Beds24/AirHost/PMS upload columns", () => {
    const header = RAKUTEN_CONDITION_FLOW_CSV_HEADERS.join(",");
    expect(header).not.toMatch(/Beds24|AirHost|PMS|roomid|inventory|price1|price2|price3|price4|upload/iu);
    expect(renderConditionFlowCsv([row()])).toContain("rakuten_price_basis_confirmed");
  });

  it("classifies unsafe transition required when only unsafe button exists", () => {
    const comparison = compareFlowBasis({ day: day(), text: "2026年06月03日", adultCount: 2, priceCandidates: [] });
    expect(
      classifyConditionFlowStep({
        priceCandidates: [],
        comparison,
        buttons: [button("予約する", "unsafe")],
        networkRequests: [],
        transitionAttempted: false,
        renderedBlocked: false
      })
    ).toBe("condition_flow_unsafe_transition_required");
  });
});

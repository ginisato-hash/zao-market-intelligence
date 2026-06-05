import { describe, expect, it } from "vitest";
import { analyzeRakutenExtractionEvidence } from "../src/collectors/rakutenEvidence";

const overviewAttemptUrl =
  "https://travel.rakuten.co.jp/HOTEL/12345/?f_checkin_date=2026%2F08%2F08&f_checkout_date=2026%2F08%2F09&f_adult_num=2&f_room_num=1&f_stay=1";
const planAttemptUrl =
  "https://travel.rakuten.co.jp/HOTEL/12345/PLAN/?f_checkin_date=2026%2F08%2F08&f_checkout_date=2026%2F08%2F09&f_adult_num=2&f_room_num=1&f_stay=1";

// Keep original name as alias for existing tests
const attemptUrl = overviewAttemptUrl;

describe("Rakuten extraction evidence", () => {
  it("rejects per-person-only text", () => {
    const evidence = analyzeRakutenExtractionEvidence({
      stayDate: "2026-08-08",
      attemptUrl,
      text: "空室あり 大人1名 12,000円 お一人様"
    });

    expect(evidence.priceFound).toBe(false);
    expect(evidence.priceBasis).toBe("per_person_tax_included");
  });

  it("accepts explicit total-tax-included text", () => {
    const evidence = analyzeRakutenExtractionEvidence({
      stayDate: "2026-08-08",
      attemptUrl,
      text: "2026年8月8日 空室あり 2名合計 24,000円 合計(税込)"
    });

    expect(evidence.priceFound).toBe(true);
    expect(evidence.priceValue).toBe(24000);
    expect(evidence.priceBasis).toBe("total_tax_included");
  });

  it("rejects when date scope is missing", () => {
    const evidence = analyzeRakutenExtractionEvidence({
      stayDate: "2026-08-08",
      text: "空室あり 2名合計 24,000円 合計(税込)"
    });

    expect(evidence.priceFound).toBe(false);
    expect(evidence.rejectionReason).toBe("selected_date_not_found");
  });

  it("returns rakuten_overview_page_no_plan_results when overview URL hits search-form page", () => {
    const overviewText =
      "宿泊プラン\nチェックイン\nチェックアウト\n合計料金 ※1部屋あたりの税込金額\n検索";

    const evidence = analyzeRakutenExtractionEvidence({
      stayDate: "2026-08-08",
      attemptUrl: overviewAttemptUrl,
      text: overviewText
    });

    expect(evidence.selectedDateEvidenceFound).toBe(true);
    expect(evidence.availabilityMarkerFound).toBe(false);
    expect(evidence.priceFound).toBe(false);
    expect(evidence.rejectionReason).toBe("rakuten_overview_page_no_plan_results");
  });

  it("returns rakuten_plan_results_not_reached when /PLAN/ URL still shows search-form page", () => {
    const overviewText =
      "宿泊プラン\nチェックイン\nチェックアウト\n合計料金 ※1部屋あたりの税込金額\n検索";

    const evidence = analyzeRakutenExtractionEvidence({
      stayDate: "2026-08-08",
      attemptUrl: planAttemptUrl,
      text: overviewText
    });

    expect(evidence.selectedDateEvidenceFound).toBe(true);
    expect(evidence.availabilityMarkerFound).toBe(false);
    expect(evidence.priceFound).toBe(false);
    expect(evidence.rejectionReason).toBe("rakuten_plan_results_not_reached");
  });

  it("proceeds to price extraction when /PLAN/ URL returns plan listing text", () => {
    const planText = "2026年8月8日 空室あり プラン名：標準プラン 2名合計 36,000円 合計(税込) 予約する";

    const evidence = analyzeRakutenExtractionEvidence({
      stayDate: "2026-08-08",
      attemptUrl: planAttemptUrl,
      text: planText
    });

    expect(evidence.selectedDateEvidenceFound).toBe(true);
    expect(evidence.availabilityMarkerFound).toBe(true);
    expect(evidence.priceFound).toBe(true);
    expect(evidence.priceValue).toBe(36000);
    expect(evidence.priceBasis).toBe("total_tax_included");
  });
});

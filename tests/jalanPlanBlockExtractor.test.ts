import { describe, expect, it } from "vitest";
import {
  buildPlanBlockDebugSummary,
  extractJalanPlanBlocks,
  planBlockToEvidence
} from "../src/collectors/jalanPlanBlockExtractor";

const planUrl =
  "https://www.jalan.net/yad328232/plan/?stayYear=2026&stayMonth=08&stayDay=08&stayCount=1&roomCrack=200000";

describe("Jalan plan-block extractor", () => {
  it("accepts a block containing plan or room evidence, total tax-included basis, and yen price", () => {
    const result = extractJalanPlanBlocks({
      blockTexts: [
        "四季折々のレジャー満喫♪ 地産地消の選べる夕食＆温泉を楽しむ 部屋タイプ・詳細 ◇ツイン◇禁煙 合計(税込) 1泊大人2名 37,000円 空室わずか"
      ],
      pageUrl: planUrl,
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });

    expect(result.acceptedCandidate?.priceValue).toBe(37000);
    expect(result.acceptedCandidate?.priceBasis).toBe("total_tax_included");
    expect(result.acceptedCandidate?.confidence).toBe("high");
  });

  it("uses the total column price when per-person and total prices are both visible", () => {
    const result = extractJalanPlanBlocks({
      blockTexts: [
        "四季折々のレジャー満喫♪ 部屋タイプ・詳細 ◆ツイン◆禁煙 大人1名(税込) 合計(税込) 1泊 大人2名 18,500円 37,000円 空室わずか"
      ],
      pageUrl: planUrl,
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });

    expect(result.acceptedCandidate?.priceText).toBe("37,000円");
    expect(result.acceptedCandidate?.priceValue).toBe(37000);
  });

  it("rejects a yen block without plan or room evidence", () => {
    const result = extractJalanPlanBlocks({
      blockTexts: ["広告バナー 合計(税込) 1泊大人2名 37,000円 ポイントキャンペーン"],
      pageUrl: planUrl,
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });

    expect(result.acceptedCandidate).toBeUndefined();
    expect(result.rejectionReasons.plan_or_room_context_not_found).toBe(1);
  });

  it("rejects a yen block without total or tax-included evidence", () => {
    const result = extractJalanPlanBlocks({
      blockTexts: ["宿泊プラン 部屋タイプ・詳細 ◇ツイン◇禁煙 37,000円 空室わずか"],
      pageUrl: planUrl,
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });

    expect(result.acceptedCandidate).toBeUndefined();
    expect(result.rejectionReasons.total_tax_included_basis_not_found).toBe(1);
  });

  it("rejects per-person-only price when total is unclear", () => {
    const result = extractJalanPlanBlocks({
      blockTexts: ["宿泊プラン 部屋タイプ・詳細 ◇ツイン◇禁煙 大人1名(税込) 18,500円 空室わずか"],
      pageUrl: planUrl,
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });

    expect(result.acceptedCandidate).toBeUndefined();
    expect(result.rejectionReasons.per_person_price_without_total).toBe(1);
  });

  it("accepts only when selected stay condition params are present", () => {
    const result = extractJalanPlanBlocks({
      blockTexts: ["宿泊プラン 部屋タイプ・詳細 ◇ツイン◇禁煙 合計(税込) 1泊大人2名 37,000円 空室わずか"],
      pageUrl: "https://www.jalan.net/yad328232/plan/",
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });

    expect(result.acceptedCandidate).toBeUndefined();
    expect(result.rejectionReasons.stay_condition_not_found).toBe(1);
  });

  it("returns rejection reason counts and debug summary", () => {
    const result = extractJalanPlanBlocks({
      blockTexts: [
        "広告バナー 合計(税込) 1泊大人2名 37,000円",
        "宿泊プラン 部屋タイプ・詳細 ◇ツイン◇禁煙 合計(税込) 1泊大人2名 37,000円 空室わずか"
      ],
      pageUrl: planUrl,
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });
    const summary = buildPlanBlockDebugSummary(result);

    expect(summary.candidateCount).toBe(2);
    expect(summary.rejectionReasons.plan_or_room_context_not_found).toBe(1);
    expect(summary.topCandidates[1]?.priceValue).toBe(37000);
  });

  it("converts an accepted candidate into collector evidence", () => {
    const result = extractJalanPlanBlocks({
      blockTexts: ["宿泊プラン 部屋タイプ・詳細 ◇ツイン◇禁煙 合計(税込) 1泊大人2名 37,000円 空室わずか"],
      pageUrl: planUrl,
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });
    const evidence = planBlockToEvidence(result, "2026-08-08");

    expect(evidence?.priceValue).toBe(37000);
    expect(evidence?.priceBasis).toBe("total_tax_included");
    expect(evidence?.selectedDateTextFound).toBe(true);
  });
});

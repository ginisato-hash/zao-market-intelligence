import { describe, expect, it } from "vitest";
import type { JalanExtractionEvidence } from "../src/collectors/jalanEvidence";
import { decideJalanCollectorResult } from "../src/collectors/jalanCollectorDecision";
import { selectAcceptedJalanPriceCandidate } from "../src/collectors/jalanAcceptedPricePolicy";
import { extractJalanPlanBlocks, planBlockCandidateToEvidence, planBlockToEvidence } from "../src/collectors/jalanPlanBlockExtractor";

const scopedEvidence: JalanExtractionEvidence = {
  stayDate: "2026-08-08",
  selectedDateTextFound: true,
  availabilityMarkerFound: true,
  availabilityMarkerText: "○",
  priceFound: true,
  priceValue: 29260,
  priceText: "合計 税込29,260円",
  priceBasis: "total_tax_included",
  surroundingText: "2026年8月8日 宿泊プラン 客室 合計 税込29,260円",
  confidence: "high"
};

describe("Jalan navigation decision", () => {
  it("rejects price if navigation loses selected date", () => {
    const decision = decideJalanCollectorResult(
      { ...scopedEvidence, selectedDateTextFound: false },
      { status: "failed" }
    );

    expect(decision.status).toBe("failed");
    expect(decision.priceJpy).toBeNull();
  });

  it("accepts price only when date, availability, room or plan context, and total basis are scoped", () => {
    const decision = decideJalanCollectorResult(scopedEvidence, { status: "failed" });

    expect(decision.status).toBe("available");
    expect(decision.priceJpy).toBe(29260);
  });

  it("uses an accepted plan-block candidate as available price evidence", () => {
    const extraction = extractJalanPlanBlocks({
      blockTexts: ["宿泊プラン 部屋タイプ・詳細 ◇ツイン◇禁煙 合計(税込) 1泊大人2名 37,000円 空室わずか"],
      pageUrl: "https://www.jalan.net/yad328232/plan/?stayYear=2026&stayMonth=08&stayDay=08&stayCount=1&roomCrack=200000",
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });
    const evidence = planBlockToEvidence(extraction, "2026-08-08");

    expect(evidence).not.toBeNull();
    const decision = decideJalanCollectorResult(evidence as JalanExtractionEvidence, { status: "failed" });
    expect(decision.status).toBe("available");
    expect(decision.priceJpy).toBe(37000);
  });

  it("persists the selected cheapest safe plan candidate, not arbitrary first candidate", () => {
    const extraction = extractJalanPlanBlocks({
      blockTexts: [
        "夕食付きプラン 部屋タイプ・詳細 ◆ツイン◆禁煙 大人1名(税込) 合計(税込) 1泊 大人2名 18,500円 37,000円 空室わずか",
        "素泊まりプラン 部屋タイプ・詳細 ◇和室7.5畳◆禁煙 大人1名(税込) 合計(税込) 1泊 大人2名 12,500円 25,000円 あと2部屋"
      ],
      pageUrl: "https://www.jalan.net/yad328232/plan/?stayYear=2026&stayMonth=08&stayDay=08&stayCount=1&roomCrack=200000",
      stayDate: "2026-08-08",
      adults: 2,
      rooms: 1,
      nights: 1
    });
    const selection = selectAcceptedJalanPriceCandidate(extraction.candidates, "cheapest_total_tax_included_safe_plan");
    const evidence = selection.selectedCandidate === undefined ? null : planBlockCandidateToEvidence(selection.selectedCandidate, "2026-08-08");
    expect(evidence).not.toBeNull();

    const decision = decideJalanCollectorResult(evidence as JalanExtractionEvidence, { status: "failed" });
    expect(decision.status).toBe("available");
    expect(decision.priceJpy).toBe(25000);
  });
});

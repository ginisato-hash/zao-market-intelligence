import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeJalanExtractionEvidence,
  analyzeJalanPlanPageExtractionEvidence,
  buildJalanRawTextExcerpt
} from "../src/collectors/jalanEvidence";
import { writeJalanDebugArtifact } from "../src/collectors/jalanDebugArtifact";

describe("Jalan extraction evidence", () => {
  it("rejects arbitrary unrelated yen values", () => {
    const evidence = analyzeJalanExtractionEvidence(
      "2026年8月\n8\n○\n\nおすすめ記事 合計 税込12,000円",
      "2026-08-08"
    );

    expect(evidence.priceFound).toBe(false);
    expect(evidence.rejectionReason).toBe("price_basis_or_date_scope_unclear");
  });

  it("accepts clearly scoped total tax-included price", () => {
    const evidence = analyzeJalanExtractionEvidence(
      "2026年8月\n8\n○\n\n2026年8月8日 チェックイン 宿泊プラン 客室 合計 税込12,000円",
      "2026-08-08"
    );

    expect(evidence.selectedDateTextFound).toBe(true);
    expect(evidence.availabilityMarkerFound).toBe(true);
    expect(evidence.priceFound).toBe(true);
    expect(evidence.priceValue).toBe(12000);
    expect(evidence.priceBasis).toBe("total_tax_included");
    expect(evidence.confidence).toBe("high");
  });

  it("rejects price when selected date is not found", () => {
    const evidence = analyzeJalanExtractionEvidence("宿泊プラン 合計 税込12,000円", "2026-08-08");

    expect(evidence.selectedDateTextFound).toBe(false);
    expect(evidence.priceFound).toBe(false);
    expect(evidence.rejectionReason).toBe("selected_date_not_found");
  });

  it("accepts plan page total price when selected date is encoded in the URL", () => {
    const evidence = analyzeJalanPlanPageExtractionEvidence(
      [
        "ル・ベール蔵王の料金・宿泊プラン",
        "四季折々のレジャー満喫♪ 地産地消の選べる夕食＆温泉を楽しむ",
        "部屋タイプ・詳細",
        "合計(税込)",
        "1泊大人2名",
        "37,000円",
        "空室わずか"
      ].join("\n"),
      "2026-08-08",
      "https://www.jalan.net/yad328232/plan/?stayYear=2026&stayMonth=08&stayDay=08&stayCount=1&roomCrack=200000"
    );

    expect(evidence.selectedDateTextFound).toBe(true);
    expect(evidence.availabilityMarkerFound).toBe(true);
    expect(evidence.priceFound).toBe(true);
    expect(evidence.priceValue).toBe(37000);
    expect(evidence.priceBasis).toBe("total_tax_included");
    expect(evidence.confidence).toBe("medium");
  });

  it("does not use URL date evidence outside Jalan plan pages", () => {
    const evidence = analyzeJalanPlanPageExtractionEvidence(
      "宿泊プラン 合計(税込) 1泊大人2名 37,000円 空室わずか",
      "2026-08-08",
      "https://www.jalan.net/jalan/doc/howto/03yoyaku.html?stayYear=2026&stayMonth=08&stayDay=08"
    );

    expect(evidence.priceFound).toBe(false);
    expect(evidence.rejectionReason).toBe("selected_date_not_found");
  });

  it("builds raw text excerpt for accepted and rejected evidence", () => {
    const accepted = analyzeJalanExtractionEvidence(
      "2026年8月\n8\n○\n\n2026年8月8日 チェックイン 宿泊プラン 客室 合計 税込12,000円",
      "2026-08-08"
    );
    const rejected = analyzeJalanExtractionEvidence("宿泊プラン 合計 税込12,000円", "2026-08-08");

    expect(buildJalanRawTextExcerpt(accepted)).toContain("税込12,000円");
    expect(buildJalanRawTextExcerpt(rejected, "price_basis_or_date_scope_unclear")).toContain(
      "price_basis_or_date_scope_unclear"
    );
  });

  it("writes debug artifact JSON", async () => {
    const evidence = analyzeJalanExtractionEvidence(
      "2026年8月\n8\n○\n\n2026年8月8日 チェックイン 宿泊プラン 客室 合計 税込12,000円",
      "2026-08-08"
    );
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "jalan-debug-"));
    process.chdir(tmp);
    try {
      const path = await writeJalanDebugArtifact({
        runId: "run_test",
        propertyName: "Test",
        propertyUrl: "https://example.com",
        stayDate: "2026-08-08",
        status: "available",
        priceJpy: 12000,
        evidence,
        errorReason: null,
        screenshotPath: ".data/screenshots/test.png",
        selectedExcerpts: ["excerpt"],
        navigation: {
          attempted: false,
          strategy: "not_attempted",
          success: false,
          beforeUrl: "https://www.jalan.net/yad328232/",
          candidateDiagnostics: {
            candidateCount: 2,
            rejectedCandidateCount: 1,
            rejectedDisallowedExamples: [{ text: "予約方法", href: "/jalan/doc/howto/03yoyaku.html", reason: "disallowed_url_or_text" }],
            finalNavigationDecision: "not_attempted"
          }
        },
        planBlockExtraction: {
          candidateCount: 1,
          rejectedCount: 0,
          rejectionReasons: {},
          topCandidates: [
            {
              planName: "宿泊プラン",
              roomName: "◇ツイン◇禁煙",
              priceText: "37,000円",
              priceValue: 37000,
              priceBasis: "total_tax_included",
              confidence: "high",
              hasTotalTaxIncludedEvidence: true,
              hasStayConditionEvidence: true,
              hasPlanOrRoomEvidence: true,
              blockTextExcerpt: "宿泊プラン ◇ツイン◇禁煙 合計(税込) 1泊大人2名 37,000円"
            }
          ]
        },
        acceptedPricePolicy: {
          policy: "cheapest_total_tax_included_safe_plan",
          safeCandidateCount: 1,
          rejectedCandidateCount: 0,
          selectedIndex: 0,
          selectedPrice: 37000,
          selectedPriceText: "37,000円",
          selectedPlanName: "宿泊プラン",
          selectedRoomName: "◇ツイン◇禁煙",
          reason: "selected_lowest_total_tax_included_safe_plan"
        }
      });

      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        property_name?: string;
        propertyName?: string;
        evidence: unknown;
        navigation?: { candidateDiagnostics?: { candidateCount?: number; rejectedDisallowedExamples?: unknown[] } };
        planBlockExtraction?: { candidateCount?: number; topCandidates?: Array<{ priceValue?: number }> };
        acceptedPricePolicy?: { policy?: string; selectedPrice?: number };
      };
      expect(parsed.propertyName).toBe("Test");
      expect(parsed.evidence).toBeTruthy();
      expect(parsed.navigation?.candidateDiagnostics?.candidateCount).toBe(2);
      expect(parsed.navigation?.candidateDiagnostics?.rejectedDisallowedExamples?.length).toBe(1);
      expect(parsed.planBlockExtraction?.candidateCount).toBe(1);
      expect(parsed.planBlockExtraction?.topCandidates?.[0]?.priceValue).toBe(37000);
      expect(parsed.acceptedPricePolicy?.policy).toBe("cheapest_total_tax_included_safe_plan");
      expect(parsed.acceptedPricePolicy?.selectedPrice).toBe(37000);
    } finally {
      process.chdir(cwd);
    }
  });

  it("writes debug artifact with custom file name", async () => {
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "jalan-debug-"));
    process.chdir(tmp);
    try {
      const path = await writeJalanDebugArtifact({
        runId: "run_test",
        debugFileName: "property_123_2026-08-08",
        propertyName: "Test",
        propertyUrl: "https://example.com",
        stayDate: "2026-08-08",
        status: "failed",
        priceJpy: null,
        evidence: analyzeJalanExtractionEvidence("", "2026-08-08"),
        selectedExcerpts: []
      });

      expect(path).toBe(".data/debug/jalan/run_test/property_123_2026-08-08.json");
    } finally {
      process.chdir(cwd);
    }
  });
});

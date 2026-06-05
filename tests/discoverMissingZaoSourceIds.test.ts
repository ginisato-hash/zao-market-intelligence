import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runMissingZaoSourceDiscovery } from "../src/scripts/discoverMissingZaoSourceIds";
import {
  parseZaoCandidateReviewCsv,
  renderZaoCandidateReviewCsv,
  type ZaoSourceCandidateReviewRecord
} from "../src/services/enrichZaoMissingSourceCandidates";

function candidateRow(propertyName: string, source: string): ZaoSourceCandidateReviewRecord {
  return {
    canonical_property_name: propertyName,
    source,
    candidate_property_url: "",
    candidate_source_property_id: "",
    verification_status: "candidate",
    evidence_note: "No identifier invented.",
    current_reviewer_note: "",
    human_review_required: "true",
    review_decision: "pending",
    reviewed_property_url: "",
    reviewed_source_property_id: "",
    reviewer_note: ""
  };
}

describe("discoverMissingZaoSourceIds script runner", () => {
  it("writes enriched CSV and report without mutating non-review candidate fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "zao-discovery-"));
    try {
      const inputPath = join(dir, "input.csv");
      const outputPath = join(dir, "enriched.csv");
      const reportPath = join(dir, "report.md");
      const inputRows = [
        candidateRow("YuiLocalZao", "booking"),
        candidateRow("三浦屋", "rakuten")
      ];
      writeFileSync(inputPath, renderZaoCandidateReviewCsv(inputRows), "utf-8");

      const result = runMissingZaoSourceDiscovery({
        inputCsvPath: inputPath,
        enrichedCsvPath: outputPath,
        reportPath,
        maxRows: 2,
        sourceFilter: ["booking", "rakuten"],
        generatedAt: "2026-05-31T00:00:00.000Z"
      });

      const rows = parseZaoCandidateReviewCsv(readFileSync(outputPath, "utf-8"));
      expect(result.inputRowCount).toBe(2);
      expect(result.outputRowCount).toBe(2);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.review_decision).toBe("needs_change");
      expect(rows[0]?.reviewed_source_property_id).toBe("yuilocalzao");
      expect(rows[1]?.review_decision).toBe("pending");
      expect(rows[0]?.verification_status).toBe("candidate");
      expect(readFileSync(reportPath, "utf-8")).toContain("No row is approved or confirmed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves Gemini QA warnings for risky slugs and never approves/confirms any row", () => {
    const dir = mkdtempSync(join(tmpdir(), "zao-discovery-warn-"));
    try {
      const inputPath = join(dir, "input.csv");
      const outputPath = join(dir, "enriched.csv");
      const reportPath = join(dir, "report.md");
      const inputRows = [
        candidateRow("深山荘 高見屋", "booking"),
        candidateRow("ZAO BASE", "booking"),
        candidateRow("ユニテ蔵王ジョーニダ・リゾート", "rakuten"),
        candidateRow("名湯舎 創", "booking")
      ];
      writeFileSync(inputPath, renderZaoCandidateReviewCsv(inputRows), "utf-8");

      runMissingZaoSourceDiscovery({
        inputCsvPath: inputPath,
        enrichedCsvPath: outputPath,
        reportPath,
        maxRows: 50,
        sourceFilter: ["booking", "rakuten", "google_hotels", "jalan"],
        generatedAt: "2026-06-01T00:00:00.000Z"
      });

      const rows = parseZaoCandidateReviewCsv(readFileSync(outputPath, "utf-8"));
      const byName = (name: string): ZaoSourceCandidateReviewRecord | undefined =>
        rows.find((r) => r.canonical_property_name === name);

      const shinzanso = byName("深山荘 高見屋");
      expect(shinzanso?.reviewed_property_url).toBe(
        "https://www.booking.com/hotel/jp/shinzanso-takamiya.ja.html"
      );
      expect(shinzanso?.reviewer_note).toContain("Gemini QA warning:");
      expect(shinzanso?.reviewer_note).toContain("shinzanso-takamiya");

      const zaoBase = byName("ZAO BASE");
      expect(zaoBase?.reviewed_property_url).toBe(
        "https://www.booking.com/hotel/jp/zao-base-sukichang-karatu-bu-1fen.ja.html"
      );
      expect(zaoBase?.reviewer_note).toContain("Gemini QA warning:");

      const unite = byName("ユニテ蔵王ジョーニダ・リゾート");
      expect(unite?.reviewed_source_property_id).toBe("187977");
      expect(unite?.reviewed_property_url).toBe("https://travel.rakuten.co.jp/HOTEL/187977/");

      const meitoya = byName("名湯舎 創");
      expect(meitoya?.reviewed_source_property_id).toBe("meitoya-sou");

      for (const r of rows) {
        expect(["pending", "needs_change"]).toContain(r.review_decision);
        expect(r.review_decision).not.toBe("approved");
        expect(r.verification_status).not.toBe("confirmed");
        expect(r.verification_status).not.toBe("system_confirmed");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the real 144-row universe intact and never overwrites the original CSV", () => {
    const originalPath = resolve(
      ".data/exports/zao-universe-review/zao_source_candidates_20260531_231933.csv"
    );
    if (!existsSync(originalPath)) return; // skip when the immutable input is unavailable

    const originalBefore = readFileSync(originalPath, "utf-8");
    const dir = mkdtempSync(join(tmpdir(), "zao-discovery-universe-"));
    try {
      const outputPath = join(dir, "enriched.csv");
      const reportPath = join(dir, "report.md");

      const result = runMissingZaoSourceDiscovery({
        inputCsvPath: originalPath,
        enrichedCsvPath: outputPath,
        reportPath,
        maxRows: 50,
        sourceFilter: ["rakuten", "booking", "google_hotels", "jalan"],
        generatedAt: "2026-06-01T00:00:00.000Z"
      });

      expect(result.inputRowCount).toBe(144);
      expect(result.outputRowCount).toBe(144);
      expect(readFileSync(originalPath, "utf-8")).toBe(originalBefore);

      const rows = parseZaoCandidateReviewCsv(readFileSync(outputPath, "utf-8"));
      expect(rows).toHaveLength(144);

      for (const r of rows) {
        expect(["pending", "needs_change"]).toContain(r.review_decision);
        expect(r.verification_status).not.toBe("confirmed");
        expect(r.verification_status).not.toBe("system_confirmed");
        if (r.review_decision === "needs_change") {
          expect(r.reviewer_note).toContain(
            "Human must verify exact property identity before approval"
          );
          if (r.source === "rakuten") {
            expect(r.reviewed_property_url).toMatch(
              /^https:\/\/travel\.rakuten\.co\.jp\/HOTEL\/\d+\/$/u
            );
          }
          if (r.source === "booking") {
            expect(r.reviewed_property_url).toMatch(
              /^https:\/\/www\.booking\.com\/hotel\/jp\/[^/.]+\.ja\.html$/u
            );
          }
          if (r.source === "jalan") {
            expect(r.reviewed_property_url).toMatch(/^https:\/\/www\.jalan\.net\/yad\d+\/$/u);
          }
          if (r.source === "google_hotels") {
            expect(r.reviewed_property_url).toMatch(
              /^https:\/\/www\.google\.com\/travel\/hotels\/entity\/[^/]+$/u
            );
          }
        }
      }

      const header = readFileSync(outputPath, "utf-8").split("\n")[0] ?? "";
      expect(header).not.toMatch(/roomid|inventory|multiplier|price|beds24|airhost|upload/iu);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

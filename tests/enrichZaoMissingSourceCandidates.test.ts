import { describe, expect, it } from "vitest";
import {
  AI_DISCOVERY_NOTE_PREFIX,
  enrichZaoMissingSourceCandidates,
  extractBookingSlug,
  extractGoogleHotelsToken,
  extractJalanYadId,
  extractRakutenHotelNo,
  parseZaoCandidateReviewCsv,
  renderZaoCandidateReviewCsv,
  ZAO_CANDIDATE_REVIEW_HEADERS,
  type ZaoSourceCandidateReviewRecord
} from "../src/services/enrichZaoMissingSourceCandidates";

function row(
  propertyName: string,
  source: ZaoSourceCandidateReviewRecord["source"],
  overrides: Partial<ZaoSourceCandidateReviewRecord> = {}
): ZaoSourceCandidateReviewRecord {
  return {
    canonical_property_name: propertyName,
    source,
    candidate_property_url: "",
    candidate_source_property_id: "",
    verification_status: "candidate",
    evidence_note: `No ${source} candidate discovered.`,
    current_reviewer_note: "",
    human_review_required: "true",
    review_decision: "pending",
    reviewed_property_url: "",
    reviewed_source_property_id: "",
    reviewer_note: "",
    ...overrides
  };
}

describe("enrichZaoMissingSourceCandidates", () => {
  it("extracts first-party source IDs from accepted URL patterns", () => {
    expect(extractJalanYadId("https://www.jalan.net/yad328232/")).toBe("328232");
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/198027/")).toBe("198027");
    expect(extractBookingSlug("https://www.booking.com/hotel/jp/yuilocalzao.ja.html")).toBe(
      "yuilocalzao"
    );
    expect(
      extractGoogleHotelsToken("https://www.google.com/travel/hotels/entity/CgoIn_eG0v78uPpiEAE")
    ).toBe("CgoIn_eG0v78uPpiEAE");
  });

  it("preserves row count and only changes review fields for AI-filled candidates", () => {
    const rows = [
      row("YuiLocalZao", "booking"),
      row("三浦屋", "rakuten"),
      row("蔵王国際ホテル", "jalan", {
        candidate_property_url: "https://www.jalan.net/yad123456/",
        candidate_source_property_id: "123456",
        verification_status: "needs_review"
      })
    ];

    const result = enrichZaoMissingSourceCandidates(
      rows,
      [
        {
          canonicalPropertyName: "YuiLocalZao",
          source: "booking",
          propertyUrl: "https://www.booking.com/hotel/jp/yuilocalzao.html",
          evidenceNote: "Targeted public search found first-party Booking.com URL."
        }
      ],
      {
        maxRows: 10,
        sourceFilter: ["jalan", "rakuten", "booking", "google_hotels"],
        priorityOrder: [{ canonicalPropertyName: "YuiLocalZao", source: "booking" }]
      }
    );

    expect(result.inputRowCount).toBe(3);
    expect(result.outputRowCount).toBe(3);
    expect(result.filledCount).toBe(1);
    expect(result.rows[0]?.review_decision).toBe("needs_change");
    expect(result.rows[0]?.reviewed_property_url).toBe(
      "https://www.booking.com/hotel/jp/yuilocalzao.ja.html"
    );
    expect(result.rows[0]?.reviewed_source_property_id).toBe("yuilocalzao");
    expect(result.rows[0]?.reviewer_note).toContain(AI_DISCOVERY_NOTE_PREFIX);
    expect(result.rows[1]?.review_decision).toBe("pending");
    expect(result.rows[2]?.review_decision).toBe("pending");

    for (const header of ZAO_CANDIDATE_REVIEW_HEADERS) {
      if (
        header === "review_decision" ||
        header === "reviewed_property_url" ||
        header === "reviewed_source_property_id" ||
        header === "reviewer_note"
      ) {
        continue;
      }
      expect(result.rows[0]?.[header]).toBe(rows[0]?.[header]);
    }
  });

  it("embeds a Gemini QA warning in the reviewer note without approving the row", () => {
    const result = enrichZaoMissingSourceCandidates(
      [row("ZAO BASE", "booking")],
      [
        {
          canonicalPropertyName: "ZAO BASE",
          source: "booking",
          propertyUrl: "https://www.booking.com/hotel/jp/zao-base-sukichang-karatu-bu-1fen.ja.html",
          evidenceNote: "Found public first-party Booking URL pattern matching the target property.",
          warningNote: "Booking slug is non-standard; must be human verified."
        }
      ],
      { maxRows: 1, sourceFilter: ["booking"], priorityOrder: [] }
    );

    expect(result.rows[0]?.review_decision).toBe("needs_change");
    expect(result.rows[0]?.reviewer_note).toContain(AI_DISCOVERY_NOTE_PREFIX);
    expect(result.rows[0]?.reviewer_note).toContain("Gemini QA warning:");
    expect(result.rows[0]?.reviewer_note).toContain("non-standard");
    expect(result.rows[0]?.review_decision).not.toBe("approved");
  });

  it("never introduces approved decisions or confirmed verification statuses", () => {
    const result = enrichZaoMissingSourceCandidates(
      [row("ZAO BASE", "rakuten")],
      [
        {
          canonicalPropertyName: "ZAO BASE",
          source: "rakuten",
          propertyUrl: "https://travel.rakuten.co.jp/HOTEL/197787/",
          evidenceNote: "Targeted public search found first-party Rakuten URL."
        }
      ],
      {
        maxRows: 1,
        sourceFilter: ["rakuten"],
        priorityOrder: []
      }
    );

    expect(result.rows[0]?.review_decision).toBe("needs_change");
    expect(result.rows[0]?.verification_status).toBe("candidate");
    expect(result.rows[0]?.review_decision).not.toBe("approved");
  });

  it("warns when the same discovered source ID is assigned to multiple properties", () => {
    const result = enrichZaoMissingSourceCandidates(
      [row("A", "rakuten"), row("B", "rakuten")],
      [
        {
          canonicalPropertyName: "A",
          source: "rakuten",
          propertyUrl: "https://travel.rakuten.co.jp/HOTEL/111/",
          evidenceNote: "Candidate A."
        },
        {
          canonicalPropertyName: "B",
          source: "rakuten",
          propertyUrl: "https://travel.rakuten.co.jp/HOTEL/111/",
          evidenceNote: "Candidate B."
        }
      ],
      {
        maxRows: 2,
        sourceFilter: ["rakuten"],
        priorityOrder: []
      }
    );

    expect(result.duplicateWarnings).toHaveLength(1);
    expect(result.duplicateWarnings[0]?.message).toContain("different properties");
  });

  it("round-trips CSV without adding price or upload columns", () => {
    const csv = renderZaoCandidateReviewCsv([row("YuiLocalZao", "booking")]);
    const header = csv.split("\n")[0] ?? "";

    expect(header).toBe(ZAO_CANDIDATE_REVIEW_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price|availability/iu);
    expect(parseZaoCandidateReviewCsv(csv)).toHaveLength(1);
  });
});

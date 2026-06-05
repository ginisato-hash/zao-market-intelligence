import { describe, expect, it } from "vitest";
import { sourceCoverageCandidateRecordSchema } from "../src/seeds/sourceCoverageCandidateSchema";

const baseCandidate = {
  property_name: "ホテル喜らく",
  source: "rakuten",
  candidate_property_url: null,
  candidate_source_property_id: null,
  candidate_label: "Rakuten Travel hotel page to be manually verified",
  evidence_note: "Jalan coverage confirmed (yad325153); Rakuten hotel number not yet verified.",
  verification_status: "candidate" as const
};

describe("sourceCoverageCandidateRecordSchema", () => {
  it("accepts a valid candidate row with null IDs", () => {
    expect(sourceCoverageCandidateRecordSchema.safeParse(baseCandidate).success).toBe(true);
  });

  it("accepts a candidate with a URL when provided", () => {
    const withUrl = {
      ...baseCandidate,
      candidate_property_url: "https://travel.rakuten.co.jp/HOTEL/12345/",
      candidate_source_property_id: "12345"
    };
    expect(sourceCoverageCandidateRecordSchema.safeParse(withUrl).success).toBe(true);
  });

  it("accepts needs_review and confirmed verification statuses", () => {
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, verification_status: "needs_review" }).success
    ).toBe(true);
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, verification_status: "confirmed" }).success
    ).toBe(true);
  });

  it("rejects the forbidden paid source serpapi", () => {
    const result = sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, source: "serpapi" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("forbidden paid source");
  });

  it("rejects the forbidden paid source dataforseo", () => {
    expect(sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, source: "dataforseo" }).success).toBe(
      false
    );
  });

  it("rejects drift source names that are not canonical", () => {
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, source: "rakuten_travel" }).success
    ).toBe(false);
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, source: "booking_com" }).success
    ).toBe(false);
  });

  it("accepts 'other' as an escape-hatch source (evidence_note required, which it already is)", () => {
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, source: "other" }).success
    ).toBe(true);
  });

  it("rejects a blank property_name", () => {
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, property_name: "   " }).success
    ).toBe(false);
  });

  it("rejects a blank source", () => {
    expect(sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, source: "  " }).success).toBe(false);
  });

  it("rejects a blank evidence_note", () => {
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, evidence_note: "" }).success
    ).toBe(false);
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({ ...baseCandidate, evidence_note: "   " }).success
    ).toBe(false);
  });

  it("rejects a malformed candidate_property_url when provided", () => {
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({
        ...baseCandidate,
        candidate_property_url: "not a url"
      }).success
    ).toBe(false);
  });

  it("rejects an unknown verification_status", () => {
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({
        ...baseCandidate,
        verification_status: "unknown_status"
      }).success
    ).toBe(false);
  });
});

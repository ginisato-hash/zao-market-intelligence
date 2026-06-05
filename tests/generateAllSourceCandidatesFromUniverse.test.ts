import { describe, expect, it } from "vitest";
import { generateAllSourceCandidatesFromUniverse } from "../src/scripts/generateAllSourceCandidatesFromUniverse";

describe("generateAllSourceCandidatesFromUniverse", () => {
  it("creates one row per canonical property across the four source universe", () => {
    const rows = generateAllSourceCandidatesFromUniverse([
      {
        canonical_property_name: "深山荘 高見屋",
        aliases: [],
        sources_present: ["jalan"],
        jalan: {
          property_url: "https://www.jalan.net/yad321744/",
          source_property_id: "321744"
        },
        rakuten: null,
        canonicalization_status: "canonical",
        evidence_note: "test universe row"
      }
    ]);

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.source).sort()).toEqual([
      "booking",
      "google_hotels",
      "jalan",
      "rakuten"
    ]);
    expect(rows.every((r) => r.verification_status !== "confirmed")).toBe(true);

    const jalan = rows.find((r) => r.source === "jalan");
    expect(jalan).toMatchObject({
      verification_status: "needs_review",
      candidate_property_url: "https://www.jalan.net/yad321744/",
      candidate_source_property_id: "321744"
    });

    const booking = rows.find((r) => r.source === "booking");
    expect(booking).toMatchObject({
      verification_status: "candidate",
      candidate_property_url: null,
      candidate_source_property_id: null
    });
  });

  it("adds canonicalization caution to found rows when the universe row needs review", () => {
    const rows = generateAllSourceCandidatesFromUniverse([
      {
        canonical_property_name: "推定統合ホテル",
        aliases: ["推定 ホテル"],
        sources_present: ["rakuten"],
        jalan: null,
        rakuten: {
          property_url: "https://travel.rakuten.co.jp/HOTEL/12345/",
          source_property_id: "12345"
        },
        canonicalization_status: "needs_review",
        evidence_note: "inferred merge"
      }
    ]);

    expect(rows.find((r) => r.source === "rakuten")?.evidence_note).toContain(
      "canonicalization_status=needs_review"
    );
  });

  it("generates null source candidates for local-only properties", () => {
    const rows = generateAllSourceCandidatesFromUniverse([
      {
        canonical_property_name: "シバママのお宿",
        aliases: [],
        sources_present: ["local_known"],
        jalan: null,
        rakuten: null,
        local: {
          property_name: "シバママのお宿",
          source: "local_known",
          canonicalization_status: "needs_review",
          evidence_note: "Known local lodging candidate."
        },
        canonicalization_status: "needs_review",
        evidence_note: "local only"
      }
    ]);

    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.verification_status === "candidate")).toBe(true);
    expect(rows.every((row) => row.candidate_property_url === null)).toBe(true);
    expect(rows.every((row) => row.candidate_source_property_id === null)).toBe(true);
  });
});

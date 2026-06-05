import { describe, expect, it } from "vitest";
import { buildZaoUniverseReviewPacket } from "../src/services/buildZaoUniverseReviewPacket";

describe("inspectZaoUniverseReviewPacket data", () => {
  it("exposes expected counts for inspection output", () => {
    const packet = buildZaoUniverseReviewPacket(
      {
        universeFile: {
          universe: [
            {
              canonical_property_name: "深山荘 高見屋",
              aliases: ["深山荘 高見屋 −MIYAMASO TAKAMIYA−"],
              sources_present: ["jalan", "rakuten"],
              jalan: {
                property_url: "https://www.jalan.net/yad321744/",
                source_property_id: "321744"
              },
              rakuten: null,
              local: null,
              canonicalization_status: "canonical",
              evidence_note: "fixture"
            }
          ],
          excluded_audit: [],
          anchor_checks: []
        },
        candidates: [
          {
            property_name: "深山荘 高見屋",
            source: "jalan",
            candidate_property_url: "https://www.jalan.net/yad321744/",
            candidate_source_property_id: "321744",
            evidence_note: "fixture",
            verification_status: "needs_review",
            reviewer_note: null
          },
          {
            property_name: "深山荘 高見屋",
            source: "booking",
            candidate_property_url: null,
            candidate_source_property_id: null,
            evidence_note: "fixture",
            verification_status: "candidate",
            reviewer_note: null
          }
        ],
        localExtensions: []
      },
      "2026-05-31T00:00:00.000Z"
    );

    expect(packet.summary).toMatchObject({
      canonicalPropertyCount: 1,
      candidateRowCount: 2,
      aliasMapCount: 1,
      excludedAuditCount: 0,
      candidateFoundBySource: { jalan: 1 },
      candidateMissingBySource: { booking: 1 }
    });
  });
});

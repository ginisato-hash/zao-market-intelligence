import { describe, expect, it } from "vitest";
import {
  CANDIDATE_CSV_HEADERS,
  PROPERTY_CSV_HEADERS,
  buildZaoUniverseReviewPacket,
  renderZaoPropertiesCsv,
  renderZaoSourceCandidatesCsv
} from "../src/services/buildZaoUniverseReviewPacket";

const forbiddenUploadFields = [
  "roomid",
  "inventory",
  "multiplier",
  "price1",
  "price2",
  "price3",
  "price4",
  "rate",
  "price",
  "availability"
];

function fixturePacket() {
  return buildZaoUniverseReviewPacket(
    {
      universeFile: {
        universe: [
          {
            canonical_property_name: "最上高湯 善七乃湯",
            aliases: ["善七乃湯・oohira HOTEL", "蔵王温泉 大平ホテル", "oohira HOTEL"],
            sources_present: ["jalan", "rakuten"],
            jalan: {
              property_url: "https://www.jalan.net/yad316011/",
              source_property_id: "316011"
            },
            rakuten: {
              property_url: "https://travel.rakuten.co.jp/HOTEL/8084/",
              source_property_id: "8084"
            },
            local: null,
            canonicalization_status: "canonical",
            evidence_note: "Merged aliases for review."
          }
        ],
        excluded_audit: [
          {
            source: "jalan",
            propertyNameRaw: "山形駅前ホテル",
            propertyUrl: "https://www.jalan.net/yad361630/",
            sourcePropertyId: "361630",
            exclusionReason: "station_area_noise",
            evidenceNote: "Outside Zao Onsen."
          }
        ],
        anchor_checks: []
      },
      candidates: [
        {
          property_name: "最上高湯 善七乃湯",
          source: "jalan",
          candidate_property_url: "https://www.jalan.net/yad316011/",
          candidate_source_property_id: "316011",
          evidence_note: "Human review required.",
          verification_status: "needs_review",
          reviewer_note: null
        },
        {
          property_name: "最上高湯 善七乃湯",
          source: "booking",
          candidate_property_url: null,
          candidate_source_property_id: null,
          evidence_note: "No identifier invented.",
          verification_status: "candidate",
          reviewer_note: null
        }
      ],
      localExtensions: []
    },
    "2026-05-31T00:00:00.000Z"
  );
}

describe("buildZaoUniverseReviewPacket", () => {
  it("assembles property, candidate, alias, and excluded audit rows", () => {
    const packet = fixturePacket();
    expect(packet.propertyRows).toHaveLength(1);
    expect(packet.candidateRows).toHaveLength(2);
    expect(packet.excludedAuditRows).toHaveLength(1);
    expect(packet.aliasMap["最上高湯 善七乃湯"]).toEqual([
      "善七乃湯・oohira HOTEL",
      "蔵王温泉 大平ホテル",
      "oohira HOTEL"
    ]);
    expect(packet.candidateRows.every((row) => row.humanReviewRequired)).toBe(true);
  });

  it("defaults review decisions to pending and reviewer output fields to blank", () => {
    const packet = fixturePacket();
    expect(packet.propertyRows[0]).toMatchObject({
      reviewDecision: "pending",
      reviewerNote: ""
    });
    expect(packet.candidateRows[0]).toMatchObject({
      reviewDecision: "pending",
      reviewedPropertyUrl: "",
      reviewedSourcePropertyId: "",
      reviewerNoteOut: ""
    });
  });

  it("CSV headers contain no price or upload fields", () => {
    const headers = [...PROPERTY_CSV_HEADERS, ...CANDIDATE_CSV_HEADERS].map((h) => h.toLowerCase());
    for (const forbidden of forbiddenUploadFields) {
      expect(headers).not.toContain(forbidden);
    }
  });

  it("renders manual review CSVs with expected headers", () => {
    const packet = fixturePacket();
    expect(renderZaoPropertiesCsv(packet.propertyRows).split("\n")[0]).toBe(PROPERTY_CSV_HEADERS.join(","));
    expect(renderZaoSourceCandidatesCsv(packet.candidateRows).split("\n")[0]).toBe(
      CANDIDATE_CSV_HEADERS.join(",")
    );
  });
});

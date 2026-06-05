import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildZaoUniverseReviewPacket,
  renderZaoExcludedAuditCsv,
  renderZaoPropertiesCsv,
  renderZaoSourceCandidatesCsv,
  renderZaoUniverseReviewMarkdown
} from "../src/services/buildZaoUniverseReviewPacket";

describe("Zao universe review packet export renderers", () => {
  it("writes markdown, property CSV, candidate CSV, alias JSON, and excluded audit CSV", () => {
    const dir = mkdtempSync(join(tmpdir(), "zao-review-"));
    try {
      const packet = buildZaoUniverseReviewPacket(
        {
          universeFile: {
            universe: [
              {
                canonical_property_name: "三浦屋",
                aliases: [],
                sources_present: ["local_operator"],
                jalan: null,
                rakuten: null,
                local: {
                  property_name: "三浦屋",
                  source: "local_operator",
                  canonicalization_status: "canonical",
                  evidence_note: "Local operator."
                },
                canonicalization_status: "canonical",
                evidence_note: "Local extension."
              }
            ],
            excluded_audit: [],
            anchor_checks: []
          },
          candidates: [
            {
              property_name: "三浦屋",
              source: "jalan",
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

      const markdownPath = join(dir, "packet.md");
      const propertyPath = join(dir, "properties.csv");
      const candidatePath = join(dir, "candidates.csv");
      const aliasPath = join(dir, "aliases.json");
      const excludedPath = join(dir, "excluded.csv");
      writeFileSync(markdownPath, renderZaoUniverseReviewMarkdown(packet), "utf-8");
      writeFileSync(propertyPath, renderZaoPropertiesCsv(packet.propertyRows), "utf-8");
      writeFileSync(candidatePath, renderZaoSourceCandidatesCsv(packet.candidateRows), "utf-8");
      writeFileSync(aliasPath, JSON.stringify(packet.aliasMap, null, 2), "utf-8");
      writeFileSync(excludedPath, renderZaoExcludedAuditCsv(packet.excludedAuditRows), "utf-8");

      expect(readFileSync(markdownPath, "utf-8")).toContain("This packet is for human review only.");
      expect(readFileSync(markdownPath, "utf-8")).toContain("It contains no prices.");
      expect(readFileSync(markdownPath, "utf-8")).toContain("## Human Review Priority");
      expect(readFileSync(propertyPath, "utf-8")).toContain("review_decision,reviewer_note");
      expect(readFileSync(candidatePath, "utf-8")).toContain("reviewed_property_url");
      expect(JSON.parse(readFileSync(aliasPath, "utf-8"))).toEqual({});
      expect(readFileSync(excludedPath, "utf-8")).toContain("exclusion_reason");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

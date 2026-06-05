import { describe, expect, it } from "vitest";
import {
  buildTemplateInspection,
  formatTemplateInspection,
  type TemplateRow
} from "../src/scripts/inspectSourceVerificationTemplates";

const FIVE_PROPERTIES = [
  "深山荘 高見屋",
  "名湯リゾート ルーセント",
  "ホテル喜らく",
  "BED'n ONSEN HAMMOND",
  "蔵王温泉 JURIN"
] as const;

const THREE_SOURCES = ["rakuten", "booking", "google_hotels"] as const;

function makeTemplateRows(): TemplateRow[] {
  return FIVE_PROPERTIES.flatMap((property_name) =>
    THREE_SOURCES.map((source) => ({
      property_name,
      source,
      candidate_property_url: null,
      candidate_source_property_id: null,
      verification_status: "candidate"
    }))
  );
}

describe("buildTemplateInspection", () => {
  it("counts 15 rows for the 5×3 template", () => {
    const inspection = buildTemplateInspection(makeTemplateRows());
    expect(inspection.templateRowsCount).toBe(15);
  });

  it("counts 5 rows per source across 3 sources", () => {
    const inspection = buildTemplateInspection(makeTemplateRows());
    expect(inspection.countBySource).toEqual({ rakuten: 5, booking: 5, google_hotels: 5 });
  });

  it("counts 3 rows per property across 5 properties", () => {
    const inspection = buildTemplateInspection(makeTemplateRows());
    expect(Object.values(inspection.countByProperty)).toEqual([3, 3, 3, 3, 3]);
    expect(Object.keys(inspection.countByProperty)).toHaveLength(5);
  });

  it("reports all_rows_candidate=true when all verification_status are candidate", () => {
    const inspection = buildTemplateInspection(makeTemplateRows());
    expect(inspection.allRowsCandidate).toBe(true);
  });

  it("reports all_rows_candidate=false when any row has non-candidate status", () => {
    const rows = makeTemplateRows();
    rows[0]!.verification_status = "confirmed";
    const inspection = buildTemplateInspection(rows);
    expect(inspection.allRowsCandidate).toBe(false);
  });

  it("reports no_verified_urls=true when all candidate_property_url are null", () => {
    const inspection = buildTemplateInspection(makeTemplateRows());
    expect(inspection.noVerifiedUrls).toBe(true);
  });

  it("reports no_verified_urls=false when any row has a non-null URL", () => {
    const rows = makeTemplateRows();
    rows[0]!.candidate_property_url = "https://travel.rakuten.co.jp/HOTEL/12345/";
    const inspection = buildTemplateInspection(rows);
    expect(inspection.noVerifiedUrls).toBe(false);
  });

  it("reports no_verified_source_ids=true when all candidate_source_property_id are null", () => {
    const inspection = buildTemplateInspection(makeTemplateRows());
    expect(inspection.noVerifiedSourceIds).toBe(true);
  });

  it("reports no_verified_source_ids=false when any row has a non-null source id", () => {
    const rows = makeTemplateRows();
    rows[0]!.candidate_source_property_id = "12345";
    const inspection = buildTemplateInspection(rows);
    expect(inspection.noVerifiedSourceIds).toBe(false);
  });

  it("reports no_verified_source_ids=true when source id is empty string", () => {
    const rows = makeTemplateRows();
    rows[0]!.candidate_source_property_id = "";
    const inspection = buildTemplateInspection(rows);
    expect(inspection.noVerifiedSourceIds).toBe(true);
  });

  it("returns zero counts for an empty row list", () => {
    const inspection = buildTemplateInspection([]);
    expect(inspection.templateRowsCount).toBe(0);
    expect(inspection.countBySource).toEqual({});
    expect(inspection.countByProperty).toEqual({});
    expect(inspection.allRowsCandidate).toBe(true);
    expect(inspection.noVerifiedUrls).toBe(true);
    expect(inspection.noVerifiedSourceIds).toBe(true);
  });
});

describe("formatTemplateInspection", () => {
  it("includes all expected keys in output", () => {
    const output = formatTemplateInspection(buildTemplateInspection(makeTemplateRows()));
    expect(output).toContain("template_rows_count=15");
    expect(output).toContain("count_by_source=");
    expect(output).toContain("count_by_property=");
    expect(output).toContain("all_rows_candidate=true");
    expect(output).toContain("no_verified_urls=true");
    expect(output).toContain("no_verified_source_ids=true");
  });

  it("reflects filled URL correctly", () => {
    const rows = makeTemplateRows();
    rows[0]!.candidate_property_url = "https://travel.rakuten.co.jp/HOTEL/12345/";
    rows[0]!.verification_status = "confirmed";
    const output = formatTemplateInspection(buildTemplateInspection(rows));
    expect(output).toContain("all_rows_candidate=false");
    expect(output).toContain("no_verified_urls=false");
    expect(output).toContain("no_verified_source_ids=true");
  });

  it("reflects filled source ID correctly", () => {
    const rows = makeTemplateRows();
    rows[0]!.candidate_source_property_id = "12345";
    const output = formatTemplateInspection(buildTemplateInspection(rows));
    expect(output).toContain("no_verified_source_ids=false");
    expect(output).toContain("no_verified_urls=true");
  });
});

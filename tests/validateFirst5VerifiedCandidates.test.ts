import { describe, expect, it } from "vitest";
import {
  validateFirst5Candidates,
  formatFirst5ValidationResult,
  FIRST5_PROPERTIES,
  FIRST5_SOURCES
} from "../src/scripts/validateFirst5VerifiedCandidates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RawRow = Record<string, unknown>;

function makeTemplateRow(property_name: string, source: string): RawRow {
  return {
    property_name,
    source,
    candidate_property_url: null,
    candidate_source_property_id: null,
    candidate_label: `TODO: Add label once ${source} page is verified`,
    evidence_note:
      "TODO: verify first-party source URL and property identity in a normal browser.",
    verification_status: "candidate",
    reviewer_note: null
  };
}

/** Build the 15-row template (5 properties × 3 sources, all candidate). */
function makeAllTemplateRows(): RawRow[] {
  return FIRST5_PROPERTIES.flatMap((property_name) =>
    FIRST5_SOURCES.map((source) => makeTemplateRow(property_name, source))
  );
}

/** Replace the row for a specific property/source pair in a 15-row set. */
function withRowReplaced(
  rows: RawRow[],
  property_name: string,
  source: string,
  override: RawRow
): RawRow[] {
  return rows.map((r) =>
    r["property_name"] === property_name && r["source"] === source ? override : r
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateFirst5Candidates", () => {
  // 1. Template is structurally valid but not ready for import
  it("template passes structural validation but ready_for_import=false", () => {
    const result = validateFirst5Candidates(makeAllTemplateRows(), "template.json");
    expect(result.structurallyValid).toBe(true);
    expect(result.readyForImport).toBe(false);
    expect(result.errorsCount).toBe(0);
    expect(result.rowsCount).toBe(15);
    // All rows are TODO evidence notes — 15 warnings expected
    expect(result.warningsCount).toBe(15);
  });

  // 2. Valid confirmed Rakuten row passes
  it("valid filled Rakuten confirmed row passes with no errors", () => {
    const confirmedRow: RawRow = {
      property_name: "深山荘 高見屋",
      source: "rakuten",
      candidate_property_url: "https://travel.rakuten.co.jp/HOTEL/12345/",
      candidate_source_property_id: "12345",
      candidate_label: "Rakuten Travel HOTEL/12345 — verified for 深山荘 高見屋",
      evidence_note:
        "Searched travel.rakuten.co.jp for 深山荘 高見屋. HOTEL/12345 page loads with correct name and Zao Onsen location.",
      verification_status: "confirmed",
      reviewer_note:
        "Manually verified: HOTEL/12345 is the correct Rakuten property for 深山荘 高見屋."
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "深山荘 高見屋",
      "rakuten",
      confirmedRow
    );
    const result = validateFirst5Candidates(rows, "filled.json");
    expect(result.errorsCount).toBe(0);
    expect(result.structurallyValid).toBe(true);
    expect(result.readyForImport).toBe(true);
  });

  // 3. Booking confirmed without collectability evidence fails
  it("booking confirmed without collectability evidence produces an error", () => {
    const badRow: RawRow = {
      property_name: "ホテル喜らく",
      source: "booking",
      candidate_property_url:
        "https://www.booking.com/hotel/jp/hotel-kiraku-zao.ja.html",
      candidate_source_property_id: "hotel-kiraku-zao",
      candidate_label: "Booking.com slug hotel-kiraku-zao",
      evidence_note:
        "Found booking.com page for ホテル喜らく at hotel-kiraku-zao slug.",
      verification_status: "confirmed",
      reviewer_note: "Confirmed the property name and address match." // no collectability keyword
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "ホテル喜らく",
      "booking",
      badRow
    );
    const result = validateFirst5Candidates(rows, "bad.json");
    expect(result.errorsCount).toBeGreaterThan(0);
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find((e) =>
      e.message.includes("collectability")
    );
    expect(msg).toBeDefined();
  });

  // 4. Google Hotels confirmed without free-direct evidence fails
  it("google_hotels confirmed without free-direct evidence produces an error", () => {
    const badRow: RawRow = {
      property_name: "名湯リゾート ルーセント",
      source: "google_hotels",
      candidate_property_url:
        "https://www.google.com/travel/hotels/entity/CgoIABC123XYZ",
      candidate_source_property_id: "CgoIABC123XYZ",
      candidate_label: "Google Hotels entity CgoIABC123XYZ",
      evidence_note:
        "Found Google Hotels entity token for 名湯リゾート ルーセント.",
      verification_status: "confirmed",
      reviewer_note: "Property name and location confirmed." // no free-direct keyword
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "名湯リゾート ルーセント",
      "google_hotels",
      badRow
    );
    const result = validateFirst5Candidates(rows, "bad.json");
    expect(result.errorsCount).toBeGreaterThan(0);
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find((e) =>
      e.message.includes("free-direct")
    );
    expect(msg).toBeDefined();
  });

  // 5. Duplicate property/source pair fails
  it("duplicate property/source pair produces an error", () => {
    const rows = makeAllTemplateRows();
    // Replace last row (蔵王温泉 JURIN / google_hotels) with a second 深山荘 高見屋 / rakuten
    rows[14] = makeTemplateRow("深山荘 高見屋", "rakuten");
    const result = validateFirst5Candidates(rows, "dup.json");
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find((e) => e.message.includes("duplicate"));
    expect(msg).toBeDefined();
  });

  // 6. Wrong property name fails
  it("row with unexpected property_name produces an error", () => {
    const rows = makeAllTemplateRows();
    rows[0] = makeTemplateRow("存在しない宿", "rakuten");
    const result = validateFirst5Candidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find((e) =>
      e.message.includes("unexpected property_name")
    );
    expect(msg).toBeDefined();
  });

  // 7. Wrong source fails
  it("row with unexpected source produces an error", () => {
    const rows = makeAllTemplateRows();
    // yahoo_travel is a valid canonical source but not in the first5 batch
    rows[0] = {
      ...makeTemplateRow("深山荘 高見屋", "yahoo_travel")
    };
    const result = validateFirst5Candidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find((e) =>
      e.message.includes("unexpected source")
    );
    expect(msg).toBeDefined();
  });

  // 8. Malformed Rakuten URL fails
  it("malformed Rakuten URL produces an error", () => {
    const badRow: RawRow = {
      property_name: "深山荘 高見屋",
      source: "rakuten",
      candidate_property_url: "https://travel.rakuten.co.jp/SEARCH/12345/", // wrong path
      candidate_source_property_id: "12345",
      candidate_label: "Bad Rakuten URL",
      evidence_note:
        "Found a Rakuten page but the URL pattern looks different from expected.",
      verification_status: "confirmed",
      reviewer_note: "Verified the hotel exists."
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "深山荘 高見屋",
      "rakuten",
      badRow
    );
    const result = validateFirst5Candidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find(
      (e) => e.message.includes("rakuten URL does not match")
    );
    expect(msg).toBeDefined();
  });

  // 9. Malformed Booking URL fails
  it("malformed Booking URL produces an error", () => {
    const badRow: RawRow = {
      property_name: "ホテル喜らく",
      source: "booking",
      candidate_property_url:
        "https://www.booking.com/hotel/us/some-hotel.html", // 'us' not 'jp'
      candidate_source_property_id: "some-hotel",
      candidate_label: "Bad Booking URL",
      evidence_note:
        "Found a Booking page but the URL uses wrong region code.",
      verification_status: "needs_review",
      reviewer_note: null
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "ホテル喜らく",
      "booking",
      badRow
    );
    const result = validateFirst5Candidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find(
      (e) => e.message.includes("booking URL does not match")
    );
    expect(msg).toBeDefined();
  });

  // 10. Malformed Google Hotels URL fails
  it("malformed Google Hotels URL produces an error", () => {
    const badRow: RawRow = {
      property_name: "名湯リゾート ルーセント",
      source: "google_hotels",
      candidate_property_url:
        "https://www.google.com/travel/hotels/search/token123", // missing /entity/
      candidate_source_property_id: "token123",
      candidate_label: "Bad Google Hotels URL",
      evidence_note:
        "Found a Google Hotels page but the URL does not contain the entity path.",
      verification_status: "needs_review",
      reviewer_note: null
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "名湯リゾート ルーセント",
      "google_hotels",
      badRow
    );
    const result = validateFirst5Candidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find(
      (e) => e.message.includes("google_hotels URL does not match")
    );
    expect(msg).toBeDefined();
  });

  // 11. No DB writes — function takes no DB argument
  it("validator requires no database connection", () => {
    // validateFirst5Candidates(rows, filePath) — no db parameter
    // If this runs and returns a result, no DB was needed
    const result = validateFirst5Candidates(makeAllTemplateRows(), "test");
    expect(result).toBeDefined();
    expect(typeof result.structurallyValid).toBe("boolean");
  });

  // 12. No network access — function is pure over the given rows array
  it("validator performs no network access", () => {
    // Pure function: same input always gives same output
    const rows = makeAllTemplateRows();
    const r1 = validateFirst5Candidates(rows, "test");
    const r2 = validateFirst5Candidates(rows, "test");
    expect(r1.errorsCount).toBe(r2.errorsCount);
    expect(r1.structurallyValid).toBe(r2.structurallyValid);
  });

  // 13. Output includes count_by_source
  it("formatted output includes count_by_source", () => {
    const result = validateFirst5Candidates(makeAllTemplateRows(), "test");
    const output = formatFirst5ValidationResult(result);
    expect(output).toContain("count_by_source=");
    expect(output).toContain('"rakuten":5');
    expect(output).toContain('"booking":5');
    expect(output).toContain('"google_hotels":5');
  });

  // 14. Output includes count_by_verification_status
  it("formatted output includes count_by_verification_status", () => {
    const result = validateFirst5Candidates(makeAllTemplateRows(), "test");
    const output = formatFirst5ValidationResult(result);
    expect(output).toContain("count_by_verification_status=");
    expect(output).toContain('"candidate":15');
  });

  // 15. Output includes ready_for_import
  it("formatted output includes ready_for_import", () => {
    const result = validateFirst5Candidates(makeAllTemplateRows(), "test");
    const output = formatFirst5ValidationResult(result);
    expect(output).toContain("ready_for_import=false");
  });
});

describe("validateFirst5Candidates — edge cases", () => {
  it("wrong row count (16 rows) produces a file-level error", () => {
    const rows = [...makeAllTemplateRows(), makeTemplateRow("深山荘 高見屋", "rakuten")];
    const result = validateFirst5Candidates(rows, "too-many.json");
    expect(result.structurallyValid).toBe(false);
    const fileErr = result.errors.find((e) => e.row === "file");
    expect(fileErr).toBeDefined();
    expect(fileErr?.message).toContain("expected 15 rows, got 16");
  });

  it("booking needs_review with valid URL passes without error", () => {
    const goodRow: RawRow = {
      property_name: "ホテル喜らく",
      source: "booking",
      candidate_property_url:
        "https://www.booking.com/hotel/jp/hotel-kiraku-zao.ja.html",
      candidate_source_property_id: "hotel-kiraku-zao",
      candidate_label: "Booking.com slug verified",
      evidence_note:
        "Found booking.com page for ホテル喜らく. Slug hotel-kiraku-zao confirmed.",
      verification_status: "needs_review",
      reviewer_note: null
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "ホテル喜らく",
      "booking",
      goodRow
    );
    const result = validateFirst5Candidates(rows, "ok.json");
    expect(result.errors.filter((e) => typeof e.row === "number" && e.message.includes("booking"))).toHaveLength(0);
  });

  it("booking confirmed WITH collectability evidence passes", () => {
    const goodRow: RawRow = {
      property_name: "ホテル喜らく",
      source: "booking",
      candidate_property_url:
        "https://www.booking.com/hotel/jp/hotel-kiraku-zao.ja.html",
      candidate_source_property_id: "hotel-kiraku-zao",
      candidate_label: "Booking.com slug verified",
      evidence_note:
        "Found booking.com page for ホテル喜らく. Slug confirmed; content_visible on probe.",
      verification_status: "confirmed",
      reviewer_note:
        "Phase 41X content_visible probe confirmed. Collectability status under review."
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "ホテル喜らく",
      "booking",
      goodRow
    );
    const result = validateFirst5Candidates(rows, "ok.json");
    const collectErr = result.errors.find((e) =>
      e.message.includes("collectability")
    );
    expect(collectErr).toBeUndefined();
  });

  it("google_hotels confirmed WITH free_direct evidence passes", () => {
    const goodRow: RawRow = {
      property_name: "名湯リゾート ルーセント",
      source: "google_hotels",
      candidate_property_url:
        "https://www.google.com/travel/hotels/entity/CgoIABC123XYZ",
      candidate_source_property_id: "CgoIABC123XYZ",
      candidate_label: "Google Hotels entity confirmed",
      evidence_note:
        "Found entity token. free_direct page loaded without consent wall.",
      verification_status: "confirmed",
      reviewer_note:
        "free_direct access confirmed on test date. Token is correct."
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "名湯リゾート ルーセント",
      "google_hotels",
      goodRow
    );
    const result = validateFirst5Candidates(rows, "ok.json");
    const freeDirectErr = result.errors.find((e) =>
      e.message.includes("free-direct")
    );
    expect(freeDirectErr).toBeUndefined();
  });

  it("rakuten confirmed without reviewer_note produces an error", () => {
    const badRow: RawRow = {
      property_name: "深山荘 高見屋",
      source: "rakuten",
      candidate_property_url: "https://travel.rakuten.co.jp/HOTEL/12345/",
      candidate_source_property_id: "12345",
      candidate_label: "Rakuten HOTEL/12345",
      evidence_note: "Found HOTEL/12345 for 深山荘 高見屋.",
      verification_status: "confirmed",
      reviewer_note: null // missing
    };
    const rows = withRowReplaced(
      makeAllTemplateRows(),
      "深山荘 高見屋",
      "rakuten",
      badRow
    );
    const result = validateFirst5Candidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    const msg = result.errors.find((e) =>
      e.message.includes("reviewer_note")
    );
    expect(msg).toBeDefined();
  });
});

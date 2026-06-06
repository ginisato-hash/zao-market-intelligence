import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReportFixture } from "./helpers/reportFixtureResolver";
import {
  B09X_MAX_PAGES,
  B09X_VERIFIED_SLUGS,
  buildB09XFutureB10XPlan,
  buildB09XSafetyConfirmation,
  buildB09XSchemaCompatibilitySummary,
  buildB09XUrl,
  decideB09X,
  normalizeB09XRow,
  renderB09XCsv,
  summarizeB09XBlockDetection,
  summarizeB09XPriceBasis,
  summarizeB09XRows,
  validateB09XTargetMatrix,
  type B08XTargetCell
} from "../src/services/bookingBoundedExpandedCollection";
import { type B04ARow } from "../src/services/bookingOfficialTaxFeeTotalHardening";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/bookingBoundedExpandedCollection.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/probeBookingBoundedExpandedCollection.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const CONTEXT = {
  collectedDateJst: "2026-06-04",
  collectedAtJst: "2026-06-04T16:30:00+09:00",
  normalizedAtJst: "2026-06-04T16:30:00+09:00",
  sourceReportPath: "/tmp/booking_b09x.md",
  sourceCsvPath: "/tmp/booking_b09x.csv"
};

function cell(overrides: Partial<B08XTargetCell> = {}): B08XTargetCell {
  return {
    canonical_property_name: "蔵王国際ホテル",
    booking_slug: "zao-kokusai",
    checkin: "2026-06-07",
    checkout: "2026-06-08",
    url: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html?checkin=2026-06-07&checkout=2026-06-08&group_adults=2&no_rooms=1&group_children=0&selected_currency=JPY&lang=ja",
    query_scope: "2_adults_1_room_1_night_jpy_ja",
    slug_status: "verified_b05x",
    risk_level: "low",
    ...overrides
  };
}

function makeB04ARow(overrides: Partial<B04ARow> = {}): B04ARow {
  return {
    runId: "booking_b09x_test",
    collectedAtJst: "2026-06-04T16:30:00+09:00",
    source: "booking",
    collectorStage: "prototype_read_only_b04a",
    pricePolicyVersion: "booking_official_visible_adder_v1",
    propertyNameExpected: "蔵王国際ホテル",
    propertyNameDetected: "蔵王国際ホテル",
    propertyIdentityMatch: true,
    bookingSlug: "zao-kokusai",
    checkin: "2026-06-07",
    checkout: "2026-06-08",
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    selectedCurrency: "JPY",
    lang: "ja",
    urlSanitized: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
    finalUrlSanitized: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
    pageTitle: "蔵王国際ホテル",
    rateCardPresent: true,
    hprtTablePresent: true,
    availabilityAlertPresent: false,
    soldOutTextPresent: false,
    primaryRoomName: "和室",
    primaryRateName: "朝食付き",
    primaryPriceRaw: "￥60,000",
    primaryPriceNumeric: 60_000,
    officialTaxFeeTextRaw: "＋税・手数料（￥6,000）",
    officialTaxFeeAdderNumeric: 6_000,
    officialTaxFeeAdderExtractionStatus: "numeric_extracted",
    computedTotalWithTaxFee: 66_000,
    taxBasisClassification: "booking_room_total_official_base_plus_tax_fee_adder",
    basisConfidence: "A",
    basisNote: "Computed total = base + official adder; no synthetic multiplier.",
    isRoomTotalCandidate: true,
    is2AdultScopeConfirmed: true,
    is1RoomScopeConfirmed: true,
    is1NightScopeConfirmed: true,
    currencyDetected: true,
    languageDetected: true,
    blockingOrModalState: "none",
    classification: "booking_b04a_official_base_plus_adder_numeric",
    debugArtifactPath: "/tmp/booking_b09x/zao-kokusai_2026-06-07",
    ...overrides
  };
}

function normalize(overrides: Partial<B04ARow> = {}) {
  return normalizeB09XRow(makeB04ARow(overrides), CONTEXT);
}

describe("BOOKING-B09X — target matrix controls", () => {
  it("loads the B08X target matrix artifact shape", () => {
    const artifact = JSON.parse(
      readFileSync(
        resolveReportFixture(".data/reports/source-discovery/booking_target_matrix_expansion_proposal_20260604_160105.json"),
        "utf8"
      )
    );
    expect(artifact.proposed_b09x_target_matrix).toHaveLength(30);
    expect(artifact.page_cap_plan.proposed_pages).toBe(30);
  });

  it("rejects matrix > 30 pages", () => {
    const many = Array.from({ length: 31 }, (_, i) => cell({ checkin: `2026-06-${String((i % 28) + 1).padStart(2, "0")}` }));
    const summary = validateB09XTargetMatrix(many);
    expect(summary.cap_exceeded).toBe(true);
    expect(summary.valid).toBe(false);
    expect(summary.reasons).toContain("target_matrix_exceeds_cap");
  });

  it("uses only verified fixed Booking slugs", () => {
    const summary = validateB09XTargetMatrix([cell()]);
    expect(summary.valid).toBe(true);
    expect(B09X_VERIFIED_SLUGS.get("蔵王国際ホテル")).toBe("zao-kokusai");
  });

  it("rejects unverified slugs", () => {
    const summary = validateB09XTargetMatrix([cell({ booking_slug: "invented-slug" })]);
    expect(summary.unverified_slug_count).toBe(1);
    expect(summary.reasons).toContain("unverified_slug_detected");
  });

  it("does not use Booking search scraping", () => {
    const summary = validateB09XTargetMatrix([
      cell({ url: "https://www.booking.com/searchresults.ja.html?ss=Zao" })
    ]);
    expect(summary.search_pages_used).toBe(true);
    expect(summary.reasons).toContain("booking_search_page_detected");
  });

  it("builds fixed Booking property URL with correct params", () => {
    const url = buildB09XUrl(cell());
    expect(url).toContain("/hotel/jp/zao-kokusai.ja.html");
    expect(url).toContain("checkin=2026-06-07");
    expect(url).toContain("checkout=2026-06-08");
    expect(url).toContain("group_adults=2");
    expect(url).toContain("no_rooms=1");
    expect(url).toContain("group_children=0");
    expect(url).toContain("selected_currency=JPY");
    expect(url).toContain("lang=ja");
  });
});

describe("BOOKING-B09X — price and DP policy", () => {
  it("preserves base + official adder price rule", () => {
    const row = normalize();
    expect(row.normalized_total_price).toBe(66_000);
    expect(row.source_primary_price).toBe(60_000);
    expect(row.source_secondary_price_or_adder).toBe(6_000);
    expect(row.normalized_total_price_basis).toBe("booking_official_visible_base_plus_tax_fee_adder_2_adults_1_room_1_night");
  });

  it("rejects base times 1.1 implementation", () => {
    expect(SERVICE_SOURCE).not.toMatch(/=\s*[^;\n]*\*\s*1\.1\b/);
    expect(SERVICE_SOURCE).not.toMatch(/\+\s*[^;\n]*\*\s*1\.1\b/);
    expect(SCRIPT_SOURCE).not.toMatch(/=\s*[^;\n]*\*\s*1\.1\b/);
  });

  it("marks valid official-total rows as B-confidence directional", () => {
    const row = normalize({ basisConfidence: "A" });
    expect(row.basis_confidence).toBe("B");
    expect(row.dp_usage).toBe("directional");
    expect(row.classification).toBe("booking_official_total_directional");
  });

  it("marks missing adder rows as C-confidence excluded", () => {
    const row = normalize({
      computedTotalWithTaxFee: null,
      officialTaxFeeAdderNumeric: null,
      officialTaxFeeAdderExtractionStatus: "unknown",
      taxBasisClassification: "booking_room_total_tax_fee_adder_missing_numeric",
      basisConfidence: "C",
      classification: "booking_b04a_price_basis_unclear"
    });
    expect(row.basis_confidence).toBe("C");
    expect(row.dp_usage).toBe("excluded");
    expect(row.exclusion_reason).toBe("missing_official_tax_fee_adder");
    expect(row.classification).toBe("booking_missing_official_tax_fee_adder");
  });

  it("marks blocked pages as C-confidence excluded", () => {
    const row = normalize({
      primaryPriceNumeric: null,
      officialTaxFeeAdderNumeric: null,
      computedTotalWithTaxFee: null,
      classification: "booking_b04a_blocked",
      blockingOrModalState: "captcha_or_security"
    });
    expect(row.basis_confidence).toBe("C");
    expect(row.dp_usage).toBe("excluded");
    expect(row.exclusion_reason).toBe("booking_page_blocked_or_unavailable");
    expect(row.classification).toBe("booking_page_unavailable");
  });

  it("keeps Booking direct count = 0", () => {
    const rows = [normalize({ basisConfidence: "A" }), normalize({ basisConfidence: "B" })];
    const summary = summarizeB09XRows(rows);
    expect(summary.direct_rows).toBe(0);
    expect(rows.every((row) => row.is_price_usable_for_dp_direct === false)).toBe(true);
  });

  it("sets price_pressure_usable true only for valid official-total rows", () => {
    const valid = normalize();
    const excluded = normalize({ computedTotalWithTaxFee: null, officialTaxFeeAdderNumeric: null });
    expect(valid.price_pressure_usable).toBe(true);
    expect(excluded.price_pressure_usable).toBe(false);
  });

  it("sets dp_usable false for all Booking rows", () => {
    expect(normalize().dp_usable).toBe(false);
    expect(normalize({ computedTotalWithTaxFee: null, officialTaxFeeAdderNumeric: null }).dp_usable).toBe(false);
  });
});

describe("BOOKING-B09X — preview schema and outputs", () => {
  it("produces row_id", () => {
    expect(normalize().row_id).toContain("booking");
  });

  it("produces row_hash", () => {
    expect(normalize().row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces schema_version = zao_local_history_v1", () => {
    expect(normalize().schema_version).toBe("zao_local_history_v1");
  });

  it("produces normalized rows preview only", () => {
    const safety = buildB09XSafetyConfirmation();
    expect(safety.preview_rows_only).toBe(true);
    expect(safety.history_append).toBe(false);
    expect(renderB09XCsv([normalize()])).toContain("row_id,row_hash");
  });

  it("builds schema compatibility summary", () => {
    const summary = buildB09XSchemaCompatibilitySummary([normalize()]);
    expect(summary.compatible).toBe(true);
    expect(summary.preview_only).toBe(true);
  });

  it("builds price, block, and future B10X summaries", () => {
    const rows = [normalize(), normalize({ computedTotalWithTaxFee: null, officialTaxFeeAdderNumeric: null })];
    expect(summarizeB09XPriceBasis(rows).official_total_directional).toBe(1);
    expect(summarizeB09XBlockDetection(rows).blocked_or_unavailable_rows).toBe(0);
    expect(buildB09XFutureB10XPlan().execute_now).toBe(false);
  });

  it("returns ready / basis_caution / not_ready decisions", () => {
    const validMatrix = validateB09XTargetMatrix([cell()]);
    const good = [normalize()];
    expect(
      decideB09X({
        matrixValidation: validMatrix,
        rows: good,
        blockSummary: summarizeB09XBlockDetection(good),
        schemaCompatibility: buildB09XSchemaCompatibilitySummary(good)
      })
    ).toBe("booking_bounded_expanded_collection_ready");

    const blocked = [normalize({ primaryPriceNumeric: null, computedTotalWithTaxFee: null, classification: "booking_b04a_blocked" })];
    expect(
      decideB09X({
        matrixValidation: validMatrix,
        rows: blocked,
        blockSummary: summarizeB09XBlockDetection(blocked),
        schemaCompatibility: buildB09XSchemaCompatibilitySummary(blocked)
      })
    ).toBe("booking_bounded_expanded_collection_not_ready");

    expect(
      decideB09X({
        matrixValidation: validateB09XTargetMatrix([cell({ booking_slug: "bad" })]),
        rows: good,
        blockSummary: summarizeB09XBlockDetection(good),
        schemaCompatibility: buildB09XSchemaCompatibilitySummary(good)
      })
    ).toBe("booking_bounded_expanded_collection_not_ready");
  });
});

describe("BOOKING-B09X — safety scans", () => {
  it("does not append history", () => {
    expect(SERVICE_SOURCE).not.toMatch(/appendFile|real-run:booking-history-append|real-run:auto-history-append/);
    expect(SCRIPT_SOURCE).not.toMatch(/appendFile|real-run:booking-history-append|real-run:auto-history-append/);
  });

  it("does not write DB", () => {
    expect(SERVICE_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE\s+/i);
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE\s+/i);
  });

  it("does not refresh AI context", () => {
    expect(SERVICE_SOURCE).not.toContain("build:ai-context-packs");
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("does not run GitHub Actions", () => {
    expect(SERVICE_SOURCE).not.toMatch(/github|workflow_dispatch|cron/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/workflow_dispatch|cron/iu);
  });

  it("has no PMS/Beds24/AirHost output", () => {
    const safety = buildB09XSafetyConfirmation();
    expect(safety.pms_beds24_airhost_ota_output).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/exportApproved|writeBeds|writeAir|pmsCsv/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/exportApproved|writeBeds|writeAir|pmsCsv/iu);
  });

  it("has no paid-source tooling", () => {
    expect(SERVICE_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/iu);
  });

  it("adds the npm script", () => {
    expect(PACKAGE_JSON).toContain("\"probe:booking-bounded-expanded\"");
  });

  it("uses Playwright only in the bounded B09X runner", () => {
    expect(SCRIPT_SOURCE).toContain("chromium");
    expect(SERVICE_SOURCE).not.toContain("playwright");
  });
});

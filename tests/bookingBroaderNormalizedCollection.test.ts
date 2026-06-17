import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  B05X_CSV_HEADERS,
  B05X_DB_MIRROR_REQUIRED_COLUMNS,
  B05X_DEFAULT_DATES,
  B05X_MAX_DATES_PER_PROPERTY,
  B05X_MAX_PAGES,
  B05X_MAX_PROPERTIES,
  B05X_VERIFIED_BOOKING_TARGETS,
  buildB05XSchemaCompatibilitySummary,
  buildB05XSoldOutSemanticsGuard,
  buildB05XTargetMatrix,
  decideB05X,
  normalizeB05XRow,
  recommendedNextActionForB05X,
  renderB05XCsv,
  renderB05XReport,
  resolveB05XPriceGate,
  summarizeB05XDpUsage,
  summarizeB05XPriceBasis,
  type B05XNormalizedRowPreview
} from "../src/services/bookingBroaderNormalizedCollection";
import { type B04ARow } from "../src/services/bookingOfficialTaxFeeTotalHardening";
import { type BookingRenderedDomTarget } from "../src/services/bookingRenderedDomProbe";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/bookingBroaderNormalizedCollection.ts"),
  "utf8"
);
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/probeBookingBroaderNormalizedCollection.ts"),
  "utf8"
);

const CONTEXT = {
  collectedDateJst: "2026-06-04",
  collectedAtJst: "2026-06-04T14:00:00+09:00",
  normalizedAtJst: "2026-06-04T14:00:00+09:00"
};

function makeB04ARow(overrides: Partial<B04ARow> = {}): B04ARow {
  return {
    runId: "booking_b05x_test",
    collectedAtJst: "2026-06-04T14:00:00+09:00",
    source: "booking",
    collectorStage: "prototype_read_only_b04a",
    pricePolicyVersion: "booking_official_visible_adder_v1",
    propertyNameExpected: "蔵王国際ホテル",
    propertyNameDetected: "蔵王国際ホテル",
    propertyIdentityMatch: true,
    bookingSlug: "zao-kokusai",
    checkin: "2026-08-12",
    checkout: "2026-08-13",
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    selectedCurrency: "JPY",
    lang: "ja",
    urlSanitized: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
    finalUrlSanitized: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
    pageTitle: "Zao Kokusai Hotel",
    rateCardPresent: true,
    hprtTablePresent: true,
    availabilityAlertPresent: false,
    soldOutTextPresent: false,
    primaryRoomName: "",
    primaryRateName: "食事なし",
    primaryRoomCardText: "",
    primaryOccupancyHint: "",
    primaryBedHint: "",
    primaryPriceRaw: "￥60,060",
    primaryPriceNumeric: 60_060,
    officialTaxFeeTextRaw: "＋税・手数料（￥300）",
    officialTaxFeeAdderNumeric: 300,
    officialTaxFeeAdderExtractionStatus: "numeric_extracted",
    computedTotalWithTaxFee: 60_360,
    taxBasisClassification: "booking_room_total_official_base_plus_tax_fee_adder",
    basisConfidence: "B",
    basisNote: "Computed total = base + official adder; no 1.1 multiplier.",
    isRoomTotalCandidate: true,
    is2AdultScopeConfirmed: true,
    is1RoomScopeConfirmed: true,
    is1NightScopeConfirmed: true,
    currencyDetected: true,
    languageDetected: true,
    blockingOrModalState: "none",
    classification: "booking_b04a_official_base_plus_adder_numeric",
    debugArtifactPath: "/tmp/debug/zao-kokusai_2026-08-12",
    ...overrides
  };
}

function normalize(overrides: Partial<B04ARow> = {}): B05XNormalizedRowPreview {
  return normalizeB05XRow(makeB04ARow(overrides), CONTEXT);
}

describe("Phase BOOKING-B05X — target matrix & caps", () => {
  it("(1) builds a bounded matrix from verified targets and default dates", () => {
    const matrix = buildB05XTargetMatrix(B05X_VERIFIED_BOOKING_TARGETS, B05X_DEFAULT_DATES);
    expect(matrix.propertyCount).toBe(3);
    expect(matrix.datesPerProperty).toBe(5);
    expect(matrix.pageCount).toBe(15);
    expect(matrix.capsRespected).toBe(true);
    expect(matrix.pageCount).toBeLessThanOrEqual(B05X_MAX_PAGES);
  });

  it("(2) caps properties to max_properties", () => {
    const many: BookingRenderedDomTarget[] = Array.from({ length: 8 }, (_, i) => ({
      canonicalPropertyName: `p${i}`,
      slug: `slug-${i}`
    }));
    const matrix = buildB05XTargetMatrix(many, ["2026-06-14"]);
    expect(matrix.propertyCount).toBe(B05X_MAX_PROPERTIES);
    expect(matrix.capNotes.some((n) => n.startsWith("property_count_capped"))).toBe(true);
  });

  it("(3) caps dates to max_dates_per_property", () => {
    const dates = ["2026-06-14", "2026-06-21", "2026-07-18", "2026-08-12", "2026-10-10", "2026-12-24"];
    const matrix = buildB05XTargetMatrix([B05X_VERIFIED_BOOKING_TARGETS[0]!], dates);
    expect(matrix.datesPerProperty).toBe(B05X_MAX_DATES_PER_PROPERTY);
    expect(matrix.capNotes.some((n) => n.startsWith("dates_per_property_capped"))).toBe(true);
  });

  it("(4) never exceeds max_pages", () => {
    const many: BookingRenderedDomTarget[] = Array.from({ length: 5 }, (_, i) => ({
      canonicalPropertyName: `p${i}`,
      slug: `slug-${i}`
    }));
    const dates = ["2026-06-14", "2026-06-21", "2026-07-18", "2026-08-12", "2026-10-10"];
    const matrix = buildB05XTargetMatrix(many, dates, { maxPages: 9 });
    expect(matrix.pageCount).toBeLessThanOrEqual(9);
    expect(matrix.capNotes.some((n) => n.startsWith("page_count_capped_at"))).toBe(true);
  });

  it("(5) each cell carries a sanitized fixed property-page URL with checkout = checkin + 1", () => {
    const matrix = buildB05XTargetMatrix([B05X_VERIFIED_BOOKING_TARGETS[0]!], ["2026-06-14"]);
    const cell = matrix.cells[0]!;
    expect(cell.checkout).toBe("2026-06-15");
    expect(cell.urlSanitized).toContain("/hotel/jp/zao-kokusai.ja.html");
    expect(cell.urlSanitized).not.toMatch(/aid=|label=/);
  });
});

describe("Phase BOOKING-B05X — price policy (base + official adder, never × 1.1)", () => {
  it("(6) computes normalized total = base + official adder", () => {
    const row = normalize({ primaryPriceNumeric: 62_756, officialTaxFeeAdderNumeric: 13_181, computedTotalWithTaxFee: 75_937 });
    expect(row.normalized_total_jpy).toBe(75_937);
    expect(row.source_primary_price).toBe(62_756);
    expect(row.source_official_tax_fee_adder).toBe(13_181);
    expect(row.price_basis).toBe("room_total_official_base_plus_visible_tax_fee_2_adults_1_room_1_night");
  });

  it("(7) missing official adder ⇒ total null, confidence C, excluded, missing_official_tax_fee_adder", () => {
    const gate = resolveB05XPriceGate(
      makeB04ARow({
        officialTaxFeeAdderNumeric: null,
        computedTotalWithTaxFee: null,
        primaryPriceNumeric: 88_000,
        basisConfidence: "C",
        classification: "booking_b04a_price_basis_unclear",
        taxBasisClassification: "booking_room_total_tax_fee_basis_unclear"
      }),
      "available"
    );
    expect(gate.normalizedTotalJpy).toBeNull();
    expect(gate.basisConfidence).toBe("C");
    expect(gate.dpUsage).toBe("excluded");
    expect(gate.exclusionReason).toBe("missing_official_tax_fee_adder");
  });

  it("(8) service source contains no base × 1.1 / tax-multiplier logic", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/);
    expect(SERVICE_SOURCE).not.toMatch(/BOOKING_TAX_MULTIPLIER/);
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1\b/);
  });

  it("(9) preserves the official price policy version", () => {
    expect(normalize().price_policy_version).toBe("booking_official_visible_adder_v1");
  });

  it("(10) does not estimate a total when only a primary price is visible", () => {
    const row = normalize({
      officialTaxFeeAdderNumeric: null,
      computedTotalWithTaxFee: null,
      primaryPriceNumeric: 50_000,
      basisConfidence: "C",
      classification: "booking_b04a_price_basis_unclear"
    });
    expect(row.normalized_total_jpy).toBeNull();
    expect(row.exclusion_reason).toBe("missing_official_tax_fee_adder");
  });
});

describe("Phase BOOKING-B05X — availability & DP usage", () => {
  it("(11) available numeric A-confidence row is dp_usage=direct", () => {
    const row = normalize({ basisConfidence: "A" });
    expect(row.availability_status).toBe("available");
    expect(row.sold_out_flag).toBe(0);
    expect(row.dp_usage).toBe("direct");
  });

  it("(12) available numeric B-confidence row is dp_usage=directional", () => {
    const row = normalize();
    expect(row.dp_usage).toBe("directional");
    expect(row.exclusion_reason).toBe("");
  });

  it("(13) sold-out row maps to sold_out + flag 1 + excluded", () => {
    const row = normalize({
      classification: "booking_b04a_sold_out",
      soldOutTextPresent: true,
      primaryPriceNumeric: null,
      computedTotalWithTaxFee: null,
      officialTaxFeeAdderNumeric: null
    });
    expect(row.availability_status).toBe("sold_out");
    expect(row.sold_out_flag).toBe(1);
    expect(row.dp_usage).toBe("excluded");
    expect(row.exclusion_reason).toBe("sold_out");
  });

  it("(14) blocked row maps to blocked + unknown sold_out flag", () => {
    const row = normalize({
      classification: "booking_b04a_blocked",
      blockingOrModalState: "consent_or_cookie_modal",
      primaryPriceNumeric: null,
      computedTotalWithTaxFee: null,
      officialTaxFeeAdderNumeric: null
    });
    expect(row.availability_status).toBe("blocked");
    expect(row.sold_out_flag).toBeNull();
    expect(row.exclusion_reason).toBe("blocked");
  });

  it("(15) property identity mismatch excludes the row", () => {
    const row = normalize({ propertyIdentityMatch: false, basisConfidence: "A" });
    expect(row.property_identity_match).toBe(false);
    expect(row.dp_usage).toBe("excluded");
    expect(row.exclusion_reason).toBe("property_identity_mismatch");
  });
});

describe("Phase BOOKING-B05X — schema compatibility", () => {
  it("(16) preview covers every DB-mirror required column", () => {
    const summary = buildB05XSchemaCompatibilitySummary();
    expect(summary.compatible).toBe(true);
    expect(summary.missing_columns).toEqual([]);
    for (const col of B05X_DB_MIRROR_REQUIRED_COLUMNS) {
      expect(B05X_CSV_HEADERS as readonly string[]).toContain(col);
    }
  });

  it("(17) preview uses the zao_local_history_v1 schema version and canonical row_id/row_hash", () => {
    const row = normalize();
    expect(row.schema_version).toBe("zao_local_history_v1");
    expect(row.row_id).toContain("booking");
    expect(row.row_id).toContain("zao-kokusai");
    expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(18) CSV header/data widths align and no forbidden columns are present", () => {
    const csv = renderB05XCsv([normalize()]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(B05X_CSV_HEADERS.join(","));
    expect((lines[1] ?? "").split(",").length).toBeGreaterThanOrEqual(B05X_CSV_HEADERS.length);
    const headerLower = B05X_CSV_HEADERS.join(",").toLowerCase();
    for (const forbidden of ["tax_multiplier", "tax_included_price", "beds24", "airhost", "pms", "price1"]) {
      expect(headerLower).not.toContain(forbidden);
    }
  });
});

describe("Phase BOOKING-B05X — decision, summaries, report", () => {
  function mixedRows(): B05XNormalizedRowPreview[] {
    return [
      normalize({ bookingSlug: "zao-kokusai", checkin: "2026-08-12", primaryPriceNumeric: 60_060, officialTaxFeeAdderNumeric: 300, computedTotalWithTaxFee: 60_360 }),
      normalize({ bookingSlug: "zao-shiki-no", checkin: "2026-08-12", primaryPriceNumeric: 63_360, officialTaxFeeAdderNumeric: 300, computedTotalWithTaxFee: 63_660 }),
      normalize({ bookingSlug: "shinzanso-takamiya", checkin: "2026-08-12", primaryPriceNumeric: 62_756, officialTaxFeeAdderNumeric: 13_181, computedTotalWithTaxFee: 75_937 }),
      normalize({
        bookingSlug: "zao-kokusai",
        checkin: "2026-10-10",
        primaryPriceNumeric: 70_000,
        officialTaxFeeAdderNumeric: null,
        computedTotalWithTaxFee: null,
        basisConfidence: "C",
        classification: "booking_b04a_price_basis_unclear"
      })
    ];
  }

  it("(19) decides ready with ≥3 DP-usable normalized rows", () => {
    expect(decideB05X(mixedRows())).toBe("booking_broader_normalized_collection_ready");
  });

  it("(20) decides not_ready when no usable totals exist", () => {
    const blocked = [
      normalize({ classification: "booking_b04a_blocked", blockingOrModalState: "consent_or_cookie_modal", primaryPriceNumeric: null, computedTotalWithTaxFee: null, officialTaxFeeAdderNumeric: null })
    ];
    expect(decideB05X(blocked)).toBe("booking_broader_normalized_collection_not_ready");
    expect(recommendedNextActionForB05X("booking_broader_normalized_collection_not_ready")).toMatch(/Not ready/);
  });

  it("(21) summaries count DP usage, missing adders, and the sold-out guard is property-level safe", () => {
    const rows = mixedRows();
    const dp = summarizeB05XDpUsage(rows);
    expect(dp.directional).toBe(3);
    expect(dp.excluded).toBe(1);
    const basis = summarizeB05XPriceBasis(rows);
    expect(basis.normalized_total_present).toBe(3);
    expect(basis.missing_official_tax_fee_adder).toBe(1);
    const guard = buildB05XSoldOutSemanticsGuard();
    expect(guard.property_level_sold_out).toBe(false);
    expect(guard.usable_for_property_sold_out_pressure).toBe(false);
  });

  it("(22) report includes price policy, caps, schema-compat and safety sections", () => {
    const rows = mixedRows();
    const report = renderB05XReport({
      generatedAt: "2026-06-04T05:00:00.000Z",
      rows,
      matrix: buildB05XTargetMatrix(B05X_VERIFIED_BOOKING_TARGETS, B05X_DEFAULT_DATES),
      decision: decideB05X(rows),
      dpUsage: summarizeB05XDpUsage(rows),
      priceBasis: summarizeB05XPriceBasis(rows),
      schemaCompatibility: buildB05XSchemaCompatibilitySummary(),
      soldOutGuard: buildB05XSoldOutSemanticsGuard(),
      pageLoadCount: 4,
      reportPath: "/tmp/r.md",
      csvPath: "/tmp/r.csv",
      jsonPath: "/tmp/r.json",
      debugRootPath: "/tmp/debug"
    });
    expect(report).toContain("primary_price_numeric + official_tax_fee_adder_numeric");
    expect(report).toContain("NEVER primary_price_numeric × 1.1");
    expect(report).toContain("Bounded target matrix");
    expect(report).toContain("Schema compatibility");
    expect(report).toContain("Safety confirmation");
    expect(report).toContain("No history append");
  });
});

describe("Phase BOOKING-B05X — orchestrator safety (static scan)", () => {
  it("(extra) script appends no history, writes no DB, refreshes no AI context, follows no links", () => {
    // No history append (writeFile into .data/history).
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFile|writeFileSync|appendFile|appendFileSync)\s*\([^)]*\.data\/history/);
    // No DB usage.
    expect(SCRIPT_SOURCE).not.toMatch(/better-sqlite3|new Database\(|INSERT\s+INTO|\.prepare\(/);
    // No AI context refresh / subprocess spawning.
    expect(SCRIPT_SOURCE).not.toMatch(/build:ai-context|buildAiContextPacks|execFileSync|execSync|spawnSync/);
    // No link following / clicking / pagination.
    expect(SCRIPT_SOURCE).not.toMatch(/\.click\(/);
    // No stealth / cookie / login.
    expect(SCRIPT_SOURCE).not.toMatch(/addCookies|setCookie|playwright-extra|puppeteer-extra|stealth\s*\(|page\.type\(/iu);
    // No paid sources.
    expect(SCRIPT_SOURCE).not.toMatch(/from\s+["'][^"']*(serpapi|apify|oxylabs|dataforseo|brightdata)/iu);
  });
});

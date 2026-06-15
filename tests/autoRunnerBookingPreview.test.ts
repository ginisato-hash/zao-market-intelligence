import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATE_NAME,
  MAX_PAGES,
  SOURCE_PHASE,
  VERIFIED_BOOKING_TARGETS,
  buildSafetyConfirmation,
  buildTargetMatrix,
  decidePreview,
  enforcePageCap,
  readGate,
  renderPreviewCsv,
  renderReport,
  selectPreviewDates,
  summarizeClassification,
  toPreviewRow,
  type PreviewResult,
  type PreviewRow
} from "../src/services/autoRunnerBookingPreview";
import { buildBookingRenderedDomRow, type BookingRenderedDomRow } from "../src/services/bookingRenderedDomProbe";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerBookingPreview.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerBookingPreview.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

// Build a BookingRenderedDomRow with controllable signals via the proven builder.
function domRow(overrides: {
  slug?: string;
  classification?: BookingRenderedDomRow["classification"];
  firstPrice?: number | null;
  soldOut?: boolean;
  loaded?: boolean;
}): BookingRenderedDomRow {
  const cls = overrides.classification ?? "booking_rendered_price_basis_candidate_found";
  // Drive the real builder so classification logic is exercised, then override.
  const built = buildBookingRenderedDomRow({
    target: { canonicalPropertyName: "蔵王国際ホテル", slug: overrides.slug ?? "zao-kokusai" },
    checkin: "2026-08-10",
    checkout: "2026-08-11",
    probeUrl: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
    signals: {
      loaded: overrides.loaded ?? true,
      httpStatus: 200,
      finalUrl: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
      pageTitle: "x",
      bodyText: "x",
      bodyTextLength: 5000,
      propertyNameDetected: true,
      checkinDetected: true,
      checkoutDetected: true,
      adultCountDetected: true,
      roomCountDetected: true,
      nightCountDetected: true,
      jpyCurrencyDetected: true,
      priceCandidates: [],
      soldOutOrUnavailableDetected: overrides.soldOut ?? false,
      captchaOrSecurityDetected: false,
      loginRequiredDetected: false,
      notFoundDetected: false,
      error: ""
    },
    debugArtifactPath: "/tmp/x"
  });
  return {
    ...built,
    classification: cls,
    firstPriceCandidateValue: overrides.firstPrice === undefined ? 25000 : overrides.firstPrice,
    soldOutOrUnavailableDetected: overrides.soldOut ?? false,
    loaded: overrides.loaded ?? true
  };
}

function previewFrom(row: BookingRenderedDomRow): PreviewRow {
  return toPreviewRow(row, { screenshotPath: "/tmp/s.png", debugPath: "/tmp/d", collectedAtJst: "2026-06-06T12:00:00+09:00" });
}

describe("AUTO-RUNNER08X - gate", () => {
  it("1. default no-env run is ready_not_run", () => {
    const gate = readGate({});
    expect(gate.enabled).toBe(false);
    expect(gate.live_collection_authorized).toBe(false);
    const decision = decidePreview({ liveExecuted: false, pageCapRespected: true, implementationSafe: true, rows: [] });
    expect(decision).toBe("auto_runner_booking_preview_ready_not_run");
  });

  it("2. COLLECT_BOOKING=1 is required for live execution", () => {
    expect(readGate({ [GATE_NAME]: "1" }).live_collection_authorized).toBe(true);
    expect(readGate({ [GATE_NAME]: "0" }).live_collection_authorized).toBe(false);
    expect(readGate({ [GATE_NAME]: "true" }).live_collection_authorized).toBe(false);
  });
});

describe("AUTO-RUNNER08X - target matrix and cap", () => {
  it("3. page cap max_pages=9 is enforced", () => {
    expect(MAX_PAGES).toBe(9);
    const dates = ["2026-06-13", "2026-06-20", "2026-08-10"];
    const matrix = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, dates);
    expect(matrix.length).toBe(9);
    const capped = enforcePageCap(matrix);
    expect(capped.selected.length).toBeLessThanOrEqual(9);
    expect(capped.respected).toBe(true);

    // Over-cap input is trimmed and respected stays true.
    const big = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, dates).concat(
      buildTargetMatrix(VERIFIED_BOOKING_TARGETS, ["2026-09-19"])
    );
    const cappedBig = enforcePageCap(big);
    expect(cappedBig.selected.length).toBe(9);
    expect(cappedBig.capped).toBe(true);
    expect(cappedBig.respected).toBe(true);
  });

  it("4. only verified Booking slugs are selected", () => {
    const matrix = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, ["2026-08-10"]);
    const slugs = new Set(matrix.map((c) => c.property_slug));
    expect(slugs).toEqual(new Set(["zao-kokusai", "zao-shiki-no", "shinzanso-takamiya"]));
  });

  it("rejects non-verified-shaped slugs (e.g. search/path injection)", () => {
    const matrix = buildTargetMatrix([{ canonicalPropertyName: "bad", slug: "../searchresults?ss=zao" }], ["2026-08-10"]);
    expect(matrix.length).toBe(0);
  });

  it("5. no Jalan/Rakuten/Google source is selected", () => {
    const matrix = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, ["2026-08-10"]);
    expect(matrix.every((c) => c.source === "booking")).toBe(true);
    // The runner never invokes another collector (safety-field negations like
    // `jalan_collected: false` are inert data, so scan for actual invocations).
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(
      /collect:jalan|collect:rakuten|probe:jalan|probe:rakuten|jalanCollector|rakutenCollector|googleHotels|google-hotels/u
    );
  });

  it("selectPreviewDates returns two upcoming Saturdays plus the peak date (<=3)", () => {
    const dates = selectPreviewDates("2026-06-06", "2026-08-10"); // 2026-06-06 is a Saturday
    expect(dates).toEqual(["2026-06-13", "2026-06-20", "2026-08-10"]);
  });
});

describe("AUTO-RUNNER08X - no mutation / no forbidden code", () => {
  it("6. no history write code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/\.data\/history|appendHistory|realHistoryAppend|writeFileSync\([^,)]*history/iu);
  });

  it("7. no DB sync / DB write code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/sync:history-to-db|HISTORY_TO_DB_SYNC|INSERT INTO|UPDATE market_signal|DELETE FROM|rate_snapshots/iu);
  });

  it("8. no AI context refresh code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("9. no pricing/PMS output code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*(?:pricing_recommendation|beds24|airhost|price[_-]csv)/iu);
  });

  it("10. no paid proxy / CAPTCHA / stealth / login cookie code exists", () => {
    // Scan for real evasion MECHANISMS, not the words used in safety negations
    // (e.g. `no_stealth: true`, "no CAPTCHA bypass" comments are inert).
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(
      /playwright-extra|puppeteer-extra|stealth-plugin|StealthPlugin|addCookies|addInitScript|storageState|setExtraHTTPHeaders|solveCaptcha|2captcha|brightdata|smartproxy|proxy:\s*\{/u
    );
  });
});

describe("AUTO-RUNNER08X - classification policy", () => {
  it("11. Booking rows cannot be direct", () => {
    const rows = [
      previewFrom(domRow({ classification: "booking_rendered_price_basis_candidate_found", firstPrice: 25000 })),
      previewFrom(domRow({ classification: "booking_rendered_sold_out_or_unavailable", firstPrice: null, soldOut: true }))
    ];
    expect(summarizeClassification(rows).direct).toBe(0);
    // PreviewClassification type has no "direct" member; assert at runtime too.
    expect(rows.every((r) => (r.classification as string) !== "direct")).toBe(true);
  });

  it("12. directional rows require price and acceptable basis", () => {
    const ok = previewFrom(domRow({ classification: "booking_rendered_price_basis_candidate_found", firstPrice: 25000 }));
    expect(ok.classification).toBe("directional");
    expect(ok.primary_price_numeric).toBe(25000);
    expect(ok.basis_confidence).toBe("directional_candidate_basis");

    // price candidate classification but no numeric price -> excluded
    const noPrice = previewFrom(domRow({ classification: "booking_rendered_price_basis_candidate_found", firstPrice: null }));
    expect(noPrice.classification).toBe("excluded");
  });

  it("13. excluded rows are audit-only with no synthetic price/total", () => {
    const soldOut = previewFrom(domRow({ classification: "booking_rendered_sold_out_or_unavailable", firstPrice: null, soldOut: true }));
    expect(soldOut.classification).toBe("excluded");
    expect(soldOut.dp_usage).toBe("audit_only");
    expect(soldOut.primary_price_numeric).toBeNull();
    expect(soldOut.computed_total_with_tax_fee).toBeNull();
    expect(soldOut.official_tax_fee_adder_numeric).toBeNull();
  });

  it("no base*1.1 synthetic tax logic in code", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1|\*\s*1\.10|0\.1\s*\*/u);
  });
});

describe("AUTO-RUNNER08X - output shape", () => {
  function sampleResult(): PreviewResult {
    const rows = [previewFrom(domRow({ classification: "booking_rendered_price_basis_candidate_found", firstPrice: 25000 }))];
    const matrix = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, ["2026-08-10"]);
    const cap = enforcePageCap(matrix);
    return {
      run_id: "auto_runner_booking_preview_20260606_120000",
      generated_at_jst: "2026-06-06T12:00:00+09:00",
      decision: "auto_runner_booking_preview_ready",
      source_phase: SOURCE_PHASE,
      gate: readGate({ [GATE_NAME]: "1" }),
      max_pages: MAX_PAGES,
      page_cap: cap,
      target_matrix: matrix,
      selected_targets: cap.selected,
      preview_rows: rows,
      classification_summary: summarizeClassification(rows),
      safety_confirmation: buildSafetyConfirmation({ liveExecuted: true, pageCapRespected: true }),
      report_path: "r.md",
      json_path: "r.json",
      csv_path: "r.csv",
      debug_artifact_path: "d/"
    };
  }

  it("14. JSON output has required top-level keys", () => {
    const r = sampleResult();
    for (const key of [
      "run_id",
      "generated_at_jst",
      "decision",
      "gate",
      "max_pages",
      "page_cap",
      "target_matrix",
      "selected_targets",
      "preview_rows",
      "classification_summary",
      "safety_confirmation"
    ]) {
      expect(r).toHaveProperty(key);
    }
  });

  it("15. report includes page cap and safety confirmation", () => {
    const text = renderReport(sampleResult());
    expect(text).toContain("max_pages: 9");
    expect(text).toContain("Safety Confirmation");
    expect(text).toContain("live_collection_executed");
  });

  it("required preview-row fields are present", () => {
    const row = previewFrom(domRow({ firstPrice: 25000 }));
    for (const key of [
      "source",
      "property_slug",
      "canonical_property_name",
      "checkin",
      "checkout",
      "stay_scope",
      "availability_status",
      "primary_price_numeric",
      "official_tax_fee_adder_numeric",
      "computed_total_with_tax_fee",
      "basis_confidence",
      "dp_usage",
      "classification",
      "screenshot_path",
      "debug_path",
      "warning_flags",
      "collected_at_jst",
      "source_phase"
    ]) {
      expect(row).toHaveProperty(key);
    }
    expect(row.stay_scope).toBe("2_adults_1_room_1_night");
    expect(row.source_phase).toBe("AUTO-RUNNER08X");
    expect(renderPreviewCsv([row])).toContain("primary_price_numeric");
  });

  it("safety confirmation reflects live flag and stays non-mutating", () => {
    const dry = buildSafetyConfirmation({ liveExecuted: false, pageCapRespected: true });
    expect(dry.live_collection_executed).toBe(false);
    expect(dry.history_modified).toBe(false);
    expect(dry.db_written).toBe(false);
    expect(dry.db_synced).toBe(false);
    expect(dry.ai_context_refreshed).toBe(false);
    expect(dry.pricing_csv_generated).toBe(false);
    const live = buildSafetyConfirmation({ liveExecuted: true, pageCapRespected: true });
    expect(live.live_collection_executed).toBe(true);
  });
});

describe("AUTO-RUNNER08X - decision matrix", () => {
  it("not_ready when page cap not respected", () => {
    expect(decidePreview({ liveExecuted: true, pageCapRespected: false, implementationSafe: true, rows: [] })).toBe(
      "auto_runner_booking_preview_not_ready"
    );
  });
  it("ready when at least one directional row", () => {
    const rows = [previewFrom(domRow({ firstPrice: 25000 }))];
    expect(decidePreview({ liveExecuted: true, pageCapRespected: true, implementationSafe: true, rows })).toBe(
      "auto_runner_booking_preview_ready"
    );
  });
  it("basis_caution when live ran but zero directional rows", () => {
    const rows = [previewFrom(domRow({ classification: "booking_rendered_sold_out_or_unavailable", firstPrice: null, soldOut: true }))];
    expect(decidePreview({ liveExecuted: true, pageCapRespected: true, implementationSafe: true, rows })).toBe(
      "auto_runner_booking_preview_basis_caution"
    );
  });

  it("package.json wires the npm script", () => {
    expect(PACKAGE_JSON).toContain("auto-runner:booking-preview");
  });
});

describe("AUTO-RUNNER16X - crawl volume multiplier (booking)", () => {
  it("baseline multiplier=1 keeps 3 dates and a 9-page cap", () => {
    expect(selectPreviewDates("2026-06-06", "2026-08-10", 1)).toHaveLength(3);
    const matrix = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, selectPreviewDates("2026-06-06", "2026-08-10", 1), 1);
    expect(matrix.length).toBe(9);
    expect(enforcePageCap(matrix, 1).max_pages).toBe(MAX_PAGES);
  });

  it("multiplier=3 expands to 9 near-term dates and a 27-page cap", () => {
    const dates = selectPreviewDates("2026-06-06", "2026-08-10", 3);
    expect(dates).toHaveLength(9); // 8 upcoming Saturdays + peak
    const matrix = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, dates, 3);
    expect(matrix.length).toBe(27); // 3 properties x 9 dates
    const cap = enforcePageCap(matrix, 3);
    expect(cap.max_pages).toBe(27);
    expect(cap.selected.length).toBe(27);
    expect(cap.respected).toBe(true);
  });

  it("multiplier=3 keeps the verified property set fixed (only dates grow)", () => {
    const dates = selectPreviewDates("2026-06-06", "2026-08-10", 3);
    const matrix = buildTargetMatrix(VERIFIED_BOOKING_TARGETS, dates, 3);
    expect(new Set(matrix.map((c) => c.property_slug)).size).toBe(3);
    expect(matrix.every((c) => c.source === "booking")).toBe(true);
  });
});

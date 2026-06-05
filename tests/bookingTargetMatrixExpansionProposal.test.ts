import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATE_WINDOW_STRATEGY,
  buildMissingBookingSlugCandidates,
  buildPageCapPlan,
  buildPriceBasisPolicy,
  buildProposedTargetMatrix,
  buildRiskAssessment,
  buildSafetyConfirmation,
  buildVerifiedBookingProperties,
  decideBookingTargetMatrixExpansion,
  extractBookingSlug,
  renderBookingTargetMatrixExpansionCsv,
  renderBookingTargetMatrixExpansionReport,
  type BookingTargetMatrixExpansionProposal,
  type CurrentBookingContext
} from "../src/services/bookingTargetMatrixExpansionProposal";

const SERVICE_SOURCE = readFileSync(resolve("src/services/bookingTargetMatrixExpansionProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/buildBookingTargetMatrixExpansionProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve("package.json"), "utf8");

const verified = buildVerifiedBookingProperties([]);
const missing = buildMissingBookingSlugCandidates({
  verified,
  sourceCoverage: {
    "名湯リゾート ルーセント": ["rakuten:39565", "jalan:331969"],
    JURIN: ["rakuten:14585", "jalan:332556"],
    "ONSEN & STAY OAKHILL": ["rakuten:196553", "jalan:388065"],
    "BED'n ONSEN HAMMOND": ["rakuten:40033", "jalan:348320"],
    "おおみや旅館": ["rakuten:5722", "jalan:338565"],
    "源泉湯宿 蔵王プラザホテル": ["rakuten:7747", "jalan:353340"]
  }
});
const cap = buildPageCapPlan(verified.length);
const matrix = buildProposedTargetMatrix(verified, cap);
const pricePolicy = buildPriceBasisPolicy();
const currentContext: CurrentBookingContext = {
  history_rows: 160,
  db_market_signal_history_rows: 160,
  ai_context_row_count: 160,
  booking_rows: 21,
  booking_directional_rows: 19,
  booking_excluded_rows: 2,
  booking_direct_rows: 0,
  b07b_decision: "post_booking_history_append_refresh_basis_caution",
  rakuten_priority_decision: "NO_GO_FREEZE_RAKUTEN"
};

function proposal(): BookingTargetMatrixExpansionProposal {
  const decision = decideBookingTargetMatrixExpansion({
    b07bDecision: currentContext.b07b_decision,
    verifiedCount: verified.length,
    pageCapOk: cap.caps_respected,
    missingCount: missing.length
  });
  return {
    run_id: "booking_target_matrix_expansion_proposal_20260604_160000",
    generated_at_jst: "2026-06-04T16:00:00+09:00",
    decision,
    source_b07b_artifact_path: ".data/reports/automation/post_booking_history_append_refresh_20260604_155005.json",
    current_booking_context: currentContext,
    verified_booking_properties: verified,
    missing_booking_slug_candidates: missing,
    date_window_strategy: DATE_WINDOW_STRATEGY,
    proposed_b09x_target_matrix: matrix,
    page_cap_plan: cap,
    price_basis_policy: pricePolicy,
    risk_assessment: buildRiskAssessment(missing.length),
    future_b09x_plan: {
      phase: "BOOKING-B09X — Bounded expanded Booking.com normalized collection",
      collection_rules: ["Use fixed Booking.com property slug URLs only.", "Do not scrape Booking search results."],
      blocked_handling: ["Record blocked status.", "Do not bypass."],
      not_allowed: ["No Booking base * 1.1."]
    },
    safety_confirmation: buildSafetyConfirmation(),
    report_path: "r.md",
    json_path: "r.json",
    csv_path: "r.csv",
    debug_artifact_path: "debug"
  };
}

describe("BOOKING-B08X inputs and slug coverage", () => {
  it("loads B07B / latest Booking context", () => {
    expect(currentContext.booking_rows).toBe(21);
    expect(currentContext.booking_direct_rows).toBe(0);
    expect(currentContext.b07b_decision).toMatch(/post_booking_history_append_refresh/);
  });

  it("recognizes the 3 verified B05X Booking slugs", () => {
    expect(verified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonical_property_name: "蔵王国際ホテル", booking_slug: "zao-kokusai" }),
        expect.objectContaining({ canonical_property_name: "蔵王四季のホテル", booking_slug: "zao-shiki-no" }),
        expect.objectContaining({ canonical_property_name: "深山荘 高見屋", booking_slug: "shinzanso-takamiya" })
      ])
    );
  });

  it("parses local needs-review Booking slug evidence without promoting it", () => {
    expect(extractBookingSlug("https://www.booking.com/hotel/jp/le-vert-zao.ja.html")).toBe("le-vert-zao");
    expect(verified.some((row) => row.booking_slug === "le-vert-zao")).toBe(false);
  });

  it("does not invent Booking slugs", () => {
    expect(missing.every((row) => row.booking_slug_status === "missing_booking_slug")).toBe(true);
    expect(missing.some((row) => row.canonical_property_name === "名湯リゾート ルーセント")).toBe(true);
    expect(missing.some((row) => row.canonical_property_name === "ル・ベール蔵王")).toBe(true);
  });

  it("marks missing slugs as manual_slug_review", () => {
    expect(missing.every((row) => row.recommended_action === "manual_slug_review")).toBe(true);
    expect(missing.every((row) => row.manual_review_needed)).toBe(true);
  });
});

describe("BOOKING-B08X date windows and caps", () => {
  it("builds date-window strategy", () => {
    expect(DATE_WINDOW_STRATEGY).toHaveLength(4);
  });

  it("includes near-term dates", () => {
    expect(DATE_WINDOW_STRATEGY[0].dates).toContain("2026-06-07");
    expect(DATE_WINDOW_STRATEGY[0].dates).toContain("2026-06-28");
  });

  it("includes summer / Obon dates", () => {
    expect(DATE_WINDOW_STRATEGY[1].dates).toEqual(expect.arrayContaining(["2026-07-18", "2026-08-12", "2026-08-15"]));
  });

  it("includes autumn long-weekend dates", () => {
    expect(DATE_WINDOW_STRATEGY[2].dates).toEqual(expect.arrayContaining(["2026-09-19", "2026-10-10", "2026-10-12"]));
  });

  it("includes winter early signal dates", () => {
    expect(DATE_WINDOW_STRATEGY[3].dates).toEqual(expect.arrayContaining(["2026-12-05", "2026-12-12", "2026-12-19"]));
  });

  it("caps proposed B09X pages <= 40", () => {
    expect(cap.proposed_pages).toBeLessThanOrEqual(40);
    expect(matrix).toHaveLength(cap.proposed_pages);
  });

  it("caps properties <= 5", () => {
    expect(cap.proposed_properties).toBeLessThanOrEqual(5);
  });

  it("caps dates per property", () => {
    expect(cap.proposed_dates_per_property).toBeLessThanOrEqual(cap.max_dates_per_property);
  });
});

describe("BOOKING-B08X collection and price policy", () => {
  it("uses fixed property slug URLs only", () => {
    expect(matrix.every((row) => row.url.startsWith(`https://www.booking.com/hotel/jp/${row.booking_slug}.ja.html?`))).toBe(true);
    expect(matrix.every((row) => row.url.includes("group_adults=2") && row.url.includes("selected_currency=JPY"))).toBe(true);
  });

  it("rejects Booking search scraping", () => {
    const plan = proposal().future_b09x_plan.collection_rules.join(" ");
    expect(plan).toMatch(/fixed Booking\.com property slug URLs only/i);
    expect(plan).toMatch(/Do not scrape Booking search results/i);
  });

  it("preserves base + official adder price rule", () => {
    expect(pricePolicy.computed_total_rule).toBe("primary_price_numeric + official_tax_fee_adder_numeric");
  });

  it("rejects base times 1.1", () => {
    expect(pricePolicy.forbidden_rule).toBe("primary_price_numeric * 1.1");
  });

  it("marks Booking valid rows as directional price-pressure, not direct", () => {
    expect(pricePolicy.valid_rows.basis_confidence).toBe("B");
    expect(pricePolicy.valid_rows.dp_usage).toBe("directional");
    expect(pricePolicy.booking_direct_rows_allowed).toBe(0);
  });

  it("keeps dp_usable false for Booking rows", () => {
    expect(pricePolicy.valid_rows.dp_usable).toBe(false);
    expect(pricePolicy.missing_official_adder_rows.dp_usable).toBe(false);
  });
});

describe("BOOKING-B08X rendering and decision", () => {
  it("renders report and CSV", () => {
    const p = proposal();
    expect(renderBookingTargetMatrixExpansionReport(p)).toContain("Booking.com Target Matrix Expansion Proposal");
    expect(renderBookingTargetMatrixExpansionCsv(p)).toContain("canonical_property_name,booking_slug,checkin");
  });

  it("returns ready / basis_caution / not_ready decisions", () => {
    expect(proposal().decision).toBe("booking_target_matrix_expansion_proposal_basis_caution");
    expect(
      decideBookingTargetMatrixExpansion({ b07bDecision: "", verifiedCount: 4, pageCapOk: true, missingCount: 0 })
    ).toBe("booking_target_matrix_expansion_proposal_not_ready");
    expect(
      decideBookingTargetMatrixExpansion({ b07bDecision: "ok", verifiedCount: 4, pageCapOk: true, missingCount: 0 })
    ).toBe("booking_target_matrix_expansion_proposal_ready");
  });

  it("has package script", () => {
    expect(PACKAGE_JSON).toContain("proposal:booking-target-matrix-expansion");
  });
});

describe("BOOKING-B08X safety scans", () => {
  it("does not run Playwright", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(import|require)[^;\n]*playwright|chromium\.launch|firefox\.launch|webkit\.launch/i);
  });

  it("does not fetch Booking", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/fetch\s*\(|https\.get|probe:booking|booking-broader-normalized/i);
  });

  it("does not write DB", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/better-sqlite3|openLocalDatabase|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i);
  });

  it("does not modify history", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(appendFileSync|renameSync|copyFileSync|unlinkSync|rmSync)\s*\([^)]*history/i);
  });

  it("does not refresh AI context", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/build:ai-context-packs|buildAiContextPacks/i);
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/ai-context/is);
  });

  it("has no PMS/Beds24/AirHost output", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/(writeFileSync|appendFileSync)\s*\([^)]*(beds24|airhost|pms|ota)/i);
  });

  it("has no paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/serpapi|dataforseo|apify|bright data|brightdata|oxylabs|paid proxy/i);
  });
});

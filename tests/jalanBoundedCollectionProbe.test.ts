import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFutureAuto04xPlan,
  buildJalanPlanUrl,
  buildJalanProbeTarget,
  buildNormalizedPreviewRow,
  buildSafetyConfirmation,
  buildSummaries,
  classifyExtractionCandidate,
  decideJalanBoundedCollectionProbe,
  enforceTargetCaps,
  loadAuto02xTargetMatrix,
  renderReport,
  type JalanExtractionCandidate,
  type JalanProbeTarget
} from "../src/services/jalanBoundedCollectionProbe";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/jalanBoundedCollectionProbe.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/probeJalanBoundedCollection.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function artifact(): {
  decision: string;
  auto03x_bounded_matrix: Array<{
    canonical_property_name: string;
    tier: "tier_1" | "tier_2";
    jalan_source_url: string;
    jalan_property_id: string;
    dates: string[];
    page_count: number;
  }>;
} {
  return {
    decision: "jalan_target_matrix_proposal_basis_caution",
    auto03x_bounded_matrix: [
      {
        canonical_property_name: "ホテル喜らく",
        tier: "tier_1",
        jalan_source_url: "https://www.jalan.net/yad325153/",
        jalan_property_id: "yad325153",
        dates: ["2026-06-06", "2026-06-13", "2026-07-18", "2026-08-08", "2026-10-10"],
        page_count: 5
      }
    ]
  };
}

function target(): JalanProbeTarget {
  return buildJalanProbeTarget({
    canonicalPropertyName: "ホテル喜らく",
    facilityTier: "tier_1",
    jalanYadId: "yad325153",
    sourceUrl: "https://www.jalan.net/yad325153/",
    checkin: "2026-07-18"
  });
}

function candidate(overrides: Partial<JalanExtractionCandidate> = {}): JalanExtractionCandidate {
  return {
    facility_name: "ホテル喜らく",
    room_or_plan_name: "和室プラン",
    meal_condition: "朝食付き",
    availability_status: "available",
    price_total_tax_included: 22000,
    price_per_person: null,
    price_basis_text: "合計(税込) 22,000円",
    tax_included_evidence: true,
    stay_scope_evidence: true,
    coupon_or_discount_evidence: false,
    date_condition_evidence: true,
    property_identity_confirmed: true,
    screenshot_path: "/tmp/screenshot.png",
    source_url: "https://www.jalan.net/yad325153/plan/?stayYear=2026&stayMonth=07&stayDay=18&stayCount=1&roomCrack=200000&roomCount=1",
    raw_text_excerpt: "合計(税込) 22,000円 朝食付き",
    error_reason: null,
    extraction_confidence: "high",
    ...overrides
  };
}

describe("JALAN-AUTO03X - target matrix and caps", () => {
  it("loads AUTO02X target matrix", () => {
    expect(loadAuto02xTargetMatrix(artifact()).length).toBe(5);
  });

  it("enforces max_pages <= 25", () => {
    const targets = Array.from({ length: 26 }, (_, index) =>
      buildJalanProbeTarget({
        canonicalPropertyName: "ホテル喜らく",
        facilityTier: "tier_1",
        jalanYadId: "yad325153",
        sourceUrl: "https://www.jalan.net/yad325153/",
        checkin: `2026-07-${String(index + 1).padStart(2, "0")}`
      })
    );
    expect(() => enforceTargetCaps(targets)).toThrow(/max_pages/u);
  });

  it("rejects unverified targets", () => {
    expect(() =>
      loadAuto02xTargetMatrix({
        decision: "jalan_target_matrix_proposal_basis_caution",
        auto03x_bounded_matrix: [
          {
            canonical_property_name: "OAKHILL",
            tier: "tier_1",
            jalan_source_url: "",
            jalan_property_id: "",
            dates: ["2026-07-18"],
            page_count: 1
          }
        ]
      })
    ).toThrow(/unverified/u);
  });

  it("builds Jalan fixed property/date targets", () => {
    const built = target();
    expect(built.target_url).toContain("https://www.jalan.net/yad325153/plan/");
    expect(built.target_url).toContain("stayYear=2026");
    expect(built.target_url).toContain("roomCrack=200000");
  });

  it("builds fixed URL with correct params", () => {
    const url = buildJalanPlanUrl({ jalanYadId: "yad325153", checkin: "2026-07-18", stayNights: 1, adults: 2, rooms: 1, children: 0 });
    expect(url).toContain("stayDay=18");
    expect(url).toContain("adultNum=2");
    expect(url).toContain("yadNo=325153");
  });
});

describe("JALAN-AUTO03X - classification", () => {
  it("classifies available row with clear tax-included price", () => {
    expect(classifyExtractionCandidate(candidate()).availability_status).toBe("available");
  });

  it("classifies sold_out row without price", () => {
    const result = classifyExtractionCandidate(candidate({ availability_status: "sold_out", price_total_tax_included: null, error_reason: "sold_out" }));
    expect(result.dp_usage).toBe("excluded");
    expect(result.availability_status).toBe("sold_out");
  });

  it("classifies failed row on timeout/block/captcha", () => {
    const result = classifyExtractionCandidate(candidate({ availability_status: "failed", price_total_tax_included: null, error_reason: "captcha" }));
    expect(result.dp_usage).toBe("excluded");
    expect(result.warning_flags.join(";")).not.toContain("captcha_bypass");
  });

  it("does not infer missing price", () => {
    const result = classifyExtractionCandidate(candidate({ price_total_tax_included: null, error_reason: "price_missing" }));
    expect(result.dp_usage).toBe("excluded");
    expect(result.basis_confidence).toBe("C");
  });

  it("direct row requires A-confidence and screenshot", () => {
    const result = classifyExtractionCandidate(candidate());
    expect(result.dp_usage).toBe("direct");
    expect(result.basis_confidence).toBe("A");
  });

  it("no screenshot prevents B/direct", () => {
    const result = classifyExtractionCandidate(candidate({ screenshot_path: null }));
    expect(result.dp_usage).toBe("excluded");
    expect(result.basis_confidence).toBe("C");
  });

  it("directional row allowed for visible price with partial evidence", () => {
    const result = classifyExtractionCandidate(candidate({ meal_condition: null, extraction_confidence: "medium" }));
    expect(result.dp_usage).toBe("directional");
    expect(result.basis_confidence).toBe("B");
  });

  it("excluded row for missing price or disqualified basis", () => {
    expect(classifyExtractionCandidate(candidate({ coupon_or_discount_evidence: true })).dp_usage).toBe("excluded");
  });

  it("coupon/member/suspicious evidence disqualifies direct", () => {
    const result = classifyExtractionCandidate(candidate({ coupon_or_discount_evidence: true }));
    expect(result.dp_usage).not.toBe("direct");
    expect(result.dp_exclusion_reason).toBe("coupon_member_point_or_suspicious_price");
  });

  it("retry count max 1", () => {
    expect(buildSafetyConfirmation().max_retries_per_target).toBe(1);
  });
});

describe("JALAN-AUTO03X - preview rows and reports", () => {
  it("normalized preview row includes required fields", () => {
    const row = buildNormalizedPreviewRow({
      runId: "run",
      checkedAt: "2026-06-04T22:00:00+09:00",
      target: target(),
      candidate: candidate(),
      reportPath: "report.md",
      csvPath: "rows.csv",
      debugPath: "debug.json"
    });
    expect(row.source).toBe("jalan");
    expect(row.source_phase).toBe("JALAN-AUTO03X");
    expect(row.schema_version).toBe("zao_local_history_v1");
    expect(row.screenshot_path).toBe("/tmp/screenshot.png");
  });

  it("screenshot path is required for B/direct", () => {
    const row = buildNormalizedPreviewRow({
      runId: "run",
      checkedAt: "2026-06-04T22:00:00+09:00",
      target: target(),
      candidate: candidate({ screenshot_path: null }),
      reportPath: "report.md",
      csvPath: "rows.csv",
      debugPath: "debug.json"
    });
    expect(row.dp_usage).toBe("excluded");
    expect(row.basis_confidence).toBe("C");
  });

  it("decision ready/basis_caution/not_ready/failed", () => {
    expect(decideJalanBoundedCollectionProbe({ targetCount: 1, rowCount: 1, failedCount: 0, blockedCount: 0, pricedRows: 1, screenshotCount: 1 })).toBe(
      "jalan_bounded_collection_probe_ready"
    );
    expect(decideJalanBoundedCollectionProbe({ targetCount: 1, rowCount: 1, failedCount: 0, blockedCount: 1, pricedRows: 1, screenshotCount: 1 })).toBe(
      "jalan_bounded_collection_probe_basis_caution"
    );
    expect(decideJalanBoundedCollectionProbe({ targetCount: 1, rowCount: 1, failedCount: 1, blockedCount: 0, pricedRows: 0, screenshotCount: 0 })).toBe(
      "jalan_bounded_collection_probe_not_ready"
    );
    expect(decideJalanBoundedCollectionProbe({ targetCount: 1, rowCount: 1, failedCount: 0, blockedCount: 0, pricedRows: 1, screenshotCount: 1, artifactWriteFailed: true })).toBe(
      "jalan_bounded_collection_probe_failed"
    );
  });

  it("report renderer includes failure summary", () => {
    const report = renderReport({
      generatedAtJst: "2026-06-04T22:00:00+09:00",
      decision: "jalan_bounded_collection_probe_basis_caution",
      sourceAuto02xArtifact: "auto02x.json",
      targetMatrixSummary: {},
      pageResultsSummary: {},
      normalizedPreviewRowsSummary: {},
      availabilitySummary: {},
      priceBasisSummary: {},
      directDirectionalExcludedSummary: {},
      failureSummary: { failed_count: 1 },
      screenshotSummary: {},
      futureAuto04xPlan: buildFutureAuto04xPlan(),
      safetyConfirmation: buildSafetyConfirmation()
    });
    expect(report).toContain("Failure / Error Summary");
  });

  it("JSON includes normalized_preview_rows", () => {
    const row = buildNormalizedPreviewRow({
      runId: "run",
      checkedAt: "2026-06-04T22:00:00+09:00",
      target: target(),
      candidate: candidate(),
      reportPath: "report.md",
      csvPath: "rows.csv",
      debugPath: "debug.json"
    });
    const summaries = buildSummaries({ targets: [target()], pageResults: [], rows: [row] });
    expect(Object.keys({ normalized_preview_rows: [row], ...summaries })).toContain("normalized_preview_rows");
  });
});

describe("JALAN-AUTO03X - executable safety scans", () => {
  it("has no history write code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync|writeFileSync\([^)]*\.data\/history/iu);
  });

  it("has no DB write code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|better-sqlite3|prepare\(["'`]\s*(?:INSERT|UPDATE|DELETE)|\.exec\(/iu);
  });

  it("has no DB sync code", () => {
    expect(SCRIPT_SOURCE).not.toContain("real-run:history-to-db-sync");
  });

  it("has no AI context refresh code", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("has no pricing CSV / PMS output", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/pricing:recommend|pricing:approve|Beds24|AirHost|pmsCsv|exportApproved/iu);
  });

  it("has no paid proxy / CAPTCHA bypass / stealth code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/proxy|stealth|captchaSolver|puppeteer-extra|login|cookie/iu);
  });

  it("does not invoke Booking/Rakuten/Google Hotel collection", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/bookingBounded|Booking|rakuten|Rakuten|googleHotels|GoogleHotels/u);
  });

  it("adds npm script and keeps service safe", () => {
    expect(PACKAGE_JSON).toContain("\"probe:jalan-bounded-collection\"");
    expect(SERVICE_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch|page\.goto/u);
  });
});

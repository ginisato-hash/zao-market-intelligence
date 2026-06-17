import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuto03xComparison,
  buildEvidenceFlags,
  buildFutureAuto04xPlan,
  buildImprovedPreviewRow,
  buildJalanProbeTarget,
  buildRescuedRows,
  buildSafetyConfirmation,
  classifyImprovedCandidate,
  decideImproved,
  detectCouponEvidence,
  enforceTargetCaps,
  isSuspiciousPrice,
  loadAuto02xTargetMatrix,
  renderImprovedPreviewRowsCsv,
  type Auto03xPriorRow,
  type JalanImprovedExtractionCandidate,
  type JalanProbeTarget
} from "../src/services/jalanBoundedCollectionProbeImproved";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/jalanBoundedCollectionProbeImproved.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/probeJalanBoundedCollectionImproved.ts"), "utf8");
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

function target(checkin = "2026-07-18"): JalanProbeTarget {
  return buildJalanProbeTarget({
    canonicalPropertyName: "ホテル喜らく",
    facilityTier: "tier_1",
    jalanYadId: "yad325153",
    sourceUrl: "https://www.jalan.net/yad325153/",
    checkin
  });
}

function candidate(overrides: Partial<JalanImprovedExtractionCandidate> = {}): JalanImprovedExtractionCandidate {
  return {
    facility_name: "ホテル喜らく",
    room_or_plan_name: "和室素泊まりプラン",
    room_name: "和室",
    plan_name: "和室素泊まりプラン",
    meal_condition: "食事なし",
    availability_status: "available",
    price_total_tax_included: 22000,
    price_per_person: null,
    price_basis_text: "合計(税込) 22,000円",
    tax_included_evidence: true,
    stay_scope_evidence: true,
    date_condition_evidence: true,
    property_identity_confirmed: true,
    screenshot_path: "/tmp/screenshot.png",
    source_url: "https://www.jalan.net/yad325153/plan/?stayYear=2026&stayMonth=07&stayDay=18&stayCount=1&roomCrack=200000&roomCount=1",
    selected_block_text: "和室素泊まりプラン 合計(税込) 22,000円 素泊まり",
    page_text_excerpt: "ホテル喜らく 和室素泊まりプラン 合計(税込) 22,000円 素泊まり",
    error_reason: null,
    extraction_confidence: "high",
    ...overrides
  };
}

function previewRow(c: JalanImprovedExtractionCandidate, checkin = "2026-07-18") {
  return buildImprovedPreviewRow({
    runId: "run",
    checkedAt: "2026-06-05T10:00:00+09:00",
    target: target(checkin),
    candidate: c,
    reportPath: "report.md",
    csvPath: "rows.csv",
    debugPath: "debug.json"
  });
}

describe("JALAN-AUTO03B - target matrix and caps", () => {
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
});

describe("JALAN-AUTO03B - coupon evidence split", () => {
  it("splits selected-plan coupon evidence from page-chrome", () => {
    const evidence = detectCouponEvidence({
      selectedBlockText: "じゃらんスペシャル 直前割 合計(税込) 20,000円",
      pageText: "ホテル ポイント 5 倍",
      roomOrPlanName: "直前割プラン"
    });
    expect(evidence.selected_plan_coupon_or_discount_evidence).toBe(true);
    expect(evidence.page_chrome_coupon_or_discount_evidence).toBe(false);
  });

  it("treats generic page-chrome point/coupon text as page-chrome only", () => {
    const evidence = detectCouponEvidence({
      selectedBlockText: "和室プラン 合計(税込) 22,000円",
      pageText: "今だけクーポン配布中 ポイント 10 倍 セール開催 会員価格あり",
      roomOrPlanName: "和室プラン"
    });
    expect(evidence.selected_plan_coupon_or_discount_evidence).toBe(false);
    expect(evidence.page_chrome_coupon_or_discount_evidence).toBe(true);
    expect(evidence.page_chrome_member_or_point_evidence).toBe(true);
  });

  it("ignores generic Jalan loyalty/score chrome inside the selected block", () => {
    const evidence = detectCouponEvidence({
      selectedBlockText:
        "【素泊まり】自分スタイルで蔵王満喫 加算予定ポイント 加算予定スコア スコアをためるとステージがアップし、お得な特典が受けられるようになります。 じゃらんステージプログラムの説明をみる 合計(税込) 25,000円",
      pageText: "ホテル 加算予定ポイント スコア",
      roomOrPlanName: "素泊まりプラン"
    });
    expect(evidence.selected_plan_coupon_or_discount_evidence).toBe(false);
    expect(evidence.selected_plan_member_or_point_evidence).toBe(false);
  });

  it("flags suspicious prices outside the stay band", () => {
    expect(isSuspiciousPrice(3000)).toBe(true);
    expect(isSuspiciousPrice(700000)).toBe(true);
    expect(isSuspiciousPrice(22000)).toBe(false);
    expect(isSuspiciousPrice(null)).toBe(false);
  });

  it("builds evidence flags from a candidate", () => {
    const flags = buildEvidenceFlags(candidate());
    expect(flags.tax_included_total_visible).toBe(true);
    expect(flags.screenshot_saved).toBe(true);
    expect(flags.price_inferred).toBe(false);
  });
});

describe("JALAN-AUTO03B - classification policy", () => {
  it("classifies a strict clean row as direct (A)", () => {
    const result = classifyImprovedCandidate(candidate());
    expect(result.dp_usage).toBe("direct");
    expect(result.basis_confidence).toBe("A");
  });

  it("selected-plan coupon blocks direct and excludes directional", () => {
    const result = classifyImprovedCandidate(
      candidate({ selected_block_text: "直前割プラン 合計(税込) 18,000円 クーポン適用", plan_name: "直前割プラン" })
    );
    expect(result.dp_usage).toBe("excluded");
    expect(result.directional_downgrade_reason).toContain("selected_plan_coupon_or_discount_not_comparable");
  });

  it("generic page-chrome coupon blocks direct but allows directional", () => {
    const result = classifyImprovedCandidate(
      candidate({ page_text_excerpt: "ホテル喜らく 和室プラン 合計(税込) 22,000円 今だけクーポン配布中 セール" })
    );
    expect(result.dp_usage).toBe("directional");
    expect(result.basis_confidence).toBe("B");
    expect(result.direct_downgrade_reason).toContain("page_chrome_coupon_or_discount");
    expect(result.directional_downgrade_reason).toBe("");
  });

  it("price + screenshot + property/date/scope confirmed but soft gap -> directional", () => {
    const result = classifyImprovedCandidate(candidate({ extraction_confidence: "medium", meal_condition: null }));
    expect(result.dp_usage).toBe("directional");
    expect(result.basis_confidence).toBe("B");
  });

  it("does not promote to direct merely because a price is visible", () => {
    const result = classifyImprovedCandidate(candidate({ extraction_confidence: "medium" }));
    expect(result.dp_usage).not.toBe("direct");
  });

  it("no price -> excluded", () => {
    const result = classifyImprovedCandidate(candidate({ price_total_tax_included: null, error_reason: "price_missing" }));
    expect(result.dp_usage).toBe("excluded");
    expect(result.hard_exclusion_reason).toBe("price_missing_or_basis_unclear");
  });

  it("failed -> excluded", () => {
    const result = classifyImprovedCandidate(
      candidate({ availability_status: "failed", price_total_tax_included: null, error_reason: "navigation_failed" })
    );
    expect(result.dp_usage).toBe("excluded");
    expect(result.basis_confidence).toBe("insufficient");
  });

  it("not_found -> excluded", () => {
    const result = classifyImprovedCandidate(
      candidate({ availability_status: "not_found", price_total_tax_included: null, error_reason: "not_found" })
    );
    expect(result.dp_usage).toBe("excluded");
    expect(result.hard_exclusion_reason).toBe("not_found");
  });

  it("sold_out -> excluded", () => {
    const result = classifyImprovedCandidate(
      candidate({ availability_status: "sold_out", price_total_tax_included: null, error_reason: "sold_out" })
    );
    expect(result.dp_usage).toBe("excluded");
    expect(result.hard_exclusion_reason).toBe("sold_out_without_price");
  });

  it("missing screenshot prevents direct and directional (hard)", () => {
    const result = classifyImprovedCandidate(candidate({ screenshot_path: null }));
    expect(result.dp_usage).toBe("excluded");
    expect(result.directional_downgrade_reason).toContain("missing_screenshot");
  });

  it("suspicious price prevents direct and directional", () => {
    const result = classifyImprovedCandidate(candidate({ price_total_tax_included: 1500 }));
    expect(result.dp_usage).toBe("excluded");
    expect(result.directional_downgrade_reason).toContain("suspicious_price");
  });

  it("keeps the three downgrade/exclusion reason fields separate", () => {
    const result = classifyImprovedCandidate(candidate({ extraction_confidence: "medium" }));
    expect(result).toHaveProperty("hard_exclusion_reason");
    expect(result).toHaveProperty("direct_downgrade_reason");
    expect(result).toHaveProperty("directional_downgrade_reason");
    expect(result.direct_downgrade_reason).toContain("extraction_confidence_not_high");
  });

  // Meal-basis hardening (confirmed-policy): priced Jalan rows are DP-usable only
  // when the selected plan is confirmed room-only; meal-included/unknown excluded.
  it("confirmed room-only priced row is DP directional usable", () => {
    const result = classifyImprovedCandidate(candidate({ extraction_confidence: "medium" }));
    expect(result.dp_usage).toBe("directional");
    expect(result.warning_flags).toContain("meal_basis_confirmed_room_only");
  });

  it("meal-included priced row is excluded from DP", () => {
    const result = classifyImprovedCandidate(
      candidate({ plan_name: "【朝食付き】お得プラン", room_or_plan_name: "【朝食付き】お得プラン", meal_condition: "朝食付き", selected_block_text: "【朝食付き】お得プラン 合計(税込) 22,000円 朝食付き", page_text_excerpt: "ホテル喜らく 朝食付き 22,000円" })
    );
    expect(result.dp_usage).toBe("excluded");
    expect(result.source_classification).toBe("jalan_meal_included_excluded");
    expect(result.hard_exclusion_reason).toBe("meal_included_plan_excluded");
    expect(result.warning_flags).toContain("meal_included_plan_excluded");
  });

  it("unknown meal-basis priced row is excluded from DP", () => {
    const result = classifyImprovedCandidate(
      candidate({ plan_name: "シンプルステイ", room_or_plan_name: "シンプルステイ", meal_condition: null, selected_block_text: "シンプルステイ 合計(税込) 22,000円", page_text_excerpt: "ホテル喜らく シンプルステイ 22,000円" })
    );
    expect(result.dp_usage).toBe("excluded");
    expect(result.source_classification).toBe("jalan_unknown_meal_basis_excluded");
    expect(result.hard_exclusion_reason).toBe("unknown_meal_basis_excluded");
  });
});

describe("JALAN-AUTO03B - preview rows, comparison, rescue", () => {
  it("normalized preview row includes required fields", () => {
    const row = previewRow(candidate());
    expect(row.source).toBe("jalan");
    expect(row.source_phase).toBe("JALAN-AUTO03B");
    expect(row.schema_version).toBe("zao_local_history_v1");
    expect(row.collector_stage).toBe("improved_coupon_aware_bounded_preview");
    expect(row.evidence_flags).toBeDefined();
  });

  it("builds AUTO03X vs AUTO03B comparison summary", () => {
    const rows = [previewRow(candidate(), "2026-07-18")];
    const priorRows: Auto03xPriorRow[] = [
      { source_slug_or_code: "yad325153", checkin: "2026-07-18", dp_usage: "excluded", normalized_total_price: 22000 }
    ];
    const comparison = buildAuto03xComparison({ priorRows, rows });
    expect(comparison.auto03x.excluded).toBe(1);
    expect(comparison.auto03b.direct).toBe(1);
  });

  it("rescues prior-excluded rows that are now directional", () => {
    const rows = [previewRow(candidate({ extraction_confidence: "medium", meal_condition: null }), "2026-07-18")];
    const priorRows: Auto03xPriorRow[] = [
      { source_slug_or_code: "yad325153", checkin: "2026-07-18", dp_usage: "excluded", normalized_total_price: 22000 }
    ];
    expect(rows[0]!.dp_usage).toBe("directional");
    const rescued = buildRescuedRows({ priorRows, rows });
    expect(rescued.length).toBe(1);
    const comparison = buildAuto03xComparison({ priorRows, rows });
    expect(comparison.rows_rescued_from_excluded_to_directional).toBe(1);
  });

  it("renders preview CSV with reason and coupon columns", () => {
    const csv = renderImprovedPreviewRowsCsv([previewRow(candidate())]);
    expect(csv).toContain("hard_exclusion_reason");
    expect(csv).toContain("direct_downgrade_reason");
    expect(csv).toContain("directional_downgrade_reason");
    expect(csv).toContain("selected_plan_coupon_or_discount_evidence");
  });
});

describe("JALAN-AUTO03B - decision", () => {
  it("decision ready when all clean and directional present", () => {
    expect(
      decideImproved({ targetCount: 5, rowCount: 5, failedCount: 0, blockedCount: 0, pricedRows: 5, directionalCount: 3, screenshotCount: 5 })
    ).toBe("jalan_bounded_collection_probe_improved_ready");
  });

  it("decision basis_caution when some failures or missing screenshots", () => {
    expect(
      decideImproved({ targetCount: 5, rowCount: 5, failedCount: 1, blockedCount: 0, pricedRows: 4, directionalCount: 2, screenshotCount: 4 })
    ).toBe("jalan_bounded_collection_probe_improved_basis_caution");
  });

  it("decision not_ready when no directional rows", () => {
    expect(
      decideImproved({ targetCount: 5, rowCount: 5, failedCount: 0, blockedCount: 0, pricedRows: 5, directionalCount: 0, screenshotCount: 5 })
    ).toBe("jalan_bounded_collection_probe_improved_not_ready");
  });

  it("decision failed when artifact write fails", () => {
    expect(
      decideImproved({ targetCount: 5, rowCount: 5, failedCount: 0, blockedCount: 0, pricedRows: 5, directionalCount: 3, screenshotCount: 5, artifactWriteFailed: true })
    ).toBe("jalan_bounded_collection_probe_improved_failed");
  });
});

describe("JALAN-AUTO03B - executable safety scans", () => {
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
    expect(SCRIPT_SOURCE).not.toMatch(/proxy|stealth|captchaSolver|puppeteer-extra|cookie/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/serpapi|dataforseo|apify|brightdata|oxylabs/iu);
  });

  it("does not invoke Booking/Rakuten/Google Hotel collection", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/bookingBounded|Booking|rakuten|Rakuten|googleHotels|GoogleHotels/u);
  });

  it("does not apply ASCII pricing multipliers", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/u);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/u);
  });

  it("adds npm script and keeps service free of live browser code", () => {
    expect(PACKAGE_JSON).toContain("\"probe:jalan-bounded-collection-improved\"");
    expect(SERVICE_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch|page\.goto/u);
  });

  it("future AUTO04X plan does not start collection or appends", () => {
    const plan = buildFutureAuto04xPlan();
    expect(plan.forbidden_actions.join(";")).toMatch(/No live collection/u);
    expect(buildSafetyConfirmation().started_auto04x).toBe(false);
  });
});

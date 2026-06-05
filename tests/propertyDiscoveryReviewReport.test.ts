import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERIC_INFORMATIONAL_TERMS,
  PROPERTY_DISCOVERY_REVIEW_CSV_HEADERS,
  assertNoForbiddenColumns,
  buildD04XScopeRecommendation,
  buildReviewRow,
  buildReviewRows,
  containsGenericInformationalTerm,
  countBy,
  d04xAllowedActionFor,
  decideD03X,
  refinedActionFor,
  renderReviewCsv,
  renderReviewReport,
  reviewSeverityFor,
  type D02XInputRow,
  type ReviewRow,
  type ReviewSummary
} from "../src/services/propertyDiscoveryReviewReport";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/propertyDiscoveryReviewReport.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildPropertyDiscoveryReviewReport.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function d02xRow(over: Partial<D02XInputRow>): D02XInputRow {
  return {
    detectedName: "テスト旅館",
    detectedNameRaw: "テスト旅館",
    normalizedDetectedName: "テスト旅館",
    sourceNames: ["jalan_zao_onsen_search"],
    sourceUrls: ["https://www.jalan.net/yad999999/"],
    sourceCount: 1,
    bestSourceConfidence: "B",
    isLodgingLike: true,
    isAreaLikelyZaoOnsen: true,
    matchedExistingName: "",
    matchedCanonicalPropertyName: "",
    matchedEntryType: "",
    matchType: "no_match",
    similarity: 0,
    classification: "new_candidate",
    confidence: "B",
    recommendedAction: "manual_review",
    reason: "no master match",
    needsHumanReview: true,
    detectedAreaHint: "Zao Onsen",
    detectedPropertyTypeHint: "ryokan",
    sourceRowIds: ["jalan_zao_onsen_search:https://www.jalan.net/yad999999/"],
    debugArtifactPath: "/tmp/debug",
    ...over
  };
}

function build(row: D02XInputRow): ReviewRow {
  return buildReviewRow({ runId: "test_run", reviewedAtJst: "2026-06-03T20:00:00+09:00", row });
}

// ---------------------------------------------------------------------------
// 1. Severity mapping per classification
// ---------------------------------------------------------------------------

describe("reviewSeverityFor", () => {
  it("maps active_existing to none", () => {
    expect(reviewSeverityFor(d02xRow({ classification: "active_existing" }))).toBe("none");
  });
  it("maps out_of_scope_candidate to low", () => {
    expect(reviewSeverityFor(d02xRow({ classification: "out_of_scope_candidate" }))).toBe("low");
  });
  it("maps alias_candidate to medium", () => {
    expect(reviewSeverityFor(d02xRow({ classification: "alias_candidate" }))).toBe("medium");
  });
  it("maps duplicate_candidate to high", () => {
    expect(reviewSeverityFor(d02xRow({ classification: "duplicate_candidate" }))).toBe("high");
  });
  it("maps new_candidate to high", () => {
    expect(reviewSeverityFor(d02xRow({ classification: "new_candidate" }))).toBe("high");
  });
  it("maps reopened_candidate to high", () => {
    expect(reviewSeverityFor(d02xRow({ classification: "reopened_candidate" }))).toBe("high");
  });
  it("maps closed_or_inactive_candidate to high (confident) / medium (C)", () => {
    expect(reviewSeverityFor(d02xRow({ classification: "closed_or_inactive_candidate", confidence: "B" }))).toBe("high");
    expect(reviewSeverityFor(d02xRow({ classification: "closed_or_inactive_candidate", confidence: "C" }))).toBe("medium");
  });
  it("maps uncertain_candidate to high when lodging+area else medium", () => {
    expect(
      reviewSeverityFor(d02xRow({ classification: "uncertain_candidate", isLodgingLike: true, isAreaLikelyZaoOnsen: true }))
    ).toBe("high");
    expect(
      reviewSeverityFor(d02xRow({ classification: "uncertain_candidate", isLodgingLike: false, isAreaLikelyZaoOnsen: false }))
    ).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// 2. Generic-term critical rule
// ---------------------------------------------------------------------------

describe("generic informational critical rule", () => {
  it("detects generic terms", () => {
    expect(containsGenericInformationalTerm("蔵王温泉とは")).toBe(true);
    expect(containsGenericInformationalTerm("アクセス案内")).toBe(true);
    expect(containsGenericInformationalTerm("高見屋")).toBe(false);
  });

  it("escalates a generic new_candidate to critical + mark_out_of_scope + warning", () => {
    const r = build(d02xRow({ detectedName: "蔵王温泉とは", classification: "new_candidate" }));
    expect(r.reviewSeverity).toBe("critical");
    expect(r.recommendedActionRefined).toBe("mark_out_of_scope");
    expect(r.d04xAllowedAction).toBe("mark_out_of_scope_after_approval");
    expect(r.warning).toBe("generic informational page/title likely misdetected as property");
    expect(r.needsHumanReview).toBe(true);
  });

  it("does NOT escalate a generic term when classification is not new_candidate", () => {
    const r = build(d02xRow({ detectedName: "蔵王温泉とは", classification: "out_of_scope_candidate" }));
    expect(r.reviewSeverity).toBe("low");
    expect(r.warning).toBe("");
  });

  it("does NOT escalate a non-generic new_candidate", () => {
    const r = build(d02xRow({ detectedName: "新規ロッジ蔵王", classification: "new_candidate" }));
    expect(r.reviewSeverity).toBe("high");
    expect(r.warning).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. Review row schema (26 fields)
// ---------------------------------------------------------------------------

describe("review row schema", () => {
  it("has exactly 26 CSV headers", () => {
    expect(PROPERTY_DISCOVERY_REVIEW_CSV_HEADERS.length).toBe(26);
  });
  it("includes the key review fields", () => {
    const r = build(d02xRow({}));
    for (const key of [
      "reviewSeverity",
      "recommendedActionRefined",
      "warning",
      "d04xAllowedAction",
      "d04xRequiresExplicitApproval",
      "sourceD02xRowRef",
      "debugArtifactPath"
    ]) {
      expect(r).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Descriptive-only D04X action
// ---------------------------------------------------------------------------

describe("d04xAllowedActionFor (descriptive only)", () => {
  it("maps classifications to descriptive after_approval actions", () => {
    expect(d04xAllowedActionFor(d02xRow({ classification: "alias_candidate" }))).toBe("add_alias_after_approval");
    expect(d04xAllowedActionFor(d02xRow({ classification: "new_candidate" }))).toBe("add_new_property_after_approval");
    expect(d04xAllowedActionFor(d02xRow({ classification: "reopened_candidate" }))).toBe("reactivate_after_approval");
    expect(d04xAllowedActionFor(d02xRow({ classification: "duplicate_candidate" }))).toBe("mark_duplicate_after_approval");
    expect(d04xAllowedActionFor(d02xRow({ classification: "closed_or_inactive_candidate" }))).toBe(
      "mark_closed_or_inactive_after_approval"
    );
    expect(d04xAllowedActionFor(d02xRow({ classification: "active_existing" }))).toBe("none");
    expect(d04xAllowedActionFor(d02xRow({ classification: "out_of_scope_candidate" }))).toBe("none");
  });

  it("every D04X allowed action requires explicit approval (or is none)", () => {
    const rows = buildReviewRows({
      runId: "t",
      reviewedAtJst: "x",
      rows: [
        d02xRow({ classification: "alias_candidate" }),
        d02xRow({ classification: "active_existing" })
      ]
    });
    for (const r of rows) {
      if (r.d04xAllowedAction === "none") expect(r.d04xRequiresExplicitApproval).toBe(false);
      else expect(r.d04xRequiresExplicitApproval).toBe(true);
    }
  });

  it("refinedActionFor is review-only and never an execution verb without review/approval framing", () => {
    expect(refinedActionFor(d02xRow({ classification: "active_existing" }))).toBe("keep_existing");
    expect(refinedActionFor(d02xRow({ classification: "alias_candidate" }))).toBe("review_then_add_alias");
    expect(refinedActionFor(d02xRow({ classification: "new_candidate" }))).toBe("review_then_add_new_property");
  });
});

// ---------------------------------------------------------------------------
// 5. D04X scope recommendation (proposal, not executed)
// ---------------------------------------------------------------------------

describe("buildD04XScopeRecommendation", () => {
  it("lists only non-none actions and marks them approval-gated", () => {
    const rows = buildReviewRows({
      runId: "t",
      reviewedAtJst: "x",
      rows: [
        d02xRow({ classification: "alias_candidate", detectedName: "A" }),
        d02xRow({ classification: "active_existing", detectedName: "B" }),
        d02xRow({ classification: "new_candidate", detectedName: "C" })
      ]
    });
    const scope = buildD04XScopeRecommendation(rows);
    expect(scope.requiresExplicitApproval).toBe(true);
    expect(scope.willNotExecuteAutomatically).toBe(true);
    expect(scope.proposedActions.map((p) => p.detectedName).sort()).toEqual(["A", "C"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Decisions
// ---------------------------------------------------------------------------

describe("decideD03X", () => {
  it("not_ready when no rows", () => {
    expect(decideD03X({ reviewRowCount: 0, criticalCount: 0, highCount: 0, humanReviewCount: 0 })).toBe(
      "property_discovery_review_not_ready"
    );
  });
  it("basis_caution when any critical", () => {
    expect(decideD03X({ reviewRowCount: 10, criticalCount: 1, highCount: 0, humanReviewCount: 0 })).toBe(
      "property_discovery_review_basis_caution"
    );
  });
  it("basis_caution when high or human-review items exist", () => {
    expect(decideD03X({ reviewRowCount: 10, criticalCount: 0, highCount: 2, humanReviewCount: 0 })).toBe(
      "property_discovery_review_basis_caution"
    );
    expect(decideD03X({ reviewRowCount: 10, criticalCount: 0, highCount: 0, humanReviewCount: 3 })).toBe(
      "property_discovery_review_basis_caution"
    );
  });
  it("ready when only none/low and no human review", () => {
    expect(decideD03X({ reviewRowCount: 10, criticalCount: 0, highCount: 0, humanReviewCount: 0 })).toBe(
      "property_discovery_review_ready"
    );
  });
});

// ---------------------------------------------------------------------------
// 7. CSV / JSON rendering
// ---------------------------------------------------------------------------

describe("renderReviewCsv", () => {
  it("emits the header and one row per record, with no forbidden tokens", () => {
    const rows = buildReviewRows({
      runId: "t",
      reviewedAtJst: "x",
      rows: [d02xRow({ detectedName: "蔵王温泉とは", classification: "new_candidate" })]
    });
    const csv = renderReviewCsv(rows);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(PROPERTY_DISCOVERY_REVIEW_CSV_HEADERS.join(","));
    expect(lines.length).toBe(2);
    expect(() => assertNoForbiddenColumns(lines[0]!)).not.toThrow();
  });

  it("escapes commas/quotes in fields", () => {
    const rows = buildReviewRows({
      runId: "t",
      reviewedAtJst: "x",
      rows: [d02xRow({ detectedName: "A,B \"C\"", classification: "alias_candidate" })]
    });
    const csv = renderReviewCsv(rows);
    expect(csv).toContain('"A,B ""C"""');
  });
});

// ---------------------------------------------------------------------------
// 8. Report statements: safety / D04X scope / no master update
// ---------------------------------------------------------------------------

function makeSummary(over: Partial<ReviewSummary>): ReviewSummary {
  return {
    runId: "t",
    generatedAt: "2026-06-03T20:00:00+09:00",
    sourceD02xArtifact: "/path/d02x.json",
    reviewRowCount: 1,
    d02xDecision: "property_name_normalization_ready",
    classificationCounts: { new_candidate: 1 },
    reviewSeverityCounts: { critical: 1 },
    recommendedActionRefinedCounts: { mark_out_of_scope: 1 },
    d04xAllowedActionCounts: { mark_out_of_scope_after_approval: 1 },
    criticalCount: 1,
    highCount: 0,
    humanReviewCount: 1,
    warnings: ["蔵王温泉とは: generic informational page/title likely misdetected as property"],
    decision: "property_discovery_review_basis_caution",
    reportPath: "/r.md",
    csvPath: "/r.csv",
    jsonPath: "/r.json",
    debugRootPath: "/debug",
    ...over
  };
}

describe("renderReviewReport", () => {
  const rows = buildReviewRows({
    runId: "t",
    reviewedAtJst: "x",
    rows: [d02xRow({ detectedName: "蔵王温泉とは", classification: "new_candidate" })]
  });
  const report = renderReviewReport({ summary: makeSummary({}), rows });

  it("states D03X did not modify the master", () => {
    expect(report).toContain("D03X did not modify the properties master.");
    expect(report).toContain("D03X did not add aliases.");
    expect(report).toContain("D03X did not active-promote candidates.");
  });
  it("states D04X is the only phase allowed to update the master, only after approval", () => {
    expect(report).toContain("D04X is the ONLY phase that may update the master");
    expect(report).toContain("explicit human approval");
  });
  it("states D03X executed no D04X action", () => {
    expect(report).toContain("D03X did not execute any D04X action");
  });
  it("flags the critical item in the executive summary", () => {
    expect(report).toContain("ATTENTION");
    expect(report).toContain("蔵王温泉とは");
  });
});

// ---------------------------------------------------------------------------
// 9. Human review items + countBy
// ---------------------------------------------------------------------------

describe("human review items", () => {
  it("includes critical and needs-review rows", () => {
    const rows = buildReviewRows({
      runId: "t",
      reviewedAtJst: "x",
      rows: [
        d02xRow({ detectedName: "蔵王温泉とは", classification: "new_candidate" }),
        d02xRow({ classification: "active_existing", needsHumanReview: false })
      ]
    });
    const review = rows.filter((r) => r.needsHumanReview);
    expect(review.length).toBe(1);
    expect(review[0]!.detectedName).toBe("蔵王温泉とは");
  });
  it("countBy tallies severities", () => {
    expect(countBy(["high", "high", "low"])).toEqual({ high: 2, low: 1 });
  });
});

// ---------------------------------------------------------------------------
// 10. Missing-D02X error contract (script)
// ---------------------------------------------------------------------------

describe("missing D02X artifact contract", () => {
  it("script resolves the latest D02X artifact and refuses to re-run collectors when missing", () => {
    expect(SCRIPT_SOURCE).toContain("property_name_normalization_");
    expect(SCRIPT_SOURCE).toContain("Do not re-run collectors.");
  });
});

// ---------------------------------------------------------------------------
// 11. Safety guards: no DB write / no Actions / no Beds24/AirHost/PMS / no paid
// ---------------------------------------------------------------------------

describe("safety guards in source", () => {
  it("service performs no DB writes (no better-sqlite3 / INSERT / UPDATE)", () => {
    expect(SERVICE_SOURCE).not.toMatch(/better-sqlite3/i);
    expect(SERVICE_SOURCE).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(SERVICE_SOURCE).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
  });
  it("neither service nor script enables GitHub Actions / GitOps / commits", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\.github\/workflows/);
      expect(src).not.toMatch(/git\s+commit/);
      expect(src).not.toMatch(/git\s+push/);
    }
  });
  it("CSV header carries no Beds24/AirHost/PMS tokens and the guard throws on them", () => {
    expect(() => assertNoForbiddenColumns(PROPERTY_DISCOVERY_REVIEW_CSV_HEADERS.join(","))).not.toThrow();
    expect(() => assertNoForbiddenColumns("a,beds24_id,b")).toThrow();
    expect(() => assertNoForbiddenColumns("a,airhost_id,b")).toThrow();
    expect(() => assertNoForbiddenColumns("a,pms_upload,b")).toThrow();
  });
  it("neither service nor script contacts paid sources", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs/i);
    }
  });
  it("exposes the generic term list", () => {
    expect(GENERIC_INFORMATIONAL_TERMS).toContain("蔵王温泉とは");
  });
});

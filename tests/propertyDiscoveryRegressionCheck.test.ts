import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROPERTY_DISCOVERY_REGRESSION_CSV_HEADERS,
  buildRegressionRows,
  classifyRegression,
  countRegression,
  decideD05X,
  findExcludedAuditMatch,
  renderRegressionCsv,
  renderRegressionReport,
  replayAfterState,
  type ApprovedD04XItem,
  type BeforeStateRow,
  type ExcludedAuditEntry,
  type RegressionSummary
} from "../src/services/propertyDiscoveryRegressionCheck";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/propertyDiscoveryRegressionCheck.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runPropertyDiscoveryRegressionCheck.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures (mirror the real D04X approved set)
// ---------------------------------------------------------------------------

const AUDIT: ExcludedAuditEntry[] = [
  {
    property_name_raw: "蔵王温泉とは",
    property_url: "https://zaomountainresort.com/about/",
    exclusion_reason: "out_of_scope",
    review_decision: "excluded_out_of_scope"
  },
  {
    property_name_raw: "蔵王温泉について",
    property_url: "https://zaomountainresort.com/about/",
    exclusion_reason: "duplicate",
    review_decision: "excluded_duplicate"
  }
];

const APPROVED: ApprovedD04XItem[] = [
  { detectedName: "蔵王温泉とは", sourceUrl: "https://zaomountainresort.com/about/", approvedAction: "mark_out_of_scope" },
  { detectedName: "蔵王温泉について", sourceUrl: "https://zaomountainresort.com/about/", approvedAction: "mark_duplicate" }
];

const BEFORE: BeforeStateRow[] = [
  {
    detectedName: "蔵王温泉とは",
    sourceUrl: "https://zaomountainresort.com/about/",
    classification: "new_candidate",
    reviewSeverity: "critical",
    d04xAllowedAction: "mark_out_of_scope_after_approval"
  },
  {
    detectedName: "蔵王温泉について",
    sourceUrl: "https://zaomountainresort.com/about/",
    classification: "duplicate_candidate",
    reviewSeverity: "high",
    d04xAllowedAction: "mark_duplicate_after_approval"
  }
];

function rows(over?: { audit?: ExcludedAuditEntry[]; approved?: ApprovedD04XItem[]; before?: BeforeStateRow[] }) {
  return buildRegressionRows({
    runId: "run",
    checkedAtJst: "2026-06-03T20:00:00+09:00",
    approved: over?.approved ?? APPROVED,
    beforeRows: over?.before ?? BEFORE,
    audit: over?.audit ?? AUDIT,
    sourceBeforeArtifact: "before.json",
    sourceAfterArtifactOrReplay: "local_replay:audit.csv",
    debugArtifactPath: "/debug"
  });
}

// ---------------------------------------------------------------------------
// 1-4. Mapping / replay / classification
// ---------------------------------------------------------------------------

describe("replay + classification", () => {
  it("resolves both approved items when present in the updated excluded audit", () => {
    const r = rows();
    expect(r.length).toBe(2);
    expect(r.every((x) => x.regressionStatus === "resolved")).toBe(true);
    expect(r.every((x) => x.resolved)).toBe(true);
    expect(r.every((x) => x.afterD04xAllowedAction === "none")).toBe(true);
  });

  it("maps approved action → expected non-actionable after-classification", () => {
    const r = rows();
    expect(r[0]!.afterClassification).toBe("out_of_scope_candidate");
    expect(r[1]!.afterClassification).toBe("duplicate_candidate_if_audit_covered");
    expect(r[0]!.excludedAuditReviewDecision).toBe("excluded_out_of_scope");
    expect(r[1]!.excludedAuditReviewDecision).toBe("excluded_duplicate");
  });

  it("missing excluded-audit match → still_actionable", () => {
    const r = rows({ audit: [] });
    expect(r.every((x) => x.regressionStatus === "still_actionable")).toBe(true);
    expect(r.every((x) => !x.resolved)).toBe(true);
  });

  it("replay with no audit match re-flags as actionable new_candidate", () => {
    const after = replayAfterState(undefined);
    expect(after.afterClassification).toBe("new_candidate");
    expect(after.afterD04xAllowedAction).toBe("add_new_property_after_approval");
    expect(after.excludedAuditMatchFound).toBe(false);
  });

  it("add_new_property after-state is forbidden (never resolved)", () => {
    const after = replayAfterState(undefined);
    const c = classifyRegression({ before: BEFORE[0]!, after });
    expect(c.resolved).toBe(false);
    expect(c.status).toBe("still_actionable");
  });

  it("audit match present but actionable after-state → unexpected", () => {
    const c = classifyRegression({
      before: BEFORE[0]!,
      after: {
        afterMatchType: "excluded_match",
        afterClassification: "excluded_match",
        afterRecommendedAction: "no_action_excluded",
        afterD04xAllowedAction: "mark_duplicate_after_approval",
        excludedAuditMatchFound: true,
        excludedAuditReviewDecision: "excluded_duplicate"
      }
    });
    expect(c.status).toBe("unexpected");
  });

  it("missing before-state → not_found_in_replay", () => {
    const after = replayAfterState(AUDIT[0]);
    const c = classifyRegression({ before: undefined, after });
    expect(c.status).toBe("not_found_in_replay");
  });

  it("findExcludedAuditMatch matches by NFKC name + url", () => {
    const m = findExcludedAuditMatch(AUDIT, "蔵王温泉とは", "https://zaomountainresort.com/about/");
    expect(m?.review_decision).toBe("excluded_out_of_scope");
    expect(findExcludedAuditMatch(AUDIT, "蔵王温泉とは", "https://other/")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5-7. Schema + summary + table
// ---------------------------------------------------------------------------

describe("schema + summary + table", () => {
  it("CSV has the canonical regression header and no forbidden tokens", () => {
    const csv = renderRegressionCsv(rows());
    const header = csv.split("\n")[0]!;
    expect(header).toBe(PROPERTY_DISCOVERY_REGRESSION_CSV_HEADERS.join(","));
    expect(header.toLowerCase()).not.toMatch(/beds24|airhost|pms_|channel_manager|ota_upload/);
  });

  it("summary counts: resolved=2, still_actionable=0", () => {
    const c = countRegression(rows());
    expect(c.regressionRowCount).toBe(2);
    expect(c.resolvedCount).toBe(2);
    expect(c.stillActionableCount).toBe(0);
    expect(c.notFoundCount).toBe(0);
    expect(c.unexpectedCount).toBe(0);
  });

  it("before/after table renders both items", () => {
    const md = renderRegressionReport({ summary: makeSummary(rows()), rows: rows() });
    expect(md).toContain("## 4. Before vs After Regression Table");
    expect(md).toContain("蔵王温泉とは");
    expect(md).toContain("蔵王温泉について");
    expect(md).toMatch(/before: new_candidate\/critical/);
  });

  it("report contains the explicit no-live-fetch statement", () => {
    const md = renderRegressionReport({ summary: makeSummary(rows()), rows: rows() });
    expect(md).toContain("D05X did not live-fetch external pages.");
    expect(md).toContain("D05X performed a LOCAL artifact replay only.");
  });

  it("report contains safety confirmation block", () => {
    const md = renderRegressionReport({ summary: makeSummary(rows()), rows: rows() });
    expect(md).toContain("## 8. Safety Confirmation");
    expect(md).toContain("D05X did not modify the properties master or any master artifact.");
    expect(md).toContain("D05X did not modify the excluded audit.");
  });
});

// ---------------------------------------------------------------------------
// 8-9. Decision
// ---------------------------------------------------------------------------

describe("decision", () => {
  it("ready when all items resolved", () => {
    expect(decideD05X(countRegression(rows()))).toBe("property_discovery_regression_ready");
  });
  it("basis_caution when >=1 still actionable", () => {
    expect(decideD05X(countRegression(rows({ audit: [] })))).toBe("property_discovery_regression_basis_caution");
  });
  it("not_ready when no regression rows", () => {
    expect(decideD05X(countRegression([]))).toBe("property_discovery_regression_not_ready");
  });
});

// ---------------------------------------------------------------------------
// 10-15. Safety guards in source + runner error paths
// ---------------------------------------------------------------------------

describe("safety guards", () => {
  it("no DB-write code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/better-sqlite3/i);
      expect(src).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(src).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    }
  });

  it("no GitHub Actions/GitOps activation code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\.github\/workflows/);
      expect(src).not.toMatch(/git\s+commit/);
      expect(src).not.toMatch(/git\s+push/);
    }
  });

  it("no Beds24 / AirHost / PMS / OTA export write code exists", () => {
    // The guard token list legitimately contains these terms; assert instead
    // that no fs-write targets a Beds24/AirHost/PMS/OTA artifact.
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync)\s*\([^)]*(beds24|airhost|pms_|channel_manager|ota_upload)/i);
    }
    // Rendered CSV header carries none of the forbidden tokens.
    expect(renderRegressionCsv(rows()).split("\n")[0]!.toLowerCase()).not.toMatch(/beds24|airhost|pms_|channel_manager|ota_upload/);
  });

  it("no live-fetch code exists (no http client / browser automation)", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\b(axios|node-fetch|playwright|puppeteer)\b/i);
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/https?-request|got\(/i);
    }
    // Positive attestation: the script records that no live fetch happened.
    expect(SCRIPT_SOURCE).toContain("liveFetchedExternalPages: false");
  });

  it("does not contact paid sources", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs/i);
    }
  });

  it("does not modify any master artifact (no writes target excluded audit / properties master)", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync)\s*\([^)]*zao_excluded_audit/i);
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync)\s*\([^)]*zao_universe_properties/i);
    }
  });

  it("runner resolves the D01X, D03X, and D04X prefixes and throws Stop-and-report on missing", () => {
    expect(SCRIPT_SOURCE).toContain("property_discovery_inventory_");
    expect(SCRIPT_SOURCE).toContain("property_discovery_review_");
    expect(SCRIPT_SOURCE).toContain("property_master_approved_update_");
    expect(SCRIPT_SOURCE).toMatch(/Stop and report the missing/);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSummary(rs: ReturnType<typeof rows>): RegressionSummary {
  return {
    runId: "run",
    generatedAt: "2026-06-03T20:00:00+09:00",
    sourceD01xArtifact: "inv.json",
    sourceD04xArtifact: "d04x.json",
    sourceBeforeArtifact: "before.json",
    excludedAuditArtifact: "audit.csv",
    liveFetchPerformed: false,
    counts: countRegression(rs),
    decision: decideD05X(countRegression(rs)),
    reportPath: "r.md",
    csvPath: "r.csv",
    jsonPath: "r.json",
    debugRootPath: "/debug"
  };
}

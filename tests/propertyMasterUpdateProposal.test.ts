import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FUTURE_APPROVAL_SENTENCE,
  PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS,
  assertNoForbiddenColumns,
  buildApprovalGate,
  buildProposalRows,
  buildRollbackPlan,
  buildTargetArtifactPlan,
  countBy,
  countNoAction,
  decideD04XP,
  proposedActionFor,
  renderProposalCsv,
  renderProposalReport,
  targetArtifactFor,
  type D03XReviewInputRow,
  type ProposalRow,
  type ProposalSummary
} from "../src/services/propertyMasterUpdateProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/propertyMasterUpdateProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildPropertyMasterUpdateProposal.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function reviewRow(over: Partial<D03XReviewInputRow>): D03XReviewInputRow {
  return {
    detectedName: "テスト旅館",
    normalizedDetectedName: "てすと旅館",
    classification: "active_existing",
    reviewSeverity: "none",
    recommendedActionRefined: "keep_existing",
    d04xAllowedAction: "none",
    matchedCanonicalPropertyName: "",
    matchedEntryType: "",
    matchType: "no_match",
    similarity: 0,
    confidence: "B",
    sourceNames: ["zao_official_stay"],
    sourceUrls: ["https://example.test/p/"],
    sourceCount: 1,
    reason: "reason",
    warning: "",
    needsHumanReview: false,
    sourceD02xRowRef: "zao_official_stay:https://example.test/p/",
    debugArtifactPath: "/tmp/debug",
    ...over
  };
}

const CRITICAL_OOS = reviewRow({
  detectedName: "蔵王温泉とは",
  classification: "new_candidate",
  reviewSeverity: "critical",
  recommendedActionRefined: "mark_out_of_scope",
  d04xAllowedAction: "mark_out_of_scope_after_approval",
  warning: "generic informational page/title likely misdetected as property",
  sourceUrls: ["https://zaomountainresort.com/about/"]
});

const DUP = reviewRow({
  detectedName: "蔵王温泉について",
  classification: "duplicate_candidate",
  reviewSeverity: "high",
  recommendedActionRefined: "mark_duplicate",
  d04xAllowedAction: "mark_duplicate_after_approval",
  sourceUrls: ["https://zaomountainresort.com/about/"]
});

function build(rows: D03XReviewInputRow[]): ProposalRow[] {
  return buildProposalRows({ runId: "run_x", generatedAtJst: "2026-06-03T21:00:00+09:00", rows });
}

// ---------------------------------------------------------------------------
// 1-2. Allowed action → proposal row mapping
// ---------------------------------------------------------------------------

describe("allowed action → proposal row mapping", () => {
  it("mark_out_of_scope_after_approval maps to a proposal row", () => {
    const rows = build([CRITICAL_OOS]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.proposedUpdateAction).toBe("mark_out_of_scope");
    expect(rows[0]!.targetMasterArtifact).toContain("zao_excluded_audit");
  });
  it("mark_duplicate_after_approval maps to a proposal row", () => {
    const rows = build([DUP]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.proposedUpdateAction).toBe("mark_duplicate");
  });
});

// ---------------------------------------------------------------------------
// 3. none rows are no_action
// ---------------------------------------------------------------------------

describe("no_action handling", () => {
  it("none rows are excluded from proposal rows and counted as no_action", () => {
    const all = [reviewRow({}), reviewRow({}), CRITICAL_OOS];
    const rows = build(all);
    expect(rows.length).toBe(1);
    expect(countNoAction(all)).toBe(2);
    expect(proposedActionFor("none")).toBe("no_action");
  });
});

// ---------------------------------------------------------------------------
// 4-5. No unexpected actions for current data
// ---------------------------------------------------------------------------

describe("no unexpected proposals for current data", () => {
  it("a critical generic page is NOT proposed as add_new_property", () => {
    const rows = build([CRITICAL_OOS]);
    expect(rows.every((r) => r.proposedUpdateAction !== "add_new_property")).toBe(true);
  });
  it("no add_alias is proposed when there are no alias_candidate rows", () => {
    const rows = build([CRITICAL_OOS, DUP, reviewRow({})]);
    expect(rows.every((r) => r.proposedUpdateAction !== "add_alias")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6-8. Approval gate
// ---------------------------------------------------------------------------

describe("approval gate", () => {
  it("is closed by default", () => {
    const gate = buildApprovalGate();
    expect(gate.explicitUserApproved).toBe(false);
    expect(gate.realUpdateAllowed).toBe(false);
  });
  it("remains closed even if an env flag is set", () => {
    const gate = buildApprovalGate({ envApprovalFlag: "true" });
    expect(gate.explicitUserApproved).toBe(false);
    expect(gate.realUpdateAllowed).toBe(false);
    expect(gate.envApprovalFlagObserved).toBe("true");
  });
  it("renders the future approval sentence without treating it as approval", () => {
    const gate = buildApprovalGate();
    expect(gate.futureApprovalSentence).toBe(FUTURE_APPROVAL_SENTENCE);
    const report = renderProposalReport({
      summary: makeSummary({}),
      rows: build([CRITICAL_OOS, DUP]),
      approvalGate: gate,
      targetPlan: buildTargetArtifactPlan(build([CRITICAL_OOS, DUP])),
      rollbackPlan: buildRollbackPlan()
    });
    expect(report).toContain(FUTURE_APPROVAL_SENTENCE);
    expect(report).toContain("NOT active approval");
    expect(report).toContain("real_update_allowed=false");
  });
});

// ---------------------------------------------------------------------------
// 9. Proposal row schema
// ---------------------------------------------------------------------------

describe("proposal row schema", () => {
  it("has the documented CSV headers", () => {
    expect(PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS).toContain("proposal_id");
    expect(PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS).toContain("proposed_update_action");
    expect(PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS).toContain("target_master_artifact");
    expect(PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS).toContain("requires_explicit_approval");
    expect(PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS).toContain("real_update_allowed");
    expect(PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS).toContain("rollback_strategy");
  });
  it("populates required row fields with approval-gated values", () => {
    const r = build([CRITICAL_OOS])[0]!;
    expect(r.proposalId).toMatch(/run_x_p001/);
    expect(r.requiresExplicitApproval).toBe(true);
    expect(r.realUpdateAllowed).toBe(false);
    expect(r.sourceD03xRowRef).toContain("zao_official_stay");
    expect(r.debugArtifactPath).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 10. Target artifact plan is descriptive only
// ---------------------------------------------------------------------------

describe("target artifact plan", () => {
  it("is descriptive only and never modifies in this phase", () => {
    const plan = buildTargetArtifactPlan(build([CRITICAL_OOS, DUP]));
    expect(plan.length).toBeGreaterThan(0);
    for (const entry of plan) {
      expect(entry.willBeModifiedInThisPhase).toBe(false);
      expect(entry.targetMasterArtifact).toBeTruthy();
    }
    expect(targetArtifactFor("mark_out_of_scope")).toContain("zao_excluded_audit");
  });
});

// ---------------------------------------------------------------------------
// 11. Rollback plan
// ---------------------------------------------------------------------------

describe("rollback plan", () => {
  it("includes backups, temp files, atomic rename, and restore", () => {
    const plan = buildRollbackPlan();
    expect(plan.backupsCreatedInThisPhase).toBe(false);
    const joined = plan.futureRealUpdateSteps.join(" ").toLowerCase();
    expect(joined).toContain("backup");
    expect(joined).toContain("temp");
    expect(joined).toContain("atomic rename");
    expect(joined).toContain("restore");
  });
});

// ---------------------------------------------------------------------------
// 12-15. Report + CSV + JSON content
// ---------------------------------------------------------------------------

function makeSummary(over: Partial<ProposalSummary>): ProposalSummary {
  return {
    runId: "run_x",
    generatedAt: "2026-06-03T21:00:00+09:00",
    sourceD03xArtifact: "/path/d03x.json",
    d03xDecision: "property_discovery_review_basis_caution",
    reviewRowCount: 80,
    proposalRowCount: 2,
    noActionCount: 78,
    proposedActionCounts: { mark_out_of_scope: 1, mark_duplicate: 1 },
    unresolvedCriticalCount: 1,
    explicitUserApproved: false,
    realUpdateAllowed: false,
    warnings: ["蔵王温泉とは: generic informational page/title likely misdetected as property"],
    decision: "property_master_update_proposal_basis_caution",
    reportPath: "/r.md",
    csvPath: "/r.csv",
    jsonPath: "/r.json",
    debugRootPath: "/debug",
    ...over
  };
}

describe("report content", () => {
  const rows = build([CRITICAL_OOS, DUP]);
  const report = renderProposalReport({
    summary: makeSummary({}),
    rows,
    approvalGate: buildApprovalGate(),
    targetPlan: buildTargetArtifactPlan(rows),
    rollbackPlan: buildRollbackPlan()
  });
  it("states no master update occurred", () => {
    expect(report).toContain("D04X-P did not modify properties master.");
    expect(report).toContain("D04X-P did not add aliases.");
    expect(report).toContain("D04X-P did not active-promote any property.");
    expect(report).toContain("D04X-P did not add price collection targets.");
    expect(report).toContain("D04X-P did not write DB.");
    expect(report).toContain("D04X-P did not modify .data/history.");
  });
});

describe("CSV + JSON content", () => {
  it("CSV renderer includes the proposal schema header and a row per proposal", () => {
    const rows = build([CRITICAL_OOS, DUP]);
    const csv = renderProposalCsv(rows);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS.join(","));
    expect(lines.length).toBe(3);
  });
  it("countBy tallies proposed action counts for JSON summary", () => {
    const rows = build([CRITICAL_OOS, DUP]);
    expect(countBy(rows.map((r) => r.proposedUpdateAction))).toEqual({ mark_out_of_scope: 1, mark_duplicate: 1 });
  });
});

// ---------------------------------------------------------------------------
// 16-18. Safety guards in source
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
  it("no Beds24/AirHost/PMS columns; guard throws on them", () => {
    expect(() => assertNoForbiddenColumns(PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS.join(","))).not.toThrow();
    expect(() => assertNoForbiddenColumns("a,beds24_id,b")).toThrow();
    expect(() => assertNoForbiddenColumns("a,airhost_id,b")).toThrow();
    expect(() => assertNoForbiddenColumns("a,pms_upload,b")).toThrow();
  });
  it("does not contact paid sources", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 19. Missing D03X artifact contract (script)
// ---------------------------------------------------------------------------

describe("missing D03X artifact contract", () => {
  it("script resolves the latest D03X artifact and refuses to re-run collectors when missing", () => {
    expect(SCRIPT_SOURCE).toContain("property_discovery_review_");
    expect(SCRIPT_SOURCE).toContain("Do not re-run collectors.");
  });
});

// ---------------------------------------------------------------------------
// 20. Decisions
// ---------------------------------------------------------------------------

describe("decideD04XP", () => {
  it("not_ready when D03X artifact not loaded", () => {
    expect(decideD04XP({ d03xArtifactLoaded: false, proposalRowCount: 2, realUpdateAllowed: false, unresolvedCriticalCount: 0 })).toBe(
      "property_master_update_proposal_not_ready"
    );
  });
  it("not_ready when realUpdateAllowed unexpectedly true", () => {
    expect(decideD04XP({ d03xArtifactLoaded: true, proposalRowCount: 2, realUpdateAllowed: true, unresolvedCriticalCount: 0 })).toBe(
      "property_master_update_proposal_not_ready"
    );
  });
  it("basis_caution when unresolved critical remains", () => {
    expect(decideD04XP({ d03xArtifactLoaded: true, proposalRowCount: 2, realUpdateAllowed: false, unresolvedCriticalCount: 1 })).toBe(
      "property_master_update_proposal_basis_caution"
    );
  });
  it("ready when proposal rows generated and gate closed with no unresolved critical", () => {
    expect(decideD04XP({ d03xArtifactLoaded: true, proposalRowCount: 2, realUpdateAllowed: false, unresolvedCriticalCount: 0 })).toBe(
      "property_master_update_proposal_ready"
    );
  });
});

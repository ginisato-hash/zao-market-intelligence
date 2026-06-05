import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPRECATE_CANONICAL,
  MATSUKANEYA_CSV_HEADERS,
  RETAIN_CANONICAL,
  buildApprovalGate,
  buildMergePlan,
  buildProposalRows,
  decideMatsukaneya,
  hasIndependentCrossSourceCorroboration,
  renderProposalCsv,
  renderProposalReport,
  type ConfirmedDuplicateGroup,
  type ProposalContext,
  type ProposalSummary,
  type SourceCandidateRow,
  type UniverseRow
} from "../src/services/matsukaneyaCanonicalMergeProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/matsukaneyaCanonicalMergeProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildMatsukaneyaCanonicalMergeProposal.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures — mirror the real read-only master rows.
// ---------------------------------------------------------------------------

const RETAIN_ROW: UniverseRow = {
  canonicalPropertyName: RETAIN_CANONICAL,
  canonicalizationStatus: "needs_review",
  aliases: ["蔵王温泉 ホテル松金屋アネックス"],
  sourcesPresent: ["rakuten"],
  jalanUrl: "",
  jalanId: "",
  rakutenUrl: "https://travel.rakuten.co.jp/HOTEL/5097/",
  rakutenId: "5097",
  evidenceNote: "Canonicalized from rakuten via single_source."
};

const DEPRECATE_ROW: UniverseRow = {
  canonicalPropertyName: DEPRECATE_CANONICAL,
  canonicalizationStatus: "needs_review",
  aliases: ["蔵王温泉 松金や －MATSUKANEYA ANNEX－"],
  sourcesPresent: ["jalan"],
  jalanUrl: "https://www.jalan.net/yad335940/",
  jalanId: "335940",
  rakutenUrl: "",
  rakutenId: "",
  evidenceNote: "Canonicalized from jalan via single_source."
};

const RETAIN_CANDS: SourceCandidateRow[] = [
  { canonicalPropertyName: RETAIN_CANONICAL, source: "rakuten", candidatePropertyUrl: "https://travel.rakuten.co.jp/HOTEL/5097/", candidateSourcePropertyId: "5097", verificationStatus: "needs_review" },
  { canonicalPropertyName: RETAIN_CANONICAL, source: "jalan", candidatePropertyUrl: "", candidateSourcePropertyId: "", verificationStatus: "candidate" }
];

const DEPRECATE_CANDS: SourceCandidateRow[] = [
  { canonicalPropertyName: DEPRECATE_CANONICAL, source: "jalan", candidatePropertyUrl: "https://www.jalan.net/yad335940/", candidateSourcePropertyId: "335940", verificationStatus: "needs_review" },
  { canonicalPropertyName: DEPRECATE_CANONICAL, source: "rakuten", candidatePropertyUrl: "", candidateSourcePropertyId: "", verificationStatus: "candidate" }
];

const GROUP: ConfirmedDuplicateGroup = {
  groupId: "matsukaneya_annex_zao",
  userConfirmedSameProperty: true,
  retain: RETAIN_ROW,
  deprecate: DEPRECATE_ROW,
  retainCandidates: RETAIN_CANDS,
  deprecateCandidates: DEPRECATE_CANDS
};

const CTX: ProposalContext = {
  runId: "run",
  generatedAtJst: "2026-06-03T20:00:00+09:00",
  debugArtifactPath: "/debug"
};

function rows() {
  return buildProposalRows(GROUP, CTX);
}

// ---------------------------------------------------------------------------
// 1-4. Confirmed same-property + roles
// ---------------------------------------------------------------------------

describe("confirmed duplicate group", () => {
  it("treats the group as user-confirmed same physical property", () => {
    for (const r of rows()) {
      expect(r.userConfirmedSamePhysicalProperty).toBe(true);
      expect(r.samePropertyStatus).toBe("confirmed_same_property");
    }
  });

  it("uses no suspected/uncertain same-vs-different classification language", () => {
    for (const r of rows()) {
      expect(r.samePropertyStatus).not.toMatch(/suspected|uncertain|maybe|possible/i);
    }
  });

  it("retains ホテル松金屋アネックス as the canonical", () => {
    const retain = rows().find((r) => r.proposedRole === "retain_canonical");
    expect(retain?.candidateName).toBe(RETAIN_CANONICAL);
    expect(rows().every((r) => r.canonicalName === RETAIN_CANONICAL)).toBe(true);
  });

  it("deprecates/aliases 松金や －MATSUKANEYA ANNEX－", () => {
    const dep = rows().find((r) => r.proposedRole === "deprecate_duplicate");
    expect(dep?.candidateName).toBe(DEPRECATE_CANONICAL);
    expect(dep?.proposedAction).toMatch(/merge_into_retained_canonical_and_mark_deprecated_alias_not_deleted/);
  });
});

// ---------------------------------------------------------------------------
// 5-8. Merge plan (proposal only, IDs preserved)
// ---------------------------------------------------------------------------

describe("merge plan", () => {
  it("proposes alias additions without executing them", () => {
    const plan = buildMergePlan(GROUP);
    expect(plan.proposedAliasesForRetained).toContain(DEPRECATE_CANONICAL);
    expect(plan.proposedAliasesForRetained).toContain("Matsukaneya Annex");
    // Plan is a description, not an applied mutation: no fs-write in the service.
    expect(SERVICE_SOURCE).not.toMatch(/writeFileSync|appendFileSync|renameSync/);
  });

  it("preserves the Rakuten hotelNo 5097", () => {
    const plan = buildMergePlan(GROUP);
    expect(plan.preservedSourceIds.rakutenHotelNo).toBe("5097");
    expect(rows().find((r) => r.proposedRole === "retain_canonical")?.rakutenHotelNo).toBe("5097");
  });

  it("preserves the Jalan yad id 335940", () => {
    const plan = buildMergePlan(GROUP);
    expect(plan.preservedSourceIds.jalanYadId).toBe("335940");
    expect(rows().find((r) => r.proposedRole === "deprecate_duplicate")?.jalanYadId).toBe("335940");
  });

  it("repoints source candidates from BOTH records to the retained canonical", () => {
    const plan = buildMergePlan(GROUP);
    expect(plan.sourceCandidateRepoint.every((rp) => rp.toCanonical === RETAIN_CANONICAL)).toBe(true);
    const fromSet = new Set(plan.sourceCandidateRepoint.map((rp) => rp.fromCanonical));
    expect(fromSet.has(RETAIN_CANONICAL)).toBe(true);
    expect(fromSet.has(DEPRECATE_CANONICAL)).toBe(true);
    expect(plan.deprecatedRecordDisposition).toBe("marked_duplicate_deprecated_not_deleted");
  });
});

// ---------------------------------------------------------------------------
// 9-11. Approval gate stays closed
// ---------------------------------------------------------------------------

describe("approval gate", () => {
  it("requires explicit approval on every row", () => {
    expect(rows().every((r) => r.requiresExplicitApproval === true)).toBe(true);
  });

  it("keeps real_update_allowed=false everywhere", () => {
    expect(rows().every((r) => r.realUpdateAllowed === false)).toBe(true);
    const gate = buildApprovalGate();
    expect(gate.realUpdateAllowed).toBe(false);
    expect(gate.explicitUserApprovedForRealMerge).toBe(false);
    expect(gate.gateState).toBe("closed");
  });

  it("renders the future approval sentence without treating it as active approval", () => {
    const gate = buildApprovalGate();
    expect(gate.futureApprovalSentence).toBe(
      "Approve Phase PD-FIX02X Matsukaneya canonical merge. You may merge 松金や －MATSUKANEYA ANNEX－ into ホテル松金屋アネックス and update the approved master artifacts."
    );
    const md = renderProposalReport({ summary: makeSummary(), rows: rows(), plan: buildMergePlan(GROUP) });
    expect(md).toContain(gate.futureApprovalSentence);
    expect(md).toContain("approval gate is CLOSED");
  });
});

// ---------------------------------------------------------------------------
// 12-16. No forbidden side effects in source
// ---------------------------------------------------------------------------

describe("no forbidden side effects", () => {
  it("has no real merge / master-mutation script", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync)\s*\([^)]*zao_universe_properties/);
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync)\s*\([^)]*zao_alias_map/);
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync)\s*\([^)]*zao_source_candidates/);
    }
  });

  it("does not write .data/history", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync)\s*\([^)]*\.data\/history/);
    }
    expect(SCRIPT_SOURCE).toContain("modifiedDataHistory: false");
  });

  it("has no DB-write code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/better-sqlite3/i);
      expect(src).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(src).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    }
    expect(SCRIPT_SOURCE).toContain("dbWrites: false");
  });

  it("has no GitHub Actions/GitOps/commit/push code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\.github\/workflows/);
      expect(src).not.toMatch(/git\s+commit/);
      expect(src).not.toMatch(/git\s+push/);
    }
    expect(SCRIPT_SOURCE).toContain("githubActionsOrGitOps: false");
  });

  it("has no live-fetch / paid-source code and does not recompute Demand Index", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\b(axios|node-fetch|playwright|puppeteer)\b/i);
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs/i);
    }
    expect(SCRIPT_SOURCE).toContain("recomputedDemandIndex: false");
  });
});

// ---------------------------------------------------------------------------
// 17. Output column safety (no PMS/Beds24/per-room/demand-index columns)
// ---------------------------------------------------------------------------

describe("output column safety", () => {
  it("does not include PMS/Beds24/per-room/demand-index columns", () => {
    const header = MATSUKANEYA_CSV_HEADERS.join(",").toLowerCase();
    for (const token of ["roomid", "minstay", "maxstay", "multiplier", "price1", "price2", "beds24", "airhost", "demand_index"]) {
      expect(header).not.toContain(token);
    }
    expect(renderProposalCsv(rows()).split("\n")[0]!.toLowerCase()).not.toMatch(/roomid|minstay|maxstay|multiplier|price1|beds24|airhost|demand_index/);
  });
});

// ---------------------------------------------------------------------------
// 18. Decision + corroboration
// ---------------------------------------------------------------------------

describe("decision", () => {
  it("flags basis_caution when sources are complementary (no independent corroboration)", () => {
    expect(hasIndependentCrossSourceCorroboration(GROUP)).toBe(false);
    expect(
      decideMatsukaneya({ proposalRowCount: 2, userConfirmedSameProperty: true, hasIndependentCrossSourceCorroboration: false })
    ).toBe("matsukaneya_canonical_merge_proposal_basis_caution");
  });

  it("is ready or basis_caution whenever a proposal is generated", () => {
    const decision = decideMatsukaneya({
      proposalRowCount: rows().length,
      userConfirmedSameProperty: true,
      hasIndependentCrossSourceCorroboration: hasIndependentCrossSourceCorroboration(GROUP)
    });
    expect(["matsukaneya_canonical_merge_proposal_ready", "matsukaneya_canonical_merge_proposal_basis_caution"]).toContain(decision);
  });

  it("is not_ready when there is no proposal row", () => {
    expect(
      decideMatsukaneya({ proposalRowCount: 0, userConfirmedSameProperty: true, hasIndependentCrossSourceCorroboration: false })
    ).toBe("matsukaneya_canonical_merge_proposal_not_ready");
  });

  it("is ready when a single source independently corroborates both records", () => {
    expect(
      decideMatsukaneya({ proposalRowCount: 2, userConfirmedSameProperty: true, hasIndependentCrossSourceCorroboration: true })
    ).toBe("matsukaneya_canonical_merge_proposal_ready");
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSummary(): ProposalSummary {
  return {
    runId: "run",
    generatedAt: "2026-06-03T20:00:00+09:00",
    groupId: "matsukaneya_annex_zao",
    userConfirmedSameProperty: true,
    sourceArtifacts: ["u.csv"],
    proposalRowCount: 2,
    retainCanonical: RETAIN_CANONICAL,
    deprecateCanonical: DEPRECATE_CANONICAL,
    decision: "matsukaneya_canonical_merge_proposal_basis_caution",
    gate: buildApprovalGate(),
    reportPath: "r.md",
    csvPath: "r.csv",
    jsonPath: "r.json",
    debugRootPath: "/debug"
  };
}

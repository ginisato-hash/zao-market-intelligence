import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVED_PROPOSAL_ROWS,
  EXCLUDED_AUDIT_HEADERS,
  TARGET_EXCLUDED_AUDIT_RELPATH,
  appendAuditRows,
  auditRowKey,
  backupPathFor,
  decideD04X,
  evaluateApprovalGate,
  mapProposalToAuditRow,
  parseCsv,
  preflightProposal,
  renderCsv,
  validateAuditCsv,
  type AuditRow,
  type PreflightProposalRow
} from "../src/services/propertyMasterApprovedUpdate";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/propertyMasterApprovedUpdate.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runPropertyMasterApprovedUpdate.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function proposalRow(over: Partial<PreflightProposalRow>): PreflightProposalRow {
  return {
    detectedName: "蔵王温泉とは",
    proposedUpdateAction: "mark_out_of_scope",
    targetMasterArtifact: ".data/exports/zao-universe-review/zao_excluded_audit_20260531_231933.csv",
    targetRecordKey: "https://zaomountainresort.com/about/",
    requiresExplicitApproval: true,
    ...over
  };
}

const APPROVED_TWO: PreflightProposalRow[] = [
  proposalRow({}),
  proposalRow({
    detectedName: "蔵王温泉について",
    proposedUpdateAction: "mark_duplicate"
  })
];

// ---------------------------------------------------------------------------
// 1-2. Approval gate
// ---------------------------------------------------------------------------

describe("approval gate", () => {
  it("is closed without the env flag even with explicit approval", () => {
    const gate = evaluateApprovalGate({ explicitUserApproved: true, envFlag: undefined });
    expect(gate.realUpdateAllowed).toBe(false);
  });
  it("is open only with explicit approval AND env flag = 1", () => {
    expect(evaluateApprovalGate({ explicitUserApproved: true, envFlag: "1" }).realUpdateAllowed).toBe(true);
    expect(evaluateApprovalGate({ explicitUserApproved: false, envFlag: "1" }).realUpdateAllowed).toBe(false);
    expect(evaluateApprovalGate({ explicitUserApproved: true, envFlag: "0" }).realUpdateAllowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3-7. Preflight
// ---------------------------------------------------------------------------

describe("preflight", () => {
  it("passes for exactly the two approved rows", () => {
    expect(preflightProposal(APPROVED_TWO).ok).toBe(true);
  });
  it("fails when an unexpected extra action is present", () => {
    const r = preflightProposal([...APPROVED_TWO, proposalRow({ detectedName: "X", proposedUpdateAction: "mark_closed_or_inactive" })]);
    expect(r.ok).toBe(false);
  });
  it("blocks add_new_property", () => {
    const r = preflightProposal([proposalRow({ proposedUpdateAction: "add_new_property" }), proposalRow({ detectedName: "蔵王温泉について", proposedUpdateAction: "mark_duplicate" })]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/add_new_property/);
  });
  it("blocks add_alias", () => {
    const r = preflightProposal([proposalRow({ proposedUpdateAction: "add_alias" }), proposalRow({ detectedName: "蔵王温泉について", proposedUpdateAction: "mark_duplicate" })]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/add_alias/);
  });
  it("requires the target artifact to be the excluded audit path", () => {
    const r = preflightProposal([
      proposalRow({ targetMasterArtifact: "zao_universe_properties_20260531_231933.csv" }),
      proposalRow({ detectedName: "蔵王温泉について", proposedUpdateAction: "mark_duplicate" })
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/Target artifact mismatch/);
  });
});

// ---------------------------------------------------------------------------
// 8. Backup path
// ---------------------------------------------------------------------------

describe("backup path", () => {
  it("is generated under the universe-review .backup dir with the timestamp", () => {
    const p = backupPathFor("20260603_200000");
    expect(p).toBe(".data/exports/zao-universe-review/.backup/20260603_200000/zao_excluded_audit_20260531_231933.csv.bak");
  });
});

// ---------------------------------------------------------------------------
// 9. Idempotent append
// ---------------------------------------------------------------------------

describe("appendAuditRows", () => {
  const newRows = APPROVED_PROPOSAL_ROWS.map((r) => mapProposalToAuditRow(r));

  it("appends when not present", () => {
    const r = appendAuditRows({ existingRows: [], newRows });
    expect(r.appended.length).toBe(2);
    expect(r.skippedExisting.length).toBe(0);
  });
  it("does not duplicate existing audit rows", () => {
    const r = appendAuditRows({ existingRows: newRows, newRows });
    expect(r.appended.length).toBe(0);
    expect(r.skippedExisting.length).toBe(2);
    expect(r.merged.length).toBe(2);
  });
  it("dedup key uses name + url + reason", () => {
    expect(auditRowKey(newRows[0]!)).toContain("蔵王温泉とは");
    expect(auditRowKey(newRows[0]!)).toContain("out_of_scope");
  });
});

// ---------------------------------------------------------------------------
// 12-13. CSV header preserved + row content mapping
// ---------------------------------------------------------------------------

describe("CSV header + mapping", () => {
  it("preserves the existing excluded-audit header on render", () => {
    const rows = APPROVED_PROPOSAL_ROWS.map((r) => mapProposalToAuditRow(r));
    const csv = renderCsv([...EXCLUDED_AUDIT_HEADERS], rows);
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual([...EXCLUDED_AUDIT_HEADERS]);
    expect(parsed.rows.length).toBe(2);
  });
  it("maps mark_out_of_scope and mark_duplicate to correct audit content", () => {
    const oos = mapProposalToAuditRow(APPROVED_PROPOSAL_ROWS[0]!);
    expect(oos["property_name_raw"]).toBe("蔵王温泉とは");
    expect(oos["exclusion_reason"]).toBe("out_of_scope");
    expect(oos["review_decision"]).toBe("excluded_out_of_scope");
    expect(oos["human_review_required"]).toBe("false");

    const dup = mapProposalToAuditRow(APPROVED_PROPOSAL_ROWS[1]!);
    expect(dup["property_name_raw"]).toBe("蔵王温泉について");
    expect(dup["exclusion_reason"]).toBe("duplicate");
    expect(dup["review_decision"]).toBe("excluded_duplicate");
  });
});

// ---------------------------------------------------------------------------
// 11. Rollback semantics via decision
// ---------------------------------------------------------------------------

describe("rollback + decision", () => {
  it("rolled-back failure surfaces as failed_rolled_back", () => {
    expect(
      decideD04X({ realUpdateAllowed: true, preflightOk: true, wrote: false, appended: 0, skippedExisting: 0, rolledBack: true, rollbackFailed: false })
    ).toBe("property_master_update_failed_rolled_back");
  });
  it("rollback failure surfaces as manual_recovery_required", () => {
    expect(
      decideD04X({ realUpdateAllowed: true, preflightOk: true, wrote: false, appended: 0, skippedExisting: 0, rolledBack: true, rollbackFailed: true })
    ).toBe("property_master_update_failed_manual_recovery_required");
  });
});

// ---------------------------------------------------------------------------
// 14-19. Safety guards in source
// ---------------------------------------------------------------------------

describe("safety guards", () => {
  it("no active-promotion / no alias-update / no price-target write code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/canonicalization_status\s*=\s*["']canonical/i);
      expect(src).not.toMatch(/alias_map_20260531_231933\.json/);
      expect(src).not.toMatch(/zao_universe_properties_20260531_231933\.csv/);
      // No write into a price-collection-targets artifact (mutation), only an attestation it didn't.
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync)\s*\([^)]*price/i);
    }
    // Script positively attests it added no price collection targets.
    expect(SCRIPT_SOURCE).toContain("addedPriceCollectionTargets: false");
  });
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
  it("no .data/history modification code exists", () => {
    // .data/history may appear only in the safety attestation prose, never as a write target.
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|appendFileSync|renameSync|copyFileSync|rmSync)\s*\([^)]*\.data\/history/);
    }
    expect(SCRIPT_SOURCE).toContain("modifiedDataHistory: false");
  });
  it("only the excluded audit artifact is targeted", () => {
    expect(TARGET_EXCLUDED_AUDIT_RELPATH).toContain("zao_excluded_audit_20260531_231933.csv");
    expect(SERVICE_SOURCE).not.toMatch(/zao_universe_properties_20260531_231933\.csv/);
  });
  it("does not contact paid sources", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 20. Success decision
// ---------------------------------------------------------------------------

describe("success decision", () => {
  it("ready_not_run when gate closed", () => {
    expect(
      decideD04X({ realUpdateAllowed: false, preflightOk: true, wrote: false, appended: 0, skippedExisting: 0, rolledBack: false, rollbackFailed: false })
    ).toBe("property_master_update_ready_not_run");
  });
  it("failed_preflight when gate open but preflight fails", () => {
    expect(
      decideD04X({ realUpdateAllowed: true, preflightOk: false, wrote: false, appended: 0, skippedExisting: 0, rolledBack: false, rollbackFailed: false })
    ).toBe("property_master_update_failed_preflight");
  });
  it("success when wrote", () => {
    expect(
      decideD04X({ realUpdateAllowed: true, preflightOk: true, wrote: true, appended: 2, skippedExisting: 0, rolledBack: false, rollbackFailed: false })
    ).toBe("property_master_update_success");
  });
  it("success when both rows already present (appended 0, skipped 2)", () => {
    expect(
      decideD04X({ realUpdateAllowed: true, preflightOk: true, wrote: false, appended: 0, skippedExisting: 2, rolledBack: false, rollbackFailed: false })
    ).toBe("property_master_update_success");
  });
  it("validateAuditCsv passes for the canonical header", () => {
    const rows = APPROVED_PROPOSAL_ROWS.map((r) => mapProposalToAuditRow(r));
    expect(validateAuditCsv({ headers: [...EXCLUDED_AUDIT_HEADERS], rows }).ok).toBe(true);
    expect(validateAuditCsv({ headers: ["wrong"], rows }).ok).toBe(false);
  });
});

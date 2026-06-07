import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscoveryReviewPack, DiscoveryReviewRow } from "../src/services/propertyDiscoveryReview";
import {
  buildAuditRow,
  buildPropertyDiscoveryAuditPack,
  parseReviewPackJson,
  renderPropertyDiscoveryAuditCsv,
  renderPropertyDiscoveryAuditJson,
  renderPropertyDiscoveryAuditMarkdown,
  selectLatestReviewPackArtifact
} from "../src/services/propertyDiscoveryAudit";

const ROOT = resolve(__dirname, "..");
const SERVICE_SOURCE = readFileSync(resolve(ROOT, "src/services/propertyDiscoveryAudit.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(ROOT, "src/scripts/runPropertyDiscoveryAudit.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(ROOT, "package.json"), "utf8");

function reviewRow(over: Partial<DiscoveryReviewRow>): DiscoveryReviewRow {
  return {
    candidate_name: "テストホテル",
    normalized_name: "テストホテル",
    classification: "new_candidate",
    confidence: 0.82,
    matched_existing_property: "",
    matched_existing_key: "",
    recommended_action_from_discovery: "approve_new",
    suggested_human_decision: "approve_new",
    decision_confidence: "medium",
    review_priority: "high",
    collector_readiness: "needs_mapping",
    source_evidence_count: 1,
    source_evidence_summary: "lodging-like name candidate",
    reason_codes: ["lodging_name_candidate", "no_existing_match"],
    decision_reason: "Lodging-like candidate.",
    required_next_step: "add inactive first",
    human_decision: "",
    human_notes: "",
    ...over
  };
}

function reviewPack(rows: DiscoveryReviewRow[]): DiscoveryReviewPack {
  return {
    decision: "auto_runner_discovery02_review_pack_ready",
    run_id: "review_fixture",
    generated_at_jst: "2026-06-08T08:00:00+09:00",
    input_artifact_path: "property_discovery_fixture.json",
    mode: "dry_run_review_pack",
    rows,
    summary: {
      total_candidates: rows.length,
      suggested_decision_counts: {},
      collector_readiness_counts: {},
      review_priority_counts: {},
      high_priority_review_count: 0,
      d05_ready: false,
      d05_reason: "waiting_for_human_decisions",
      safety_confirmation: {
        network_collection_executed: false,
        live_collector_run: false,
        history_modified: false,
        db_synced: false,
        ai_context_refreshed: false,
        property_master_written: false,
        collector_target_updated: false,
        pricing_or_pms_output_generated: false
      }
    },
    next_recommended_action: "Fill human_decision and human_notes, then run D05 approved properties master update."
  };
}

describe("AUTO-RUNNER-DISCOVERY03 property discovery audit pack", () => {
  it("duplicate -> already_covered_duplicate / reject_duplicate", () => {
    const r = buildAuditRow(reviewRow({ classification: "duplicate_candidate", suggested_human_decision: "reject_duplicate", matched_existing_property: "蔵王国際ホテル" }));
    expect(r.audit_group).toBe("already_covered_duplicate");
    expect(r.recommended_next_human_action).toBe("reject_duplicate");
    expect(r.active_readiness_stage).toBe("already_covered");
    expect(r.d05_blocker).toBe("none");
  });

  it("alias -> alias_review / approve_alias_after_review", () => {
    const r = buildAuditRow(reviewRow({ classification: "alias_candidate", suggested_human_decision: "approve_alias", matched_existing_property: "深山荘 高見屋" }));
    expect(r.audit_group).toBe("alias_review");
    expect(r.recommended_next_human_action).toBe("approve_alias_after_review");
    expect(r.d05_blocker).toBe("missing_human_decision");
  });

  it("alias without matched existing property is high risk", () => {
    const r = buildAuditRow(reviewRow({ classification: "alias_candidate", suggested_human_decision: "approve_alias", matched_existing_property: "" }));
    expect(r.approval_risk).toBe("high");
    expect(r.d05_blocker).toBe("missing_existing_match_for_alias");
  });

  it("approve_new lodging-like -> ready_to_review_for_new_property", () => {
    const r = buildAuditRow(reviewRow({ candidate_name: "蔵王テストホテル" }));
    expect(r.audit_group).toBe("ready_to_review_for_new_property");
    expect(r.recommended_next_human_action).toBe("approve_new_after_review");
    expect(r.active_readiness_stage).toBe("needs_collector_mapping");
  });

  it("approve_new uncertain -> still not active-ready", () => {
    const r = buildAuditRow(reviewRow({ candidate_name: "ぼくのうち", suggested_human_decision: "approve_new" }));
    expect(r.recommended_next_human_action).toBe("approve_new_after_review");
    expect(r.active_readiness_stage).not.toBe("ready_for_dry_run_mapping");
    expect(r.active_readiness_stage).not.toBe("already_covered");
  });

  it("hold -> needs_lodging_status_verification", () => {
    const r = buildAuditRow(reviewRow({ classification: "hold_candidate", suggested_human_decision: "hold" }));
    expect(r.audit_group).toBe("needs_lodging_status_verification");
    expect(r.recommended_next_human_action).toBe("hold_for_manual_check");
    expect(r.d05_blocker).toBe("unclear_lodging_status");
  });

  it("out_of_scope -> likely_exclude_or_hold", () => {
    const r = buildAuditRow(reviewRow({ classification: "out_of_scope_candidate", suggested_human_decision: "reject_out_of_scope" }));
    expect(r.audit_group).toBe("likely_exclude_or_hold");
    expect(r.recommended_next_human_action).toBe("reject_out_of_scope");
    expect(r.d05_blocker).toBe("out_of_scope_or_inactive");
  });

  it("human_decision remains blank", () => {
    expect(buildAuditRow(reviewRow({})).human_decision).toBe("");
  });

  it("human_notes remains blank", () => {
    expect(buildAuditRow(reviewRow({ human_notes: "should be cleared" as "" })).human_notes).toBe("");
  });

  it("D05 readiness remains false while human decisions blank", () => {
    const pack = buildPropertyDiscoveryAuditPack({ runId: "audit", generatedAtJst: "2026-06-08T08:00:00+09:00", inputReviewPackArtifactPath: "review.json", reviewPack: reviewPack([reviewRow({})]) });
    expect(pack.summary.d05_ready).toBe(false);
    expect(pack.summary.d05_reason).toBe("waiting_for_human_decisions");
  });

  it("sorting puts useful approve_new candidates before duplicates", () => {
    const pack = buildPropertyDiscoveryAuditPack({
      runId: "audit",
      generatedAtJst: "2026-06-08T08:00:00+09:00",
      inputReviewPackArtifactPath: "review.json",
      reviewPack: reviewPack([
        reviewRow({ candidate_name: "重複候補", classification: "duplicate_candidate", suggested_human_decision: "reject_duplicate" }),
        reviewRow({ candidate_name: "蔵王テストホテル", suggested_human_decision: "approve_new" })
      ])
    });
    expect(pack.rows[0]!.recommended_next_human_action).toBe("approve_new_after_review");
  });

  it("renders markdown/csv/json", () => {
    const pack = buildPropertyDiscoveryAuditPack({ runId: "audit", generatedAtJst: "2026-06-08T08:00:00+09:00", inputReviewPackArtifactPath: "review.json", reviewPack: reviewPack([reviewRow({})]) });
    expect(renderPropertyDiscoveryAuditMarkdown(pack)).toContain("D05 Readiness Explanation");
    expect(renderPropertyDiscoveryAuditCsv(pack.rows)).toContain("audit_priority");
    expect(JSON.parse(renderPropertyDiscoveryAuditJson(pack)).summary.total_candidates).toBe(1);
  });

  it("missing review-pack input fails clearly or asks to generate prerequisites", () => {
    expect(() => selectLatestReviewPackArtifact([])).toThrow("property_discovery_review_pack_missing_run_discover_properties_review_pack_first");
  });

  it("parses review-pack json and clears human fields", () => {
    const parsed = parseReviewPackJson(JSON.stringify(reviewPack([reviewRow({ human_decision: "approve_new" as "" })])));
    expect(parsed.rows[0]!.human_decision).toBe("");
    expect(parsed.rows[0]!.human_notes).toBe("");
  });

  it("registers npm run discover:properties:audit-pack", () => {
    expect(PACKAGE_JSON).toContain("\"discover:properties:audit-pack\"");
    expect(PACKAGE_JSON).toContain("src/scripts/runPropertyDiscoveryAudit.ts");
  });

  it("contains no executable collector, sync, context, launchd, or pricing path", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/launchctl|COLLECT_BOOKING=1|COLLECT_JALAN=1|auto-runner:market-refresh|sync:history-to-db:fresh|build:ai-context-packs/u);
    expect(SCRIPT_SOURCE).not.toMatch(/pricing|Beds24|AirHost|PMS|channel-manager/iu);
    expect(`${SERVICE_SOURCE}\n${SCRIPT_SOURCE}`).not.toMatch(/chromium\.launch|page\.goto|fetch\s*\(|https\.get|property_master_written:\s*true|collector_target_updated:\s*true/u);
  });
});

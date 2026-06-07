import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscoveryCandidateRow } from "../src/services/propertyDiscovery";
import {
  buildDecisionRow,
  buildDiscoveryReviewPack,
  parseDiscoveryRowsFromCsv,
  parseDiscoveryRowsFromJson,
  renderDiscoveryReviewCsv,
  renderDiscoveryReviewJson,
  renderDiscoveryReviewMarkdown,
  selectLatestDiscoveryArtifact
} from "../src/services/propertyDiscoveryReview";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/propertyDiscoveryReview.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runPropertyDiscoveryReview.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function row(over: Partial<DiscoveryCandidateRow>): DiscoveryCandidateRow {
  return {
    candidate_name: "テスト旅館",
    normalized_name: "テスト",
    classification: "new_candidate",
    confidence: 0.82,
    matched_existing_property: "",
    matched_existing_key: "",
    recommended_action: "approve_new",
    human_decision: "",
    source_evidence_count: 1,
    source_evidence_summary: "manual seed / lodging name candidate",
    reason_codes: ["no_existing_match", "lodging_name_candidate"],
    notes: "Needs human approval before any master update.",
    ...over
  };
}

describe("AUTO-RUNNER-DISCOVERY02 property discovery review pack", () => {
  it("duplicate_candidate -> reject_duplicate", () => {
    const r = buildDecisionRow(row({ classification: "duplicate_candidate", matched_existing_property: "蔵王国際ホテル" }));
    expect(r.suggested_human_decision).toBe("reject_duplicate");
    expect(r.review_priority).toBe("low");
    expect(r.collector_readiness).toBe("already_covered");
  });

  it("alias_candidate -> approve_alias", () => {
    const r = buildDecisionRow(row({ classification: "alias_candidate", matched_existing_property: "深山荘 高見屋" }));
    expect(r.suggested_human_decision).toBe("approve_alias");
    expect(r.review_priority).toBe("medium");
    expect(r.collector_readiness).toBe("needs_alias_only");
  });

  it("high-confidence new_candidate -> approve_new", () => {
    const r = buildDecisionRow(row({ classification: "new_candidate", confidence: 0.82 }));
    expect(r.suggested_human_decision).toBe("approve_new");
    expect(r.review_priority).toBe("high");
    expect(r.collector_readiness).toBe("needs_mapping");
  });

  it("uncertain new_candidate -> hold", () => {
    const r = buildDecisionRow(row({ classification: "new_candidate", reason_codes: ["unclear_lodging_signal"], notes: "private rental with missing OTA mapping" }));
    expect(r.suggested_human_decision).toBe("hold");
    expect(r.collector_readiness).toBe("unknown");
  });

  it("hold_candidate -> hold", () => {
    const r = buildDecisionRow(row({ classification: "hold_candidate" }));
    expect(r.suggested_human_decision).toBe("hold");
    expect(r.review_priority).toBe("high");
  });

  it("inactive and out_of_scope map to rejection decisions", () => {
    expect(buildDecisionRow(row({ classification: "closed_or_inactive_candidate" })).suggested_human_decision).toBe("reject_inactive");
    expect(buildDecisionRow(row({ classification: "out_of_scope_candidate" })).suggested_human_decision).toBe("reject_out_of_scope");
  });

  it("human_decision and human_notes remain blank", () => {
    const r = buildDecisionRow(row({}));
    expect(r.human_decision).toBe("");
    expect(r.human_notes).toBe("");
  });

  it("D05 readiness is false when human decisions are blank", () => {
    const pack = buildDiscoveryReviewPack({ runId: "test", generatedAtJst: "2026-06-07T00:00:00+09:00", inputArtifactPath: "input.json", rows: [row({})] });
    expect(pack.summary.d05_ready).toBe(false);
    expect(pack.summary.d05_reason).toBe("waiting_for_human_decisions");
  });

  it("renders markdown, csv, and json", () => {
    const pack = buildDiscoveryReviewPack({ runId: "test", generatedAtJst: "2026-06-07T00:00:00+09:00", inputArtifactPath: "input.json", rows: [row({}), row({ classification: "duplicate_candidate" })] });
    expect(renderDiscoveryReviewMarkdown(pack)).toContain("D05 Readiness Summary");
    expect(renderDiscoveryReviewCsv(pack.rows)).toContain("suggested_human_decision");
    expect(JSON.parse(renderDiscoveryReviewJson(pack)).summary.total_candidates).toBe(2);
  });

  it("parses discovery rows from json and csv inputs", () => {
    const json = JSON.stringify({ rows: [row({ candidate_name: "JSON旅館" })] });
    expect(parseDiscoveryRowsFromJson(json)[0]!.candidate_name).toBe("JSON旅館");
    const csv = "candidate_name,normalized_name,classification,confidence,matched_existing_property,matched_existing_key,recommended_action,human_decision,source_evidence_count,source_evidence_summary,reason_codes,notes\nCSV旅館,csv,new_candidate,0.82,,,approve_new,,1,seed,no_existing_match|lodging_name_candidate,note\n";
    expect(parseDiscoveryRowsFromCsv(csv)[0]!.candidate_name).toBe("CSV旅館");
  });

  it("missing input artifact fails clearly", () => {
    expect(() => selectLatestDiscoveryArtifact([])).toThrow("property_discovery_input_missing");
  });

  it("selects latest json before csv fallback", () => {
    expect(selectLatestDiscoveryArtifact(["/x/property_discovery_20260607_000000.csv", "/x/property_discovery_20260607_000001.json"])).toContain(".json");
    expect(selectLatestDiscoveryArtifact(["/x/property_discovery_20260607_000002.csv"])).toContain(".csv");
  });

  it("contains no executable collector, sync, context, or pricing path", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/COLLECT_BOOKING|COLLECT_JALAN|auto-runner:market-refresh|sync:history-to-db:fresh|build:ai-context-packs/u);
    expect(SCRIPT_SOURCE).not.toMatch(/pricing|Beds24|AirHost|PMS/u);
    expect(SERVICE_SOURCE).not.toMatch(/chromium\.launch|page\.goto|fetch\s*\(|https\.get/u);
  });

  it("registers npm run discover:properties:review-pack", () => {
    expect(PACKAGE_JSON).toContain("\"discover:properties:review-pack\"");
    expect(PACKAGE_JSON).toContain("src/scripts/runPropertyDiscoveryReview.ts");
  });
});

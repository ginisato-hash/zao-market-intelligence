import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildImprovedPreviewRow,
  buildJalanProbeTarget,
  type JalanImprovedExtractionCandidate,
  type JalanImprovedPreviewRow,
  type JalanProbeTarget
} from "../src/services/jalanBoundedCollectionProbeImproved";
import {
  buildFutureAuto05xPlan,
  buildProposalRows,
  buildSafetyConfirmation,
  buildTouchedShards,
  decideAppendProposal,
  deriveIdentity,
  excludedAuditEvidenceKind,
  isDirectionalAppendable,
  manualReviewReasons,
  renderProposalCsv,
  renderReport,
  summarizeProposal,
  type ExistingHistoryKey,
  type JalanAppendProposalRow
} from "../src/services/jalanHistoryAppendProposal";
import {
  buildRowHash,
  buildRowId,
  shardMonthFromCheckin
} from "../src/services/localHistorySchemaDesign";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/jalanHistoryAppendProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildJalanHistoryAppendProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures — build genuine AUTO03B preview rows via the AUTO03B builder.
// ---------------------------------------------------------------------------

function target(checkin = "2026-07-18", yad = "yad328232"): JalanProbeTarget {
  return buildJalanProbeTarget({
    canonicalPropertyName: "ル・ベール蔵王",
    facilityTier: "tier_1",
    jalanYadId: yad,
    sourceUrl: `https://www.jalan.net/${yad}/`,
    checkin
  });
}

function candidate(overrides: Partial<JalanImprovedExtractionCandidate> = {}): JalanImprovedExtractionCandidate {
  return {
    facility_name: "ル・ベール蔵王",
    room_or_plan_name: "【素泊まり】蔵王満喫プラン",
    room_name: "和室7.5畳",
    plan_name: "【素泊まり】蔵王満喫プラン",
    meal_condition: "素泊まり",
    availability_status: "available",
    price_total_tax_included: 25000,
    price_per_person: null,
    price_basis_text: "合計(税込) 25,000円",
    tax_included_evidence: true,
    stay_scope_evidence: true,
    date_condition_evidence: true,
    property_identity_confirmed: true,
    screenshot_path: "/tmp/shot.png",
    source_url: "https://www.jalan.net/yad328232/plan/",
    selected_block_text: "【素泊まり】蔵王満喫プラン 合計(税込) 25,000円 素泊まり",
    page_text_excerpt: "ル・ベール蔵王 【素泊まり】蔵王満喫プラン 合計(税込) 25,000円",
    error_reason: null,
    extraction_confidence: "high",
    ...overrides
  };
}

function previewRow(c: JalanImprovedExtractionCandidate, checkin = "2026-07-18", yad = "yad328232"): JalanImprovedPreviewRow {
  return buildImprovedPreviewRow({
    runId: "run",
    checkedAt: "2026-06-05T00:29:41+09:00",
    target: target(checkin, yad),
    candidate: c,
    reportPath: "report.md",
    csvPath: "rows.csv",
    debugPath: "debug.json"
  });
}

// Directional row: priced, screenshot, property/date/scope confirmed, only a
// non-hard direct gap (medium extraction confidence) -> dp_usage=directional/B.
function directionalRow(checkin = "2026-07-18"): JalanImprovedPreviewRow {
  return previewRow(candidate({ extraction_confidence: "medium" }), checkin);
}

// Excluded by sold-out.
function soldOutRow(checkin = "2026-06-06"): JalanImprovedPreviewRow {
  return previewRow(
    candidate({ availability_status: "sold_out", price_total_tax_included: null, error_reason: "sold_out" }),
    checkin,
    "yad327282"
  );
}

// Excluded by selected-plan discount (priced but not comparable).
function discountRow(checkin = "2026-07-18"): JalanImprovedPreviewRow {
  return previewRow(
    candidate({
      price_total_tax_included: 17145,
      selected_block_text: "【じゃらんスペシャル】直前割プラン 合計(税込) 17,145円",
      plan_name: "【じゃらんスペシャル】直前割プラン"
    }),
    checkin,
    "yad348320"
  );
}

// ---------------------------------------------------------------------------
// Identity (§8)
// ---------------------------------------------------------------------------

describe("JALAN-AUTO04X - canonical identity reuse", () => {
  it("derives row_id/row_hash/shard_month with the canonical v1 helpers", () => {
    const row = directionalRow("2026-07-18");
    const id = deriveIdentity(row);
    const expectedId = buildRowId({
      collectedDateJst: row.collected_date_jst,
      source: row.source,
      canonicalPropertyName: row.canonical_property_name,
      sourceSlugOrCode: row.source_slug_or_code,
      sourcePropertyId: row.source_property_id,
      checkin: row.checkin,
      checkout: row.checkout,
      stayScope: row.stay_scope
    });
    const expectedHash = buildRowHash({
      source: row.source,
      sourcePhase: row.source_phase,
      collectorStage: row.collector_stage,
      canonicalPropertyName: row.canonical_property_name,
      sourceSlugOrCode: row.source_slug_or_code,
      sourcePropertyId: row.source_property_id,
      checkin: row.checkin,
      checkout: row.checkout,
      stayScope: row.stay_scope,
      collectedDateJst: row.collected_date_jst,
      availabilityStatus: row.availability_status,
      soldOutStatus: row.sold_out_status,
      normalizedTotalPrice: row.normalized_total_price,
      basisConfidence: row.basis_confidence,
      sourceClassification: row.source_classification,
      isPriceUsableForDpDirect: row.is_price_usable_for_dp_direct,
      isPriceUsableForDpDirectional: row.is_price_usable_for_dp_directional,
      isPriceExcludedFromDp: row.is_price_excluded_from_dp
    });
    expect(id.row_id).toBe(expectedId);
    expect(id.row_hash).toBe(expectedHash);
    expect(id.shard_month).toBe(shardMonthFromCheckin(row.checkin));
    expect(id.shard_month).toBe("2026_07");
  });
});

// ---------------------------------------------------------------------------
// Row-selection gates (§7)
// ---------------------------------------------------------------------------

describe("JALAN-AUTO04X - append gates", () => {
  it("accepts a clean directional row for directional append", () => {
    expect(isDirectionalAppendable(directionalRow())).toBe(true);
  });

  it("rejects directional append when screenshot missing", () => {
    const row = { ...directionalRow(), screenshot_path: "" } as JalanImprovedPreviewRow;
    expect(isDirectionalAppendable(row)).toBe(false);
  });

  it("rejects directional append when row is direct-usable", () => {
    const row = { ...directionalRow(), is_price_usable_for_dp_direct: true } as JalanImprovedPreviewRow;
    expect(isDirectionalAppendable(row)).toBe(false);
  });

  it("rejects directional append when a hard exclusion reason is present", () => {
    const row = { ...directionalRow(), hard_exclusion_reason: "suspicious_price" } as JalanImprovedPreviewRow;
    expect(isDirectionalAppendable(row)).toBe(false);
  });

  it("classifies excluded-audit evidence kinds", () => {
    expect(excludedAuditEvidenceKind(soldOutRow())).toBe("sold_out");
    expect(excludedAuditEvidenceKind(discountRow())).toBe("selected_plan_discount");
    expect(
      excludedAuditEvidenceKind(
        previewRow(
          candidate({ availability_status: "not_found", price_total_tax_included: null, error_reason: "not_found" }),
          "2026-06-06",
          "yad325153"
        )
      )
    ).toBe("not_found");
    expect(excludedAuditEvidenceKind(directionalRow())).toBe("");
  });

  it("flags structural problems as manual_review reasons", () => {
    expect(manualReviewReasons(directionalRow())).toEqual([]);
    const bad = { ...directionalRow(), canonical_property_name: "", checkin: "bad" } as JalanImprovedPreviewRow;
    const reasons = manualReviewReasons(bad);
    expect(reasons).toContain("missing_canonical_property_name");
    expect(reasons).toContain("invalid_checkin");
  });
});

// ---------------------------------------------------------------------------
// Proposal construction
// ---------------------------------------------------------------------------

describe("JALAN-AUTO04X - proposal rows", () => {
  it("proposes append_directional with price_pressure_usable and dp_usable=false", () => {
    const [row] = buildProposalRows([directionalRow()], []);
    expect(row!.history_action).toBe("append_directional");
    expect(row!.price_pressure_usable).toBe(true);
    expect(row!.dp_usable).toBe(false);
  });

  it("proposes append_excluded_audit for sold-out with audit-only flags", () => {
    const [row] = buildProposalRows([soldOutRow()], []);
    expect(row!.history_action).toBe("append_excluded_audit");
    expect(row!.audit_evidence_kind).toBe("sold_out");
    expect(row!.price_pressure_usable).toBe(false);
    expect(row!.dp_usable).toBe(false);
  });

  it("proposes append_excluded_audit for a selected-plan discount row", () => {
    const [row] = buildProposalRows([discountRow()], []);
    expect(row!.history_action).toBe("append_excluded_audit");
    expect(row!.audit_evidence_kind).toBe("selected_plan_discount");
  });

  it("skips an identical row already in history (same row_id + row_hash)", () => {
    const row = directionalRow();
    const id = deriveIdentity(row);
    const existing: ExistingHistoryKey[] = [{ row_id: id.row_id, row_hash: id.row_hash, shard_month: id.shard_month }];
    const [out] = buildProposalRows([row], existing);
    expect(out!.history_action).toBe("skip_identical");
    expect(out!.existing_row_hash).toBe(id.row_hash);
  });

  it("blocks a conflicting row (same row_id, different row_hash) without resolving it", () => {
    const row = directionalRow();
    const id = deriveIdentity(row);
    const existing: ExistingHistoryKey[] = [{ row_id: id.row_id, row_hash: "deadbeef", shard_month: id.shard_month }];
    const [out] = buildProposalRows([row], existing);
    expect(out!.history_action).toBe("block_conflict");
    expect(out!.existing_row_hash).toBe("deadbeef");
    expect(out!.reason).toMatch(/not resolved/u);
  });

  it("routes structurally broken rows to manual_review", () => {
    const bad = { ...directionalRow(), schema_version: "wrong" } as unknown as JalanImprovedPreviewRow;
    const [out] = buildProposalRows([bad], []);
    expect(out!.history_action).toBe("manual_review");
    expect(out!.manual_review_reasons).toContain("invalid_schema_version");
  });
});

// ---------------------------------------------------------------------------
// Summary + touched shards (§9)
// ---------------------------------------------------------------------------

describe("JALAN-AUTO04X - preflight summary and touched shards", () => {
  const rows = [directionalRow("2026-07-18"), soldOutRow("2026-06-06"), discountRow("2026-08-08")];
  const history = { total_rows: 100, rows_by_shard: { "2026_06": 10, "2026_07": 20, "2026_08": 30 }, source_files: [] };

  it("counts selections and expected total after append", () => {
    const proposal = buildProposalRows(rows, []);
    const summary = summarizeProposal(rows, proposal, history);
    expect(summary.total_preview_rows).toBe(3);
    expect(summary.selected_for_directional_append).toBe(1);
    expect(summary.selected_for_excluded_audit_append).toBe(2);
    expect(summary.skip_identical_count).toBe(0);
    expect(summary.conflict_count).toBe(0);
    expect(summary.manual_review_count).toBe(0);
    expect(summary.total_appendable_count).toBe(3);
    expect(summary.expected_total_after_append_if_no_conflicts).toBe(103);
    expect(summary.touched_shards).toEqual(["2026_06", "2026_07", "2026_08"]);
  });

  it("summarizes per-shard append plan with existing baseline", () => {
    const proposal = buildProposalRows(rows, []);
    const shards = buildTouchedShards(proposal, history);
    const jul = shards.find((s) => s.shard_month === "2026_07");
    expect(jul!.existing_rows).toBe(20);
    expect(jul!.append_directional).toBe(1);
    expect(jul!.expected_after).toBe(21);
    expect(jul!.future_shard_path).toBe(".data/history/zao_signals_2026_07.csv");
  });
});

// ---------------------------------------------------------------------------
// Decision (§14)
// ---------------------------------------------------------------------------

describe("JALAN-AUTO04X - decision", () => {
  const baseSummary = (over: Partial<ReturnType<typeof summarizeProposal>> = {}): ReturnType<typeof summarizeProposal> => ({
    total_preview_rows: 5,
    directional_preview_rows: 1,
    excluded_preview_rows: 4,
    selected_for_directional_append: 1,
    selected_for_excluded_audit_append: 0,
    skip_identical_count: 0,
    conflict_count: 0,
    manual_review_count: 0,
    total_appendable_count: 1,
    existing_history_row_count: 0,
    expected_total_after_append_if_no_conflicts: 1,
    touched_shards: ["2026_07"],
    action_breakdown: {},
    ...over
  });

  it("ready when directional present and only clean appends remain", () => {
    expect(decideAppendProposal({ sourceLoaded: true, historyParsed: true, summary: baseSummary() })).toBe(
      "jalan_history_append_proposal_ready"
    );
  });

  it("basis_caution when excluded-audit or manual-review rows also remain", () => {
    expect(
      decideAppendProposal({
        sourceLoaded: true,
        historyParsed: true,
        summary: baseSummary({ selected_for_excluded_audit_append: 4 })
      })
    ).toBe("jalan_history_append_proposal_basis_caution");
  });

  it("not_ready when no directional rows", () => {
    expect(
      decideAppendProposal({
        sourceLoaded: true,
        historyParsed: true,
        summary: baseSummary({ selected_for_directional_append: 0 })
      })
    ).toBe("jalan_history_append_proposal_not_ready");
  });

  it("not_ready when conflicts block", () => {
    expect(
      decideAppendProposal({ sourceLoaded: true, historyParsed: true, summary: baseSummary({ conflict_count: 2 }) })
    ).toBe("jalan_history_append_proposal_not_ready");
  });

  it("not_ready when source missing or history unreadable", () => {
    expect(decideAppendProposal({ sourceLoaded: false, historyParsed: true, summary: baseSummary() })).toBe(
      "jalan_history_append_proposal_not_ready"
    );
    expect(decideAppendProposal({ sourceLoaded: true, historyParsed: false, summary: baseSummary() })).toBe(
      "jalan_history_append_proposal_not_ready"
    );
  });
});

// ---------------------------------------------------------------------------
// Future plan + safety (§10)
// ---------------------------------------------------------------------------

describe("JALAN-AUTO04X - future plan and safety", () => {
  it("future AUTO05X plan carries the approval sentence and env flag", () => {
    const proposal = buildProposalRows([directionalRow()], []);
    const summary = summarizeProposal([directionalRow()], proposal, { total_rows: 0, rows_by_shard: {}, source_files: [] });
    const plan = buildFutureAuto05xPlan(summary);
    expect(plan.phase).toBe("JALAN-AUTO05X");
    expect(plan.status).toBe("proposed_not_executed");
    expect(plan.approval_gate.explicit_approval_sentence).toContain("Approve Phase JALAN-AUTO05X");
    expect(plan.approval_gate.env_flag).toBe("JALAN_HISTORY_APPEND=1");
    expect(plan.db_sync_and_ai_context).toMatch(/JALAN-AUTO05B/u);
  });

  it("safety confirmation is all-false", () => {
    const safety = buildSafetyConfirmation();
    expect(Object.values(safety).every((v) => v === false)).toBe(true);
    expect(safety.history_appended).toBe(false);
    expect(safety.db_synced).toBe(false);
    expect(safety.started_auto05x).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("JALAN-AUTO04X - rendering", () => {
  const rows = [directionalRow("2026-07-18"), discountRow("2026-08-08")];
  const proposal = buildProposalRows(rows, []);
  const summary = summarizeProposal(rows, proposal, { total_rows: 0, rows_by_shard: {}, source_files: [] });

  it("renders CSV with identity headers and an append action column", () => {
    const csv = renderProposalCsv(proposal);
    expect(csv).toContain("row_id");
    expect(csv).toContain("history_action");
    expect(csv).toContain("price_pressure_usable");
    expect(csv).toContain("append_directional");
  });

  it("renders the report with the future AUTO05X plan and decision", () => {
    const md = renderReport({
      generatedAtJst: "2026-06-05T01:00:00+09:00",
      decision: "jalan_history_append_proposal_basis_caution",
      sourceAuto03bArtifact: "auto03b.json",
      sourceAuto03bSummary: { preview_rows: 2 },
      summary,
      touchedShards: buildTouchedShards(proposal, { total_rows: 0, rows_by_shard: {}, source_files: [] }),
      proposalRows: proposal,
      futureAuto05xPlan: buildFutureAuto05xPlan(summary),
      safetyConfirmation: buildSafetyConfirmation(),
      nextPhase: "JALAN-AUTO05X — do not start without explicit instruction."
    });
    expect(md).toContain("## 9. Future AUTO05X Plan");
    expect(md).toContain("Approve Phase JALAN-AUTO05X");
    expect(md).toContain("JALAN_HISTORY_APPEND=1");
    expect(md).toContain("## 11. Decision");
    expect(md).toContain("jalan_history_append_proposal_basis_caution");
    expect(md).toContain("## 10. Safety Confirmation");
  });
});

// ---------------------------------------------------------------------------
// Executable safety scans (§15)
// ---------------------------------------------------------------------------

describe("JALAN-AUTO04X - executable safety scans", () => {
  it("script never appends or writes to .data/history", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/appendFile/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/renameSync|copyFileSync/iu);
    // history dir is only ever read.
    expect(SCRIPT_SOURCE).toMatch(/readdirSync|readFileSync/u);
  });

  it("script has no DB write or DB sync code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/better-sqlite3|prepare\(["'`]\s*(?:INSERT|UPDATE|DELETE)|\b(?:db|database)\.exec\(/iu);
    expect(SCRIPT_SOURCE).not.toContain("real-run:history-to-db-sync");
  });

  it("script has no AI context refresh code", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
    expect(SCRIPT_SOURCE).not.toMatch(/query:ai-task/u);
  });

  it("script runs no live collector or browser automation", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch|page\.goto|browser\./u);
    expect(SCRIPT_SOURCE).not.toMatch(/probe:jalan-bounded-collection|review:jalan-probe-result|proposal:jalan-target-matrix/u);
    expect(SCRIPT_SOURCE).not.toMatch(/fetch\(|axios|got\(|https?:\/\//u);
  });

  it("script emits no pricing / PMS output", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/pricing:recommend|pricing:approve|Beds24|AirHost|pmsCsv|exportApproved/iu);
  });

  it("does not invoke Booking/Rakuten/Google collection", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/bookingBounded|Booking|rakuten|Rakuten|googleHotels|GoogleHotels/u);
    expect(SERVICE_SOURCE).not.toMatch(/bookingBounded|Booking|rakuten|Rakuten|googleHotels|GoogleHotels/u);
  });

  it("service applies no ASCII pricing multipliers and no browser code", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/u);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/u);
    expect(SERVICE_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch|page\.goto/u);
  });

  it("script writes only to reports/automation and the debug dir", () => {
    expect(SCRIPT_SOURCE).toContain(".data/reports/automation");
    expect(SCRIPT_SOURCE).toContain(".data/debug/jalan-history-append-proposal");
  });

  it("package.json exposes the proposal script and the source artifact is wired", () => {
    expect(PACKAGE_JSON).toContain("\"proposal:jalan-history-append\"");
    expect(SCRIPT_SOURCE).toContain("jalan_bounded_collection_probe_improved_20260605_002941.json");
  });

  it("script JSON report exposes the required top-level keys", () => {
    for (const key of [
      "run_id",
      "generated_at_jst",
      "decision",
      "source_auto03b_artifact",
      "source_auto03b_summary",
      "proposal_summary",
      "preflight_summary",
      "touched_shards",
      "proposal_rows",
      "directional_append_rows",
      "excluded_audit_rows",
      "manual_review_rows",
      "conflict_rows",
      "future_auto05x_plan",
      "safety_confirmation",
      "next_phase"
    ]) {
      expect(SCRIPT_SOURCE).toContain(`${key}:`);
    }
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTO08X_DEBUG_MARKER,
  buildContextContaminationSummary,
  buildContradictionEvidence,
  buildRakutenSoldOutSemanticsAudit,
  classifySoldOutSemantics,
  collectorFixProposal,
  isAuto08xAffectedRow,
  quarantineOptions,
  renderRakutenSoldOutSemanticsAuditCsv,
  renderRakutenSoldOutSemanticsAuditMarkdown,
  summarizeAffectedRows,
  type HistoryRowLike
} from "../src/services/rakutenSoldOutSemanticsAudit";

const SERVICE_SOURCE = readFileSync(resolve("src/services/rakutenSoldOutSemanticsAudit.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/buildRakutenSoldOutSemanticsAudit.ts"), "utf8");

function affectedRow(overrides: Partial<HistoryRowLike> = {}): HistoryRowLike {
  return {
    row_id: "r1",
    row_hash: "h1",
    source: "rakuten",
    source_phase: "AUTO08X",
    canonical_property_name: "蔵王国際ホテル",
    source_property_id: "5723",
    source_slug_or_code: "5723:00",
    checkin: "2026-06-03",
    availability_status: "sold_out",
    source_classification: "rakuten_day_sold_out",
    classification: "rakuten_day_sold_out",
    dp_usage: "excluded",
    is_price_excluded_from_dp: "true",
    debug_artifact_path: AUTO08X_DEBUG_MARKER,
    raw_json: JSON.stringify({ sourcePhase: "AUTO08X", sourceSlugOrCode: "5723:00" }),
    ...overrides
  };
}

describe("rakuten sold-out semantics audit", () => {
  it("identifies AUTO08X affected rows by debug/run marker", () => {
    expect(isAuto08xAffectedRow(affectedRow())).toBe(true);
    expect(isAuto08xAffectedRow(affectedRow({ source_phase: "", raw_json: "", debug_artifact_path: AUTO08X_DEBUG_MARKER }))).toBe(true);
    expect(isAuto08xAffectedRow(affectedRow({ source: "jalan" }))).toBe(false);
  });

  it("summarizes affected history row count", () => {
    const summary = summarizeAffectedRows([affectedRow({ row_id: "1" }), affectedRow({ row_id: "2" }), { source: "rakuten" }]);
    expect(summary.count).toBe(2);
    expect(summary.by_property["蔵王国際ホテル"]).toBe(2);
    expect(summary.by_source_slug_or_code["5723:00"]).toBe(2);
  });

  it("summarizes affected DB row count", () => {
    const dbRows = [
      affectedRow({ row_id: "db1", source_phase: "", raw_json: JSON.stringify({ sourcePhase: "AUTO08X", sourceSlugOrCode: "39565:honkan-exk" }) }),
      affectedRow({ row_id: "db2", source_phase: "", raw_json: JSON.stringify({ sourcePhase: "AUTO08X", sourceSlugOrCode: "39565:honkan-exk" }) })
    ];
    expect(summarizeAffectedRows(dbRows).count).toBe(2);
  });

  it("summarizes affected context count", () => {
    const summary = buildContextContaminationSummary({
      beforeSoldOutRowCount: 66,
      latestSoldOutRowCount: 182,
      latestDemandRows: [{ checkin_date: "2026-06-01", sold_out_count: 4 }],
      latestMarketSnapshotPath: ".data/ai-context/latest_market_snapshot.json",
      latestDemandContextPath: ".data/ai-context/latest_demand_context.json"
    });
    expect(summary.delta_sold_out_row_count).toBe(116);
    expect(summary.unsafe_usage_note).toContain("contaminated");
  });

  it("distinguishes f_syu/room-type sold_out from property-level sold_out", () => {
    expect(classifySoldOutSemantics({
      fSyu: "honkan-exk",
      roomName: "ザ・ゲスト棟 和室ベッド ＜倶楽部ルーム＞",
      independentContextCount: 1,
      planListNoAvailability: false
    })).toBe("room_type_context_sold_out");
  });

  it("flags non-empty f_syu as room-type/f_syu context", () => {
    expect(classifySoldOutSemantics({
      fSyu: "honkan-exk",
      roomName: "",
      independentContextCount: 1,
      planListNoAvailability: false
    })).toBe("f_syu_context_sold_out");
  });

  it("does not allow one f_syu to imply property-level sold_out", () => {
    expect(classifySoldOutSemantics({
      fSyu: "00",
      roomName: "南館和室14畳",
      independentContextCount: 1,
      planListNoAvailability: false
    })).not.toBe("property_level_sold_out_confirmed");
  });

  it("can confirm property-level sold_out only with independent evidence", () => {
    expect(classifySoldOutSemantics({
      fSyu: "00",
      roomName: "南館和室14畳",
      independentContextCount: 2,
      planListNoAvailability: false
    })).toBe("property_level_sold_out_confirmed");
  });

  it("incorporates user contradiction evidence", () => {
    const evidence = buildContradictionEvidence();
    expect(evidence.map((e) => e.f_syu)).toEqual(["honkan-exk", "00"]);
    expect(evidence.map((e) => e.room_context).join("\n")).toContain("南館和室14畳");
    expect(evidence.map((e) => e.room_context).join("\n")).toContain("倶楽部ルーム");
  });

  it("generates quarantine options A/B/C/D and recommends A", () => {
    const options = quarantineOptions();
    expect(options.map((o) => o.option)).toEqual(["A", "B", "C", "D"]);
    expect(options.find((o) => o.option === "A")?.recommendation).toBe("recommended");
  });

  it("recommends not using affected rows in DB/context until fixed", () => {
    const audit = buildRakutenSoldOutSemanticsAudit({
      runId: "run",
      generatedAtJst: "2026-06-04T10:00:00+09:00",
      historyRows: [affectedRow()],
      dbRows: [affectedRow({ row_id: "db" })],
      beforeSoldOutRowCount: 66,
      latestSoldOutRowCount: 182,
      latestDemandRows: [],
      codeSnippets: []
    });
    expect(audit.recommended_fix_plan.join("\n")).toContain("Do not use the 116 AUTO08X rows");
    expect(audit.decision).toBe("rakuten_sold_out_semantics_audit_basis_caution");
  });

  it("proposes context fields required for recurrence prevention", () => {
    const proposal = collectorFixProposal();
    expect(proposal.fields_to_persist).toEqual(expect.arrayContaining([
      "f_hotel_no",
      "f_syu",
      "f_camp_id",
      "source_context_type",
      "room_name"
    ]));
  });

  it("proposes new Rakuten sold-out classifications", () => {
    const proposal = collectorFixProposal();
    expect(proposal.new_classifications).toEqual(expect.arrayContaining([
      "rakuten_f_syu_context_sold_out",
      "rakuten_room_type_context_sold_out",
      "rakuten_property_sold_out_confirmed",
      "rakuten_plan_available_contradiction"
    ]));
  });

  it("renders report and CSV without PMS export columns", () => {
    const audit = buildRakutenSoldOutSemanticsAudit({
      runId: "run",
      generatedAtJst: "2026-06-04T10:00:00+09:00",
      historyRows: [affectedRow()],
      dbRows: [affectedRow({ row_id: "db" })],
      beforeSoldOutRowCount: 66,
      latestSoldOutRowCount: 182,
      latestDemandRows: [],
      codeSnippets: ["buildHplanCalendarUrl with target.fSyu"]
    });
    const md = renderRakutenSoldOutSemanticsAuditMarkdown(audit);
    const csv = renderRakutenSoldOutSemanticsAuditCsv(audit);
    expect(md).toContain("property_level_sold_out_confirmed=false");
    expect(csv).not.toMatch(/roomid|inventory|minstay|maxstay|price1|Beds24|AirHost|PMS/);
  });

  it("does not modify .data/history", () => {
    expect(SERVICE_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/u);
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*HISTORY_DIR/u);
  });

  it("does not write DB", () => {
    expect(SERVICE_SOURCE).not.toMatch(/better-sqlite3|openLocalDatabase|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|CREATE\s+TABLE/i);
    expect(SCRIPT_SOURCE).toMatch(/readonly:\s*true/);
    expect(SCRIPT_SOURCE).not.toMatch(/INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE/i);
  });

  it("does not run DB sync", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("HISTORY_TO_DB_SYNC");
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("real-run:history-to-db-sync");
  });

  it("does not refresh AI context", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*AI_CONTEXT/u);
  });

  it("does not run broad collectors", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("real-run:auto-history-append");
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("collect:jalan");
  });

  it("does not use Playwright", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright["']|chromium\.|firefox\.|webkit\./i);
  });

  it("does not use paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/i);
  });

  it("decision is basis_caution or ready when affected rows are present", () => {
    const audit = buildRakutenSoldOutSemanticsAudit({
      runId: "run",
      generatedAtJst: "2026-06-04T10:00:00+09:00",
      historyRows: [affectedRow()],
      dbRows: [affectedRow({ row_id: "db" })],
      beforeSoldOutRowCount: 66,
      latestSoldOutRowCount: 182,
      latestDemandRows: [],
      codeSnippets: []
    });
    expect(["rakuten_sold_out_semantics_audit_basis_caution", "rakuten_sold_out_semantics_audit_ready"]).toContain(audit.decision);
  });
});

// Phase AUTO08X-FIX01 — Rakuten sold-out semantics audit.
//
// Audit/proposal only. This module identifies AUTO08X rows and explains why a
// single f_syu/room-type calendar full day is not property-level sold_out.
// It does not mutate history, write DB rows, refresh AI context, run collectors,
// use Playwright, or fetch live pages.

export type RakutenSoldOutSemanticsAuditDecision =
  | "rakuten_sold_out_semantics_audit_ready"
  | "rakuten_sold_out_semantics_audit_basis_caution"
  | "rakuten_sold_out_semantics_audit_not_ready";

export type SoldOutSemanticsClassification =
  | "f_syu_context_sold_out"
  | "room_type_context_sold_out"
  | "campaign_or_plan_context_sold_out"
  | "property_level_sold_out_confirmed";

export interface HistoryRowLike {
  row_id?: string;
  row_hash?: string;
  source?: string;
  source_phase?: string;
  collector_stage?: string;
  canonical_property_name?: string;
  source_property_id?: string;
  source_slug_or_code?: string;
  checkin?: string;
  checkin_date?: string;
  availability_status?: string;
  source_classification?: string;
  classification?: string;
  dp_usage?: string;
  is_price_excluded_from_dp?: string;
  debug_artifact_path?: string;
  source_report_path?: string;
  raw_json?: string;
  [key: string]: string | undefined;
}

export interface AffectedRowsSummary {
  count: number;
  by_property: Record<string, number>;
  by_source_slug_or_code: Record<string, number>;
  by_classification: Record<string, number>;
  by_dp_usage: Record<string, number>;
  sample_rows: HistoryRowLike[];
}

export interface ContextContaminationSummary {
  before_sold_out_row_count: number;
  latest_sold_out_row_count: number;
  delta_sold_out_row_count: number;
  latest_market_snapshot_path: string;
  latest_demand_context_path: string;
  affected_demand_dates_count: number;
  unsafe_usage_note: string;
}

export interface ContradictionEvidence {
  hotel_no: string;
  f_syu: string;
  canonical_property_name: string;
  room_context: string;
  conclusion: string;
}

export interface CodePathAudit {
  build_url_path: string;
  normalization_path: string;
  downstream_path: string;
  root_cause: string;
  evidence_snippets: string[];
}

export interface QuarantineOption {
  option: "A" | "B" | "C" | "D";
  title: string;
  action: string;
  pros: string[];
  cons: string[];
  recommendation: "recommended" | "not_preferred" | "fallback";
}

export interface CollectorFixProposal {
  source_context_types: string[];
  fields_to_persist: string[];
  new_classifications: string[];
  rules: string[];
}

export interface RakutenSoldOutSemanticsAudit {
  run_id: string;
  generated_at_jst: string;
  decision: RakutenSoldOutSemanticsAuditDecision;
  affected_history_rows: AffectedRowsSummary;
  affected_db_rows: AffectedRowsSummary;
  affected_context: ContextContaminationSummary;
  semantics_classification: SoldOutSemanticsClassification;
  semantics_result: string;
  contradiction_evidence: ContradictionEvidence[];
  code_path_audit: CodePathAudit;
  quarantine_options: QuarantineOption[];
  recommended_fix_plan: string[];
  collector_fix_proposal: CollectorFixProposal;
  safety_confirmation: Record<string, boolean>;
}

export const AUTO08X_DEBUG_MARKER = ".data/debug/auto-history-append/20260604_094714";
export const AUTO08X_REPORT_MARKER = ".data/reports/automation/auto_history_append_20260604_094714";

export function isAuto08xAffectedRow(row: HistoryRowLike): boolean {
  const joined = [
    row.source_phase,
    row.collector_stage,
    row.source_report_path,
    row.debug_artifact_path,
    row.raw_json,
    row.source_classification,
    row.classification
  ].filter(Boolean).join("\n");
  const classification = row.source_classification ?? row.classification ?? "";
  return (
    row.source === "rakuten" &&
    joined.includes("AUTO08X") &&
    classification === "rakuten_day_sold_out"
  ) || (
    row.source === "rakuten" &&
    classification === "rakuten_day_sold_out" &&
    (joined.includes(AUTO08X_DEBUG_MARKER) || joined.includes(AUTO08X_REPORT_MARKER))
  );
}

export function summarizeAffectedRows(rows: HistoryRowLike[]): AffectedRowsSummary {
  const affected = rows.filter(isAuto08xAffectedRow);
  return {
    count: affected.length,
    by_property: countBy(affected, (row) => row.canonical_property_name ?? ""),
    by_source_slug_or_code: countBy(affected, (row) => row.source_slug_or_code ?? sourceSlugFromRaw(row) ?? ""),
    by_classification: countBy(affected, (row) => row.source_classification ?? row.classification ?? ""),
    by_dp_usage: countBy(affected, (row) => row.dp_usage ?? dpUsageFromRow(row)),
    sample_rows: affected.slice(0, 10)
  };
}

export function classifySoldOutSemantics(input: {
  fSyu: string;
  roomName: string;
  independentContextCount: number;
  planListNoAvailability: boolean;
}): SoldOutSemanticsClassification {
  if (input.planListNoAvailability || input.independentContextCount > 1) return "property_level_sold_out_confirmed";
  if (input.roomName.trim() !== "") return "room_type_context_sold_out";
  if (input.fSyu.trim() !== "") return "f_syu_context_sold_out";
  return "campaign_or_plan_context_sold_out";
}

export function buildContradictionEvidence(): ContradictionEvidence[] {
  return [
    {
      hotel_no: "39565",
      f_syu: "honkan-exk",
      canonical_property_name: "名湯リゾート ルーセント",
      room_context: "ザ・ゲスト棟 和室ベッド ＜倶楽部ルーム＞",
      conclusion: "Single f_syu calendar represents this room-type context, not whole-property sold_out."
    },
    {
      hotel_no: "5723",
      f_syu: "00",
      canonical_property_name: "蔵王国際ホテル",
      room_context: "南館和室14畳",
      conclusion: "Single f_syu calendar represents this room-type context, not whole-property sold_out."
    }
  ];
}

export function buildContextContaminationSummary(input: {
  beforeSoldOutRowCount: number;
  latestSoldOutRowCount: number;
  latestDemandRows: { sold_out_count?: number; row_count?: number; checkin_date?: string }[];
  latestMarketSnapshotPath: string;
  latestDemandContextPath: string;
}): ContextContaminationSummary {
  const delta = input.latestSoldOutRowCount - input.beforeSoldOutRowCount;
  return {
    before_sold_out_row_count: input.beforeSoldOutRowCount,
    latest_sold_out_row_count: input.latestSoldOutRowCount,
    delta_sold_out_row_count: delta,
    latest_market_snapshot_path: input.latestMarketSnapshotPath,
    latest_demand_context_path: input.latestDemandContextPath,
    affected_demand_dates_count: input.latestDemandRows.filter((row) => (row.sold_out_count ?? 0) > 0).length,
    unsafe_usage_note: "Current context packs aggregate AUTO08X f_syu/room-type sold-out rows into sold_out_count/sold_out_ratio, so DB/context sold-out pressure must be treated as contaminated until correction."
  };
}

export function quarantineOptions(): QuarantineOption[] {
  return [
    {
      option: "A",
      title: "Revert AUTO08X rows from history, DB, and context",
      action: "Remove the 116 AUTO08X rows from .data/history, resync DB from clean history, then rebuild AI context packs.",
      pros: ["Cleanest canonical state.", "Lowest risk for future AI because contaminated rows disappear from source-of-truth history.", "DB/context can be rebuilt deterministically."],
      cons: ["Requires explicit approval and careful backup/rollback.", "Removes room-level negative evidence unless preserved in a separate debug/report artifact."],
      recommendation: "recommended"
    },
    {
      option: "B",
      title: "Rewrite AUTO08X rows as quarantined/excluded",
      action: "Keep rows but change classification/exclusion_reason/dp_usage to f_syu_context_sold_out_unconfirmed.",
      pros: ["Preserves evidence in history.", "Avoids deleting appended rows."],
      cons: ["Mutating canonical history rows is harder to audit.", "Future filters must be perfect to avoid repeated contamination."],
      recommendation: "not_preferred"
    },
    {
      option: "C",
      title: "Leave history but block DB/context usage",
      action: "Keep history rows as-is but add DB/context filters excluding the AUTO08X run marker from sold-out pressure.",
      pros: ["Minimal source artifact mutation.", "Can be implemented in derived layers."],
      cons: ["Canonical history remains misleading.", "Every downstream consumer must remember the special-case exclusion."],
      recommendation: "fallback"
    },
    {
      option: "D",
      title: "Append correction/supersession rows",
      action: "Keep original rows and append correction rows that supersede the AUTO08X sold-out interpretation.",
      pros: ["Append-only audit trail.", "No deletion/rewrite of existing rows."],
      cons: ["Requires supersession semantics not currently established.", "AI consumers may still read original contaminated rows."],
      recommendation: "not_preferred"
    }
  ];
}

export function collectorFixProposal(): CollectorFixProposal {
  return {
    source_context_types: ["property_level", "room_type_level", "f_syu_level", "plan_level", "campaign_level", "unknown"],
    fields_to_persist: ["f_hotel_no", "f_syu", "f_camp_id", "room_name", "ryHeyaKihon", "source_context_type", "plan_context_id"],
    new_classifications: [
      "rakuten_f_syu_context_sold_out",
      "rakuten_room_type_context_sold_out",
      "rakuten_plan_context_sold_out",
      "rakuten_campaign_context_sold_out",
      "rakuten_property_sold_out_unconfirmed",
      "rakuten_property_sold_out_confirmed",
      "rakuten_context_mismatch",
      "rakuten_plan_available_contradiction"
    ],
    rules: [
      "Do not convert a single f_syu calendar full day into property-level sold_out.",
      "If f_syu is non-empty or room-type-specific, classify sold-out as context-level and exclude from property-level sold_out pressure.",
      "To infer property-level sold_out, require plan-list-level no-availability, multiple independent room/plan contexts, or confirmed no available plans from an f_camp_id-empty query.",
      "Context packs must exclude non-property-level sold_out rows from sold_out_row_count and demand_context sold_out_ratio."
    ]
  };
}

export function buildCodePathAudit(snippets: string[]): CodePathAudit {
  return {
    build_url_path: "src/scripts/runAutoHistoryAppendRealRun.ts calls buildHplanCalendarUrl with hotelNo + target.fSyu.",
    normalization_path: "src/services/autoHistoryAppendRealRun.ts maps isFull/non-vacant zero-price observations to availability_status=sold_out and sourceClassification=rakuten_day_sold_out.",
    downstream_path: "AI context packs aggregate sold_out rows into sold_out_row_count, sold_out_count, sold_out_ratio, and demand_signal_level without source_context_type.",
    root_cause: "AUTO08X lacked source_context_type and treated room-type/f_syu calendar full days as property-level market sold-out pressure.",
    evidence_snippets: snippets
  };
}

export function recommendedFixPlan(): string[] {
  return [
    "Do not use the 116 AUTO08X rows for DB/context sold_out pressure until correction is approved.",
    "Recommend Option A: approved revert of the 116 AUTO08X rows from .data/history, then resync DB from clean history, then rebuild AI context packs.",
    "Preserve this audit report/debug artifacts as evidence that the rows are room-type/f_syu-level negative availability evidence.",
    "Before any new Rakuten automation, patch collector normalization to emit source_context_type and context-level sold-out classifications.",
    "Regenerate AI context only after corrected history/DB state is approved and applied."
  ];
}

export function buildRakutenSoldOutSemanticsAudit(input: {
  runId: string;
  generatedAtJst: string;
  historyRows: HistoryRowLike[];
  dbRows: HistoryRowLike[];
  beforeSoldOutRowCount: number;
  latestSoldOutRowCount: number;
  latestDemandRows: { sold_out_count?: number; row_count?: number; checkin_date?: string }[];
  codeSnippets: string[];
}): RakutenSoldOutSemanticsAudit {
  const affectedHistoryRows = summarizeAffectedRows(input.historyRows);
  const affectedDbRows = summarizeAffectedRows(input.dbRows);
  const evidence = buildContradictionEvidence();
  const context = buildContextContaminationSummary({
    beforeSoldOutRowCount: input.beforeSoldOutRowCount,
    latestSoldOutRowCount: input.latestSoldOutRowCount,
    latestDemandRows: input.latestDemandRows,
    latestMarketSnapshotPath: ".data/ai-context/latest_market_snapshot.json",
    latestDemandContextPath: ".data/ai-context/latest_demand_context.json"
  });
  const semanticsClassification = classifySoldOutSemantics({
    fSyu: evidence.map((e) => e.f_syu).join(","),
    roomName: evidence.map((e) => e.room_context).join(","),
    independentContextCount: 1,
    planListNoAvailability: false
  });
  const decision: RakutenSoldOutSemanticsAuditDecision =
    affectedHistoryRows.count > 0 && affectedDbRows.count > 0
      ? "rakuten_sold_out_semantics_audit_basis_caution"
      : "rakuten_sold_out_semantics_audit_not_ready";
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision,
    affected_history_rows: affectedHistoryRows,
    affected_db_rows: affectedDbRows,
    affected_context: context,
    semantics_classification: semanticsClassification,
    semantics_result: "AUTO08X rows are useful as room-type/f_syu-level negative availability evidence, but unsafe as property-level sold_out pressure.",
    contradiction_evidence: evidence,
    code_path_audit: buildCodePathAudit(input.codeSnippets),
    quarantine_options: quarantineOptions(),
    recommended_fix_plan: recommendedFixPlan(),
    collector_fix_proposal: collectorFixProposal(),
    safety_confirmation: {
      historyModified: false,
      dbWrites: false,
      dbSyncRun: false,
      aiContextRefreshed: false,
      broadCollectorsRun: false,
      playwrightUsed: false,
      liveExternalFetch: false,
      githubActionsActivated: false,
      gitCommitOrPush: false,
      paidSourceTooling: false
    }
  };
}

export function renderRakutenSoldOutSemanticsAuditCsv(audit: RakutenSoldOutSemanticsAudit): string {
  const rows = [
    ["summary", "decision", audit.decision],
    ["summary", "semantics_classification", audit.semantics_classification],
    ["affected", "history_rows", String(audit.affected_history_rows.count)],
    ["affected", "db_rows", String(audit.affected_db_rows.count)],
    ["affected", "context_delta_sold_out", String(audit.affected_context.delta_sold_out_row_count)],
    ...audit.quarantine_options.map((o) => ["quarantine_option", o.option, `${o.title}: ${o.recommendation}`]),
    ...audit.collector_fix_proposal.new_classifications.map((c) => ["collector_classification", c, "proposed"])
  ];
  return `section,key,value\n${rows.map((r) => r.map(csvEscape).join(",")).join("\n")}\n`;
}

export function renderRakutenSoldOutSemanticsAuditMarkdown(audit: RakutenSoldOutSemanticsAudit): string {
  return [
    "# Rakuten Sold-Out Semantics Audit",
    "",
    `Generated at: ${audit.generated_at_jst}`,
    `Decision: ${audit.decision}`,
    "",
    "## 1. Summary",
    "",
    audit.semantics_result,
    "",
    "## 2. Affected Rows",
    "",
    `- history_rows=${audit.affected_history_rows.count}`,
    `- db_rows=${audit.affected_db_rows.count}`,
    `- context_sold_out_delta=${audit.affected_context.delta_sold_out_row_count}`,
    "",
    "## 3. Semantics Audit Result",
    "",
    `- classification=${audit.semantics_classification}`,
    "- property_level_sold_out_confirmed=false",
    "",
    "## 4. Contradiction Evidence",
    "",
    ...audit.contradiction_evidence.map((e) => `- ${e.canonical_property_name} hotelNo=${e.hotel_no} f_syu=${e.f_syu}: ${e.room_context}; ${e.conclusion}`),
    "",
    "## 5. Code-path Audit",
    "",
    `- build_url_path=${audit.code_path_audit.build_url_path}`,
    `- normalization_path=${audit.code_path_audit.normalization_path}`,
    `- downstream_path=${audit.code_path_audit.downstream_path}`,
    `- root_cause=${audit.code_path_audit.root_cause}`,
    ...audit.code_path_audit.evidence_snippets.map((s) => `- snippet=${s}`),
    "",
    "## 6. Quarantine / Correction Options",
    "",
    ...audit.quarantine_options.flatMap((o) => [
      `### Option ${o.option} — ${o.title}`,
      `- action=${o.action}`,
      `- pros=${o.pros.join(" | ")}`,
      `- cons=${o.cons.join(" | ")}`,
      `- recommendation=${o.recommendation}`,
      ""
    ]),
    "## 7. Recommended Fix Plan",
    "",
    ...audit.recommended_fix_plan.map((s) => `- ${s}`),
    "",
    "## 8. Collector Fix Proposal",
    "",
    `- source_context_types=${audit.collector_fix_proposal.source_context_types.join(", ")}`,
    `- fields_to_persist=${audit.collector_fix_proposal.fields_to_persist.join(", ")}`,
    `- new_classifications=${audit.collector_fix_proposal.new_classifications.join(", ")}`,
    ...audit.collector_fix_proposal.rules.map((r) => `- rule=${r}`),
    "",
    "## 9. Safety Confirmation",
    "",
    ...Object.entries(audit.safety_confirmation).map(([k, v]) => `- ${k}=${v}`),
    ""
  ].join("\n");
}

function sourceSlugFromRaw(row: HistoryRowLike): string | undefined {
  if (!row.raw_json) return undefined;
  try {
    const parsed = JSON.parse(row.raw_json) as Record<string, unknown>;
    return typeof parsed["source_slug_or_code"] === "string"
      ? parsed["source_slug_or_code"]
      : typeof parsed["sourceSlugOrCode"] === "string"
        ? parsed["sourceSlugOrCode"]
        : undefined;
  } catch {
    return undefined;
  }
}

function dpUsageFromRow(row: HistoryRowLike): string {
  if (row.is_price_excluded_from_dp === "true") return "excluded";
  return "";
}

function countBy(rows: HistoryRowLike[], keyFn: (row: HistoryRowLike) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row) || "(blank)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

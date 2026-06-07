// Phase AUTO-RUNNER-DISCOVERY02 - human review decision pack.
//
// Decision-support only. This module never updates the property master, never
// updates collector targets, never appends history, never syncs DB, never
// refreshes AI context, and never performs network collection.

import type { DiscoveryCandidateRow, DiscoveryClassification, HumanDecision } from "./propertyDiscovery";

export type SuggestedHumanDecision =
  | "approve_new"
  | "approve_alias"
  | "reject_duplicate"
  | "reject_out_of_scope"
  | "reject_inactive"
  | "hold";

export type ReviewPriority = "high" | "medium" | "low";
export type CollectorReadiness = "already_covered" | "needs_alias_only" | "needs_mapping" | "unknown" | "not_applicable";
export type DecisionConfidence = "high" | "medium" | "low";

export interface DiscoveryReviewRow {
  candidate_name: string;
  normalized_name: string;
  classification: DiscoveryClassification;
  confidence: number;
  matched_existing_property: string;
  matched_existing_key: string;
  recommended_action_from_discovery: string;
  suggested_human_decision: SuggestedHumanDecision;
  decision_confidence: DecisionConfidence;
  review_priority: ReviewPriority;
  collector_readiness: CollectorReadiness;
  source_evidence_count: number;
  source_evidence_summary: string;
  reason_codes: string[];
  decision_reason: string;
  required_next_step: string;
  human_decision: "";
  human_notes: "";
}

export interface DiscoveryReviewPack {
  decision: "auto_runner_discovery02_review_pack_ready";
  run_id: string;
  generated_at_jst: string;
  input_artifact_path: string;
  mode: "dry_run_review_pack";
  rows: DiscoveryReviewRow[];
  summary: {
    total_candidates: number;
    suggested_decision_counts: Record<string, number>;
    collector_readiness_counts: Record<string, number>;
    review_priority_counts: Record<string, number>;
    high_priority_review_count: number;
    d05_ready: false;
    d05_reason: "waiting_for_human_decisions";
    safety_confirmation: {
      network_collection_executed: false;
      live_collector_run: false;
      history_modified: false;
      db_synced: false;
      ai_context_refreshed: false;
      property_master_written: false;
      collector_target_updated: false;
      pricing_or_pms_output_generated: false;
    };
  };
  next_recommended_action: "Fill human_decision and human_notes, then run D05 approved properties master update.";
}

export const DISCOVERY_REVIEW_CSV_HEADERS = [
  "candidate_name",
  "normalized_name",
  "classification",
  "confidence",
  "matched_existing_property",
  "matched_existing_key",
  "recommended_action_from_discovery",
  "suggested_human_decision",
  "decision_confidence",
  "review_priority",
  "collector_readiness",
  "source_evidence_count",
  "source_evidence_summary",
  "reason_codes",
  "decision_reason",
  "required_next_step",
  "human_decision",
  "human_notes"
] as const;

export function buildDecisionRow(row: DiscoveryCandidateRow): DiscoveryReviewRow {
  const suggestion = suggestDecision(row);
  return {
    candidate_name: row.candidate_name,
    normalized_name: row.normalized_name,
    classification: row.classification,
    confidence: row.confidence,
    matched_existing_property: row.matched_existing_property,
    matched_existing_key: row.matched_existing_key,
    recommended_action_from_discovery: row.recommended_action,
    suggested_human_decision: suggestion.suggested_human_decision,
    decision_confidence: suggestion.decision_confidence,
    review_priority: reviewPriorityFor(suggestion.suggested_human_decision),
    collector_readiness: collectorReadinessFor(row.classification, suggestion.suggested_human_decision),
    source_evidence_count: row.source_evidence_count,
    source_evidence_summary: row.source_evidence_summary,
    reason_codes: row.reason_codes,
    decision_reason: suggestion.decision_reason,
    required_next_step: suggestion.required_next_step,
    human_decision: "",
    human_notes: ""
  };
}

export function buildDiscoveryReviewPack(input: {
  runId: string;
  generatedAtJst: string;
  inputArtifactPath: string;
  rows: readonly DiscoveryCandidateRow[];
}): DiscoveryReviewPack {
  const rows = input.rows.map(buildDecisionRow);
  return {
    decision: "auto_runner_discovery02_review_pack_ready",
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    input_artifact_path: input.inputArtifactPath,
    mode: "dry_run_review_pack",
    rows,
    summary: {
      total_candidates: rows.length,
      suggested_decision_counts: countBy(rows.map((r) => r.suggested_human_decision)),
      collector_readiness_counts: countBy(rows.map((r) => r.collector_readiness)),
      review_priority_counts: countBy(rows.map((r) => r.review_priority)),
      high_priority_review_count: rows.filter((r) => r.review_priority === "high").length,
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

export function parseDiscoveryRowsFromJson(json: string): DiscoveryCandidateRow[] {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("property_discovery_input_invalid_json");
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new Error("property_discovery_input_missing_rows");
  return rows.map(normalizeDiscoveryRow);
}

export function parseDiscoveryRowsFromCsv(csv: string): DiscoveryCandidateRow[] {
  const records = parseCsv(csv);
  return records.map((r) =>
    normalizeDiscoveryRow({
      ...r,
      confidence: Number(r["confidence"] ?? 0),
      source_evidence_count: Number(r["source_evidence_count"] ?? 0),
      recommended_action: r["recommended_action"] ?? "",
      reason_codes: String(r["reason_codes"] ?? "").split("|").filter(Boolean)
    })
  );
}

export function selectLatestDiscoveryArtifact(paths: readonly string[]): string {
  const preferred = [...paths].filter((p) => /property_discovery_\d{8}_\d{6}\.json$/u.test(p)).sort().at(-1);
  if (preferred) return preferred;
  const csv = [...paths].filter((p) => /property_discovery_\d{8}_\d{6}\.csv$/u.test(p)).sort().at(-1);
  if (csv) return csv;
  throw new Error("property_discovery_input_missing");
}

export function renderDiscoveryReviewCsv(rows: readonly DiscoveryReviewRow[]): string {
  return [
    DISCOVERY_REVIEW_CSV_HEADERS.join(","),
    ...rows.map((row) =>
      DISCOVERY_REVIEW_CSV_HEADERS.map((h) => csvEscape(h === "reason_codes" ? row.reason_codes.join("|") : String(row[h] ?? ""))).join(",")
    )
  ].join("\n") + "\n";
}

export function renderDiscoveryReviewJson(pack: DiscoveryReviewPack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export function renderDiscoveryReviewMarkdown(pack: DiscoveryReviewPack): string {
  const byDecision = (d: SuggestedHumanDecision): DiscoveryReviewRow[] => pack.rows.filter((r) => r.suggested_human_decision === d);
  const bullets = (rows: readonly DiscoveryReviewRow[]): string[] =>
    rows.length === 0
      ? ["- none"]
      : rows.map((r) => `- ${r.candidate_name}: ${r.suggested_human_decision}, priority=${r.review_priority}, readiness=${r.collector_readiness}, reason=${r.decision_reason}`);

  return [
    "# Property Discovery Human Review Decision Pack",
    "",
    `- run timestamp JST: ${pack.generated_at_jst}`,
    `- input artifact path: ${pack.input_artifact_path}`,
    `- mode: ${pack.mode}`,
    `- decision: ${pack.decision}`,
    `- total candidates: ${pack.summary.total_candidates}`,
    "",
    "## Suggested Decision Counts",
    ...objectLines(pack.summary.suggested_decision_counts),
    "",
    "## Collector Readiness Summary",
    ...objectLines(pack.summary.collector_readiness_counts),
    "",
    "## approve_new Candidates",
    ...bullets(byDecision("approve_new")),
    "",
    "## approve_alias Candidates",
    ...bullets(byDecision("approve_alias")),
    "",
    "## reject_duplicate Candidates",
    ...bullets(byDecision("reject_duplicate")),
    "",
    "## hold Candidates",
    ...bullets(byDecision("hold")),
    "",
    "## Rejected Candidates",
    ...bullets([...byDecision("reject_out_of_scope"), ...byDecision("reject_inactive")]),
    "",
    "## High-Priority Review List",
    ...bullets(pack.rows.filter((r) => r.review_priority === "high")),
    "",
    "## Human Approval Instructions",
    "- Fill human_decision with approve_new, approve_alias, reject_duplicate, reject_out_of_scope, reject_inactive, or hold.",
    "- Fill human_notes with reviewer evidence or rationale.",
    "- Do not apply this pack automatically; D05 is the only phase allowed to update master data after explicit approval.",
    "",
    "## D05 Readiness Summary",
    `- d05_ready: ${pack.summary.d05_ready}`,
    `- reason: ${pack.summary.d05_reason}`,
    "- approve_new rows still require inactive-first master addition details and collector mapping dry-run.",
    "- approve_alias rows require matched_existing_property confirmation.",
    "",
    "## Safety",
    ...Object.entries(pack.summary.safety_confirmation).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Next Recommended Action",
    `- ${pack.next_recommended_action}`,
    ""
  ].join("\n");
}

function suggestDecision(row: DiscoveryCandidateRow): {
  suggested_human_decision: SuggestedHumanDecision;
  decision_confidence: DecisionConfidence;
  decision_reason: string;
  required_next_step: string;
} {
  switch (row.classification) {
    case "duplicate_candidate":
      return {
        suggested_human_decision: "reject_duplicate",
        decision_confidence: "high",
        decision_reason: "Already represented in existing collector target or known mapping.",
        required_next_step: "none"
      };
    case "alias_candidate":
      return {
        suggested_human_decision: "approve_alias",
        decision_confidence: row.matched_existing_property ? "medium" : "low",
        decision_reason: "Likely same property, but display naming differs.",
        required_next_step: "add alias to existing property after human confirmation"
      };
    case "new_candidate":
      if (isHighConfidenceNew(row)) {
        return {
          suggested_human_decision: "approve_new",
          decision_confidence: "medium",
          decision_reason: "Lodging-like candidate with no strong existing match and no obvious out-of-scope signal.",
          required_next_step: "add as inactive first, then create collector mapping dry-run, then active=true only after verification"
        };
      }
      return {
        suggested_human_decision: "hold",
        decision_confidence: "low",
        decision_reason: "New candidate needs human verification before it can be treated as lodging and mapped to OTA sources.",
        required_next_step: "human verify lodging status and OTA mapping"
      };
    case "hold_candidate":
      return {
        suggested_human_decision: "hold",
        decision_confidence: "medium",
        decision_reason: "Discovery marked this row as needing human review before any master update.",
        required_next_step: "human verify before any master update"
      };
    case "out_of_scope_candidate":
      return {
        suggested_human_decision: "reject_out_of_scope",
        decision_confidence: "high",
        decision_reason: "Candidate appears outside lodging/target scope.",
        required_next_step: "none"
      };
    case "closed_or_inactive_candidate":
      return {
        suggested_human_decision: "reject_inactive",
        decision_confidence: "high",
        decision_reason: "Candidate appears closed or inactive.",
        required_next_step: "none unless reactivation evidence appears"
      };
    default:
      return {
        suggested_human_decision: "hold",
        decision_confidence: "low",
        decision_reason: "Unknown classification; fail closed for human review.",
        required_next_step: "human verify before any master update"
      };
  }
}

function isHighConfidenceNew(row: DiscoveryCandidateRow): boolean {
  const reasonText = row.reason_codes.join("|").toLowerCase();
  const evidenceText = `${row.source_evidence_summary} ${row.notes}`.toLowerCase();
  const uncertain = /unclear|unknown|hold|mixed|restaurant|day-use|outside|private rental/iu.test(`${reasonText} ${evidenceText}`);
  return row.confidence >= 0.75 && row.matched_existing_property === "" && reasonText.includes("lodging_name_candidate") && !uncertain;
}

function reviewPriorityFor(decision: SuggestedHumanDecision): ReviewPriority {
  if (decision === "approve_new" || decision === "hold") return "high";
  if (decision === "approve_alias") return "medium";
  return "low";
}

function collectorReadinessFor(classification: DiscoveryClassification, decision: SuggestedHumanDecision): CollectorReadiness {
  if (classification === "duplicate_candidate") return "already_covered";
  if (classification === "alias_candidate") return "needs_alias_only";
  if (classification === "new_candidate" && decision === "approve_new") return "needs_mapping";
  if (classification === "new_candidate" && decision === "hold") return "unknown";
  if (classification === "hold_candidate") return "unknown";
  if (classification === "out_of_scope_candidate" || classification === "closed_or_inactive_candidate") return "not_applicable";
  return "unknown";
}

function normalizeDiscoveryRow(row: unknown): DiscoveryCandidateRow {
  if (!row || typeof row !== "object") throw new Error("property_discovery_input_invalid_row");
  const r = row as Record<string, unknown>;
  const reason = r["reason_codes"];
  return {
    candidate_name: s(r["candidate_name"]),
    normalized_name: s(r["normalized_name"]),
    classification: s(r["classification"]) as DiscoveryClassification,
    confidence: Number(r["confidence"] ?? 0),
    matched_existing_property: s(r["matched_existing_property"]),
    matched_existing_key: s(r["matched_existing_key"]),
    recommended_action: s(r["recommended_action"]) as HumanDecision,
    human_decision: "",
    source_evidence_count: Number(r["source_evidence_count"] ?? 0),
    source_evidence_summary: s(r["source_evidence_summary"]),
    reason_codes: Array.isArray(reason) ? reason.map(String) : s(reason).split("|").filter(Boolean),
    notes: s(r["notes"])
  };
}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function objectLines(obj: Record<string, number>): string[] {
  const entries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? ["- none"] : entries.map(([k, v]) => `- ${k}: ${v}`);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, '""')}"`;
  return value;
}

function parseCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const out: Record<string, string> = {};
    headers.forEach((h, i) => { out[h] = values[i] ?? ""; });
    return out;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

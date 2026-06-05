// Phase BOOKING-B10Z — build the Booking bounded append proposal under the
// ID02X observation-identity policy. READ-ONLY: it reads local artifacts (B09X
// collection, B10X append proposal, B10Y conflict proposal, ID02X identity) and
// the current .data/history identity snapshot, then writes report/json/csv +
// debug artifacts. It never appends history, never writes or syncs the DB, never
// refreshes AI context, never makes a live Booking request, never runs browser
// automation or a collector, and applies no synthetic Booking tax multiplier.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildFutureB11XPlan,
  buildIdentityPolicy,
  buildPricePressurePolicy,
  buildProposalRows,
  buildSafetyConfirmation,
  decideB10Z,
  renderProposalCsv,
  summarizeProposal,
  type B09XIdentityPreviewRow,
  type B10ZDecision,
  type B10ZProposalRow,
  type B10ZProposalSummary,
  type CurrentHistorySummary,
  type ExistingHistoryKey
} from "../services/bookingBoundedAppendProposalWithIdentity";
import type { B10YConflictRow } from "../services/bookingObservationIdentity";

const B09X_ARTIFACT = ".data/reports/source-discovery/booking_bounded_expanded_collection_20260604_161623.json";
const B10X_ARTIFACT = ".data/reports/automation/booking_bounded_history_append_proposal_20260604_163035.json";
const B10Y_ARTIFACT = ".data/reports/automation/booking_conflict_resolution_proposal_20260604_163851.json";
const ID02X_ARTIFACT = ".data/reports/automation/booking_observation_identity_20260604_190243.json";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-bounded-append-with-identity-proposal";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function readExistingHistory(): { keys: ExistingHistoryKey[]; summary: CurrentHistorySummary; parsed: boolean } {
  try {
    const dir = resolve(HISTORY_DIR);
    const files = readdirSync(dir)
      .filter((file) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(file))
      .sort();
    const keys: ExistingHistoryKey[] = [];
    const rowsByShard: Record<string, number> = {};
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
      const shardMonth = /^zao_signals_(\d{4}_\d{2})\.csv$/u.exec(file)?.[1] ?? "unknown";
      let rowCount = 0;
      for (const line of lines.slice(1)) {
        const [row_id = "", row_hash = ""] = line.split(",");
        if (!row_id) continue;
        keys.push({ row_id, row_hash, shard_month: shardMonth });
        rowCount += 1;
      }
      rowsByShard[shardMonth] = rowCount;
    }
    return {
      keys,
      summary: {
        total_rows: keys.length,
        rows_by_shard: rowsByShard,
        source_files: files.map((file) => join(HISTORY_DIR, file))
      },
      parsed: true
    };
  } catch {
    return { keys: [], summary: { total_rows: 0, rows_by_shard: {}, source_files: [] }, parsed: false };
  }
}

function main(): void {
  const ts = timestamp();
  const runId = `booking_bounded_append_with_identity_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const b09xLoaded = existsSync(resolve(B09X_ARTIFACT));
  const b10xLoaded = existsSync(resolve(B10X_ARTIFACT));
  const b10yLoaded = existsSync(resolve(B10Y_ARTIFACT));
  const id02xLoaded = existsSync(resolve(ID02X_ARTIFACT));

  const b09x = b09xLoaded ? readJson<Record<string, unknown>>(B09X_ARTIFACT) : null;
  const b10x = b10xLoaded ? readJson<Record<string, unknown>>(B10X_ARTIFACT) : null;
  const b10y = b10yLoaded ? readJson<Record<string, unknown>>(B10Y_ARTIFACT) : null;
  const id02x = id02xLoaded ? readJson<Record<string, unknown>>(ID02X_ARTIFACT) : null;

  const b09xRows = ((b09x?.["normalized_rows_preview"] ?? []) as B09XIdentityPreviewRow[]) ?? [];
  const b10yConflicts = ((b10y?.["conflict_comparison_rows"] ?? []) as B10YConflictRow[]) ?? [];

  const { keys, summary: currentHistorySummary, parsed: historyParsed } = readExistingHistory();

  const proposalRows: B10ZProposalRow[] = buildProposalRows(b09xRows, keys, b10yConflicts);
  const summary: B10ZProposalSummary = summarizeProposal(proposalRows, currentHistorySummary);
  const anyObservationIdDegraded = proposalRows.some((r) => r.observation_id_degraded);

  const decision: B10ZDecision = decideB10Z({
    b09xLoaded: b09xLoaded && b09xRows.length > 0,
    id02xLoaded,
    historyParsed,
    summary,
    anyObservationIdDegraded
  });

  const identityPolicy = buildIdentityPolicy();
  const pricePressurePolicy = buildPricePressurePolicy();
  const futureB11xPlan = buildFutureB11XPlan(summary);
  const safety = buildSafetyConfirmation();
  const safetyAllClean = Object.values(safety).every((v) => v === false);

  const sourceArtifacts = {
    b09x: { path: B09X_ARTIFACT, loaded: b09xLoaded, decision: b09x?.["decision"] ?? null, preview_rows: b09xRows.length },
    b10x: { path: B10X_ARTIFACT, loaded: b10xLoaded, decision: b10x?.["decision"] ?? null },
    b10y: { path: B10Y_ARTIFACT, loaded: b10yLoaded, decision: b10y?.["decision"] ?? null, conflict_rows: b10yConflicts.length },
    id02x: { path: ID02X_ARTIFACT, loaded: id02xLoaded, decision: id02x?.["decision"] ?? null }
  };

  const reclassificationSummary = {
    conflict_rows_total: b10yConflicts.length,
    metadata_only_to_skip_benign_duplicate: summary.skip_benign_duplicate_count,
    market_value_to_append_new_observation_after_identity_fix: summary.append_new_observation_after_identity_fix_count,
    block_true_conflict: summary.block_true_conflict_count,
    manual_review: summary.manual_review_count
  };

  const identityExamples = proposalRows
    .filter((r) => r.history_action === "append_new" || r.history_action === "append_new_observation_after_identity_fix")
    .slice(0, 4)
    .map((r) => ({
      new_row_id: r.new_row_id,
      history_action: r.history_action,
      conflict_classification: r.conflict_classification,
      market_identity_key: r.market_identity_key,
      market_identity_plain_key: r.market_identity_plain_key,
      observation_id: r.observation_id,
      observation_id_basis: r.observation_id_basis,
      market_value_hash: r.market_value_hash,
      observation_hash: r.observation_hash,
      existing_row_hash: r.existing_row_hash,
      new_row_hash: r.new_row_hash
    }));

  const report = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_artifacts: sourceArtifacts,
    current_history_summary: currentHistorySummary,
    proposal_summary: summary,
    proposal_rows: proposalRows,
    reclassification_summary: reclassificationSummary,
    price_pressure_policy: pricePressurePolicy,
    identity_policy: identityPolicy,
    future_b11x_plan: futureB11xPlan,
    safety_confirmation: { ...safety, safety_all_clean: safetyAllClean },
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(reportPath, renderReport(report), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderProposalCsv(proposalRows), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_b09x_artifact.json", { path: B09X_ARTIFACT, loaded: b09xLoaded, preview_rows: b09xRows.length });
  writeDebug("source_b10x_artifact.json", { path: B10X_ARTIFACT, loaded: b10xLoaded, decision: b10x?.["decision"] ?? null });
  writeDebug("source_b10y_artifact.json", { path: B10Y_ARTIFACT, loaded: b10yLoaded, conflict_rows: b10yConflicts.length });
  writeDebug("source_id02x_artifact.json", { path: ID02X_ARTIFACT, loaded: id02xLoaded, decision: id02x?.["decision"] ?? null });
  writeDebug("existing_history_identity_index.json", { summary: currentHistorySummary, keys });
  writeDebug("proposal_rows.json", proposalRows);
  writeDebug("reclassification_summary.json", reclassificationSummary);
  writeDebug("identity_examples.json", identityExamples);
  writeDebug("future_b11x_plan.json", futureB11xPlan);
  writeDebug("safety_confirmation.json", { ...safety, safety_all_clean: safetyAllClean });

  console.log(`decision=${decision}`);
  console.log(`proposal_rows=${summary.proposal_row_count}`);
  console.log(`append_new=${summary.append_new_count}`);
  console.log(`skip_benign_duplicate=${summary.skip_benign_duplicate_count}`);
  console.log(`append_new_observation_after_identity_fix=${summary.append_new_observation_after_identity_fix_count}`);
  console.log(`block_true_conflict=${summary.block_true_conflict_count} manual_review=${summary.manual_review_count}`);
  console.log(`total_appendable=${summary.total_appendable_count} expected_total_after_append=${summary.expected_total_after_append}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);

  const acceptable = new Set<B10ZDecision>([
    "booking_bounded_append_with_identity_proposal_ready",
    "booking_bounded_append_with_identity_proposal_basis_caution"
  ]);
  if (!acceptable.has(decision)) process.exitCode = 1;
}

function renderReport(report: Record<string, any>): string {
  const sm = report.proposal_summary as B10ZProposalSummary;
  const rows = report.proposal_rows as B10ZProposalRow[];
  const sa = report.source_artifacts as Record<string, { path: string; loaded: boolean; decision: unknown }>;
  const lines: string[] = [
    "# Booking Bounded Append Proposal With Identity Policy",
    "",
    `Generated at JST: ${report.generated_at_jst}`,
    `Run ID: ${report.run_id}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${report.decision}`,
    `- proposal_rows=${sm.proposal_row_count}`,
    `- append_new=${sm.append_new_count}`,
    `- skip_benign_duplicate=${sm.skip_benign_duplicate_count}`,
    `- append_new_observation_after_identity_fix=${sm.append_new_observation_after_identity_fix_count}`,
    `- block_true_conflict=${sm.block_true_conflict_count}, manual_review=${sm.manual_review_count}`,
    `- total_appendable=${sm.total_appendable_count}, expected_total_after_append=${sm.expected_total_after_append}`,
    "",
    "## 2. Source Artifacts",
    "",
    ...Object.entries(sa).map(([k, v]) => `- ${k}: ${v.path} (loaded=${v.loaded}, decision=${String(v.decision)})`),
    "",
    "## 3. Current History State",
    "",
    `- total_rows=${report.current_history_summary.total_rows}`,
    `- rows_by_shard=${JSON.stringify(report.current_history_summary.rows_by_shard)}`,
    "",
    "## 4. Proposal Action Breakdown",
    "",
    ...Object.entries(sm.action_breakdown).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 5. Conflict Classification Breakdown",
    "",
    ...Object.entries(sm.classification_breakdown).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 6. Identity Policy",
    "",
    `- ${report.identity_policy.policy}`,
    `- ${report.identity_policy.legacy_row_id_collision_rule}`,
    `- never_overwrites_existing_rows=${report.identity_policy.never_overwrites_existing_rows}`,
    `- observation_id_rule: ${report.identity_policy.observation_id_rule}`,
    "",
    "## 7. Reclassified Conflict Rows (Case C)",
    "",
    "| row_id | history_action | conflict_classification | append_recommendation |",
    "| --- | --- | --- | --- |",
    ...rows
      .filter((r) => r.existing_row_hash !== "" && r.history_action !== "append_new")
      .map((r) => `| ${r.new_row_id} | ${r.history_action} | ${r.conflict_classification} | ${r.append_recommendation} |`),
    "",
    "## 8. Append-New Rows (Case A)",
    "",
    `- append_directional=${sm.append_directional_count}`,
    `- append_excluded_audit=${sm.append_excluded_audit_count}`,
    "",
    "## 9. Price Pressure Policy",
    "",
    "- B-confidence directional rows: append_directional, price_pressure_usable=true, dp_usable=false.",
    "- C-confidence excluded rows: append_excluded_audit, price_pressure_usable=false, dp_usable=false.",
    "- Booking direct rows remain zero. No property-management or channel-manager price action. No Booking base x 1.1.",
    "",
    "## 10. Future B11X Plan",
    "",
    `- ${report.future_b11x_plan.phase}`,
    `- status=${report.future_b11x_plan.status}`,
    `- appendable_rows=${report.future_b11x_plan.appendable_rows}`,
    `- expected_total_after_append=${report.future_b11x_plan.expected_total_after_append}`,
    "- B11X must not start without explicit instruction.",
    "",
    "## 11. Safety Confirmation",
    "",
    ...Object.entries(report.safety_confirmation as Record<string, boolean>).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 12. Decision",
    "",
    `- ${report.decision}`,
    "",
    "## 13. Next Step",
    "",
    "- BOOKING-B11X — Approved Booking bounded append with identity policy (do not start without explicit instruction).",
    "",
    "## Output Paths",
    "",
    `- report_path=${report.report_path}`,
    `- json_path=${report.json_path}`,
    `- csv_path=${report.csv_path}`,
    `- debug_artifact_path=${report.debug_artifact_path}`,
    ""
  ];
  return lines.join("\n");
}

main();

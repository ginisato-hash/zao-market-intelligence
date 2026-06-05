// Phase BOOKING-ID02X — build the observation-identity helper + conflict-policy
// report. This script is READ-ONLY: it reads local artifacts (ID01X design,
// B10Y conflict proposal) and writes report/json/csv + debug artifacts. It never
// touches .data/history, never writes the DB, never migrates, never fetches
// Booking, never runs a collector, and contains no Booking base × 1.1 logic.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMarketIdentityKey,
  buildMarketIdentityPlainKey,
  buildMarketValueHash,
  buildObservationHash,
  buildObservationIdResult,
  classifyObservationConflict,
  decideObservationIdentity,
  deriveIdentity,
  reclassifyB10YConflict,
  summarizeReclassification,
  ALWAYS_EXCLUDED_FROM_IDENTITY,
  MARKET_IDENTITY_FIELDS,
  MARKET_VALUE_FIELDS,
  OBSERVATION_HASH_FIELDS,
  type B10YConflictRow,
  type BookingLikeHistoryRow,
  type ConflictPolicySummary,
  type ObservationIdentityDecision,
  type ReclassifiedConflictRow
} from "../services/bookingObservationIdentity";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-observation-identity";
const ID01X_ARTIFACT = ".data/reports/automation/booking_row_identity_design_20260604_165107.json";
const B10Y_ARTIFACT = ".data/reports/automation/booking_conflict_resolution_proposal_20260604_163851.json";

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

interface HelperExample {
  label: string;
  row: BookingLikeHistoryRow;
  derived: ReturnType<typeof deriveIdentity>;
}

function buildHelperExamples(conflicts: B10YConflictRow[]): HelperExample[] {
  const examples: HelperExample[] = [];
  const first = conflicts[0];
  if (first) {
    const existing: BookingLikeHistoryRow = {
      row_id: first.row_id,
      row_hash: first.existing_row_hash,
      source: "booking",
      canonical_property_name: first.canonical_property_name,
      source_slug_or_code: first.source_slug_or_code,
      checkin: first.checkin,
      checkout: first.checkout,
      stay_scope: first.row_id.split("|").pop() ?? "",
      ...first.existing_values
    };
    const incoming: BookingLikeHistoryRow = {
      row_id: first.row_id,
      row_hash: first.new_b09x_row_hash,
      source: "booking",
      canonical_property_name: first.canonical_property_name,
      source_slug_or_code: first.source_slug_or_code,
      checkin: first.checkin,
      checkout: first.checkout,
      stay_scope: first.row_id.split("|").pop() ?? "",
      ...first.new_values
    };
    examples.push({ label: "b10y_first_conflict_existing", row: existing, derived: deriveIdentity(existing) });
    examples.push({ label: "b10y_first_conflict_new", row: incoming, derived: deriveIdentity(incoming) });
  }
  return examples;
}

function main(): void {
  const ts = timestamp();
  const runId = `booking_observation_identity_${ts}`;
  const generatedAtJst = jstIso();
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const id01xLoaded = existsSync(resolve(ID01X_ARTIFACT));
  const b10yLoaded = existsSync(resolve(B10Y_ARTIFACT));
  const id01x = id01xLoaded ? readJson<Record<string, unknown>>(ID01X_ARTIFACT) : null;
  const b10y = b10yLoaded ? readJson<Record<string, unknown>>(B10Y_ARTIFACT) : null;

  const conflicts = (b10y?.["conflict_comparison_rows"] ?? []) as B10YConflictRow[];
  const reclassified: ReclassifiedConflictRow[] = conflicts.map((c) => reclassifyB10YConflict(c));
  const summary: ConflictPolicySummary = summarizeReclassification(reclassified);
  const helperExamples = buildHelperExamples(conflicts);
  const anyDegraded = reclassified.length > 0 && helperExamples.some((e) => e.derived.observation_id_degraded);

  const safety = {
    history_modified: false,
    db_written: false,
    db_schema_migrated: false,
    db_sync_run: false,
    ai_context_refreshed: false,
    live_booking_fetch: false,
    playwright_used: false,
    collector_run: false,
    pms_or_ota_output: false,
    price_update: false,
    booking_times_1_1: false,
    github_actions_or_cron_or_gitops: false,
    git_commit_or_push: false,
    paid_sources: false,
    started_b10z: false,
    rakuten_restarted: false,
    jalan_started: false
  };
  const safetyAllClean = Object.values(safety).every((v) => v === false);

  const decision: ObservationIdentityDecision = decideObservationIdentity({
    b10y_loaded: b10yLoaded && conflicts.length > 0,
    summary,
    any_observation_id_degraded: anyDegraded,
    safety_all_clean: safetyAllClean
  });

  const identityModel = {
    policy: "ID01X Option C — preserve legacy v1 row_id; add derived market_identity_key, observation_id, market_value_hash, observation_hash.",
    market_identity_key_fields: [...MARKET_IDENTITY_FIELDS],
    observation_id_rule: "sha256(market_identity_key + collected_run_id||collected_at_jst + source_phase + collector_stage); prefer collected_run_id, fall back to collected_at_jst, never Date.now()/generated_at_jst.",
    market_value_hash_fields: [...MARKET_VALUE_FIELDS],
    observation_hash_fields: [...OBSERVATION_HASH_FIELDS],
    always_excluded_from_identity: [...ALWAYS_EXCLUDED_FROM_IDENTITY],
    never_overwrites_existing_rows: true,
    no_booking_base_times_1_1: true
  };

  const helperDefinitions = {
    buildMarketIdentityKey: "Groups all observations of one market object. sha256 of canonical JSON of MARKET_IDENTITY_FIELDS.",
    buildMarketIdentityPlainKey: "Human-readable debug key: source|slug|checkin|checkout|stay_scope|adults|rooms|children|currency|language.",
    buildObservationId: "Uniquely identifies one observation event; prefers collected_run_id, falls back to collected_at_jst.",
    buildMarketValueHash: "Detects market-value movement; excludes phase/stage/timestamps/paths.",
    buildObservationHash: "Detects exact duplicate observation; excludes volatile debug/report paths.",
    classifyObservationConflict: "Pure conflict classifier; emits classification + recommended_action; never overwrites existing rows."
  };

  const futureB10zPlan = {
    name: "BOOKING-B10Z — Re-run Booking bounded append proposal with ID02X conflict policy",
    status: "proposed_not_executed",
    inputs: {
      b09x_new_rows: 15,
      b10y_metadata_only_conflicts: summary.metadata_only_conflicts,
      b10y_market_value_conflicts: summary.market_value_conflicts
    },
    planned_actions: {
      b09x_new_rows: "remain append_new",
      metadata_only_conflicts: "become skip_benign_duplicate",
      market_value_conflicts: "become append_new_observation_after_identity_fix (or append_new_observation_price_changed / append_new_observation_basis_changed)"
    },
    can_proceed: summary.b10z_can_proceed && decision !== "booking_observation_identity_not_ready",
    guardrails: [
      "No history append in this phase.",
      "No DB write in this phase.",
      "B10Z is proposed only; do not execute without explicit instruction."
    ]
  };

  const report = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_id01x_artifact_path: ID01X_ARTIFACT,
    source_b10y_artifact_path: B10Y_ARTIFACT,
    identity_model: identityModel,
    helper_definitions: helperDefinitions,
    helper_examples: helperExamples,
    conflict_reclassification_rows: reclassified,
    conflict_policy_summary: summary,
    future_b10z_plan: futureB10zPlan,
    safety_confirmation: { ...safety, safety_all_clean: safetyAllClean },
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(reportPath, renderReport(report, id01x), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderCsv(reclassified), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_id01x_artifact.json", { path: ID01X_ARTIFACT, loaded: id01xLoaded, decision: id01x?.["decision"] ?? null });
  writeDebug("source_b10y_artifact.json", { path: B10Y_ARTIFACT, loaded: b10yLoaded, conflict_count: conflicts.length });
  writeDebug("identity_helper_examples.json", helperExamples);
  writeDebug("conflict_reclassification_rows.json", reclassified);
  writeDebug("conflict_policy_summary.json", summary);
  writeDebug("future_b10z_plan.json", futureB10zPlan);
  writeDebug("safety_confirmation.json", { ...safety, safety_all_clean: safetyAllClean });

  console.log(`decision=${decision}`);
  console.log(`conflict_count=${summary.conflict_count}`);
  console.log(`metadata_only=${summary.metadata_only_conflicts} skip_benign_duplicate=${summary.skip_benign_duplicate_count}`);
  console.log(`market_value=${summary.market_value_conflicts} append_after_identity_fix=${summary.append_after_identity_fix_count}`);
  console.log(`price_changed=${summary.price_changed_conflicts} basis_changed=${summary.basis_changed_conflicts} availability_changed=${summary.availability_changed_conflicts}`);
  console.log(`b10z_can_proceed=${summary.b10z_can_proceed}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);

  const acceptable = new Set<ObservationIdentityDecision>([
    "booking_observation_identity_ready",
    "booking_observation_identity_basis_caution"
  ]);
  if (!acceptable.has(decision)) process.exitCode = 1;
}

function renderCsv(rows: ReclassifiedConflictRow[]): string {
  const headers = [
    "row_id",
    "id02x_classification",
    "id02x_recommended_action",
    "b10y_recommended_action",
    "market_value_changed",
    "price_changed",
    "basis_changed",
    "availability_changed"
  ];
  const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map((r) =>
    [
      r.row_id,
      r.id02x_classification,
      r.id02x_recommended_action,
      r.b10y_recommended_action,
      String(r.market_value_changed),
      String(r.price_changed),
      String(r.basis_changed),
      String(r.availability_changed)
    ]
      .map(csvCell)
      .join(",")
  );
  return [headers.join(","), ...lines].join("\n") + "\n";
}

function renderReport(report: Record<string, any>, id01x: Record<string, unknown> | null): string {
  const sm = report.conflict_policy_summary as ConflictPolicySummary;
  const lines: string[] = [
    "# Booking Observation Identity Helpers + Conflict Policy",
    "",
    `Generated at: ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `- Decision: ${report.decision}`,
    `- B10Y conflicts reclassified: ${sm.conflict_count}`,
    `- Metadata-only → skip_benign_duplicate: ${sm.skip_benign_duplicate_count}`,
    `- Market-value → append_new_observation_after_identity_fix: ${sm.append_after_identity_fix_count}`,
    `- price_changed=${sm.price_changed_conflicts}, basis_changed=${sm.basis_changed_conflicts}, availability_changed=${sm.availability_changed_conflicts}`,
    `- B10Z can proceed (no block/manual): ${sm.b10z_can_proceed}`,
    "",
    "## 2. Source ID01X Design",
    "",
    `- artifact: ${report.source_id01x_artifact_path}`,
    `- ID01X decision: ${String(id01x?.["decision"] ?? "(not loaded)")}`,
    "- Policy adopted: Option C (preserve legacy v1 row_id; add derived identity keys).",
    "",
    "## 3. Helper Definitions",
    "",
    ...Object.entries(report.helper_definitions as Record<string, string>).map(([k, v]) => `- \`${k}\`: ${v}`),
    "",
    `- market_identity_key fields: ${(report.identity_model.market_identity_key_fields as string[]).join(", ")}`,
    `- market_value_hash fields: ${(report.identity_model.market_value_hash_fields as string[]).join(", ")}`,
    `- observation_hash fields: ${(report.identity_model.observation_hash_fields as string[]).join(", ")}`,
    `- always excluded from identity: ${(report.identity_model.always_excluded_from_identity as string[]).join(", ")}`,
    "",
    "## 4. Conflict Policy Utility",
    "",
    "- `classifyObservationConflict(existingRow, newRow)` emits a classification + recommended_action.",
    "- Priority: exact_duplicate → true_observation_id_conflict → legacy_row_id_conflict → same-market new observation.",
    "- Legacy v1 collisions never overwrite/supersede; market-value collisions become new observations after the identity fix.",
    "",
    "## 5. B10Y Conflict Reclassification",
    "",
    "| row_id | ID02X classification | ID02X action | B10Y action |",
    "| --- | --- | --- | --- |",
    ...(report.conflict_reclassification_rows as ReclassifiedConflictRow[]).map(
      (r) => `| ${r.row_id} | ${r.id02x_classification} | ${r.id02x_recommended_action} | ${r.b10y_recommended_action} |`
    ),
    "",
    "## 6. Recommended Actions",
    "",
    ...Object.entries(sm.action_breakdown).map(([action, count]) => `- ${action}: ${count}`),
    "",
    "## 7. Future B10Z Plan",
    "",
    `- ${report.future_b10z_plan.name}`,
    `- status: ${report.future_b10z_plan.status}`,
    `- can_proceed: ${report.future_b10z_plan.can_proceed}`,
    "- B09X new rows remain append_new.",
    `- ${sm.metadata_only_conflicts} metadata-only conflicts → skip_benign_duplicate.`,
    `- ${sm.market_value_conflicts} market-value conflicts → append_new_observation_after_identity_fix.`,
    "- B10Z is proposed only; do not execute without explicit instruction.",
    "",
    "## 8. Safety Confirmation",
    "",
    ...Object.entries(report.safety_confirmation as Record<string, boolean>).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 9. Decision",
    "",
    `- ${report.decision}`,
    "",
    "## 10. Next Step",
    "",
    "- BOOKING-B10Z — Re-run append proposal with ID02X conflict policy (do not start without explicit instruction).",
    ""
  ];
  return lines.join("\n");
}

main();

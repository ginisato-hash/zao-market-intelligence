// Phase BOOKING-B08X — Booking.com target matrix expansion proposal.
//
// Reads only local artifacts and writes proposal/debug files. It does not fetch
// Booking.com, does not use Playwright, does not write DB/history, and does not
// refresh AI context.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCsvTable } from "../services/historyToDbSyncDryRun";
import {
  B05X_VERIFIED_SLUGS,
  DATE_WINDOW_STRATEGY,
  buildMissingBookingSlugCandidates,
  buildPageCapPlan,
  buildPriceBasisPolicy,
  buildProposedTargetMatrix,
  buildRiskAssessment,
  buildSafetyConfirmation,
  buildVerifiedBookingProperties,
  buildFutureB09XPlan,
  decideBookingTargetMatrixExpansion,
  extractBookingSlug,
  renderBookingTargetMatrixExpansionCsv,
  renderBookingTargetMatrixExpansionReport,
  type BookingTargetMatrixExpansionProposal,
  type CurrentBookingContext,
  type LocalBookingSlugEvidence
} from "../services/bookingTargetMatrixExpansionProposal";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/booking-target-matrix-expansion-proposal";
const B07B_ARTIFACT = ".data/reports/automation/post_booking_history_append_refresh_20260604_155005.json";
const MARKET_SNAPSHOT = ".data/ai-context/latest_market_snapshot.json";
const SOURCE_CANDIDATES_DIR = ".data/exports/zao-universe-review";
const LOCAL_VERIFIED_SOURCE_COVERAGE = "data/seeds/source_coverage_candidates.990-2301.verified.sample.json";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function latestCsv(prefix: string): string {
  const dir = resolve(SOURCE_CANDIDATES_DIR);
  const match = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".csv"))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (match === undefined) throw new Error(`No CSV found for ${prefix}`);
  return join(SOURCE_CANDIDATES_DIR, match.name);
}

interface B07BJson {
  decision: string;
  history_unique_row_id_count: number;
  db_after: {
    market_signal_history_rows: number;
    source_counts: Record<string, number>;
    dp_usage_counts: Record<string, number>;
  };
  booking_rows: {
    total_in_db: number;
    directional_in_db: number;
    excluded_in_db: number;
    direct_in_db: number;
  };
}

function readCurrentContext(): CurrentBookingContext {
  const b07b = readJson<B07BJson>(B07B_ARTIFACT);
  const snapshot = readJson<{ market_signal_history_row_count: number; source_counts: Record<string, number> }>(MARKET_SNAPSHOT);
  return {
    history_rows: b07b.history_unique_row_id_count,
    db_market_signal_history_rows: b07b.db_after.market_signal_history_rows,
    ai_context_row_count: snapshot.market_signal_history_row_count,
    booking_rows: b07b.booking_rows.total_in_db,
    booking_directional_rows: b07b.booking_rows.directional_in_db,
    booking_excluded_rows: b07b.booking_rows.excluded_in_db,
    booking_direct_rows: b07b.booking_rows.direct_in_db,
    b07b_decision: b07b.decision,
    rakuten_priority_decision: "NO_GO_FREEZE_RAKUTEN"
  };
}

interface SourceCoverageSeed {
  property_name: string;
  source: string;
  candidate_property_url?: string | null;
  candidate_label?: string;
  evidence_note?: string;
  verification_status?: string;
}

function readExtraVerifiedBookingEvidence(): LocalBookingSlugEvidence[] {
  const seeds = readJson<SourceCoverageSeed[]>(LOCAL_VERIFIED_SOURCE_COVERAGE);
  return seeds
    .filter(
      (row) =>
        row.source === "booking" &&
        typeof row.candidate_property_url === "string" &&
        row.verification_status === "verified"
    )
    .flatMap((row) => {
      const slug = extractBookingSlug(row.candidate_property_url ?? "");
      if (slug === null) return [];
      return [
        {
          canonical_property_name: row.property_name,
          slug,
          source_artifact: LOCAL_VERIFIED_SOURCE_COVERAGE,
          evidence_note: row.evidence_note ?? row.candidate_label ?? "Local verified Booking source coverage candidate.",
          feasibility_note: row.evidence_note ?? ""
        }
      ];
    });
}

function readSourceCoverage(): Record<string, string[]> {
  const sourceCsv = latestCsv("zao_source_candidates_");
  const multiCsv = latestCsv("zao_source_candidates_multi_source_enriched_");
  const out: Record<string, Set<string>> = {};
  for (const file of [sourceCsv, multiCsv]) {
    const table = parseCsvTable(readFileSync(resolve(file), "utf8"));
    for (const row of table.rows) {
      const name = row["canonical_property_name"] ?? "";
      const source = row["source"] ?? "";
      const id = row["candidate_source_property_id"] || row["reviewed_source_property_id"] || "";
      const url = row["candidate_property_url"] || row["reviewed_property_url"] || "";
      if (name === "" || source === "") continue;
      const entry = `${source}${id ? `:${id}` : ""}${url ? `:${url}` : ""}`;
      out[name] = out[name] ?? new Set<string>();
      out[name]!.add(entry);
    }
  }
  const plain: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(out)) plain[name] = [...values].sort();
  return plain;
}

function main(): void {
  const ts = timestamp();
  const runId = `booking_target_matrix_expansion_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const currentBookingContext = readCurrentContext();
  const extraEvidence = readExtraVerifiedBookingEvidence();
  const verified = buildVerifiedBookingProperties(extraEvidence);
  const sourceCoverage = readSourceCoverage();
  const missing = buildMissingBookingSlugCandidates({ verified, sourceCoverage });
  const cap = buildPageCapPlan(verified.length);
  const matrix = buildProposedTargetMatrix(verified, cap);
  const priceBasisPolicy = buildPriceBasisPolicy();
  const riskAssessment = buildRiskAssessment(missing.length);
  const futureB09xPlan = buildFutureB09XPlan();
  const safety = buildSafetyConfirmation();
  const decision = decideBookingTargetMatrixExpansion({
    b07bDecision: currentBookingContext.b07b_decision,
    verifiedCount: verified.length,
    pageCapOk: cap.caps_respected,
    missingCount: missing.length
  });

  const proposal: BookingTargetMatrixExpansionProposal = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_b07b_artifact_path: B07B_ARTIFACT,
    current_booking_context: currentBookingContext,
    verified_booking_properties: verified,
    missing_booking_slug_candidates: missing,
    date_window_strategy: DATE_WINDOW_STRATEGY,
    proposed_b09x_target_matrix: matrix,
    page_cap_plan: cap,
    price_basis_policy: priceBasisPolicy,
    risk_assessment: riskAssessment,
    future_b09x_plan: futureB09xPlan,
    safety_confirmation: safety,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(reportPath, renderBookingTargetMatrixExpansionReport(proposal), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderBookingTargetMatrixExpansionCsv(proposal), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_b07b_artifact.json", readJson(B07B_ARTIFACT));
  writeDebug("verified_booking_slugs.json", { b05x_verified: B05X_VERIFIED_SLUGS, extraEvidence, verified });
  writeDebug("missing_booking_slug_candidates.json", missing);
  writeDebug("proposed_target_matrix.json", matrix);
  writeDebug("date_window_strategy.json", proposal.date_window_strategy);
  writeDebug("page_cap_plan.json", cap);
  writeDebug("future_b09x_plan.json", futureB09xPlan);
  writeDebug("safety_confirmation.json", safety);

  console.log(`decision=${decision}`);
  console.log(`report=${reportPath}`);
  console.log(`json=${jsonPath}`);
  console.log(`csv=${csvPath}`);
  console.log(`debug=${debugPath}`);
}

main();

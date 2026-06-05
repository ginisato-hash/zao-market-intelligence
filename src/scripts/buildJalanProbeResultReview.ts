// Phase JALAN-AUTO03R - build Jalan probe result review.
//
// Reads saved AUTO03X artifacts only. Writes review/debug artifacts only. No
// live Jalan collection, browser automation, history writes, DB writes/sync, AI
// context refresh, query smoke, or pricing/PMS output.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildClassifierPolicyAudit,
  buildExtractorImprovementPlan,
  buildFutureAuto03bPlan,
  buildProposedClassificationFix,
  buildSafetyConfirmation,
  decideJalanProbeResultReview,
  diagnoseRows,
  renderDiagnosisCsv,
  renderReport,
  summarizeExclusions,
  validateAuto03xArtifact,
  type Auto03xArtifactLike,
  type EvidenceFileStatus
} from "../services/jalanProbeResultReview";

const SOURCE_AUTO03X_ARTIFACT_PATH = ".data/reports/source-discovery/jalan_bounded_collection_probe_20260604_232102.json";
const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/jalan-probe-result-review";

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

function readJson(path: string): Auto03xArtifactLike {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Auto03xArtifactLike;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function evidenceForRow(row: { screenshot_path: string; debug_artifact_path: string; raw_text_excerpt: string; normalized_total_price: number | null; checkin: string; meal_condition: string }): Partial<EvidenceFileStatus> {
  const targetResultPath = row.debug_artifact_path;
  const textPath = targetResultPath.replace("/target-results/", "/text/").replace(/\.json$/u, ".txt");
  const htmlPath = targetResultPath.replace("/target-results/", "/html/").replace(/\.json$/u, ".html");
  const text = existsSync(textPath) ? readFileSync(textPath, "utf8") : row.raw_text_excerpt;
  const htmlExists = existsSync(htmlPath);
  const price = row.normalized_total_price === null ? "" : String(row.normalized_total_price.toLocaleString("ja-JP"));
  const dateParts = row.checkin.split("-");
  const year = dateParts[0] ?? "";
  const month = String(Number(dateParts[1] ?? ""));
  const day = String(Number(dateParts[2] ?? ""));
  return {
    screenshot_exists: row.screenshot_path !== "" && existsSync(row.screenshot_path),
    text_artifact_exists: existsSync(textPath),
    html_artifact_exists: htmlExists,
    target_result_exists: targetResultPath !== "" && existsSync(targetResultPath),
    price_text_visible: price !== "" && (text.includes(price) || text.includes(price.replace(",", ""))),
    date_text_visible: text.includes(`${year}年${month}月`) || text.includes(`${month}月`) || text.includes(day),
    stay_scope_visible: text.includes("大人") || text.includes("1部屋") || text.includes("部屋数"),
    coupon_member_point_evidence_visible: /クーポン|ポイント|セール|スペシャル|割引|会員|半額|直前割/u.test(text),
    plan_level_discount_evidence_visible: /じゃらんスペシャル|直前割|半額|割引|クーポン|セール/u.test(String((row as { room_or_plan_name?: string }).room_or_plan_name ?? "")),
    meal_condition_visible: row.meal_condition !== "" && text.includes(row.meal_condition),
    evidence_note: `text=${textPath}; html=${htmlPath}; screenshot=${row.screenshot_path}`
  };
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `jalan_probe_result_review_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAuto03xArtifactPath = resolve(SOURCE_AUTO03X_ARTIFACT_PATH);
  const sourceAuto03x = readJson(SOURCE_AUTO03X_ARTIFACT_PATH);
  const validation = validateAuto03xArtifact(sourceAuto03x);
  const evidenceByTarget = new Map<string, Partial<EvidenceFileStatus>>();
  for (const row of validation.rows) {
    evidenceByTarget.set(`${row.source_slug_or_code}_${row.checkin}`, evidenceForRow(row));
  }
  const rowLevelDiagnosis = diagnoseRows(validation.rows, evidenceByTarget);
  const priceDetectedExcludedRows = rowLevelDiagnosis.filter((row) => row.tax_included_detected && row.dp_usage === "excluded");
  const exclusionReasonSummary = summarizeExclusions(rowLevelDiagnosis);
  const classifierPolicyAudit = buildClassifierPolicyAudit(exclusionReasonSummary);
  const proposedClassificationFix = buildProposedClassificationFix();
  const extractorImprovementPlan = buildExtractorImprovementPlan();
  const futureAuto03bPlan = buildFutureAuto03bPlan();
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideJalanProbeResultReview({ validAuto03x: validation.valid, summary: exclusionReasonSummary });

  const sourceAuto03xSummary = {
    decision: sourceAuto03x.decision,
    normalized_preview_rows_summary: sourceAuto03x.normalized_preview_rows_summary,
    direct_directional_excluded_summary: sourceAuto03x.direct_directional_excluded_summary,
    price_basis_summary: sourceAuto03x.price_basis_summary,
    validation
  };
  const evidenceReviewSummary = {
    rows_with_screenshot: rowLevelDiagnosis.filter((row) => row.evidence_review.screenshot_exists).length,
    rows_with_text_artifact: rowLevelDiagnosis.filter((row) => row.evidence_review.text_artifact_exists).length,
    rows_with_html_artifact: rowLevelDiagnosis.filter((row) => row.evidence_review.html_artifact_exists).length,
    price_detected_rows_with_price_text: priceDetectedExcludedRows.filter((row) => row.evidence_review.price_text_visible).length,
    price_detected_rows_with_plan_level_discount: priceDetectedExcludedRows.filter((row) => row.evidence_review.plan_level_discount_evidence_visible).length
  };

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto03x_summary: sourceAuto03xSummary,
    row_level_diagnosis: rowLevelDiagnosis,
    price_detected_excluded_rows: priceDetectedExcludedRows,
    exclusion_reason_summary: exclusionReasonSummary,
    classifier_policy_audit: classifierPolicyAudit,
    evidence_review_summary: evidenceReviewSummary,
    proposed_classification_fix: proposedClassificationFix,
    extractor_improvement_plan: extractorImprovementPlan,
    future_auto03b_plan: futureAuto03bPlan,
    safety_confirmation: safetyConfirmation,
    next_phase: "JALAN-AUTO03B — Improved bounded Jalan collection probe",
    report_path: "",
    json_path: "",
    csv_path: "",
    debug_artifact_path: debugPath
  };

  const reportPath = resolve(REPORT_DIR, `jalan_probe_result_review_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `jalan_probe_result_review_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `jalan_probe_result_review_${ts}.csv`);
  output.report_path = reportPath;
  output.json_path = jsonPath;
  output.csv_path = csvPath;

  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      sourceAuto03xArtifact: sourceAuto03xArtifactPath,
      summary: exclusionReasonSummary,
      policyAudit: classifierPolicyAudit,
      proposedFix: proposedClassificationFix,
      extractorPlan: extractorImprovementPlan,
      futurePlan: futureAuto03bPlan,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderDiagnosisCsv(rowLevelDiagnosis), "utf8");

  mkdirSync(dirname(resolve(debugPath, "x")), { recursive: true });
  writeJson(resolve(debugPath, "source_auto03x_artifact.json"), sourceAuto03x);
  writeJson(resolve(debugPath, "row_level_diagnosis.json"), rowLevelDiagnosis);
  writeJson(resolve(debugPath, "price_detected_excluded_rows.json"), priceDetectedExcludedRows);
  writeJson(resolve(debugPath, "exclusion_reason_summary.json"), exclusionReasonSummary);
  writeJson(resolve(debugPath, "classifier_policy_audit.json"), classifierPolicyAudit);
  writeJson(resolve(debugPath, "extractor_improvement_plan.json"), extractorImprovementPlan);
  writeJson(resolve(debugPath, "future_auto03b_plan.json"), futureAuto03bPlan);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
console.log(`decision=${result.decision}`);

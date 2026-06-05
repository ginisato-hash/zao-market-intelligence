// Phase D03X — build the property discovery review report.
//
// Reads the latest D02X normalization artifact (read-only) and produces a
// human-readable review packet: report/CSV/JSON + debug artifacts.
//
// Mutates nothing: no DB, no properties-master update, no alias update, no
// active promotion, no price-collection-target update, no GitHub Actions /
// GitOps / cron, no version-control commits or pushes, no paid sources. No
// D04X action is executed; all D04X actions are descriptive proposals that
// require explicit human approval.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildD04XScopeRecommendation,
  buildReviewRows,
  countBy,
  decideD03X,
  renderReviewCsv,
  renderReviewReport,
  type D02XInputRow,
  type ReviewRow,
  type ReviewSummary
} from "../services/propertyDiscoveryReviewReport";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/property-discovery-review";
const D02X_REPORT_PREFIX = "property_name_normalization_";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function nowJst(): string {
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
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function resolveLatestD02X(): string {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing artifact directory: ${reportDir}. Stop and report the missing D02X artifact path. Do not re-run collectors.`);
  }
  const jsonFiles = entries.filter((n) => n.startsWith(D02X_REPORT_PREFIX) && n.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(`Missing D02X artifact (expected ${D02X_REPORT_PREFIX}*.json in ${reportDir}). Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  return resolve(reportDir, latest);
}

interface D02XArtifact {
  summary?: { decision?: string };
  rows: D02XInputRow[];
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  const ts = timestamp();
  const runId = `property_discovery_review_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  // ---- Source D02X artifact (read-only) ----
  const d02xPath = resolveLatestD02X();
  let d02x: D02XArtifact;
  try {
    d02x = JSON.parse(readFileSync(d02xPath, "utf8")) as D02XArtifact;
  } catch (caught) {
    throw new Error(`Malformed D02X artifact ${d02xPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const rows = Array.isArray(d02x.rows) ? d02x.rows : [];
  if (rows.length === 0) {
    throw new Error(`D02X artifact ${d02xPath} contains no rows. Stop and report; do not re-run collectors.`);
  }
  const d02xDecision = d02x.summary?.decision ?? "unknown";

  // ---- Build review rows ----
  const reviewedAtJst = nowJst();
  const reviewRows: ReviewRow[] = buildReviewRows({ runId, reviewedAtJst, rows });

  const classificationCounts = countBy(reviewRows.map((r) => r.classification));
  const reviewSeverityCounts = countBy(reviewRows.map((r) => r.reviewSeverity));
  const recommendedActionRefinedCounts = countBy(reviewRows.map((r) => r.recommendedActionRefined));
  const d04xAllowedActionCounts = countBy(reviewRows.map((r) => r.d04xAllowedAction));
  const criticalCount = reviewSeverityCounts["critical"] ?? 0;
  const highCount = reviewSeverityCounts["high"] ?? 0;
  const humanReviewCount = reviewRows.filter((r) => r.needsHumanReview).length;

  const warnings = reviewRows.filter((r) => r.warning).map((r) => `${r.detectedName}: ${r.warning}`);

  const decision = decideD03X({ reviewRowCount: reviewRows.length, criticalCount, highCount, humanReviewCount });

  const reportDir = resolve(REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `property_discovery_review_${ts}.md`);
  const csvPath = resolve(reportDir, `property_discovery_review_${ts}.csv`);
  const jsonPath = resolve(reportDir, `property_discovery_review_${ts}.json`);

  const summary: ReviewSummary = {
    runId,
    generatedAt: reviewedAtJst,
    sourceD02xArtifact: d02xPath,
    reviewRowCount: reviewRows.length,
    d02xDecision,
    classificationCounts,
    reviewSeverityCounts,
    recommendedActionRefinedCounts,
    d04xAllowedActionCounts,
    criticalCount,
    highCount,
    humanReviewCount,
    warnings,
    decision,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  writeFileSync(csvPath, renderReviewCsv(reviewRows), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, rows: reviewRows }, null, 2), "utf8");
  writeFileSync(reportPath, renderReviewReport({ summary, rows: reviewRows }), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_d02x_artifact.json", { d02xPath, d02xDecision, rowCount: rows.length });
  writeDebug("review_rows.json", reviewRows);
  writeDebug("classification_summary.json", classificationCounts);
  writeDebug("recommended_action_summary.json", recommendedActionRefinedCounts);
  writeDebug("review_severity_summary.json", reviewSeverityCounts);
  writeDebug("human_review_items.json", reviewRows.filter((r) => r.needsHumanReview));
  writeDebug("d04x_scope_recommendation.json", buildD04XScopeRecommendation(reviewRows));
  writeDebug("safety_confirmation.json", {
    modifiedPropertiesMaster: false,
    addedAliases: false,
    activePromotedCandidates: false,
    addedPriceCollectionTargets: false,
    executedAnyD04XAction: false,
    dbWrites: false,
    githubActionsOrGitOps: false,
    versionControlCommitsOrPushes: false,
    paidSources: false
  });

  return { reportPath, csvPath, jsonPath, debugRootPath, decision };
}

try {
  const result = build();
  console.log(`report_path=${result.reportPath}`);
  console.log(`csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

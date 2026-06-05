// Phase D05X — run the property discovery regression / re-run check.
//
// Verifies the two approved D04X excluded-audit rows now affect the discovery
// pipeline as intended, via a LOCAL artifact replay. This script NEVER
// live-fetches external pages, never modifies any master artifact, never
// writes the DB, never enables GitHub Actions/GitOps, never commits/pushes,
// never touches .data/history, and never contacts paid sources.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  countRegression,
  decideD05X,
  buildRegressionRows,
  renderRegressionCsv,
  renderRegressionReport,
  type ApprovedD04XItem,
  type BeforeStateRow,
  type ExcludedAuditEntry,
  type RegressionSummary
} from "../services/propertyDiscoveryRegressionCheck";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/property-discovery-regression";
const EXCLUDED_AUDIT_RELPATH = ".data/exports/zao-universe-review/zao_excluded_audit_20260531_231933.csv";

const INVENTORY_PREFIX = "property_discovery_inventory_";
const REVIEW_PREFIX = "property_discovery_review_";
const D04X_PREFIX = "property_master_approved_update_";

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
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function resolveLatest(prefix: string, label: string): string {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing artifact directory: ${reportDir}. Stop and report the missing ${label} artifact path. Do not re-run collectors.`);
  }
  const jsonFiles = entries.filter((n) => n.startsWith(prefix) && n.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(`Missing ${label} artifact (expected ${prefix}*.json in ${reportDir}). Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  return resolve(reportDir, latest);
}

// Minimal quote-aware CSV parse (header + rows).
function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    const next = csv[i + 1];
    if (inQuotes && ch === "\"" && next === "\"") {
      cell += "\"";
      i++;
    } else if (ch === "\"") {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((v) => v !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((v) => v !== "")) matrix.push(row);
  }
  const headers = matrix.shift() ?? [];
  const rows = matrix.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { headers, rows };
}

interface ReviewArtifact {
  rows?: Array<{
    detectedName?: string;
    sourceUrls?: string[];
    classification?: string;
    reviewSeverity?: string;
    d04xAllowedAction?: string;
  }>;
}

interface D04XArtifact {
  appended?: Array<{ property_name_raw?: string; property_url?: string; exclusion_reason?: string }>;
  skippedExisting?: Array<{ property_name_raw?: string; property_url?: string; exclusion_reason?: string }>;
}

function readJson<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (caught) {
    throw new Error(`Malformed ${label} artifact ${path}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  const ts = timestamp();
  const runId = `property_discovery_regression_check_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  // ---- Resolve source artifacts (read-only) ----
  const inventoryPath = resolveLatest(INVENTORY_PREFIX, "D01X inventory");
  const reviewPath = resolveLatest(REVIEW_PREFIX, "D03X review");
  const d04xPath = resolveLatest(D04X_PREFIX, "D04X approved update");

  const review = readJson<ReviewArtifact>(reviewPath, "D03X review");
  const d04x = readJson<D04XArtifact>(d04xPath, "D04X approved update");

  // ---- Updated excluded audit (read-only) ----
  const auditPath = resolve(EXCLUDED_AUDIT_RELPATH);
  const auditParsed = parseCsv(readFileSync(auditPath, "utf8"));
  const audit: ExcludedAuditEntry[] = auditParsed.rows.map((r) => ({
    property_name_raw: r["property_name_raw"] ?? "",
    property_url: r["property_url"] ?? "",
    exclusion_reason: r["exclusion_reason"] ?? "",
    review_decision: r["review_decision"] ?? ""
  }));

  // ---- Approved D04X items (the exact set the regression verifies) ----
  const appliedRows = [...(d04x.appended ?? []), ...(d04x.skippedExisting ?? [])];
  const approved: ApprovedD04XItem[] = appliedRows.map((r) => ({
    detectedName: r.property_name_raw ?? "",
    sourceUrl: r.property_url ?? "",
    approvedAction: r.exclusion_reason === "out_of_scope" ? "mark_out_of_scope" : "mark_duplicate"
  }));

  // ---- Before-state rows (D03X) limited to the approved items ----
  const reviewRows = Array.isArray(review.rows) ? review.rows : [];
  const beforeRows: BeforeStateRow[] = reviewRows
    .filter((r) => approved.some((a) => a.detectedName === r.detectedName))
    .map((r) => ({
      detectedName: r.detectedName ?? "",
      sourceUrl: (r.sourceUrls ?? [])[0] ?? "",
      classification: r.classification ?? "",
      reviewSeverity: r.reviewSeverity ?? "",
      d04xAllowedAction: r.d04xAllowedAction ?? ""
    }));

  // ---- Replay + classify ----
  const rows = buildRegressionRows({
    runId,
    checkedAtJst: nowJst(),
    approved,
    beforeRows,
    audit,
    sourceBeforeArtifact: reviewPath,
    sourceAfterArtifactOrReplay: `local_replay:${auditPath}`,
    debugArtifactPath: debugRootPath
  });

  const counts = countRegression(rows);
  const decision = decideD05X(counts);

  const reportDir = resolve(REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `property_discovery_regression_check_${ts}.md`);
  const csvPath = resolve(reportDir, `property_discovery_regression_check_${ts}.csv`);
  const jsonPath = resolve(reportDir, `property_discovery_regression_check_${ts}.json`);

  const summary: RegressionSummary = {
    runId,
    generatedAt: nowJst(),
    sourceD01xArtifact: inventoryPath,
    sourceD04xArtifact: d04xPath,
    sourceBeforeArtifact: reviewPath,
    excludedAuditArtifact: auditPath,
    liveFetchPerformed: false,
    counts,
    decision,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  writeFileSync(csvPath, renderRegressionCsv(rows), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, rows }, null, 2), "utf8");
  writeFileSync(reportPath, renderRegressionReport({ summary, rows }), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_d01x_artifact.json", { inventoryPath });
  writeDebug("source_d04x_artifact.json", { d04xPath, approved });
  writeDebug("excluded_audit_snapshot.json", { auditPath, rowCount: audit.length, audit });
  writeDebug("before_state_rows.json", beforeRows);
  writeDebug("after_replay_rows.json", rows.map((r) => ({
    detectedName: r.detectedName,
    afterMatchType: r.afterMatchType,
    afterClassification: r.afterClassification,
    afterD04xAllowedAction: r.afterD04xAllowedAction,
    excludedAuditMatchFound: r.excludedAuditMatchFound
  })));
  writeDebug("regression_rows.json", rows);
  writeDebug("regression_summary.json", summary);
  writeDebug("safety_confirmation.json", {
    liveFetchedExternalPages: false,
    modifiedPropertiesMaster: false,
    modifiedExcludedAudit: false,
    addedAliases: false,
    activePromotedAnyProperty: false,
    addedPriceCollectionTargets: false,
    dbWrites: false,
    modifiedDataHistory: false,
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

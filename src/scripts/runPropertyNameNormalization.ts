// Phase D02X — run property name normalization + existing master matching.
//
// Reads the latest D01X inventory artifact (read-only) and the existing
// reviewed Zao universe artifacts (read-only), builds the master pool, dedupes
// + classifies D01X rows, and writes a local report/CSV/JSON + debug artifacts.
//
// Mutates nothing: no DB, no properties-master update, no alias update, no
// active promotion, no price-collection-target update, no GitHub Actions /
// GitOps / cron, no version-control commits or pushes, no paid sources.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PropertyDiscoveryInventoryRow } from "../services/propertyDiscoveryInventory";
import {
  buildExistingMasterPool,
  buildNormalizationRows,
  countBy,
  decideD02X,
  renderNormalizationCsv,
  renderNormalizationReport,
  type NormalizationSummary,
  type PropertyNormalizationRow
} from "../services/propertyNameNormalization";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/property-name-normalization";
const UNIVERSE_DIR = ".data/exports/zao-universe-review";
const D01X_REPORT_PREFIX = "property_discovery_inventory_";

const UNIVERSE_PROPERTIES = "zao_universe_properties_20260531_231933.csv";
const UNIVERSE_ALIAS_MAP = "zao_alias_map_20260531_231933.json";
const UNIVERSE_SOURCE_CANDIDATES = "zao_source_candidates_20260531_231933.csv";
const UNIVERSE_EXCLUDED_AUDIT = "zao_excluded_audit_20260531_231933.csv";

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

function resolveLatestD01X(): string {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing artifact directory: ${reportDir}. Stop and report the missing D01X artifact path. Do not re-run collectors.`);
  }
  const jsonFiles = entries.filter((n) => n.startsWith(D01X_REPORT_PREFIX) && n.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(`Missing D01X artifact (expected ${D01X_REPORT_PREFIX}*.json in ${reportDir}). Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  return resolve(reportDir, latest);
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

interface D01XArtifact {
  rows: PropertyDiscoveryInventoryRow[];
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  const ts = timestamp();
  const runId = `property_name_normalization_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  // ---- Source D01X artifact (read-only) ----
  const d01xPath = resolveLatestD01X();
  let d01x: D01XArtifact;
  try {
    d01x = JSON.parse(readFileSync(d01xPath, "utf8")) as D01XArtifact;
  } catch (caught) {
    throw new Error(`Malformed D01X artifact ${d01xPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const rows = Array.isArray(d01x.rows) ? d01x.rows : [];
  if (rows.length === 0) {
    throw new Error(`D01X artifact ${d01xPath} contains no rows. Stop and report; do not re-run collectors.`);
  }

  // ---- Existing master pool (read-only) ----
  const universeDir = resolve(UNIVERSE_DIR);
  const pool = buildExistingMasterPool({
    propertiesCsv: readOptional(resolve(universeDir, UNIVERSE_PROPERTIES)),
    aliasMapJson: readOptional(resolve(universeDir, UNIVERSE_ALIAS_MAP)),
    sourceCandidatesCsv: readOptional(resolve(universeDir, UNIVERSE_SOURCE_CANDIDATES)),
    excludedAuditCsv: readOptional(resolve(universeDir, UNIVERSE_EXCLUDED_AUDIT))
  });

  // ---- Normalize + match + classify ----
  const normalizedAtJst = nowJst();
  const normalizedRows: PropertyNormalizationRow[] = buildNormalizationRows({ runId, normalizedAtJst, rows, pool });

  const classificationCounts = countBy(normalizedRows.map((r) => r.classification));
  const confidenceCounts = countBy(normalizedRows.map((r) => r.confidence));
  const recommendedActionCounts = countBy(normalizedRows.map((r) => r.recommendedAction));
  const uncertainCount = classificationCounts["uncertain_candidate"] ?? 0;

  const decision = decideD02X({
    d01xRowCount: rows.length,
    canonicalCount: pool.canonicalCount,
    classifiedCount: normalizedRows.length,
    aliasMapPresent: pool.aliasMapPresent,
    excludedPresent: pool.excludedPresent,
    uncertainCount
  });

  const reportDir = resolve(REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `property_name_normalization_${ts}.md`);
  const csvPath = resolve(reportDir, `property_name_normalization_${ts}.csv`);
  const jsonPath = resolve(reportDir, `property_name_normalization_${ts}.json`);

  const summary: NormalizationSummary = {
    runId,
    generatedAt: normalizedAtJst,
    sourceD01xArtifact: d01xPath,
    rawRowCount: rows.length,
    dedupedRowCount: normalizedRows.length,
    existingCanonicalCount: pool.canonicalCount,
    existingSourceCandidateCount: pool.sourceCandidateCount,
    existingAliasCount: pool.aliasCount,
    existingExcludedCount: pool.excludedCount,
    classificationCounts,
    confidenceCounts,
    recommendedActionCounts,
    warnings: pool.warnings,
    decision,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  writeFileSync(csvPath, renderNormalizationCsv(normalizedRows), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, rows: normalizedRows }, null, 2), "utf8");
  writeFileSync(reportPath, renderNormalizationReport({ summary, rows: normalizedRows }), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_d01x_artifact.json", { d01xPath, rawRowCount: rows.length });
  writeDebug("existing_master_pool.json", {
    canonicalCount: pool.canonicalCount,
    aliasCount: pool.aliasCount,
    sourceCandidateCount: pool.sourceCandidateCount,
    excludedCount: pool.excludedCount,
    aliasMapPresent: pool.aliasMapPresent,
    excludedPresent: pool.excludedPresent,
    warnings: pool.warnings,
    entries: pool.entries
  });
  writeDebug("deduped_detected_groups.json", normalizedRows.map((r) => ({
    normalizedDetectedName: r.normalizedDetectedName,
    detectedName: r.detectedName,
    sourceNames: r.sourceNames,
    sourceCount: r.sourceCount,
    sourceRowIds: r.sourceRowIds
  })));
  writeDebug("matched_rows.json", normalizedRows);
  writeDebug("classification_summary.json", classificationCounts);
  writeDebug("review_action_summary.json", recommendedActionCounts);
  writeDebug("unmatched_candidates.json", normalizedRows.filter((r) => r.matchType === "no_match"));
  writeDebug("alias_candidates.json", normalizedRows.filter((r) => r.classification === "alias_candidate"));
  writeDebug("out_of_scope_candidates.json", normalizedRows.filter((r) => r.classification === "out_of_scope_candidate"));
  writeDebug("normalization_warnings.json", { warnings: pool.warnings });

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

// Phase PD-FIX01X — build the Matsukaneya canonical merge PROPOSAL packet.
//
// Reads the read-only master/export artifacts and produces a local
// Markdown/CSV/JSON + debug proposal packet. This script NEVER modifies the
// properties master, alias map, source candidates, or active-status flags;
// NEVER executes the canonical merge; NEVER writes the DB; NEVER recomputes the
// Demand Index; NEVER touches .data/history; NEVER produces Beds24/AirHost/PMS/
// OTA output; NEVER enables GitHub Actions/GitOps/cron; NEVER commits/pushes;
// and NEVER performs a live external fetch or collector re-run. The real-merge
// approval gate stays CLOSED.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONFIRMED_DUPLICATE_GROUP_ID,
  DEPRECATE_CANONICAL,
  RETAIN_CANONICAL,
  buildApprovalGate,
  buildMergePlan,
  buildProposalRows,
  decideMatsukaneya,
  hasIndependentCrossSourceCorroboration,
  renderProposalCsv,
  renderProposalReport,
  type ConfirmedDuplicateGroup,
  type ProposalSummary,
  type SourceCandidateRow,
  type UniverseRow
} from "../services/matsukaneyaCanonicalMergeProposal";

const EXPORT_DIR = ".data/exports/zao-universe-review";
const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/matsukaneya-canonical-merge-proposal";

const UNIVERSE_FILE = "zao_universe_properties_20260531_231933.csv";
const ALIAS_FILE = "zao_alias_map_20260531_231933.json";
const CANDIDATE_FILE = "zao_source_candidates_20260531_231933.csv";
const CANDIDATE_MULTI_FILE = "zao_source_candidates_multi_source_enriched_20260601_074617.csv";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstParts(): { iso: string; date: string } {
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
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { iso: `${date}T${get("hour")}:${get("minute")}:${get("second")}+09:00`, date };
}

// Quote-aware CSV parse → array of header-keyed records.
function parseCsv(csv: string): Record<string, string>[] {
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
  return matrix.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

function readArtifact(name: string): string {
  const path = resolve(EXPORT_DIR, name);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`Missing source artifact: ${path}. Stop and report the missing artifact path. Do not re-run collectors.`);
  }
}

function splitList(value: string): string[] {
  return value
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function toUniverseRow(r: Record<string, string>): UniverseRow {
  return {
    canonicalPropertyName: r["canonical_property_name"] ?? "",
    canonicalizationStatus: r["canonicalization_status"] ?? "",
    aliases: splitList(r["aliases"] ?? ""),
    sourcesPresent: splitList(r["sources_present"] ?? ""),
    jalanUrl: r["jalan_url"] ?? "",
    jalanId: r["jalan_id"] ?? "",
    rakutenUrl: r["rakuten_url"] ?? "",
    rakutenId: r["rakuten_id"] ?? "",
    evidenceNote: r["evidence_note"] ?? ""
  };
}

function toCandidateRow(r: Record<string, string>): SourceCandidateRow {
  return {
    canonicalPropertyName: r["canonical_property_name"] ?? "",
    source: r["source"] ?? "",
    candidatePropertyUrl: r["candidate_property_url"] ?? "",
    candidateSourcePropertyId: r["candidate_source_property_id"] ?? "",
    verificationStatus: r["verification_status"] ?? ""
  };
}

function findUniverse(rows: UniverseRow[], name: string): UniverseRow {
  const found = rows.find((r) => r.canonicalPropertyName === name);
  if (!found) {
    throw new Error(`Confirmed-duplicate canonical not found in universe master: ${name}. Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  return found;
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  const ts = timestamp();
  const runId = `matsukaneya_canonical_merge_proposal_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  const jst = jstParts();

  // ---- Read artifacts (read-only) ----
  const universeRows = parseCsv(readArtifact(UNIVERSE_FILE)).map(toUniverseRow);
  const candidateRows = parseCsv(readArtifact(CANDIDATE_FILE)).map(toCandidateRow);
  const candidateMultiRows = parseCsv(readArtifact(CANDIDATE_MULTI_FILE)).map(toCandidateRow);
  const aliasMapRaw = readArtifact(ALIAS_FILE); // read to confirm presence; mutated never
  const aliasMap = JSON.parse(aliasMapRaw) as Record<string, string[]>;

  const retain = findUniverse(universeRows, RETAIN_CANONICAL);
  const deprecate = findUniverse(universeRows, DEPRECATE_CANONICAL);

  // Prefer the multi-source enriched candidates when present.
  const candidatesFor = (name: string): SourceCandidateRow[] => {
    const multi = candidateMultiRows.filter((c) => c.canonicalPropertyName === name);
    return multi.length > 0 ? multi : candidateRows.filter((c) => c.canonicalPropertyName === name);
  };

  const group: ConfirmedDuplicateGroup = {
    groupId: CONFIRMED_DUPLICATE_GROUP_ID,
    userConfirmedSameProperty: true,
    retain,
    deprecate,
    retainCandidates: candidatesFor(RETAIN_CANONICAL),
    deprecateCandidates: candidatesFor(DEPRECATE_CANONICAL)
  };

  const ctx = { runId, generatedAtJst: jst.iso, debugArtifactPath: debugRootPath };
  const rows = buildProposalRows(group, ctx);
  const plan = buildMergePlan(group);
  const gate = buildApprovalGate();
  const corroborated = hasIndependentCrossSourceCorroboration(group);

  const decision = decideMatsukaneya({
    proposalRowCount: rows.length,
    userConfirmedSameProperty: group.userConfirmedSameProperty,
    hasIndependentCrossSourceCorroboration: corroborated
  });

  // ---- Output paths ----
  const reportDir = resolve(REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `matsukaneya_canonical_merge_proposal_${ts}.md`);
  const csvPath = resolve(reportDir, `matsukaneya_canonical_merge_proposal_${ts}.csv`);
  const jsonPath = resolve(reportDir, `matsukaneya_canonical_merge_proposal_${ts}.json`);

  const summary: ProposalSummary = {
    runId,
    generatedAt: jst.iso,
    groupId: group.groupId,
    userConfirmedSameProperty: group.userConfirmedSameProperty,
    sourceArtifacts: [
      resolve(EXPORT_DIR, UNIVERSE_FILE),
      resolve(EXPORT_DIR, ALIAS_FILE),
      resolve(EXPORT_DIR, CANDIDATE_FILE),
      resolve(EXPORT_DIR, CANDIDATE_MULTI_FILE)
    ],
    proposalRowCount: rows.length,
    retainCanonical: RETAIN_CANONICAL,
    deprecateCanonical: DEPRECATE_CANONICAL,
    decision,
    gate,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  writeFileSync(csvPath, renderProposalCsv(rows), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, rows, plan, gate }, null, 2), "utf8");
  writeFileSync(reportPath, renderProposalReport({ summary, rows, plan }), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_universe_rows.json", { retain, deprecate });
  writeDebug("source_candidate_rows.json", { retain: group.retainCandidates, deprecate: group.deprecateCandidates });
  writeDebug("alias_map_entries.json", {
    [RETAIN_CANONICAL]: aliasMap[RETAIN_CANONICAL] ?? [],
    [DEPRECATE_CANONICAL]: aliasMap[DEPRECATE_CANONICAL] ?? []
  });
  writeDebug("evidence_rows.json", rows.map((r) => ({
    candidateName: r.candidateName,
    evidenceType: r.evidenceType,
    evidenceValue: r.evidenceValue,
    evidenceStrength: r.evidenceStrength,
    samePropertyStatus: r.samePropertyStatus
  })));
  writeDebug("proposed_merge_plan.json", plan);
  writeDebug("approval_gate_result.json", { ...gate, hasIndependentCrossSourceCorroboration: corroborated, decision });
  writeDebug("safety_confirmation.json", {
    userConfirmedSameProperty: true,
    explicitUserApprovedForRealMerge: false,
    realUpdateAllowed: false,
    modifiedPropertiesMaster: false,
    executedCanonicalMerge: false,
    modifiedAliasMap: false,
    modifiedSourceCandidates: false,
    modifiedActiveStatus: false,
    modifiedPriceCollectionTargets: false,
    dbWrites: false,
    recomputedDemandIndex: false,
    modifiedDataHistory: false,
    bookingBaseTimes1_1: false,
    beds24Output: false,
    airhostOutput: false,
    pmsOutput: false,
    otaUpload: false,
    liveExternalFetch: false,
    collectorReRun: false,
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

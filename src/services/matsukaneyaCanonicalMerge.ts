// Phase PD-FIX02X — approved Matsukaneya canonical merge.
//
// This module is deliberately scoped to the approved Matsukaneya duplicate:
// retain ホテル松金屋アネックス, deprecate 松金や －MATSUKANEYA ANNEX－,
// and preserve Rakuten 5097 / Jalan 335940. It contains no DB code, no network
// code, no collector code, and no GitHub Actions/GitOps activation.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CONFIRMED_DUPLICATE_GROUP_ID,
  DEPRECATE_CANONICAL,
  FUTURE_TARGET_ARTIFACTS,
  RETAIN_CANONICAL
} from "./matsukaneyaCanonicalMergeProposal";

export {
  CONFIRMED_DUPLICATE_GROUP_ID,
  DEPRECATE_CANONICAL,
  RETAIN_CANONICAL
};

export const APPROVED_TARGET_ARTIFACTS = [
  ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv",
  ".data/exports/zao-universe-review/zao_alias_map_20260531_231933.json",
  ".data/exports/zao-universe-review/zao_source_candidates_20260531_231933.csv",
  ".data/exports/zao-universe-review/zao_source_candidates_multi_source_enriched_20260601_074617.csv"
] as const;

export const PROPOSAL_JSON_PATH =
  ".data/reports/source-discovery/matsukaneya_canonical_merge_proposal_20260603_205455.json";

export const APPROVED_RAKUTEN_HOTEL_NO = "5097";
export const APPROVED_JALAN_YAD_ID = "335940";

const DUPLICATE_STATUS = `duplicate_of:${RETAIN_CANONICAL}`;
const MERGE_NOTE =
  `PD-FIX02X approved Matsukaneya canonical merge: ${DEPRECATE_CANONICAL} is the same physical property as ${RETAIN_CANONICAL}; source IDs preserved under retained canonical.`;

export type MatsukaneyaMergeDecision =
  | "matsukaneya_canonical_merge_ready_not_run"
  | "matsukaneya_canonical_merge_success"
  | "matsukaneya_canonical_merge_failed_preflight"
  | "matsukaneya_canonical_merge_failed_rolled_back"
  | "matsukaneya_canonical_merge_failed_manual_recovery_required";

export interface ApprovalGateInput {
  explicitUserApproved: boolean;
  envMatsukaneyaMerge: string | undefined;
  proposal: unknown;
  targetArtifactPaths: readonly string[];
}

export interface ApprovalGateResult {
  explicitUserApproved: boolean;
  envFlagPresent: boolean;
  sourceProposalExists: boolean;
  proposalMatches: boolean;
  targetArtifactsMatch: boolean;
  realUpdateAllowed: boolean;
  decision: MatsukaneyaMergeDecision;
  reasons: string[];
}

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export interface MergeApplication {
  content: string;
  changed: boolean;
  actions: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  retainedCanonicalExists: boolean;
  deprecatedCanonicalMarkedDuplicate: boolean;
  aliasMapUpdated: boolean;
  rakuten5097MapsToRetained: boolean;
  jalan335940MapsToRetained: boolean;
  noDeprecatedCandidateRows: boolean;
  headersPreserved: boolean;
  noForbiddenColumns: boolean;
}

export interface TargetContents {
  universeCsv: string;
  aliasJson: string;
  sourceCandidatesCsv: string;
  multiSourceCandidatesCsv: string;
}

export interface MergeOutputs extends TargetContents {
  actions: Record<string, string[]>;
  changed: Record<string, boolean>;
}

export const REQUIRED_ALIASES = [
  "松金や －MATSUKANEYA ANNEX－",
  "Matsukaneya Annex",
  "松金屋アネックス",
  "蔵王温泉 松金や －MATSUKANEYA ANNEX－",
  "蔵王温泉 ホテル松金屋アネックス"
] as const;

export const FORBIDDEN_OUTPUT_COLUMN_TOKENS = [
  "roomid",
  "inventory",
  "minstay",
  "maxstay",
  "multiplier",
  "price1",
  "price2",
  "price3",
  "price4",
  "price5",
  "beds24",
  "airhost",
  "pms"
] as const;

export function evaluateMatsukaneyaMergeGate(input: ApprovalGateInput): ApprovalGateResult {
  const reasons: string[] = [];
  const envFlagPresent = input.envMatsukaneyaMerge === "1";
  const proposalMatches = proposalHasExpectedMerge(input.proposal);
  const targetArtifactsMatch = arraysEqual([...input.targetArtifactPaths], [...APPROVED_TARGET_ARTIFACTS]);

  if (!input.explicitUserApproved) reasons.push("explicit user approval is missing");
  if (!envFlagPresent) reasons.push("MATSUKANEYA_MERGE=1 is missing");
  if (!proposalMatches) reasons.push("PD-FIX01X proposal does not exactly match the approved Matsukaneya merge");
  if (!targetArtifactsMatch) reasons.push("target artifact paths do not exactly match the approved four files");

  const realUpdateAllowed = input.explicitUserApproved && envFlagPresent && proposalMatches && targetArtifactsMatch;
  return {
    explicitUserApproved: input.explicitUserApproved,
    envFlagPresent,
    sourceProposalExists: true,
    proposalMatches,
    targetArtifactsMatch,
    realUpdateAllowed,
    decision: realUpdateAllowed ? "matsukaneya_canonical_merge_success" : "matsukaneya_canonical_merge_ready_not_run",
    reasons
  };
}

export function proposalHasExpectedMerge(proposal: unknown): boolean {
  const p = proposal as {
    summary?: Record<string, unknown>;
    rows?: Array<Record<string, unknown>>;
    plan?: Record<string, unknown>;
  };
  if (!p || typeof p !== "object") return false;
  if (p.summary?.["groupId"] !== CONFIRMED_DUPLICATE_GROUP_ID) return false;
  if (p.summary?.["retainCanonical"] !== RETAIN_CANONICAL) return false;
  if (p.summary?.["deprecateCanonical"] !== DEPRECATE_CANONICAL) return false;
  if (p.summary?.["userConfirmedSameProperty"] !== true) return false;
  if (!Array.isArray(p.rows) || p.rows.length !== 2) return false;
  if (p.plan?.["retainCanonical"] !== RETAIN_CANONICAL) return false;
  if (p.plan?.["deprecateCanonical"] !== DEPRECATE_CANONICAL) return false;
  const ids = p.plan?.["preservedSourceIds"] as Record<string, unknown> | undefined;
  if (ids?.["rakutenHotelNo"] !== APPROVED_RAKUTEN_HOTEL_NO) return false;
  if (ids?.["jalanYadId"] !== APPROVED_JALAN_YAD_ID) return false;
  const targetArtifacts = p.plan?.["targetArtifactsIfApproved"];
  if (!Array.isArray(targetArtifacts)) return false;
  if (!arraysEqual(targetArtifacts.map(String), [...FUTURE_TARGET_ARTIFACTS])) return false;
  const repoints = p.plan?.["sourceCandidateRepoint"];
  if (!Array.isArray(repoints) || repoints.length !== 2) return false;
  return repoints.some((r) => isRepoint(r, "rakuten", APPROVED_RAKUTEN_HOTEL_NO)) &&
    repoints.some((r) => isRepoint(r, "jalan", APPROVED_JALAN_YAD_ID));
}

function isRepoint(value: unknown, source: string, id: string): boolean {
  const r = value as Record<string, unknown>;
  return r?.["toCanonical"] === RETAIN_CANONICAL &&
    r?.["source"] === source &&
    r?.["candidateId"] === id;
}

export function applyApprovedMatsukaneyaMerge(input: TargetContents): MergeOutputs {
  const universe = applyUniversePropertiesMerge(input.universeCsv);
  const alias = applyAliasMapMerge(input.aliasJson);
  const sourceCandidates = applySourceCandidatesMerge(input.sourceCandidatesCsv);
  const multiSourceCandidates = applySourceCandidatesMerge(input.multiSourceCandidatesCsv);
  return {
    universeCsv: universe.content,
    aliasJson: alias.content,
    sourceCandidatesCsv: sourceCandidates.content,
    multiSourceCandidatesCsv: multiSourceCandidates.content,
    actions: {
      universeCsv: universe.actions,
      aliasJson: alias.actions,
      sourceCandidatesCsv: sourceCandidates.actions,
      multiSourceCandidatesCsv: multiSourceCandidates.actions
    },
    changed: {
      universeCsv: universe.changed,
      aliasJson: alias.changed,
      sourceCandidatesCsv: sourceCandidates.changed,
      multiSourceCandidatesCsv: multiSourceCandidates.changed
    }
  };
}

export function applyUniversePropertiesMerge(csv: string): MergeApplication {
  const table = parseCsvTable(csv);
  const original = renderCsvTable(table);
  const actions: string[] = [];
  const retain = table.rows.find((r) => r["canonical_property_name"] === RETAIN_CANONICAL);
  const deprecate = table.rows.find((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL);
  if (!retain || !deprecate) {
    throw new Error("Approved Matsukaneya universe rows were not both present.");
  }

  retain["aliases"] = joinUniqueList(retain["aliases"] ?? "", [
    ...(deprecate["aliases"] ?? "").split(";"),
    ...REQUIRED_ALIASES
  ]);
  retain["sources_present"] = joinUniqueList(retain["sources_present"] ?? "", ["jalan", "rakuten"]);
  retain["jalan_url"] = nonEmpty(retain["jalan_url"]) || nonEmpty(deprecate["jalan_url"]);
  retain["jalan_id"] = nonEmpty(retain["jalan_id"]) || APPROVED_JALAN_YAD_ID;
  retain["rakuten_url"] = nonEmpty(retain["rakuten_url"]) || "https://travel.rakuten.co.jp/HOTEL/5097/";
  retain["rakuten_id"] = nonEmpty(retain["rakuten_id"]) || APPROVED_RAKUTEN_HOTEL_NO;
  retain["evidence_note"] = appendNote(retain["evidence_note"] ?? "", MERGE_NOTE);

  deprecate["canonicalization_status"] = DUPLICATE_STATUS;
  deprecate["evidence_note"] = appendNote(deprecate["evidence_note"] ?? "", MERGE_NOTE);
  actions.push(`retained canonical ${RETAIN_CANONICAL} now carries Rakuten ${APPROVED_RAKUTEN_HOTEL_NO} and Jalan ${APPROVED_JALAN_YAD_ID}`);
  actions.push(`deprecated canonical ${DEPRECATE_CANONICAL} marked ${DUPLICATE_STATUS}`);

  const content = renderCsvTable(table);
  return { content, changed: content !== original, actions };
}

export function applyAliasMapMerge(json: string): MergeApplication {
  const original = `${JSON.stringify(JSON.parse(json), null, 2)}\n`;
  const map = JSON.parse(json) as Record<string, string[]>;
  const aliases = new Set<string>([...(map[RETAIN_CANONICAL] ?? [])]);
  for (const alias of map[DEPRECATE_CANONICAL] ?? []) aliases.add(alias);
  for (const alias of REQUIRED_ALIASES) aliases.add(alias);
  aliases.delete(RETAIN_CANONICAL);
  map[RETAIN_CANONICAL] = [...aliases];
  delete map[DEPRECATE_CANONICAL];
  const content = `${JSON.stringify(map, null, 2)}\n`;
  return {
    content,
    changed: content !== original,
    actions: [`moved Matsukaneya aliases under retained canonical ${RETAIN_CANONICAL}`]
  };
}

export function applySourceCandidatesMerge(csv: string): MergeApplication {
  const table = parseCsvTable(csv);
  const original = renderCsvTable(table);
  const actions: string[] = [];
  let repointed = 0;
  for (const row of table.rows) {
    if (row["canonical_property_name"] !== DEPRECATE_CANONICAL) continue;
    row["canonical_property_name"] = RETAIN_CANONICAL;
    row["evidence_note"] = appendNote(row["evidence_note"] ?? "", MERGE_NOTE);
    repointed++;
  }
  if (repointed > 0) actions.push(`repointed ${repointed} source-candidate rows from deprecated canonical to retained canonical`);
  const content = renderCsvTable(table);
  return { content, changed: content !== original, actions };
}

export function validateMergedArtifacts(input: TargetContents): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const universe = parseCsvTable(input.universeCsv);
  const candidates = parseCsvTable(input.sourceCandidatesCsv);
  const multi = parseCsvTable(input.multiSourceCandidatesCsv);
  const aliasMap = JSON.parse(input.aliasJson) as Record<string, string[]>;

  const retained = universe.rows.find((r) => r["canonical_property_name"] === RETAIN_CANONICAL);
  const deprecated = universe.rows.find((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL);
  const retainedCanonicalExists = Boolean(retained);
  const deprecatedCanonicalMarkedDuplicate = deprecated?.["canonicalization_status"] === DUPLICATE_STATUS;
  const aliasMapUpdated = aliasMap[RETAIN_CANONICAL]?.includes(DEPRECATE_CANONICAL) === true &&
    !Object.prototype.hasOwnProperty.call(aliasMap, DEPRECATE_CANONICAL) &&
    noDuplicateStrings(aliasMap[RETAIN_CANONICAL] ?? []);
  const rakuten5097MapsToRetained =
    hasCandidateId(candidates.rows, "rakuten", APPROVED_RAKUTEN_HOTEL_NO) &&
    hasCandidateId(multi.rows, "rakuten", APPROVED_RAKUTEN_HOTEL_NO);
  const jalan335940MapsToRetained =
    hasCandidateId(candidates.rows, "jalan", APPROVED_JALAN_YAD_ID) &&
    hasCandidateId(multi.rows, "jalan", APPROVED_JALAN_YAD_ID);
  const noDeprecatedCandidateRows =
    !candidates.rows.some((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL) &&
    !multi.rows.some((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL);
  const headersPreserved =
    universe.headers.includes("canonical_property_name") &&
    candidates.headers.includes("canonical_property_name") &&
    multi.headers.includes("canonical_property_name");
  const noForbiddenColumns = [universe.headers, candidates.headers, multi.headers].every((h) => !hasForbiddenColumns(h));

  const checks: Array<[boolean, string]> = [
    [retainedCanonicalExists, "retained canonical is missing"],
    [deprecatedCanonicalMarkedDuplicate, "deprecated canonical is not marked duplicate"],
    [aliasMapUpdated, "alias map is not merged under retained canonical or has duplicates"],
    [rakuten5097MapsToRetained, "Rakuten 5097 does not map to retained canonical in both candidate files"],
    [jalan335940MapsToRetained, "Jalan 335940 does not map to retained canonical in both candidate files"],
    [noDeprecatedCandidateRows, "deprecated canonical still appears in source candidate files"],
    [headersPreserved, "required headers were not preserved"],
    [noForbiddenColumns, "forbidden PMS/upload columns are present"]
  ];
  for (const [ok, error] of checks) {
    if (!ok) errors.push(error);
  }
  if (retained && retained["canonicalization_status"] !== "canonical") {
    warnings.push("retained canonical status was not promoted; existing review status was preserved");
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    retainedCanonicalExists,
    deprecatedCanonicalMarkedDuplicate,
    aliasMapUpdated,
    rakuten5097MapsToRetained,
    jalan335940MapsToRetained,
    noDeprecatedCandidateRows,
    headersPreserved,
    noForbiddenColumns
  };
}

export function summarizeTargets(input: TargetContents): Record<string, unknown> {
  const universe = parseCsvTable(input.universeCsv);
  const candidates = parseCsvTable(input.sourceCandidatesCsv);
  const multi = parseCsvTable(input.multiSourceCandidatesCsv);
  const aliasMap = JSON.parse(input.aliasJson) as Record<string, string[]>;
  return {
    universe_row_count: universe.rows.length,
    source_candidates_row_count: candidates.rows.length,
    multi_source_candidates_row_count: multi.rows.length,
    alias_map_key_count: Object.keys(aliasMap).length,
    retained_universe_rows: universe.rows.filter((r) => r["canonical_property_name"] === RETAIN_CANONICAL).length,
    deprecated_universe_rows: universe.rows.filter((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL).length,
    retained_candidate_rows: candidates.rows.filter((r) => r["canonical_property_name"] === RETAIN_CANONICAL).length,
    deprecated_candidate_rows: candidates.rows.filter((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL).length,
    retained_multi_candidate_rows: multi.rows.filter((r) => r["canonical_property_name"] === RETAIN_CANONICAL).length,
    deprecated_multi_candidate_rows: multi.rows.filter((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL).length
  };
}

export function createBackupDir(rootDir: string, timestamp: string): string {
  return resolve(rootDir, ".data/exports/zao-universe-review/.backup", `${timestamp}_matsukaneya_merge`);
}

export function backupTargets(cwd: string, targetPaths: readonly string[], backupDir: string): string[] {
  mkdirSync(backupDir, { recursive: true });
  const actions: string[] = [];
  for (const rel of targetPaths) {
    const src = resolve(cwd, rel);
    const dest = join(backupDir, basename(rel));
    copyFileSync(src, dest);
    actions.push(`${src} -> ${dest}`);
  }
  return actions;
}

export function writeTargetsAtomically(cwd: string, updates: Record<string, string>): string[] {
  const actions: string[] = [];
  for (const [rel, content] of Object.entries(updates)) {
    const target = resolve(cwd, rel);
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current === content) {
      actions.push(`skipped_existing:${target}`);
      continue;
    }
    const temp = join(dirname(target), `.${basename(target)}.tmp-matsukaneya`);
    writeFileSync(temp, content, "utf8");
    renameSync(temp, target);
    actions.push(`atomic_rename:${temp}->${target}`);
  }
  return actions;
}

export function restoreTargetsFromBackup(cwd: string, targetPaths: readonly string[], backupDir: string): string[] {
  const actions: string[] = [];
  for (const rel of targetPaths) {
    const backup = join(backupDir, basename(rel));
    const target = resolve(cwd, rel);
    copyFileSync(backup, target);
    actions.push(`${backup} -> ${target}`);
  }
  return actions;
}

export function renderMergeCsv(summary: Record<string, unknown>): string {
  const headers = ["key", "value"];
  const rows = Object.entries(summary).map(([k, v]) => `${csvEscape(k)},${csvEscape(String(v))}`);
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

export function renderMergeReport(input: {
  generatedAtJst: string;
  decision: MatsukaneyaMergeDecision;
  gate: ApprovalGateResult;
  validation: ValidationResult;
  backupPath: string;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugPath: string;
  writeActions: string[];
}): string {
  return [
    "# Matsukaneya Canonical Merge (Phase PD-FIX02X)",
    "",
    `Generated at: ${input.generatedAtJst}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.decision}`,
    `- explicit_user_approved=${bool(input.gate.explicitUserApproved)}`,
    `- env_MATSUKANEYA_MERGE_1=${bool(input.gate.envFlagPresent)}`,
    `- real_update_allowed=${bool(input.gate.realUpdateAllowed)}`,
    `- retain_canonical=${RETAIN_CANONICAL}`,
    `- deprecated_canonical=${DEPRECATE_CANONICAL}`,
    `- rakuten_hotel_no=${APPROVED_RAKUTEN_HOTEL_NO}`,
    `- jalan_yad_id=${APPROVED_JALAN_YAD_ID}`,
    "",
    "## 2. Merge Actions",
    "",
    "- Universe row retained; deprecated row marked duplicate/deprecated, not deleted.",
    "- Alias map moved Matsukaneya aliases under the retained canonical.",
    "- Source-candidate canonical linkage was repointed to the retained canonical while preserving source IDs and URLs.",
    "",
    "## 3. Validation",
    "",
    `- validation_valid=${bool(input.validation.valid)}`,
    `- retained_canonical_exists=${bool(input.validation.retainedCanonicalExists)}`,
    `- deprecated_canonical_marked_duplicate=${bool(input.validation.deprecatedCanonicalMarkedDuplicate)}`,
    `- alias_map_updated=${bool(input.validation.aliasMapUpdated)}`,
    `- rakuten_5097_maps_to_retained=${bool(input.validation.rakuten5097MapsToRetained)}`,
    `- jalan_335940_maps_to_retained=${bool(input.validation.jalan335940MapsToRetained)}`,
    `- no_deprecated_candidate_rows=${bool(input.validation.noDeprecatedCandidateRows)}`,
    `- errors=${input.validation.errors.join(" | ") || "-"}`,
    `- warnings=${input.validation.warnings.join(" | ") || "-"}`,
    "",
    "## 4. Write Actions",
    "",
    ...input.writeActions.map((a) => `- ${a}`),
    "",
    "## 5. Safety Confirmation",
    "",
    "- No DB writes were performed.",
    "- No collectors, probes, paid services, external fetches, GitHub Actions, GitOps, commits, or pushes were run by this merge script.",
    "- .data/history and excluded audit artifacts were not targeted.",
    "- No Beds24 / AirHost / PMS / OTA upload output was produced.",
    "",
    "## 6. Paths",
    "",
    `- backup_path=${input.backupPath || "-"}`,
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugPath}`,
    ""
  ].join("\n");
}

export function parseCsvTable(csv: string): CsvTable {
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
  return { headers, rows: matrix.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}

export function renderCsvTable(table: CsvTable): string {
  const rows = table.rows.map((r) => table.headers.map((h) => csvEscape(r[h] ?? "")).join(","));
  return `${table.headers.join(",")}\n${rows.join("\n")}\n`;
}

function hasCandidateId(rows: Record<string, string>[], source: string, id: string): boolean {
  return rows.some((r) =>
    r["canonical_property_name"] === RETAIN_CANONICAL &&
    r["source"] === source &&
    r["candidate_source_property_id"] === id
  );
}

function joinUniqueList(existing: string, add: readonly string[]): string {
  const out = new Set<string>();
  for (const value of [...existing.split(";"), ...add]) {
    const trimmed = value.trim();
    if (trimmed !== "") out.add(trimmed);
  }
  return [...out].join(";");
}

function appendNote(existing: string, note: string): string {
  return existing.includes(note) ? existing : `${existing}${existing.trim() === "" ? "" : " "}${note}`;
}

function nonEmpty(value: string | undefined): string {
  return value?.trim() ?? "";
}

function noDuplicateStrings(values: string[]): boolean {
  return values.length === new Set(values).size;
}

function hasForbiddenColumns(headers: string[]): boolean {
  const lower = headers.join(",").toLowerCase();
  return FORBIDDEN_OUTPUT_COLUMN_TOKENS.some((token) => lower.includes(token));
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

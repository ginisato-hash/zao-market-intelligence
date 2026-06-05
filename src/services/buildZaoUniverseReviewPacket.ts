import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CanonicalizationStatus = "canonical" | "needs_review";
export type CandidateSource = "jalan" | "rakuten" | "booking" | "google_hotels";
export type CandidateVerificationStatus = "candidate" | "needs_review";

export interface ZaoUniverseReviewPropertyRow {
  canonicalPropertyName: string;
  canonicalizationStatus: CanonicalizationStatus;
  aliases: string[];
  sourcesPresent: string[];
  jalanUrl: string | null;
  jalanId: string | null;
  rakutenUrl: string | null;
  rakutenId: string | null;
  localSource: string | null;
  evidenceNote: string;
  needsHumanReview: boolean;
  reviewDecision: "pending";
  reviewerNote: "";
}

export interface ZaoSourceCandidateReviewRow {
  canonicalPropertyName: string;
  source: CandidateSource;
  candidatePropertyUrl: string | null;
  candidateSourcePropertyId: string | null;
  verificationStatus: CandidateVerificationStatus;
  evidenceNote: string;
  reviewerNote: string | null;
  humanReviewRequired: true;
  reviewDecision: "pending";
  reviewedPropertyUrl: "";
  reviewedSourcePropertyId: "";
  reviewerNoteOut: "";
}

export interface ZaoExcludedAuditReviewRow {
  source: "jalan" | "rakuten";
  propertyNameRaw: string;
  propertyUrl: string | null;
  sourcePropertyId: string | null;
  exclusionReason: string;
  evidenceNote: string;
  humanReviewRequired: true;
  reviewDecision: "pending";
  reviewerNote: "";
}

export interface ZaoUniverseReviewPacket {
  generatedAt: string;
  propertyRows: ZaoUniverseReviewPropertyRow[];
  candidateRows: ZaoSourceCandidateReviewRow[];
  aliasMap: Record<string, string[]>;
  excludedAuditRows: ZaoExcludedAuditReviewRow[];
  localExtensions: LocalExtensionInput[];
  anchorChecks: AnchorCheckInput[];
  summary: {
    canonicalPropertyCount: number;
    candidateRowCount: number;
    aliasMapCount: number;
    excludedAuditCount: number;
    needsReviewPropertyCount: number;
    countByCanonicalizationStatus: Record<string, number>;
    candidateCountBySource: Record<string, number>;
    candidateFoundBySource: Record<string, number>;
    candidateMissingBySource: Record<string, number>;
  };
}

interface SourceRefInput {
  property_url: string;
  source_property_id: string;
}

interface LocalExtensionInput {
  property_name: string;
  source: "local_operator" | "local_known";
  canonicalization_status: CanonicalizationStatus;
  evidence_note: string;
}

interface UniverseRowInput {
  canonical_property_name: string;
  aliases: string[];
  sources_present: string[];
  jalan: SourceRefInput | null;
  rakuten: SourceRefInput | null;
  local?: LocalExtensionInput | null;
  canonicalization_status: CanonicalizationStatus;
  evidence_note: string;
}

interface UniverseFileInput {
  universe: UniverseRowInput[];
  excluded_audit?: ExcludedAuditInput[];
  anchor_checks?: AnchorCheckInput[];
}

interface CandidateInput {
  property_name: string;
  source: CandidateSource;
  candidate_property_url: string | null;
  candidate_source_property_id: string | null;
  evidence_note: string;
  verification_status: CandidateVerificationStatus;
  reviewer_note: string | null;
}

interface ExcludedAuditInput {
  source: "jalan" | "rakuten";
  propertyNameRaw: string;
  propertyUrl: string | null;
  sourcePropertyId: string | null;
  exclusionReason: string;
  evidenceNote: string;
}

interface AnchorCheckInput {
  anchor: string;
  present: boolean;
  canonical_property_name: string | null;
  sources_present: string[];
  canonicalization_status: CanonicalizationStatus | null;
}

export interface ZaoUniverseReviewPacketInput {
  universeFile: UniverseFileInput;
  candidates: CandidateInput[];
  localExtensions: LocalExtensionInput[];
}

export interface ZaoUniverseReviewPacketPaths {
  universePath?: string;
  candidatesPath?: string;
  localExtensionsPath?: string;
}

const DEFAULT_UNIVERSE_PATH = "data/seeds/zao_property_universe.ai-discovered.local.json";
const DEFAULT_CANDIDATES_PATH = "data/seeds/source_coverage_candidates.990-2301.ai-discovered.local.json";
const DEFAULT_LOCAL_EXTENSIONS_PATH = "data/seeds/zao_local_property_extensions.json";

export function loadZaoUniverseReviewPacketInput(
  paths: ZaoUniverseReviewPacketPaths = {}
): ZaoUniverseReviewPacketInput {
  const universePath = paths.universePath ?? DEFAULT_UNIVERSE_PATH;
  const candidatesPath = paths.candidatesPath ?? DEFAULT_CANDIDATES_PATH;
  const localExtensionsPath = paths.localExtensionsPath ?? DEFAULT_LOCAL_EXTENSIONS_PATH;
  return {
    universeFile: JSON.parse(readFileSync(resolve(universePath), "utf-8")) as UniverseFileInput,
    candidates: JSON.parse(readFileSync(resolve(candidatesPath), "utf-8")) as CandidateInput[],
    localExtensions: JSON.parse(readFileSync(resolve(localExtensionsPath), "utf-8")) as LocalExtensionInput[]
  };
}

export function buildZaoUniverseReviewPacket(
  input: ZaoUniverseReviewPacketInput,
  generatedAt = new Date().toISOString()
): ZaoUniverseReviewPacket {
  const propertyRows = input.universeFile.universe.map((row): ZaoUniverseReviewPropertyRow => ({
    canonicalPropertyName: row.canonical_property_name,
    canonicalizationStatus: row.canonicalization_status,
    aliases: row.aliases ?? [],
    sourcesPresent: row.sources_present ?? [],
    jalanUrl: row.jalan?.property_url ?? null,
    jalanId: row.jalan?.source_property_id ?? null,
    rakutenUrl: row.rakuten?.property_url ?? null,
    rakutenId: row.rakuten?.source_property_id ?? null,
    localSource: row.local?.source ?? null,
    evidenceNote: row.evidence_note,
    needsHumanReview: row.canonicalization_status === "needs_review",
    reviewDecision: "pending",
    reviewerNote: ""
  }));

  const candidateRows = input.candidates.map((row): ZaoSourceCandidateReviewRow => ({
    canonicalPropertyName: row.property_name,
    source: row.source,
    candidatePropertyUrl: row.candidate_property_url,
    candidateSourcePropertyId: row.candidate_source_property_id,
    verificationStatus: row.verification_status,
    evidenceNote: row.evidence_note,
    reviewerNote: row.reviewer_note,
    humanReviewRequired: true,
    reviewDecision: "pending",
    reviewedPropertyUrl: "",
    reviewedSourcePropertyId: "",
    reviewerNoteOut: ""
  }));

  const aliasMap = Object.fromEntries(
    propertyRows
      .filter((row) => row.aliases.length > 0)
      .map((row) => [row.canonicalPropertyName, row.aliases])
  );

  const excludedAuditRows = (input.universeFile.excluded_audit ?? []).map(
    (row): ZaoExcludedAuditReviewRow => ({
      source: row.source,
      propertyNameRaw: row.propertyNameRaw,
      propertyUrl: row.propertyUrl,
      sourcePropertyId: row.sourcePropertyId,
      exclusionReason: row.exclusionReason,
      evidenceNote: row.evidenceNote,
      humanReviewRequired: true,
      reviewDecision: "pending",
      reviewerNote: ""
    })
  );

  return {
    generatedAt,
    propertyRows,
    candidateRows,
    aliasMap,
    excludedAuditRows,
    localExtensions: input.localExtensions,
    anchorChecks: input.universeFile.anchor_checks ?? [],
    summary: summarizeReviewPacket(propertyRows, candidateRows, aliasMap, excludedAuditRows)
  };
}

function summarizeReviewPacket(
  propertyRows: ZaoUniverseReviewPropertyRow[],
  candidateRows: ZaoSourceCandidateReviewRow[],
  aliasMap: Record<string, string[]>,
  excludedAuditRows: ZaoExcludedAuditReviewRow[]
): ZaoUniverseReviewPacket["summary"] {
  const countByCanonicalizationStatus: Record<string, number> = {};
  for (const row of propertyRows) {
    countByCanonicalizationStatus[row.canonicalizationStatus] =
      (countByCanonicalizationStatus[row.canonicalizationStatus] ?? 0) + 1;
  }

  const candidateCountBySource: Record<string, number> = {};
  const candidateFoundBySource: Record<string, number> = {};
  const candidateMissingBySource: Record<string, number> = {};
  for (const row of candidateRows) {
    candidateCountBySource[row.source] = (candidateCountBySource[row.source] ?? 0) + 1;
    if (row.candidatePropertyUrl || row.candidateSourcePropertyId) {
      candidateFoundBySource[row.source] = (candidateFoundBySource[row.source] ?? 0) + 1;
    } else {
      candidateMissingBySource[row.source] = (candidateMissingBySource[row.source] ?? 0) + 1;
    }
  }

  return {
    canonicalPropertyCount: propertyRows.length,
    candidateRowCount: candidateRows.length,
    aliasMapCount: Object.keys(aliasMap).length,
    excludedAuditCount: excludedAuditRows.length,
    needsReviewPropertyCount: propertyRows.filter((row) => row.needsHumanReview).length,
    countByCanonicalizationStatus,
    candidateCountBySource,
    candidateFoundBySource,
    candidateMissingBySource
  };
}

export const PROPERTY_CSV_HEADERS = [
  "canonical_property_name",
  "canonicalization_status",
  "aliases",
  "sources_present",
  "jalan_url",
  "jalan_id",
  "rakuten_url",
  "rakuten_id",
  "local_source",
  "evidence_note",
  "needs_human_review",
  "review_decision",
  "reviewer_note"
] as const;

export const CANDIDATE_CSV_HEADERS = [
  "canonical_property_name",
  "source",
  "candidate_property_url",
  "candidate_source_property_id",
  "verification_status",
  "evidence_note",
  "current_reviewer_note",
  "human_review_required",
  "review_decision",
  "reviewed_property_url",
  "reviewed_source_property_id",
  "reviewer_note"
] as const;

export const EXCLUDED_AUDIT_CSV_HEADERS = [
  "source",
  "property_name_raw",
  "property_url",
  "source_property_id",
  "exclusion_reason",
  "evidence_note",
  "human_review_required",
  "review_decision",
  "reviewer_note"
] as const;

export function renderZaoPropertiesCsv(rows: ZaoUniverseReviewPropertyRow[]): string {
  return renderCsv(
    PROPERTY_CSV_HEADERS,
    rows.map((row) => [
      row.canonicalPropertyName,
      row.canonicalizationStatus,
      row.aliases.join(";"),
      row.sourcesPresent.join(";"),
      row.jalanUrl ?? "",
      row.jalanId ?? "",
      row.rakutenUrl ?? "",
      row.rakutenId ?? "",
      row.localSource ?? "",
      row.evidenceNote,
      String(row.needsHumanReview),
      row.reviewDecision,
      row.reviewerNote
    ])
  );
}

export function renderZaoSourceCandidatesCsv(rows: ZaoSourceCandidateReviewRow[]): string {
  return renderCsv(
    CANDIDATE_CSV_HEADERS,
    rows.map((row) => [
      row.canonicalPropertyName,
      row.source,
      row.candidatePropertyUrl ?? "",
      row.candidateSourcePropertyId ?? "",
      row.verificationStatus,
      row.evidenceNote,
      row.reviewerNote ?? "",
      String(row.humanReviewRequired),
      row.reviewDecision,
      row.reviewedPropertyUrl,
      row.reviewedSourcePropertyId,
      row.reviewerNoteOut
    ])
  );
}

export function renderZaoExcludedAuditCsv(rows: ZaoExcludedAuditReviewRow[]): string {
  return renderCsv(
    EXCLUDED_AUDIT_CSV_HEADERS,
    rows.map((row) => [
      row.source,
      row.propertyNameRaw,
      row.propertyUrl ?? "",
      row.sourcePropertyId ?? "",
      row.exclusionReason,
      row.evidenceNote,
      String(row.humanReviewRequired),
      row.reviewDecision,
      row.reviewerNote
    ])
  );
}

export function renderZaoUniverseReviewMarkdown(packet: ZaoUniverseReviewPacket): string {
  const summary = packet.summary;
  const priorityRows = buildHumanReviewPriorities(packet);
  const lines = [
    "# Zao Universe Human Review Packet",
    "",
    `Generated at: ${packet.generatedAt}`,
    "",
    "## Warning",
    "",
    "This packet is for human review only.",
    "It is not an import file.",
    "It is not a PMS/OTA upload file.",
    "It contains no prices.",
    "Do not run import or promotion until reviewed and explicitly approved.",
    "",
    "## Summary",
    "",
    `- canonical_property_count=${summary.canonicalPropertyCount}`,
    `- candidate_row_count=${summary.candidateRowCount}`,
    `- count_by_canonicalization_status=${JSON.stringify(summary.countByCanonicalizationStatus)}`,
    `- candidate_count_by_source=${JSON.stringify(summary.candidateCountBySource)}`,
    `- candidate_found_by_source=${JSON.stringify(summary.candidateFoundBySource)}`,
    `- candidate_missing_by_source=${JSON.stringify(summary.candidateMissingBySource)}`,
    `- needs_review_property_count=${summary.needsReviewPropertyCount}`,
    "",
    "## Local / Operator Extensions",
    "",
    ...packet.localExtensions.map(
      (row) =>
        `- ${row.property_name}: ${row.source}, ${row.canonicalization_status}. ${row.evidence_note}`
    ),
    "",
    "## Alias Merge Summary",
    "",
    ...Object.entries(packet.aliasMap).map(([canonical, aliases]) => `- ${canonical}: ${aliases.join("; ")}`),
    "",
    "## Anchor Check Summary",
    "",
    "| anchor | present | canonical | sources | status |",
    "|---|---:|---|---|---|",
    ...packet.anchorChecks.map(
      (row) =>
        `| ${row.anchor} | ${row.present} | ${row.canonical_property_name ?? ""} | ${row.sources_present.join(";")} | ${row.canonicalization_status ?? ""} |`
    ),
    "",
    "## Source Candidate Coverage Matrix Summary",
    "",
    `- Found by source: ${JSON.stringify(summary.candidateFoundBySource)}`,
    `- Missing by source: ${JSON.stringify(summary.candidateMissingBySource)}`,
    "",
    "## Excluded Audit Summary",
    "",
    `- excluded_audit_count=${summary.excludedAuditCount}`,
    "",
    "## Human Review Priority",
    "",
    ...priorityRows.map((row, index) => `${index + 1}. ${row}`),
    "",
    "## Human Review Checklist",
    "",
    "- Review all needs_review properties",
    "- Review local_known rows",
    "- Review alias merges",
    "- Review missing source IDs",
    "- Fill reviewed_property_url / reviewed_source_property_id only after opening exact property page",
    "- Do not collect prices",
    "- Do not run import/promotion yet",
    ""
  ];
  return lines.join("\n");
}

function buildHumanReviewPriorities(packet: ZaoUniverseReviewPacket): string[] {
  const requested: Array<[string, string]> = [
    ["三浦屋", "rakuten"],
    ["三浦屋", "booking"],
    ["三浦屋", "google_hotels"],
    ["蔵王国際ホテル", "booking"],
    ["蔵王国際ホテル", "google_hotels"],
    ["蔵王四季のホテル", "booking"],
    ["蔵王四季のホテル", "google_hotels"],
    ["深山荘 高見屋", "booking"],
    ["深山荘 高見屋", "google_hotels"],
    ["名湯リゾート ルーセント", "booking"],
    ["名湯リゾート ルーセント", "google_hotels"],
    ["YuiLocalZao", "rakuten"],
    ["YuiLocalZao", "booking"],
    ["ZAO BASE", "rakuten"],
    ["ZAO BASE", "booking"],
    ["シバママのお宿", "jalan"],
    ["シバママのお宿", "rakuten"],
    ["松尾ハウス", "jalan"],
    ["松尾ハウス", "rakuten"],
    ["お食事処・お泊り処・お湯処 ろばた", "jalan/rakuten cross-source merge fields"]
  ];
  return requested.map(([requestedName, source]) => {
    const row = findPropertyRow(packet.propertyRows, requestedName);
    const canonical = row?.canonicalPropertyName ?? requestedName;
    const mapping = canonical === requestedName ? "" : ` (mapped to ${canonical})`;
    return `${canonical} / ${source}${mapping}`;
  });
}

function findPropertyRow(
  rows: ZaoUniverseReviewPropertyRow[],
  requestedName: string
): ZaoUniverseReviewPropertyRow | undefined {
  return rows.find(
    (row) => row.canonicalPropertyName === requestedName || row.aliases.includes(requestedName)
  );
}

function renderCsv(headers: readonly string[], rows: string[][]): string {
  return [headers.map(csvEscape).join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join("\n") + "\n";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, '""')}"`;
  }
  return value;
}

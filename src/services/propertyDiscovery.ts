// Phase AUTO-RUNNER-DISCOVERY01 - unified property discovery dry run.
//
// Pure helpers for review-ready property discovery. This module performs no
// network collection, no history append, no DB sync, no AI context refresh, no
// property-master write, and no collector-target update.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VERIFIED_BOOKING_TARGETS } from "./autoRunnerBookingPreview";
import { VERIFIED_JALAN_TARGETS } from "./autoRunnerMarketRefresh";
import {
  levenshteinRatio,
  normalizePropertyNameForMatching,
  similarityScore
} from "./propertyNameNormalization";

export type DiscoveryClassification =
  | "new_candidate"
  | "alias_candidate"
  | "duplicate_candidate"
  | "closed_or_inactive_candidate"
  | "out_of_scope_candidate"
  | "hold_candidate";

export type HumanDecision =
  | ""
  | "approve_new"
  | "approve_alias"
  | "reject_duplicate"
  | "reject_out_of_scope"
  | "reject_inactive"
  | "hold";

export interface DiscoverySeed {
  candidate_name: string;
  evidence_summary: string;
  metadata?: {
    likely_lodging?: boolean;
    likely_zao_onsen?: boolean;
    closed_or_inactive?: boolean;
    out_of_scope?: boolean;
    hold?: boolean;
    notes?: string;
  };
}

export interface ExistingPropertyEntry {
  canonical_property_name: string;
  key: string;
  normalized_name: string;
  aliases: string[];
  source_evidence: string[];
}

export interface DiscoveryCandidateRow {
  candidate_name: string;
  normalized_name: string;
  classification: DiscoveryClassification;
  confidence: number;
  matched_existing_property: string;
  matched_existing_key: string;
  recommended_action: HumanDecision;
  human_decision: "";
  source_evidence_count: number;
  source_evidence_summary: string;
  reason_codes: string[];
  notes: string;
}

export interface DiscoverySummary {
  total_candidates: number;
  classification_counts: Record<string, number>;
  recommended_action_counts: Record<string, number>;
  existing_target_coverage: {
    comparison_base: string;
    booking_targets: number;
    jalan_targets: number;
    alias_seed_canonicals: number;
    history_known_properties: number;
    total_existing_entries: number;
    central_property_master_present: boolean;
  };
  safety_confirmation: {
    mode: "dry_run";
    network_collection_executed: false;
    live_collector_run: false;
    history_modified: false;
    db_synced: false;
    ai_context_refreshed: false;
    property_master_written: false;
    collector_target_updated: false;
    pricing_or_pms_output_generated: false;
  };
}

export interface DiscoveryResult {
  decision: "auto_runner_discovery01_ready";
  run_id: string;
  generated_at_jst: string;
  mode: "dry_run";
  rows: DiscoveryCandidateRow[];
  summary: DiscoverySummary;
  next_recommended_phase: "D05 approved properties master update";
}

export const DISCOVERY_SEEDS: readonly DiscoverySeed[] = [
  { candidate_name: "BED'n ONSEN HAMMOND", evidence_summary: "manual seed / known lodging candidate" },
  { candidate_name: "JURIN", evidence_summary: "manual seed / known lodging candidate" },
  { candidate_name: "ＫＫＲ蔵王 白銀荘", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "ONSEN & STAY OAKHILL", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "YuiLocalZao", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "ZAO BASE", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "えびや旅館", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "おおみや旅館", evidence_summary: "manual seed / lodging name candidate" },
  {
    candidate_name: "お食事処・お泊り処・お湯処 ろばた",
    evidence_summary: "manual seed / mixed restaurant, lodging, bath wording",
    metadata: { hold: true, notes: "Mixed restaurant/day-use wording; human should verify lodging scope before any master update." }
  },
  { candidate_name: "こけしの宿 招仙閣", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "シバママのお宿", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "たかみや瑠璃倶楽", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "ぼくのうち", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "ホテル ラルジャン蔵王", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "ロッジスガノ", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "松尾ハウス", evidence_summary: "manual seed / lodging name candidate" },
  { candidate_name: "ホテル喜らく", evidence_summary: "manual seed / known lodging candidate" },
  { candidate_name: "ル・ベール蔵王", evidence_summary: "manual seed / known lodging candidate" },
  { candidate_name: "蔵王四季のホテル", evidence_summary: "manual seed / active Booking target" },
  { candidate_name: "蔵王国際ホテル", evidence_summary: "manual seed / active Booking target" },
  { candidate_name: "深山荘高見屋", evidence_summary: "manual seed / active Booking target alias" },
  { candidate_name: "蔵王プラザホテル", evidence_summary: "manual seed / lodging name candidate" }
] as const;

const LODGING_TOKENS = /ホテル|旅館|宿|ロッジ|ロッヂ|ハウス|onsen|stay|base|jurin|hammond|oakhill|yuilocalzao|zao/iu;
const NON_LODGING_TOKENS = /食事処|日帰り|売店|レストラン|restaurant|観光案内|スキー場|ロープウェイ/iu;
const CLOSED_TOKENS = /閉館|閉業|休業|廃業|closed|inactive/iu;
const STRONG_ALIAS_THRESHOLD = 0.92;
const MEDIUM_ALIAS_THRESHOLD = 0.82;

export function normalizeDiscoveryName(name: string): string {
  return normalizePropertyNameForMatching(name)
    .replace(/^蔵王温泉\s*/u, "")
    .replace(/\s*蔵王温泉$/u, "")
    .replace(/\s+/gu, "")
    .replace(/^ホテル/u, "")
    .replace(/ホテル$/u, "")
    .replace(/旅館$/u, "");
}

export function keyForName(name: string): string {
  return normalizeDiscoveryName(name);
}

export function buildExistingPropertyEntries(input?: {
  aliasSeedJson?: string;
  historyCsvs?: string[];
}): ExistingPropertyEntry[] {
  const merged = new Map<string, ExistingPropertyEntry>();

  const add = (canonical: string, aliases: string[], evidence: string): void => {
    const trimmed = canonical.trim();
    if (!trimmed) return;
    const key = keyForName(trimmed);
    const current = merged.get(key) ?? {
      canonical_property_name: trimmed,
      key,
      normalized_name: normalizeDiscoveryName(trimmed),
      aliases: [],
      source_evidence: []
    };
    for (const alias of aliases) {
      if (alias.trim() && !current.aliases.includes(alias.trim())) current.aliases.push(alias.trim());
    }
    if (!current.source_evidence.includes(evidence)) current.source_evidence.push(evidence);
    merged.set(key, current);
  };

  for (const target of VERIFIED_BOOKING_TARGETS) add(target.canonicalPropertyName, [target.slug], "booking_target");
  for (const target of VERIFIED_JALAN_TARGETS) add(target.canonicalPropertyName, [target.jalanYadId], "jalan_target");

  for (const row of parseAliasSeed(input?.aliasSeedJson ?? readOptional("data/seeds/property_aliases.990-2301.sample.json"))) {
    add(row.canonical_property_name, row.aliases, "alias_seed");
  }

  const historyCsvs = input?.historyCsvs ?? readHistoryCsvs();
  for (const csv of historyCsvs) {
    for (const row of parseCsv(csv)) {
      const canonical = row["canonical_property_name"] ?? "";
      if (canonical) add(canonical, [], "history_known_property");
    }
  }

  return [...merged.values()].sort((a, b) => a.canonical_property_name.localeCompare(b.canonical_property_name, "ja"));
}

export function classifyDiscoverySeed(seed: DiscoverySeed, existing: readonly ExistingPropertyEntry[]): DiscoveryCandidateRow {
  const normalized = normalizeDiscoveryName(seed.candidate_name);
  const evidenceCount = 1;
  const exact = existing.find((entry) => normalizedMatchesEntry(normalized, entry));
  const best = exact ?? bestMatch(normalized, existing);
  const reasonCodes: string[] = [];

  if (seed.metadata?.closed_or_inactive || CLOSED_TOKENS.test(seed.candidate_name)) {
    reasonCodes.push("closed_or_inactive_signal");
    return row(seed, normalized, "closed_or_inactive_candidate", 0.72, best, "reject_inactive", reasonCodes);
  }

  if (seed.metadata?.hold) {
    reasonCodes.push("manual_hold_seed");
    if (best) reasonCodes.push(`best_match_similarity:${similarityFor(normalized, best).toFixed(2)}`);
    return row(seed, normalized, "hold_candidate", 0.55, best, "hold", reasonCodes);
  }

  if (seed.metadata?.out_of_scope || (!looksLodgingLike(seed) && NON_LODGING_TOKENS.test(seed.candidate_name))) {
    reasonCodes.push("out_of_scope_or_non_lodging_signal");
    return row(seed, normalized, "out_of_scope_candidate", 0.7, best, "reject_out_of_scope", reasonCodes);
  }

  if (exact) {
    const basicCandidate = normalizePropertyNameForMatching(seed.candidate_name).replace(/\s+/gu, "");
    const basicNames = [exact.canonical_property_name, ...exact.aliases].map((name) => normalizePropertyNameForMatching(name).replace(/\s+/gu, ""));
    const explicitAliasMatch = exact.aliases.some((alias) => normalizePropertyNameForMatching(alias).replace(/\s+/gu, "") === basicCandidate);
    if (explicitAliasMatch && seed.candidate_name !== exact.canonical_property_name) {
      reasonCodes.push("exact_alias_match");
      return row(seed, normalized, "alias_candidate", 0.9, exact, "approve_alias", reasonCodes);
    }
    if (!basicNames.includes(basicCandidate)) {
      reasonCodes.push("prefix_removed_match");
      return row(seed, normalized, "alias_candidate", 0.86, exact, "approve_alias", reasonCodes);
    }
    reasonCodes.push("strong_existing_match");
    return row(seed, normalized, "duplicate_candidate", 0.98, exact, "reject_duplicate", reasonCodes);
  }

  if (best) {
    const score = similarityFor(normalized, best);
    if (score >= STRONG_ALIAS_THRESHOLD) {
      reasonCodes.push("strong_alias_like_match");
      return row(seed, normalized, "alias_candidate", round2(score), best, "approve_alias", reasonCodes);
    }
    if (score >= MEDIUM_ALIAS_THRESHOLD) {
      reasonCodes.push("medium_alias_like_match");
      return row(seed, normalized, "alias_candidate", round2(score), best, "approve_alias", reasonCodes);
    }
  }

  if (!looksLodgingLike(seed)) {
    reasonCodes.push("unclear_lodging_signal");
    return row(seed, normalized, "hold_candidate", 0.52, best, "hold", reasonCodes);
  }

  reasonCodes.push("no_existing_match", "lodging_name_candidate");
  return row(seed, normalized, "new_candidate", 0.82, undefined, "approve_new", reasonCodes);
}

export function buildPropertyDiscoveryResult(input?: {
  runId?: string;
  generatedAtJst?: string;
  seeds?: readonly DiscoverySeed[];
  existing?: readonly ExistingPropertyEntry[];
}): DiscoveryResult {
  const rows = (input?.seeds ?? DISCOVERY_SEEDS).map((seed) =>
    classifyDiscoverySeed(seed, input?.existing ?? buildExistingPropertyEntries())
  );
  const existing = input?.existing ?? buildExistingPropertyEntries();
  const summary: DiscoverySummary = {
    total_candidates: rows.length,
    classification_counts: countBy(rows.map((r) => r.classification)),
    recommended_action_counts: countBy(rows.map((r) => r.recommended_action)),
    existing_target_coverage: {
      comparison_base: "collector targets + alias seed + local history known canonical names",
      booking_targets: VERIFIED_BOOKING_TARGETS.length,
      jalan_targets: VERIFIED_JALAN_TARGETS.length,
      alias_seed_canonicals: existing.filter((e) => e.source_evidence.includes("alias_seed")).length,
      history_known_properties: existing.filter((e) => e.source_evidence.includes("history_known_property")).length,
      total_existing_entries: existing.length,
      central_property_master_present: false
    },
    safety_confirmation: {
      mode: "dry_run",
      network_collection_executed: false,
      live_collector_run: false,
      history_modified: false,
      db_synced: false,
      ai_context_refreshed: false,
      property_master_written: false,
      collector_target_updated: false,
      pricing_or_pms_output_generated: false
    }
  };
  return {
    decision: "auto_runner_discovery01_ready",
    run_id: input?.runId ?? "property_discovery_test",
    generated_at_jst: input?.generatedAtJst ?? "2026-06-07T00:00:00+09:00",
    mode: "dry_run",
    rows,
    summary,
    next_recommended_phase: "D05 approved properties master update"
  };
}

export const DISCOVERY_CSV_HEADERS = [
  "candidate_name",
  "normalized_name",
  "classification",
  "confidence",
  "matched_existing_property",
  "matched_existing_key",
  "recommended_action",
  "human_decision",
  "source_evidence_count",
  "source_evidence_summary",
  "reason_codes",
  "notes"
] as const;

export function renderDiscoveryCsv(rows: readonly DiscoveryCandidateRow[]): string {
  return [
    DISCOVERY_CSV_HEADERS.join(","),
    ...rows.map((r) =>
      DISCOVERY_CSV_HEADERS.map((h) => csvEscape(h === "reason_codes" ? r.reason_codes.join("|") : String(r[h] ?? ""))).join(",")
    )
  ].join("\n") + "\n";
}

export function renderDiscoveryMarkdown(result: DiscoveryResult): string {
  const byClass = (cls: DiscoveryClassification): DiscoveryCandidateRow[] => result.rows.filter((r) => r.classification === cls);
  const bullets = (rows: readonly DiscoveryCandidateRow[]): string[] =>
    rows.length === 0
      ? ["- none"]
      : rows.map((r) => `- ${r.candidate_name}: ${r.classification}, action=${r.recommended_action}, match=${r.matched_existing_property || "none"}, reasons=${r.reason_codes.join("|")}`);

  return [
    "# Property Discovery Dry Run",
    "",
    `- run timestamp JST: ${result.generated_at_jst}`,
    `- mode: ${result.mode}`,
    `- decision: ${result.decision}`,
    `- total candidates: ${result.summary.total_candidates}`,
    "",
    "## Classification Counts",
    ...objectLines(result.summary.classification_counts),
    "",
    "## Recommended Action Counts",
    ...objectLines(result.summary.recommended_action_counts),
    "",
    "## New Candidates",
    ...bullets(byClass("new_candidate")),
    "",
    "## Alias Candidates",
    ...bullets(byClass("alias_candidate")),
    "",
    "## Duplicates",
    ...bullets(byClass("duplicate_candidate")),
    "",
    "## Hold Candidates",
    ...bullets(byClass("hold_candidate")),
    "",
    "## Out-of-Scope / Inactive Candidates",
    ...bullets([...byClass("out_of_scope_candidate"), ...byClass("closed_or_inactive_candidate")]),
    "",
    "## Existing Target Coverage Summary",
    `- comparison base: ${result.summary.existing_target_coverage.comparison_base}`,
    `- central property master present: ${result.summary.existing_target_coverage.central_property_master_present}`,
    `- Booking targets: ${result.summary.existing_target_coverage.booking_targets}`,
    `- Jalan targets: ${result.summary.existing_target_coverage.jalan_targets}`,
    `- alias seed canonicals: ${result.summary.existing_target_coverage.alias_seed_canonicals}`,
    `- history known properties: ${result.summary.existing_target_coverage.history_known_properties}`,
    "",
    "## Human Approval Instructions",
    "- approve_new: later add to properties master as inactive first, then dry-run collector mapping, then active.",
    "- approve_alias: later add alias to existing property.",
    "- reject_duplicate: do not add.",
    "- reject_out_of_scope: do not add.",
    "- reject_inactive: do not add unless reactivated.",
    "- hold: revisit later.",
    "",
    "## Safety",
    ...Object.entries(result.summary.safety_confirmation).map(([k, v]) => `- ${k}: ${v}`),
    "",
    `## Next Recommended Phase`,
    `- ${result.next_recommended_phase}`,
    ""
  ].join("\n");
}

export function renderDiscoveryJson(result: DiscoveryResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function normalizedMatchesEntry(normalized: string, entry: ExistingPropertyEntry): boolean {
  if (normalized === entry.normalized_name) return true;
  return entry.aliases.some((alias) => normalized === normalizeDiscoveryName(alias));
}

function bestMatch(normalized: string, existing: readonly ExistingPropertyEntry[]): ExistingPropertyEntry | undefined {
  let best: { entry: ExistingPropertyEntry; score: number } | undefined;
  for (const entry of existing) {
    const score = similarityFor(normalized, entry);
    if (!best || score > best.score) best = { entry, score };
  }
  return best && best.score >= MEDIUM_ALIAS_THRESHOLD ? best.entry : undefined;
}

function similarityFor(normalized: string, entry: ExistingPropertyEntry): number {
  const names = [entry.normalized_name, ...entry.aliases.map(normalizeDiscoveryName)].filter(Boolean);
  return Math.max(...names.map((name) => Math.max(similarityScore(normalized, name), levenshteinRatio(normalized, name))));
}

function row(
  seed: DiscoverySeed,
  normalized: string,
  classification: DiscoveryClassification,
  confidence: number,
  match: ExistingPropertyEntry | undefined,
  recommendedAction: HumanDecision,
  reasonCodes: string[]
): DiscoveryCandidateRow {
  return {
    candidate_name: seed.candidate_name,
    normalized_name: normalized,
    classification,
    confidence: round2(confidence),
    matched_existing_property: match?.canonical_property_name ?? "",
    matched_existing_key: match?.key ?? "",
    recommended_action: recommendedAction,
    human_decision: "",
    source_evidence_count: 1,
    source_evidence_summary: seed.evidence_summary,
    reason_codes: reasonCodes,
    notes: seed.metadata?.notes ?? "Needs human approval before any master update."
  };
}

function looksLodgingLike(seed: DiscoverySeed): boolean {
  if (seed.metadata?.likely_lodging !== undefined) return seed.metadata.likely_lodging;
  return LODGING_TOKENS.test(seed.candidate_name) || !NON_LODGING_TOKENS.test(seed.candidate_name);
}

function parseAliasSeed(json: string): Array<{ canonical_property_name: string; aliases: string[] }> {
  if (!json.trim()) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      const canonical = typeof record["canonical_property_name"] === "string" ? record["canonical_property_name"] : "";
      const aliases = Array.isArray(record["aliases"]) ? record["aliases"].filter((x): x is string => typeof x === "string") : [];
      return canonical ? [{ canonical_property_name: canonical, aliases }] : [];
    });
  } catch {
    return [];
  }
}

function readHistoryCsvs(): string[] {
  const dir = resolve(".data/history");
  if (!existsSync(dir)) return [];
  const months = ["2026_05", "2026_06", "2026_07", "2026_08", "2026_09", "2026_10", "2026_11", "2026_12"];
  return months.map((m) => readOptional(join(".data/history", `zao_signals_${m}.csv`))).filter((x) => x.trim());
}

function readOptional(path: string): string {
  const abs = resolve(path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

function parseCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const out: Record<string, string> = {};
    headers.forEach((h, i) => { out[h] = values[i] ?? ""; });
    return out;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, '""')}"`;
  return value;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function objectLines(obj: Record<string, number>): string[] {
  const entries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? ["- none"] : entries.map(([k, v]) => `- ${k}: ${v}`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

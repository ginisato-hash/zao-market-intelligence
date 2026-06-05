import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SourceCoverageCandidateRecord } from "../seeds/sourceCoverageCandidateSchema";
import type {
  CanonicalizationStatus,
  LocalPropertyExtension,
  UniverseSourceRef
} from "../services/buildZaoPropertyUniverse";

/**
 * Phase 46.6X Deliverable 4 — turn the canonical Zao Onsen universe into a
 * source-coverage candidate file covering EVERY canonical property × 4 sources
 * (jalan, rakuten, booking, google_hotels).
 *
 *  - jalan / rakuten: rows where the source-page extraction found a URL+id are
 *    emitted as `needs_review` (human must confirm the listing in a browser).
 *  - booking / google_hotels: no first-party listing page was parsed in this
 *    phase, so these are `candidate` placeholders with null URL/id. We never
 *    invent a Booking slug or a Google entity token, and never use `confirmed`.
 */

export const ALL_SOURCE_CANDIDATE_SOURCES = ["jalan", "rakuten", "booking", "google_hotels"] as const;
export type AllSourceCandidateSource = (typeof ALL_SOURCE_CANDIDATE_SOURCES)[number];

interface UniverseRowInput {
  canonical_property_name: string;
  aliases: string[];
  sources_present: string[];
  jalan: UniverseSourceRef | null;
  rakuten: UniverseSourceRef | null;
  local?: LocalPropertyExtension | null;
  canonicalization_status: CanonicalizationStatus;
  evidence_note: string;
}

interface UniverseFile {
  generated_at: string;
  universe: UniverseRowInput[];
}

function foundRow(
  canonical: string,
  source: AllSourceCandidateSource,
  ref: UniverseSourceRef,
  canonStatus: CanonicalizationStatus
): SourceCoverageCandidateRecord {
  const canonNote =
    canonStatus === "needs_review"
      ? " Canonical name itself is unconfirmed (canonicalization_status=needs_review) — confirm the property identity too."
      : "";
  return {
    property_name: canonical,
    source,
    candidate_property_url: ref.property_url,
    candidate_source_property_id: ref.source_property_id,
    candidate_label: `${source} ${ref.source_property_id} — candidate for ${canonical} (needs human verification)`,
    evidence_note:
      `Extracted from the ${source} Zao Onsen listing page during Phase 46.6X: ${ref.property_url} ` +
      `(id ${ref.source_property_id}). Property-name/location match must be verified in a normal browser before promotion.` +
      canonNote,
    verification_status: "needs_review",
    reviewer_note: null
  };
}

function notFoundRow(
  canonical: string,
  source: AllSourceCandidateSource
): SourceCoverageCandidateRecord {
  return {
    property_name: canonical,
    source,
    candidate_property_url: null,
    candidate_source_property_id: null,
    candidate_label: null,
    evidence_note: `No ${source} candidate was discovered for "${canonical}" during Phase 46.6X source-page extraction. Manual discovery required; no identifier was invented.`,
    verification_status: "candidate",
    reviewer_note: null
  };
}

export function generateAllSourceCandidatesFromUniverse(
  universe: UniverseRowInput[]
): SourceCoverageCandidateRecord[] {
  const rows: SourceCoverageCandidateRecord[] = [];
  for (const row of universe) {
    const canonical = row.canonical_property_name;
    for (const source of ALL_SOURCE_CANDIDATE_SOURCES) {
      if (source === "jalan" && row.jalan) {
        rows.push(foundRow(canonical, source, row.jalan, row.canonicalization_status));
      } else if (source === "rakuten" && row.rakuten) {
        rows.push(foundRow(canonical, source, row.rakuten, row.canonicalization_status));
      } else {
        rows.push(notFoundRow(canonical, source));
      }
    }
  }
  return rows;
}

const DEFAULT_UNIVERSE_PATH = "data/seeds/zao_property_universe.ai-discovered.local.json";
const DEFAULT_OUT_PATH = "data/seeds/source_coverage_candidates.990-2301.ai-discovered.local.json";

if (process.argv[1]?.endsWith("generateAllSourceCandidatesFromUniverse.ts")) {
  const universePath = process.env["ZAO_UNIVERSE_FILE"] ?? DEFAULT_UNIVERSE_PATH;
  const outPath = process.env["ALL_SOURCE_CANDIDATES_FILE"] ?? DEFAULT_OUT_PATH;
  const file = JSON.parse(readFileSync(resolve(universePath), "utf-8")) as UniverseFile;
  const rows = generateAllSourceCandidatesFromUniverse(file.universe);
  writeFileSync(resolve(outPath), JSON.stringify(rows, null, 2), "utf-8");

  const bySource: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byStatus[r.verification_status] = (byStatus[r.verification_status] ?? 0) + 1;
  }
  console.log(`universe_count=${file.universe.length}`);
  console.log(`rows=${rows.length} (expected ${file.universe.length * 4})`);
  console.log(`count_by_source=${JSON.stringify(bySource)}`);
  console.log(`count_by_verification_status=${JSON.stringify(byStatus)}`);
  console.log(`output=${resolve(outPath)}`);
}

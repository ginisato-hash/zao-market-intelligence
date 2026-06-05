import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export const ZAO_CANDIDATE_REVIEW_HEADERS = [
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

export type ZaoCandidateReviewHeader = (typeof ZAO_CANDIDATE_REVIEW_HEADERS)[number];
export type ZaoDiscoverySource = "jalan" | "rakuten" | "booking" | "google_hotels";

export type ZaoSourceCandidateReviewRecord = Record<ZaoCandidateReviewHeader, string>;

export interface ZaoSourceDiscoveryResult {
  canonicalPropertyName: string;
  source: ZaoDiscoverySource;
  propertyUrl: string;
  sourcePropertyId?: string;
  evidenceNote: string;
  /**
   * Optional Gemini QA warning embedded into the reviewer note when the
   * discovered URL/slug is plausible but non-canonical or otherwise risky, so a
   * human verifies it before approval. Never marks the row approved/confirmed.
   */
  warningNote?: string;
}

export interface ZaoEnrichmentWarning {
  row?: number;
  key?: string;
  message: string;
}

export interface EnrichZaoMissingSourceCandidatesOptions {
  maxRows: number;
  sourceFilter: ZaoDiscoverySource[];
  priorityOrder?: Array<{ canonicalPropertyName: string; source: ZaoDiscoverySource }>;
}

export interface EnrichZaoMissingSourceCandidatesResult {
  rows: ZaoSourceCandidateReviewRecord[];
  inputRowCount: number;
  outputRowCount: number;
  missingRowCount: number;
  rowsConsideredForDiscovery: number;
  filledCount: number;
  filledBySource: Record<string, number>;
  stillMissingBySource: Record<string, number>;
  duplicateWarnings: ZaoEnrichmentWarning[];
  warnings: ZaoEnrichmentWarning[];
  filledRows: ZaoSourceCandidateReviewRecord[];
}

const REVIEW_FIELDS = new Set<ZaoCandidateReviewHeader>([
  "review_decision",
  "reviewed_property_url",
  "reviewed_source_property_id",
  "reviewer_note"
]);

export const AI_DISCOVERY_NOTE_PREFIX =
  "AI-discovered candidate. Human must verify exact property identity before approval.";

const JALAN_URL_RE = /^https:\/\/www\.jalan\.net\/yad(\d+)\/?$/u;
const RAKUTEN_URL_RE = /^https:\/\/travel\.rakuten\.co\.jp\/HOTEL\/(\d+)\/?$/u;
const BOOKING_URL_RE = /^https:\/\/www\.booking\.com\/hotel\/jp\/([^/.?#]+)(?:\.[a-z-]+)?\.html(?:[?#].*)?$/u;
const GOOGLE_HOTELS_URL_RE = /^https:\/\/www\.google\.com\/travel\/hotels\/entity\/([^/?#]+)(?:[?#].*)?$/u;

export function extractJalanYadId(url: string): string | null {
  return JALAN_URL_RE.exec(url.trim())?.[1] ?? null;
}

export function extractRakutenHotelNo(url: string): string | null {
  return RAKUTEN_URL_RE.exec(url.trim())?.[1] ?? null;
}

export function extractBookingSlug(url: string): string | null {
  return BOOKING_URL_RE.exec(url.trim())?.[1] ?? null;
}

export function extractGoogleHotelsToken(url: string): string | null {
  return GOOGLE_HOTELS_URL_RE.exec(url.trim())?.[1] ?? null;
}

export function normalizeDiscoveredUrlAndId(
  source: ZaoDiscoverySource,
  propertyUrl: string,
  sourcePropertyId?: string
): { propertyUrl: string; sourcePropertyId: string } | null {
  if (source === "jalan") {
    const id = sourcePropertyId?.trim() || extractJalanYadId(propertyUrl);
    return id ? { propertyUrl: `https://www.jalan.net/yad${id}/`, sourcePropertyId: id } : null;
  }
  if (source === "rakuten") {
    const id = sourcePropertyId?.trim() || extractRakutenHotelNo(propertyUrl);
    return id
      ? { propertyUrl: `https://travel.rakuten.co.jp/HOTEL/${id}/`, sourcePropertyId: id }
      : null;
  }
  if (source === "booking") {
    const slug = sourcePropertyId?.trim() || extractBookingSlug(propertyUrl);
    return slug
      ? {
          propertyUrl: `https://www.booking.com/hotel/jp/${slug}.ja.html`,
          sourcePropertyId: slug
        }
      : null;
  }
  const token = sourcePropertyId?.trim() || extractGoogleHotelsToken(propertyUrl);
  return token
    ? {
        propertyUrl: `https://www.google.com/travel/hotels/entity/${token}`,
        sourcePropertyId: token
      }
    : null;
}

export function readZaoCandidateReviewCsv(path: string): ZaoSourceCandidateReviewRecord[] {
  const csv = readFileSync(resolve(path), "utf-8");
  return parseZaoCandidateReviewCsv(csv);
}

export function parseZaoCandidateReviewCsv(csv: string): ZaoSourceCandidateReviewRecord[] {
  const parsed = parseCsv(csv);
  if (parsed.length === 0) {
    throw new Error("candidate CSV is empty");
  }
  const header = parsed[0];
  const expected = [...ZAO_CANDIDATE_REVIEW_HEADERS];
  if (!header || header.join(",") !== expected.join(",")) {
    throw new Error(
      `candidate CSV headers must exactly match ${expected.join(",")}`
    );
  }
  return parsed.slice(1).map((row, rowIndex) => {
    const record = {} as ZaoSourceCandidateReviewRecord;
    for (const [i, key] of expected.entries()) {
      record[key] = row[i] ?? "";
    }
    if (row.length !== expected.length) {
      throw new Error(
        `candidate CSV row ${rowIndex + 2} has ${row.length} columns; expected ${expected.length}`
      );
    }
    return record;
  });
}

export function renderZaoCandidateReviewCsv(rows: ZaoSourceCandidateReviewRecord[]): string {
  return renderCsv(
    [...ZAO_CANDIDATE_REVIEW_HEADERS],
    rows.map((row) => ZAO_CANDIDATE_REVIEW_HEADERS.map((header) => row[header] ?? ""))
  );
}

export function writeZaoCandidateReviewCsv(
  path: string,
  rows: ZaoSourceCandidateReviewRecord[]
): void {
  writeFileSync(resolve(path), renderZaoCandidateReviewCsv(rows), "utf-8");
}

export function enrichZaoMissingSourceCandidates(
  rows: ZaoSourceCandidateReviewRecord[],
  discoveryResults: ZaoSourceDiscoveryResult[],
  options: EnrichZaoMissingSourceCandidatesOptions
): EnrichZaoMissingSourceCandidatesResult {
  const warnings: ZaoEnrichmentWarning[] = [];
  const normalizedResults = new Map<
    string,
    { propertyUrl: string; sourcePropertyId: string; evidenceNote: string; warningNote?: string }
  >();

  for (const result of discoveryResults) {
    const normalized = normalizeDiscoveredUrlAndId(
      result.source,
      result.propertyUrl,
      result.sourcePropertyId
    );
    const key = discoveryKey(result.canonicalPropertyName, result.source);
    if (!normalized) {
      warnings.push({ key, message: `discovery result URL/id did not match ${result.source} pattern` });
      continue;
    }
    normalizedResults.set(key, {
      ...normalized,
      evidenceNote: result.evidenceNote,
      ...(result.warningNote === undefined ? {} : { warningNote: result.warningNote })
    });
  }

  const orderedMissingIndexes = orderMissingRows(rows, options.priorityOrder ?? []);
  const eligibleMissingIndexes = orderedMissingIndexes.filter((index) =>
    options.sourceFilter.includes(rows[index]?.source as ZaoDiscoverySource)
  );
  const rowsToConsider = eligibleMissingIndexes.slice(0, options.maxRows);
  const rowsToConsiderSet = new Set(rowsToConsider);
  const outputRows = rows.map((row) => ({ ...row }));
  const filledRows: ZaoSourceCandidateReviewRecord[] = [];

  for (const index of rowsToConsider) {
    const row = outputRows[index];
    if (!row) continue;
    const result = normalizedResults.get(discoveryKey(row.canonical_property_name, row.source));
    if (!result) continue;

    row.review_decision = "needs_change";
    row.reviewed_property_url = result.propertyUrl;
    row.reviewed_source_property_id = result.sourcePropertyId;
    row.reviewer_note = result.warningNote
      ? `${AI_DISCOVERY_NOTE_PREFIX} ${result.evidenceNote} Gemini QA warning: ${result.warningNote}`
      : `${AI_DISCOVERY_NOTE_PREFIX} ${result.evidenceNote}`;
    filledRows.push(row);
  }

  assertOnlyReviewFieldsChanged(rows, outputRows, warnings);

  const filledBySource: Record<string, number> = {};
  for (const row of filledRows) {
    filledBySource[row.source] = (filledBySource[row.source] ?? 0) + 1;
  }

  const stillMissingBySource: Record<string, number> = {};
  for (let i = 0; i < outputRows.length; i++) {
    const row = outputRows[i];
    if (!row || !isMissingCandidate(row)) continue;
    if (rowsToConsiderSet.has(i) && row.reviewed_property_url && row.reviewed_source_property_id) {
      continue;
    }
    stillMissingBySource[row.source] = (stillMissingBySource[row.source] ?? 0) + 1;
  }

  const duplicateWarnings = findDuplicateDiscoveredSourceIds(outputRows);

  return {
    rows: outputRows,
    inputRowCount: rows.length,
    outputRowCount: outputRows.length,
    missingRowCount: orderedMissingIndexes.length,
    rowsConsideredForDiscovery: rowsToConsider.length,
    filledCount: filledRows.length,
    filledBySource,
    stillMissingBySource,
    duplicateWarnings,
    warnings,
    filledRows
  };
}

export function buildZaoMissingSourceDiscoveryReport(input: {
  generatedAt: string;
  inputCsvPath: string;
  enrichedCsvPath: string;
  result: EnrichZaoMissingSourceCandidatesResult;
  maxRows: number;
  sourceFilter: ZaoDiscoverySource[];
}): string {
  const { result } = input;
  const warningRows = [...result.warnings, ...result.duplicateWarnings];
  const stillMissing = Object.entries(result.stillMissingBySource)
    .map(([source, count]) => `- ${source}: ${count}`)
    .join("\n");
  const filled = result.filledRows
    .map(
      (row) =>
        `- ${row.canonical_property_name} / ${row.source}: ${row.reviewed_property_url} (${row.reviewed_source_property_id})`
    )
    .join("\n");
  const warnings = warningRows
    .map((row) => `- ${row.key ? `${row.key}: ` : ""}${row.message}`)
    .join("\n");

  return [
    "# Zao Multi-Source ID Discovery Report",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## Summary",
    "",
    `- input_candidate_rows=${result.inputRowCount}`,
    `- enriched_candidate_rows=${result.outputRowCount}`,
    `- missing_rows_before_enrichment=${result.missingRowCount}`,
    `- rows_considered_for_discovery=${result.rowsConsideredForDiscovery}`,
    `- filled_count=${result.filledCount}`,
    `- filled_count_by_source=${JSON.stringify(result.filledBySource)}`,
    `- still_missing_count_by_source=${JSON.stringify(result.stillMissingBySource)}`,
    "",
    "## Inputs Used",
    "",
    `- input_csv=${basename(input.inputCsvPath)}`,
    `- enriched_csv=${basename(input.enrichedCsvPath)}`,
    "",
    "## Search Constraints",
    "",
    `- max_rows=${input.maxRows}`,
    `- source_filter=${input.sourceFilter.join(",")}`,
    "- Targeted public search only.",
    "- First-party URL patterns only.",
    "- No paid APIs, no paid SERP APIs, no proxy services, no CAPTCHA bypass, no login/session cookies.",
    "- No price or availability collection.",
    "",
    "## Count By Source",
    "",
    `- filled=${JSON.stringify(result.filledBySource)}`,
    `- still_missing=${JSON.stringify(result.stillMissingBySource)}`,
    "",
    "## Filled Candidates",
    "",
    filled || "- None",
    "",
    "## Still Missing Candidates",
    "",
    stillMissing || "- None",
    "",
    "## Rows Requiring Human Verification",
    "",
    "- Every AI-filled row has review_decision=needs_change.",
    "- Human review must verify exact physical property identity before approval/import.",
    "- No row is approved or confirmed by this report.",
    "",
    "## Warnings / Uncertain Rows",
    "",
    warnings || "- None",
    "",
    "## No-Paid / No-Price Confirmation",
    "",
    "- No paid service was used by the local enrichment writer.",
    "- No price, availability, inventory, PMS, OTA upload, Beds24, or AirHost fields were added.",
    "- No DB rows were written.",
    "",
    "## Next Human Review Step",
    "",
    "- Open the enriched CSV and review each needs_change row in a normal browser.",
    "- Only after human verification should a separate reviewed file be considered for validation/import.",
    ""
  ].join("\n");
}

export function findDuplicateDiscoveredSourceIds(
  rows: ZaoSourceCandidateReviewRecord[]
): ZaoEnrichmentWarning[] {
  const seen = new Map<string, string>();
  const warnings: ZaoEnrichmentWarning[] = [];
  for (const row of rows) {
    const id = row.reviewed_source_property_id.trim();
    if (!id) continue;
    const key = `${row.source}|${id}`;
    const prior = seen.get(key);
    if (prior && prior !== row.canonical_property_name) {
      warnings.push({
        key,
        message: `same discovered source ID appears for different properties: ${prior} and ${row.canonical_property_name}`
      });
    } else {
      seen.set(key, row.canonical_property_name);
    }
  }
  return warnings;
}

function orderMissingRows(
  rows: ZaoSourceCandidateReviewRecord[],
  priorityOrder: Array<{ canonicalPropertyName: string; source: ZaoDiscoverySource }>
): number[] {
  const missingIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isMissingCandidate(row));
  const used = new Set<number>();
  const ordered: number[] = [];

  for (const priority of priorityOrder) {
    const match = missingIndexes.find(
      ({ row, index }) =>
        !used.has(index) &&
        row.canonical_property_name === priority.canonicalPropertyName &&
        row.source === priority.source
    );
    if (match) {
      used.add(match.index);
      ordered.push(match.index);
    }
  }

  for (const { index } of missingIndexes) {
    if (!used.has(index)) ordered.push(index);
  }

  return ordered;
}

function isMissingCandidate(row: ZaoSourceCandidateReviewRecord): boolean {
  return !row.candidate_property_url.trim() && !row.candidate_source_property_id.trim();
}

function discoveryKey(propertyName: string, source: string): string {
  return `${propertyName}|${source}`;
}

function assertOnlyReviewFieldsChanged(
  originalRows: ZaoSourceCandidateReviewRecord[],
  outputRows: ZaoSourceCandidateReviewRecord[],
  warnings: ZaoEnrichmentWarning[]
): void {
  for (let i = 0; i < originalRows.length; i++) {
    const original = originalRows[i];
    const output = outputRows[i];
    if (!original || !output) continue;
    for (const header of ZAO_CANDIDATE_REVIEW_HEADERS) {
      if (REVIEW_FIELDS.has(header)) continue;
      if (original[header] !== output[header]) {
        warnings.push({
          row: i + 2,
          message: `non-review field changed unexpectedly: ${header}`
        });
      }
    }
  }
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    const next = csv[i + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        current += "\"";
        i++;
      } else if (char === "\"") {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(current);
      current = "";
    } else if (char === "\n") {
      row.push(current);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      current = "";
    } else if (char !== "\r") {
      current += char;
    }
  }

  if (current !== "" || row.length > 0) {
    row.push(current);
    rows.push(row);
  }
  return rows;
}

function renderCsv(headers: string[], rows: string[][]): string {
  return [headers.map(csvEscape).join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join("\n") + "\n";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }
  return value;
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sourceCoverageCandidateRecordSchema,
  type SourceCoverageCandidateRecord
} from "../seeds/sourceCoverageCandidateSchema";

export const FIRST5_PROPERTIES = [
  "深山荘 高見屋",
  "名湯リゾート ルーセント",
  "ホテル喜らく",
  "BED'n ONSEN HAMMOND",
  "蔵王温泉 JURIN"
] as const;

export const FIRST5_SOURCES = ["rakuten", "booking", "google_hotels"] as const;

type First5Property = (typeof FIRST5_PROPERTIES)[number];
type First5Source = (typeof FIRST5_SOURCES)[number];

const EXPECTED_ROWS = 15;

const DEFAULT_FILE_PATH =
  "data/seeds/source_coverage_candidates.990-2301.first5.template.json";

// URL pattern regexes — applied to any row that has a non-null URL
const RAKUTEN_URL_RE = /^https:\/\/travel\.rakuten\.co\.jp\/HOTEL\/\d+\/$/;
const BOOKING_URL_RE = /^https:\/\/www\.booking\.com\/hotel\/jp\/[^/]+\.ja\.html$/;
const GOOGLE_HOTELS_URL_RE =
  /^https:\/\/www\.google\.com\/travel\/hotels\/entity\/[A-Za-z0-9_=+/\-]+$/;

// Keyword checks for source-specific confirmed requirements
const BOOKING_COLLECTABILITY_RE =
  /content_visible|safe_price|collectab|stable_access|price_extract/i;
const GOOGLE_FREE_DIRECT_RE = /free_direct|content_visible|safe_price|collectab/i;

export interface ValidationIssue {
  row: number | "file";
  message: string;
}

export interface First5ValidationResult {
  filePath: string;
  rowsCount: number;
  validRowsCount: number;
  invalidRowsCount: number;
  structurallyValid: boolean;
  readyForImport: boolean;
  countBySource: Record<string, number>;
  countByVerificationStatus: Record<string, number>;
  warningsCount: number;
  errorsCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function validateFirst5Candidates(
  rows: unknown[],
  filePath = "<unknown>"
): First5ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const countBySource: Record<string, number> = {};
  const countByVerificationStatus: Record<string, number> = {};
  const invalidRowIndices = new Set<number>();
  const parsedRows: SourceCoverageCandidateRecord[] = [];
  const seenPairs = new Set<string>();

  // File-level: row count
  if (rows.length !== EXPECTED_ROWS) {
    errors.push({
      row: "file",
      message: `expected ${EXPECTED_ROWS} rows, got ${rows.length}`
    });
  }

  for (let i = 0; i < rows.length; i++) {
    const parsed = sourceCoverageCandidateRecordSchema.safeParse(rows[i]);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const msg = issue
        ? `${issue.path.join(".") || "record"}: ${issue.message}`
        : "invalid record";
      errors.push({ row: i, message: msg });
      invalidRowIndices.add(i);
      continue;
    }

    const rec = parsed.data;
    parsedRows.push(rec);

    countBySource[rec.source] = (countBySource[rec.source] ?? 0) + 1;
    countByVerificationStatus[rec.verification_status] =
      (countByVerificationStatus[rec.verification_status] ?? 0) + 1;

    const addError = (msg: string): void => {
      errors.push({ row: i, message: msg });
      invalidRowIndices.add(i);
    };

    // First5 property name check
    if (!FIRST5_PROPERTIES.includes(rec.property_name as First5Property)) {
      addError(`unexpected property_name "${rec.property_name}"`);
    }

    // First5 source check
    if (!FIRST5_SOURCES.includes(rec.source as First5Source)) {
      addError(`unexpected source "${rec.source}" for first5 batch`);
    }

    // Duplicate property/source pair check
    const pairKey = `${rec.property_name}|${rec.source}`;
    if (seenPairs.has(pairKey)) {
      addError(
        `duplicate property/source pair: "${rec.property_name}" + "${rec.source}"`
      );
    } else {
      seenPairs.add(pairKey);
    }

    // Warn about unfilled TODO evidence notes
    if (rec.evidence_note.trimStart().startsWith("TODO:")) {
      warnings.push({ row: i, message: "evidence_note is still a TODO placeholder" });
    }

    // Source-specific URL pattern and status rules
    if (rec.source === "rakuten") {
      if (
        rec.candidate_property_url !== null &&
        !RAKUTEN_URL_RE.test(rec.candidate_property_url)
      ) {
        addError(
          `rakuten URL does not match expected pattern https://travel.rakuten.co.jp/HOTEL/[number]/`
        );
      }
      if (rec.verification_status === "confirmed") {
        if (rec.candidate_property_url === null) {
          addError("rakuten confirmed requires candidate_property_url");
        }
        if (!rec.candidate_source_property_id?.trim()) {
          addError("rakuten confirmed requires candidate_source_property_id");
        }
        if (!rec.reviewer_note?.trim()) {
          addError("rakuten confirmed requires reviewer_note");
        }
      }
    } else if (rec.source === "booking") {
      if (
        rec.candidate_property_url !== null &&
        !BOOKING_URL_RE.test(rec.candidate_property_url)
      ) {
        addError(
          `booking URL does not match expected pattern https://www.booking.com/hotel/jp/[slug].ja.html`
        );
      }
      if (rec.verification_status === "confirmed") {
        const note = rec.reviewer_note ?? "";
        if (!BOOKING_COLLECTABILITY_RE.test(note)) {
          addError(
            "booking confirmed requires reviewer_note with explicit safe collectability evidence " +
              "(mention content_visible, safe_price, collectab, stable_access, or price_extract)"
          );
        }
      }
    } else if (rec.source === "google_hotels") {
      if (
        rec.candidate_property_url !== null &&
        !GOOGLE_HOTELS_URL_RE.test(rec.candidate_property_url)
      ) {
        addError(
          `google_hotels URL does not match expected pattern https://www.google.com/travel/hotels/entity/[token]`
        );
      }
      if (rec.verification_status === "confirmed") {
        const note = rec.reviewer_note ?? "";
        if (!GOOGLE_FREE_DIRECT_RE.test(note)) {
          addError(
            "google_hotels confirmed requires reviewer_note with explicit free-direct collectability evidence " +
              "(mention free_direct, content_visible, safe_price, or collectab)"
          );
        }
      }
    }
  }

  const errorsCount = errors.length;
  const structurallyValid = errorsCount === 0;

  const hasActionableRow = parsedRows.some(
    (r) =>
      (r.verification_status === "confirmed" || r.verification_status === "needs_review") &&
      (r.candidate_property_url !== null ||
        (r.candidate_source_property_id !== null &&
          r.candidate_source_property_id.trim() !== ""))
  );

  const readyForImport = structurallyValid && hasActionableRow;
  const invalidRowsCount = invalidRowIndices.size;
  const validRowsCount = rows.length - invalidRowsCount;

  return {
    filePath,
    rowsCount: rows.length,
    validRowsCount,
    invalidRowsCount,
    structurallyValid,
    readyForImport,
    countBySource,
    countByVerificationStatus,
    warningsCount: warnings.length,
    errorsCount,
    errors,
    warnings
  };
}

export function formatFirst5ValidationResult(result: First5ValidationResult): string {
  const lines: string[] = [
    `file_path=${result.filePath}`,
    `rows_count=${result.rowsCount}`,
    `valid_rows_count=${result.validRowsCount}`,
    `invalid_rows_count=${result.invalidRowsCount}`,
    `structurally_valid=${result.structurallyValid}`,
    `ready_for_import=${result.readyForImport}`,
    `count_by_source=${JSON.stringify(result.countBySource)}`,
    `count_by_verification_status=${JSON.stringify(result.countByVerificationStatus)}`,
    `warnings_count=${result.warningsCount}`,
    `errors_count=${result.errorsCount}`
  ];
  for (const err of result.errors) {
    lines.push(`error[row=${err.row}]=${err.message}`);
  }
  for (const warn of result.warnings) {
    lines.push(`warning[row=${warn.row}]=${warn.message}`);
  }
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("validateFirst5VerifiedCandidates.ts")) {
  const filePath =
    process.env["FIRST5_VERIFIED_CANDIDATES_FILE"] ?? DEFAULT_FILE_PATH;
  const raw = JSON.parse(readFileSync(resolve(filePath), "utf-8")) as unknown[];
  console.log(formatFirst5ValidationResult(validateFirst5Candidates(raw, filePath)));
}

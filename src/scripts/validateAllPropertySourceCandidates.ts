import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sourceCoverageCandidateRecordSchema,
  type SourceCoverageCandidateRecord
} from "../seeds/sourceCoverageCandidateSchema";

/**
 * Phase 46.6X Deliverable 5 — validator for the rebuilt all-property AI-discovered
 * candidate file. Hardened over the Phase 46.5X version:
 *  - "jalan" is now an allowed source (4 sources total).
 *  - Mock/test names are a hard error (the 46.5X file leaked property_mock_zao_001).
 *  - Every canonical property must carry exactly the 4 sources, and the row count
 *    must equal canonical_property_count × 4.
 *  - The result reports `ready_for_human_review` and forces `ready_for_import=false`
 *    — promotion/import is a separate, explicitly-gated step. The old
 *    `ready_for_import=true` was operationally dangerous.
 */

export const ALL_PROPERTY_SOURCES = ["jalan", "rakuten", "booking", "google_hotels"] as const;

export const MOCK_PATTERN = /mock|test|fixture|dummy|sample/iu;

export const EXPECTED_ZAO_ANCHORS = [
  "蔵王国際ホテル",
  "蔵王四季のホテル",
  "深山荘 高見屋",
  "名湯リゾート ルーセント",
  "JURIN",
  "BED'n ONSEN HAMMOND",
  "名湯舎 創",
  "ホテル喜らく",
  "吉田屋",
  "たかみや瑠璃倶楽",
  "ONSEN & STAY OAKHILL",
  "三浦屋"
] as const;

const FORBIDDEN_ZENSHICHI_STANDALONE_NAMES = [
  "善七乃湯・oohira HOTEL",
  "最上高湯 善七乃湯（旧：蔵王温泉 大平ホテル）"
];

const EXPECTED_RETAINED_PROPERTIES = [
  "YuiLocalZao",
  "ZAO BASE",
  "ユニテ蔵王ジョーニダ・リゾート"
];

const FORBIDDEN_GEOGRAPHIC_BOUNDARY_PROPERTIES = [
  "蔵王エコー山荘",
  "蔵王ライザウッディロッジ"
];

// URL pattern regexes
const JALAN_URL_RE = /^https:\/\/www\.jalan\.net\/yad\d+\/$/u;
const RAKUTEN_URL_RE = /^https:\/\/travel\.rakuten\.co\.jp\/HOTEL\/\d+\/$/u;
const BOOKING_URL_RE = /^https:\/\/www\.booking\.com\/hotel\/jp\/[^/]+\.ja\.html$/u;
const GOOGLE_HOTELS_URL_RE = /^https:\/\/www\.google\.com\/travel\/hotels\/entity\/[A-Za-z0-9_=+/\-]+$/u;

const DEFAULT_FILE_PATH =
  "data/seeds/source_coverage_candidates.990-2301.ai-discovered.local.json";

export interface ValidationIssue {
  row: number | "file";
  message: string;
}

export interface AllPropertyValidationResult {
  filePath: string;
  rowsCount: number;
  validRowsCount: number;
  invalidRowsCount: number;
  distinctPropertyCount: number;
  expectedRows: number;
  structurallyValid: boolean;
  readyForHumanReview: boolean;
  readyForImport: false;
  countBySource: Record<string, number>;
  countByVerificationStatus: Record<string, number>;
  warningsCount: number;
  errorsCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function validateAllPropertyCandidates(
  rows: unknown[],
  filePath = "<unknown>"
): AllPropertyValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const countBySource: Record<string, number> = {};
  const countByVerificationStatus: Record<string, number> = {};
  const invalidRowIndices = new Set<number>();
  const parsedRows: SourceCoverageCandidateRecord[] = [];
  const seenPairs = new Set<string>();
  const sourcesByProperty = new Map<string, Set<string>>();

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

    // Source must be one of the four allowed
    if (!ALL_PROPERTY_SOURCES.includes(rec.source as (typeof ALL_PROPERTY_SOURCES)[number])) {
      addError(
        `source "${rec.source}" is not allowed in AI-discovered file (use jalan, rakuten, booking, or google_hotels)`
      );
    }

    // Mock/test contamination is a hard error (Phase 46.5X leaked a mock property)
    if (MOCK_PATTERN.test(rec.property_name)) {
      addError(`property_name "${rec.property_name}" matches mock/test pattern — not allowed`);
    }

    // Track per-property source coverage
    const propSources = sourcesByProperty.get(rec.property_name) ?? new Set<string>();
    propSources.add(rec.source);
    sourcesByProperty.set(rec.property_name, propSources);

    // Duplicate property/source pair check
    const pairKey = `${rec.property_name}|${rec.source}`;
    if (seenPairs.has(pairKey)) {
      addError(`duplicate property/source pair: "${rec.property_name}" + "${rec.source}"`);
    } else {
      seenPairs.add(pairKey);
    }

    // AI-discovered files must never have confirmed/rejected status
    if (rec.verification_status === "confirmed") {
      addError(
        `verification_status "confirmed" is not allowed in AI-discovered files — use "needs_review" for found candidates`
      );
    }

    const hasId =
      rec.candidate_source_property_id !== null && rec.candidate_source_property_id.trim() !== "";

    // Found rows (URL present) must be needs_review, not candidate
    if (rec.candidate_property_url !== null && rec.verification_status === "candidate") {
      addError(
        `row has a non-null candidate_property_url but verification_status is "candidate" — use "needs_review" for AI-found rows`
      );
    }

    // Not-found rows (no URL and no ID) must be candidate, not needs_review
    if (rec.candidate_property_url === null && !hasId && rec.verification_status === "needs_review") {
      addError(
        `row has no URL or source ID but verification_status is "needs_review" — use "candidate" when nothing was found`
      );
    }

    // URL pattern checks
    if (rec.candidate_property_url !== null) {
      if (rec.source === "jalan" && !JALAN_URL_RE.test(rec.candidate_property_url)) {
        addError(
          `jalan URL "${rec.candidate_property_url}" does not match expected pattern https://www.jalan.net/yad[number]/`
        );
      } else if (rec.source === "rakuten" && !RAKUTEN_URL_RE.test(rec.candidate_property_url)) {
        addError(
          `rakuten URL "${rec.candidate_property_url}" does not match expected pattern https://travel.rakuten.co.jp/HOTEL/[number]/`
        );
      } else if (rec.source === "booking" && !BOOKING_URL_RE.test(rec.candidate_property_url)) {
        addError(
          `booking URL "${rec.candidate_property_url}" does not match expected pattern https://www.booking.com/hotel/jp/[slug].ja.html`
        );
      } else if (
        rec.source === "google_hotels" &&
        !GOOGLE_HOTELS_URL_RE.test(rec.candidate_property_url)
      ) {
        addError(
          `google_hotels URL "${rec.candidate_property_url}" does not match expected pattern https://www.google.com/travel/hotels/entity/[token]`
        );
      }
    }
  }

  const distinctPropertyCount = sourcesByProperty.size;
  const expectedRows = distinctPropertyCount * ALL_PROPERTY_SOURCES.length;

  // Each property must carry exactly the four sources
  for (const [propertyName, sources] of sourcesByProperty) {
    const missing = ALL_PROPERTY_SOURCES.filter((s) => !sources.has(s));
    if (missing.length > 0) {
      errors.push({
        row: "file",
        message: `property "${propertyName}" is missing source rows: ${missing.join(", ")}`
      });
    }
  }

  // Row count must equal canonical_property_count × 4
  if (parsedRows.length !== expectedRows) {
    errors.push({
      row: "file",
      message: `row count ${parsedRows.length} != expected ${expectedRows} (distinct properties ${distinctPropertyCount} × ${ALL_PROPERTY_SOURCES.length} sources)`
    });
  }

  const propertyNames = [...sourcesByProperty.keys()];
  for (const anchor of EXPECTED_ZAO_ANCHORS) {
    if (!propertyNames.includes(anchor)) {
      errors.push({
        row: "file",
        message: `expected Zao market anchor missing from AI-discovered candidates: ${anchor}`
      });
    }
  }
  const leakedZenshichi = propertyNames.filter((name) =>
    FORBIDDEN_ZENSHICHI_STANDALONE_NAMES.includes(name)
  );
  if (leakedZenshichi.length > 0) {
    errors.push({
      row: "file",
      message: `善七乃湯 variants must be merged under "最上高湯 善七乃湯"; standalone variants found: ${leakedZenshichi.join(", ")}`
    });
  }
  for (const retained of EXPECTED_RETAINED_PROPERTIES) {
    if (!propertyNames.includes(retained)) {
      errors.push({
        row: "file",
        message: `expected approved Zao market property missing from AI-discovered candidates: ${retained}`
      });
    }
  }
  const leakedBoundaryProperties = propertyNames.filter((name) =>
    FORBIDDEN_GEOGRAPHIC_BOUNDARY_PROPERTIES.includes(name)
  );
  if (leakedBoundaryProperties.length > 0) {
    errors.push({
      row: "file",
      message: `properties outside Yamagata City Zao Onsen village market must be excluded: ${leakedBoundaryProperties.join(", ")}`
    });
  }

  const errorsCount = errors.length;
  const structurallyValid = errorsCount === 0;

  const hasActionableRow = parsedRows.some(
    (r) =>
      r.verification_status === "needs_review" &&
      (r.candidate_property_url !== null ||
        (r.candidate_source_property_id !== null && r.candidate_source_property_id.trim() !== ""))
  );

  const readyForHumanReview = structurallyValid && hasActionableRow;
  const invalidRowsCount = invalidRowIndices.size;
  const validRowsCount = rows.length - invalidRowsCount;

  return {
    filePath,
    rowsCount: rows.length,
    validRowsCount,
    invalidRowsCount,
    distinctPropertyCount,
    expectedRows,
    structurallyValid,
    readyForHumanReview,
    readyForImport: false,
    countBySource,
    countByVerificationStatus,
    warningsCount: warnings.length,
    errorsCount,
    errors,
    warnings
  };
}

export function formatAllPropertyValidationResult(result: AllPropertyValidationResult): string {
  const lines: string[] = [
    `file_path=${result.filePath}`,
    `rows_count=${result.rowsCount}`,
    `valid_rows_count=${result.validRowsCount}`,
    `invalid_rows_count=${result.invalidRowsCount}`,
    `distinct_property_count=${result.distinctPropertyCount}`,
    `expected_rows=${result.expectedRows}`,
    `structurally_valid=${result.structurallyValid}`,
    `ready_for_human_review=${result.readyForHumanReview}`,
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

if (process.argv[1]?.endsWith("validateAllPropertySourceCandidates.ts")) {
  const filePath = process.env["ALL_SOURCE_CANDIDATES_FILE"] ?? DEFAULT_FILE_PATH;
  const raw = JSON.parse(readFileSync(resolve(filePath), "utf-8")) as unknown[];
  console.log(
    formatAllPropertyValidationResult(validateAllPropertyCandidates(raw, filePath))
  );
}

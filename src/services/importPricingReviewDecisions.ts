import { readFileSync } from "node:fs";
import { runInTransaction, type LocalDatabase } from "../db/client";
import {
  pricingReviewDecisionId,
  upsertPricingReviewDecision,
  type PricingReviewDecisionStoredRecord
} from "../db/repositories/pricingReviewDecisionsRepository";
import { buildPricingReviewDecisionRow } from "./pricingReviewDecision";

// Must match the manual-review CSV produced by exportPricingReviewPacket (Phase 36), exactly and in order.
export const EXPECTED_REVIEW_CSV_HEADERS = [
  "target_id",
  "stay_date",
  "priority",
  "approval_status",
  "recommended_price_jpy",
  "confidence",
  "raw_market_median_jpy",
  "quality_adjusted_market_median_jpy",
  "baseline_adr_jpy",
  "audit_flags",
  "approval_reasons",
  "recommendation_reason",
  "review_decision",
  "reviewer_note"
] as const;

const COL = {
  targetId: 0,
  stayDate: 1,
  approvalStatus: 3,
  recommendedPrice: 4,
  reviewDecision: 12,
  reviewerNote: 13
} as const;

export interface ImportPricingReviewDecisionsResult {
  sourcePath: string;
  importedRows: number;
  skippedRows: number;
  validationErrorCount: number;
  validationErrors: string[];
  countByReviewDecision: Record<string, number>;
}

/**
 * Imports a human-edited manual-review CSV into pricing_review_decisions.
 * Read-only with respect to pricing_recommendations and pricing_recommendation_approvals.
 * Applies no prices. A mismatched header aborts the whole import; per-row problems are
 * collected and reported (not silently dropped).
 */
export function importPricingReviewDecisions(
  db: LocalDatabase,
  input: { csvPath: string; sourceMarket?: string; importedAt?: string }
): ImportPricingReviewDecisionsResult {
  const sourceMarket = input.sourceMarket ?? "jalan";
  const now = input.importedAt ?? new Date().toISOString();

  const text = readFileSync(input.csvPath, "utf8");
  const records = parseCsv(text);

  if (records.length === 0) {
    throw new Error(`pricing review CSV is empty: ${input.csvPath}`);
  }

  const header = records[0] ?? [];
  assertHeaderMatches(header, input.csvPath);

  const dataRows = records.slice(1).filter((row) => !isBlankRow(row));

  const validRows: PricingReviewDecisionStoredRecord[] = [];
  const validationErrors: string[] = [];
  let skippedRows = 0;

  dataRows.forEach((cells, index) => {
    const lineNumber = index + 2; // +1 for header, +1 for 1-based line numbering
    if (cells.length !== EXPECTED_REVIEW_CSV_HEADERS.length) {
      skippedRows += 1;
      validationErrors.push(
        `line ${lineNumber}: expected ${EXPECTED_REVIEW_CSV_HEADERS.length} columns, got ${cells.length}`
      );
      return;
    }

    const result = buildPricingReviewDecisionRow({
      targetId: cells[COL.targetId] ?? "",
      stayDate: cells[COL.stayDate] ?? "",
      recommendedPriceRaw: cells[COL.recommendedPrice] ?? "",
      approvalStatus: cells[COL.approvalStatus] ?? "",
      reviewDecisionRaw: cells[COL.reviewDecision] ?? "",
      reviewerNote: cells[COL.reviewerNote] ?? ""
    });

    if (result.row === undefined) {
      skippedRows += 1;
      for (const error of result.errors) {
        validationErrors.push(`line ${lineNumber}: ${error}`);
      }
      return;
    }

    validRows.push({
      id: pricingReviewDecisionId(result.row.targetId, result.row.stayDate, sourceMarket),
      targetId: result.row.targetId,
      stayDate: result.row.stayDate,
      sourceMarket,
      recommendedPriceJpy: result.row.recommendedPriceJpy,
      approvalStatus: result.row.approvalStatus,
      reviewDecision: result.row.reviewDecision,
      reviewerNote: result.row.reviewerNote,
      importedFromPath: input.csvPath,
      createdAt: now,
      updatedAt: now
    });
  });

  runInTransaction(db, () => {
    for (const row of validRows) {
      upsertPricingReviewDecision(db, row);
    }
  });

  return {
    sourcePath: input.csvPath,
    importedRows: validRows.length,
    skippedRows,
    validationErrorCount: validationErrors.length,
    validationErrors,
    countByReviewDecision: countBy(validRows, (row) => row.reviewDecision)
  };
}

function assertHeaderMatches(header: string[], csvPath: string): void {
  const normalized = header.map((cell) => cell.trim());
  const matches =
    normalized.length === EXPECTED_REVIEW_CSV_HEADERS.length &&
    EXPECTED_REVIEW_CSV_HEADERS.every((expected, index) => normalized[index] === expected);
  if (!matches) {
    throw new Error(
      `unexpected CSV header in ${csvPath}\n  expected: ${EXPECTED_REVIEW_CSV_HEADERS.join(",")}\n  got:      ${normalized.join(",")}`
    );
  }
}

/** RFC-4180-ish CSV parser: handles quoted fields, embedded commas/newlines, and "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushField();
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field !== "" || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows;
}

function isBlankRow(cells: string[]): boolean {
  return cells.every((cell) => cell.trim() === "");
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

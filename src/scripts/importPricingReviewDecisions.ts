import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import {
  importPricingReviewDecisions,
  type ImportPricingReviewDecisionsResult
} from "../services/importPricingReviewDecisions";

export function formatImportResult(result: ImportPricingReviewDecisionsResult): string {
  const lines = [
    `source_path=${result.sourcePath}`,
    `imported_rows=${result.importedRows}`,
    `skipped_rows=${result.skippedRows}`,
    `validation_error_count=${result.validationErrorCount}`,
    `count_by_review_decision=${JSON.stringify(result.countByReviewDecision)}`
  ];
  if (result.validationErrors.length > 0) {
    lines.push("validation_errors:");
    for (const error of result.validationErrors) {
      lines.push(`  ${error}`);
    }
  }
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("importPricingReviewDecisions.ts")) {
  const csvPath = process.env.PRICING_REVIEW_CSV;
  if (csvPath === undefined || csvPath.trim() === "") {
    console.error("PRICING_REVIEW_CSV is required (path to the human-edited manual review CSV)");
    process.exit(1);
  }

  const db = openLocalDatabase();
  try {
    executeMigration(db);
    const result = importPricingReviewDecisions(db, {
      csvPath,
      ...(process.env.PRICING_SOURCE_MARKET === undefined ? {} : { sourceMarket: process.env.PRICING_SOURCE_MARKET })
    });
    console.log(formatImportResult(result));
  } finally {
    closeDatabase(db);
  }
}

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  EXPECTED_REVIEW_CSV_HEADERS,
  importPricingReviewDecisions,
  parseCsv
} from "../src/services/importPricingReviewDecisions";
import { listPricingReviewDecisions } from "../src/db/repositories/pricingReviewDecisionsRepository";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pricing-review-import-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const HEADER = EXPECTED_REVIEW_CSV_HEADERS.join(",");

/** Builds one CSV data row with all 14 columns; overrides keyed by header name. */
function dataRow(overrides: Partial<Record<(typeof EXPECTED_REVIEW_CSV_HEADERS)[number], string>> = {}): string {
  const base: Record<(typeof EXPECTED_REVIEW_CSV_HEADERS)[number], string> = {
    target_id: "sample_target",
    stay_date: "2026-08-08",
    priority: "S",
    approval_status: "auto_approved",
    recommended_price_jpy: "18000",
    confidence: "high",
    raw_market_median_jpy: "17000",
    quality_adjusted_market_median_jpy: "17500",
    baseline_adr_jpy: "16000",
    audit_flags: "",
    approval_reasons: "high_confidence_clean_recommendation",
    recommendation_reason: "market median anchored",
    review_decision: "approved",
    reviewer_note: ""
  };
  const merged = { ...base, ...overrides };
  return EXPECTED_REVIEW_CSV_HEADERS.map((h) => merged[h]).join(",");
}

function writeCsv(lines: string[]): string {
  const path = join(workDir, "review.csv");
  writeFileSync(path, [HEADER, ...lines].join("\n"), "utf8");
  return path;
}

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

describe("parseCsv", () => {
  it("handles quoted fields with embedded commas, quotes, and newlines", () => {
    const rows = parseCsv('a,"b,c","d""e","f\ng"\n');
    expect(rows).toEqual([["a", "b,c", 'd"e', "f\ng"]]);
  });
});

describe("importPricingReviewDecisions", () => {
  it("imports a valid CSV", () => {
    const db = openDb();
    const path = writeCsv([dataRow()]);
    const result = importPricingReviewDecisions(db, { csvPath: path, importedAt: "2026-05-29T00:00:00.000Z" });

    expect(result.importedRows).toBe(1);
    expect(result.skippedRows).toBe(0);
    expect(result.validationErrorCount).toBe(0);
    expect(result.countByReviewDecision).toEqual({ approved: 1 });

    const stored = listPricingReviewDecisions(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.reviewDecision).toBe("approved");
    expect(stored[0]?.recommendedPriceJpy).toBe(18000);
    expect(stored[0]?.sourceMarket).toBe("jalan");
    expect(stored[0]?.importedFromPath).toBe(path);
    db.close();
  });

  it("defaults a blank review_decision to pending", () => {
    const db = openDb();
    const path = writeCsv([dataRow({ review_decision: "", recommended_price_jpy: "" })]);
    const result = importPricingReviewDecisions(db, { csvPath: path });

    expect(result.importedRows).toBe(1);
    expect(result.countByReviewDecision).toEqual({ pending: 1 });
    expect(listPricingReviewDecisions(db)[0]?.reviewDecision).toBe("pending");
    db.close();
  });

  it("skips an invalid review_decision and reports the line", () => {
    const db = openDb();
    const path = writeCsv([dataRow({ review_decision: "maybe" })]);
    const result = importPricingReviewDecisions(db, { csvPath: path });

    expect(result.importedRows).toBe(0);
    expect(result.skippedRows).toBe(1);
    expect(result.validationErrorCount).toBeGreaterThan(0);
    expect(result.validationErrors.join(" ")).toContain("line 2");
    expect(result.validationErrors.join(" ")).toContain("review_decision");
    db.close();
  });

  it("skips approved rows with a blank price", () => {
    const db = openDb();
    const path = writeCsv([dataRow({ review_decision: "approved", recommended_price_jpy: "" })]);
    const result = importPricingReviewDecisions(db, { csvPath: path });

    expect(result.importedRows).toBe(0);
    expect(result.skippedRows).toBe(1);
    expect(result.validationErrors.join(" ")).toContain("approved decision requires");
    db.close();
  });

  it("skips needs_change rows with a blank reviewer_note", () => {
    const db = openDb();
    const path = writeCsv([dataRow({ review_decision: "needs_change", reviewer_note: "" })]);
    const result = importPricingReviewDecisions(db, { csvPath: path });

    expect(result.importedRows).toBe(0);
    expect(result.skippedRows).toBe(1);
    expect(result.validationErrors.join(" ")).toContain("needs_change decision requires");
    db.close();
  });

  it("imports valid rows and reports invalid ones in the same file (no silent partial failure)", () => {
    const db = openDb();
    const path = writeCsv([
      dataRow({ target_id: "good", review_decision: "approved" }),
      dataRow({ target_id: "bad", review_decision: "maybe" }),
      dataRow({ target_id: "good2", stay_date: "2026-08-09", review_decision: "rejected", recommended_price_jpy: "" })
    ]);
    const result = importPricingReviewDecisions(db, { csvPath: path });

    expect(result.importedRows).toBe(2);
    expect(result.skippedRows).toBe(1);
    expect(result.validationErrorCount).toBeGreaterThan(0);
    expect(listPricingReviewDecisions(db)).toHaveLength(2);
    db.close();
  });

  it("aborts the whole import on a mismatched header", () => {
    const db = openDb();
    const path = join(workDir, "bad-header.csv");
    writeFileSync(path, ["target_id,stay_date,wrong", dataRow()].join("\n"), "utf8");
    expect(() => importPricingReviewDecisions(db, { csvPath: path })).toThrow(/unexpected CSV header/);
    expect(listPricingReviewDecisions(db)).toHaveLength(0);
    db.close();
  });

  it("respects an explicit sourceMarket", () => {
    const db = openDb();
    const path = writeCsv([dataRow()]);
    const result = importPricingReviewDecisions(db, { csvPath: path, sourceMarket: "rakuten" });
    expect(result.importedRows).toBe(1);
    expect(listPricingReviewDecisions(db)[0]?.sourceMarket).toBe("rakuten");
    db.close();
  });

  it("does not mutate pricing_recommendations", () => {
    const db = openDb();
    seedRecommendation(db);
    const before = snapshot(db, "pricing_recommendations");

    const path = writeCsv([dataRow()]);
    importPricingReviewDecisions(db, { csvPath: path });

    expect(snapshot(db, "pricing_recommendations")).toEqual(before);
    db.close();
  });

  it("does not mutate pricing_recommendation_approvals", () => {
    const db = openDb();
    seedRecommendation(db);
    seedApproval(db);
    const before = snapshot(db, "pricing_recommendation_approvals");

    const path = writeCsv([dataRow()]);
    importPricingReviewDecisions(db, { csvPath: path });

    expect(snapshot(db, "pricing_recommendation_approvals")).toEqual(before);
    db.close();
  });
});

function seedRecommendation(db: LocalDatabase): void {
  db.prepare(
    `INSERT INTO pricing_recommendations (
       id, target_id, stay_date, source_market, baseline_adr_jpy, recommended_price_jpy,
       min_price_jpy, max_price_jpy, confidence, recommendation_reason, created_at, updated_at
     )
     VALUES ('rec', 'sample_target', '2026-08-08', 'jalan', 16000, 18000, 8000, 35000, 'A', 'seed', '2026-05-29', '2026-05-29')`
  ).run();
}

function seedApproval(db: LocalDatabase): void {
  db.prepare(
    `INSERT INTO pricing_recommendation_approvals (
       id, recommendation_id, target_id, stay_date, source_market, approval_status,
       reasons_json, audit_flags_json, created_at, updated_at
     )
     VALUES ('approval', 'rec', 'sample_target', '2026-08-08', 'jalan', 'auto_approved', '[]', '[]', '2026-05-29', '2026-05-29')`
  ).run();
}

function snapshot(db: LocalDatabase, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

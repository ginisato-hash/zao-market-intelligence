import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  pricingReviewDecisionId,
  upsertPricingReviewDecision,
  type PricingReviewDecisionStoredRecord
} from "../src/db/repositories/pricingReviewDecisionsRepository";
import {
  exportApprovedRecommendationPreview,
  PREVIEW_CSV_HEADERS,
  renderApprovedPreviewCsv,
  renderApprovedPreviewMarkdown
} from "../src/scripts/exportApprovedRecommendationPreview";
import { buildApprovedRecommendationPreview } from "../src/services/buildApprovedRecommendationPreview";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "approved-preview-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedApproved(db: LocalDatabase): void {
  db.prepare(
    `INSERT INTO pricing_recommendations (
       id, target_id, stay_date, source_market, baseline_adr_jpy, recommended_price_jpy,
       min_price_jpy, max_price_jpy, confidence, recommendation_reason, created_at, updated_at
     )
     VALUES ('rec', 'sample_target', '2026-08-08', 'jalan', 16000, 18000, 8000, 35000, 'A', 'market median anchored', '2026-05-29', '2026-05-29')`
  ).run();
  const row: PricingReviewDecisionStoredRecord = {
    id: pricingReviewDecisionId("sample_target", "2026-08-08", "jalan"),
    targetId: "sample_target",
    stayDate: "2026-08-08",
    sourceMarket: "jalan",
    recommendedPriceJpy: 18000,
    approvalStatus: "auto_approved",
    reviewDecision: "approved",
    reviewerNote: "confirmed",
    importedFromPath: "/tmp/review.csv",
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29"
  };
  upsertPricingReviewDecision(db, row);
}

const UPLOAD_ONLY_COLUMNS = [
  "roomid",
  "inventory",
  "multiplier",
  "price1",
  "price2",
  "price3",
  "price4",
  "beds24",
  "airhost"
];

describe("approved preview CSV", () => {
  it("has preview-only headers and no upload/Beds24/AirHost columns", () => {
    expect([...PREVIEW_CSV_HEADERS]).toEqual([
      "target_id",
      "stay_date",
      "priority",
      "recommended_price_jpy",
      "approval_status",
      "review_decision",
      "confidence",
      "recommendation_reason",
      "reviewer_note",
      "source_market"
    ]);
    for (const forbidden of UPLOAD_ONLY_COLUMNS) {
      expect(PREVIEW_CSV_HEADERS).not.toContain(forbidden);
    }
  });

  it("renders rows with the reviewer-approved price", () => {
    const db = openDb();
    seedApproved(db);
    const preview = buildApprovedRecommendationPreview(db);
    const csv = renderApprovedPreviewCsv(preview.rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(PREVIEW_CSV_HEADERS.join(","));
    expect(lines[1]).toContain("sample_target,2026-08-08");
    expect(lines[1]).toContain("18000");
    expect(lines[1]).toContain("approved");
    db.close();
  });
});

describe("approved preview Markdown", () => {
  it("includes the preview-only warning and the confirmation checklist", () => {
    const db = openDb();
    seedApproved(db);
    const md = renderApprovedPreviewMarkdown(buildApprovedRecommendationPreview(db));
    expect(md).toContain("# Approved Recommendation Export Preview");
    expect(md).toContain("preview only");
    expect(md.toLowerCase()).toContain("not an upload format");
    expect(md).toContain("Confirm no pending / needs_change rows are included.");
    expect(md).toContain("NOT a Beds24 / AirHost upload file.");
    db.close();
  });
});

describe("exportApprovedRecommendationPreview", () => {
  it("writes both files and reports counts without mutating the DB", () => {
    const db = openDb();
    seedApproved(db);
    const before = {
      recommendations: db.prepare("SELECT * FROM pricing_recommendations ORDER BY id").all(),
      decisions: db.prepare("SELECT * FROM pricing_review_decisions ORDER BY id").all()
    };

    const result = exportApprovedRecommendationPreview(db, {
      exportDir: workDir,
      timestamp: new Date("2026-05-29T12:34:56Z")
    });

    expect(existsSync(result.markdownPath)).toBe(true);
    expect(existsSync(result.csvPath)).toBe(true);
    expect(result.markdownPath).toContain("approved_recommendation_preview_");
    expect(result.csvPath.endsWith(".csv")).toBe(true);
    expect(result.approvedRowsCount).toBe(1);

    const csv = readFileSync(result.csvPath, "utf8");
    expect(csv.split("\n")[0]).toBe(PREVIEW_CSV_HEADERS.join(","));

    expect(db.prepare("SELECT * FROM pricing_recommendations ORDER BY id").all()).toEqual(before.recommendations);
    expect(db.prepare("SELECT * FROM pricing_review_decisions ORDER BY id").all()).toEqual(before.decisions);
    db.close();
  });

  it("writes an empty preview (header only) when there are no approved rows", () => {
    const db = openDb();
    const result = exportApprovedRecommendationPreview(db, { exportDir: workDir });
    expect(result.approvedRowsCount).toBe(0);
    const csv = readFileSync(result.csvPath, "utf8");
    expect(csv.trim()).toBe(PREVIEW_CSV_HEADERS.join(","));
    db.close();
  });
});

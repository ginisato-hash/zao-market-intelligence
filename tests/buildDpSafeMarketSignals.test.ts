import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  buildDpSafeMarketSignals,
  detectCouponContamination,
  DP_SAFE_WARNING_FLAGS
} from "../src/services/buildDpSafeMarketSignals";
import {
  DP_SAFE_CSV_HEADERS,
  renderDpSafeCsv
} from "../src/scripts/buildDpSafeMarketSignalReport";

describe("buildDpSafeMarketSignals", () => {
  it("classifies a clean confidence-A date as use_directly", () => {
    const db = openDb();
    seedProps(db, 8);
    for (let index = 1; index <= 6; index += 1) {
      insertSnapshot(db, { id: `r${index}`, propertyId: `p${index}`, stayDate: "2026-08-09", price: 40000 + index * 1000 });
    }

    const [row] = buildDpSafeMarketSignals(db);

    expect(row?.confidence).toBe("A");
    expect(row?.useClass).toBe("use_directly");
    expect(row?.dpSafeMedianJpy).not.toBeNull();
    expect(row?.excludedQualityRowsCount).toBe(0);
    db.close();
  });

  it("classifies a confidence-B date as use_directionally", () => {
    const db = openDb();
    seedProps(db, 8);
    for (let index = 1; index <= 3; index += 1) {
      insertSnapshot(db, { id: `r${index}`, propertyId: `p${index}`, stayDate: "2026-08-08", price: 25000 });
    }

    const [row] = buildDpSafeMarketSignals(db);

    expect(row?.confidence).toBe("B");
    expect(row?.useClass).toBe("use_directionally");
    db.close();
  });

  it("excludes confidence-C and insufficient dates", () => {
    const db = openDb();
    seedProps(db, 8);
    insertSnapshot(db, { id: "single", propertyId: "p1", stayDate: "2026-08-15", price: 27000 });
    insertSnapshot(db, { id: "fail", propertyId: "p2", stayDate: "2026-12-12", status: "failed", price: null });

    const rows = buildDpSafeMarketSignals(db);
    const cRow = rows.find((row) => row.stayDate === "2026-08-15");
    const insufficientRow = rows.find((row) => row.stayDate === "2026-12-12");

    expect(cRow?.confidence).toBe("C");
    expect(cRow?.useClass).toBe("exclude");
    expect(cRow?.warningFlags).toContain(DP_SAFE_WARNING_FLAGS.lowConfidence);
    expect(insufficientRow?.confidence).toBe("insufficient");
    expect(insufficientRow?.useClass).toBe("exclude");
    db.close();
  });

  it("labels a flagged coupon-as-price row with the coupon warning and excludes it", () => {
    const db = openDb();
    seedProps(db, 8);
    for (let index = 1; index <= 5; index += 1) {
      insertSnapshot(db, { id: `clean${index}`, propertyId: `p${index}`, stayDate: "2026-08-10", price: 40000 });
    }
    // Coupon-as-price rows are captured upstream as price_basis_suspicious; the
    // raw text confirms the coupon so the precise coupon label is applied.
    insertSnapshot(db, {
      id: "coupon",
      propertyId: "p6",
      stayDate: "2026-08-10",
      price: 3000,
      rawText: "合計 税込3,000円分クーポンを獲得"
    });
    insertQuality(db, "coupon", "high", ["too_low_absolute", "price_basis_suspicious"]);

    const [row] = buildDpSafeMarketSignals(db);

    expect(row?.rawMedianJpy).toBe(40000); // coupon row still in raw sample
    expect(row?.dpSafeMedianJpy).toBe(40000);
    expect(row?.excludedQualityRowsCount).toBe(1);
    expect(row?.warningFlags).toContain(DP_SAFE_WARNING_FLAGS.couponExcluded);
    db.close();
  });

  it("does not exclude clean rows just because the page text mentions coupons", () => {
    const db = openDb();
    seedProps(db, 8);
    for (let index = 1; index <= 6; index += 1) {
      insertSnapshot(db, {
        id: `r${index}`,
        propertyId: `p${index}`,
        stayDate: "2026-08-09",
        price: 40000,
        rawText: "お得なクーポン配布中 ポイント3倍 合計 税込40,000円"
      });
    }

    const [row] = buildDpSafeMarketSignals(db);

    expect(row?.confidence).toBe("A");
    expect(row?.useClass).toBe("use_directly");
    expect(row?.excludedQualityRowsCount).toBe(0);
    expect(row?.dpSafeMedianJpy).toBe(40000);
    db.close();
  });

  it("excludes price_basis_suspicious rows from the dp_safe median", () => {
    const db = openDb();
    seedProps(db, 8);
    for (let index = 1; index <= 5; index += 1) {
      insertSnapshot(db, { id: `clean${index}`, propertyId: `p${index}`, stayDate: "2026-07-18", price: 12000 });
    }
    insertSnapshot(db, { id: "suspicious", propertyId: "p6", stayDate: "2026-07-18", price: 3000 });
    insertQuality(db, "suspicious", "high", ["too_low_absolute", "price_basis_suspicious"]);

    const [row] = buildDpSafeMarketSignals(db);

    expect(row?.dpSafeMedianJpy).toBe(12000);
    expect(row?.excludedQualityRowsCount).toBe(1);
    expect(row?.warningFlags).toContain(DP_SAFE_WARNING_FLAGS.priceBasisSuspiciousExcluded);
    db.close();
  });

  it("retains premium high-market outliers as a warning, not a parser error", () => {
    const db = openDb();
    seedProps(db, 8);
    for (let index = 1; index <= 5; index += 1) {
      insertSnapshot(db, { id: `mid${index}`, propertyId: `p${index}`, stayDate: "2026-08-14", price: 36000 });
    }
    insertSnapshot(db, { id: "premium", propertyId: "p6", stayDate: "2026-08-14", price: 101200 });
    insertQuality(db, "premium", "medium", ["too_high_vs_market"]);

    const [row] = buildDpSafeMarketSignals(db);

    // Premium row stays in both raw and dp_safe samples (median robust); no exclusion.
    expect(row?.excludedQualityRowsCount).toBe(0);
    expect(row?.warningFlags).toContain(DP_SAFE_WARNING_FLAGS.premiumOutlierPresent);
    expect(row?.useClass).toBe("use_directly");
    db.close();
  });

  it("does not delete or mutate raw snapshots", () => {
    const db = openDb();
    seedProps(db, 8);
    for (let index = 1; index <= 5; index += 1) {
      insertSnapshot(db, { id: `r${index}`, propertyId: `p${index}`, stayDate: "2026-08-09", price: 40000 });
    }
    const before = (db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots").get() as { count: number }).count;

    buildDpSafeMarketSignals(db);

    const after = (db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots").get() as { count: number }).count;
    expect(after).toBe(before);
    db.close();
  });

  it("emits a CSV with no Beds24 / AirHost / upload / inventory columns", () => {
    const csv = renderDpSafeCsv([
      {
        stayDate: "2026-08-09",
        rawMedianJpy: 44150,
        adjustedMedianJpy: 44150,
        dpSafeMedianJpy: 44150,
        confidence: "A",
        useClass: "use_directly",
        reason: "confidence_a_clean_dp_safe_median",
        availableCount: 8,
        failedCount: 0,
        excludedQualityRowsCount: 0,
        warningFlags: []
      }
    ]);
    const header = csv.split("\n")[0] ?? "";
    const forbidden = ["roomid", "inventory", "multiplier", "price1", "price2", "price3", "price4", "beds24", "airhost", "upload"];
    for (const token of forbidden) {
      expect(header.toLowerCase()).not.toContain(token);
    }
    expect(header).toBe(DP_SAFE_CSV_HEADERS.join(","));
  });
});

describe("detectCouponContamination", () => {
  it("flags a price next to a coupon token", () => {
    expect(detectCouponContamination("合計 税込3,000円分クーポン", 3000)).toBe(true);
    expect(detectCouponContamination("2,000円割引キャンペーン", 2000)).toBe(true);
  });

  it("does not flag a clean total", () => {
    expect(detectCouponContamination("合計 税込40,000円", 40000)).toBe(false);
    expect(detectCouponContamination(null, 40000)).toBe(false);
    expect(detectCouponContamination("合計 税込40,000円", null)).toBe(false);
  });
});

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedProps(db: LocalDatabase, count: number): void {
  db.prepare(
    "INSERT INTO collector_runs (id, ota, started_at_jst, status) VALUES ('run_market', 'jalan', '2026-05-29T00:00:00+09:00', 'completed')"
  ).run();
  for (let index = 1; index <= count; index += 1) {
    db.prepare(
      `INSERT INTO properties (
         id, name, postal_code, area_name, property_type, price_segment, meal_style, ski_access, active, created_at, updated_at
       )
       VALUES (?, ?, '990-2301', 'Zao Onsen', 'hotel', 'unknown', 'unknown', 'unknown', 1, '2026-05-29', '2026-05-29')`
    ).run(`p${index}`, `Property ${index}`);
  }
}

function insertSnapshot(
  db: LocalDatabase,
  input: {
    id: string;
    propertyId: string;
    stayDate: string;
    price: number | null;
    status?: "available" | "failed" | "sold_out" | "not_listed";
    rawText?: string;
  }
): void {
  const status = input.status ?? "available";
  db.prepare(
    `INSERT INTO rate_snapshots (
       id, run_id, property_id, ota, stay_date, guests, nights, price_jpy,
       price_total_tax_included, availability_status, confidence, checked_at_jst,
       raw_text_excerpt, error_reason, created_at
     )
     VALUES (?, 'run_market', ?, 'jalan', ?, 2, 1, ?, ?, ?, 'A', '2026-05-29T01:00:00+09:00', ?, ?, '2026-05-29T01:00:00+09:00')`
  ).run(
    input.id,
    input.propertyId,
    input.stayDate,
    input.price,
    input.price,
    status,
    input.rawText ?? null,
    status === "failed" ? "test_failure" : null
  );
}

function insertQuality(
  db: LocalDatabase,
  rateSnapshotId: string,
  severity: "none" | "low" | "medium" | "high",
  flags: string[]
): void {
  db.prepare(
    `INSERT INTO price_quality_flags (
       id, rate_snapshot_id, source, property_id, stay_date, price_jpy,
       flags_json, severity, reason, created_at
     )
     SELECT 'pq_' || id, id, ota, property_id, stay_date, price_total_tax_included, ?, ?, ?, '2026-05-29'
     FROM rate_snapshots WHERE id = ?`
  ).run(JSON.stringify(flags), severity, flags.join(","), rateSnapshotId);
}

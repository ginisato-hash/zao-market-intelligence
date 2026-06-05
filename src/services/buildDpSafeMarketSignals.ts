import type { LocalDatabase } from "../db/client";
import {
  computeMarketSignalsFromSnapshots,
  median,
  type ComputeMarketSignalsInput,
  type MarketDailySignalRecord,
  type MarketSignalConfidence
} from "./computeMarketSignals";

/**
 * DP-safe market signals.
 *
 * Non-destructive read-only derivation that sits on top of the existing market
 * signals + price quality flags. It never mutates or deletes snapshots. It
 * decides, per stay date, whether the signal is safe to drive dynamic pricing
 * (DP) directly, only directionally, or not at all, and computes a `dp_safe`
 * median that drops contaminated rows (coupon-as-price, suspicious price basis,
 * per-person/basis mismatch) while keeping legitimate premium outliers in the
 * raw sample.
 */
export type DpSignalUseClass = "use_directly" | "use_directionally" | "exclude";

export interface DpSafeSignalRow {
  stayDate: string;
  rawMedianJpy: number | null;
  adjustedMedianJpy: number | null;
  dpSafeMedianJpy: number | null;
  confidence: MarketSignalConfidence;
  useClass: DpSignalUseClass;
  reason: string;
  availableCount: number;
  failedCount: number;
  excludedQualityRowsCount: number;
  warningFlags: string[];
}

export const DP_SAFE_WARNING_FLAGS = {
  couponExcluded: "coupon_suspected_rows_excluded_from_dp_safe",
  priceBasisSuspiciousExcluded: "price_basis_suspicious_rows_excluded_from_dp_safe",
  perPersonMismatchExcluded: "per_person_or_basis_mismatch_rows_excluded_from_dp_safe",
  premiumOutlierPresent: "premium_high_market_outlier_present_review_before_mid_tier_dp",
  lowConfidence: "low_confidence_not_dp_usable",
  allRowsExcluded: "all_available_rows_excluded_by_quality"
} as const;

const COUPON_CONTEXT_TOKENS = ["クーポン", "円分", "円引", "円OFF", "円off", "割引", "ポイント", "獲得"];

/**
 * Detect whether a captured price looks like a coupon / discount / points
 * amount rather than a real total. Pure helper so it can be unit tested without
 * a database. Looks for coupon context tokens within a small window of the price
 * digits inside the raw text excerpt.
 */
export function detectCouponContamination(rawTextExcerpt: string | null, priceJpy: number | null): boolean {
  if (rawTextExcerpt === null || rawTextExcerpt.length === 0 || priceJpy === null) {
    return false;
  }
  const needles = [priceJpy.toLocaleString("en-US"), String(priceJpy)];
  for (const needle of needles) {
    let index = rawTextExcerpt.indexOf(needle);
    while (index >= 0) {
      const window = rawTextExcerpt.slice(Math.max(0, index - 24), index + needle.length + 24);
      if (COUPON_CONTEXT_TOKENS.some((token) => window.includes(token))) {
        return true;
      }
      index = rawTextExcerpt.indexOf(needle, index + 1);
    }
  }
  return false;
}

interface DpSafeSnapshotRow {
  property_id: string;
  stay_date: string;
  availability_status: string;
  price_total_tax_included: number | null;
  quality_severity: "none" | "low" | "medium" | "high" | null;
  flags_json: string | null;
  raw_text_excerpt: string | null;
}

export function buildDpSafeMarketSignals(
  db: LocalDatabase,
  input: ComputeMarketSignalsInput = {}
): DpSafeSignalRow[] {
  const source = input.source ?? "jalan";
  const postalCode = input.postalCode ?? "990-2301";
  const signals = computeMarketSignalsFromSnapshots(db, input);
  const rowsByDate = groupBy(
    loadDpSafeSnapshotRows(db, {
      source,
      postalCode,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to })
    }),
    (row) => row.stay_date
  );

  return signals.map((signal) => buildRow(signal, rowsByDate.get(signal.stayDate) ?? []));
}

function buildRow(signal: MarketDailySignalRecord, rows: DpSafeSnapshotRow[]): DpSafeSignalRow {
  const availableRows = rows.filter(
    (row) => row.availability_status === "available" && row.price_total_tax_included !== null
  );

  const warningFlags = new Set<string>();
  const dpSafePrices: number[] = [];
  let excludedQualityRowsCount = 0;

  for (const row of availableRows) {
    const price = row.price_total_tax_included as number;
    const flags = parseFlags(row.flags_json);
    const priceBasisSuspicious = flags.includes("price_basis_suspicious");
    const perPersonMismatch = flags.includes("per_person_or_basis_mismatch");
    const premiumOutlier = flags.includes("too_high_vs_market") || flags.includes("too_high_absolute");

    if (premiumOutlier) {
      warningFlags.add(DP_SAFE_WARNING_FLAGS.premiumOutlierPresent);
    }

    // Exclusion is driven by quality flags only. We deliberately do NOT scan the
    // full-page raw_text_excerpt for coupon tokens here: those pages mention
    // クーポン/ポイント everywhere, so a whole-page scan produces false positives
    // that would wrongly drop clean rows. Genuine coupon-as-price rows are
    // already captured upstream as `price_basis_suspicious`.
    if (priceBasisSuspicious) {
      excludedQualityRowsCount += 1;
      // Use the precise coupon label when the captured number really sits next
      // to a coupon token (e.g. the Jul 18-19 ¥3,000/¥4,000 cluster).
      if (detectCouponContamination(row.raw_text_excerpt, price)) {
        warningFlags.add(DP_SAFE_WARNING_FLAGS.couponExcluded);
      } else {
        warningFlags.add(DP_SAFE_WARNING_FLAGS.priceBasisSuspiciousExcluded);
      }
      continue;
    }
    if (perPersonMismatch) {
      warningFlags.add(DP_SAFE_WARNING_FLAGS.perPersonMismatchExcluded);
      excludedQualityRowsCount += 1;
      continue;
    }

    // Premium high-market outliers are kept in the dp-safe sample (median is
    // robust) but carry a warning so mid-tier DP reviews them before use.
    dpSafePrices.push(price);
  }

  dpSafePrices.sort((left, right) => left - right);
  const dpSafeMedianJpy = median(dpSafePrices);

  if (availableRows.length > 0 && dpSafePrices.length === 0) {
    warningFlags.add(DP_SAFE_WARNING_FLAGS.allRowsExcluded);
  }

  const { useClass, reason } = classify(signal.confidence, dpSafeMedianJpy);
  if (useClass === "exclude" && (signal.confidence === "C" || signal.confidence === "insufficient")) {
    warningFlags.add(DP_SAFE_WARNING_FLAGS.lowConfidence);
  }

  return {
    stayDate: signal.stayDate,
    rawMedianJpy: signal.medianPriceJpy,
    adjustedMedianJpy: signal.qualityAdjustedMedianPriceJpy,
    dpSafeMedianJpy,
    confidence: signal.confidence,
    useClass,
    reason,
    availableCount: signal.availableCount,
    failedCount: signal.failedCount,
    excludedQualityRowsCount,
    warningFlags: [...warningFlags].sort()
  };
}

function classify(
  confidence: MarketSignalConfidence,
  dpSafeMedianJpy: number | null
): { useClass: DpSignalUseClass; reason: string } {
  if (confidence === "A") {
    if (dpSafeMedianJpy === null) {
      return { useClass: "exclude", reason: "confidence_a_but_all_rows_excluded_by_quality" };
    }
    return { useClass: "use_directly", reason: "confidence_a_clean_dp_safe_median" };
  }
  if (confidence === "B") {
    if (dpSafeMedianJpy === null) {
      return { useClass: "exclude", reason: "confidence_b_but_all_rows_excluded_by_quality" };
    }
    return { useClass: "use_directionally", reason: "confidence_b_directional_only" };
  }
  if (confidence === "C") {
    return { useClass: "exclude", reason: "confidence_c_single_sample_not_dp_safe" };
  }
  return { useClass: "exclude", reason: "insufficient_sample_not_dp_safe" };
}

function parseFlags(flagsJson: string | null): string[] {
  if (flagsJson === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(flagsJson);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function loadDpSafeSnapshotRows(
  db: LocalDatabase,
  input: { source: string; postalCode: string; from?: string; to?: string }
): DpSafeSnapshotRow[] {
  const params: Record<string, string> = { source: input.source, postalCode: input.postalCode };
  const filters = ["rs.ota = @source", "p.postal_code = @postalCode"];
  if (input.from !== undefined) {
    filters.push("rs.stay_date >= @from");
    params.from = input.from;
  }
  if (input.to !== undefined) {
    filters.push("rs.stay_date <= @to");
    params.to = input.to;
  }

  return db
    .prepare(
      `WITH ranked AS (
         SELECT
           rs.property_id,
           rs.stay_date,
           rs.availability_status,
           rs.price_total_tax_included,
           rs.raw_text_excerpt,
           pqf.severity AS quality_severity,
           pqf.flags_json AS flags_json,
           ROW_NUMBER() OVER (
             PARTITION BY rs.property_id, rs.ota, rs.stay_date
             ORDER BY rs.checked_at_jst DESC, rs.created_at DESC, rs.id DESC
           ) AS row_rank
         FROM rate_snapshots rs
         JOIN properties p ON p.id = rs.property_id
         LEFT JOIN price_quality_flags pqf ON pqf.rate_snapshot_id = rs.id
         WHERE ${filters.join(" AND ")}
       )
       SELECT property_id, stay_date, availability_status, price_total_tax_included, raw_text_excerpt, quality_severity, flags_json
       FROM ranked
       WHERE row_rank = 1
       ORDER BY stay_date ASC, property_id ASC`
    )
    .all(params) as DpSafeSnapshotRow[];
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

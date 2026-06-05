import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction, type LocalDatabase } from "../db/client";
import { listMarketDailySignals } from "../db/repositories/marketSignalsRepository";
import { upsertPricingRecommendation } from "../db/repositories/pricingRecommendationsRepository";
import { parsePricingTargetSeed, type PricingTargetConfig } from "../config/pricingTargetSchema";
import {
  generatePricingRecommendations,
  type PricingRecommendationRecord
} from "../services/generatePricingRecommendations";
import type { TargetDatePriority } from "../domain/types";

const DEFAULT_PRICING_TARGETS_PATH = "data/config/pricing_targets.sample.json";

export interface PricingRecommendationGenerationSummary {
  targetCount: number;
  processedDatesCount: number;
  recommendationsUpserted: number;
  countByConfidence: Record<string, number>;
  sampleRows: PricingRecommendationRecord[];
}

export function generateAndUpsertPricingRecommendations(
  db: LocalDatabase,
  input: { configPath?: string; createdAt?: string } = {}
): PricingRecommendationGenerationSummary {
  executeMigration(db);
  const targets = readPricingTargets(input.configPath ?? process.env.PRICING_TARGETS_CONFIG ?? DEFAULT_PRICING_TARGETS_PATH);
  const activeTargets = targets.filter((target) => target.active);
  const signals = listMarketDailySignals(db);
  const priorities = loadTargetDatePriorities(db);
  const rows = generatePricingRecommendations({
    targets: activeTargets,
    signals,
    targetDatePriorities: priorities,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
  });

  runInTransaction(db, () => {
    for (const row of rows) {
      upsertPricingRecommendation(db, row);
    }
  });

  return {
    targetCount: activeTargets.length,
    processedDatesCount: new Set(rows.map((row) => row.stayDate)).size,
    recommendationsUpserted: rows.length,
    countByConfidence: countBy(rows, (row) => row.confidence),
    sampleRows: rows.slice(0, 10)
  };
}

export function formatPricingRecommendationGenerationSummary(
  summary: PricingRecommendationGenerationSummary
): string {
  return [
    `target_count=${summary.targetCount}`,
    `processed_dates_count=${summary.processedDatesCount}`,
    `recommendations_upserted=${summary.recommendationsUpserted}`,
    `count_by_confidence=${JSON.stringify(summary.countByConfidence)}`,
    "sample_rows:",
    ...formatRows(summary.sampleRows)
  ].join("\n");
}

function readPricingTargets(path: string): PricingTargetConfig[] {
  return parsePricingTargetSeed(JSON.parse(readFileSync(resolve(path), "utf8")) as unknown);
}

function loadTargetDatePriorities(db: LocalDatabase): Map<string, TargetDatePriority> {
  const rows = db
    .prepare("SELECT stay_date, priority FROM target_dates")
    .all() as Array<{ stay_date: string; priority: TargetDatePriority }>;
  return new Map(rows.map((row) => [row.stay_date, row.priority]));
}

function formatRows(rows: PricingRecommendationRecord[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.targetId} ${row.stayDate} priority=${row.targetPriority ?? "null"} raw=${row.rawMarketMedianJpy ?? "null"} adjusted=${row.qualityAdjustedMarketMedianJpy ?? "null"} baseline=${row.baselineAdrJpy} recommended=${row.recommendedPriceJpy} confidence=${row.confidence} reason=${row.recommendationReason}`
  );
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

if (process.argv[1]?.endsWith("generatePricingRecommendations.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatPricingRecommendationGenerationSummary(generateAndUpsertPricingRecommendations(db)));
  } finally {
    closeDatabase(db);
  }
}

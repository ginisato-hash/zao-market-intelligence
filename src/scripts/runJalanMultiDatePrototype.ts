import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JalanCollector } from "../collectors/jalanCollector";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { insertCollectionJobAttempt } from "../db/repositories/collectionJobAttemptsRepository";
import type { CollectorResult } from "../domain/types";
import { parseJalanMultiDatePrototypeConfig, type JalanMultiDatePrototypeConfig } from "../prototype/jalanPrototypeSchema";
import { LocalScreenshotStorage } from "../services/screenshotStorage";
import { persistCollectorResult } from "../services/persistCollectorResult";
import { buildCollectionJobAttempt } from "../services/recordCollectionJobAttempt";
import { createRunId } from "../utils/ids";
import { upsertJalanLink, upsertPrototypeProperty } from "./runJalanPrototype";

const MULTI_DATE_CONFIG_PATH = "data/prototype/jalan.multi-date.prototype.json";

export interface JalanMultiDateDryRunSummary {
  dryRun: true;
  propertyName: string;
  propertyUrl: string;
  ota: "jalan";
  plannedDates: string[];
  maxAttempts: number;
  delayMsBetweenAttempts: number;
}

export interface JalanMultiDateRunSummary {
  collectorRunId: string;
  propertyName: string;
  propertyUrl: string;
  ota: "jalan";
  attemptedDates: string[];
  attemptedDateCount: number;
  statusCounts: Record<string, number>;
  acceptedPricesByDate: Record<string, number>;
  failedDates: Array<{ stayDate: string; errorReason: string }>;
  screenshotPathsByDate: Record<string, string>;
  debugJsonPathsByDate: Record<string, string>;
  persistedRateSnapshots: number;
  persistedInventorySnapshots: number;
  persistedJobAttempts: number;
  crawlBudget: {
    maxAttempts: number;
    actualAttempts: number;
    delayMsBetweenAttempts: number;
    sequential: true;
  };
}

export interface JalanMultiDateRunnerDeps {
  db?: LocalDatabase;
  collector?: { collect(input: Parameters<JalanCollector["collect"]>[0]): Promise<CollectorResult[]> };
  delay?: (ms: number) => Promise<void>;
}

export function loadJalanMultiDatePrototypeConfig(path = MULTI_DATE_CONFIG_PATH): JalanMultiDatePrototypeConfig {
  return parseJalanMultiDatePrototypeConfig(JSON.parse(readFileSync(resolve(path), "utf8")));
}

export function resolveJalanBatchConfigPath(argv = process.argv, env = process.env): string {
  const configIndex = argv.indexOf("--config");
  const cliConfig = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  return cliConfig ?? env.JALAN_BATCH_CONFIG ?? MULTI_DATE_CONFIG_PATH;
}

export function runJalanMultiDateDryRun(path = MULTI_DATE_CONFIG_PATH): JalanMultiDateDryRunSummary {
  const config = loadJalanMultiDatePrototypeConfig(path);
  return {
    dryRun: true,
    propertyName: config.property_name,
    propertyUrl: config.property_url,
    ota: "jalan",
    plannedDates: config.stay_dates.slice(0, config.max_attempts),
    maxAttempts: config.max_attempts,
    delayMsBetweenAttempts: config.delay_ms_between_attempts
  };
}

export async function runJalanMultiDatePrototype(
  config: JalanMultiDatePrototypeConfig,
  deps: JalanMultiDateRunnerDeps = {}
): Promise<JalanMultiDateRunSummary> {
  const ownsDb = deps.db === undefined;
  const db = deps.db ?? openLocalDatabase();
  const collector =
    deps.collector ??
    new JalanCollector({
      screenshotStorage: new LocalScreenshotStorage()
    });
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)));
  const runId = createRunId();
  const attemptedDates = config.stay_dates.slice(0, config.max_attempts);
  const summary: JalanMultiDateRunSummary = {
    collectorRunId: runId,
    propertyName: config.property_name,
    propertyUrl: config.property_url,
    ota: "jalan",
    attemptedDates,
    attemptedDateCount: attemptedDates.length,
    statusCounts: {},
    acceptedPricesByDate: {},
    failedDates: [],
    screenshotPathsByDate: {},
    debugJsonPathsByDate: {},
    persistedRateSnapshots: 0,
    persistedInventorySnapshots: 0,
    persistedJobAttempts: 0,
    crawlBudget: {
      maxAttempts: config.max_attempts,
      actualAttempts: attemptedDates.length,
      delayMsBetweenAttempts: config.delay_ms_between_attempts,
      sequential: true
    }
  };

  try {
    executeMigration(db);
    const propertyId = upsertPrototypeProperty(db, config);
    upsertJalanLink(db, propertyId, config);

    for (let index = 0; index < attemptedDates.length; index += 1) {
      const stayDate = attemptedDates[index];
      if (stayDate === undefined) {
        continue;
      }
      if (index > 0) {
        await delay(config.delay_ms_between_attempts);
      }

      const collectorInput = {
        runId,
        propertyId,
        propertyName: config.property_name,
        ota: "jalan" as const,
        propertyUrl: config.property_url,
        stayDate,
        guests: config.adults,
        adults: config.adults,
        children: config.children,
        rooms: config.rooms,
        nights: config.nights,
        jobId: `jalan_multi_date_${stayDate}`
      };

      const [result] = await collector.collect(collectorInput);

      if (result === undefined) {
        continue;
      }

      persistCollectorResult(db, result);
      insertCollectionJobAttempt(
        db,
        buildCollectionJobAttempt(collectorInput, result, {
          debugJsonPath: `.data/debug/jalan/${runId}/${stayDate}.json`
        })
      );
      const status = result.rateSnapshot.availabilityStatus;
      summary.statusCounts[status] = (summary.statusCounts[status] ?? 0) + 1;
      if (result.rateSnapshot.priceTotalTaxIncluded !== null) {
        summary.acceptedPricesByDate[stayDate] = result.rateSnapshot.priceTotalTaxIncluded;
      }
      if (result.rateSnapshot.errorReason !== undefined) {
        summary.failedDates.push({ stayDate, errorReason: result.rateSnapshot.errorReason });
      }
      if (result.rateSnapshot.screenshotKey !== undefined) {
        summary.screenshotPathsByDate[stayDate] = result.rateSnapshot.screenshotKey;
      }
      summary.debugJsonPathsByDate[stayDate] = `.data/debug/jalan/${runId}/${stayDate}.json`;
      summary.persistedRateSnapshots += 1;
      summary.persistedInventorySnapshots += 1;
      summary.persistedJobAttempts += 1;
    }

    return summary;
  } finally {
    if (ownsDb) {
      closeDatabase(db);
    }
  }
}

export function printJalanMultiDateSummary(summary: JalanMultiDateRunSummary): void {
  console.log(`collector_run_id=${summary.collectorRunId}`);
  console.log(`property_name=${summary.propertyName}`);
  console.log(`property_url=${summary.propertyUrl}`);
  console.log(`ota=${summary.ota}`);
  console.log(`attempted_date_count=${summary.attemptedDateCount}`);
  console.log(`attempted_dates=${JSON.stringify(summary.attemptedDates)}`);
  console.log(`status_counts=${JSON.stringify(summary.statusCounts)}`);
  console.log(`accepted_prices_by_date=${JSON.stringify(summary.acceptedPricesByDate)}`);
  console.log(`failed_dates=${JSON.stringify(summary.failedDates)}`);
  console.log(`screenshot_paths_by_date=${JSON.stringify(summary.screenshotPathsByDate)}`);
  console.log(`debug_json_paths_by_date=${JSON.stringify(summary.debugJsonPathsByDate)}`);
  console.log(`persisted_rate_snapshots=${summary.persistedRateSnapshots}`);
  console.log(`persisted_inventory_snapshots=${summary.persistedInventorySnapshots}`);
  console.log(`persisted_job_attempts=${summary.persistedJobAttempts}`);
  console.log(`crawl_budget=${JSON.stringify(summary.crawlBudget)}`);
}

async function main(): Promise<void> {
  const dryRun = process.env.JALAN_MULTI_DATE_DRY_RUN === "true";
  const configPath = resolveJalanBatchConfigPath();

  if (dryRun) {
    const summary = runJalanMultiDateDryRun(configPath);
    console.log("jalan_multi_date_dry_run=true");
    console.log(`property_name=${summary.propertyName}`);
    console.log(`property_url=${summary.propertyUrl}`);
    console.log(`ota=${summary.ota}`);
    console.log(`planned_dates=${JSON.stringify(summary.plannedDates)}`);
    console.log(`max_attempts=${summary.maxAttempts}`);
    console.log(`delay_ms_between_attempts=${summary.delayMsBetweenAttempts}`);
    console.log("db_writes=0");
    console.log("screenshots=0");
    return;
  }

  printJalanMultiDateSummary(await runJalanMultiDatePrototype(loadJalanMultiDatePrototypeConfig(configPath)));
}

if (process.argv[1]?.endsWith("runJalanMultiDatePrototype.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

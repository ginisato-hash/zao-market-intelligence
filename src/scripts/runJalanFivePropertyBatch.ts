import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JalanCollector } from "../collectors/jalanCollector";
import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction, type LocalDatabase } from "../db/client";
import { insertCollectionJobAttempt } from "../db/repositories/collectionJobAttemptsRepository";
import type { CollectorResult } from "../domain/types";
import {
  parseJalanFivePropertyBatchConfig,
  type JalanFivePropertyBatchConfig
} from "../prototype/jalanFivePropertyBatchSchema";
import { buildCollectionJobAttempt } from "../services/recordCollectionJobAttempt";
import { persistCollectorResult } from "../services/persistCollectorResult";
import { LocalScreenshotStorage } from "../services/screenshotStorage";
import { createRunId } from "../utils/ids";

const DEFAULT_CONFIG_PATH = "data/prototype/jalan.five-property-batch.sample.json";

export interface JalanFivePropertyDryRunSummary {
  dryRun: true;
  properties: Array<{ propertyName: string; propertyUrl: string }>;
  stayDates: string[];
  plannedJobs: Array<{ propertyName: string; stayDate: string }>;
  maxJobs: number;
  delayMsBetweenJobs: number;
}

export interface JalanFivePropertyJobResult {
  propertyName: string;
  propertyUrl: string;
  stayDate: string;
  availabilityStatus: string;
  price: number | null;
  errorReason: string | null;
  screenshotPath: string | null;
  debugJsonPath: string;
}

export interface JalanFivePropertyRunSummary {
  collectorRunId: string;
  propertyCount: number;
  dateCount: number;
  totalJobsPlanned: number;
  totalJobsAttempted: number;
  statusCounts: Record<string, number>;
  outcomeCounts: Record<string, number>;
  jobResults: JalanFivePropertyJobResult[];
  persistedRateSnapshots: number;
  persistedInventorySnapshots: number;
  persistedJobAttempts: number;
  crawlBudget: {
    maxJobs: number;
    actualJobs: number;
    delayMsBetweenJobs: number;
    sequential: true;
  };
}

export interface JalanFivePropertyBatchDeps {
  db?: LocalDatabase;
  collector?: { collect(input: Parameters<JalanCollector["collect"]>[0]): Promise<CollectorResult[]> };
  delay?: (ms: number) => Promise<void>;
}

export function loadJalanFivePropertyBatchConfig(path = DEFAULT_CONFIG_PATH): JalanFivePropertyBatchConfig {
  return parseJalanFivePropertyBatchConfig(JSON.parse(readFileSync(resolve(path), "utf8")));
}

export function resolveJalanFivePropertyConfigPath(argv = process.argv, env = process.env): string {
  const configIndex = argv.indexOf("--config");
  const cliConfig = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  return cliConfig ?? env.JALAN_FIVE_PROPERTY_BATCH_CONFIG ?? DEFAULT_CONFIG_PATH;
}

export function runJalanFivePropertyDryRun(path = DEFAULT_CONFIG_PATH): JalanFivePropertyDryRunSummary {
  const config = loadJalanFivePropertyBatchConfig(path);
  const plannedJobs = config.properties.flatMap((prop) =>
    config.stay_dates.map((date) => ({ propertyName: prop.property_name, stayDate: date }))
  );
  return {
    dryRun: true,
    properties: config.properties.map((p) => ({ propertyName: p.property_name, propertyUrl: p.property_url })),
    stayDates: config.stay_dates,
    plannedJobs,
    maxJobs: config.max_jobs,
    delayMsBetweenJobs: config.delay_ms_between_jobs
  };
}

function upsertBatchProperty(db: LocalDatabase, propertyName: string, propertyUrl: string): string {
  const propertyId = `property_prototype_${createHash("sha1").update(propertyName).digest("hex").slice(0, 12)}`;

  runInTransaction(db, () => {
    db.prepare(
      `INSERT INTO properties (id, name, postal_code, area_name, property_type, price_segment, meal_style, has_onsen, ski_access, active, notes)
       VALUES (@id, @name, '990-2301', 'Zao Onsen', 'unknown', 'unknown', 'unknown', NULL, 'unknown', 1, @notes)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         active = 1,
         notes = excluded.notes,
         updated_at = datetime('now')`
    ).run({
      id: propertyId,
      name: propertyName,
      notes: "Jalan five-property batch property; controlled low-volume testing only."
    });

    const linkId = `ota_link_prototype_${createHash("sha1").update(`${propertyId}|jalan`).digest("hex").slice(0, 12)}`;
    const existing = db
      .prepare("SELECT id FROM property_ota_links WHERE property_id = ? AND ota = 'jalan'")
      .get(propertyId) as { id: string } | undefined;

    if (existing === undefined) {
      db.prepare(
        `INSERT INTO property_ota_links (id, property_id, ota, url, property_url, active, notes)
         VALUES (@id, @propertyId, 'jalan', @url, @url, 1, @notes)`
      ).run({
        id: linkId,
        propertyId,
        url: propertyUrl,
        notes: "Jalan five-property batch URL; low-volume testing only."
      });
    } else {
      db.prepare(
        `UPDATE property_ota_links
         SET url = @url,
             property_url = @url,
             active = 1,
             notes = @notes,
             updated_at = datetime('now')
         WHERE id = @id`
      ).run({ id: existing.id, url: propertyUrl, notes: "Jalan five-property batch URL; low-volume testing only." });
    }
  });

  return propertyId;
}

export async function runJalanFivePropertyBatch(
  config: JalanFivePropertyBatchConfig,
  deps: JalanFivePropertyBatchDeps = {}
): Promise<JalanFivePropertyRunSummary> {
  const ownsDb = deps.db === undefined;
  const db = deps.db ?? openLocalDatabase();
  const collector =
    deps.collector ??
    new JalanCollector({
      screenshotStorage: new LocalScreenshotStorage()
    });
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runId = createRunId();

  const summary: JalanFivePropertyRunSummary = {
    collectorRunId: runId,
    propertyCount: config.properties.length,
    dateCount: config.stay_dates.length,
    totalJobsPlanned: Math.min(config.properties.length * config.stay_dates.length, config.max_jobs),
    totalJobsAttempted: 0,
    statusCounts: {},
    outcomeCounts: {},
    jobResults: [],
    persistedRateSnapshots: 0,
    persistedInventorySnapshots: 0,
    persistedJobAttempts: 0,
    crawlBudget: {
      maxJobs: config.max_jobs,
      actualJobs: 0,
      delayMsBetweenJobs: config.delay_ms_between_jobs,
      sequential: true
    }
  };

  try {
    executeMigration(db);
    const propertyIds = config.properties.map((prop) => upsertBatchProperty(db, prop.property_name, prop.property_url));
    let jobIndex = 0;

    for (let pi = 0; pi < config.properties.length; pi += 1) {
      const prop = config.properties[pi];
      const propertyId = propertyIds[pi];
      if (prop === undefined || propertyId === undefined) continue;

      for (const stayDate of config.stay_dates) {
        if (jobIndex >= config.max_jobs) break;
        if (jobIndex > 0) await delay(config.delay_ms_between_jobs);

        const jobId = `jalan_five_property_${propertyId}_${stayDate}`;
        const collectorInput = {
          runId,
          propertyId,
          propertyName: prop.property_name,
          ota: "jalan" as const,
          propertyUrl: prop.property_url,
          stayDate,
          guests: config.adults,
          adults: config.adults,
          children: config.children,
          rooms: config.rooms,
          nights: config.nights,
          jobId
        };

        const [result] = await collector.collect(collectorInput);
        if (result === undefined) {
          jobIndex += 1;
          continue;
        }

        persistCollectorResult(db, result);
        const debugJsonPath = `.data/debug/jalan/${runId}/${propertyId}_${stayDate}.json`;
        const attempt = buildCollectionJobAttempt(collectorInput, result, { debugJsonPath });
        insertCollectionJobAttempt(db, attempt);

        const status = result.rateSnapshot.availabilityStatus;
        summary.statusCounts[status] = (summary.statusCounts[status] ?? 0) + 1;
        summary.outcomeCounts[attempt.outcome] = (summary.outcomeCounts[attempt.outcome] ?? 0) + 1;
        summary.jobResults.push({
          propertyName: prop.property_name,
          propertyUrl: prop.property_url,
          stayDate,
          availabilityStatus: status,
          price: result.rateSnapshot.priceTotalTaxIncluded ?? null,
          errorReason: result.rateSnapshot.errorReason ?? null,
          screenshotPath: result.rateSnapshot.screenshotKey ?? null,
          debugJsonPath
        });

        summary.persistedRateSnapshots += 1;
        summary.persistedInventorySnapshots += 1;
        summary.persistedJobAttempts += 1;
        summary.totalJobsAttempted += 1;
        summary.crawlBudget.actualJobs += 1;
        jobIndex += 1;
      }
    }

    return summary;
  } finally {
    if (ownsDb) closeDatabase(db);
  }
}

export function printJalanFivePropertyBatchSummary(summary: JalanFivePropertyRunSummary): void {
  console.log(`collector_run_id=${summary.collectorRunId}`);
  console.log(`property_count=${summary.propertyCount}`);
  console.log(`date_count=${summary.dateCount}`);
  console.log(`total_jobs_planned=${summary.totalJobsPlanned}`);
  console.log(`total_jobs_attempted=${summary.totalJobsAttempted}`);
  console.log(`status_counts=${JSON.stringify(summary.statusCounts)}`);
  console.log(`outcome_counts=${JSON.stringify(summary.outcomeCounts)}`);
  console.log(`persisted_rate_snapshots=${summary.persistedRateSnapshots}`);
  console.log(`persisted_inventory_snapshots=${summary.persistedInventorySnapshots}`);
  console.log(`persisted_job_attempts=${summary.persistedJobAttempts}`);
  console.log(`crawl_budget=${JSON.stringify(summary.crawlBudget)}`);
  console.log("---");
  console.log("property | stay_date | status | price | error_reason | screenshot | debug_json");
  for (const job of summary.jobResults) {
    console.log(
      `${job.propertyName} | ${job.stayDate} | ${job.availabilityStatus} | ${job.price ?? "null"} | ${job.errorReason ?? "null"} | ${job.screenshotPath ?? "null"} | ${job.debugJsonPath}`
    );
  }
}

async function main(): Promise<void> {
  const dryRun = process.env.JALAN_FIVE_PROPERTY_DRY_RUN === "true";
  const configPath = resolveJalanFivePropertyConfigPath();

  if (dryRun) {
    const summary = runJalanFivePropertyDryRun(configPath);
    console.log("jalan_five_property_batch_dry_run=true");
    console.log(`property_count=${summary.properties.length}`);
    console.log(`stay_dates=${JSON.stringify(summary.stayDates)}`);
    console.log(`total_jobs_planned=${summary.plannedJobs.length}`);
    console.log(`max_jobs=${summary.maxJobs}`);
    console.log(`delay_ms_between_jobs=${summary.delayMsBetweenJobs}`);
    console.log("planned_jobs:");
    for (const job of summary.plannedJobs) {
      console.log(`  ${job.propertyName} × ${job.stayDate}`);
    }
    console.log("db_writes=0");
    console.log("screenshots=0");
    console.log("attempts=0");
    return;
  }

  const config = loadJalanFivePropertyBatchConfig(configPath);
  printJalanFivePropertyBatchSummary(await runJalanFivePropertyBatch(config));
}

if (process.argv[1]?.endsWith("runJalanFivePropertyBatch.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

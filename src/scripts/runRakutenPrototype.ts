import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RakutenCollector } from "../collectors/rakutenCollector";
import { buildRakutenAttemptUrl } from "../collectors/rakutenUrl";
import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction, type LocalDatabase } from "../db/client";
import { insertCollectionJobAttempt } from "../db/repositories/collectionJobAttemptsRepository";
import type { CollectorInput, CollectorResult } from "../domain/types";
import { parseRakutenPrototypeConfig, type RakutenPrototypeConfig } from "../prototype/rakutenPrototypeSchema";
import { LocalScreenshotStorage } from "../services/screenshotStorage";
import { persistCollectorResult } from "../services/persistCollectorResult";
import { buildCollectionJobAttempt } from "../services/recordCollectionJobAttempt";
import { createRunId } from "../utils/ids";

const RAKUTEN_CONFIG_PATH = "data/prototype/rakuten.prototype.json";

export interface RakutenPrototypeDryRunSummary {
  dryRun: true;
  propertyName: string;
  ota: "rakuten";
  plannedDates: string[];
  attemptUrls: string[];
}

export interface RakutenPrototypeRunSummary {
  collectorRunId: string;
  propertyName: string;
  propertyUrl: string;
  attemptUrl: string;
  stayDate: string;
  availabilityStatus: string;
  priceTotalTaxIncluded: number | null;
  errorReason: string | null;
  screenshotPath: string | null;
  debugJsonPath: string;
  persistedRateSnapshots: number;
  persistedInventorySnapshots: number;
  persistedJobAttempts: number;
}

export interface RakutenPrototypeRunnerDeps {
  db?: LocalDatabase;
  collector?: { collect(input: CollectorInput): Promise<CollectorResult[]> };
}

export function loadRakutenPrototypeConfig(path = RAKUTEN_CONFIG_PATH): RakutenPrototypeConfig {
  return parseRakutenPrototypeConfig(JSON.parse(readFileSync(resolve(path), "utf8")));
}

export function runRakutenPrototypeDryRun(path = RAKUTEN_CONFIG_PATH): RakutenPrototypeDryRunSummary {
  const config = loadRakutenPrototypeConfig(path);
  const runId = createRunId();
  const attemptUrls = config.stay_dates.map((stayDate) =>
    buildRakutenAttemptUrl(toCollectorInput(config, runId, "property_rakuten_prototype_dry_run", stayDate))
  );
  return {
    dryRun: true,
    propertyName: config.property_name,
    ota: "rakuten",
    plannedDates: config.stay_dates,
    attemptUrls
  };
}

export async function runRakutenPrototype(
  config: RakutenPrototypeConfig,
  deps: RakutenPrototypeRunnerDeps = {}
): Promise<RakutenPrototypeRunSummary> {
  const ownsDb = deps.db === undefined;
  const db = deps.db ?? openLocalDatabase();
  const collector =
    deps.collector ??
    new RakutenCollector({ screenshotStorage: new LocalScreenshotStorage() });

  const runId = createRunId();

  try {
    executeMigration(db);
    const propertyId = upsertRakutenPrototypeProperty(db, config);

    // Use only the first stay_date as this is a single-date prototype
    const stayDate = config.stay_dates[0] ?? "2026-08-08";
    const collectorInput = toCollectorInput(config, runId, propertyId, stayDate);
    const debugJsonPath = `.data/debug/rakuten/${runId}/${stayDate}.json`;

    const [result] = await collector.collect(collectorInput);
    if (result === undefined) {
      throw new Error("Collector returned no results.");
    }

    persistCollectorResult(db, result);
    insertCollectionJobAttempt(
      db,
      buildCollectionJobAttempt(collectorInput, result, { debugJsonPath })
    );

    return {
      collectorRunId: runId,
      propertyName: config.property_name,
      propertyUrl: config.property_url,
      attemptUrl: buildRakutenAttemptUrl(collectorInput),
      stayDate,
      availabilityStatus: result.rateSnapshot.availabilityStatus,
      priceTotalTaxIncluded: result.rateSnapshot.priceTotalTaxIncluded ?? null,
      errorReason: result.rateSnapshot.errorReason ?? null,
      screenshotPath: result.rateSnapshot.screenshotKey ?? null,
      debugJsonPath,
      persistedRateSnapshots: 1,
      persistedInventorySnapshots: 1,
      persistedJobAttempts: 1
    };
  } finally {
    if (ownsDb) {
      closeDatabase(db);
    }
  }
}

export function printRakutenPrototypeRunSummary(summary: RakutenPrototypeRunSummary): void {
  console.log(`collector_run_id=${summary.collectorRunId}`);
  console.log(`property_name=${summary.propertyName}`);
  console.log(`property_url=${summary.propertyUrl}`);
  console.log(`attempt_url=${summary.attemptUrl}`);
  console.log(`stay_date=${summary.stayDate}`);
  console.log(`availability_status=${summary.availabilityStatus}`);
  console.log(`price_total_tax_included=${summary.priceTotalTaxIncluded ?? "null"}`);
  console.log(`error_reason=${summary.errorReason ?? "null"}`);
  console.log(`screenshot_path=${summary.screenshotPath ?? "null"}`);
  console.log(`debug_json_path=${summary.debugJsonPath}`);
  console.log(`persisted_rate_snapshots=${summary.persistedRateSnapshots}`);
  console.log(`persisted_inventory_snapshots=${summary.persistedInventorySnapshots}`);
  console.log(`persisted_job_attempts=${summary.persistedJobAttempts}`);
}

function upsertRakutenPrototypeProperty(db: LocalDatabase, config: RakutenPrototypeConfig): string {
  const propertyId = `property_prototype_${createHash("sha1").update(config.property_name).digest("hex").slice(0, 12)}`;

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
      name: config.property_name,
      notes: "Rakuten prototype property; requires verification before seed promotion."
    });

    const linkId = `ota_link_prototype_${createHash("sha1").update(`${propertyId}|rakuten`).digest("hex").slice(0, 12)}`;
    const existing = db
      .prepare("SELECT id FROM property_ota_links WHERE property_id = ? AND ota = 'rakuten'")
      .get(propertyId) as { id: string } | undefined;

    if (existing === undefined) {
      db.prepare(
        `INSERT INTO property_ota_links (id, property_id, ota, url, property_url, active, notes)
         VALUES (@id, @propertyId, 'rakuten', @url, @url, 1, @notes)`
      ).run({
        id: linkId,
        propertyId,
        url: config.property_url,
        notes: "Rakuten prototype URL; low-volume testing only."
      });
    } else {
      db.prepare(
        `UPDATE property_ota_links SET url = @url, property_url = @url, active = 1,
         notes = @notes, updated_at = datetime('now') WHERE id = @id`
      ).run({ id: existing.id, url: config.property_url, notes: "Rakuten prototype URL; low-volume testing only." });
    }
  });

  return propertyId;
}

function toCollectorInput(
  config: RakutenPrototypeConfig,
  runId: string,
  propertyId: string,
  stayDate: string
): CollectorInput {
  return {
    runId,
    propertyId,
    propertyName: config.property_name,
    ota: "rakuten",
    propertyUrl: config.property_url,
    stayDate,
    guests: config.adults,
    adults: config.adults,
    children: config.children,
    rooms: config.rooms,
    nights: config.nights,
    jobId: `rakuten_prototype_${stayDate}`
  };
}

async function main(): Promise<void> {
  const dryRun = process.env.RAKUTEN_PROTOTYPE_DRY_RUN === "true";
  const config = loadRakutenPrototypeConfig();

  if (dryRun) {
    const summary = runRakutenPrototypeDryRun();
    console.log("rakuten_prototype_dry_run=true");
    console.log(`property_name=${summary.propertyName}`);
    console.log(`ota=${summary.ota}`);
    console.log(`planned_dates=${JSON.stringify(summary.plannedDates)}`);
    console.log(`attempt_urls=${JSON.stringify(summary.attemptUrls)}`);
    console.log("db_writes=0");
    console.log("screenshots=0");
    console.log("network_requests=0");
    return;
  }

  printRakutenPrototypeRunSummary(await runRakutenPrototype(config));
}

if (process.argv[1]?.endsWith("runRakutenPrototype.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

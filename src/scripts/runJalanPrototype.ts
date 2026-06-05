import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JalanCollector } from "../collectors/jalanCollector";
import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction } from "../db/client";
import type { LocalDatabase } from "../db/client";
import { LocalScreenshotStorage } from "../services/screenshotStorage";
import { persistCollectorResult } from "../services/persistCollectorResult";
import { parseJalanPrototypeConfig, type JalanPrototypeConfig } from "../prototype/jalanPrototypeSchema";
import { createRunId } from "../utils/ids";

const PROTOTYPE_CONFIG_PATH = "data/prototype/jalan.prototype.json";

export interface JalanPrototypeDryRunSummary {
  dryRun: true;
  propertyName: string;
  ota: "jalan";
  attemptedDates: string[];
}

export function loadJalanPrototypeConfig(path = PROTOTYPE_CONFIG_PATH): JalanPrototypeConfig {
  return parseJalanPrototypeConfig(JSON.parse(readFileSync(resolve(path), "utf8")));
}

export function runJalanPrototypeDryRun(path = PROTOTYPE_CONFIG_PATH): JalanPrototypeDryRunSummary {
  const config = loadJalanPrototypeConfig(path);
  return {
    dryRun: true,
    propertyName: config.property_name,
    ota: "jalan",
    attemptedDates: config.stay_dates
  };
}

async function main(): Promise<void> {
  const dryRun = process.env.JALAN_PROTOTYPE_DRY_RUN === "true";
  const config = loadJalanPrototypeConfig();

  if (dryRun) {
    const summary = runJalanPrototypeDryRun();
    console.log("jalan_prototype_dry_run=true");
    console.log(`property_name=${summary.propertyName}`);
    console.log(`ota=${summary.ota}`);
    console.log(`planned_dates=${JSON.stringify(summary.attemptedDates)}`);
    console.log("db_writes=0");
    console.log("screenshots=0");
    return;
  }

  const db = openLocalDatabase();
  const runId = createRunId();

  try {
    executeMigration(db);
    const propertyId = upsertPrototypeProperty(db, config);
    upsertJalanLink(db, propertyId, config);

    const collector = new JalanCollector({
      screenshotStorage: new LocalScreenshotStorage()
    });
    const statusCounts: Record<string, number> = {};
    const errorReasons: string[] = [];
    const screenshotPaths: string[] = [];

    for (let index = 0; index < config.stay_dates.length; index += 1) {
      const stayDate = config.stay_dates[index];
      if (stayDate === undefined) {
        continue;
      }

      if (index > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
      }

      const [result] = await collector.collect({
        runId,
        propertyId,
        propertyName: config.property_name,
        ota: "jalan",
        propertyUrl: config.property_url,
        stayDate,
        guests: config.adults,
        adults: config.adults,
        children: config.children,
        rooms: config.rooms,
        nights: config.nights,
        jobId: `jalan_prototype_${stayDate}`
      });

      if (result === undefined) {
        continue;
      }

      persistCollectorResult(db, result);
      statusCounts[result.rateSnapshot.availabilityStatus] =
        (statusCounts[result.rateSnapshot.availabilityStatus] ?? 0) + 1;
      if (result.rateSnapshot.errorReason !== undefined) {
        errorReasons.push(result.rateSnapshot.errorReason);
      }
      if (result.rateSnapshot.screenshotKey !== undefined) {
        screenshotPaths.push(result.rateSnapshot.screenshotKey);
      }
    }

    console.log(`collector_run_id=${runId}`);
    console.log(`property_name=${config.property_name}`);
    console.log("ota=jalan");
    console.log(`attempted_dates=${JSON.stringify(config.stay_dates)}`);
    console.log(`status_counts=${JSON.stringify(statusCounts)}`);
    console.log(`screenshots_written=${screenshotPaths.length}`);
    console.log(`persisted_rate_snapshots=${config.stay_dates.length}`);
    console.log(`persisted_inventory_snapshots=${config.stay_dates.length}`);
    console.log(`error_reasons=${JSON.stringify(errorReasons)}`);
  } finally {
    closeDatabase(db);
  }
}

export function upsertPrototypeProperty(db: LocalDatabase, config: JalanPrototypeConfig): string {
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
      notes: "Manual Jalan prototype property; requires verification before seed promotion."
    });
  });
  return propertyId;
}

export function upsertJalanLink(db: LocalDatabase, propertyId: string, config: JalanPrototypeConfig): void {
  const params = {
    id: `ota_link_prototype_${createHash("sha1").update(`${propertyId}|jalan`).digest("hex").slice(0, 12)}`,
    propertyId,
    url: config.property_url,
    notes: "Manual Jalan prototype URL; low-volume testing only."
  };
  const existing = db
    .prepare("SELECT id FROM property_ota_links WHERE property_id = ? AND ota = 'jalan'")
    .get(propertyId) as { id: string } | undefined;

  if (existing === undefined) {
    db.prepare(
      `INSERT INTO property_ota_links (id, property_id, ota, url, property_url, active, notes)
       VALUES (@id, @propertyId, 'jalan', @url, @url, 1, @notes)`
    ).run(params);
    return;
  }

  db.prepare(
    `UPDATE property_ota_links
     SET url = @url,
         property_url = @url,
         active = 1,
         notes = @notes,
         updated_at = datetime('now')
     WHERE id = @id`
  ).run({ ...params, id: existing.id });
}

if (process.argv[1]?.endsWith("runJalanPrototype.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

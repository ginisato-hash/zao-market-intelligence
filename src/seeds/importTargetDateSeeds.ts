import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LocalDatabase } from "../db/client";
import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction } from "../db/client";
import { upsertTargetDate } from "../db/repositories/targetDatesRepository";
import { targetDateSeedFileSchema } from "./targetDateSeedSchema";

export const DEFAULT_TARGET_DATE_SEED_PATH = "data/seeds/target_dates.990-2301.sample.json";

export interface ImportTargetDateSeedsOptions {
  db?: LocalDatabase;
  targetDateSeedPath?: string;
}

export interface ImportTargetDateSeedsSummary {
  targetDatesInserted: number;
  targetDatesUpdated: number;
  skippedRecords: number;
}

export function importTargetDateSeeds(options: ImportTargetDateSeedsOptions = {}): ImportTargetDateSeedsSummary {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openLocalDatabase();

  try {
    executeMigration(db);
    const seeds = readTargetDateSeeds(options.targetDateSeedPath ?? DEFAULT_TARGET_DATE_SEED_PATH);

    return runInTransaction(db, () => {
      const summary: ImportTargetDateSeedsSummary = {
        targetDatesInserted: 0,
        targetDatesUpdated: 0,
        skippedRecords: 0
      };

      for (const seed of seeds) {
        const result = upsertTargetDate(db, {
          stayDate: seed.stay_date,
          priority: seed.priority,
          reason: seed.reason,
          active: seed.active
        });

        if (result === "inserted") {
          summary.targetDatesInserted += 1;
        } else {
          summary.targetDatesUpdated += 1;
        }
      }

      return summary;
    });
  } finally {
    if (ownsDb) {
      closeDatabase(db);
    }
  }
}

function readTargetDateSeeds(path: string) {
  try {
    return targetDateSeedFileSchema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid target date seed file ${path}: ${error.message}`);
    }
    throw error;
  }
}

if (process.argv[1]?.endsWith("importTargetDateSeeds.ts")) {
  const summary = importTargetDateSeeds();
  console.log(`target_dates_inserted=${summary.targetDatesInserted}`);
  console.log(`target_dates_updated=${summary.targetDatesUpdated}`);
  console.log(`skipped_records=${summary.skippedRecords}`);
}

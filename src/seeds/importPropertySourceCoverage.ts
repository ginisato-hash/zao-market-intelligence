import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  closeDatabase,
  executeMigration,
  openLocalDatabase,
  runInTransaction,
  type LocalDatabase
} from "../db/client";
import { upsertPropertySourceCoverage } from "../db/repositories/propertySourceCoverageRepository";
import { resolveCanonicalPropertyNameDetailed } from "../services/propertyAliasResolver";
import { readPropertyAliasSeed } from "./importPropertyAliases";
import {
  propertySourceCoverageSeedRecordSchema,
  type PropertySourceCoverageSeedRecord
} from "./propertySourceCoverageSeedSchema";

export const DEFAULT_SOURCE_COVERAGE_SEED_PATH = "data/seeds/property_source_coverage.990-2301.sample.json";

export interface ImportPropertySourceCoverageOptions {
  db?: LocalDatabase;
  seedPath?: string;
  aliasSeedPath?: string;
}

export interface ImportPropertySourceCoverageSummary {
  coverageInserted: number;
  coverageUpdated: number;
  skippedRecords: number;
  skipped: Array<{ reason: string }>;
  countBySource: Record<string, number>;
  countByCoverageStatus: Record<string, number>;
  propertiesInserted: number;
  aliasResolvedCount: number;
}

interface ExistingIdRow {
  id: string;
}

export function importPropertySourceCoverage(
  options: ImportPropertySourceCoverageOptions = {}
): ImportPropertySourceCoverageSummary {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openLocalDatabase();
  try {
    executeMigration(db);
    const seedPath = options.seedPath ?? process.env.SOURCE_COVERAGE_SEED ?? DEFAULT_SOURCE_COVERAGE_SEED_PATH;
    const rawRecords = readRawSourceCoverageSeed(seedPath);
    const aliases = readPropertyAliasSeed(options.aliasSeedPath);

    return runInTransaction(db, () => {
      const summary: ImportPropertySourceCoverageSummary = {
        coverageInserted: 0,
        coverageUpdated: 0,
        skippedRecords: 0,
        skipped: [],
        countBySource: {},
        countByCoverageStatus: {},
        propertiesInserted: 0,
        aliasResolvedCount: 0
      };

      rawRecords.forEach((raw, index) => {
        const parsed = propertySourceCoverageSeedRecordSchema.safeParse(raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const reason = issue === undefined ? "invalid record" : `${issue.path.join(".") || "record"}: ${issue.message}`;
          summary.skippedRecords += 1;
          summary.skipped.push({ reason: `record[${index}] ${reason}` });
          return;
        }
        const seed = parsed.data;

        const aliasResolution = resolveCanonicalPropertyNameDetailed(seed.property_name, aliases);
        if (aliasResolution.status === "ambiguous") {
          summary.skippedRecords += 1;
          summary.skipped.push({ reason: `record[${index}] ambiguous alias for "${seed.property_name}"` });
          return;
        }
        if (aliasResolution.status === "resolved") {
          summary.aliasResolvedCount += 1;
        }
        const canonicalName = aliasResolution.canonicalName;

        const property = findPropertyByName(db, canonicalName);
        const propertyId = property?.id ?? deterministicPropertyId(canonicalName);
        if (property === undefined) {
          insertMinimalProperty(db, propertyId, canonicalName, seed);
          summary.propertiesInserted += 1;
        }

        const result = upsertPropertySourceCoverage(db, {
          propertyId,
          source: seed.source,
          sourcePropertyId: seed.source_property_id ?? null,
          propertyUrl: seed.property_url ?? null,
          coverageStatus: seed.coverage_status,
          accessStatus: seed.access_status ?? null,
          lastVerifiedAt: seed.last_verified_at ?? null,
          notes: seed.notes ?? null,
          active: seed.active ?? true
        });
        if (result.inserted) {
          summary.coverageInserted += 1;
        } else {
          summary.coverageUpdated += 1;
        }
        summary.countBySource[seed.source] = (summary.countBySource[seed.source] ?? 0) + 1;
        summary.countByCoverageStatus[seed.coverage_status] =
          (summary.countByCoverageStatus[seed.coverage_status] ?? 0) + 1;
      });

      return summary;
    });
  } finally {
    if (ownsDb) {
      closeDatabase(db);
    }
  }
}

export function readRawSourceCoverageSeed(path: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid source coverage seed file ${path}: ${error.message}`);
    }
    throw error;
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid source coverage seed file ${path}: expected a JSON array`);
  }
  return parsed;
}

function findPropertyByName(db: LocalDatabase, propertyName: string): ExistingIdRow | undefined {
  return db.prepare("SELECT id FROM properties WHERE name = ? AND postal_code = '990-2301'").get(propertyName) as
    | ExistingIdRow
    | undefined;
}

function insertMinimalProperty(
  db: LocalDatabase,
  propertyId: string,
  propertyName: string,
  seed: PropertySourceCoverageSeedRecord
): void {
  db.prepare(
    `INSERT INTO properties (
      id, name, postal_code, area_name, property_type, price_segment, meal_style, has_onsen, ski_access, active, notes
    )
    VALUES (
      @id, @name, '990-2301', 'Zao Onsen', 'unknown', 'unknown', 'unknown', NULL, 'unknown', 1, @notes
    )`
  ).run({
    id: propertyId,
    name: propertyName,
    notes:
      seed.notes ??
      "Inserted from source coverage seed; property metadata still requires manual verification."
  });
}

function deterministicPropertyId(propertyName: string): string {
  return `property_9902301_${createHash("sha1").update(propertyName).digest("hex").slice(0, 12)}`;
}

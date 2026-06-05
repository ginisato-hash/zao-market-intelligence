import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction, type LocalDatabase } from "../db/client";
import { resolveCanonicalPropertyNameDetailed } from "../services/propertyAliasResolver";
import { createId } from "../utils/ids";
import { readPropertyAliasSeed } from "./importPropertyAliases";
import {
  jalanVerifiedPropertySeedFileSchema,
  type JalanVerifiedPropertySeedRecord
} from "./jalanVerifiedPropertySeedSchema";

export const DEFAULT_JALAN_VERIFIED_SEED_PATH = "data/seeds/jalan_verified_properties.990-2301.sample.json";

export interface ImportJalanVerifiedPropertiesOptions {
  db?: LocalDatabase;
  seedPath?: string;
  aliasSeedPath?: string;
}

export interface ImportJalanVerifiedPropertiesSummary {
  propertiesInserted: number;
  propertiesUpdated: number;
  otaLinksInserted: number;
  otaLinksUpdated: number;
  confirmedCount: number;
  needsReviewCount: number;
  rejectedCount: number;
  aliasResolvedCount: number;
  ambiguousAliasSkippedCount: number;
  aliasResolutions: Array<{ inputName: string; canonicalName: string }>;
}

interface ExistingIdRow {
  id: string;
}

export function importJalanVerifiedProperties(
  options: ImportJalanVerifiedPropertiesOptions = {}
): ImportJalanVerifiedPropertiesSummary {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openLocalDatabase();
  try {
    executeMigration(db);
    const seedPath = options.seedPath ?? process.env.JALAN_VERIFIED_SEED ?? DEFAULT_JALAN_VERIFIED_SEED_PATH;
    const seeds = readJalanVerifiedSeed(seedPath);
    const aliases = readPropertyAliasSeed(options.aliasSeedPath);

    return runInTransaction(db, () => {
      const summary: ImportJalanVerifiedPropertiesSummary = {
        propertiesInserted: 0,
        propertiesUpdated: 0,
        otaLinksInserted: 0,
        otaLinksUpdated: 0,
        confirmedCount: 0,
        needsReviewCount: 0,
        rejectedCount: 0,
        aliasResolvedCount: 0,
        ambiguousAliasSkippedCount: 0,
        aliasResolutions: []
      };

      for (const seed of seeds) {
        const aliasResolution = resolveCanonicalPropertyNameDetailed(seed.property_name, aliases);
        if (aliasResolution.status === "ambiguous") {
          summary.needsReviewCount += 1;
          summary.ambiguousAliasSkippedCount += 1;
          continue;
        }

        const resolvedSeed = {
          ...seed,
          property_name: aliasResolution.canonicalName
        };
        if (aliasResolution.status === "resolved") {
          summary.aliasResolvedCount += 1;
          summary.aliasResolutions.push({
            inputName: aliasResolution.inputName,
            canonicalName: aliasResolution.canonicalName
          });
        }

        if (seed.verification_status === "confirmed") {
          summary.confirmedCount += 1;
        } else if (seed.verification_status === "needs_review") {
          summary.needsReviewCount += 1;
        } else {
          summary.rejectedCount += 1;
        }

        const property = findPropertyByName(db, resolvedSeed.property_name);
        const propertyId = property?.id ?? deterministicPropertyId(resolvedSeed.property_name);
        if (property === undefined) {
          insertMinimalProperty(db, propertyId, resolvedSeed);
          summary.propertiesInserted += 1;
        } else {
          touchProperty(db, property.id);
          summary.propertiesUpdated += 1;
        }

        const existingLink = findJalanLink(db, propertyId);
        if (existingLink === undefined) {
          insertJalanLink(db, propertyId, resolvedSeed);
          summary.otaLinksInserted += 1;
        } else {
          updateJalanLink(db, existingLink.id, resolvedSeed);
          summary.otaLinksUpdated += 1;
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

export function readJalanVerifiedSeed(path: string): JalanVerifiedPropertySeedRecord[] {
  try {
    return jalanVerifiedPropertySeedFileSchema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid Jalan verified seed file ${path}: ${error.message}`);
    }
    throw error;
  }
}

function findPropertyByName(db: LocalDatabase, propertyName: string): ExistingIdRow | undefined {
  return db.prepare("SELECT id FROM properties WHERE name = ? AND postal_code = '990-2301'").get(propertyName) as
    | ExistingIdRow
    | undefined;
}

function findJalanLink(db: LocalDatabase, propertyId: string): ExistingIdRow | undefined {
  return db.prepare("SELECT id FROM property_ota_links WHERE property_id = ? AND ota = 'jalan'").get(propertyId) as
    | ExistingIdRow
    | undefined;
}

function insertMinimalProperty(db: LocalDatabase, propertyId: string, seed: JalanVerifiedPropertySeedRecord): void {
  db.prepare(
    `INSERT INTO properties (
      id, name, postal_code, area_name, property_type, price_segment, meal_style, has_onsen, ski_access, active, notes
    )
    VALUES (
      @id, @name, '990-2301', 'Zao Onsen', 'unknown', 'unknown', 'unknown', NULL, 'unknown', 1, @notes
    )`
  ).run({
    id: propertyId,
    name: seed.property_name,
    notes: seed.notes ?? "Inserted from Jalan verified URL seed; property metadata still requires manual verification."
  });
}

function touchProperty(db: LocalDatabase, propertyId: string): void {
  db.prepare("UPDATE properties SET updated_at = datetime('now') WHERE id = ?").run(propertyId);
}

function insertJalanLink(db: LocalDatabase, propertyId: string, seed: JalanVerifiedPropertySeedRecord): void {
  db.prepare(
    `INSERT INTO property_ota_links (
      id, property_id, ota, url, property_url, active, last_verified_at, notes
    )
    VALUES (
      @id, @propertyId, 'jalan', @url, @propertyUrl, @active, @lastVerifiedAt, @notes
    )`
  ).run(jalanLinkParams(createId("ota_link"), propertyId, seed));
}

function updateJalanLink(db: LocalDatabase, linkId: string, seed: JalanVerifiedPropertySeedRecord): void {
  db.prepare(
    `UPDATE property_ota_links
     SET url = @url,
         property_url = @propertyUrl,
         active = @active,
         last_verified_at = @lastVerifiedAt,
         notes = @notes,
         updated_at = datetime('now')
     WHERE id = @id`
  ).run(jalanLinkParams(linkId, "", seed));
}

function jalanLinkParams(id: string, propertyId: string, seed: JalanVerifiedPropertySeedRecord): Record<string, unknown> {
  return {
    id,
    propertyId,
    url: seed.property_url,
    propertyUrl: seed.property_url,
    active: seed.verification_status === "confirmed" ? 1 : 0,
    lastVerifiedAt: seed.verified_at ?? null,
    notes: [
      `verification_status=${seed.verification_status}`,
      `verification_method=${seed.verification_method}`,
      seed.notes
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join("; ")
  };
}

function deterministicPropertyId(propertyName: string): string {
  return `property_9902301_${createHash("sha1").update(propertyName).digest("hex").slice(0, 12)}`;
}

if (process.argv[1]?.endsWith("importJalanVerifiedProperties.ts")) {
  const summary = importJalanVerifiedProperties();
  console.log(`properties_inserted=${summary.propertiesInserted}`);
  console.log(`properties_updated=${summary.propertiesUpdated}`);
  console.log(`ota_links_inserted=${summary.otaLinksInserted}`);
  console.log(`ota_links_updated=${summary.otaLinksUpdated}`);
  console.log(`confirmed_count=${summary.confirmedCount}`);
  console.log(`needs_review_count=${summary.needsReviewCount}`);
  console.log(`rejected_count=${summary.rejectedCount}`);
  console.log(`alias_resolved_count=${summary.aliasResolvedCount}`);
  for (const resolution of summary.aliasResolutions) {
    console.log(`alias_resolved input_name="${resolution.inputName}" canonical_name="${resolution.canonicalName}"`);
  }
  console.log(`ambiguous_alias_skipped_count=${summary.ambiguousAliasSkippedCount}`);
}

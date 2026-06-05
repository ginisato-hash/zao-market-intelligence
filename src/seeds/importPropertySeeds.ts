import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LocalDatabase } from "../db/client";
import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction } from "../db/client";
import { createId } from "../utils/ids";
import {
  propertyOtaLinkSeedFileSchema,
  propertySeedFileSchema,
  type PropertyOtaLinkSeedRecord,
  type PropertySeedRecord
} from "./propertySeedSchema";

export const DEFAULT_PROPERTY_SEED_PATH = "data/seeds/properties.990-2301.sample.json";
export const DEFAULT_OTA_LINK_SEED_PATH = "data/seeds/property_ota_links.990-2301.sample.json";

export interface ImportPropertySeedsOptions {
  db?: LocalDatabase;
  propertySeedPath?: string;
  otaLinkSeedPath?: string;
}

export interface ImportPropertySeedsSummary {
  propertiesInserted: number;
  propertiesUpdated: number;
  otaLinksInserted: number;
  otaLinksUpdated: number;
  skippedRecords: number;
}

interface ExistingPropertyRow {
  id: string;
}

interface ExistingLinkRow {
  id: string;
}

export function importPropertySeeds(options: ImportPropertySeedsOptions = {}): ImportPropertySeedsSummary {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openLocalDatabase();

  try {
    executeMigration(db);

    const propertySeeds = readJsonSeed(options.propertySeedPath ?? DEFAULT_PROPERTY_SEED_PATH, propertySeedFileSchema);
    const otaLinkSeeds = readJsonSeed(options.otaLinkSeedPath ?? DEFAULT_OTA_LINK_SEED_PATH, propertyOtaLinkSeedFileSchema);

    return runInTransaction(db, () => {
      const summary: ImportPropertySeedsSummary = {
        propertiesInserted: 0,
        propertiesUpdated: 0,
        otaLinksInserted: 0,
        otaLinksUpdated: 0,
        skippedRecords: 0
      };

      for (const seed of propertySeeds) {
        const existing = findProperty(db, seed);
        if (existing === undefined) {
          insertProperty(db, seed);
          summary.propertiesInserted += 1;
        } else {
          updateProperty(db, existing.id, seed);
          summary.propertiesUpdated += 1;
        }
      }

      for (const seed of otaLinkSeeds) {
        const propertyId = findPropertyIdByName(db, seed.property_name);
        if (propertyId === undefined) {
          summary.skippedRecords += 1;
          continue;
        }

        const existing = findOtaLink(db, propertyId, seed.ota);
        if (existing === undefined) {
          insertOtaLink(db, propertyId, seed);
          summary.otaLinksInserted += 1;
        } else {
          updateOtaLink(db, existing.id, seed);
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

function readJsonSeed<T>(path: string, schema: { parse(value: unknown): T }): T {
  try {
    return schema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid seed file ${path}: ${error.message}`);
    }
    throw error;
  }
}

function findProperty(db: LocalDatabase, seed: PropertySeedRecord): ExistingPropertyRow | undefined {
  if (seed.property_id !== undefined) {
    return db.prepare("SELECT id FROM properties WHERE id = ?").get(seed.property_id) as ExistingPropertyRow | undefined;
  }

  return db
    .prepare("SELECT id FROM properties WHERE name = ? AND postal_code = ?")
    .get(seed.property_name, seed.postal_code) as ExistingPropertyRow | undefined;
}

function findPropertyIdByName(db: LocalDatabase, propertyName: string): string | undefined {
  const row = db.prepare("SELECT id FROM properties WHERE name = ?").get(propertyName) as ExistingPropertyRow | undefined;
  return row?.id;
}

function findOtaLink(db: LocalDatabase, propertyId: string, ota: string): ExistingLinkRow | undefined {
  return db
    .prepare("SELECT id FROM property_ota_links WHERE property_id = ? AND ota = ?")
    .get(propertyId, ota) as ExistingLinkRow | undefined;
}

function insertProperty(db: LocalDatabase, seed: PropertySeedRecord): void {
  db.prepare(
    `INSERT INTO properties (
      id,
      name,
      postal_code,
      area_name,
      address,
      lat,
      lng,
      property_type,
      price_segment,
      meal_style,
      has_onsen,
      ski_access,
      room_count_estimate,
      max_capacity_estimate,
      active,
      notes
    )
    VALUES (
      @id,
      @name,
      @postalCode,
      @areaName,
      @address,
      @lat,
      @lng,
      @propertyType,
      @priceSegment,
      @mealStyle,
      @hasOnsen,
      @skiAccess,
      @roomCountEstimate,
      @maxCapacityEstimate,
      @active,
      @notes
    )`
  ).run(propertyParams(seed));
}

function updateProperty(db: LocalDatabase, id: string, seed: PropertySeedRecord): void {
  db.prepare(
    `UPDATE properties
     SET name = @name,
         postal_code = @postalCode,
         area_name = @areaName,
         address = @address,
         lat = @lat,
         lng = @lng,
         property_type = @propertyType,
         price_segment = @priceSegment,
         meal_style = @mealStyle,
         has_onsen = @hasOnsen,
         ski_access = @skiAccess,
         room_count_estimate = @roomCountEstimate,
         max_capacity_estimate = @maxCapacityEstimate,
         active = @active,
         notes = @notes,
         updated_at = datetime('now')
     WHERE id = @id`
  ).run({ ...propertyParams(seed), id });
}

function insertOtaLink(db: LocalDatabase, propertyId: string, seed: PropertyOtaLinkSeedRecord): void {
  db.prepare(
    `INSERT INTO property_ota_links (
      id,
      property_id,
      ota,
      ota_property_id,
      url,
      property_url,
      active,
      last_verified_at,
      notes
    )
    VALUES (
      @id,
      @propertyId,
      @ota,
      @otaPropertyId,
      @url,
      @propertyUrl,
      @active,
      @lastVerifiedAt,
      @notes
    )`
  ).run(otaLinkParams(propertyId, seed));
}

function updateOtaLink(db: LocalDatabase, id: string, seed: PropertyOtaLinkSeedRecord): void {
  db.prepare(
    `UPDATE property_ota_links
     SET ota_property_id = @otaPropertyId,
         url = @url,
         property_url = @propertyUrl,
         active = @active,
         last_verified_at = @lastVerifiedAt,
         notes = @notes,
         updated_at = datetime('now')
     WHERE id = @id`
  ).run({ ...otaLinkParams("", seed), id });
}

function propertyParams(seed: PropertySeedRecord): Record<string, unknown> {
  return {
    id: seed.property_id ?? deterministicPropertyId(seed.property_name),
    name: seed.property_name,
    postalCode: seed.postal_code,
    areaName: "Zao Onsen",
    address: seed.address ?? null,
    lat: seed.lat ?? null,
    lng: seed.lng ?? null,
    propertyType: seed.property_type,
    priceSegment: seed.price_segment,
    mealStyle: seed.meal_style,
    hasOnsen: seed.has_onsen === null ? null : Number(seed.has_onsen),
    skiAccess: seed.ski_access,
    roomCountEstimate: seed.room_count_estimate ?? null,
    maxCapacityEstimate: seed.max_capacity_estimate ?? null,
    active: Number(seed.active),
    notes: seed.notes ?? null
  };
}

function otaLinkParams(propertyId: string, seed: PropertyOtaLinkSeedRecord): Record<string, unknown> {
  const propertyUrl = seed.property_url ?? null;

  return {
    id: createId("ota_link"),
    propertyId,
    ota: seed.ota,
    otaPropertyId: seed.ota_property_id ?? null,
    url: propertyUrl ?? "",
    propertyUrl,
    active: Number(seed.active),
    lastVerifiedAt: seed.last_verified_at ?? null,
    notes: seed.notes ?? null
  };
}

function deterministicPropertyId(propertyName: string): string {
  return `property_9902301_${createHash("sha1").update(propertyName).digest("hex").slice(0, 12)}`;
}

if (process.argv[1]?.endsWith("importPropertySeeds.ts")) {
  const summary = importPropertySeeds();
  console.log(`properties_inserted=${summary.propertiesInserted}`);
  console.log(`properties_updated=${summary.propertiesUpdated}`);
  console.log(`ota_links_inserted=${summary.otaLinksInserted}`);
  console.log(`ota_links_updated=${summary.otaLinksUpdated}`);
  console.log(`skipped_records=${summary.skippedRecords}`);
}

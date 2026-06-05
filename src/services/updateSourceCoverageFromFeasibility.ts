import { createHash } from "node:crypto";
import type { LocalDatabase } from "../db/client";
import { upsertPropertySourceCoverage } from "../db/repositories/propertySourceCoverageRepository";
import { readPropertyAliasSeed } from "../seeds/importPropertyAliases";
import { resolveCanonicalPropertyNameDetailed } from "./propertyAliasResolver";
import {
  buildCoverageUpdateFromFeasibility,
  type SourceFeasibilityResult,
  type SourceFeasibilityStatus
} from "./sourceFeasibilityResult";

export interface UpdateSourceCoverageOptions {
  /**
   * Optional alias seed path. Only consulted when an exact property-name match
   * fails, so the common case (probe targets an already-seeded property) stays
   * hermetic and never touches the filesystem.
   */
  aliasSeedPath?: string;
}

export interface UpdateSourceCoverageResult {
  propertyId: string;
  inserted: boolean;
  updated: boolean;
  coverageStatus: SourceFeasibilityStatus;
  active: boolean;
}

interface ExistingIdRow {
  id: string;
}

/**
 * Persist a single feasibility probe result as a property_source_coverage
 * upsert. The property is resolved in this order:
 *   1. result.propertyId, if provided and the row exists;
 *   2. exact canonical-name match (postal 990-2301);
 *   3. alias-resolved canonical-name match (only if step 2 misses);
 *   4. insert a minimal placeholder property with a deterministic id.
 *
 * This mirrors the importer so probe persistence is order-independent with the
 * Jalan and source-coverage seeds and never creates duplicate physical
 * properties. Prices are never written — feasibility probes record access
 * feasibility only.
 */
export function updateSourceCoverageFromFeasibility(
  db: LocalDatabase,
  result: SourceFeasibilityResult,
  options: UpdateSourceCoverageOptions = {}
): UpdateSourceCoverageResult {
  const propertyId = resolvePropertyId(db, result, options);
  const update = buildCoverageUpdateFromFeasibility(result);

  const outcome = upsertPropertySourceCoverage(db, {
    propertyId,
    source: update.source,
    sourcePropertyId: update.sourcePropertyId,
    propertyUrl: update.propertyUrl,
    coverageStatus: update.coverageStatus,
    accessStatus: update.accessStatus,
    lastVerifiedAt: update.lastVerifiedAt,
    notes: update.notes,
    active: update.active
  });

  return {
    propertyId,
    inserted: outcome.inserted,
    updated: outcome.updated,
    coverageStatus: update.coverageStatus,
    active: update.active
  };
}

function resolvePropertyId(
  db: LocalDatabase,
  result: SourceFeasibilityResult,
  options: UpdateSourceCoverageOptions
): string {
  if (result.propertyId !== undefined) {
    const existing = findPropertyById(db, result.propertyId);
    if (existing !== undefined) {
      return existing.id;
    }
  }

  const exact = findPropertyByName(db, result.propertyName);
  if (exact !== undefined) {
    return exact.id;
  }

  const aliases = readPropertyAliasSeed(options.aliasSeedPath);
  const resolution = resolveCanonicalPropertyNameDetailed(result.propertyName, aliases);
  const canonicalName = resolution.status === "ambiguous" ? result.propertyName : resolution.canonicalName;

  const canonical = findPropertyByName(db, canonicalName);
  if (canonical !== undefined) {
    return canonical.id;
  }

  const propertyId = deterministicPropertyId(canonicalName);
  insertMinimalProperty(db, propertyId, canonicalName);
  return propertyId;
}

function findPropertyById(db: LocalDatabase, id: string): ExistingIdRow | undefined {
  return db.prepare("SELECT id FROM properties WHERE id = ?").get(id) as ExistingIdRow | undefined;
}

function findPropertyByName(db: LocalDatabase, propertyName: string): ExistingIdRow | undefined {
  return db.prepare("SELECT id FROM properties WHERE name = ? AND postal_code = '990-2301'").get(propertyName) as
    | ExistingIdRow
    | undefined;
}

function insertMinimalProperty(db: LocalDatabase, propertyId: string, propertyName: string): void {
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
    notes: "Inserted from feasibility probe; property metadata still requires manual verification."
  });
}

function deterministicPropertyId(propertyName: string): string {
  return `property_9902301_${createHash("sha1").update(propertyName).digest("hex").slice(0, 12)}`;
}

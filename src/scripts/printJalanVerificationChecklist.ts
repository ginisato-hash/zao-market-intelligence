import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  findPossibleDuplicateProperties,
  normalizePropertyName,
  type PropertyAlias
} from "../services/propertyAliasResolver";
import { readPropertyAliasSeed } from "../seeds/importPropertyAliases";
import { propertySeedFileSchema } from "../seeds/propertySeedSchema";
import {
  DEFAULT_JALAN_VERIFIED_SEED_PATH,
  readJalanVerifiedSeed
} from "../seeds/importJalanVerifiedProperties";

const DEFAULT_PROPERTY_SEED_PATH = "data/seeds/properties.990-2301.sample.json";

interface MasterProperty {
  property_name: string;
}

interface DbJalanLinkRow {
  property_name: string;
  property_url: string | null;
  active: number;
  notes: string | null;
}

export interface JalanVerificationChecklist {
  confirmedUrls: Array<{ propertyName: string; propertyUrl: string }>;
  propertiesWithNoJalanUrl: string[];
  propertiesNeedingReview: string[];
  duplicateCandidateNames: string[];
  aliasResolvedDuplicateNames: string[];
  unresolvedDuplicateCandidateNames: string[];
  aliasResolvedCount: number;
  unresolvedDuplicateCandidateCount: number;
}

export function buildJalanVerificationChecklist(options: {
  db?: LocalDatabase;
  propertySeedPath?: string;
  verifiedSeedPath?: string;
  aliasSeedPath?: string;
} = {}): JalanVerificationChecklist {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openLocalDatabase();
  try {
    executeMigration(db);
    const masterProperties = readMasterProperties(options.propertySeedPath ?? DEFAULT_PROPERTY_SEED_PATH);
    const verifiedSeeds = readJalanVerifiedSeed(options.verifiedSeedPath ?? process.env.JALAN_VERIFIED_SEED ?? DEFAULT_JALAN_VERIFIED_SEED_PATH);
    const aliases = readPropertyAliasSeed(options.aliasSeedPath);
    const dbLinks = readDbJalanLinks(db);

    const confirmedUrls = [
      ...verifiedSeeds
        .filter((seed) => seed.verification_status === "confirmed")
        .map((seed) => ({ propertyName: seed.property_name, propertyUrl: seed.property_url })),
      ...dbLinks
        .filter((link) => link.active === 1 && link.property_url !== null)
        .map((link) => ({ propertyName: link.property_name, propertyUrl: link.property_url as string }))
    ].filter(uniquePair);

    const confirmedOrReviewNames = new Set([
      ...verifiedSeeds
        .filter((seed) => seed.verification_status !== "rejected")
        .map((seed) => normalizePropertyName(seed.property_name)),
      ...dbLinks
        .filter((link) => link.property_url !== null)
        .map((link) => normalizePropertyName(link.property_name))
    ]);
    addAliasCoveredNames(confirmedOrReviewNames, aliases as PropertyAlias[]);

    const propertiesWithNoJalanUrl = masterProperties
      .filter((property) => !confirmedOrReviewNames.has(normalizePropertyName(property.property_name)))
      .map((property) => property.property_name);

    const propertiesNeedingReview = verifiedSeeds
      .filter((seed) => seed.verification_status === "needs_review")
      .map((seed) => seed.property_name);

    const duplicateCandidates = findPossibleDuplicateProperties([
      ...masterProperties.map((property) => property.property_name),
      ...verifiedSeeds.map((seed) => seed.property_name),
      ...dbLinks.map((link) => link.property_name)
    ], aliases as PropertyAlias[]);
    const aliasResolvedDuplicateNames = duplicateCandidates
      .filter((candidate) => candidate.status === "alias_resolved")
      .map((candidate) => candidate.names.join(" | "));
    const unresolvedDuplicateCandidateNames = duplicateCandidates
      .filter((candidate) => candidate.status === "unresolved")
      .map((candidate) => candidate.names.join(" | "));

    return {
      confirmedUrls,
      propertiesWithNoJalanUrl,
      propertiesNeedingReview,
      duplicateCandidateNames: [
        ...aliasResolvedDuplicateNames,
        ...unresolvedDuplicateCandidateNames
      ],
      aliasResolvedDuplicateNames,
      unresolvedDuplicateCandidateNames,
      aliasResolvedCount: aliasResolvedDuplicateNames.length,
      unresolvedDuplicateCandidateCount: unresolvedDuplicateCandidateNames.length
    };
  } finally {
    if (ownsDb) {
      closeDatabase(db);
    }
  }
}

export function formatJalanVerificationChecklist(checklist: JalanVerificationChecklist): string {
  return [
    `confirmed_jalan_url_count=${checklist.confirmedUrls.length}`,
    "confirmed_jalan_urls:",
    ...formatList(checklist.confirmedUrls.map((item) => `${item.propertyName} -> ${item.propertyUrl}`)),
    `properties_with_no_jalan_url_count=${checklist.propertiesWithNoJalanUrl.length}`,
    "properties_with_no_jalan_url:",
    ...formatList(checklist.propertiesWithNoJalanUrl),
    `properties_needing_review_count=${checklist.propertiesNeedingReview.length}`,
    "properties_needing_review:",
    ...formatList(checklist.propertiesNeedingReview),
    `duplicate_candidate_names_count=${checklist.duplicateCandidateNames.length}`,
    "duplicate_candidate_names:",
    ...formatList(checklist.duplicateCandidateNames),
    `alias_resolved_count=${checklist.aliasResolvedCount}`,
    "alias_resolved_duplicate_names:",
    ...formatList(checklist.aliasResolvedDuplicateNames),
    `unresolved_duplicate_candidate_count=${checklist.unresolvedDuplicateCandidateCount}`,
    "unresolved_duplicate_candidate_names:",
    ...formatList(checklist.unresolvedDuplicateCandidateNames)
  ].join("\n");
}

function readMasterProperties(path: string): MasterProperty[] {
  const parsed = propertySeedFileSchema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
  return parsed.map((property) => ({ property_name: property.property_name }));
}

function readDbJalanLinks(db: LocalDatabase): DbJalanLinkRow[] {
  return db
    .prepare(
      `SELECT p.name AS property_name,
              pol.property_url AS property_url,
              pol.active AS active,
              pol.notes AS notes
       FROM property_ota_links pol
       JOIN properties p ON p.id = pol.property_id
       WHERE pol.ota = 'jalan'`
    )
    .all() as DbJalanLinkRow[];
}

function uniquePair(item: { propertyName: string; propertyUrl: string }, index: number, array: Array<{ propertyName: string; propertyUrl: string }>): boolean {
  return array.findIndex((candidate) => candidate.propertyUrl === item.propertyUrl) === index;
}

function addAliasCoveredNames(names: Set<string>, aliases: PropertyAlias[]): void {
  for (const record of aliases) {
    if (record.status !== "confirmed") {
      continue;
    }
    const aliasNames = [
      record.canonical_property_name,
      ...record.aliases
    ];
    if (aliasNames.some((name) => names.has(normalizePropertyName(name)))) {
      for (const name of aliasNames) {
        names.add(normalizePropertyName(name));
      }
    }
  }
}

function formatList(items: string[]): string[] {
  return items.length === 0 ? ["  none"] : items.map((item) => `  ${item}`);
}

if (process.argv[1]?.endsWith("printJalanVerificationChecklist.ts")) {
  console.log(formatJalanVerificationChecklist(buildJalanVerificationChecklist()));
}

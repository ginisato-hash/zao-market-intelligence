import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { propertyAliasSeedFileSchema, type PropertyAliasSeedRecord } from "./propertyAliasSeedSchema";

export const DEFAULT_PROPERTY_ALIAS_SEED_PATH = "data/seeds/property_aliases.990-2301.sample.json";

export function readPropertyAliasSeed(path = process.env.PROPERTY_ALIAS_SEED ?? DEFAULT_PROPERTY_ALIAS_SEED_PATH): PropertyAliasSeedRecord[] {
  try {
    return propertyAliasSeedFileSchema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid property alias seed file ${path}: ${error.message}`);
    }
    throw error;
  }
}

if (process.argv[1]?.endsWith("importPropertyAliases.ts")) {
  const aliases = readPropertyAliasSeed();
  const confirmed = aliases.filter((alias) => alias.status === "confirmed").length;
  const needsReview = aliases.filter((alias) => alias.status === "needs_review").length;
  const rejected = aliases.filter((alias) => alias.status === "rejected").length;
  console.log(`alias_records=${aliases.length}`);
  console.log(`confirmed_count=${confirmed}`);
  console.log(`needs_review_count=${needsReview}`);
  console.log(`rejected_count=${rejected}`);
}

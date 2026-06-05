import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildZaoPropertyUniverse, type LocalPropertyExtension } from "../services/buildZaoPropertyUniverse";
import type { ExtractedSourceListing } from "../services/extractZaoSourceListings";
import type { PropertyAlias } from "../services/propertyAliasResolver";

/**
 * Phase 46.6X Deliverable 3 runner — read the latest source listings + alias
 * registry + DB property seed, build the canonical Zao Onsen universe, and write
 * `data/seeds/zao_property_universe.ai-discovered.local.json`.
 */

const LISTINGS_PATH = process.env["ZAO_SOURCE_LISTINGS_FILE"] ?? "data/seeds/zao_source_listings.latest.json";
const ALIASES_PATH = process.env["ZAO_ALIASES_FILE"] ?? "data/seeds/property_aliases.990-2301.sample.json";
const PROPERTIES_PATH = process.env["ZAO_PROPERTIES_FILE"] ?? "data/seeds/properties.990-2301.sample.json";
const LOCAL_EXTENSIONS_PATH =
  process.env["ZAO_LOCAL_EXTENSIONS_FILE"] ?? "data/seeds/zao_local_property_extensions.json";
const OUT_PATH =
  process.env["ZAO_UNIVERSE_FILE"] ?? "data/seeds/zao_property_universe.ai-discovered.local.json";

interface ListingsFile {
  generated_at: string;
  source_pages: unknown[];
  listings: ExtractedSourceListing[];
}

function main(): void {
  const listingsFile = JSON.parse(readFileSync(resolve(LISTINGS_PATH), "utf-8")) as ListingsFile;
  const aliases = JSON.parse(readFileSync(resolve(ALIASES_PATH), "utf-8")) as PropertyAlias[];
  const localExtensions = JSON.parse(readFileSync(resolve(LOCAL_EXTENSIONS_PATH), "utf-8")) as LocalPropertyExtension[];
  const propertyRecords = JSON.parse(readFileSync(resolve(PROPERTIES_PATH), "utf-8")) as Array<{
    property_name?: string;
    name?: string;
    active?: boolean;
  }>;
  const dbNames = propertyRecords
    .map((r) => r.property_name ?? r.name ?? "")
    .filter((n) => n.length > 0);

  const result = buildZaoPropertyUniverse(listingsFile.listings, aliases, dbNames, localExtensions);

  const output = {
    generated_at: new Date().toISOString(),
    source_listings_generated_at: listingsFile.generated_at,
    method:
      "Canonicalized Jalan ∪ Rakuten Zao Onsen listings ∪ local/operator extensions. Mock/test rejected; non-Zao keyword noise filtered out; alias variants merged (confirmed-alias/DB/forced) or flagged needs_review when inferred.",
    stats: result.stats,
    universe: result.universe,
    excluded: result.excluded,
    excluded_audit: result.excludedAudit,
    suspected_duplicates: result.suspectedDuplicates,
    db_diff: result.dbDiff,
    alias_decisions: result.aliasDecisions,
    anchor_checks: result.anchorChecks,
    errors: result.errors
  };

  writeFileSync(resolve(OUT_PATH), JSON.stringify(output, null, 2), "utf-8");

  console.log(`universe_count=${result.stats.universeCount}`);
  console.log(`  canonical=${result.stats.canonicalCount} needs_review=${result.stats.needsReviewCount}`);
  console.log(
    `excluded mock=${result.stats.excludedMock} off_market=${result.stats.excludedOffMarket} ambiguous=${result.stats.excludedAmbiguous}`
  );
  console.log(`suspected_duplicates=${result.suspectedDuplicates.length}`);
  console.log(`anchor_check_missing=${result.anchorChecks.filter((a) => !a.present).length}`);
  console.log(`db_diff in_sources_not_in_db=${result.dbDiff.in_sources_not_in_db.length} in_db_not_in_sources=${result.dbDiff.in_db_not_in_sources.length}`);
  console.log(`errors=${result.errors.length}`);
  for (const e of result.errors) {
    console.log(`  error: ${e}`);
  }
  console.log(`output=${resolve(OUT_PATH)}`);
}

main();

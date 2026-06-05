import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildZaoUniverseReviewPacket,
  loadZaoUniverseReviewPacketInput
} from "../services/buildZaoUniverseReviewPacket";

const OUT_DIR = ".data/exports/zao-universe-review";

function latestPath(prefix: string, suffix: string): string {
  const dir = resolve(OUT_DIR);
  if (!existsSync(dir)) {
    return "";
  }
  const names = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort();
  const latest = names.at(-1);
  return latest ? resolve(dir, latest) : "";
}

function main(): void {
  const packet = buildZaoUniverseReviewPacket(loadZaoUniverseReviewPacketInput());
  const summary = packet.summary;

  console.log(`canonical_property_count=${summary.canonicalPropertyCount}`);
  console.log(`candidate_row_count=${summary.candidateRowCount}`);
  console.log(`alias_map_count=${summary.aliasMapCount}`);
  console.log(`excluded_audit_count=${summary.excludedAuditCount}`);
  console.log(`needs_review_property_count=${summary.needsReviewPropertyCount}`);
  console.log(`candidate_count_by_source=${JSON.stringify(summary.candidateCountBySource)}`);
  console.log(`candidate_found_by_source=${JSON.stringify(summary.candidateFoundBySource)}`);
  console.log(`candidate_missing_by_source=${JSON.stringify(summary.candidateMissingBySource)}`);
  console.log(`latest_markdown_path=${latestPath("zao_universe_review_packet_", ".md")}`);
  console.log(`latest_property_csv_path=${latestPath("zao_universe_properties_", ".csv")}`);
  console.log(`latest_candidate_csv_path=${latestPath("zao_source_candidates_", ".csv")}`);
  console.log(`latest_alias_json_path=${latestPath("zao_alias_map_", ".json")}`);
  console.log(`latest_excluded_csv_path=${latestPath("zao_excluded_audit_", ".csv")}`);
}

main();

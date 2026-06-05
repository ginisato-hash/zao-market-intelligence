import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildZaoUniverseReviewPacket,
  loadZaoUniverseReviewPacketInput,
  renderZaoExcludedAuditCsv,
  renderZaoPropertiesCsv,
  renderZaoSourceCandidatesCsv,
  renderZaoUniverseReviewMarkdown
} from "../services/buildZaoUniverseReviewPacket";

const OUT_DIR = ".data/exports/zao-universe-review";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main(): void {
  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const ts = timestamp();
  const packet = buildZaoUniverseReviewPacket(loadZaoUniverseReviewPacketInput());

  const markdownPath = resolve(OUT_DIR, `zao_universe_review_packet_${ts}.md`);
  const propertyCsvPath = resolve(OUT_DIR, `zao_universe_properties_${ts}.csv`);
  const candidateCsvPath = resolve(OUT_DIR, `zao_source_candidates_${ts}.csv`);
  const aliasJsonPath = resolve(OUT_DIR, `zao_alias_map_${ts}.json`);
  const excludedCsvPath = resolve(OUT_DIR, `zao_excluded_audit_${ts}.csv`);

  writeFileSync(markdownPath, renderZaoUniverseReviewMarkdown(packet), "utf-8");
  writeFileSync(propertyCsvPath, renderZaoPropertiesCsv(packet.propertyRows), "utf-8");
  writeFileSync(candidateCsvPath, renderZaoSourceCandidatesCsv(packet.candidateRows), "utf-8");
  writeFileSync(aliasJsonPath, JSON.stringify(packet.aliasMap, null, 2), "utf-8");
  writeFileSync(excludedCsvPath, renderZaoExcludedAuditCsv(packet.excludedAuditRows), "utf-8");

  console.log(`markdown_path=${markdownPath}`);
  console.log(`property_csv_path=${propertyCsvPath}`);
  console.log(`candidate_csv_path=${candidateCsvPath}`);
  console.log(`alias_json_path=${aliasJsonPath}`);
  console.log(`excluded_csv_path=${excludedCsvPath}`);
  console.log(`canonical_property_count=${packet.summary.canonicalPropertyCount}`);
  console.log(`candidate_row_count=${packet.summary.candidateRowCount}`);
  console.log(`alias_map_count=${packet.summary.aliasMapCount}`);
  console.log(`excluded_audit_count=${packet.summary.excludedAuditCount}`);
  console.log(`candidate_found_by_source=${JSON.stringify(packet.summary.candidateFoundBySource)}`);
  console.log(`candidate_missing_by_source=${JSON.stringify(packet.summary.candidateMissingBySource)}`);
}

main();

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_TEMPLATE_PATH =
  "data/seeds/source_coverage_candidates.990-2301.first5.template.json";

export interface TemplateRow {
  property_name: string;
  source: string;
  candidate_property_url: string | null;
  candidate_source_property_id: string | null;
  verification_status: string;
  [key: string]: unknown;
}

export interface TemplateInspection {
  templateRowsCount: number;
  countBySource: Record<string, number>;
  countByProperty: Record<string, number>;
  allRowsCandidate: boolean;
  noVerifiedUrls: boolean;
  noVerifiedSourceIds: boolean;
}

export function buildTemplateInspection(rows: TemplateRow[]): TemplateInspection {
  const countBySource: Record<string, number> = {};
  const countByProperty: Record<string, number> = {};
  let allRowsCandidate = true;
  let noVerifiedUrls = true;
  let noVerifiedSourceIds = true;

  for (const row of rows) {
    countBySource[row.source] = (countBySource[row.source] ?? 0) + 1;
    countByProperty[row.property_name] = (countByProperty[row.property_name] ?? 0) + 1;
    if (row.verification_status !== "candidate") allRowsCandidate = false;
    if (row.candidate_property_url !== null) noVerifiedUrls = false;
    if (row.candidate_source_property_id !== null && String(row.candidate_source_property_id).trim() !== "")
      noVerifiedSourceIds = false;
  }

  return {
    templateRowsCount: rows.length,
    countBySource,
    countByProperty,
    allRowsCandidate,
    noVerifiedUrls,
    noVerifiedSourceIds
  };
}

export function formatTemplateInspection(inspection: TemplateInspection): string {
  const lines = [
    `template_rows_count=${inspection.templateRowsCount}`,
    `count_by_source=${JSON.stringify(inspection.countBySource)}`,
    `count_by_property=${JSON.stringify(inspection.countByProperty)}`,
    `all_rows_candidate=${inspection.allRowsCandidate}`,
    `no_verified_urls=${inspection.noVerifiedUrls}`,
    `no_verified_source_ids=${inspection.noVerifiedSourceIds}`
  ];
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("inspectSourceVerificationTemplates.ts")) {
  const filePath = process.argv[2] ?? DEFAULT_TEMPLATE_PATH;
  const raw = JSON.parse(readFileSync(resolve(filePath), "utf-8")) as TemplateRow[];
  console.log(formatTemplateInspection(buildTemplateInspection(raw)));
}

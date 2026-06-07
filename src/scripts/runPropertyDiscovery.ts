// AUTO-RUNNER-DISCOVERY01 runner: dry-run property discovery only.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPropertyDiscoveryResult,
  renderDiscoveryCsv,
  renderDiscoveryJson,
  renderDiscoveryMarkdown
} from "../services/propertyDiscovery";

const REPORT_DIR = ".data/reports/property-discovery";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstNow(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function run(): void {
  const ts = timestamp();
  const runId = `property_discovery_${ts}`;
  const generatedAtJst = jstNow();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  const result = buildPropertyDiscoveryResult({ runId, generatedAtJst });
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);

  writeFileSync(reportPath, renderDiscoveryMarkdown(result), "utf8");
  writeFileSync(csvPath, renderDiscoveryCsv(result.rows), "utf8");
  writeFileSync(jsonPath, renderDiscoveryJson(result), "utf8");

  console.log(`decision=${result.decision}`);
  console.log(`mode=${result.mode}`);
  console.log(`total_candidates=${result.summary.total_candidates}`);
  console.log(`classification_counts=${JSON.stringify(result.summary.classification_counts)}`);
  console.log(`recommended_action_counts=${JSON.stringify(result.summary.recommended_action_counts)}`);
  console.log(`history_modified=${result.summary.safety_confirmation.history_modified}`);
  console.log(`db_synced=${result.summary.safety_confirmation.db_synced}`);
  console.log(`property_master_written=${result.summary.safety_confirmation.property_master_written}`);
  console.log(`collector_target_updated=${result.summary.safety_confirmation.collector_target_updated}`);
  console.log(`report_path=${reportPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`json_path=${jsonPath}`);
}

run();

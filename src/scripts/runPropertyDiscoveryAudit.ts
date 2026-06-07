// AUTO-RUNNER-DISCOVERY03 runner: property discovery audit pack only.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildPropertyDiscoveryAuditPack,
  parseReviewPackJson,
  renderPropertyDiscoveryAuditCsv,
  renderPropertyDiscoveryAuditJson,
  renderPropertyDiscoveryAuditMarkdown,
  selectLatestReviewPackArtifact
} from "../services/propertyDiscoveryAudit";

const INPUT_DIR = ".data/reports/property-discovery-review";
const REPORT_DIR = ".data/reports/property-discovery-audit";

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

function explicitInputArg(argv: readonly string[]): string | undefined {
  const idx = argv.indexOf("--input");
  if (idx >= 0) return argv[idx + 1];
  const withEquals = argv.find((a) => a.startsWith("--input="));
  return withEquals?.slice("--input=".length);
}

function findInputPath(): string {
  const explicit = explicitInputArg(process.argv.slice(2));
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error("property_discovery_review_pack_missing_run_discover_properties_review_pack_first");
    return path;
  }

  const dir = resolve(INPUT_DIR);
  if (!existsSync(dir)) throw new Error("property_discovery_review_pack_missing_run_discover_properties_review_pack_first");
  const paths = readdirSync(dir)
    .filter((name) => /^property_discovery_review_\d{8}_\d{6}\.json$/u.test(name))
    .map((name) => resolve(join(INPUT_DIR, name)));
  return selectLatestReviewPackArtifact(paths);
}

function run(): void {
  const inputPath = findInputPath();
  const reviewPack = parseReviewPackJson(readFileSync(inputPath, "utf8"));
  const ts = timestamp();
  const runId = `property_discovery_audit_${ts}`;
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  const pack = buildPropertyDiscoveryAuditPack({
    runId,
    generatedAtJst: jstNow(),
    inputReviewPackArtifactPath: inputPath,
    reviewPack
  });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  writeFileSync(reportPath, renderPropertyDiscoveryAuditMarkdown(pack), "utf8");
  writeFileSync(csvPath, renderPropertyDiscoveryAuditCsv(pack.rows), "utf8");
  writeFileSync(jsonPath, renderPropertyDiscoveryAuditJson(pack), "utf8");

  console.log(`decision=${pack.decision}`);
  console.log(`mode=${pack.mode}`);
  console.log(`input_review_pack_artifact_path=${inputPath}`);
  console.log(`total_candidates=${pack.summary.total_candidates}`);
  console.log(`audit_group_counts=${JSON.stringify(pack.summary.audit_group_counts)}`);
  console.log(`recommended_human_action_counts=${JSON.stringify(pack.summary.recommended_human_action_counts)}`);
  console.log(`approval_risk_counts=${JSON.stringify(pack.summary.approval_risk_counts)}`);
  console.log(`collector_mapping_difficulty_counts=${JSON.stringify(pack.summary.collector_mapping_difficulty_counts)}`);
  console.log(`d05_blocker_counts=${JSON.stringify(pack.summary.d05_blocker_counts)}`);
  console.log(`d05_ready=${pack.summary.d05_ready}`);
  console.log(`d05_reason=${pack.summary.d05_reason}`);
  console.log(`property_master_written=${pack.summary.safety_confirmation.property_master_written}`);
  console.log(`collector_target_updated=${pack.summary.safety_confirmation.collector_target_updated}`);
  console.log(`report_path=${reportPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`json_path=${jsonPath}`);
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

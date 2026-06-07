// AUTO-RUNNER-DISCOVERY02 runner: human review decision pack only.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  buildDiscoveryReviewPack,
  parseDiscoveryRowsFromCsv,
  parseDiscoveryRowsFromJson,
  renderDiscoveryReviewCsv,
  renderDiscoveryReviewJson,
  renderDiscoveryReviewMarkdown,
  selectLatestDiscoveryArtifact
} from "../services/propertyDiscoveryReview";

const INPUT_DIR = ".data/reports/property-discovery";
const REPORT_DIR = ".data/reports/property-discovery-review";

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
    if (!existsSync(path)) throw new Error("property_discovery_input_missing");
    return path;
  }
  const dir = resolve(INPUT_DIR);
  if (!existsSync(dir)) throw new Error("property_discovery_input_missing");
  const paths = readdirSync(dir)
    .filter((name) => /^property_discovery_\d{8}_\d{6}\.(json|csv)$/u.test(name))
    .map((name) => resolve(join(INPUT_DIR, name)));
  return selectLatestDiscoveryArtifact(paths);
}

function run(): void {
  const inputPath = findInputPath();
  const input = readFileSync(inputPath, "utf8");
  const ext = extname(inputPath).toLowerCase();
  const rows = ext === ".json" ? parseDiscoveryRowsFromJson(input) : parseDiscoveryRowsFromCsv(input);

  const ts = timestamp();
  const runId = `property_discovery_review_${ts}`;
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const pack = buildDiscoveryReviewPack({
    runId,
    generatedAtJst: jstNow(),
    inputArtifactPath: inputPath,
    rows
  });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  writeFileSync(reportPath, renderDiscoveryReviewMarkdown(pack), "utf8");
  writeFileSync(csvPath, renderDiscoveryReviewCsv(pack.rows), "utf8");
  writeFileSync(jsonPath, renderDiscoveryReviewJson(pack), "utf8");

  console.log(`decision=${pack.decision}`);
  console.log(`mode=${pack.mode}`);
  console.log(`input_artifact_path=${inputPath}`);
  console.log(`total_candidates=${pack.summary.total_candidates}`);
  console.log(`suggested_decision_counts=${JSON.stringify(pack.summary.suggested_decision_counts)}`);
  console.log(`collector_readiness_counts=${JSON.stringify(pack.summary.collector_readiness_counts)}`);
  console.log(`high_priority_review_count=${pack.summary.high_priority_review_count}`);
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

// Phase AUTO02X — build DB schema + AI-readable views design artifacts.
//
// Reads local artifacts and writes design/debug outputs only. Does not execute
// SQL, create migrations, open the DB, mutate history/property exports, run
// collectors, fetch external pages, or activate workflows.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildDbAiViewsSchemaDesign,
  renderDbAiViewsSchemaCsv,
  renderDbAiViewsSchemaReport,
  renderSchemaDraftSql,
  renderViewsDraftSql
} from "../services/dbAiViewsSchemaDesign";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/db-ai-views-schema-design";
const HISTORY_DIR = ".data/history";

const AUTO01X_JSON = ".data/reports/automation/automated_db_ai_retrieval_plan_20260603_214830.json";
const AI_MANIFEST_JSON = ".data/reports/market-update/ai_readable_market_manifest_latest.json";
const DATA_DICTIONARY_JSON = ".data/reports/market-update/market_data_dictionary_latest.json";
const DB_ARTIFACTS = [
  "src/db/schema.ts",
  "src/db/client.ts",
  "src/db/migrate.ts",
  "src/db/migrations/001_initial_schema.sql",
  "src/db/migrations/002_add_price_quality_flags.sql",
  "src/db/migrations/003_add_pricing_recommendations.sql",
  "src/db/migrations/004_add_source_coverage_candidates.sql"
] as const;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function historySummary(): { files: string[]; rowCount: number; headers: string[] } {
  const files = readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort();
  let rowCount = 0;
  let headers: string[] = [];
  for (const file of files) {
    const text = readFileSync(resolve(HISTORY_DIR, file), "utf8");
    const lines = text.trim().split(/\r?\n/).filter((line) => line !== "");
    if (lines.length > 0 && headers.length === 0) headers = splitCsvLine(lines[0]!);
    rowCount += Math.max(0, lines.length - 1);
  }
  return { files, rowCount, headers };
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (inQuotes && ch === "\"" && next === "\"") {
      cell += "\"";
      i++;
    } else if (ch === "\"") {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  result.push(cell);
  return result;
}

function readExisting(path: string): { path: string; exists: boolean; bytes: number } {
  const full = resolve(path);
  if (!existsSync(full)) return { path, exists: false, bytes: 0 };
  return { path, exists: true, bytes: readFileSync(full, "utf8").length };
}

function main(): void {
  const ts = timestamp();
  const runId = `db_ai_views_schema_design_${ts}`;
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const schemaDraftSqlPath = resolve(debugPath, "schema_draft.sql");
  const viewsDraftSqlPath = resolve(debugPath, "views_draft.sql");
  const history = historySummary();
  const sourceArtifactReads = [AUTO01X_JSON, AI_MANIFEST_JSON, DATA_DICTIONARY_JSON].map(readExisting);
  const dbArtifactReads = DB_ARTIFACTS.map(readExisting);
  const packageJson = readFileSync(resolve("package.json"), "utf8");

  const design = buildDbAiViewsSchemaDesign({
    runId,
    generatedAtJst: jstIso(),
    schemaDraftSqlPath,
    viewsDraftSqlPath,
    historyFileCount: history.files.length,
    historyHeaderCount: history.headers.length,
    dbArtifactCount: dbArtifactReads.filter((f) => f.exists).length
  });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);
  writeFileSync(reportPath, renderDbAiViewsSchemaReport(design), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(design, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderDbAiViewsSchemaCsv(design), "utf8");
  writeFileSync(schemaDraftSqlPath, renderSchemaDraftSql(design), "utf8");
  writeFileSync(viewsDraftSqlPath, renderViewsDraftSql(design), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_artifacts_used.json", {
    AUTO01X_JSON,
    AI_MANIFEST_JSON,
    DATA_DICTIONARY_JSON,
    HISTORY_DIR,
    DB_ARTIFACTS
  });
  writeDebug("history_schema_headers.json", history);
  writeDebug("existing_db_artifacts_inspected.json", dbArtifactReads);
  writeDebug("package_script_presence.json", {
    hasAutomatedPlanScript: packageJson.includes("plan:automated-db-ai-retrieval"),
    hasDbVerifyScript: packageJson.includes("db:verify")
  });
  writeDebug("source_artifact_reads.json", sourceArtifactReads);
  writeDebug("draft_sql_paths.json", design.draft_sql_paths);
  writeDebug("safety_confirmation.json", design.safety_confirmation);

  console.log(`decision=${design.decision}`);
  console.log(`table_count=${design.table_designs.length}`);
  console.log(`view_count=${design.view_designs.length}`);
  console.log(`query_recipe_count=${design.query_recipes.length}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
  console.log(`schema_draft_sql=${schemaDraftSqlPath}`);
  console.log(`views_draft_sql=${viewsDraftSqlPath}`);
}

main();

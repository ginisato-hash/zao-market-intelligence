// Phase AI-READ02X — build market data dictionary / schema documentation.
//
// Reads local artifacts and writes documentation outputs only. Does not mutate
// history shards, property master exports, DB, workflows, or pricing logic.

import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMarketDataDictionary,
  parseCsvTable,
  renderMarketDataDictionaryCsv,
  renderMarketDataDictionaryMarkdown
} from "../services/marketDataDictionary";

const REPORT_DIR = ".data/reports/market-update";
const DEBUG_ROOT = ".data/debug/market-data-dictionary";

const MANIFEST_JSON = ".data/reports/market-update/ai_readable_market_manifest_latest.json";
const MANIFEST_MD = ".data/reports/market-update/ai_readable_market_manifest_latest.md";
const HISTORY_SAMPLE = ".data/history/zao_signals_2026_06.csv";
const DEMAND_CSV = ".data/reports/market-update/zao_demand_index_design_20260603_200932.csv";
const DEMAND_JSON = ".data/reports/market-update/zao_demand_index_design_20260603_200932.json";
const UNIVERSE_CSV = ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv";
const SOURCE_CANDIDATES_CSV = ".data/exports/zao-universe-review/zao_source_candidates_20260531_231933.csv";
const SOURCE_CANDIDATES_MULTI_CSV = ".data/exports/zao-universe-review/zao_source_candidates_multi_source_enriched_20260601_074617.csv";
const ALIAS_MAP_JSON = ".data/exports/zao-universe-review/zao_alias_map_20260531_231933.json";
const EXCLUDED_AUDIT_CSV = ".data/exports/zao-universe-review/zao_excluded_audit_20260531_231933.csv";

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

function main(): void {
  const ts = timestamp();
  const runId = `market_data_dictionary_${ts}`;
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const manifestJson = readFileSync(resolve(MANIFEST_JSON), "utf8");
  const manifestMd = readFileSync(resolve(MANIFEST_MD), "utf8");
  const history = parseCsvTable(readFileSync(resolve(HISTORY_SAMPLE), "utf8"));
  const demand = parseCsvTable(readFileSync(resolve(DEMAND_CSV), "utf8"));
  const universe = parseCsvTable(readFileSync(resolve(UNIVERSE_CSV), "utf8"));
  const sourceCandidates = parseCsvTable(readFileSync(resolve(SOURCE_CANDIDATES_CSV), "utf8"));
  const sourceCandidatesMulti = parseCsvTable(readFileSync(resolve(SOURCE_CANDIDATES_MULTI_CSV), "utf8"));
  const excludedAudit = parseCsvTable(readFileSync(resolve(EXCLUDED_AUDIT_CSV), "utf8"));
  const demandJson = readFileSync(resolve(DEMAND_JSON), "utf8");
  const aliasMapJson = readFileSync(resolve(ALIAS_MAP_JSON), "utf8");

  const dictionary = buildMarketDataDictionary({
    runId,
    generatedAtJst: jstIso(),
    historyHeaders: history.headers,
    demandHeaders: demand.headers,
    propertyUniverseHeaders: universe.headers,
    sourceCandidateHeaders: sourceCandidates.headers,
    excludedAuditHeaders: excludedAudit.headers
  });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);
  const latestMarkdownPath = resolve(reportDir, "market_data_dictionary_latest.md");
  const latestJsonPath = resolve(reportDir, "market_data_dictionary_latest.json");

  writeFileSync(reportPath, renderMarketDataDictionaryMarkdown(dictionary), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(dictionary, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderMarketDataDictionaryCsv(dictionary), "utf8");
  copyFileSync(reportPath, latestMarkdownPath);
  copyFileSync(jsonPath, latestJsonPath);

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("input_artifacts_used.json", {
    MANIFEST_JSON,
    MANIFEST_MD,
    HISTORY_SAMPLE,
    DEMAND_CSV,
    DEMAND_JSON,
    UNIVERSE_CSV,
    SOURCE_CANDIDATES_CSV,
    SOURCE_CANDIDATES_MULTI_CSV,
    ALIAS_MAP_JSON,
    EXCLUDED_AUDIT_CSV
  });
  writeDebug("input_header_summary.json", {
    historyHeaders: history.headers,
    demandHeaders: demand.headers,
    universeHeaders: universe.headers,
    sourceCandidateHeaders: sourceCandidates.headers,
    sourceCandidateMultiHeaders: sourceCandidatesMulti.headers,
    excludedAuditHeaders: excludedAudit.headers,
    manifestBytes: manifestJson.length + manifestMd.length,
    demandJsonBytes: demandJson.length,
    aliasMapBytes: aliasMapJson.length
  });
  writeDebug("latest_pointer_status.json", {
    latestMarkdownPath,
    latestJsonPath,
    latestMarkdownIsSymlink: lstatSync(latestMarkdownPath).isSymbolicLink(),
    latestJsonIsSymlink: lstatSync(latestJsonPath).isSymbolicLink()
  });
  writeDebug("safety_confirmation.json", dictionary.safety_confirmation);

  console.log(`decision=${dictionary.decision}`);
  console.log(`history_schema_columns=${dictionary.schemas.history_shard.length}`);
  console.log(`demand_schema_columns=${dictionary.schemas.demand_index.length}`);
  console.log(`property_universe_schema_columns=${dictionary.schemas.property_universe.length}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`latest_markdown_path=${latestMarkdownPath}`);
  console.log(`latest_json_path=${latestJsonPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

main();

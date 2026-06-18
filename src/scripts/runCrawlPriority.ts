// Phase ZMI CRAWL-PRIORITY01 — adaptive fetch prioritization runner.
//
// Read-only: reads canonical history, derives a rule-based per-checkin-date crawl
// priority, and writes artifacts under .data/crawl-priority/. No collection,
// append, DB write/sync, AI context, publish, or pricing/PMS output.
//   --check  validates the previously written artifacts.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildPriceChanges,
  dedupeObservations,
  parseHistoryForPriceHistory
} from "../services/priceHistorySignals";
import {
  buildCrawlPriority,
  buildCrawlPriorityValidation,
  buildMarketBookingCurve,
  renderCrawlPriorityCsv,
  type CrawlPriorityValidation
} from "../services/marketIntelligenceSignals";

const HISTORY_DIR = ".data/history";
const OUT_DIR = ".data/crawl-priority";
export const CRAWL_PRIORITY_FILES = { targets: "crawl_priority_targets.csv", validation: "crawl_priority_validation.json" } as const;

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function readHistoryFiles(): { filename: string; content: string }[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR).filter((f) => /^zao_signals_.*\.csv$/u.test(f)).sort().map((f) => ({ filename: f, content: readFileSync(join(HISTORY_DIR, f), "utf8") }));
}

const REQUIRED_KEYS: (keyof CrawlPriorityValidation)[] = [
  "run_at", "crawl_priority_rows", "high_priority_count", "medium_priority_count", "low_priority_count",
  "max_priority_score", "min_priority_score", "decision", "warnings"
];

function runCheck(): void {
  const path = resolve(OUT_DIR, CRAWL_PRIORITY_FILES.validation);
  if (!existsSync(path)) {
    console.error("decision=crawl_priority_failed");
    console.error("reason=validation_json_missing (run build:crawl-priority first)");
    process.exitCode = 1;
    return;
  }
  const v = JSON.parse(readFileSync(path, "utf8")) as CrawlPriorityValidation;
  const missing = REQUIRED_KEYS.filter((k) => !(k in v));
  const okDecision = v.decision === "crawl_priority_ready" || v.decision === "crawl_priority_ready_with_warnings";
  const ok = missing.length === 0 && okDecision;
  console.log(`decision=${v.decision}`);
  console.log(`validation_keys_complete=${missing.length === 0}`);
  if (missing.length > 0) console.log(`missing_keys=${missing.join(",")}`);
  console.log(`crawl_priority_rows=${v.crawl_priority_rows}`);
  console.log(`validate:crawl-priority=${ok ? "passed" : "failed"}`);
  if (!ok) process.exitCode = 1;
}

function run(): void {
  if (process.argv.includes("--check")) { runCheck(); return; }
  const files = readHistoryFiles();
  const parsed = parseHistoryForPriceHistory(files);
  const changes = buildPriceChanges(dedupeObservations(parsed.rows).rows);
  const curve = buildMarketBookingCurve(parsed.rows, changes);
  const targets = buildCrawlPriority({ rows: parsed.rows, curve, changes, runDateIso: todayJst() });
  const validation = buildCrawlPriorityValidation({ runAt: jstNow(), rows: targets, inputHistoryRows: parsed.totalRawRows });

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const targetsPath = resolve(OUT_DIR, CRAWL_PRIORITY_FILES.targets);
  const validationPath = resolve(OUT_DIR, CRAWL_PRIORITY_FILES.validation);
  writeFileSync(targetsPath, renderCrawlPriorityCsv(targets), "utf8");
  writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf8");

  console.log(`decision=${validation.decision}`);
  console.log(`crawl_priority_rows=${targets.length}`);
  console.log(`high_priority_count=${validation.high_priority_count}`);
  console.log(`medium_priority_count=${validation.medium_priority_count}`);
  console.log(`low_priority_count=${validation.low_priority_count}`);
  console.log(`max_priority_score=${validation.max_priority_score}`);
  console.log(`targets_path=${targetsPath}`);
  console.log(`validation_path=${validationPath}`);
  for (const w of validation.warnings) console.log(`warning=${w}`);
}

run();

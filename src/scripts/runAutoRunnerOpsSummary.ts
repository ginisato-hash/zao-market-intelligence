// Phase AUTO-RUNNER13X - operations summary runner (read-only).
//
// Gathers read-only evidence only: git HEAD/status, `launchctl print` for job
// inspection, read-only history/DB/AI-context counts, and the latest
// market-refresh artifact. It runs no collectors, appends no history, syncs no
// DB, refreshes no AI context, installs/modifies no launchd job, and emits no
// pricing/PMS output.

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EXPECTED_BASELINE_ROW_COUNT,
  EXPECTED_LAUNCHD_JOBS,
  FORBIDDEN_LAUNCHD_JOB,
  buildOpsSummaryResult,
  renderOpsSummaryReport,
  type LatestRunEvidence,
  type OpsCounts,
  type OpsSummaryInput,
  type RunTrigger
} from "../services/autoRunnerOpsSummary";

const HISTORY_DIR = ".data/history";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const AI_CONTEXT_PATH = ".data/ai-context/latest_market_snapshot.json";
const AUTOMATION_DIR = ".data/reports/automation";
const REPORT_DIR = ".data/reports/ops-summary";
const LIVE_LOG = ".logs/market-refresh-live.out.log";

function jstNow(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Read-only git helpers.
function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

// Read-only job inspection via `launchctl print`. We never start/load/unload jobs.
function launchdJobPresent(label: string): boolean {
  const uid = process.getuid ? process.getuid() : 501;
  const r = spawnSync("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
  return r.status === 0;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function readCounts(): OpsCounts {
  let history = 0;
  const ids = new Map<string, number>();
  const sources: Record<string, number> = {};
  if (existsSync(HISTORY_DIR)) {
    for (const f of readdirSync(HISTORY_DIR).filter((n) => /^zao_signals_.*\.csv$/u.test(n))) {
      const lines = readFileSync(join(HISTORY_DIR, f), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
      const headers = parseCsvLine(lines[0] ?? "");
      const rowIdIdx = headers.indexOf("row_id");
      const sourceIdx = headers.indexOf("source");
      for (const line of lines.slice(1)) {
        const cells = parseCsvLine(line);
        history += 1;
        const id = cells[rowIdIdx] ?? "";
        ids.set(id, (ids.get(id) ?? 0) + 1);
        const src = cells[sourceIdx] ?? "unknown";
        sources[src] = (sources[src] ?? 0) + 1;
      }
    }
  }
  let dbRows = 0;
  if (existsSync(DB_PATH)) {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try { dbRows = (db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get() as { c: number }).c; }
    finally { db.close(); }
  }
  let aiRows = 0;
  if (existsSync(AI_CONTEXT_PATH)) {
    aiRows = (JSON.parse(readFileSync(AI_CONTEXT_PATH, "utf8")) as { market_signal_history_row_count?: number }).market_signal_history_row_count ?? 0;
  }
  return {
    history_rows: history,
    db_rows: dbRows,
    ai_context_rows: aiRows,
    booking: sources["booking"] ?? 0,
    jalan: sources["jalan"] ?? 0,
    rakuten: sources["rakuten"] ?? 0,
    duplicate_row_id_count: [...ids.values()].filter((n) => n > 1).length
  };
}

function latestMarketRefreshArtifact(): string | null {
  if (!existsSync(AUTOMATION_DIR)) return null;
  const matches = readdirSync(AUTOMATION_DIR)
    .filter((n) => n.startsWith("auto_runner_market_refresh_") && n.endsWith(".json"))
    .sort();
  return matches.length > 0 ? resolve(AUTOMATION_DIR, matches[matches.length - 1]!) : null;
}

// Heuristic: a market-refresh-live run whose newest out.log run started in the
// 09:00 hour JST is treated as a scheduled fire; anything else is a manual
// trigger. Best-effort only — used for status, never to gate safety.
function detectTrigger(artifactGeneratedAtJst: string): RunTrigger {
  if (artifactGeneratedAtJst === "") return "none";
  const hour = Number(artifactGeneratedAtJst.slice(11, 13));
  return hour === 9 ? "scheduled" : "manual_kickstart";
}

function readLatestRun(): { evidence: LatestRunEvidence; scheduledObserved: boolean } {
  const path = latestMarketRefreshArtifact();
  if (path === null) {
    return {
      evidence: { artifact_timestamp: "", artifact_path: "", trigger: "none", decision: "none", append_count: 0, skipped_identical_count: 0, intraday_price_change_count: 0, hard_conflict_count: 0, pricing_pms_output_count: 0 },
      scheduledObserved: false
    };
  }
  const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const plan = (j["append_plan"] ?? {}) as Record<string, any>;
  const safety = (j["safety_confirmation"] ?? {}) as Record<string, boolean>;
  const generatedAt = String(j["generated_at_jst"] ?? "");
  const trigger = detectTrigger(generatedAt);
  const pricingPms = (safety["pricing_csv_generated"] ? 1 : 0) + (safety["pms_output_generated"] ? 1 : 0);
  // Scheduled-run observed only if the live job log shows a 09:00-hour run.
  const scheduledObserved = liveLogHasNineOClockRun();
  return {
    evidence: {
      artifact_timestamp: generatedAt,
      artifact_path: path,
      trigger,
      decision: String(j["decision"] ?? "unknown"),
      append_count: Number(plan["new_row_count"] ?? 0),
      skipped_identical_count: Number(plan["skipped_identical_rows"] ?? 0),
      intraday_price_change_count: Array.isArray(plan["intraday_rows"]) ? plan["intraday_rows"].length : 0,
      hard_conflict_count: Array.isArray(plan["hard_conflicts"]) ? plan["hard_conflicts"].length : 0,
      pricing_pms_output_count: pricingPms
    },
    scheduledObserved
  };
}

function liveLogHasNineOClockRun(): boolean {
  if (!existsSync(LIVE_LOG)) return false;
  // Conservative: only true if a generated artifact line in the log carries a
  // 09:0x JST report timestamp. Absent that, treat as not-yet-observed.
  const text = readFileSync(LIVE_LOG, "utf8");
  return /auto_runner_market_refresh_\d{8}_09[0-5]\d/u.test(text);
}

function runReadonlyKvCommand(script: string): Record<string, string> {
  const r = spawnSync("npm", ["run", script], { cwd: process.cwd(), encoding: "utf8" });
  const out: Record<string, string> = {};
  for (const line of (r.stdout ?? "").split(/\r?\n/u)) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function run(): void {
  const ts = timestamp();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  const counts = readCounts();
  const { evidence, scheduledObserved } = readLatestRun();
  const healthKv = runReadonlyKvCommand("auto-runner:health-check"); // read-only / non-mutating
  const dbUpdateKv = runReadonlyKvCommand("auto-runner:db-update");   // read-only / non-mutating

  const input: OpsSummaryInput = {
    now_jst: jstNow(),
    git_head: git(["log", "-1", "--oneline"]),
    working_tree_clean: git(["status", "--short"]) === "",
    launchd: {
      health_check: launchdJobPresent(EXPECTED_LAUNCHD_JOBS[0]),
      db_update_dry_run: launchdJobPresent(EXPECTED_LAUNCHD_JOBS[1]),
      market_refresh_live: launchdJobPresent(EXPECTED_LAUNCHD_JOBS[2]),
      gated_absent: !launchdJobPresent(FORBIDDEN_LAUNCHD_JOB)
    },
    latest_run: evidence,
    counts,
    baseline_expected: EXPECTED_BASELINE_ROW_COUNT,
    scheduled_run_observed: scheduledObserved,
    health_check_status: healthKv["decision"] ?? "unknown",
    db_update_status: dbUpdateKv["decision"] ?? "unknown"
  };

  const result = buildOpsSummaryResult(input);
  const reportPath = resolve(REPORT_DIR, `ops_summary_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `ops_summary_${ts}.json`);
  writeFileSync(reportPath, renderOpsSummaryReport(input, result), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify({ input, result }, null, 2)}\n`, "utf8");

  console.log(`status=${result.status}`);
  console.log(`baseline_stale=${result.baseline_stale}`);
  console.log(`scheduled_run_observed=${input.scheduled_run_observed}`);
  console.log(`latest_run_trigger=${evidence.trigger}`);
  console.log(`history_rows=${counts.history_rows}`);
  console.log(`db_rows=${counts.db_rows}`);
  console.log(`ai_context_rows=${counts.ai_context_rows}`);
  console.log(`booking=${counts.booking}`);
  console.log(`jalan=${counts.jalan}`);
  console.log(`rakuten=${counts.rakuten}`);
  console.log(`duplicate_row_id=${counts.duplicate_row_id_count}`);
  console.log(`recommended_next_action=${result.recommended_next_action}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
}

run();

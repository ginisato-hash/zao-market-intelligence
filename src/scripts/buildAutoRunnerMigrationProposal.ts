// Phase AUTO-RUNNER01X — Repository / artifact migration plan implementation
// PROPOSAL (report).
//
// PROPOSAL / DESIGN ONLY, read-only orchestrator. Reads the current verified
// system state (git tracked/uncommitted counts, .gitignore contents, .env.example
// presence, latest AUTO-RUNNER00X artifact, history shard row counts, DB mirror
// counts in readonly mode, AI context snapshot), assembles the migration plan, and
// writes a md/json/csv proposal plus debug artifacts.
//
// This script performs NO git operations (no add/commit/push/remote changes),
// creates NO GitHub Actions / launchd / cron file, writes NO history, NO DB rows,
// runs NO live request / browser automation / collector, performs NO DB sync, NO
// AI context refresh, emits NO pricing CSV, NO property-management / channel-manager
// output, and performs NO price update.

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMigrationProposal,
  decideMigration,
  renderMigrationCsv,
  renderMigrationReport,
  type CanonicalDataEntry,
  type CanonicalDataInventory,
  type CurrentRepoState
} from "../services/autoRunnerMigrationProposal";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-migration-proposal";
const AI_CONTEXT_SNAPSHOT = ".data/ai-context/latest_market_snapshot.json";
const GITIGNORE_PATH = ".gitignore";
const ENV_EXAMPLE_PATH = ".env.example";
const AUTO00X_GLOB_PREFIX = "auto_runner_architecture_proposal_";

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

function countHistoryRows(): number {
  const dir = resolve(HISTORY_DIR);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir).filter((n) => /^zao_signals_.*\.csv$/.test(n))) {
    const lines = readFileSync(resolve(dir, name), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    total += Math.max(0, lines.length - 1);
  }
  return total;
}

interface DbCounts {
  total: number;
  booking: number;
  jalan: number;
  rakuten: number;
}

function readDbCounts(): DbCounts {
  // READ-ONLY: open the existing DB in readonly mode; never migrate or write.
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get() as { c: number }).c;
    const bySource = db
      .prepare("SELECT source, COUNT(*) AS c FROM market_signal_history GROUP BY source")
      .all() as Array<{ source: string; c: number }>;
    const get = (src: string): number => bySource.find((r) => r.source === src)?.c ?? 0;
    return { total, booking: get("booking"), jalan: get("jalan"), rakuten: get("rakuten") };
  } finally {
    db.close();
  }
}

function readAiContextRows(): number {
  const path = resolve(AI_CONTEXT_SNAPSHOT);
  if (!existsSync(path)) return 0;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { market_signal_history_row_count?: number };
    return j.market_signal_history_row_count ?? 0;
  } catch {
    return 0;
  }
}

// READ-ONLY git introspection: `git ls-files` and `git status --porcelain` never
// mutate the repository; no add/commit/push/remote operations are performed.
function countTrackedFiles(): number {
  try {
    const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function countUncommittedEntries(): number {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function gitignoreFlags(): { ignoresData: boolean; ignoresSqlite: boolean } {
  const path = resolve(GITIGNORE_PATH);
  if (!existsSync(path)) return { ignoresData: false, ignoresSqlite: false };
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const ignoresData = lines.some((l) => l === ".data" || l === ".data/" || l === ".data/*" || l === "/.data" || l === "/.data/");
  const ignoresSqlite = lines.some((l) => l === "*.sqlite" || l === "*.sqlite*" || l.endsWith(".sqlite"));
  return { ignoresData, ignoresSqlite };
}

function findLatestAuto00xArtifact(): { path: string; present: boolean } {
  const dir = resolve(REPORT_DIR);
  if (!existsSync(dir)) return { path: `${REPORT_DIR}/${AUTO00X_GLOB_PREFIX}*.json`, present: false };
  const matches = readdirSync(dir)
    .filter((n) => n.startsWith(AUTO00X_GLOB_PREFIX) && n.endsWith(".json"))
    .sort();
  const latest = matches[matches.length - 1];
  if (!latest) return { path: `${REPORT_DIR}/${AUTO00X_GLOB_PREFIX}*.json`, present: false };
  return { path: resolve(dir, latest), present: true };
}

function approxSize(path: string): string {
  const abs = resolve(path);
  if (!existsSync(abs)) return "absent";
  try {
    const st = statSync(abs);
    if (st.isDirectory()) {
      // shallow estimate: sum of immediate entries' sizes
      let total = 0;
      for (const name of readdirSync(abs)) {
        try {
          const child = statSync(resolve(abs, name));
          if (child.isFile()) total += child.size;
        } catch {
          // ignore unreadable child
        }
      }
      return formatBytes(total) + "+";
    }
    return formatBytes(st.size);
  } catch {
    return "unknown";
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${n}B`;
}

function buildCanonicalDataEntries(): CanonicalDataEntry[] {
  return [
    {
      path: ".data/history/zao_signals_*.csv",
      kind: "canonical",
      approxSize: "~1.5M",
      isCanonical: true,
      note: "Append-only signal history shards; single source of truth for DB + AI context."
    },
    {
      path: ".data/zao-market-intelligence.sqlite",
      kind: "regenerable",
      approxSize: approxSize(DB_PATH),
      isCanonical: false,
      note: "DB mirror; rebuilt from canonical history via gated sync."
    },
    {
      path: ".data/ai-context/",
      kind: "regenerable",
      approxSize: "~72K",
      isCanonical: false,
      note: "AI context packs; rebuilt from DB mirror."
    },
    {
      path: ".data/reports/automation/",
      kind: "audit_artifact",
      approxSize: "~12M",
      isCanonical: false,
      note: "Verification/audit reports; archive, keep only latest summaries in git."
    },
    {
      path: ".data/debug/",
      kind: "heavy_artifact",
      approxSize: "~418M",
      isCanonical: false,
      note: "Debug dumps (3400+ files); keep out of git."
    },
    {
      path: ".data/screenshots/",
      kind: "heavy_artifact",
      approxSize: "~751M",
      isCanonical: false,
      note: "Collection screenshots; archive externally, keep out of git."
    },
    {
      path: ".data/history/.backup/",
      kind: "heavy_artifact",
      approxSize: "~1.2M",
      isCanonical: false,
      note: "Local pre-append backups; machine-local safety, keep out of git."
    },
    {
      path: ".env",
      kind: "secret",
      approxSize: approxSize(".env"),
      isCanonical: false,
      note: "Secrets; never committed; installed manually on the always-on Mac."
    },
    {
      path: "node_modules/",
      kind: "dependency",
      approxSize: "large",
      isCanonical: false,
      note: "Reinstalled via npm install on the target Mac."
    }
  ];
}

function writeDebug(debugPath: string, name: string, data: unknown): void {
  writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main(): void {
  const ts = timestamp();
  const runId = `auto_runner_migration_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);

  const historyRows = countHistoryRows();
  const dbCounts = readDbCounts();
  const aiContextRows = readAiContextRows();
  const giFlags = gitignoreFlags();
  const auto00x = findLatestAuto00xArtifact();

  const state: CurrentRepoState = {
    trackedFileCount: countTrackedFiles(),
    uncommittedEntryCount: countUncommittedEntries(),
    gitignoreIgnoresDataDir: giFlags.ignoresData,
    gitignoreIgnoresSqlite: giFlags.ignoresSqlite,
    envExamplePresent: existsSync(resolve(ENV_EXAMPLE_PATH)),
    auto00xArtifactPath: auto00x.path,
    auto00xArtifactPresent: auto00x.present
  };

  const inventory: CanonicalDataInventory = {
    historyRows,
    dbRows: dbCounts.total,
    aiContextRows,
    bookingRows: dbCounts.booking,
    jalanRows: dbCounts.jalan,
    rakutenRows: dbCounts.rakuten,
    entries: buildCanonicalDataEntries()
  };

  const proposal = buildMigrationProposal(state, inventory);
  const decision = decideMigration(state, inventory);

  const safetyConfirmation = {
    no_git_add: true,
    no_git_commit: true,
    no_git_push: true,
    no_git_remote_changes: true,
    no_github_actions_file: true,
    no_launchd_or_cron_file: true,
    no_live_collection: true,
    no_playwright: true,
    no_browser_automation: true,
    no_external_fetch: true,
    no_history_mutation: true,
    no_db_write: true,
    no_db_sync: true,
    no_ai_context_refresh: true,
    no_pricing_csv: true,
    no_pms_beds24_airhost_output: true,
    no_price_update: true,
    no_paid_sources: true
  };

  const reportInput = {
    generatedAtJst,
    runId,
    decision,
    sourceAuto00xArtifact: state.auto00xArtifactPath,
    proposal,
    reportPath,
    jsonPath,
    csvPath,
    debugRootPath: debugPath
  };

  const jsonPayload = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    current_repo_state: state,
    canonical_data_inventory: inventory,
    commit_ignore_archive_matrix: proposal.commitIgnoreArchiveMatrix,
    gitignore_recommendations: proposal.gitignoreRecommendations,
    artifact_transfer_plan: proposal.artifactTransferPlan,
    bootstrap_sequence: proposal.bootstrapSequence,
    verification_sequence: proposal.verificationSequence,
    rollback_backup_policy: proposal.rollbackBackupPolicy,
    secret_environment_policy: proposal.secretEnvironmentPolicy,
    future_phase_plan: proposal.futurePhasePlan,
    risks: proposal.risks,
    safety_confirmation: safetyConfirmation,
    next_phase: "AUTO-RUNNER02X (do not start without explicit instruction)"
  };

  writeFileSync(reportPath, renderMigrationReport(reportInput), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderMigrationCsv(proposal.commitIgnoreArchiveMatrix), "utf8");

  writeDebug(debugPath, "git_status_snapshot.json", {
    tracked_file_count: state.trackedFileCount,
    uncommitted_entry_count: state.uncommittedEntryCount,
    gitignore_ignores_data: state.gitignoreIgnoresDataDir,
    gitignore_ignores_sqlite: state.gitignoreIgnoresSqlite
  });
  writeDebug(debugPath, "repo_inventory_summary.json", {
    env_example_present: state.envExamplePresent,
    auto00x_artifact_path: state.auto00xArtifactPath,
    auto00x_artifact_present: state.auto00xArtifactPresent
  });
  writeDebug(debugPath, "canonical_data_inventory.json", inventory);
  writeDebug(debugPath, "commit_ignore_archive_matrix.json", proposal.commitIgnoreArchiveMatrix);
  writeDebug(debugPath, "bootstrap_sequence.json", proposal.bootstrapSequence);
  writeDebug(debugPath, "verification_sequence.json", proposal.verificationSequence);
  writeDebug(debugPath, "future_phase_plan.json", proposal.futurePhasePlan);
  writeDebug(debugPath, "safety_confirmation.json", safetyConfirmation);

  console.log(`decision=${decision}`);
  console.log(`history_rows=${historyRows} db_rows=${dbCounts.total} ai_context_rows=${aiContextRows}`);
  console.log(`booking=${dbCounts.booking} jalan=${dbCounts.jalan} rakuten=${dbCounts.rakuten}`);
  console.log(`tracked_files=${state.trackedFileCount} uncommitted=${state.uncommittedEntryCount}`);
  console.log(`gitignore_ignores_data=${state.gitignoreIgnoresDataDir} gitignore_ignores_sqlite=${state.gitignoreIgnoresSqlite}`);
  console.log(`env_example_present=${state.envExamplePresent} auto00x_present=${state.auto00xArtifactPresent}`);
  console.log(`matrix_entries=${proposal.commitIgnoreArchiveMatrix.length} future_phases=${proposal.futurePhasePlan.length}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

if (process.argv[1]?.endsWith("buildAutoRunnerMigrationProposal.ts")) {
  main();
}

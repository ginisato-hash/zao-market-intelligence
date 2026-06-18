// AUTO-RUNNER-CHATGPT-UPLOAD01 — ChatGPT DB/history upload bundle packager.
//
// Creates a local zip bundle for manual upload to ChatGPT. This script is
// read-only with respect to the SQLite DB and canonical history CSVs. It
// performs no DB writes, no history appends, no collector execution, no DB sync,
// no AI context rebuild, and no pricing/PMS output.

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  buildManifestData,
  decideBundle,
  parseHistoryCsvStats,
  renderManifestMd,
  sha256,
  type CrawlPriorityBundleInfo,
  type MarketCurveBundleInfo,
  type PriceHistoryBundleInfo,
  type SqliteStats
} from "../services/chatGptUploadBundle";
import {
  buildPriceHistorySignals,
  parseHistoryForPriceHistory,
  renderCompetitorPriceChangesCsv,
  renderMarketDailySignalsCsv
} from "../services/priceHistorySignals";
import {
  buildCrawlPriority,
  buildCrawlPriorityValidation,
  buildMarketBookingCurve,
  buildMarketCurveValidation,
  renderCrawlPriorityCsv,
  renderMarketCurveCsv
} from "../services/marketIntelligenceSignals";

const REPO_DIR = resolve(".");
const HISTORY_DIR = join(REPO_DIR, ".data/history");
const SQLITE_PATH = join(REPO_DIR, ".data/zao-market-intelligence.sqlite");
const EXPORT_BASE = join(REPO_DIR, ".data/exports/chatgpt-upload");
const DEFAULT_UPLOAD_DIR = join(homedir(), "Desktop", "ZMI_ChatGPT_Uploads");

function jstNow(): string {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date());
  return `${fmt.replace(" ", "T")}+09:00`;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function gitHead(): string {
  const r = spawnSync("git", ["log", "-1", "--oneline"], { cwd: REPO_DIR, encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

function gitBranch(): string {
  const r = spawnSync("git", ["branch", "--show-current"], { cwd: REPO_DIR, encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

function readSqliteStats(warnings: string[]): SqliteStats | null {
  if (!existsSync(SQLITE_PATH)) { warnings.push("sqlite_missing"); return null; }
  const stat = statSync(SQLITE_PATH);
  const buf = readFileSync(SQLITE_PATH);
  const hash = sha256(buf);
  let rowCount: number | null = null;
  try {
    const db = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get() as { c: number };
      rowCount = row.c;
    } finally {
      db.close();
    }
  } catch {
    warnings.push("sqlite_row_count_unreadable");
  }
  return { included: true, path: "zao-market-intelligence.sqlite", size_bytes: stat.size, row_count: rowCount, sha256: hash };
}

function readHistoryFiles(): { filename: string; content: string }[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter((f) => /^zao_signals_.*\.csv$/u.test(f))
    .sort()
    .map((f) => ({ filename: f, content: readFileSync(join(HISTORY_DIR, f), "utf8") }));
}

function run(): void {
  const ts = timestamp();
  const genAt = jstNow();
  const bundleName = `zmi_chatgpt_upload_${ts}`;
  const zipFilename = `${bundleName}.zip`;
  const uploadDir = process.env["CHATGPT_UPLOAD_OUT_DIR"]
    ? resolve(process.env["CHATGPT_UPLOAD_OUT_DIR"])
    : DEFAULT_UPLOAD_DIR;
  const keepStaging = process.env["CHATGPT_UPLOAD_KEEP_STAGING"] === "1";
  const warnings: string[] = [];

  // 1. Read source data.
  const historyFiles = readHistoryFiles();
  const historyStats = parseHistoryCsvStats(historyFiles);
  if (historyStats.row_count === 0) {
    console.error("decision=chatgpt_upload_bundle_not_ready");
    console.error("reason=no_history_csv");
    process.exitCode = 1;
    return;
  }
  const sqliteStats = readSqliteStats(warnings);

  // 1b. Generate price-history signals fresh from the same history CSVs.
  const phParsed = parseHistoryForPriceHistory(historyFiles);
  const ph = buildPriceHistorySignals(phParsed.rows, {
    runAt: genAt,
    inputSources: historyFiles.map((f) => `history/${f.filename}`),
    totalRawRows: phParsed.totalRawRows,
    observedAtColumnUsed: phParsed.observedAtColumnUsed,
    observedAtConfidence: phParsed.observedAtConfidence
  });
  const priceHistoryInfo: PriceHistoryBundleInfo = {
    included: true,
    directory: "price-history/",
    files: [
      "price-history/competitor_price_changes.csv",
      "price-history/market_daily_price_change_signals.csv",
      "price-history/price_history_validation.json"
    ],
    purpose: ["competitor price change tracking", "sold out transition tracking", "daily market pressure scoring"],
    comparison_pair_count: ph.validation.comparison_pair_count,
    daily_signal_rows: ph.dailySignals.length,
    decision: ph.validation.decision
  };

  // 1c. Market booking curve + adaptive crawl priority (reuse ph.changes).
  const curve = buildMarketBookingCurve(phParsed.rows, ph.changes);
  const curveValidation = buildMarketCurveValidation({ runAt: genAt, inputHistoryRows: phParsed.totalRawRows, curve });
  const todayJst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const priority = buildCrawlPriority({ rows: phParsed.rows, curve, changes: ph.changes, runDateIso: todayJst });
  const priorityValidation = buildCrawlPriorityValidation({ runAt: genAt, rows: priority, inputHistoryRows: phParsed.totalRawRows });
  const marketCurveInfo: MarketCurveBundleInfo = {
    included: true,
    directory: "market-curve/",
    files: ["market-curve/market_booking_curve.csv", "market-curve/market_booking_curve_validation.json"],
    purpose: ["market availability/sold-out booking curve by checkin date", "lead-time market movement tracking"],
    booking_curve_rows: curve.length,
    decision: curveValidation.decision
  };
  const crawlPriorityInfo: CrawlPriorityBundleInfo = {
    included: true,
    directory: "crawl-priority/",
    files: ["crawl-priority/crawl_priority_targets.csv", "crawl-priority/crawl_priority_validation.json"],
    purpose: ["next-crawl checkin-date prioritization", "rule-based fetch ordering by movement and lead time"],
    crawl_priority_rows: priority.length,
    high_priority_count: priorityValidation.high_priority_count,
    decision: priorityValidation.decision
  };

  // 2. Build manifest data.
  const manifestData = buildManifestData({
    generated_at_jst: genAt,
    git_head: gitHead(),
    git_branch: gitBranch(),
    package_filename: zipFilename,
    source_repo_path: REPO_DIR,
    upload_folder_path: uploadDir,
    history: historyStats,
    sqlite: sqliteStats,
    warnings,
    price_history: priceHistoryInfo,
    market_booking_curve: marketCurveInfo,
    crawl_priority: crawlPriorityInfo
  });

  // Check for mismatch and add to warnings if not already there.
  if (sqliteStats !== null && sqliteStats.row_count !== null && sqliteStats.row_count !== historyStats.row_count) {
    if (!manifestData.warnings.includes("sqlite_history_row_count_mismatch")) {
      manifestData.warnings.push(`sqlite_history_row_count_mismatch: sqlite=${sqliteStats.row_count} history=${historyStats.row_count}`);
    }
  }

  // 3. Create staging directory.
  const stagingRoot = join(EXPORT_BASE, "staging", ts);
  const bundleDir = join(stagingRoot, bundleName);
  mkdirSync(join(bundleDir, "history"), { recursive: true });

  // 4. Write manifest files.
  writeFileSync(join(bundleDir, "manifest.md"), renderManifestMd(manifestData), "utf8");
  writeFileSync(join(bundleDir, "manifest.json"), `${JSON.stringify(manifestData, null, 2)}\n`, "utf8");

  // 5. Copy history CSVs.
  for (const { filename, content } of historyFiles) {
    writeFileSync(join(bundleDir, "history", filename), content, "utf8");
  }

  // 5b. Write price-history signal artifacts into the bundle.
  mkdirSync(join(bundleDir, "price-history"), { recursive: true });
  writeFileSync(join(bundleDir, "price-history", "competitor_price_changes.csv"), renderCompetitorPriceChangesCsv(ph.changes), "utf8");
  writeFileSync(join(bundleDir, "price-history", "market_daily_price_change_signals.csv"), renderMarketDailySignalsCsv(ph.dailySignals), "utf8");
  writeFileSync(join(bundleDir, "price-history", "price_history_validation.json"), `${JSON.stringify(ph.validation, null, 2)}\n`, "utf8");

  // 5c. Write market booking curve + crawl priority artifacts into the bundle.
  mkdirSync(join(bundleDir, "market-curve"), { recursive: true });
  writeFileSync(join(bundleDir, "market-curve", "market_booking_curve.csv"), renderMarketCurveCsv(curve), "utf8");
  writeFileSync(join(bundleDir, "market-curve", "market_booking_curve_validation.json"), `${JSON.stringify(curveValidation, null, 2)}\n`, "utf8");
  mkdirSync(join(bundleDir, "crawl-priority"), { recursive: true });
  writeFileSync(join(bundleDir, "crawl-priority", "crawl_priority_targets.csv"), renderCrawlPriorityCsv(priority), "utf8");
  writeFileSync(join(bundleDir, "crawl-priority", "crawl_priority_validation.json"), `${JSON.stringify(priorityValidation, null, 2)}\n`, "utf8");

  // 6. Copy SQLite (if present).
  if (sqliteStats !== null) {
    copyFileSync(SQLITE_PATH, join(bundleDir, "zao-market-intelligence.sqlite"));
  }

  // 7. Zip the bundle.
  mkdirSync(join(EXPORT_BASE), { recursive: true });
  const zipPath = join(EXPORT_BASE, zipFilename);
  const zipResult = spawnSync("/usr/bin/zip", ["-r", zipPath, bundleName], {
    cwd: stagingRoot,
    encoding: "utf8"
  });
  if (zipResult.status !== 0) {
    console.error(`zip failed: ${zipResult.stderr}`);
    process.exitCode = 1;
    return;
  }

  // 8. Create repo-local latest.
  const latestDir = join(EXPORT_BASE, "latest");
  mkdirSync(latestDir, { recursive: true });
  const latestRepoPath = join(latestDir, "zmi_chatgpt_upload_latest.zip");
  copyFileSync(zipPath, latestRepoPath);

  // 9. Create upload-folder copies.
  try {
    mkdirSync(uploadDir, { recursive: true });
  } catch {
    console.error("decision=chatgpt_upload_bundle_not_ready");
    console.error("reason=upload_folder_write_failed");
    process.exitCode = 1;
    return;
  }
  const uploadTimestampedPath = join(uploadDir, zipFilename);
  const uploadLatestPath = join(uploadDir, "zmi_chatgpt_upload_latest.zip");
  copyFileSync(zipPath, uploadTimestampedPath);
  copyFileSync(zipPath, uploadLatestPath);

  // 10. Remove staging unless requested.
  if (!keepStaging) rmSync(stagingRoot, { recursive: true, force: true });

  // 11. Print summary.
  const decision = decideBundle({
    historyRowCount: historyStats.row_count,
    sqlitePresent: sqliteStats !== null,
    sqliteRowCount: sqliteStats?.row_count ?? null,
    warnings: manifestData.warnings
  });

  console.log(`decision=${decision}`);
  console.log(`zip=${zipPath}`);
  console.log(`latest=${latestRepoPath}`);
  console.log(`upload_path=${uploadLatestPath}`);
  console.log(`timestamped_upload_path=${uploadTimestampedPath}`);
  console.log(`history_rows=${historyStats.row_count}`);
  console.log(`sqlite_rows=${sqliteStats?.row_count ?? "missing"}`);
  console.log(`duplicate_row_id=${historyStats.duplicate_row_id_count}`);
  console.log(`source_of_truth=${manifestData.source_of_truth}`);
  console.log(`price_history_included=${manifestData.price_history_signals.included}`);
  console.log(`price_history_decision=${manifestData.price_history_signals.decision}`);
  console.log(`price_history_comparison_pairs=${manifestData.price_history_signals.comparison_pair_count}`);
  console.log(`market_booking_curve_rows=${manifestData.market_booking_curve.booking_curve_rows}`);
  console.log(`crawl_priority_rows=${manifestData.crawl_priority_signals.crawl_priority_rows}`);
  if (manifestData.warnings.length > 0) {
    for (const w of manifestData.warnings) console.log(`warning=${w}`);
  }
}

run();

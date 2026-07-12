// AUTO-RUNNER-CHATGPT-UPLOAD02 — GitHub Release publish driver.
//
// Runs package:chatgpt-db, locates the generated zip, and publishes it to
// a stable GitHub Release (tag: chatgpt-db-latest). Uses gh CLI via spawnSync.
// Read-only with respect to SQLite DB and canonical history. Performs no
// DB writes, no collector execution, no DB sync, no AI context rebuild,
// and no pricing/PMS output.

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ASSET_NAME,
  RELEASE_TAG,
  RELEASE_TITLE,
  buildReleaseBody,
  decidePublish,
  renderPublishSummary,
  type PublishContext
} from "../services/chatGptDbReleasePublisher";

const REPO_DIR = resolve(".");
const DESKTOP_ZIP = resolve(homedir(), "Desktop", "ZMI_ChatGPT_Uploads", ASSET_NAME);
const REPO_LATEST_ZIP = resolve(REPO_DIR, ".data/exports/chatgpt-upload/latest", ASSET_NAME);
const SQLITE_PATH = resolve(REPO_DIR, ".data/zao-market-intelligence.sqlite");
const HISTORY_DIR = resolve(REPO_DIR, ".data/history");
const PUBLISH_MARKER_PATH = resolve(REPO_DIR, ".data/state/last_chatgpt_db_publish.json");

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
// Read by ops:automation-healthcheck's freshness dashboard.
function writePublishMarker(releaseUrl: string, assetUrl: string): void {
  mkdirSync(resolve(REPO_DIR, ".data/state"), { recursive: true });
  writeFileSync(PUBLISH_MARKER_PATH, `${JSON.stringify({ published_at_jst: jstNow(), release_url: releaseUrl, asset_url: assetUrl }, null, 2)}\n`, "utf8");
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { ok: boolean; stdout: string; stderr: string; status: number } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? REPO_DIR, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

function ghInstalled(): boolean {
  return run("which", ["gh"]).ok;
}

function ghAuthenticated(): boolean {
  return run("gh", ["auth", "status"]).ok;
}

function readHistoryRows(): number {
  const r = run("wc", ["-l"], { cwd: HISTORY_DIR });
  // Count lines across all CSVs minus header per file
  let total = 0;
  if (!existsSync(HISTORY_DIR)) return 0;
  const files = spawnSync("ls", [HISTORY_DIR], { encoding: "utf8" }).stdout.split("\n").filter((f) => /^zao_signals_.*\.csv$/u.test(f));
  for (const f of files) {
    const wc = spawnSync("wc", ["-l", `${HISTORY_DIR}/${f}`], { encoding: "utf8" });
    const n = parseInt((wc.stdout ?? "").trim().split(" ")[0] ?? "0", 10);
    if (n > 1) total += n - 1; // subtract header row
  }
  return total;
}

function readLatestCollectedDate(): string | null {
  // Read from SQLite if available (read-only)
  if (!existsSync(SQLITE_PATH)) return null;
  try {
    const db = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT MAX(collected_date_jst) AS d FROM market_signal_history").get() as { d: string | null };
      return row?.d ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function releaseExists(): boolean {
  return run("gh", ["release", "view", RELEASE_TAG]).ok;
}

function run2(): void {
  // 1. Package step
  const pkg = run("npm", ["run", "package:chatgpt-db"]);
  if (!pkg.ok) {
    console.error(`decision=chatgpt_db_publish_not_ready`);
    console.error(`reason=package_step_failed`);
    console.error(pkg.stderr);
    process.exitCode = 1;
    return;
  }

  // 2. Locate latest zip
  const zipPath = existsSync(DESKTOP_ZIP) ? DESKTOP_ZIP : existsSync(REPO_LATEST_ZIP) ? REPO_LATEST_ZIP : "";
  const zipSizeBytes = zipPath.length > 0 && existsSync(zipPath) ? statSync(zipPath).size : 0;

  // 3. Check gh
  const installed = ghInstalled();
  const authenticated = installed && ghAuthenticated();

  // 4. Build context and decide
  const exists = installed && authenticated ? releaseExists() : false;
  const ctx: PublishContext = { ghInstalled: installed, ghAuthenticated: authenticated, zipPath, zipSizeBytes, releaseExists: exists };
  const decision = decidePublish(ctx);

  if (decision === "chatgpt_db_publish_gh_missing") {
    console.error(`decision=${decision}`);
    console.error(`reason=gh_cli_missing_or_not_authenticated`);
    console.error(`install_gh=brew install gh && gh auth login`);
    process.exitCode = 1;
    return;
  }
  if (decision === "chatgpt_db_publish_zip_missing") {
    console.error(`decision=${decision}`);
    console.error(`reason=zip_missing_or_empty: ${zipPath || "(not found)"}`);
    process.exitCode = 1;
    return;
  }

  // 5. Gather metadata for release body
  const historyRows = readHistoryRows();
  const collectedDate = readLatestCollectedDate();
  const releaseBody = buildReleaseBody(historyRows, collectedDate);

  // 6. Create or update release
  if (!exists) {
    const create = run("gh", ["release", "create", RELEASE_TAG, "--title", RELEASE_TITLE, "--notes", releaseBody]);
    if (!create.ok) {
      console.error(`decision=chatgpt_db_publish_not_ready`);
      console.error(`reason=gh_release_create_failed: ${create.stderr}`);
      process.exitCode = 1;
      return;
    }
  } else {
    run("gh", ["release", "edit", RELEASE_TAG, "--title", RELEASE_TITLE, "--notes", releaseBody]);
  }

  // 7. Upload asset with --clobber
  const upload = run("gh", ["release", "upload", RELEASE_TAG, zipPath, "--clobber"]);
  if (!upload.ok) {
    console.error(`decision=chatgpt_db_publish_not_ready`);
    console.error(`reason=gh_release_upload_failed: ${upload.stderr}`);
    process.exitCode = 1;
    return;
  }

  // 8. Fetch release info
  const view = run("gh", ["release", "view", RELEASE_TAG, "--json", "tagName,name,url,assets"]);
  let releaseUrl = "";
  let assetUrl = "";
  if (view.ok) {
    try {
      const data = JSON.parse(view.stdout) as { url: string; assets?: Array<{ name: string; url: string }> };
      releaseUrl = data.url ?? "";
      const found = data.assets?.find((a) => a.name === ASSET_NAME);
      assetUrl = found?.url ?? "";
    } catch { /* ignore parse errors */ }
  }

  // 9. Print summary
  writePublishMarker(releaseUrl, assetUrl);
  console.log(renderPublishSummary(ctx, decision, releaseUrl, assetUrl));
}

run2();

// Phase ZMI AUTOMATION-HEALTHCHECK01 — standing watchdog for the always-on
// Mac launchd automation (market-refresh-rotating / booking-market-recrawl /
// pricing-critical-recrawl / bi-web-publish).
//
// Built after a real 2026-07-12 incident: local collection kept succeeding
// for 7 days while GitHub silently froze, because nothing in the pipeline
// ever committed+pushed its output, and booking-market-recrawl silently
// self-aborted on every scheduled run for the same reason. None of that was
// visible without manually reading launchd + git state. This script makes
// that state observable and (locally) alertable without requiring any
// external credential: it always uses a native macOS notification, and
// OPTIONALLY posts to Slack/Discord if the user provides a webhook URL via
// ZMI_HEALTHCHECK_SLACK_WEBHOOK_URL / ZMI_HEALTHCHECK_DISCORD_WEBHOOK_URL —
// with neither set (the default), no network call is made.
//
// Read-only: no history/DB mutation, no commit/push, no publish.

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPORT_DIR = ".data/reports/automation";
const LOCKS_DIR = ".data/locks";
const SQLITE_PATH = ".data/zao-market-intelligence.sqlite";
const BI_METADATA_PATH = "apps/zmi-bi-web/data/metadata.json";
const BI_PUBLISH_MARKER_PATH = ".data/state/last_bi_web_publish.json";
const CHATGPT_PUBLISH_MARKER_PATH = ".data/state/last_chatgpt_db_publish.json";
const STALE_HOURS = Number(process.env["ZMI_HEALTHCHECK_STALE_HOURS"] ?? "4") || 4;
const STALE_LOCK_HOURS = Number(process.env["ZMI_HEALTHCHECK_STALE_LOCK_HOURS"] ?? "3") || 3;
const ALLOWED_DIRTY_PREFIXES = [".data/history/", "apps/zmi-bi-web/data/"];
const LAUNCHD_JOBS = [
  "com.yuge.zmi.market-refresh-rotating",
  "com.yuge.zmi.booking-market-recrawl",
  "com.yuge.zmi.pricing-critical-recrawl",
  "com.yuge.zmi.bi-web-publish"
] as const;

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function tsId(): string { const d = new Date(); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

interface LaunchdJobStatus {
  label: string;
  loaded: boolean;
  state: string | null;
  last_exit_code: number | null;
  runs: number | null;
}

function checkLaunchdJob(label: string): LaunchdJobStatus {
  const uid = process.getuid?.() ?? 0;
  const r = sh("launchctl", ["print", `gui/${uid}/${label}`]);
  if (!r.ok || /Could not find service/u.test(r.out)) {
    return { label, loaded: false, state: null, last_exit_code: null, runs: null };
  }
  const state = /state = (\S+)/u.exec(r.out)?.[1] ?? null;
  const lastExit = /last exit code = (-?\d+)/u.exec(r.out)?.[1];
  const runs = /runs = (\d+)/u.exec(r.out)?.[1];
  return {
    label,
    loaded: true,
    state,
    last_exit_code: lastExit !== undefined ? Number(lastExit) : null,
    runs: runs !== undefined ? Number(runs) : null
  };
}

function checkStaleLocks(): Array<{ path: string; age_hours: number }> {
  let entries: string[];
  try { entries = readdirSync(LOCKS_DIR); } catch { return []; }
  const now = Date.now();
  const stale: Array<{ path: string; age_hours: number }> = [];
  for (const name of entries) {
    const p = resolve(LOCKS_DIR, name);
    try {
      const ageHours = (now - statSync(p).mtimeMs) / (60 * 60 * 1000);
      if (ageHours > STALE_LOCK_HOURS) stale.push({ path: p, age_hours: Number(ageHours.toFixed(2)) });
    } catch { /* race: file removed between readdir and stat */ }
  }
  return stale;
}

async function notifySlackOrDiscord(message: string): Promise<void> {
  const slack = process.env["ZMI_HEALTHCHECK_SLACK_WEBHOOK_URL"];
  const discord = process.env["ZMI_HEALTHCHECK_DISCORD_WEBHOOK_URL"];
  if (slack) {
    try { await fetch(slack, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: message }) }); }
    catch { /* best-effort; local notification + report file are the source of truth */ }
  }
  if (discord) {
    try { await fetch(discord, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: message }) }); }
    catch { /* best-effort */ }
  }
}

function notifyMac(title: string, message: string): void {
  const esc = (s: string): string => s.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  sh("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`]);
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>; } catch { return null; }
}

// Distinguishes "collection is fine but GitHub is stale" from "GitHub is
// fine but Cloudflare/D1/ChatGPT-DB is stale" — the exact ambiguity that
// made the 2026-07-12 incident hard to see without reading launchd + git by
// hand. Every layer here is read-only: git log (no fetch-dependent ref
// beyond what's already cached from the check above), a read-only sqlite
// open, and two local marker files publishBiWeb.ts / publishChatGptDb.ts
// write on success (wrangler/gh expose no queryable "last publish time").
interface FreshnessLayer { name: string; at_jst: string | null; delay_hours_since_collection: number | null }
interface FreshnessSummary {
  latest_local_collected_at_jst: string | null;
  latest_history_committed_at_jst: string | null;
  latest_github_pushed_at_jst: string | null;
  latest_cloudflare_published_at_jst: string | null;
  latest_d1_synced_at_jst: string | null;
  latest_chatgpt_db_published_at_jst: string | null;
  layers: FreshnessLayer[];
}

function hoursSince(fromIso: string | null, toIso: string | null): number | null {
  if (fromIso === null || toIso === null) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Number(((to - from) / (60 * 60 * 1000)).toFixed(2));
}

function computeFreshnessSummary(): FreshnessSummary {
  const biMeta = readJsonSafe(BI_METADATA_PATH);
  const latestLocalCollectedAtJst = typeof biMeta?.["latest_collected_at_jst"] === "string" && biMeta["latest_collected_at_jst"] !== "" ? (biMeta["latest_collected_at_jst"] as string) : null;

  // Last commit that touched .data/history, converted from git's ISO-8601
  // author date to the same "YYYY-MM-DDTHH:MM:SS+09:00" shape as the other
  // timestamps so hoursSince() can compare them directly.
  const historyCommitIso = sh("git", ["log", "-1", "--format=%aI", "--", ".data/history"]).out.trim();
  const latestHistoryCommittedAtJst = historyCommitIso !== "" ? historyCommitIso : null;
  const historyCommitSha = sh("git", ["log", "-1", "--format=%H", "--", ".data/history"]).out.trim();

  // "Pushed" means that commit is an ancestor of the LOCALLY CACHED
  // origin/main ref (updated by this script's own `git fetch` above, and by
  // ops:auto-commit-push's fetch before every push) — not a fresh network
  // call here, so this stays a fast, read-only check.
  let latestGithubPushedAtJst: string | null = null;
  if (historyCommitSha !== "") {
    const isAncestor = sh("git", ["merge-base", "--is-ancestor", historyCommitSha, "origin/main"]);
    if (isAncestor.ok) latestGithubPushedAtJst = latestHistoryCommittedAtJst;
  }

  const biPublishMarker = readJsonSafe(BI_PUBLISH_MARKER_PATH);
  const latestCloudflarePublishedAtJst = typeof biPublishMarker?.["published_at_jst"] === "string" ? (biPublishMarker["published_at_jst"] as string) : null;

  let latestD1SyncedAtJst: string | null = null;
  if (existsSync(resolve(SQLITE_PATH))) {
    try {
      const db = new Database(resolve(SQLITE_PATH), { readonly: true, fileMustExist: true });
      try {
        const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_signal_sync_runs'").get();
        if (tableExists) {
          const row = db.prepare("SELECT MAX(finished_at) AS finished_at FROM market_signal_sync_runs WHERE status = 'success'").get() as { finished_at: string | null };
          latestD1SyncedAtJst = row?.finished_at ?? null;
        }
      } finally { db.close(); }
    } catch { /* sqlite file missing/locked — leave null, not a crash */ }
  }

  const chatgptMarker = readJsonSafe(CHATGPT_PUBLISH_MARKER_PATH);
  const latestChatgptDbPublishedAtJst = typeof chatgptMarker?.["published_at_jst"] === "string" ? (chatgptMarker["published_at_jst"] as string) : null;

  const layers: FreshnessLayer[] = [
    { name: "local_collection", at_jst: latestLocalCollectedAtJst, delay_hours_since_collection: 0 },
    { name: "history_commit", at_jst: latestHistoryCommittedAtJst, delay_hours_since_collection: hoursSince(latestLocalCollectedAtJst, latestHistoryCommittedAtJst) },
    { name: "github_push", at_jst: latestGithubPushedAtJst, delay_hours_since_collection: hoursSince(latestLocalCollectedAtJst, latestGithubPushedAtJst) },
    { name: "cloudflare_publish", at_jst: latestCloudflarePublishedAtJst, delay_hours_since_collection: hoursSince(latestLocalCollectedAtJst, latestCloudflarePublishedAtJst) },
    { name: "d1_sync", at_jst: latestD1SyncedAtJst, delay_hours_since_collection: hoursSince(latestLocalCollectedAtJst, latestD1SyncedAtJst) },
    { name: "chatgpt_db_publish", at_jst: latestChatgptDbPublishedAtJst, delay_hours_since_collection: hoursSince(latestLocalCollectedAtJst, latestChatgptDbPublishedAtJst) }
  ];

  return {
    latest_local_collected_at_jst: latestLocalCollectedAtJst,
    latest_history_committed_at_jst: latestHistoryCommittedAtJst,
    latest_github_pushed_at_jst: latestGithubPushedAtJst,
    latest_cloudflare_published_at_jst: latestCloudflarePublishedAtJst,
    latest_d1_synced_at_jst: latestD1SyncedAtJst,
    latest_chatgpt_db_published_at_jst: latestChatgptDbPublishedAtJst,
    layers
  };
}

async function main(): Promise<void> {
  const runId = `automation_healthcheck_${tsId()}`;
  const alerts: string[] = [];

  sh("git", ["fetch", "origin", "main"]);
  const lastCommitEpoch = Number(sh("git", ["log", "-1", "--format=%ct"]).out.trim() || "0");
  const lastCommitAgeHours = lastCommitEpoch > 0 ? (Date.now() / 1000 - lastCommitEpoch) / 3600 : null;
  const lastCommitSha = sh("git", ["rev-parse", "--short", "HEAD"]).out.trim();
  const localHead = sh("git", ["rev-parse", "HEAD"]).out.trim();
  const originHead = sh("git", ["rev-parse", "origin/main"]).out.trim();
  const unpushedCount = localHead && originHead && localHead !== originHead
    ? Number(sh("git", ["rev-list", "--count", `origin/main..HEAD`]).out.trim() || "0")
    : 0;

  if (lastCommitAgeHours !== null && lastCommitAgeHours > STALE_HOURS) {
    alerts.push(`last_commit_stale: ${lastCommitAgeHours.toFixed(1)}h since ${lastCommitSha} (threshold ${STALE_HOURS}h)`);
  }
  if (unpushedCount > 0) {
    alerts.push(`unpushed_commits: ${unpushedCount} local commit(s) not on origin/main (push may be failing)`);
  }

  const dirty = sh("git", ["status", "--porcelain"]).out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/u, ""));
  const unexpectedDirty = dirty.filter((p) => !ALLOWED_DIRTY_PREFIXES.some((prefix) => p.startsWith(prefix)));
  if (unexpectedDirty.length > 0) alerts.push(`unexpected_dirty_files: ${unexpectedDirty.join(", ")}`);

  const staleLocks = checkStaleLocks();
  if (staleLocks.length > 0) alerts.push(`stale_lock_files: ${staleLocks.map((l) => `${l.path} (${l.age_hours}h)`).join(", ")}`);

  const jobs = LAUNCHD_JOBS.map(checkLaunchdJob);
  for (const j of jobs) {
    if (!j.loaded) alerts.push(`launchd_job_not_loaded: ${j.label}`);
    else if (j.last_exit_code !== null && j.last_exit_code !== 0) alerts.push(`launchd_job_last_exit_nonzero: ${j.label} exit=${j.last_exit_code}`);
  }

  const freshness = computeFreshnessSummary();

  const healthy = alerts.length === 0;
  const report = {
    run_id: runId,
    generated_at_jst: jstNow(),
    healthy,
    stale_threshold_hours: STALE_HOURS,
    last_commit_sha: lastCommitSha,
    last_commit_age_hours: lastCommitAgeHours !== null ? Number(lastCommitAgeHours.toFixed(2)) : null,
    unpushed_commit_count: unpushedCount,
    unexpected_dirty_files: unexpectedDirty,
    stale_lock_files: staleLocks,
    launchd_jobs: jobs,
    freshness,
    alerts
  };

  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`decision=${healthy ? "automation_healthcheck_ok" : "automation_healthcheck_alert"}`);
  console.log(`last_commit_age_hours=${report.last_commit_age_hours}`);
  console.log(`unpushed_commit_count=${unpushedCount}`);
  console.log(`unexpected_dirty_files_count=${unexpectedDirty.length}`);
  console.log(`stale_lock_files_count=${staleLocks.length}`);
  for (const j of jobs) console.log(`launchd:${j.label} loaded=${j.loaded} state=${j.state} last_exit_code=${j.last_exit_code} runs=${j.runs}`);
  console.log(`latest_local_collected_at_jst=${freshness.latest_local_collected_at_jst}`);
  console.log(`latest_history_committed_at_jst=${freshness.latest_history_committed_at_jst}`);
  console.log(`latest_github_pushed_at_jst=${freshness.latest_github_pushed_at_jst}`);
  console.log(`latest_cloudflare_published_at_jst=${freshness.latest_cloudflare_published_at_jst}`);
  console.log(`latest_d1_synced_at_jst=${freshness.latest_d1_synced_at_jst}`);
  console.log(`latest_chatgpt_db_published_at_jst=${freshness.latest_chatgpt_db_published_at_jst}`);
  for (const layer of freshness.layers) console.log(`freshness_layer:${layer.name} at_jst=${layer.at_jst} delay_hours_since_collection=${layer.delay_hours_since_collection}`);
  console.log(`report_json=${jsonPath}`);

  if (!healthy) {
    const message = alerts.join(" | ");
    console.log(`alerts=${message}`);
    notifyMac("ZMI automation alert", message.length > 200 ? `${message.slice(0, 200)}...` : message);
    await notifySlackOrDiscord(`:rotating_light: ZMI automation healthcheck alert (${jstNow()}):\n${alerts.map((a) => `- ${a}`).join("\n")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

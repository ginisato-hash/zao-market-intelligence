// Phase ZMI AUTO-COMMIT-PUSH01 — closes a real production gap discovered
// 2026-07-12: market-refresh-rotating (every 2h) and pricing-critical-recrawl
// (daily) both append to .data/history / apps/zmi-bi-web/data locally, but
// NEITHER job — nor anything else in the launchd automation — ever ran
// git add/commit/push on that output. That step had only ever happened as a
// side effect of interactive work sessions. Once those stopped
// (2026-07-06 01:06), local changes piled up uncommitted for 7 days: GitHub's
// market DB looked frozen even though local collection never actually
// stopped, and booking-market-recrawl silently self-aborted on every
// scheduled run from 2026-06-23 onward (its own dirty-tree safety guard,
// tripped continuously because the tree was never clean again).
//
// This script is the fix: run it after every rotating cycle. It stages ONLY
// .data/history and apps/zmi-bi-web/data, refuses to run (loud abort, no
// commit) if any OTHER path is dirty or if history shows any deletion
// (append-only violation), and reports clearly whether push succeeded so a
// failure is visible in logs/healthcheck rather than silently swallowed.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ALLOWED_PREFIXES = [".data/history/", "apps/zmi-bi-web/data/"];
const REPORT_DIR = ".data/reports/automation";

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function tsId(): string { const d = new Date(); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

interface CmdResult { ok: boolean; out: string }
function git(args: string[]): CmdResult {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function isAllowed(path: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}
function numstatDeletions(args: string[]): Array<{ path: string; add: number; del: number }> {
  return git(args).out.split("\n").filter(Boolean).map((l) => {
    const [add, del, path] = l.split("\t");
    return { path: path ?? "", add: Number(add ?? 0), del: Number(del ?? 0) };
  }).filter((r) => r.del > 0);
}

function finish(report: Record<string, unknown>): void {
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const jsonPath = resolve(REPORT_DIR, `${report["run_id"]}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`decision=${report["decision"]}`);
  console.log(`report_json=${jsonPath}`);
}

function main(): void {
  const runId = `auto_commit_push_${tsId()}`;
  const report: Record<string, unknown> = { run_id: runId, generated_at_jst: jstNow() };

  const dirty = git(["status", "--porcelain"]).out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/u, ""));
  report.dirty_files = dirty;
  if (dirty.length === 0) { report.decision = "auto_commit_push_noop_clean_tree"; finish(report); return; }

  const forbidden = dirty.filter((p) => !isAllowed(p));
  if (forbidden.length > 0) {
    report.decision = "aborted_unexpected_dirty_files";
    report.forbidden_dirty_files = forbidden;
    finish(report);
    process.exitCode = 1;
    return;
  }

  const unstagedDeletions = numstatDeletions(["diff", "--numstat", "--", ".data/history/"]);
  if (unstagedDeletions.length > 0) {
    report.decision = "aborted_history_deletion_detected";
    report.history_deletions = unstagedDeletions;
    finish(report);
    process.exitCode = 1;
    return;
  }

  git(["add", "--", ".data/history", "apps/zmi-bi-web/data"]);
  const staged = git(["diff", "--cached", "--name-only"]).out.split("\n").map((l) => l.trim()).filter(Boolean);
  report.staged_files = staged;

  const unexpectedStaged = staged.filter((p) => !isAllowed(p));
  const stagedDeletions = numstatDeletions(["diff", "--cached", "--numstat", "--", ".data/history/"]);
  if (unexpectedStaged.length > 0 || stagedDeletions.length > 0) {
    report.decision = unexpectedStaged.length > 0 ? "aborted_unexpected_staged_files" : "aborted_staged_history_deletion_detected";
    report.unexpected_staged_files = unexpectedStaged;
    report.staged_history_deletions = stagedDeletions;
    git(["restore", "--staged", "--", ".data/history", "apps/zmi-bi-web/data"]);
    finish(report);
    process.exitCode = 1;
    return;
  }

  if (staged.length === 0) { report.decision = "auto_commit_push_noop_nothing_staged"; finish(report); return; }

  const historyStat = git(["diff", "--cached", "--stat", "--", ".data/history/"]).out.trim();
  const commit = git(["commit", "-m", `Auto-commit market data (${jstNow()})\n\nAutomated by ops:auto-commit-push (AUTO-COMMIT-PUSH01) after a scheduled\ncollection run appended new observations. Data-only: .data/history + apps/zmi-bi-web/data.\n`]);
  report.commit_ok = commit.ok;
  report.commit_output = commit.out;
  report.history_stat = historyStat;
  if (!commit.ok) { report.decision = "aborted_commit_failed"; finish(report); process.exitCode = 1; return; }

  const push = git(["push", "origin", "main"]);
  report.push_ok = push.ok;
  report.push_output = push.out;
  if (!push.ok) {
    // Commit succeeded locally (data is safe / append-only), but the remote
    // is not updated — surface this loudly rather than swallowing it, so a
    // healthcheck or the next run's operator can see push is failing.
    report.decision = "auto_commit_push_commit_ok_push_failed";
    finish(report);
    process.exitCode = 1;
    return;
  }

  report.decision = "auto_commit_push_success";
  report.commit_sha = git(["rev-parse", "HEAD"]).out.trim();
  finish(report);
}

main();

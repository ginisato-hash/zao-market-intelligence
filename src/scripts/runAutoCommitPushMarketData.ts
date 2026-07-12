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
//
// AUTO-COMMIT-PUSH02 (2026-07-13) concurrency hardening, added after a
// review flagged real gaps in the first version:
//   - a dedicated stale-self-cleaning lock (mirrors
//     runBookingMarketRecrawlPipeline.ts's LOCK_STALE_MS pattern) so two
//     overlapping invocations (e.g. a manual run racing the scheduled one)
//     can never both try to commit/push at once;
//   - fetch + check for unpushed local commits BEFORE looking at the working
//     tree at all — a clean tree with an unpushed commit (commit succeeded
//     last time, push failed) used to look like "nothing to do" and would
//     never retry; now it retries the push immediately, every run, until it
//     succeeds;
//   - fetch + ff-only pull before pushing when origin has moved ahead
//     (another writer, or a manual push) — if that's not a clean
//     fast-forward, abort loudly rather than rebase or force-push;
//   - a short re-check after staging that nothing already-staged changed
//     again mid-run (defense in depth on top of runRealAppend's own
//     lock+atomic-write, which already prevents a torn CSV write).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ALLOWED_PREFIXES = [".data/history/", "apps/zmi-bi-web/data/"];
const REPORT_DIR = ".data/reports/automation";
const LOCK_PATH = ".data/locks/auto_commit_push.lock";
const LOCK_STALE_MS = 30 * 60 * 1000; // 30m — this script should always finish in well under a minute.

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
function porcelainPaths(): string[] {
  return git(["status", "--porcelain"]).out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/u, ""));
}

function finish(report: Record<string, unknown>): void {
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const jsonPath = resolve(REPORT_DIR, `${report["run_id"]}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`decision=${report["decision"]}`);
  console.log(`report_json=${jsonPath}`);
}

// Returns true if a lock is held by another live invocation (caller must
// abort). Cleans up + acquires otherwise. A lock older than LOCK_STALE_MS is
// treated as orphaned (crashed process) and reclaimed rather than blocking
// forever.
function acquireLock(): boolean {
  mkdirSync(resolve(".data/locks"), { recursive: true });
  if (existsSync(LOCK_PATH)) {
    const ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs;
    if (ageMs < LOCK_STALE_MS) return false;
    // Stale — a previous run crashed without cleaning up. Reclaim it.
    rmSync(LOCK_PATH, { force: true });
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started_at_jst: jstNow() }), "utf8");
  return true;
}
function releaseLock(): void {
  rmSync(LOCK_PATH, { force: true });
}
function readLockOwner(): unknown {
  try { return JSON.parse(readFileSync(LOCK_PATH, "utf8")); } catch { return null; }
}

function main(): void {
  const runId = `auto_commit_push_${tsId()}`;
  const report: Record<string, unknown> = { run_id: runId, generated_at_jst: jstNow() };

  if (!acquireLock()) {
    report.decision = "aborted_lock_held_by_other_run";
    report.lock_owner = readLockOwner();
    finish(report);
    process.exitCode = 1;
    return;
  }

  try {
    git(["fetch", "origin", "main"]);

    // Retry a previously-failed push FIRST, before looking at the working
    // tree at all — a clean tree with an unpushed local commit must not be
    // mistaken for "nothing to do".
    const headBefore = git(["rev-parse", "HEAD"]).out.trim();
    const originBefore = git(["rev-parse", "origin/main"]).out.trim();
    if (headBefore !== originBefore) {
      const aheadCount = Number(git(["rev-list", "--count", "origin/main..HEAD"]).out.trim() || "0");
      const behindCount = Number(git(["rev-list", "--count", "HEAD..origin/main"]).out.trim() || "0");
      report.unpushed_commits_at_start = aheadCount;
      report.behind_origin_at_start = behindCount;

      if (behindCount > 0) {
        // Origin moved ahead (another writer, or a manual push). Only ever
        // fast-forward; never rebase or force-push an unattended automation.
        const pull = git(["pull", "--ff-only", "origin", "main"]);
        report.ff_only_pull_ok = pull.ok;
        report.ff_only_pull_output = pull.out;
        if (!pull.ok) {
          report.decision = "aborted_diverged_from_origin_not_fast_forward";
          finish(report);
          process.exitCode = 1;
          return;
        }
      }
      if (aheadCount > 0) {
        const retryPush = git(["push", "origin", "main"]);
        report.retry_push_ok = retryPush.ok;
        report.retry_push_output = retryPush.out;
        if (!retryPush.ok) {
          report.decision = "aborted_retry_push_failed";
          finish(report);
          process.exitCode = 1;
          return;
        }
      }
    }

    const dirty = porcelainPaths();
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

    // Stability check: nothing already-staged should still be changing.
    // runRealAppend's own lock+atomic-write already prevents a torn CSV
    // write; this only catches an unrelated concurrent writer (e.g. a
    // different job invoked outside its normal lock) touching the same
    // path a second time mid-run.
    const restaggered = porcelainPaths().filter((p) => staged.includes(p));
    if (restaggered.length > 0) {
      report.decision = "aborted_concurrent_write_detected";
      report.restaggered_files = restaggered;
      git(["restore", "--staged", "--", ".data/history", "apps/zmi-bi-web/data"]);
      finish(report);
      process.exitCode = 1;
      return;
    }

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
      // Commit succeeded locally (data is safe / append-only), but the
      // remote is not updated — surface this loudly rather than swallowing
      // it. The NEXT invocation's unpushed-commit check at the top of main()
      // will retry this push automatically, even if no new data has been
      // collected in the meantime.
      report.decision = "auto_commit_push_commit_ok_push_failed";
      finish(report);
      process.exitCode = 1;
      return;
    }

    report.decision = "auto_commit_push_success";
    report.commit_sha = git(["rev-parse", "HEAD"]).out.trim();
    finish(report);
  } finally {
    releaseLock();
  }
}

main();

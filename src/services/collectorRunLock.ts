// Phase ZMI-MKT-OBS02 — collector overlap prevention + run deadline. PART B1.
//
// Follows the existing collector contract already used by
// runBookingMarketRecrawlPipeline.ts and runAutoCommitPushMarketData.ts: a
// single lock file under .data/locks/, abandoned-lock reclamation after a
// staleness threshold, and release in a finally block.
//
// Why a lock rather than a launchd setting: launchd has no "do not start if
// the previous invocation is still running" key for calendar-scheduled jobs.
// ThrottleInterval only rate-limits RESPAWNS, and KeepAlive is about
// restarting, not exclusion. With a twice-daily job that makes dozens of
// bounded external requests, an overrun (a slow OTA, a retry storm) could
// otherwise still be running when the next firing starts and double the
// outbound request rate — so exclusion has to be enforced in-process.
//
// The deadline is likewise in-process: macOS ships no GNU `timeout`, so
// wrapping the command in the plist is not portable.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000; // 1h
export const DEFAULT_RUN_TIMEOUT_MS = 45 * 60 * 1000; // 45m

export function isLockStale(ageMs: number, staleMs: number = DEFAULT_LOCK_STALE_MS): boolean {
  return ageMs >= staleMs;
}

export interface LockAcquisition {
  acquired: boolean;
  staleLockReclaimed: boolean;
  heldByAgeMs: number | null;
  ownerRaw: string | null;
}

/**
 * Try to take the lock. When a FRESH lock exists the caller must abort (the
 * previous run is still going). A lock older than staleMs is treated as
 * abandoned by a crashed process and reclaimed rather than blocking forever.
 */
export function acquireCollectorLock(input: {
  lockPath: string;
  runId: string;
  nowMs?: number;
  staleMs?: number;
}): LockAcquisition {
  const nowMs = input.nowMs ?? Date.now();
  const staleMs = input.staleMs ?? DEFAULT_LOCK_STALE_MS;
  mkdirSync(dirname(input.lockPath), { recursive: true });

  let staleLockReclaimed = false;
  if (existsSync(input.lockPath)) {
    const ageMs = nowMs - statSync(input.lockPath).mtimeMs;
    let ownerRaw: string | null = null;
    try {
      ownerRaw = readFileSync(input.lockPath, "utf8");
    } catch {
      ownerRaw = null;
    }
    if (!isLockStale(ageMs, staleMs)) {
      return { acquired: false, staleLockReclaimed: false, heldByAgeMs: ageMs, ownerRaw };
    }
    rmSync(input.lockPath, { force: true });
    staleLockReclaimed = true;
  }
  writeFileSync(input.lockPath, `${JSON.stringify({ runId: input.runId, pid: process.pid, acquiredAtMs: nowMs })}\n`, "utf8");
  return { acquired: true, staleLockReclaimed, heldByAgeMs: null, ownerRaw: null };
}

export function releaseCollectorLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
}

export interface RunDeadline {
  startedAtMs: number;
  timeoutMs: number;
  exceeded: (nowMs?: number) => boolean;
  remainingMs: (nowMs?: number) => number;
}

/**
 * A wall-clock budget checked between units of work, so an overrunning run
 * stops making new external requests instead of colliding with the next
 * scheduled firing. Checked cooperatively (never a hard kill mid-request, which
 * would leave a page open and lose the observation already fetched).
 */
export function createRunDeadline(input: { startedAtMs?: number; timeoutMs?: number } = {}): RunDeadline {
  const startedAtMs = input.startedAtMs ?? Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  return {
    startedAtMs,
    timeoutMs,
    exceeded: (nowMs?: number) => (nowMs ?? Date.now()) - startedAtMs >= timeoutMs,
    remainingMs: (nowMs?: number) => Math.max(0, timeoutMs - ((nowMs ?? Date.now()) - startedAtMs))
  };
}

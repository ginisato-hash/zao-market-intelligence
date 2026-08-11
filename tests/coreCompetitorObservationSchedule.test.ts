// ZMI-MKT-OBS02 PART B1 — production schedule: launchd contract, overlap
// prevention, and run deadline.

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCK_STALE_MS,
  acquireCollectorLock,
  createRunDeadline,
  isLockStale,
  releaseCollectorLock
} from "../src/services/collectorRunLock";

const PLIST = readFileSync(
  resolve(__dirname, "../ops/launchd/com.yuge.zmi.core-competitor-observation.plist.template"),
  "utf8"
);
const COLLECTOR = readFileSync(resolve(__dirname, "../src/scripts/runCoreCompetitorRepeatedObservation.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const OPS_DIR = resolve(__dirname, "../ops/launchd");

// Minimal plist reader: pull every <dict> inside StartCalendarInterval.
function parseCalendarIntervals(plist: string): Array<{ hour: number | null; minute: number | null; weekday: number | null }> {
  const block = /<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(plist);
  if (!block) {
    const single = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(plist);
    return single ? [readDict(single[1] ?? "")] : [];
  }
  return [...(block[1] ?? "").matchAll(/<dict>([\s\S]*?)<\/dict>/gu)].map((m) => readDict(m[1] ?? ""));
}
function readDict(dict: string): { hour: number | null; minute: number | null; weekday: number | null } {
  const num = (key: string): number | null => {
    const m = new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`, "u").exec(dict);
    return m ? Number(m[1]) : null;
  };
  return { hour: num("Hour"), minute: num("Minute"), weekday: num("Weekday") };
}

describe("PART B1 — launchd schedule parses to exactly two daily firings", () => {
  it("fires twice a day at 04:50 and 16:50 JST", () => {
    const intervals = parseCalendarIntervals(PLIST);
    expect(intervals).toHaveLength(2);
    expect(intervals).toEqual([
      { hour: 4, minute: 50, weekday: null },
      { hour: 16, minute: 50, weekday: null }
    ]);
  });

  it("the two firings are ~12h apart, so morning/afternoon are a genuine time-separated pair", () => {
    const [am, pm] = parseCalendarIntervals(PLIST);
    const amMin = am!.hour! * 60 + am!.minute!;
    const pmMin = pm!.hour! * 60 + pm!.minute!;
    expect(pmMin - amMin).toBe(12 * 60);
  });

  it("runs every day (no Weekday restriction), so the horizon is covered daily", () => {
    for (const i of parseCalendarIntervals(PLIST)) expect(i.weekday).toBeNull();
  });

  it("does not collide with any other installed ZMI job's minute/hour slot", () => {
    const ours = parseCalendarIntervals(PLIST).map((i) => `${i.hour}:${i.minute}`);
    const others: string[] = [];
    for (const file of ["market-refresh-rotating", "bi-web-publish", "pricing-critical-recrawl", "booking-market-recrawl", "health-check", "db-update-dry-run", "market-refresh-live", "market-refresh-gated"]) {
      const path = join(OPS_DIR, `com.yuge.zmi.${file}.plist.template`);
      if (!existsSync(path)) continue;
      for (const i of parseCalendarIntervals(readFileSync(path, "utf8"))) {
        if (i.hour !== null && i.minute !== null) others.push(`${i.hour}:${i.minute}`);
      }
    }
    expect(others.length).toBeGreaterThan(0);
    for (const slot of ours) expect(others, `slot ${slot} collides`).not.toContain(slot);
  });
});

describe("PART B1 — launchd job contract", () => {
  it("never runs at load and never respawns against an external OTA", () => {
    expect(PLIST).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/u);
    expect(PLIST).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/u);
  });

  it("declares the production working directory, log paths, and an exit grace period", () => {
    expect(PLIST).toContain("<key>WorkingDirectory</key>");
    expect(PLIST).toContain("/Users/gini/Documents/ZMI/zao-market-intelligence");
    expect(PLIST).toContain("<key>StandardOutPath</key>");
    expect(PLIST).toContain("<key>StandardErrorPath</key>");
    expect(PLIST).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>\d+<\/integer>/u);
    expect(PLIST).toContain("<key>ProcessType</key>");
  });

  it("runs the append-mode collector and then the trusted-path committer", () => {
    expect(PLIST).toContain("market-observation:core-competitor:append");
    expect(PLIST).toContain("npm run ops:auto-commit-push");
    // `;` not `&&` — a collector-side failure must not block committing what
    // was already appended before it failed.
    expect(PLIST).toMatch(/core-competitor:append;\s*npm run ops:auto-commit-push/u);
  });

  it("requires both live and append gates explicitly (fail-closed by default)", () => {
    expect(PLIST).toContain("COLLECT_LIVE=1");
    expect(PLIST).toContain("ZMI_APPEND_MARKET_OBSERVATIONS=1");
    expect(COLLECTOR).toContain('process.env["COLLECT_LIVE"] === "1"');
    expect(COLLECTOR).toContain('process.env["ZMI_APPEND_MARKET_OBSERVATIONS"] === "1"');
  });

  it("never writes history, Beds24, PMS, or pricing output from this job", () => {
    // Assert on the COMMAND actually executed, not the whole template: the
    // comments legitimately mention pricing jobs (the slot-collision table)
    // and state what this job must never touch.
    const command = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(PLIST)?.[1] ?? "";
    expect(command).toContain("market-observation:core-competitor:append");
    for (const forbidden of ["beds24", "pricing", "pms", ".data/history", "--force", "publish", "sync:history"]) {
      expect(command.toLowerCase(), `command must not invoke ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("both npm scripts referenced by the job exist", () => {
    expect(PACKAGE_JSON).toContain('"market-observation:core-competitor:append"');
    expect(PACKAGE_JSON).toContain('"ops:auto-commit-push"');
  });
});

describe("PART B1 — overlap prevention", () => {
  const dirs: string[] = [];
  function tempLock(): string {
    const dir = mkdtempSync(join(tmpdir(), "zmi-lock-"));
    dirs.push(dir);
    return join(dir, "locks", "core_competitor_observation.lock");
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a second concurrent run cannot acquire the lock while the first holds it", () => {
    const lockPath = tempLock();
    const first = acquireCollectorLock({ lockPath, runId: "run_a" });
    expect(first.acquired).toBe(true);
    const second = acquireCollectorLock({ lockPath, runId: "run_b" });
    expect(second.acquired).toBe(false);
    expect(second.ownerRaw).toContain("run_a");
  });

  it("releasing the lock lets the next run acquire it", () => {
    const lockPath = tempLock();
    expect(acquireCollectorLock({ lockPath, runId: "run_a" }).acquired).toBe(true);
    releaseCollectorLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
    expect(acquireCollectorLock({ lockPath, runId: "run_b" }).acquired).toBe(true);
  });

  it("an abandoned lock from a crashed run is reclaimed instead of blocking forever", () => {
    const lockPath = tempLock();
    acquireCollectorLock({ lockPath, runId: "crashed" });
    // Backdate the lock past the staleness threshold.
    const old = (Date.now() - DEFAULT_LOCK_STALE_MS - 60_000) / 1000;
    utimesSync(lockPath, old, old);
    const next = acquireCollectorLock({ lockPath, runId: "fresh" });
    expect(next.acquired).toBe(true);
    expect(next.staleLockReclaimed).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toContain("fresh");
  });

  it("staleness threshold is exclusive of fresh locks and inclusive at the boundary", () => {
    expect(isLockStale(0)).toBe(false);
    expect(isLockStale(DEFAULT_LOCK_STALE_MS - 1)).toBe(false);
    expect(isLockStale(DEFAULT_LOCK_STALE_MS)).toBe(true);
  });

  it("a corrupt lock file still blocks a concurrent run (fails closed, not open)", () => {
    const lockPath = tempLock();
    acquireCollectorLock({ lockPath, runId: "run_a" });
    writeFileSync(lockPath, "not json at all", "utf8");
    expect(acquireCollectorLock({ lockPath, runId: "run_b" }).acquired).toBe(false);
  });

  it("the collector aborts (non-zero) rather than proceeding when the lock is held", () => {
    expect(COLLECTOR).toContain("core_competitor_observation_aborted_lock_held");
    expect(COLLECTOR).toMatch(/if\s*\(!lock\.acquired\)\s*\{[\s\S]{0,400}process\.exitCode\s*=\s*1/u);
    expect(COLLECTOR).toMatch(/finally\s*\{\s*releaseCollectorLock\(LOCK_PATH\);/u);
  });
});

describe("PART B1 — run deadline", () => {
  it("is not exceeded before the budget elapses, and is after", () => {
    const d = createRunDeadline({ startedAtMs: 1_000, timeoutMs: 60_000 });
    expect(d.exceeded(1_000)).toBe(false);
    expect(d.exceeded(60_999)).toBe(false);
    expect(d.exceeded(61_000)).toBe(true);
    expect(d.remainingMs(31_000)).toBe(30_000);
    expect(d.remainingMs(999_999)).toBe(0);
  });

  it("the collector checks the deadline BEFORE issuing a new request in both source loops", () => {
    const checks = COLLECTOR.match(/if\s*\(input\.deadline\.exceeded\(\)\)\s*\{\s*deadlineHit\s*=\s*true;\s*break;\s*\}/gu) ?? [];
    expect(checks.length).toBe(2); // one per source (booking, jalan)
    // The check must precede the request counter increment in each loop.
    for (const loop of ["collectBookingObservations", "collectJalanObservations"]) {
      const start = COLLECTOR.indexOf(`async function ${loop}`);
      const body = COLLECTOR.slice(start, start + 2500);
      expect(body.indexOf("deadline.exceeded()"), loop).toBeLessThan(body.indexOf("requestCount += 1"));
    }
  });

  it("records the schedule guards in the persisted run manifest, not only stdout", () => {
    expect(COLLECTOR).toContain("schedule_guards");
    expect(COLLECTOR).toContain("run_deadline_exceeded");
    expect(COLLECTOR).toContain("stale_lock_reclaimed");
  });
});

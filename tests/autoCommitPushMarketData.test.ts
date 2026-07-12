import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoCommitPushMarketData.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");
const ROTATING_PLIST = readFileSync(resolve(__dirname, "../ops/launchd/com.yuge.zmi.market-refresh-rotating.plist.template"), "utf8");

describe("AUTO-COMMIT-PUSH01 safety", () => {
  it("is wired as an npm script", () => {
    expect(PACKAGE_JSON).toContain('"ops:auto-commit-push"');
    expect(PACKAGE_JSON).toContain("runAutoCommitPushMarketData.ts");
  });

  it("only ever stages .data/history and apps/zmi-bi-web/data", () => {
    expect(SCRIPT_SOURCE).toContain('".data/history", "apps/zmi-bi-web/data"');
    expect(SCRIPT_SOURCE).not.toMatch(/git",\s*\["add",\s*"\."\]/u);
    expect(SCRIPT_SOURCE).not.toContain('"add", "-A"');
  });

  it("aborts (does not commit) when any file outside the allowed scope is dirty", () => {
    expect(SCRIPT_SOURCE).toContain("aborted_unexpected_dirty_files");
    expect(SCRIPT_SOURCE).toContain("forbidden_dirty_files");
  });

  it("aborts (does not commit) when history shows a deletion, both before and after staging", () => {
    expect(SCRIPT_SOURCE).toContain("aborted_history_deletion_detected");
    expect(SCRIPT_SOURCE).toContain("aborted_staged_history_deletion_detected");
    // Checked once against the working tree diff and again against the staged diff.
    expect((SCRIPT_SOURCE.match(/numstatDeletions/gu) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("never force-pushes, resets, or runs git clean", () => {
    expect(SCRIPT_SOURCE).not.toContain("--force");
    expect(SCRIPT_SOURCE).not.toMatch(/"reset"/u);
    expect(SCRIPT_SOURCE).not.toMatch(/"clean"/u);
  });

  it("reports push failure distinctly from commit failure, and does not silently swallow it", () => {
    expect(SCRIPT_SOURCE).toContain("auto_commit_push_commit_ok_push_failed");
    expect(SCRIPT_SOURCE).toContain("aborted_commit_failed");
    expect(SCRIPT_SOURCE).toMatch(/if\s*\(!push\.ok\)\s*\{[\s\S]{0,600}process\.exitCode\s*=\s*1/u);
  });

  it("no-ops cleanly on an already-clean tree", () => {
    expect(SCRIPT_SOURCE).toContain("auto_commit_push_noop_clean_tree");
  });

  it("is wired into the market-refresh-rotating launchd job, running even if the crawl step itself fails", () => {
    expect(ROTATING_PLIST).toContain("npm run ops:auto-commit-push");
    // `;` (not `&&`) so a crawl-side failure doesn't also block committing
    // whatever was already appended before the failure.
    expect(ROTATING_PLIST).toMatch(/auto-runner:market-refresh-rotating;\s*npm run ops:auto-commit-push/u);
  });

  it("uses a dedicated, self-cleaning lock to prevent two overlapping invocations from racing", () => {
    expect(SCRIPT_SOURCE).toContain("auto_commit_push.lock");
    expect(SCRIPT_SOURCE).toContain("aborted_lock_held_by_other_run");
    expect(SCRIPT_SOURCE).toContain("LOCK_STALE_MS");
    expect(SCRIPT_SOURCE).toMatch(/finally\s*\{\s*releaseLock\(\);/u);
  });

  it("fetches origin before deciding anything, and never force-pushes on divergence", () => {
    expect(SCRIPT_SOURCE).toMatch(/git\(\["fetch",\s*"origin",\s*"main"\]\)/u);
    expect(SCRIPT_SOURCE).toContain("--ff-only");
    expect(SCRIPT_SOURCE).toContain("aborted_diverged_from_origin_not_fast_forward");
  });

  it("retries a previously-committed-but-unpushed state even when the working tree is clean", () => {
    // The unpushed-commit check must run BEFORE the dirty-tree noop check,
    // so a clean tree with an unpushed commit is never mistaken for
    // "nothing to do".
    const unpushedCheckIdx = SCRIPT_SOURCE.indexOf("unpushed_commits_at_start");
    const noopCleanIdx = SCRIPT_SOURCE.indexOf("auto_commit_push_noop_clean_tree");
    expect(unpushedCheckIdx).toBeGreaterThan(-1);
    expect(unpushedCheckIdx).toBeLessThan(noopCleanIdx);
    expect(SCRIPT_SOURCE).toContain("aborted_retry_push_failed");
  });

  it("detects a concurrent write to an already-staged file before committing", () => {
    expect(SCRIPT_SOURCE).toContain("aborted_concurrent_write_detected");
    expect(SCRIPT_SOURCE).toContain("restaggered_files");
  });

  it("regression: the concurrent-write check must not false-positive on every normal run (git status --porcelain still lists a freshly-staged, unchanged file)", () => {
    // A file that was just `git add`-ed shows up in `git status --porcelain`
    // as "M  path" (worktree column = space) until it's committed — that is
    // NOT a re-modification. Only a SECOND status column that is non-space
    // (e.g. "MM path", meaning the worktree changed again after staging)
    // is a genuine concurrent write. The check must read the raw two-column
    // code, not just "does this path appear in git status --porcelain at all".
    expect(SCRIPT_SOURCE).toContain("worktreeChangedSinceIndexPaths");
    expect(SCRIPT_SOURCE).toMatch(/const restaggered = worktreeChangedSinceIndexPaths\(\)/u);
    expect(SCRIPT_SOURCE).not.toMatch(/const restaggered = porcelainPaths\(\)/u);
  });
});

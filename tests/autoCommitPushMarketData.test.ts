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
    expect(SCRIPT_SOURCE).toMatch(/if\s*\(!push\.ok\)\s*\{[\s\S]{0,400}process\.exitCode\s*=\s*1/u);
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
});

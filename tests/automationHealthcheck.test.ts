import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutomationHealthcheck.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

describe("AUTOMATION-HEALTHCHECK01", () => {
  it("is wired as an npm script", () => {
    expect(PACKAGE_JSON).toContain('"ops:automation-healthcheck"');
    expect(PACKAGE_JSON).toContain("runAutomationHealthcheck.ts");
  });

  it("checks all four production launchd jobs", () => {
    for (const label of [
      "com.yuge.zmi.market-refresh-rotating",
      "com.yuge.zmi.booking-market-recrawl",
      "com.yuge.zmi.pricing-critical-recrawl",
      "com.yuge.zmi.bi-web-publish"
    ]) {
      expect(SCRIPT_SOURCE).toContain(label);
    }
  });

  it("flags staleness against a configurable hour threshold, defaulting to 4h", () => {
    expect(SCRIPT_SOURCE).toContain("ZMI_HEALTHCHECK_STALE_HOURS");
    expect(SCRIPT_SOURCE).toMatch(/STALE_HOURS[\s\S]{0,40}"4"/u);
    expect(SCRIPT_SOURCE).toContain("last_commit_stale");
  });

  it("detects unpushed local commits (git push silently failing)", () => {
    expect(SCRIPT_SOURCE).toContain("unpushed_commits");
    expect(SCRIPT_SOURCE).toContain("origin/main..HEAD");
  });

  it("detects stale lock files", () => {
    expect(SCRIPT_SOURCE).toContain("stale_lock_files");
    expect(SCRIPT_SOURCE).toContain("STALE_LOCK_HOURS");
  });

  it("detects unexpected dirty files outside the allowed data scope", () => {
    expect(SCRIPT_SOURCE).toContain("unexpected_dirty_files");
    expect(SCRIPT_SOURCE).toContain(".data/history/");
    expect(SCRIPT_SOURCE).toContain("apps/zmi-bi-web/data/");
  });

  it("always uses a local macOS notification (no external credential required)", () => {
    expect(SCRIPT_SOURCE).toContain("osascript");
    expect(SCRIPT_SOURCE).toContain("display notification");
  });

  it("only calls Slack/Discord webhooks when explicitly configured, never with a hardcoded URL", () => {
    expect(SCRIPT_SOURCE).toContain("ZMI_HEALTHCHECK_SLACK_WEBHOOK_URL");
    expect(SCRIPT_SOURCE).toContain("ZMI_HEALTHCHECK_DISCORD_WEBHOOK_URL");
    expect(SCRIPT_SOURCE).not.toMatch(/https:\/\/hooks\.slack\.com/u);
    expect(SCRIPT_SOURCE).not.toMatch(/https:\/\/discord(app)?\.com\/api\/webhooks/u);
  });

  it("is read-only: no history/DB mutation, no commit/push/publish", () => {
    expect(SCRIPT_SOURCE).not.toContain('"commit"');
    expect(SCRIPT_SOURCE).not.toContain('"push"');
    expect(SCRIPT_SOURCE).not.toContain("writeFileSync(HISTORY");
  });

  it("exits non-zero when unhealthy so a cron/launchd wrapper can detect failure", () => {
    expect(SCRIPT_SOURCE).toMatch(/if\s*\(!healthy\)\s*\{[\s\S]{0,600}process\.exitCode\s*=\s*1/u);
  });
});

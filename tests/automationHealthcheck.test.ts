import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutomationHealthcheck.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");
const PUBLISH_BI_WEB_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/publishBiWeb.ts"), "utf8");
const PUBLISH_CHATGPT_DB_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/publishChatGptDb.ts"), "utf8");

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

  describe("data freshness dashboard (§4)", () => {
    it("reports all six requested freshness timestamps", () => {
      for (const field of [
        "latest_local_collected_at_jst",
        "latest_history_committed_at_jst",
        "latest_github_pushed_at_jst",
        "latest_cloudflare_published_at_jst",
        "latest_d1_synced_at_jst",
        "latest_chatgpt_db_published_at_jst"
      ]) {
        expect(SCRIPT_SOURCE).toContain(field);
      }
    });

    it("computes a per-layer delay in hours since local collection, so a stale D1/ChatGPT layer is distinguishable from a stale GitHub layer", () => {
      expect(SCRIPT_SOURCE).toContain("delay_hours_since_collection");
      expect(SCRIPT_SOURCE).toContain("hoursSince");
      expect(SCRIPT_SOURCE).toMatch(/layers:\s*FreshnessLayer\[\]/u);
    });

    it("determines github-pushed status via merge-base ancestry against the (already-fetched) cached origin/main ref, not a second network call", () => {
      expect(SCRIPT_SOURCE).toContain('"merge-base", "--is-ancestor"');
    });

    it("reads Cloudflare/ChatGPT-DB publish times from local marker files (wrangler/gh expose no queryable publish timestamp)", () => {
      expect(SCRIPT_SOURCE).toContain("last_bi_web_publish.json");
      expect(SCRIPT_SOURCE).toContain("last_chatgpt_db_publish.json");
    });

    it("reads the D1 mirror's sync time read-only, without ever writing to the sqlite file", () => {
      expect(SCRIPT_SOURCE).toContain("market_signal_sync_runs");
      expect(SCRIPT_SOURCE).toMatch(/readonly:\s*true/u);
      expect(SCRIPT_SOURCE).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM|DROP TABLE/u);
    });

    it("publishBiWeb.ts writes the marker only after a successful wrangler deploy", () => {
      expect(PUBLISH_BI_WEB_SOURCE).toContain("last_bi_web_publish.json");
      const deployIdx = PUBLISH_BI_WEB_SOURCE.indexOf('"wrangler", "pages", "deploy"');
      const markerIdx = PUBLISH_BI_WEB_SOURCE.indexOf("writePublishMarker(url)");
      expect(deployIdx).toBeGreaterThan(-1);
      expect(markerIdx).toBeGreaterThan(deployIdx);
    });

    it("publishChatGptDb.ts writes the marker only after a successful release upload", () => {
      expect(PUBLISH_CHATGPT_DB_SOURCE).toContain("last_chatgpt_db_publish.json");
      const uploadIdx = PUBLISH_CHATGPT_DB_SOURCE.indexOf('"release", "upload"');
      const markerIdx = PUBLISH_CHATGPT_DB_SOURCE.indexOf("writePublishMarker(releaseUrl, assetUrl)");
      expect(uploadIdx).toBeGreaterThan(-1);
      expect(markerIdx).toBeGreaterThan(uploadIdx);
    });
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSET_NAME,
  RELEASE_TAG,
  RELEASE_TITLE,
  buildReleaseBody,
  decidePublish,
  renderPublishSummary,
  type PublishContext
} from "../src/services/chatGptDbReleasePublisher";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/chatGptDbReleasePublisher.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/publishChatGptDb.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function ctx(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    ghInstalled: true,
    ghAuthenticated: true,
    zipPath: "/tmp/zmi_chatgpt_upload_latest.zip",
    zipSizeBytes: 150_000,
    releaseExists: false,
    ...overrides
  };
}

describe("CHATGPT-UPLOAD02 - decision logic", () => {
  it("1. returns gh_missing when gh not installed", () => {
    expect(decidePublish(ctx({ ghInstalled: false }))).toBe("chatgpt_db_publish_gh_missing");
  });

  it("2. returns gh_missing when gh not authenticated", () => {
    expect(decidePublish(ctx({ ghAuthenticated: false }))).toBe("chatgpt_db_publish_gh_missing");
  });

  it("3. returns zip_missing when zipSizeBytes=0", () => {
    expect(decidePublish(ctx({ zipSizeBytes: 0 }))).toBe("chatgpt_db_publish_zip_missing");
  });

  it("3b. returns zip_missing when zipPath is empty", () => {
    expect(decidePublish(ctx({ zipPath: "" }))).toBe("chatgpt_db_publish_zip_missing");
  });

  it("4. returns ready when all present", () => {
    expect(decidePublish(ctx())).toBe("chatgpt_db_publish_ready");
  });

  it("4b. returns ready whether release exists or not", () => {
    expect(decidePublish(ctx({ releaseExists: true }))).toBe("chatgpt_db_publish_ready");
    expect(decidePublish(ctx({ releaseExists: false }))).toBe("chatgpt_db_publish_ready");
  });
});

describe("CHATGPT-UPLOAD02 - release body", () => {
  it("5. buildReleaseBody contains release tag", () => {
    expect(buildReleaseBody(275, "2026-06-08")).toContain(RELEASE_TAG);
  });

  it("5b. buildReleaseBody contains asset name", () => {
    expect(buildReleaseBody(275, "2026-06-08")).toContain(ASSET_NAME);
  });

  it("6. buildReleaseBody includes safety instructions", () => {
    const body = buildReleaseBody(275, "2026-06-08");
    expect(body).toContain("history CSV is canonical");
    expect(body).toContain("do not infer unavailable data");
    expect(body).toContain("do not produce PMS");
  });

  it("includes history row count in body", () => {
    expect(buildReleaseBody(275, "2026-06-08")).toContain("275");
  });

  it("includes collected date when provided", () => {
    expect(buildReleaseBody(275, "2026-06-08")).toContain("2026-06-08");
  });

  it("handles null collected date gracefully", () => {
    expect(() => buildReleaseBody(275, null)).not.toThrow();
  });
});

describe("CHATGPT-UPLOAD02 - render summary", () => {
  it("7. renderPublishSummary contains decision and release_tag", () => {
    const summary = renderPublishSummary(ctx(), "chatgpt_db_publish_ready", "https://github.com/r/releases/tag/t", "https://asset");
    expect(summary).toContain("decision=chatgpt_db_publish_ready");
    expect(summary).toContain(`release_tag=${RELEASE_TAG}`);
    expect(summary).toContain("release_url=https://github.com");
  });
});

describe("CHATGPT-UPLOAD02 - constants", () => {
  it("8. ASSET_NAME is zmi_chatgpt_upload_latest.zip", () => {
    expect(ASSET_NAME).toBe("zmi_chatgpt_upload_latest.zip");
  });

  it("9. RELEASE_TAG is chatgpt-db-latest", () => {
    expect(RELEASE_TAG).toBe("chatgpt-db-latest");
  });

  it("RELEASE_TITLE is set", () => {
    expect(RELEASE_TITLE).toBe("ZMI ChatGPT DB Latest");
  });
});

describe("CHATGPT-UPLOAD02 - safety scans", () => {
  it("10. script has no DB mutation SQL in .prepare() calls", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\.prepare\(["'`][^"'`]*(INSERT|UPDATE|DELETE|CREATE TABLE|DROP|ALTER|VACUUM|REINDEX)/iu);
  });

  it("11. script opens SQLite read-only", () => {
    expect(SCRIPT_SOURCE).toContain("readonly: true");
  });

  it("12. package.json contains publish:chatgpt-db", () => {
    expect(PACKAGE_JSON).toContain("publish:chatgpt-db");
  });

  it("13. package.json contains auto-runner:chatgpt-db-publish", () => {
    expect(PACKAGE_JSON).toContain("auto-runner:chatgpt-db-publish");
  });

  it("service is pure (no I/O, no spawnSync, no filesystem)", () => {
    expect(SERVICE_SOURCE).not.toMatch(/spawnSync|readFileSync|writeFileSync|existsSync|child_process/u);
  });

  it("script performs no history append or DB sync", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/COLLECT_BOOKING|COLLECT_JALAN|sync:history-to-db|build:ai-context-packs/u);
  });
});

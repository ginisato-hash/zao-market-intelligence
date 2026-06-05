import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalScreenshotStorage, NotImplementedR2ScreenshotStorage } from "../src/services/screenshotStorage";

describe("screenshot storage", () => {
  it("writes objects to local storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "zao-screenshots-"));
    const storage = new LocalScreenshotStorage(root);

    const result = await storage.putObject({
      key: "screenshots/2026/08/08/run/property/ota/stay/job.png",
      contentType: "image/png",
      body: "fake image bytes"
    });

    expect(result.storageType).toBe("local");
    expect(readFileSync(result.path, "utf8")).toBe("fake image bytes");
  });

  it("throws a clear error for R2 storage in this phase", async () => {
    const storage = new NotImplementedR2ScreenshotStorage();

    await expect(
      storage.putObject({
        key: "screenshots/test.png",
        contentType: "image/png",
        body: "fake"
      })
    ).rejects.toThrow("R2 remote screenshot upload is not implemented in Phase 5.");
  });
});

import { describe, expect, it } from "vitest";
import { createScreenshotKey } from "../src/utils/screenshotKey";

describe("createScreenshotKey", () => {
  it("includes date folders, run, property, OTA, stay date, job, and png extension", () => {
    const key = createScreenshotKey({
      capturedAt: new Date("2026-08-08T12:00:00.000Z"),
      runId: "run_123",
      propertyId: "property_456",
      ota: "jalan",
      stayDate: "2026-10-10",
      jobId: "job_789"
    });

    expect(key).toContain("screenshots/2026/08/08");
    expect(key).toContain("run_123");
    expect(key).toContain("property_456");
    expect(key).toContain("jalan");
    expect(key).toContain("2026-10-10");
    expect(key.endsWith("job_789.png")).toBe(true);
  });
});

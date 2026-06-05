import { describe, expect, it } from "vitest";
import { targetDateSeedRecordSchema } from "../src/seeds/targetDateSeedSchema";

describe("target date seed validation", () => {
  it("accepts a valid target date seed", () => {
    const parsed = targetDateSeedRecordSchema.parse({
      stay_date: "2026-10-10",
      priority: "S",
      reason: "Autumn foliage sample",
      active: true
    });

    expect(parsed.priority).toBe("S");
  });

  it("rejects invalid target date format", () => {
    expect(() =>
      targetDateSeedRecordSchema.parse({
        stay_date: "2026/10/10",
        priority: "A",
        reason: "Bad format",
        active: true
      })
    ).toThrow();
  });

  it("rejects invalid priority", () => {
    expect(() =>
      targetDateSeedRecordSchema.parse({
        stay_date: "2026-10-10",
        priority: "D",
        reason: "Bad priority",
        active: true
      })
    ).toThrow();
  });
});

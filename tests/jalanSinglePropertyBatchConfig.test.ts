import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJalanMultiDatePrototypeConfig } from "../src/prototype/jalanPrototypeSchema";
import { loadJalanMultiDatePrototypeConfig, resolveJalanBatchConfigPath } from "../src/scripts/runJalanMultiDatePrototype";

describe("Jalan single-property batch config", () => {
  it("loads a custom config path", () => {
    const dir = mkdtempSync(join(tmpdir(), "jalan-batch-config-"));
    const path = join(dir, "custom.json");
    writeFileSync(path, JSON.stringify(validConfig({ property_name: "Custom Property" })), "utf8");

    expect(loadJalanMultiDatePrototypeConfig(path).property_name).toBe("Custom Property");
  });

  it("resolves config path from CLI or env without code edits", () => {
    expect(resolveJalanBatchConfigPath(["node", "script", "--config", "custom.json"], {})).toBe("custom.json");
    expect(resolveJalanBatchConfigPath(["node", "script"], { JALAN_BATCH_CONFIG: "env.json" })).toBe("env.json");
  });

  it("placeholder config fails clearly", () => {
    expect(() =>
      parseJalanMultiDatePrototypeConfig({
        ...validConfig(),
        property_name: "MANUAL_PROPERTY_NAME_REQUIRED",
        property_url: "MANUAL_JALAN_PROPERTY_URL_REQUIRED"
      })
    ).toThrow(/placeholder values/);
  });

  it("one manually configured property validates", () => {
    const config = parseJalanMultiDatePrototypeConfig(validConfig());

    expect(config.property_name).toBe("ル・ベール蔵王");
    expect(config.property_url).toBe("https://www.jalan.net/yad328232/");
  });

  it("rejects more stay dates than max_attempts", () => {
    expect(() =>
      parseJalanMultiDatePrototypeConfig({
        ...validConfig(),
        max_attempts: 4
      })
    ).toThrow(/max_attempts/);
  });
});

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    ota: "jalan",
    property_name: "ル・ベール蔵王",
    property_url: "https://www.jalan.net/yad328232/",
    stay_dates: ["2026-07-18", "2026-08-08", "2026-08-15", "2026-10-10", "2026-12-12"],
    adults: 2,
    children: 0,
    rooms: 1,
    nights: 1,
    max_attempts: 5,
    delay_ms_between_attempts: 3000,
    ...overrides
  };
}

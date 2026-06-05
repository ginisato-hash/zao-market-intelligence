import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config/env";

describe("env config", () => {
  it("defaults to local database and local screenshot storage", () => {
    const env = parseEnv({});

    expect(env.DATABASE_MODE).toBe("local");
    expect(env.LOCAL_DB_PATH).toBe(".data/zao-market-intelligence.sqlite");
    expect(env.SCREENSHOT_STORAGE).toBe("local");
    expect(env.LOCAL_SCREENSHOT_DIR).toBe(".data/screenshots");
  });

  it("rejects invalid DATABASE_MODE", () => {
    expect(() => parseEnv({ DATABASE_MODE: "postgres" })).toThrow();
  });

  it("rejects invalid SCREENSHOT_STORAGE", () => {
    expect(() => parseEnv({ SCREENSHOT_STORAGE: "s3" })).toThrow();
  });
});

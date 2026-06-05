import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadSourceCapabilities,
  assertNoPaidSourcesEnabled
} from "../src/services/sourceCapabilityRegistry";

const FORBIDDEN_COLLECTOR_NAMES = [
  "serpapi",
  "dataforseo",
  "apify",
  "brightdata",
  "oxylabs"
];

describe("checkNoPaidSourcesEnabled (guard assertions)", () => {
  it("current source_capabilities config has no paid sources enabled", () => {
    const caps = loadSourceCapabilities();
    expect(() => assertNoPaidSourcesEnabled(caps)).not.toThrow();
  });

  it("all five forbidden collector names appear in the capabilities config as forbidden", () => {
    const caps = loadSourceCapabilities();
    const forbiddenSources = caps
      .filter((c) => c.status === "forbidden")
      .map((c) => c.source);
    for (const name of FORBIDDEN_COLLECTOR_NAMES) {
      expect(forbiddenSources).toContain(name);
    }
  });

  it("package.json collect: scripts contain none of the forbidden names", () => {
    interface PkgJson { scripts: Record<string, string> }
    const pkg = JSON.parse(
      readFileSync(resolve("package.json"), "utf8")
    ) as PkgJson;
    const scripts = pkg.scripts ?? {};
    const COLLECT_PREFIX = /^collect:/;

    const violations: string[] = [];
    for (const [scriptName, scriptValue] of Object.entries(scripts)) {
      if (!COLLECT_PREFIX.test(scriptName)) continue;
      for (const name of FORBIDDEN_COLLECTOR_NAMES) {
        if (scriptValue.toLowerCase().includes(name)) {
          violations.push(`${scriptName}: ${name}`);
        }
      }
    }
    expect(violations).toHaveLength(0);
  });

  it("forbidden sources have cost_policy=paid_forbidden", () => {
    const caps = loadSourceCapabilities();
    const forbidden = caps.filter((c) => !c.allowed);
    for (const cap of forbidden) {
      if (cap.paid_service_required) {
        expect(cap.cost_policy).toBe("paid_forbidden");
      }
    }
  });
});

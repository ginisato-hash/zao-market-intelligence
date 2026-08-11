// ZMI-MKT-OBS02 PART B2 — trusted market-data commit policy behaviour.
//
// The unattended committer's boundary. .data/market-observations/ was added to
// the trusted set, so it must earn the SAME four guarantees .data/history has:
// path allowlist, append-only, schema validation, size bound.

import { describe, expect, it } from "vitest";
import {
  APPEND_ONLY_PREFIXES,
  MAX_TRUSTED_FILE_BYTES,
  TRUSTED_MARKET_DATA_PREFIXES,
  appendOnlyViolations,
  classifyTrustedMarketDataPath,
  evaluateTrustedMarketDataCommit,
  forbiddenPaths,
  isAppendOnlyPath,
  isTrustedMarketDataPath,
  observationShardPaths,
  oversizedFiles,
  validateObservationShardHeaderLine
} from "../src/services/marketDataCommitPolicy";
import { MARKET_OBSERVATION_CSV_HEADERS } from "../src/services/marketObservationSchema";

const GOOD_HEADER = MARKET_OBSERVATION_CSV_HEADERS.join(",");
const OBS_SHARD = ".data/market-observations/mkt_obs_2026_08.csv";

function okInput(overrides: Partial<Parameters<typeof evaluateTrustedMarketDataCommit>[0]> = {}) {
  return {
    paths: [".data/history/zao_signals_2026_08.csv", OBS_SHARD, "apps/zmi-bi-web/data/metadata.json"],
    numstat: [
      { path: ".data/history/zao_signals_2026_08.csv", add: 10, del: 0 },
      { path: OBS_SHARD, add: 18, del: 0 }
    ],
    observationHeaders: new Map<string, string | null>([[OBS_SHARD, GOOD_HEADER]]),
    fileSizes: [{ path: OBS_SHARD, bytes: 54_000 }],
    ...overrides
  };
}

describe("PART B2 — trusted path allowlist", () => {
  it("trusts exactly history, BI exports, and the new observation store", () => {
    expect(TRUSTED_MARKET_DATA_PREFIXES).toEqual([".data/history/", "apps/zmi-bi-web/data/", ".data/market-observations/"]);
    expect(isTrustedMarketDataPath(OBS_SHARD)).toBe(true);
    expect(isTrustedMarketDataPath(".data/history/zao_signals_2026_08.csv")).toBe(true);
    expect(isTrustedMarketDataPath("apps/zmi-bi-web/data/metadata.json")).toBe(true);
  });

  it("refuses source code, ops config, secrets, and anything else outside the trusted set", () => {
    for (const p of [
      "src/services/marketObservationSchema.ts",
      "package.json",
      ".env",
      "ops/launchd/com.yuge.zmi.core-competitor-observation.plist.template",
      ".data/reports/automation/run.json",
      ".data/market-observations-evil/mkt_obs_2026_08.csv"
    ]) {
      expect(isTrustedMarketDataPath(p), p).toBe(false);
    }
    expect(forbiddenPaths([OBS_SHARD, "src/index.ts", ".env"])).toEqual(["src/index.ts", ".env"]);
  });

  it("classifies each trusted path by store kind", () => {
    expect(classifyTrustedMarketDataPath(OBS_SHARD)).toBe("market_observation");
    expect(classifyTrustedMarketDataPath(".data/history/zao_signals_2026_08.csv")).toBe("history");
    expect(classifyTrustedMarketDataPath("apps/zmi-bi-web/data/metadata.json")).toBe("bi_web_export");
    expect(classifyTrustedMarketDataPath("src/x.ts")).toBe("untrusted");
  });
});

describe("PART B2 — append-only enforcement covers the observation store", () => {
  it("treats history and market-observations as append-only, but not regenerated BI exports", () => {
    expect(isAppendOnlyPath(".data/history/zao_signals_2026_08.csv")).toBe(true);
    expect(isAppendOnlyPath(OBS_SHARD)).toBe(true);
    // Derived exports are rewritten wholesale (retention pruning shrinks them).
    expect(isAppendOnlyPath("apps/zmi-bi-web/data/zmi_market_unified.csv")).toBe(false);
    expect(APPEND_ONLY_PREFIXES).not.toContain("apps/zmi-bi-web/data/");
  });

  it("flags a deletion in the observation store exactly like one in history", () => {
    const violations = appendOnlyViolations([
      { path: OBS_SHARD, add: 0, del: 3 },
      { path: ".data/history/zao_signals_2026_08.csv", add: 0, del: 1 }
    ]);
    expect(violations).toHaveLength(2);
  });

  it("does NOT flag a shrinking BI export (legitimate regeneration)", () => {
    expect(appendOnlyViolations([{ path: "apps/zmi-bi-web/data/zmi_market_unified.csv", add: 5, del: 40 }])).toEqual([]);
  });

  it("aborts the whole commit on an observation-store deletion", () => {
    const verdict = evaluateTrustedMarketDataCommit(
      okInput({ numstat: [{ path: OBS_SHARD, add: 1, del: 2 }] })
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe("aborted_append_only_violation");
  });
});

describe("PART B2 — observation shard schema validation", () => {
  it("accepts the exact zao_market_observation_v1 header", () => {
    expect(validateObservationShardHeaderLine(OBS_SHARD, GOOD_HEADER)).toBeNull();
  });

  it("rejects a missing or empty header (truncated / half-written file)", () => {
    expect(validateObservationShardHeaderLine(OBS_SHARD, null)?.errors).toContain("empty_or_missing_header");
    expect(validateObservationShardHeaderLine(OBS_SHARD, "   ")?.errors).toContain("empty_or_missing_header");
  });

  it("rejects a header missing a required column", () => {
    const truncated = MARKET_OBSERVATION_CSV_HEADERS.filter((c) => c !== "inventory_scope").join(",");
    expect(validateObservationShardHeaderLine(OBS_SHARD, truncated)?.errors).toContain("missing_column:inventory_scope");
  });

  it("rejects a header that reintroduces a forbidden naive-inventory column", () => {
    const bad = `${GOOD_HEADER},rooms_available_exact`;
    expect(validateObservationShardHeaderLine(OBS_SHARD, bad)?.errors).toContain("forbidden_column:rooms_available_exact");
  });

  it("rejects a REORDERED header — rows are written positionally, so order silently mis-maps values", () => {
    const swapped = [...MARKET_OBSERVATION_CSV_HEADERS];
    const i = swapped.indexOf("inventory_count");
    const j = swapped.indexOf("inventory_scope");
    [swapped[i], swapped[j]] = [swapped[j]!, swapped[i]!];
    const problem = validateObservationShardHeaderLine(OBS_SHARD, swapped.join(","));
    expect(problem?.errors).toContain("column_order_mismatch");
  });

  it("tolerates a UTF-8 BOM on the header line", () => {
    expect(validateObservationShardHeaderLine(OBS_SHARD, `﻿${GOOD_HEADER}`)).toBeNull();
  });

  it("only validates real observation shard filenames", () => {
    expect(observationShardPaths([OBS_SHARD, ".data/market-observations/notes.md", ".data/history/zao_signals_2026_08.csv"])).toEqual([OBS_SHARD]);
  });

  it("aborts the commit when a staged shard's header is invalid", () => {
    const verdict = evaluateTrustedMarketDataCommit(
      okInput({ observationHeaders: new Map<string, string | null>([[OBS_SHARD, "a,b,c"]]) })
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe("aborted_observation_schema_invalid");
  });

  it("aborts when a staged shard has no readable header at all", () => {
    const verdict = evaluateTrustedMarketDataCommit(okInput({ observationHeaders: new Map<string, string | null>() }));
    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe("aborted_observation_schema_invalid");
  });
});

describe("PART B2 — file size bound", () => {
  it("passes normal shard sizes and refuses a runaway file", () => {
    expect(oversizedFiles([{ path: OBS_SHARD, bytes: 54_000 }])).toEqual([]);
    expect(oversizedFiles([{ path: OBS_SHARD, bytes: MAX_TRUSTED_FILE_BYTES + 1 }])).toHaveLength(1);
  });

  it("aborts the commit on an oversized staged file", () => {
    const verdict = evaluateTrustedMarketDataCommit(
      okInput({ fileSizes: [{ path: OBS_SHARD, bytes: MAX_TRUSTED_FILE_BYTES + 1 }] })
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe("aborted_file_too_large");
  });
});

describe("PART B2 — combined verdict", () => {
  it("passes a realistic, fully-valid staged set (history + observations + BI exports)", () => {
    const verdict = evaluateTrustedMarketDataCommit(okInput());
    expect(verdict.ok).toBe(true);
    expect(verdict.decision).toBe("trusted_market_data_ok");
    expect(verdict.forbidden).toEqual([]);
    expect(verdict.appendOnlyViolations).toEqual([]);
    expect(verdict.schemaProblems).toEqual([]);
    expect(verdict.oversized).toEqual([]);
  });

  it("reports the most severe problem first: untrusted path outranks everything else", () => {
    const verdict = evaluateTrustedMarketDataCommit(
      okInput({
        paths: [...okInput().paths, "src/evil.ts"],
        numstat: [{ path: OBS_SHARD, add: 0, del: 5 }],
        observationHeaders: new Map<string, string | null>([[OBS_SHARD, "bad"]]),
        fileSizes: [{ path: OBS_SHARD, bytes: MAX_TRUSTED_FILE_BYTES + 1 }]
      })
    );
    expect(verdict.decision).toBe("aborted_unexpected_paths");
    // All findings are still reported for diagnostics, not just the first.
    expect(verdict.appendOnlyViolations).toHaveLength(1);
    expect(verdict.schemaProblems).toHaveLength(1);
    expect(verdict.oversized).toHaveLength(1);
  });

  it("an empty staged set is trivially ok (the script's own noop path handles it)", () => {
    const verdict = evaluateTrustedMarketDataCommit({
      paths: [],
      numstat: [],
      observationHeaders: new Map(),
      fileSizes: []
    });
    expect(verdict.ok).toBe(true);
  });
});

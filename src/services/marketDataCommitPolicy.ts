// Phase ZMI-MKT-OBS02 — trusted market-data commit policy (pure). PART B2.
//
// runAutoCommitPushMarketData.ts stages market data unattended, so what it is
// allowed to touch is a safety boundary, not a convenience list. Extending it
// to the new .data/market-observations/ store therefore means giving that
// store the SAME guarantees .data/history already has, not appending one line
// to an allowlist:
//
//   1. path allowlist            — nothing outside the trusted prefixes;
//   2. append-only enforcement   — zero deleted lines in any append-only store
//                                  (history AND market-observations), checked
//                                  both unstaged and staged;
//   3. schema validation         — every staged observation shard must carry
//                                  the exact zao_market_observation_v1 header,
//                                  so a truncated/hand-edited/half-written
//                                  file can never be committed;
//   4. file size bound           — a runaway shard is refused rather than
//                                  pushed.
//
// Pure and I/O-free so all four rules are unit-testable without shelling out
// to git; the script supplies the git/fs facts and applies the verdicts.

import { MARKET_OBSERVATION_CSV_HEADERS, validateObservationColumns } from "./marketObservationSchema";

// Every path the unattended committer may stage.
export const TRUSTED_MARKET_DATA_PREFIXES = [
  ".data/history/",
  "apps/zmi-bi-web/data/",
  ".data/market-observations/"
] as const;

// Stores whose files may only ever GROW. A deletion here means history was
// rewritten, which must abort the whole run. apps/zmi-bi-web/data is
// deliberately NOT in this list: those files are regenerated derived exports,
// where a shrinking row count is legitimate (retention pruning).
export const APPEND_ONLY_PREFIXES = [".data/history/", ".data/market-observations/"] as const;

// Generous enough that no legitimate monthly shard approaches it, small enough
// that a runaway/duplicated file is caught before it reaches the remote.
export const MAX_TRUSTED_FILE_BYTES = 64 * 1024 * 1024;

export type TrustedMarketDataKind = "history" | "bi_web_export" | "market_observation" | "untrusted";

export function classifyTrustedMarketDataPath(path: string): TrustedMarketDataKind {
  if (path.startsWith(".data/history/")) return "history";
  if (path.startsWith("apps/zmi-bi-web/data/")) return "bi_web_export";
  if (path.startsWith(".data/market-observations/")) return "market_observation";
  return "untrusted";
}

export function isTrustedMarketDataPath(path: string): boolean {
  return classifyTrustedMarketDataPath(path) !== "untrusted";
}

export function isAppendOnlyPath(path: string): boolean {
  return APPEND_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Paths that the unattended committer must refuse to stage. */
export function forbiddenPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !isTrustedMarketDataPath(p));
}

export interface NumstatEntry {
  path: string;
  add: number;
  del: number;
}

/**
 * Append-only violations across EVERY append-only store, not just history.
 * A deletion inside .data/market-observations/ is exactly as disqualifying as
 * one inside .data/history/.
 */
export function appendOnlyViolations(entries: readonly NumstatEntry[]): NumstatEntry[] {
  return entries.filter((e) => e.del > 0 && isAppendOnlyPath(e.path));
}

export interface FileSizeEntry {
  path: string;
  bytes: number;
}

export function oversizedFiles(entries: readonly FileSizeEntry[], maxBytes: number = MAX_TRUSTED_FILE_BYTES): FileSizeEntry[] {
  return entries.filter((e) => e.bytes > maxBytes);
}

export interface ObservationShardSchemaProblem {
  path: string;
  errors: string[];
}

/**
 * Schema-validate a staged market-observation shard from its header line.
 * Catches a truncated or hand-edited file, a stale schema version, and a
 * column-order change — the observation-store equivalent of the migration
 * guard .data/history shards already go through on append.
 */
export function validateObservationShardHeaderLine(path: string, headerLine: string | null): ObservationShardSchemaProblem | null {
  if (headerLine === null || headerLine.trim() === "") {
    return { path, errors: ["empty_or_missing_header"] };
  }
  const columns = headerLine.replace(/^﻿/u, "").trim().split(",");
  const errors = validateObservationColumns(columns);
  // Column ORDER matters too: the append path writes rows positionally, so a
  // reordered header would silently mis-associate every value.
  if (errors.length === 0) {
    const orderMismatch =
      columns.length !== MARKET_OBSERVATION_CSV_HEADERS.length ||
      MARKET_OBSERVATION_CSV_HEADERS.some((col, i) => columns[i] !== col);
    if (orderMismatch) errors.push("column_order_mismatch");
  }
  return errors.length > 0 ? { path, errors } : null;
}

/** Only the observation-store CSV shards need header validation. */
export function observationShardPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => /^\.data\/market-observations\/mkt_obs_\d{4}_\d{2}\.csv$/u.test(p));
}

export interface CommitPolicyVerdict {
  ok: boolean;
  decision:
    | "trusted_market_data_ok"
    | "aborted_unexpected_paths"
    | "aborted_append_only_violation"
    | "aborted_observation_schema_invalid"
    | "aborted_file_too_large";
  forbidden: string[];
  appendOnlyViolations: NumstatEntry[];
  schemaProblems: ObservationShardSchemaProblem[];
  oversized: FileSizeEntry[];
}

/**
 * Single entry point applying all four rules in severity order, so the script
 * reports one decision and callers/tests exercise the same logic.
 */
export function evaluateTrustedMarketDataCommit(input: {
  paths: readonly string[];
  numstat: readonly NumstatEntry[];
  observationHeaders: ReadonlyMap<string, string | null>;
  fileSizes: readonly FileSizeEntry[];
  maxBytes?: number;
}): CommitPolicyVerdict {
  const forbidden = forbiddenPaths(input.paths);
  const violations = appendOnlyViolations(input.numstat);
  const schemaProblems = observationShardPaths(input.paths)
    .map((p) => validateObservationShardHeaderLine(p, input.observationHeaders.get(p) ?? null))
    .filter((x): x is ObservationShardSchemaProblem => x !== null);
  const oversized = oversizedFiles(input.fileSizes, input.maxBytes ?? MAX_TRUSTED_FILE_BYTES);

  const base = { forbidden, appendOnlyViolations: violations, schemaProblems, oversized };
  if (forbidden.length > 0) return { ok: false, decision: "aborted_unexpected_paths", ...base };
  if (violations.length > 0) return { ok: false, decision: "aborted_append_only_violation", ...base };
  if (schemaProblems.length > 0) return { ok: false, decision: "aborted_observation_schema_invalid", ...base };
  if (oversized.length > 0) return { ok: false, decision: "aborted_file_too_large", ...base };
  return { ok: true, decision: "trusted_market_data_ok", ...base };
}

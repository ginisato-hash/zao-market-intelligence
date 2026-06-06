// Phase AUTO-RUNNER-HANDOFF06X - fresh-clone test portability.
//
// Resolves a report-artifact path used by tests to a committed lightweight
// fixture under tests/fixtures/reports/**, so the suite runs on a fresh clone
// where the live .data/reports/** outputs are gitignored and absent.
//
// Resolution order (deterministic):
//   1. tests/fixtures/reports/<subpath>   (committed fixture, preferred)
//   2. .data/reports/<subpath>            (live dev output, fallback only)
//   3. throw a clear error if neither exists.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const MARKER = ".data/reports/";

// Accepts any path that contains ".data/reports/" (absolute, "../"-prefixed, or
// the bare ".data/reports/..." form) and returns the absolute path to use.
export function resolveReportFixture(reportPath: string): string {
  const markerIndex = reportPath.indexOf(MARKER);
  const subPath = markerIndex >= 0 ? reportPath.slice(markerIndex + MARKER.length) : reportPath;

  const fixturePath = resolve(REPO_ROOT, "tests/fixtures/reports", subPath);
  if (existsSync(fixturePath)) {
    return fixturePath;
  }

  const livePath = resolve(REPO_ROOT, ".data/reports", subPath);
  if (existsSync(livePath)) {
    return livePath;
  }

  throw new Error(
    `Report fixture not found: "${subPath}". Looked in tests/fixtures/reports/ and .data/reports/.`
  );
}

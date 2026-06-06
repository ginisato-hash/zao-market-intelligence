// Phase AUTO-RUNNER-HANDOFF05X - always-on Mac bootstrap portability.
//
// Verifies the lightweight config/seed/prototype files needed for a fresh clone
// are present and secret-free, that the source-capability registry can locate
// the committed config, and that auto-runner:db-update / auto-runner:health-check
// no longer hard-depend on a previously generated timestamped .data/reports
// artifact (they fall back to the built-in default stage model / in-process plan).
//
// Behavioral safety scans target executable patterns, not harmless prose.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDefaultPipelineStages,
  buildRunnerStubSummaryInProcess,
  buildSafetyConfirmation,
  buildStagePlan,
  evaluateGates
} from "../src/services/autoRunnerDbUpdateStub";
import {
  DEFAULT_SOURCE_CAPABILITY_PATH,
  loadSourceCapabilities
} from "../src/services/sourceCapabilityRegistry";

const REPO_ROOT = resolve(__dirname, "..");

const REQUIRED_BOOTSTRAP_FILES = [
  "data/config/source_capabilities.free-only.json",
  "data/seeds/property_aliases.990-2301.sample.json",
  "data/seeds/source_coverage_candidates.990-2301.verified.sample.json",
  "data/prototype/jalan.multi-date.prototype.json"
];

const DB_UPDATE_SCRIPT_SOURCE = readFileSync(resolve(REPO_ROOT, "src/scripts/runAutoRunnerDbUpdateStub.ts"), "utf8");
const HEALTH_CHECK_SCRIPT_SOURCE = readFileSync(resolve(REPO_ROOT, "src/scripts/runAutoRunnerHealthCheck.ts"), "utf8");

function readBootstrapFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

// Secret detection keys on JSON property NAMES and PEM blocks, never on free-text
// values. This deliberately does not flag the benign Google Hotels entity-token
// value or the "metasearch_proxy" source_type label, which are public metadata.
const SECRET_KEY_PATTERN = /"(api_?key|secret|password|passwd|access_token|refresh_token|client_secret|private_key|cookie|session|bearer|proxy_password|auth_token)"\s*:/iu;
const PEM_PATTERN = /-----BEGIN[A-Z ]*PRIVATE KEY-----/u;

describe("AUTO-RUNNER-HANDOFF05X - required bootstrap files", () => {
  it.each(REQUIRED_BOOTSTRAP_FILES)("Required file is present and parses: %s", (relPath) => {
    const content = readBootstrapFile(relPath);
    expect(content.length).toBeGreaterThan(0);
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("Source-capability config is the registry default path", () => {
    expect(DEFAULT_SOURCE_CAPABILITY_PATH).toContain("source_capabilities.free-only.json");
  });

  it("loadSourceCapabilities locates the committed config", () => {
    const capabilities = loadSourceCapabilities(resolve(REPO_ROOT, DEFAULT_SOURCE_CAPABILITY_PATH));
    expect(capabilities).toBeTruthy();
    expect(JSON.stringify(capabilities).length).toBeGreaterThan(0);
  });
});

describe("AUTO-RUNNER-HANDOFF05X - bootstrap files contain no secrets", () => {
  it.each(REQUIRED_BOOTSTRAP_FILES)("No secret property names or PEM blocks: %s", (relPath) => {
    const content = readBootstrapFile(relPath);
    expect(SECRET_KEY_PATTERN.test(content)).toBe(false);
    expect(PEM_PATTERN.test(content)).toBe(false);
  });

  it("Benign Google Hotels entity token metadata is not treated as a secret", () => {
    const content = readBootstrapFile("data/seeds/source_coverage_candidates.990-2301.verified.sample.json");
    expect(content).toContain("entity token");
    expect(SECRET_KEY_PATTERN.test(content)).toBe(false);
  });
});

describe("AUTO-RUNNER-HANDOFF05X - default pipeline model fallback", () => {
  it("Default stage model has 13 stages and exposes the five risky gated stages", () => {
    const stages = buildDefaultPipelineStages();
    expect(stages.map((s) => s.stage_id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // The canonical risky stage ids {3,4,7,8,9} become enabled only when their
    // gates are all set; with everything enabled exactly five risky stages fire.
    const allGatesEnabled: Record<string, string> = {};
    for (const stage of stages) {
      for (const gate of stage.required_gates) {
        for (const token of gate.split(" or ")) {
          const [name, value] = token.split("=");
          if (name && value === "1") {
            allGatesEnabled[name] = "1";
          }
        }
      }
    }
    const stagePlan = buildStagePlan(stages, evaluateGates(allGatesEnabled));
    expect(buildSafetyConfirmation(stagePlan).risky_stages_enabled).toBe(5);
  });

  it("Default stage model with no gates enables zero risky stages and no mutation", () => {
    const stagePlan = buildStagePlan(buildDefaultPipelineStages(), evaluateGates({}));
    const safety = buildSafetyConfirmation(stagePlan);
    expect(safety.risky_stages_enabled).toBe(0);
    expect(safety.mutation_executed).toBe(false);
  });

  it("In-process runner summary needs no timestamped artifact and is non-mutating", () => {
    const summary = buildRunnerStubSummaryInProcess({
      historyDir: resolve(REPO_ROOT, ".data/history"),
      dbPath: resolve(REPO_ROOT, ".data/zao-market-intelligence.sqlite"),
      aiContextPath: resolve(REPO_ROOT, ".data/ai-context/latest_market_snapshot.json"),
      env: {}
    });
    expect(summary.decision).toBe("auto_runner_db_update_stub_ready_not_run");
    expect(summary.mutation_executed).toBe(false);
    expect(summary.risky_stages_enabled).toBe(0);
    expect(summary.risky_actual_executed_count).toBe(0);
    expect(summary.all_risky_actual_executed_false).toBe(true);
  });
});

describe("AUTO-RUNNER-HANDOFF05X - runners fall back without timestamped artifacts", () => {
  it("db-update runner globs latest artifact and falls back to default model", () => {
    expect(DB_UPDATE_SCRIPT_SOURCE).toContain("findLatestArtifact");
    expect(DB_UPDATE_SCRIPT_SOURCE).toContain("buildDefaultPipelineStages");
    // The hardcoded source artifact is only read when it actually exists.
    expect(DB_UPDATE_SCRIPT_SOURCE).toMatch(/existsSync\(SOURCE_AUTO_RUNNER07D_ARTIFACT_PATH\)/u);
  });

  it("health-check runner globs latest stub artifact and falls back in-process", () => {
    expect(HEALTH_CHECK_SCRIPT_SOURCE).toContain("findLatestArtifact");
    expect(HEALTH_CHECK_SCRIPT_SOURCE).toContain("buildRunnerStubSummaryInProcess");
    expect(HEALTH_CHECK_SCRIPT_SOURCE).toMatch(/existsSync\(SOURCE_AUTO_RUNNER07E_ARTIFACT_PATH\)/u);
  });

  it("findLatestArtifact uses read-only directory listing, not process execution", () => {
    const combined = DB_UPDATE_SCRIPT_SOURCE + HEALTH_CHECK_SCRIPT_SOURCE;
    expect(combined).toContain("readdirSync");
    expect(combined).not.toMatch(/execSync|execFileSync|spawn\(|child_process/u);
  });
});

describe("AUTO-RUNNER-HANDOFF05X - runners remain dry-run only", () => {
  it("No collector, sync, context-refresh, or pricing execution introduced", () => {
    const combined = DB_UPDATE_SCRIPT_SOURCE + HEALTH_CHECK_SCRIPT_SOURCE;
    expect(combined).not.toMatch(/runFreshHistoryToDbSync|syncHistoryToDbFresh|sync:history-to-db:fresh/u);
    expect(combined).not.toMatch(/build:ai-context-packs|buildAiContextPacks|runPost.*Refresh/u);
    expect(combined).not.toMatch(/probe:booking|probe:jalan|collect:/u);
    expect(combined).not.toMatch(/openLocalDatabase|applyRealSync|INSERT INTO|DELETE FROM|UPDATE market_signal/iu);
  });

  it("No browser automation, launchd, cron, or GitHub Actions introduced", () => {
    const combined = DB_UPDATE_SCRIPT_SOURCE + HEALTH_CHECK_SCRIPT_SOURCE;
    expect(combined).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage/u);
    expect(combined).not.toMatch(/launchctl|crontab|LaunchAgents|\.github\/workflows/u);
  });
});

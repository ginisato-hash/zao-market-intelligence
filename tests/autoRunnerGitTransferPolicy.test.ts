import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGitCheckIgnoreResult,
  buildTransferManifest,
  decideGitTransferPolicy,
  renderReport,
  summarizeGitCheckIgnore,
  summarizeGitignorePolicy,
  summarizeHistoryShards
} from "../src/services/autoRunnerGitTransferPolicy";

const ROOT = resolve(__dirname, "..");
const GITIGNORE = readFileSync(resolve(ROOT, ".gitignore"), "utf8");
const SERVICE_SOURCE = readFileSync(resolve(ROOT, "src/services/autoRunnerGitTransferPolicy.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(ROOT, "src/scripts/buildAutoRunnerGitTransferPolicy.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(ROOT, "package.json"), "utf8");

describe("AUTO-RUNNER-HANDOFF02X - .gitignore policy", () => {
  const policy = summarizeGitignorePolicy(GITIGNORE);

  it(".gitignore policy contains .data/*", () => {
    expect(policy.has_data_blanket_ignore).toBe(true);
  });

  it(".gitignore policy unignores .data/history/", () => {
    expect(policy.unignores_history_dir).toBe(true);
  });

  it(".gitignore policy unignores .data/history/zao_signals_*.csv", () => {
    expect(policy.unignores_history_shards).toBe(true);
  });

  it(".gitignore policy keeps .data/history/.backup ignored", () => {
    expect(policy.ignores_history_backup).toBe(true);
  });

  it(".gitignore policy keeps .data/debug ignored", () => {
    expect(policy.ignores_debug).toBe(true);
  });

  it(".gitignore policy keeps .data/screenshots ignored", () => {
    expect(policy.ignores_screenshots).toBe(true);
  });

  it(".gitignore policy keeps .data/reports ignored", () => {
    expect(policy.ignores_reports).toBe(true);
  });

  it(".gitignore policy keeps .data/ai-context ignored", () => {
    expect(policy.ignores_ai_context).toBe(true);
  });

  it(".gitignore policy keeps .data/run-state ignored", () => {
    expect(policy.ignores_run_state).toBe(true);
  });

  it(".gitignore policy keeps .logs ignored", () => {
    expect(policy.ignores_logs).toBe(true);
  });

  it(".gitignore policy keeps *.sqlite ignored", () => {
    expect(policy.ignores_sqlite).toBe(true);
  });

  it(".gitignore policy keeps .env and .env.* ignored", () => {
    expect(policy.ignores_env).toBe(true);
  });
});

describe("AUTO-RUNNER-HANDOFF02X - transfer manifest", () => {
  const manifest = buildTransferManifest();

  it("transfer manifest includes canonical history as commit candidate", () => {
    expect(manifest.commit_candidate).toContain(".data/history/zao_signals_*.csv");
  });

  it("transfer manifest classifies SQLite DB as regenerate", () => {
    expect(manifest.regenerate_on_always_on_mac).toContain(".data/zao-market-intelligence.sqlite");
  });

  it("transfer manifest classifies AI context as regenerate", () => {
    expect(manifest.regenerate_on_always_on_mac).toContain(".data/ai-context/**");
  });

  it("transfer manifest classifies debug/screenshots/reports/logs as ignore/archive", () => {
    expect(manifest.ignore_or_archive).toContain(".data/debug/**");
    expect(manifest.ignore_or_archive).toContain(".data/screenshots/**");
    expect(manifest.ignore_or_archive).toContain(".data/reports/**");
    expect(manifest.ignore_or_archive).toContain(".logs/**");
  });

  it("transfer manifest classifies secrets as never_commit", () => {
    expect(manifest.never_commit).toContain(".env");
    expect(manifest.never_commit.join(" ")).toContain("secrets");
  });
});

describe("AUTO-RUNNER-HANDOFF02X - verification helpers", () => {
  it("summarizes trackable history and ignored private/heavy paths", () => {
    const results = summarizeGitCheckIgnore([
      buildGitCheckIgnoreResult({
        path: ".data/history/zao_signals_2026_06.csv",
        raw: ".gitignore:47:!.data/history/zao_signals_*.csv\t.data/history/zao_signals_2026_06.csv\n",
        expected: "trackable"
      }),
      buildGitCheckIgnoreResult({
        path: ".data/debug",
        raw: ".gitignore:49:.data/debug/\t.data/debug\n",
        expected: "ignored"
      })
    ]);
    expect(results.history_trackable).toBe(true);
    expect(results.forbidden_paths_ignored).toBe(true);
    expect(results.all_passed).toBe(true);
  });

  it("summarizes history shard counts without modifying history", () => {
    const csv = [
      "row_id,source,schema_version",
      "a,booking,zao_local_history_v1",
      "b,jalan,zao_local_history_v1",
      "c,rakuten,zao_local_history_v1"
    ].join("\n");
    const summary = summarizeHistoryShards({ files: [{ path: ".data/history/fixture.csv", text: csv }] });
    expect(summary.history_row_count).toBe(3);
    expect(summary.duplicate_row_id_count).toBe(0);
    expect(summary.source_counts).toEqual({ booking: 1, jalan: 1, rakuten: 1 });
  });

  it("decision ready/basis_caution/not_ready", () => {
    expect(
      decideGitTransferPolicy({
        sourcePresent: false,
        gitignorePolicyReady: true,
        gitIgnoreVerificationPassed: true,
        historySummaryPassed: true,
        commitPushStillManual: true
      })
    ).toBe("auto_runner_git_transfer_policy_not_ready");
    expect(
      decideGitTransferPolicy({
        sourcePresent: true,
        gitignorePolicyReady: true,
        gitIgnoreVerificationPassed: true,
        historySummaryPassed: true,
        commitPushStillManual: true
      })
    ).toBe("auto_runner_git_transfer_policy_basis_caution");
    expect(
      decideGitTransferPolicy({
        sourcePresent: true,
        gitignorePolicyReady: true,
        gitIgnoreVerificationPassed: true,
        historySummaryPassed: true,
        commitPushStillManual: false
      })
    ).toBe("auto_runner_git_transfer_policy_ready");
  });

  it("renders report and package script", () => {
    expect(
      renderReport({
        generatedAtJst: "2026-06-06T00:20:00+09:00",
        decision: "auto_runner_git_transfer_policy_basis_caution",
        sourceHandoff01xPath: "handoff01x.json",
        before: summarizeGitignorePolicy(""),
        after: summarizeGitignorePolicy(GITIGNORE),
        gitCheckIgnoreSummary: summarizeGitCheckIgnore([]),
        history: summarizeHistoryShards({ files: [] }),
        manifest: buildTransferManifest(),
        risks: [],
        safety: {
          execution_location_current_implementation_mac: true,
          git_add: false,
          git_commit: false,
          git_push: false,
          git_tag: false,
          git_remote_change: false,
          github_release_created: false,
          gitignore_modified: true,
          history_modified: false,
          history_appended: false,
          db_write: false,
          db_sync: false,
          ai_context_refresh: false,
          query_smoke: false,
          live_booking_collection: false,
          live_jalan_collection: false,
          playwright_launch: false,
          browser_automation: false,
          external_fetch: false,
          launchd_cron_activation: false,
          github_actions_creation: false,
          pricing_csv_generation: false,
          pms_beds24_airhost_output: false,
          price_update: false,
          always_on_mac_commands_executed: false,
          started_auto_runner07g: false
        },
        nextPhase: "human approval"
      })
    ).toContain("Git Transfer Policy");
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-git-transfer-policy");
  });
});

describe("AUTO-RUNNER-HANDOFF02X - executable safety scans", () => {
  it("no git add/commit/push code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execFileSync\(\s*["']git["']\s*,\s*\[\s*["'](?:add|commit|push|tag|remote)["']/u);
  });

  it("no DB sync code exists", () => {
    expect(`${SERVICE_SOURCE}\n${SCRIPT_SOURCE}`).not.toMatch(/execFileSync\([^)]*(sync:history-to-db:fresh|real-run:history-to-db-sync|HISTORY_TO_DB_SYNC=1)/u);
  });

  it("no AI context refresh code exists", () => {
    expect(`${SERVICE_SOURCE}\n${SCRIPT_SOURCE}`).not.toMatch(/execFileSync\([^)]*(build:ai-context-packs|buildAiContextPacks)/u);
  });

  it("no collector/Playwright code exists", () => {
    expect(`${SERVICE_SOURCE}\n${SCRIPT_SOURCE}`).not.toMatch(/execFileSync\([^)]*(probe:booking|probe:jalan|collect:)|from\s+["']playwright|browser\.launch|newPage/u);
  });

  it("no pricing/PMS output code exists", () => {
    expect(`${SERVICE_SOURCE}\n${SCRIPT_SOURCE}`).not.toMatch(/execFileSync\([^)]*(pricing:|Beds24|AirHost|PMS_UPLOAD|OTA_UPLOAD)/u);
  });
});

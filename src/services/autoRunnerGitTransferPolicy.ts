// Phase AUTO-RUNNER-HANDOFF02X - Git transfer policy for always-on Mac handoff.
//
// Pure policy/report helpers. This module does not stage, commit, push,
// mutate history, write DB, refresh AI context, run collectors, or produce
// pricing/PMS outputs.

export type AutoRunnerGitTransferPolicyDecision =
  | "auto_runner_git_transfer_policy_ready"
  | "auto_runner_git_transfer_policy_basis_caution"
  | "auto_runner_git_transfer_policy_not_ready";

export interface GitignorePolicySummary {
  has_data_blanket_ignore: boolean;
  unignores_history_dir: boolean;
  unignores_history_shards: boolean;
  ignores_history_backup: boolean;
  ignores_debug: boolean;
  ignores_screenshots: boolean;
  ignores_reports: boolean;
  ignores_ai_context: boolean;
  ignores_run_state: boolean;
  ignores_logs: boolean;
  ignores_sqlite: boolean;
  ignores_env: boolean;
  policy_ready: boolean;
}

export interface GitCheckIgnoreResult {
  path: string;
  raw: string;
  ignored: boolean;
  trackable: boolean;
  matched_rule: string;
  expected: "trackable" | "ignored";
  passed: boolean;
}

export interface HistorySummary {
  shard_files: string[];
  history_row_count: number;
  duplicate_row_id_count: number;
  source_counts: Record<string, number>;
  schema_versions: string[];
  expected_counts_passed: boolean;
}

export interface TransferManifest {
  commit_candidate: string[];
  regenerate_on_always_on_mac: string[];
  ignore_or_archive: string[];
  never_commit: string[];
}

export interface SafetyConfirmation {
  execution_location_current_implementation_mac: true;
  git_add: false;
  git_commit: false;
  git_push: false;
  git_tag: false;
  git_remote_change: false;
  github_release_created: false;
  gitignore_modified: true;
  history_modified: false;
  history_appended: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_launch: false;
  browser_automation: false;
  external_fetch: false;
  launchd_cron_activation: false;
  github_actions_creation: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  always_on_mac_commands_executed: false;
  started_auto_runner07g: false;
}

export const REQUIRED_GITIGNORE_POLICY = [
  "# Zao Market Intelligence local data policy",
  ".data/*",
  "!.data/history/",
  "!.data/history/zao_signals_*.csv",
  ".data/history/.backup/",
  ".data/debug/",
  ".data/screenshots/",
  ".data/reports/",
  ".data/ai-context/",
  ".data/run-state/",
  ".logs/",
  "*.sqlite",
  ".env",
  ".env.*"
] as const;

export function summarizeGitignorePolicy(text: string): GitignorePolicySummary {
  const has = (rule: string): boolean => text.split(/\r?\n/u).some((line) => line.trim() === rule);
  const summary = {
    has_data_blanket_ignore: has(".data/*"),
    unignores_history_dir: has("!.data/history/"),
    unignores_history_shards: has("!.data/history/zao_signals_*.csv"),
    ignores_history_backup: has(".data/history/.backup/"),
    ignores_debug: has(".data/debug/"),
    ignores_screenshots: has(".data/screenshots/"),
    ignores_reports: has(".data/reports/"),
    ignores_ai_context: has(".data/ai-context/"),
    ignores_run_state: has(".data/run-state/"),
    ignores_logs: has(".logs/"),
    ignores_sqlite: has("*.sqlite"),
    ignores_env: has(".env") && has(".env.*")
  };
  return {
    ...summary,
    policy_ready: Object.values(summary).every(Boolean)
  };
}

export function buildGitCheckIgnoreResult(input: { path: string; raw: string; expected: "trackable" | "ignored" }): GitCheckIgnoreResult {
  const matchedRule = parseMatchedRule(input.raw);
  const trackable = matchedRule.startsWith("!");
  const ignored = matchedRule.length > 0 && !trackable;
  const passed = input.expected === "trackable" ? trackable : ignored;
  return {
    path: input.path,
    raw: input.raw,
    ignored,
    trackable,
    matched_rule: matchedRule,
    expected: input.expected,
    passed
  };
}

export function summarizeGitCheckIgnore(results: readonly GitCheckIgnoreResult[]): {
  history_trackable: boolean;
  forbidden_paths_ignored: boolean;
  all_passed: boolean;
  results: readonly GitCheckIgnoreResult[];
} {
  const historyResults = results.filter((result) => result.expected === "trackable");
  const forbiddenResults = results.filter((result) => result.expected === "ignored");
  return {
    history_trackable: historyResults.length > 0 && historyResults.every((result) => result.trackable && result.passed),
    forbidden_paths_ignored: forbiddenResults.length > 0 && forbiddenResults.every((result) => result.ignored && result.passed),
    all_passed: results.every((result) => result.passed),
    results
  };
}

export function summarizeHistoryShards(input: { files: Array<{ path: string; text: string }> }): HistorySummary {
  const rowIds: string[] = [];
  const sourceCounts: Record<string, number> = {};
  const schemaVersions = new Set<string>();

  for (const file of input.files) {
    const lines = file.text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (lines.length <= 1) continue;
    const header = parseCsvLine(lines[0] ?? "");
    const rowIdIndex = header.indexOf("row_id");
    const sourceIndex = header.indexOf("source");
    const schemaIndex = header.indexOf("schema_version");
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const rowId = cells[rowIdIndex] ?? "";
      const source = cells[sourceIndex] ?? "unknown";
      const schemaVersion = cells[schemaIndex] ?? "";
      rowIds.push(rowId);
      sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
      if (schemaVersion) schemaVersions.add(schemaVersion);
    }
  }

  const duplicateCount = rowIds.length - new Set(rowIds).size;
  return {
    shard_files: input.files.map((file) => file.path).sort(),
    history_row_count: rowIds.length,
    duplicate_row_id_count: duplicateCount,
    source_counts: sourceCounts,
    schema_versions: [...schemaVersions].sort(),
    expected_counts_passed: rowIds.length === 210 && duplicateCount === 0 && sourceCounts.booking === 46 && sourceCounts.jalan === 38 && sourceCounts.rakuten === 126
  };
}

export function buildTransferManifest(): TransferManifest {
  return {
    commit_candidate: [
      "src/**",
      "tests/**",
      "package.json",
      "package-lock.json",
      ".gitignore",
      "README/docs",
      ".data/history/zao_signals_*.csv"
    ],
    regenerate_on_always_on_mac: [".data/zao-market-intelligence.sqlite", ".data/ai-context/**"],
    ignore_or_archive: [".data/debug/**", ".data/screenshots/**", ".data/reports/**", ".data/run-state/**", ".logs/**"],
    never_commit: [".env", ".env.*", "secrets", "cookies", "PMS/Beds24/AirHost credentials", "paid proxy / CAPTCHA / stealth credentials"]
  };
}

export function buildRisks(): string[] {
  return [
    "git add/commit/push still require explicit human approval and are not performed in this phase.",
    "Canonical history shards are now trackable, so the next commit scope must be reviewed carefully.",
    "Large debug/report/screenshot artifacts remain ignored and may need a separate archive policy if audit transfer is required.",
    "Always-on Mac bootstrap has not been executed yet."
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
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
  };
}

export function decideGitTransferPolicy(input: {
  sourcePresent: boolean;
  gitignorePolicyReady: boolean;
  gitIgnoreVerificationPassed: boolean;
  historySummaryPassed: boolean;
  commitPushStillManual: boolean;
}): AutoRunnerGitTransferPolicyDecision {
  if (!input.sourcePresent || !input.gitignorePolicyReady || !input.gitIgnoreVerificationPassed || !input.historySummaryPassed) {
    return "auto_runner_git_transfer_policy_not_ready";
  }
  if (input.commitPushStillManual) return "auto_runner_git_transfer_policy_basis_caution";
  return "auto_runner_git_transfer_policy_ready";
}

export function renderTransferManifestCsv(manifest: TransferManifest): string {
  const rows = [["category", "path_or_pattern"]];
  for (const [category, entries] of Object.entries(manifest)) {
    for (const entry of entries) rows.push([category, entry]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerGitTransferPolicyDecision;
  sourceHandoff01xPath: string;
  before: GitignorePolicySummary;
  after: GitignorePolicySummary;
  gitCheckIgnoreSummary: ReturnType<typeof summarizeGitCheckIgnore>;
  history: HistorySummary;
  manifest: TransferManifest;
  risks: string[];
  safety: SafetyConfirmation;
  nextPhase: string;
}): string {
  return `# Git Transfer Policy for Always-On Mac Handoff

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary
AUTO-RUNNER-HANDOFF02X applies the minimal .gitignore history exception so canonical .data/history/zao_signals_*.csv shards can be tracked for GitHub transfer. It does not stage, commit, push, mutate history, write DB, refresh AI context, run collectors, create schedules, or produce pricing/PMS output.

## 2. Source HANDOFF01X Result
- Source artifact: ${input.sourceHandoff01xPath}

## 3. .gitignore Before / After
- Before policy ready: ${input.before.policy_ready}
- Before history shard exception: ${input.before.unignores_history_shards}
- After policy ready: ${input.after.policy_ready}
- After history shard exception: ${input.after.unignores_history_shards}
- After DB/debug/screenshots/reports/context/run-state/logs/secrets ignored: ${input.after.ignores_sqlite && input.after.ignores_debug && input.after.ignores_screenshots && input.after.ignores_reports && input.after.ignores_ai_context && input.after.ignores_run_state && input.after.ignores_logs && input.after.ignores_env}

## 4. Git Ignore Verification
${input.gitCheckIgnoreSummary.results.map((result) => `- ${result.path}: expected=${result.expected}, ignored=${result.ignored}, trackable=${result.trackable}, rule=${result.matched_rule || "none"}, passed=${result.passed}`).join("\n")}

## 5. History Summary
- history_row_count=${input.history.history_row_count}
- duplicate_row_id_count=${input.history.duplicate_row_id_count}
- source_counts=${JSON.stringify(input.history.source_counts)}
- schema_versions=${input.history.schema_versions.join(", ")}
- expected_counts_passed=${input.history.expected_counts_passed}

## 6. Transfer Manifest
- commit_candidate: ${input.manifest.commit_candidate.join("; ")}
- regenerate_on_always_on_mac: ${input.manifest.regenerate_on_always_on_mac.join("; ")}
- ignore_or_archive: ${input.manifest.ignore_or_archive.join("; ")}
- never_commit: ${input.manifest.never_commit.join("; ")}

## 7. Risks
${input.risks.map((risk) => `- ${risk}`).join("\n")}

## 8. Safety Confirmation
${Object.entries(input.safety).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## 9. Decision
${input.decision}

## 10. Next Phase
${input.nextPhase}
`;
}

function parseMatchedRule(raw: string): string {
  const firstLine = raw.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
  const match = firstLine.match(/^[^:]+:\d+:(.*?)\t/u);
  return match?.[1]?.trim() ?? "";
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

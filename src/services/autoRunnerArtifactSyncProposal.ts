// Phase AUTO-RUNNER06X - GitHub artifact sync / release archive proposal.
//
// Pure planning/report helpers only. This module does not mutate Git, create
// archives, run collectors, append history, sync DB, refresh AI context, or
// generate pricing/PMS output.

export type AutoRunnerArtifactSyncDecision =
  | "auto_runner_artifact_sync_proposal_ready"
  | "auto_runner_artifact_sync_proposal_basis_caution"
  | "auto_runner_artifact_sync_proposal_not_ready";

export interface CurrentStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number; role: string };
  jalan: { rows: number; directional: number; excluded: number; direct: number; role: string };
  rakuten: { rows: number; role: string };
}

export interface GitStatusSummary {
  tracked_file_count: number;
  status_entries: string[];
  modified_count: number;
  untracked_count: number;
  broad_uncommitted_tree: boolean;
  gitignore_blanket_ignores_data: boolean;
  gitignore_ignores_sqlite: boolean;
}

export interface DataSizeSummary {
  data_total: string;
  history: string;
  sqlite: string;
  ai_context: string;
  reports: string;
  debug: string;
  screenshots: string;
}

export interface ArtifactCategory {
  category: "commit_to_git" | "commit_or_policy_approval" | "regenerate_not_commit" | "archive_or_ignore" | "never_commit";
  examples: string[];
  reason: string;
}

export interface GithubTransferOption {
  option_id: "A" | "B" | "C" | "D";
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  recommendation: "primary" | "fallback" | "manual_fallback" | "caution_only";
}

export interface GitignoreRecommendation {
  description: string;
  future_rules: string[];
  do_not_apply_in_this_phase: true;
}

export interface ReleaseArchivePolicy {
  normal_archive_name: string;
  normal_archive_contents: string[];
  normal_archive_excludes: string[];
  heavy_archive_name: string;
  heavy_archive_rule: string;
}

export interface RestorePlan {
  steps: string[];
}

export interface IntegrityChecks {
  checks: string[];
  future_manifest_path_pattern: string;
}

export interface SafetyConfirmation {
  git_add: false;
  git_commit: false;
  git_push: false;
  git_tag: false;
  git_remote_change: false;
  github_release_creation: false;
  github_actions_creation: false;
  gitignore_modification: false;
  archive_creation: false;
  history_modification: false;
  history_append: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_launch: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  paid_apis_or_proxies: false;
  started_auto_runner07x: false;
}

export function buildCurrentStateSummary(input?: Partial<CurrentStateSummary>): CurrentStateSummary {
  return {
    history_rows: input?.history_rows ?? 210,
    db_rows: input?.db_rows ?? 210,
    ai_context_rows: input?.ai_context_rows ?? 210,
    booking: input?.booking ?? { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary directional backbone" },
    jalan: input?.jalan ?? { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary domestic OTA signal" },
    rakuten: input?.rakuten ?? { rows: 126, role: "frozen / caution" }
  };
}

export function buildGitStatusSummary(input: { trackedFiles: string[]; statusLines: string[]; gitignoreText: string }): GitStatusSummary {
  const modifiedCount = input.statusLines.filter((line) => /^[ MARCUD?!]{1,2}\s/.test(line) && !line.startsWith("?? ")).length;
  const untrackedCount = input.statusLines.filter((line) => line.startsWith("?? ")).length;
  return {
    tracked_file_count: input.trackedFiles.length,
    status_entries: input.statusLines,
    modified_count: modifiedCount,
    untracked_count: untrackedCount,
    broad_uncommitted_tree: input.statusLines.length > 10 || input.trackedFiles.length <= 2,
    gitignore_blanket_ignores_data: /^\.data\/$/m.test(input.gitignoreText),
    gitignore_ignores_sqlite: /^\*\.sqlite$/m.test(input.gitignoreText)
  };
}

export function buildArtifactCategoryMatrix(): ArtifactCategory[] {
  return [
    {
      category: "commit_to_git",
      examples: ["src/**", "tests/**", "package.json", "package-lock.json", "tsconfig/config files", "README.md", "docs/**"],
      reason: "Code, tests, and normal project metadata are small enough and required to reproduce the workflow."
    },
    {
      category: "commit_or_policy_approval",
      examples: [".data/history/zao_signals_*.csv"],
      reason: "Canonical market history is small and is the source of truth, but .data history tracking needs explicit Git policy approval."
    },
    {
      category: "regenerate_not_commit",
      examples: [".data/zao-market-intelligence.sqlite", ".data/ai-context/**"],
      reason: "SQLite DB and AI context packs are regenerable from canonical history and should not be normal Git payload."
    },
    {
      category: "archive_or_ignore",
      examples: [".data/reports/**", ".data/debug/**", ".data/screenshots/**", ".data/history/.backup/**"],
      reason: "Reports/debug/screenshots are useful audit artifacts but are large or noisy for routine Git commits."
    },
    {
      category: "never_commit",
      examples: [".env", ".env.*", "secrets", "cookies", "login state", "paid proxy keys", "CAPTCHA keys", "PMS/Beds24/AirHost credentials"],
      reason: "Secrets and session state must stay out of Git and archive bundles."
    }
  ];
}

export function buildGithubTransferOptions(): GithubTransferOption[] {
  return [
    {
      option_id: "A",
      name: "Git only, minimal",
      description: "Commit code, tests, config, and approved canonical history shards; regenerate DB/context on the always-on Mac.",
      pros: ["Small repository footprint.", "Simple restore path.", "Keeps generated/debug payload out of Git."],
      cons: ["Requires .gitignore policy change for .data/history.", "Does not carry full audit screenshots/debug by default."],
      recommendation: "primary"
    },
    {
      option_id: "B",
      name: "Git + release archive",
      description: "Use Git for code/history and attach selected reports/debug summaries to manually approved release archives.",
      pros: ["Good audit snapshots without bloating normal Git history.", "Can preserve important run evidence."],
      cons: ["Requires release policy and manual approval.", "Heavy screenshots still need discipline."],
      recommendation: "fallback"
    },
    {
      option_id: "C",
      name: "Git + manual artifact zip",
      description: "Commit code and transfer history or selected reports through a manual archive/cloud-drive handoff.",
      pros: ["Works before GitHub release policy exists.", "Human can inspect exact payload."],
      cons: ["More manual steps.", "Higher risk of stale or incomplete artifact transfer."],
      recommendation: "manual_fallback"
    },
    {
      option_id: "D",
      name: "Git LFS",
      description: "Use LFS only if repository policy explicitly allows selected large audit artifacts.",
      pros: ["Can keep chosen large files addressable from Git."],
      cons: ["Adds quota and workflow complexity.", "Not appropriate for routine debug screenshots."],
      recommendation: "caution_only"
    }
  ];
}

export function buildGitignoreRecommendations(): GitignoreRecommendation {
  return {
    description: "Future change should unignore only canonical history shards while leaving generated, large, and secret material ignored.",
    future_rules: [
      ".data/*",
      "!.data/history/",
      "!.data/history/zao_signals_*.csv",
      ".data/history/.backup/",
      ".data/debug/",
      ".data/screenshots/",
      ".data/reports/",
      ".data/ai-context/",
      "*.sqlite",
      ".env",
      ".env.*",
      "!.env.example"
    ],
    do_not_apply_in_this_phase: true
  };
}

export function buildReleaseArchivePolicy(): ReleaseArchivePolicy {
  return {
    normal_archive_name: "zmi-artifact-snapshot-YYYYMMDD-HHmmss.zip",
    normal_archive_contents: [
      ".data/reports/automation/*.md",
      ".data/reports/automation/*.json",
      ".data/reports/source-discovery/*.md",
      ".data/reports/source-discovery/*.json",
      "selected .data/debug/** summary JSON only"
    ],
    normal_archive_excludes: ["screenshots by default", ".env / .env.*", "SQLite DB by default", "cookies/login state", "paid proxy or CAPTCHA keys"],
    heavy_archive_name: "zmi-heavy-debug-snapshot-YYYYMMDD-HHmmss.zip",
    heavy_archive_rule: "Create only by manual approval when screenshot or full debug evidence is required for audit."
  };
}

export function buildAlwaysOnMacRestorePlan(): RestorePlan {
  return {
    steps: [
      "On the always-on Mac, pull or clone the approved repository branch.",
      "Verify .data/history/zao_signals_*.csv exists after Git policy is approved, or restore the approved history artifact bundle.",
      "Check history row count, source counts, duplicate row_id count, and schema_version before any DB regeneration.",
      "Regenerate DB from canonical history using the future stale-pointer-safe bootstrap command.",
      "Run db:verify.",
      "Rebuild AI context after DB/history are verified.",
      "Run read-only pricing_support/data-quality smoke checks in a later gated bootstrap phase."
    ]
  };
}

export function buildIntegrityChecks(): IntegrityChecks {
  return {
    checks: [
      "history row count equals expected baseline",
      "source counts match manifest",
      "duplicate row_id count is zero",
      "schema_version is zao_local_history_v1",
      "sha256 hash for each history shard",
      "artifact manifest JSON lists included files, sizes, and hashes",
      "DB row count matches history after regeneration",
      "AI context row count matches history/DB after rebuild"
    ],
    future_manifest_path_pattern: ".data/artifact-manifests/zmi_manifest_YYYYMMDD_HHmmss.json"
  };
}

export function buildRecommendedTransferStrategy(): string {
  return "Primary: Option A, Git-only minimal code/tests/config plus approved canonical history shards. Fallback: Option B, manually approved GitHub Release archive for selected audit reports/debug summaries.";
}

export function buildRisks(summary: GitStatusSummary): string[] {
  const risks = [
    "Actual Git policy and release archive policy require human approval.",
    "Current .gitignore blanket-ignores .data/, so canonical history will not transfer through Git until a future policy change is made.",
    "Large debug/screenshots can bloat GitHub artifacts if not excluded by default.",
    "SQLite DB and AI context must be regenerated, not treated as canonical.",
    "Secrets/cookies/login state must remain excluded from both Git and archives."
  ];
  if (summary.broad_uncommitted_tree) {
    risks.push("Current working tree is broad and uncommitted; manual review is needed before any stable runner branch or release archive.");
  }
  return risks;
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    git_add: false,
    git_commit: false,
    git_push: false,
    git_tag: false,
    git_remote_change: false,
    github_release_creation: false,
    github_actions_creation: false,
    gitignore_modification: false,
    archive_creation: false,
    history_modification: false,
    history_append: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    live_booking_collection: false,
    live_jalan_collection: false,
    playwright_launch: false,
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    paid_apis_or_proxies: false,
    started_auto_runner07x: false
  };
}

export function decideAutoRunnerArtifactSync(input: {
  sourcePresent: boolean;
  gitignoreBlanketIgnoresData: boolean;
  broadUncommittedTree: boolean;
}): AutoRunnerArtifactSyncDecision {
  if (!input.sourcePresent) {
    return "auto_runner_artifact_sync_proposal_not_ready";
  }
  if (input.gitignoreBlanketIgnoresData || input.broadUncommittedTree) {
    return "auto_runner_artifact_sync_proposal_basis_caution";
  }
  return "auto_runner_artifact_sync_proposal_ready";
}

export function renderCategoryCsv(categories: readonly ArtifactCategory[]): string {
  const rows = [["category", "examples", "reason"]];
  for (const item of categories) {
    rows.push([item.category, item.examples.join("; "), item.reason]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerArtifactSyncDecision;
  sourceArtifactPath: string;
  current: CurrentStateSummary;
  git: GitStatusSummary;
  sizes: DataSizeSummary;
  categories: ArtifactCategory[];
  options: GithubTransferOption[];
  recommendedStrategy: string;
  gitignore: GitignoreRecommendation;
  release: ReleaseArchivePolicy;
  restore: RestorePlan;
  integrity: IntegrityChecks;
  risks: string[];
  safety: SafetyConfirmation;
}): string {
  return `# GitHub Artifact Sync / Release Archive Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary
AUTO-RUNNER06X proposes a minimal Git-first artifact transfer model: keep code/tests/config in Git, include canonical history shards only after explicit policy approval, regenerate DB/context, and archive selected reports/debug outside normal Git history.

## 2. Source AUTO-RUNNER05X Result
- Source artifact: ${input.sourceArtifactPath}

## 3. Current State
- History rows: ${input.current.history_rows}
- DB rows: ${input.current.db_rows}
- AI context rows: ${input.current.ai_context_rows}
- Booking: ${input.current.booking.rows} rows, ${input.current.booking.directional} directional, ${input.current.booking.excluded} excluded, ${input.current.booking.direct} direct
- Jalan: ${input.current.jalan.rows} rows, ${input.current.jalan.directional} directional, ${input.current.jalan.excluded} excluded, ${input.current.jalan.direct} direct
- Rakuten: ${input.current.rakuten.rows} rows, ${input.current.rakuten.role}

## 4. Git / Repository State
- Tracked files: ${input.git.tracked_file_count}
- Modified entries: ${input.git.modified_count}
- Untracked entries: ${input.git.untracked_count}
- Blanket .data ignore detected: ${input.git.gitignore_blanket_ignores_data}
- SQLite ignore detected: ${input.git.gitignore_ignores_sqlite}

## 5. Data Size Summary
- .data total: ${input.sizes.data_total}
- history: ${input.sizes.history}
- sqlite: ${input.sizes.sqlite}
- ai-context: ${input.sizes.ai_context}
- reports: ${input.sizes.reports}
- debug: ${input.sizes.debug}
- screenshots: ${input.sizes.screenshots}

## 6. Artifact Category Matrix
${input.categories.map((item) => `- ${item.category}: ${item.examples.join(", ")} — ${item.reason}`).join("\n")}

## 7. GitHub Transfer Options
${input.options.map((option) => `- Option ${option.option_id} (${option.name}): ${option.description} Recommendation: ${option.recommendation}.`).join("\n")}

## 8. Recommended Strategy
${input.recommendedStrategy}

## 9. Future .gitignore Recommendation
Do not modify .gitignore in AUTO-RUNNER06X. Future rules:

\`\`\`gitignore
${input.gitignore.future_rules.join("\n")}
\`\`\`

## 10. Release Archive Policy
- Normal archive: ${input.release.normal_archive_name}
- Contents: ${input.release.normal_archive_contents.join("; ")}
- Excludes: ${input.release.normal_archive_excludes.join("; ")}
- Heavy archive: ${input.release.heavy_archive_name}; ${input.release.heavy_archive_rule}

## 11. Always-On Mac Restore Plan
${input.restore.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## 12. Integrity Checks
${input.integrity.checks.map((check) => `- ${check}`).join("\n")}
- Future manifest path: ${input.integrity.future_manifest_path_pattern}

## 13. Risks
${input.risks.map((risk) => `- ${risk}`).join("\n")}

## 14. Safety Confirmation
${Object.entries(input.safety).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## 15. Decision
${input.decision}

## 16. Next Phase
AUTO-RUNNER07X — price decision report runner, no CSV
`;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

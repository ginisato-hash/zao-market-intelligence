// Phase AUTO-RUNNER01X — Repository / artifact migration plan implementation
// PROPOSAL (engine).
//
// PROPOSAL / DESIGN ONLY. This module assembles a concrete plan for moving the
// Zao Market Intelligence system from the current implementation Mac to the
// separate always-on Mac, via GitHub code + canonical-history transfer. It
// performs NO git operations, writes NO history, NO DB rows, runs NO live
// request / browser automation / collector, creates NO GitHub Actions / launchd
// / cron file, emits NO property-management or channel-manager output, and
// performs NO price update. It only reads current state (supplied by the caller)
// and returns design documents to be rendered into a report.

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type MigrationDecision =
  | "auto_runner_migration_proposal_ready"
  | "auto_runner_migration_proposal_basis_caution"
  | "auto_runner_migration_proposal_not_ready";

export const EXPECTED_HISTORY_ROWS = 210;
export const EXPECTED_DB_ROWS = 210;

// ---------------------------------------------------------------------------
// Current repository state
// ---------------------------------------------------------------------------

export interface CurrentRepoState {
  trackedFileCount: number;
  uncommittedEntryCount: number;
  gitignoreIgnoresDataDir: boolean; // .gitignore currently blanket-ignores .data/
  gitignoreIgnoresSqlite: boolean;
  envExamplePresent: boolean;
  auto00xArtifactPath: string;
  auto00xArtifactPresent: boolean;
}

// ---------------------------------------------------------------------------
// Canonical data inventory
// ---------------------------------------------------------------------------

export type DataKind = "canonical" | "regenerable" | "audit_artifact" | "heavy_artifact" | "secret" | "dependency";

export interface CanonicalDataEntry {
  path: string;
  kind: DataKind;
  approxSize: string;
  isCanonical: boolean;
  note: string;
}

export interface CanonicalDataInventory {
  historyRows: number;
  dbRows: number;
  aiContextRows: number;
  bookingRows: number;
  jalanRows: number;
  rakutenRows: number;
  entries: CanonicalDataEntry[];
}

// ---------------------------------------------------------------------------
// Commit / ignore / archive matrix
// ---------------------------------------------------------------------------

export type MatrixAction = "commit" | "ignore" | "archive" | "regenerate" | "never_commit";

export interface MatrixEntry {
  pathOrPattern: string;
  category: DataKind | "source" | "config" | "logs";
  recommendedAction: MatrixAction;
  reason: string;
  risk: string;
  requiredForAlwaysOnMac: boolean;
}

export function buildCommitIgnoreArchiveMatrix(): MatrixEntry[] {
  return [
    {
      pathOrPattern: "src/**",
      category: "source",
      recommendedAction: "commit",
      reason: "Application source; required to run anywhere.",
      risk: "none",
      requiredForAlwaysOnMac: true
    },
    {
      pathOrPattern: "tests/**",
      category: "source",
      recommendedAction: "commit",
      reason: "Test suite; required for verification on the target Mac.",
      risk: "none",
      requiredForAlwaysOnMac: true
    },
    {
      pathOrPattern: "package.json",
      category: "config",
      recommendedAction: "commit",
      reason: "Scripts + dependency manifest.",
      risk: "none",
      requiredForAlwaysOnMac: true
    },
    {
      pathOrPattern: "package-lock.json",
      category: "config",
      recommendedAction: "commit",
      reason: "Deterministic install on the target Mac.",
      risk: "none",
      requiredForAlwaysOnMac: true
    },
    {
      pathOrPattern: "tsconfig.json / vitest / playwright.config.ts / wrangler.toml",
      category: "config",
      recommendedAction: "commit",
      reason: "Build/test/runtime configuration.",
      risk: "none",
      requiredForAlwaysOnMac: true
    },
    {
      pathOrPattern: ".data/history/zao_signals_*.csv",
      category: "canonical",
      recommendedAction: "commit",
      reason: "Canonical source of truth (~1.5M); DB + AI context are regenerated from it.",
      risk: "POLICY APPROVAL REQUIRED: current .gitignore blanket-ignores .data/; needs a negation rule before this can be committed.",
      requiredForAlwaysOnMac: true
    },
    {
      pathOrPattern: ".data/zao-market-intelligence.sqlite",
      category: "regenerable",
      recommendedAction: "regenerate",
      reason: "DB mirror (~3.1M) is regenerated from .data/history; not canonical.",
      risk: "Committing the binary causes drift vs canonical history.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".data/ai-context/**",
      category: "regenerable",
      recommendedAction: "regenerate",
      reason: "AI context packs (~72K) are rebuilt from the DB mirror.",
      risk: "Stale context if committed instead of rebuilt.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".data/reports/automation/*.json",
      category: "audit_artifact",
      recommendedAction: "archive",
      reason: "Audit/verification reports (79 files); keep latest summaries, archive the rest.",
      risk: "Repo bloat if all 12M committed.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".data/reports/automation/*.md",
      category: "audit_artifact",
      recommendedAction: "archive",
      reason: "Human-readable reports; archive bundle or keep only latest.",
      risk: "Repo bloat.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".data/reports/source-discovery/*.json",
      category: "audit_artifact",
      recommendedAction: "archive",
      reason: "Source-discovery audit artifacts; archive, not required to run.",
      risk: "Repo bloat.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".data/debug/**",
      category: "heavy_artifact",
      recommendedAction: "ignore",
      reason: "Debug HTML/JSON dumps (~418M, 3400+ files); not required to run.",
      risk: "Severe repo bloat / unusable clone if committed.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".data/screenshots/**",
      category: "heavy_artifact",
      recommendedAction: "ignore",
      reason: "Collection screenshots (~751M); audit-only, archive externally if needed.",
      risk: "Severe repo bloat; consider Releases/LFS only if policy supports it.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".data/history/.backup/**",
      category: "heavy_artifact",
      recommendedAction: "ignore",
      reason: "Local pre-append backups (~1.2M); machine-local safety, regenerated per append.",
      risk: "Confusion vs canonical shards if committed.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: "logs/** , *.log",
      category: "logs",
      recommendedAction: "ignore",
      reason: "Runtime logs; never needed in VCS.",
      risk: "Noise / possible sensitive content.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: "node_modules/**",
      category: "dependency",
      recommendedAction: "ignore",
      reason: "Reinstalled via npm install on the target Mac.",
      risk: "Huge, platform-specific binaries.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".env",
      category: "secret",
      recommendedAction: "never_commit",
      reason: "Secrets; installed manually on the target Mac.",
      risk: "CRITICAL: credential leak if committed.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: ".env.local / .env.*",
      category: "secret",
      recommendedAction: "never_commit",
      reason: "Secrets; only .env.example (placeholders) may be committed.",
      risk: "CRITICAL: credential leak if committed.",
      requiredForAlwaysOnMac: false
    },
    {
      pathOrPattern: "screenshots (top-level review zips, *.zip)",
      category: "heavy_artifact",
      recommendedAction: "ignore",
      reason: "Ad-hoc review packets at repo root; archive externally.",
      risk: "Repo bloat.",
      requiredForAlwaysOnMac: false
    }
  ];
}

// ---------------------------------------------------------------------------
// .gitignore recommendations
// ---------------------------------------------------------------------------

export interface GitignoreRecommendations {
  problem: string;
  proposedAdditions: string[];
  rationale: string;
}

export function buildGitignoreRecommendations(state: CurrentRepoState): GitignoreRecommendations {
  return {
    problem: state.gitignoreIgnoresDataDir
      ? "Current .gitignore blanket-ignores `.data/`, so the canonical `.data/history` shards would NOT be committed and could not transfer to the always-on Mac."
      : "`.data/` is not blanket-ignored.",
    proposedAdditions: [
      "# AUTO-RUNNER01X proposed: keep ignoring .data, but allow canonical history shards",
      ".data/*",
      "!.data/history/",
      ".data/history/*",
      "!.data/history/zao_signals_*.csv",
      "# keep ignoring regenerable + heavy artifacts explicitly",
      ".data/zao-market-intelligence.sqlite",
      ".data/ai-context/",
      ".data/debug/",
      ".data/screenshots/",
      ".data/history/.backup/",
      "# secrets (already covered; keep)",
      ".env",
      ".env.*",
      "!.env.example"
    ],
    rationale:
      "Negate the blanket .data ignore for ONLY the canonical CSV shards so history transfers via git, while the SQLite DB, AI context, debug, screenshots, and local backups stay ignored and are regenerated/archived on the target Mac. Requires human approval before applying — not changed in this phase."
  };
}

// ---------------------------------------------------------------------------
// Artifact transfer plan
// ---------------------------------------------------------------------------

export interface ArtifactTransferPlan {
  flow: string;
  options: Array<{ id: string; description: string; recommended: boolean }>;
}

export function buildArtifactTransferPlan(): ArtifactTransferPlan {
  return {
    flow: "current_implementation_mac -> github (code + canonical history) -> always_on_mac (clone + regenerate)",
    options: [
      { id: "A", description: "Do not commit heavy reports/debug; archive manually as zip.", recommended: true },
      { id: "B", description: "Keep only latest summary reports in git.", recommended: true },
      { id: "C", description: "Use GitHub Releases / artifact zip for historical debug bundles.", recommended: true },
      { id: "D", description: "Git LFS for large artifacts only if repository policy supports it.", recommended: false }
    ]
  };
}

// ---------------------------------------------------------------------------
// Bootstrap + verification sequences
// ---------------------------------------------------------------------------

export function buildBootstrapSequence(): string[] {
  return [
    "git clone <repo-url>",
    "cd zao-market-intelligence",
    "npm install",
    "npm run typecheck",
    "npm run test",
    "npm run check:no-paid-sources",
    "# verify canonical history shards are present (expect 210 rows)",
    "ls .data/history/zao_signals_*.csv",
    "# regenerate DB mirror from canonical history (gated)",
    "npm run dry-run:history-to-db-sync",
    "HISTORY_TO_DB_SYNC=1 npm run real-run:history-to-db-sync",
    "# rebuild AI context from DB",
    "npm run build:ai-context-packs",
    "# final verification",
    "npm run db:verify",
    "npm run query:ai-task -- --task pricing_support --start 2026-06-01 --end 2026-12-31"
  ];
}

export function buildVerificationSequence(): string[] {
  return [
    "npm run typecheck — source compiles",
    "npm run test — full suite green",
    "npm run check:no-paid-sources — guard passes",
    "history row count == 210 (canonical)",
    "after gated sync: DB market_signal_history == 210 (booking 46 / jalan 38 / rakuten 126)",
    "npm run db:verify — collector baseline unchanged",
    "AI context row basis == 210"
  ];
}

// ---------------------------------------------------------------------------
// Rollback / backup + secret policy
// ---------------------------------------------------------------------------

export interface RollbackBackupPolicy {
  beforeMigration: string[];
  rollback: string[];
}

export function buildRollbackBackupPolicy(): RollbackBackupPolicy {
  return {
    beforeMigration: [
      "Tag a reproducible pre-migration commit/release on the source Mac.",
      "Keep .data/history/.backup local snapshots on the source Mac (do not delete).",
      "Archive current .data/reports + .data/debug as an external zip before any cleanup."
    ],
    rollback: [
      "DB is regenerable: if a target-Mac sync is wrong, delete the SQLite file and re-run the gated sync from canonical history.",
      "AI context is regenerable: rebuild from DB.",
      "Canonical history is the only irreplaceable asset: never overwrite shards without a backup; git history provides versioning once committed."
    ]
  };
}

export function buildSecretEnvironmentPolicy(): string[] {
  return [
    ".env is never committed",
    ".env.example may be committed (placeholders only)",
    "secrets installed manually on the always-on Mac",
    "no Booking/Jalan login cookies",
    "no paid proxy keys",
    "no CAPTCHA service keys",
    "no PMS/Beds24/AirHost upload credentials in this runner phase"
  ];
}

// ---------------------------------------------------------------------------
// Future phase plan
// ---------------------------------------------------------------------------

export interface FuturePhase {
  id: string;
  objective: string;
  allowed: string;
  forbidden: string;
  gates: string;
  successCriteria: string;
}

export function buildFuturePhasePlan(): FuturePhase[] {
  return [
    {
      id: "AUTO-RUNNER02X",
      objective: "Local Mac bootstrap script proposal",
      allowed: "Design bootstrap script content",
      forbidden: "No install; no execution",
      gates: "none (proposal)",
      successCriteria: "Bootstrap script draft + checklist"
    },
    {
      id: "AUTO-RUNNER03X",
      objective: "Manual end-to-end runner script, collectors disabled by default",
      allowed: "Design manual orchestrator over existing gated steps",
      forbidden: "No schedule; no auto collection",
      gates: "existing per-step gates",
      successCriteria: "Manual runner runs stages on demand"
    },
    {
      id: "AUTO-RUNNER04X",
      objective: "launchd schedule proposal, disabled",
      allowed: "Design launchd plist + cadence",
      forbidden: "No plist installation; no activation",
      gates: "none (proposal)",
      successCriteria: "Schedule design + plist draft"
    },
    {
      id: "AUTO-RUNNER05X",
      objective: "Bounded collector schedule implementation, disabled by default",
      allowed: "Implement scheduling wiring disabled by default",
      forbidden: "No enablement; no live run",
      gates: "COLLECT_* off by default",
      successCriteria: "Wiring present but inert"
    },
    {
      id: "AUTO-RUNNER06X",
      objective: "GitHub artifact sync / release archive proposal",
      allowed: "Design reviewed artifact sync / release bundles",
      forbidden: "No auto-push of data",
      gates: "manual review gate",
      successCriteria: "Artifact sync plan"
    },
    {
      id: "AUTO-RUNNER07X",
      objective: "Price decision report runner, no CSV",
      allowed: "Design read-only price decision reporting",
      forbidden: "No CSV; no PMS output",
      gates: "none (read-only)",
      successCriteria: "Decision report design"
    },
    {
      id: "AUTO-RUNNER08X",
      objective: "Miuraya pricing CSV generation proposal, gated",
      allowed: "Design gated CSV generation for manual review",
      forbidden: "No PMS/Beds24/AirHost upload; no auto price update",
      gates: "GENERATE_PRICE_CSV=1 (off by default)",
      successCriteria: "Gated CSV proposal"
    }
  ];
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideMigration(state: CurrentRepoState, inventory: CanonicalDataInventory): MigrationDecision {
  // not_ready: current state cannot be verified or essential artifacts missing.
  if (inventory.historyRows <= 0 || !state.auto00xArtifactPresent) {
    return "auto_runner_migration_proposal_not_ready";
  }
  // ready: history readable AND git policy already permits canonical-data commit
  // (no human approval needed). In practice .data is blanket-ignored, so this is
  // rarely hit.
  if (
    inventory.historyRows === EXPECTED_HISTORY_ROWS &&
    !state.gitignoreIgnoresDataDir &&
    state.envExamplePresent
  ) {
    return "auto_runner_migration_proposal_ready";
  }
  // basis_caution: plan is workable but the canonical-data commit + .gitignore
  // change require explicit human approval.
  return "auto_runner_migration_proposal_basis_caution";
}

// ---------------------------------------------------------------------------
// Full proposal assembly
// ---------------------------------------------------------------------------

export interface MigrationProposal {
  currentRepoState: CurrentRepoState;
  canonicalDataInventory: CanonicalDataInventory;
  commitIgnoreArchiveMatrix: MatrixEntry[];
  gitignoreRecommendations: GitignoreRecommendations;
  artifactTransferPlan: ArtifactTransferPlan;
  bootstrapSequence: string[];
  verificationSequence: string[];
  rollbackBackupPolicy: RollbackBackupPolicy;
  secretEnvironmentPolicy: string[];
  futurePhasePlan: FuturePhase[];
  risks: string[];
}

export function buildMigrationProposal(
  state: CurrentRepoState,
  inventory: CanonicalDataInventory
): MigrationProposal {
  const risks: string[] = [
    "always_on_mac_is_a_different_machine_requiring_careful_first_transfer",
    "current_repo_has_almost_nothing_committed_initial_commit_set_needs_review",
    "heavy_debug_and_screenshot_artifacts_must_be_kept_out_of_git",
    "live_ota_collection_must_run_on_always_on_mac_not_cloud_ip"
  ];
  if (state.gitignoreIgnoresDataDir) {
    risks.push("gitignore_blanket_ignores_data_canonical_history_needs_negation_rule_and_human_approval");
  }
  return {
    currentRepoState: state,
    canonicalDataInventory: inventory,
    commitIgnoreArchiveMatrix: buildCommitIgnoreArchiveMatrix(),
    gitignoreRecommendations: buildGitignoreRecommendations(state),
    artifactTransferPlan: buildArtifactTransferPlan(),
    bootstrapSequence: buildBootstrapSequence(),
    verificationSequence: buildVerificationSequence(),
    rollbackBackupPolicy: buildRollbackBackupPolicy(),
    secretEnvironmentPolicy: buildSecretEnvironmentPolicy(),
    futurePhasePlan: buildFuturePhasePlan(),
    risks
  };
}

// ---------------------------------------------------------------------------
// CSV rendering (one row per matrix entry)
// ---------------------------------------------------------------------------

export const MIGRATION_CSV_HEADERS = [
  "path_or_pattern",
  "category",
  "recommended_action",
  "required_for_always_on_mac",
  "risk",
  "reason"
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

export function renderMigrationCsv(matrix: readonly MatrixEntry[]): string {
  const body = matrix.map((m) =>
    [m.pathOrPattern, m.category, m.recommendedAction, String(m.requiredForAlwaysOnMac), m.risk, m.reason]
      .map(csvEscape)
      .join(",")
  );
  return [MIGRATION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export interface MigrationReportInput {
  generatedAtJst: string;
  runId: string;
  decision: MigrationDecision;
  sourceAuto00xArtifact: string;
  proposal: MigrationProposal;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugRootPath: string;
}

export function renderMigrationReport(input: MigrationReportInput): string {
  const p = input.proposal;
  const s = p.currentRepoState;
  const inv = p.canonicalDataInventory;
  const gi = p.gitignoreRecommendations;
  return [
    "# Auto Runner Migration Proposal",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Executive Summary",
    "",
    "- PROPOSAL / DESIGN ONLY. No git add/commit/push, no Actions/launchd/cron, no collection, no mutation.",
    "- Concrete plan to move code + canonical history from the implementation Mac to the always-on Mac via GitHub, regenerating DB + AI context on arrival.",
    `- source AUTO-RUNNER00X artifact: ${input.sourceAuto00xArtifact}`,
    `- decision=${input.decision}`,
    "",
    "## 2. Current Repository State",
    "",
    `- tracked_file_count=${s.trackedFileCount}`,
    `- uncommitted_entry_count=${s.uncommittedEntryCount}`,
    `- gitignore_blanket_ignores_data=${s.gitignoreIgnoresDataDir}`,
    `- gitignore_ignores_sqlite=${s.gitignoreIgnoresSqlite}`,
    `- env_example_present=${s.envExamplePresent}`,
    `- auto00x_artifact_present=${s.auto00xArtifactPresent}`,
    "",
    "## 3. Canonical Data Inventory",
    "",
    `- history_rows=${inv.historyRows} (CANONICAL source of truth)`,
    `- db_rows=${inv.dbRows} (regenerable)`,
    `- ai_context_rows=${inv.aiContextRows} (regenerable)`,
    `- booking=${inv.bookingRows} / jalan=${inv.jalanRows} / rakuten=${inv.rakutenRows}`,
    "",
    "| path | kind | size | canonical | note |",
    "|---|---|---|---|---|",
    ...inv.entries.map((e) => `| ${e.path} | ${e.kind} | ${e.approxSize} | ${e.isCanonical} | ${e.note} |`),
    "",
    "## 4. Commit / Ignore / Archive Matrix",
    "",
    "| path_or_pattern | category | action | required | risk |",
    "|---|---|---|---|---|",
    ...p.commitIgnoreArchiveMatrix.map(
      (m) => `| ${m.pathOrPattern} | ${m.category} | ${m.recommendedAction} | ${m.requiredForAlwaysOnMac} | ${m.risk} |`
    ),
    "",
    "### Proposed .gitignore changes (NOT applied in this phase)",
    "",
    `- problem: ${gi.problem}`,
    "- proposed additions:",
    "```",
    ...gi.proposedAdditions,
    "```",
    `- rationale: ${gi.rationale}`,
    "",
    "## 5. GitHub Transfer Plan",
    "",
    `- flow: ${p.artifactTransferPlan.flow}`,
    "- options:",
    ...p.artifactTransferPlan.options.map((o) => `  - [${o.id}] ${o.description} ${o.recommended ? "(recommended)" : ""}`),
    "",
    "## 6. Always-On Mac Bootstrap Sequence",
    "",
    "Future sequence only — DO NOT run in this phase:",
    "",
    "```bash",
    ...p.bootstrapSequence,
    "```",
    "",
    "## 7. Verification Sequence",
    "",
    ...p.verificationSequence.map((v) => `- ${v}`),
    "",
    "## 8. Rollback / Backup Policy",
    "",
    "Before migration:",
    "",
    ...p.rollbackBackupPolicy.beforeMigration.map((x) => `- ${x}`),
    "",
    "Rollback:",
    "",
    ...p.rollbackBackupPolicy.rollback.map((x) => `- ${x}`),
    "",
    "## 9. Secret / Environment Policy",
    "",
    ...p.secretEnvironmentPolicy.map((x) => `- ${x}`),
    "",
    "## 10. Future Phase Plan",
    "",
    "| phase | objective | gates | success |",
    "|---|---|---|---|",
    ...p.futurePhasePlan.map((f) => `| ${f.id} | ${f.objective} | ${f.gates} | ${f.successCriteria} |`),
    "",
    "## 11. Risks",
    "",
    ...p.risks.map((r) => `- ${r}`),
    "",
    "## 12. Safety Confirmation",
    "",
    "- No git add/commit/push, no remote changes, no GitHub Actions, no launchd/cron, no live collection, no Playwright, no external fetch, no history/DB/context mutation, no pricing CSV, no PMS/Beds24/AirHost output, no paid sources.",
    "",
    "## 13. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 14. Next Phase",
    "",
    "- AUTO-RUNNER02X — Local Mac bootstrap script proposal (do not start without explicit instruction).",
    "",
    "## Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    ""
  ].join("\n");
}

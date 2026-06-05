import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildArtifactTransferPlan,
  buildBootstrapSequence,
  buildCommitIgnoreArchiveMatrix,
  buildFuturePhasePlan,
  buildGitignoreRecommendations,
  buildMigrationProposal,
  buildSecretEnvironmentPolicy,
  buildVerificationSequence,
  decideMigration,
  MIGRATION_CSV_HEADERS,
  renderMigrationCsv,
  renderMigrationReport,
  type CanonicalDataEntry,
  type CanonicalDataInventory,
  type CurrentRepoState
} from "../src/services/autoRunnerMigrationProposal";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/autoRunnerMigrationProposal.ts"),
  "utf8"
);
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildAutoRunnerMigrationProposal.ts"),
  "utf8"
);
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function entries(): CanonicalDataEntry[] {
  return [
    { path: ".data/history/zao_signals_*.csv", kind: "canonical", approxSize: "~1.5M", isCanonical: true, note: "truth" },
    { path: ".data/zao-market-intelligence.sqlite", kind: "regenerable", approxSize: "~3.1M", isCanonical: false, note: "mirror" }
  ];
}

function inventory(overrides: Partial<CanonicalDataInventory> = {}): CanonicalDataInventory {
  return {
    historyRows: 210,
    dbRows: 210,
    aiContextRows: 210,
    bookingRows: 46,
    jalanRows: 38,
    rakutenRows: 126,
    entries: entries(),
    ...overrides
  };
}

function repoState(overrides: Partial<CurrentRepoState> = {}): CurrentRepoState {
  return {
    trackedFileCount: 2,
    uncommittedEntryCount: 17,
    gitignoreIgnoresDataDir: true,
    gitignoreIgnoresSqlite: true,
    envExamplePresent: true,
    auto00xArtifactPath: ".data/reports/automation/auto_runner_architecture_proposal_20260605_114206.json",
    auto00xArtifactPresent: true,
    ...overrides
  };
}

describe("AUTO-RUNNER01X current repo state", () => {
  it("1. surfaces tracked/uncommitted counts and gitignore flags", () => {
    const p = buildMigrationProposal(repoState(), inventory());
    expect(p.currentRepoState.trackedFileCount).toBe(2);
    expect(p.currentRepoState.uncommittedEntryCount).toBe(17);
    expect(p.currentRepoState.gitignoreIgnoresDataDir).toBe(true);
    expect(p.currentRepoState.gitignoreIgnoresSqlite).toBe(true);
  });

  it("2. records .env.example presence and the AUTO-RUNNER00X source artifact", () => {
    const p = buildMigrationProposal(repoState(), inventory());
    expect(p.currentRepoState.envExamplePresent).toBe(true);
    expect(p.currentRepoState.auto00xArtifactPresent).toBe(true);
    expect(p.currentRepoState.auto00xArtifactPath).toMatch(/auto_runner_architecture_proposal_/);
  });
});

describe("AUTO-RUNNER01X canonical data inventory", () => {
  it("3. carries history=210 / DB=210 and per-source counts", () => {
    const p = buildMigrationProposal(repoState(), inventory());
    expect(p.canonicalDataInventory.historyRows).toBe(210);
    expect(p.canonicalDataInventory.dbRows).toBe(210);
    expect(p.canonicalDataInventory.bookingRows).toBe(46);
    expect(p.canonicalDataInventory.jalanRows).toBe(38);
    expect(p.canonicalDataInventory.rakutenRows).toBe(126);
  });

  it("4. marks history shards canonical and the SQLite mirror regenerable", () => {
    const e = inventory().entries;
    const history = e.find((x) => x.path.includes("zao_signals_"));
    const sqlite = e.find((x) => x.path.includes(".sqlite"));
    expect(history?.kind).toBe("canonical");
    expect(history?.isCanonical).toBe(true);
    expect(sqlite?.kind).toBe("regenerable");
    expect(sqlite?.isCanonical).toBe(false);
  });
});

describe("AUTO-RUNNER01X commit / ignore / archive matrix", () => {
  const matrix = buildCommitIgnoreArchiveMatrix();
  const find = (pat: string) => matrix.find((m) => m.pathOrPattern.includes(pat));

  it("5. commits source, tests and the manifest", () => {
    expect(find("src/**")?.recommendedAction).toBe("commit");
    expect(find("tests/**")?.recommendedAction).toBe("commit");
    expect(find("package.json")?.recommendedAction).toBe("commit");
  });

  it("6. commits canonical history shards but flags required policy approval", () => {
    const history = find("zao_signals_");
    expect(history?.recommendedAction).toBe("commit");
    expect(history?.requiredForAlwaysOnMac).toBe(true);
    expect(history?.risk).toMatch(/APPROVAL REQUIRED|negation/i);
  });

  it("7. regenerates the SQLite mirror and AI context rather than committing them", () => {
    expect(find(".sqlite")?.recommendedAction).toBe("regenerate");
    expect(find("ai-context")?.recommendedAction).toBe("regenerate");
  });

  it("8. ignores heavy debug + screenshot artifacts", () => {
    expect(find("debug")?.recommendedAction).toBe("ignore");
    expect(find("screenshots/**")?.recommendedAction).toBe("ignore");
    expect(find("debug")?.requiredForAlwaysOnMac).toBe(false);
  });

  it("9. never commits secrets", () => {
    const env = matrix.find((m) => m.pathOrPattern === ".env");
    expect(env?.recommendedAction).toBe("never_commit");
    expect(env?.category).toBe("secret");
  });

  it("10. ignores node_modules and logs", () => {
    expect(find("node_modules")?.recommendedAction).toBe("ignore");
    expect(find("*.log")?.recommendedAction).toBe("ignore");
  });
});

describe("AUTO-RUNNER01X gitignore recommendations", () => {
  it("11. proposes negating the blanket .data ignore for canonical shards only", () => {
    const g = buildGitignoreRecommendations(repoState());
    expect(g.problem).toMatch(/blanket-ignores/i);
    expect(g.proposedAdditions).toContain("!.data/history/zao_signals_*.csv");
    expect(g.proposedAdditions).toContain(".data/debug/");
    expect(g.proposedAdditions).toContain("!.env.example");
    expect(g.rationale).toMatch(/human approval|not changed in this phase/i);
  });

  it("12. states the non-problem when .data is not blanket-ignored", () => {
    const g = buildGitignoreRecommendations(repoState({ gitignoreIgnoresDataDir: false }));
    expect(g.problem).toMatch(/not blanket-ignored/i);
  });
});

describe("AUTO-RUNNER01X transfer + bootstrap + verification", () => {
  it("13. transfer flow goes implementation Mac -> github -> always-on Mac", () => {
    const t = buildArtifactTransferPlan();
    expect(t.flow).toMatch(/github/i);
    expect(t.flow).toMatch(/always_on_mac/);
    expect(t.options.some((o) => o.recommended)).toBe(true);
  });

  it("14. bootstrap sequence clones, installs and gates the DB sync", () => {
    const b = buildBootstrapSequence();
    expect(b.some((x) => x.includes("git clone"))).toBe(true);
    expect(b).toContain("npm install");
    expect(b).toContain("npm run typecheck");
    expect(b.some((x) => x.includes("HISTORY_TO_DB_SYNC=1"))).toBe(true);
  });

  it("15. verification sequence asserts 210 + db:verify", () => {
    const v = buildVerificationSequence();
    expect(v.some((x) => x.includes("210"))).toBe(true);
    expect(v.some((x) => x.includes("db:verify"))).toBe(true);
  });
});

describe("AUTO-RUNNER01X secret policy + future phases", () => {
  it("16. secret policy never commits .env, allows .env.example, manual secrets", () => {
    const s = buildSecretEnvironmentPolicy();
    expect(s).toContain(".env is never committed");
    expect(s).toContain(".env.example may be committed (placeholders only)");
    expect(s.some((x) => /manually on the always-on Mac/.test(x))).toBe(true);
    expect(s.some((x) => /no paid proxy keys/.test(x))).toBe(true);
  });

  it("17. future phase plan covers 02X..08X", () => {
    const ids = buildFuturePhasePlan().map((f) => f.id);
    expect(ids).toContain("AUTO-RUNNER02X");
    expect(ids).toContain("AUTO-RUNNER08X");
    expect(ids.length).toBe(7);
  });
});

describe("AUTO-RUNNER01X decision", () => {
  it("18. basis_caution in the realistic case (.data blanket-ignored needs approval)", () => {
    expect(decideMigration(repoState(), inventory())).toBe("auto_runner_migration_proposal_basis_caution");
  });

  it("19. ready only when gitignore already permits canonical commit", () => {
    expect(decideMigration(repoState({ gitignoreIgnoresDataDir: false }), inventory())).toBe(
      "auto_runner_migration_proposal_ready"
    );
  });

  it("20. not_ready when history is unreadable or the AUTO-RUNNER00X artifact is missing", () => {
    expect(decideMigration(repoState(), inventory({ historyRows: 0 }))).toBe(
      "auto_runner_migration_proposal_not_ready"
    );
    expect(decideMigration(repoState({ auto00xArtifactPresent: false }), inventory())).toBe(
      "auto_runner_migration_proposal_not_ready"
    );
  });
});

describe("AUTO-RUNNER01X rendering", () => {
  it("21. CSV header matches schema and emits one row per matrix entry", () => {
    const matrix = buildCommitIgnoreArchiveMatrix();
    const csv = renderMigrationCsv(matrix);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(MIGRATION_CSV_HEADERS.join(","));
    expect(lines).toHaveLength(matrix.length + 1);
  });

  it("22. markdown report includes required sections and the decision", () => {
    const p = buildMigrationProposal(repoState(), inventory());
    const md = renderMigrationReport({
      generatedAtJst: "2026-06-05T12:00:00+09:00",
      runId: "auto_runner_migration_proposal_test",
      decision: decideMigration(repoState(), inventory()),
      sourceAuto00xArtifact: p.currentRepoState.auto00xArtifactPath,
      proposal: p,
      reportPath: "r.md",
      jsonPath: "r.json",
      csvPath: "r.csv",
      debugRootPath: "debug"
    });
    expect(md).toContain("# Auto Runner Migration Proposal");
    expect(md).toContain("## 3. Canonical Data Inventory");
    expect(md).toContain("## 4. Commit / Ignore / Archive Matrix");
    expect(md).toContain("## 10. Future Phase Plan");
    expect(md).toContain("auto_runner_migration_proposal_basis_caution");
    expect(md).toContain("history_rows=210");
  });

  it("23. exposes the proposal:auto-runner-migration npm script", () => {
    expect(PACKAGE_JSON).toContain(
      '"proposal:auto-runner-migration": "node --import tsx src/scripts/buildAutoRunnerMigrationProposal.ts"'
    );
  });
});

describe("AUTO-RUNNER01X safety scans (executable patterns, not guardrail prose)", () => {
  it("performs no git mutation (add/commit/push/remote) — git is only read via ls-files/status", () => {
    // The report prose legitimately names "No git add/commit/push" as a guardrail,
    // so scan for git invoked with a mutating subcommand at the call site only.
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(
        /execFileSync\(\s*["'`]git["'`]\s*,\s*\[\s*["'`](add|commit|push|remote|tag|checkout)\b/u
      );
      expect(src).not.toMatch(/spawnSync\(\s*["'`]git["'`]\s*,\s*\[\s*["'`](add|commit|push)\b/u);
    }
    // Only the two read-only git introspection calls are allowed.
    expect(SCRIPT_SOURCE).toMatch(/execFileSync\("git",\s*\["ls-files"\]/);
    expect(SCRIPT_SOURCE).toMatch(/execFileSync\("git",\s*\["status",\s*"--porcelain"\]/);
  });

  it("creates no GitHub Actions / launchd / cron file", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|mkdirSync)\s*\([^)]*\.github\/workflows/u);
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|mkdirSync)\s*\([^)]*\.plist/u);
      expect(src).not.toMatch(/crontab\s+-|launchctl\s+(load|bootstrap|enable)/i);
    }
  });

  it("runs no live collector / Playwright / browser automation (call sites, not prose)", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(
        /from\s+["'`]playwright|require\(["'`]playwright|chromium\.launch|\.newContext\(|page\.goto\(/i
      );
    }
  });

  it("performs no external fetch", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\bfetch\(|axios|node-fetch/i);
    }
  });

  it("writes no history and opens the DB read-only (no INSERT/UPDATE/DELETE/sync)", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/u);
    expect(SCRIPT_SOURCE).toMatch(/new Database\([\s\S]{0,120}?readonly:\s*true/);
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|executeMigration|runHistoryToDbSync/i);
    }
  });

  it("triggers no AI context refresh", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/buildAiContextPacks|refreshAiContext/);
    }
  });

  it("generates no pricing CSV / PMS output (executable identifiers, not prose)", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(
        /generatePricingRecommendations|exportPricingReview|approvePricingRecommendations|applyPrice|updatePrice|uploadToBeds24|uploadToAirhost/
      );
    }
  });

  it("uses no synthetic markup multiplier", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\*\s*1\.1\b/);
      expect(src).not.toMatch(/1\.1\s*\*/);
    }
  });

  it("uses no paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs/i);
    }
  });
});

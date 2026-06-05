import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProposal,
  buildSourceRoles,
  decideProposal,
  PROPOSAL_CSV_HEADERS,
  renderProposalCsv,
  renderProposalReport,
  type SourceStateSummary
} from "../src/services/autoRunnerArchitectureProposal";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/autoRunnerArchitectureProposal.ts"),
  "utf8"
);
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildAutoRunnerArchitectureProposal.ts"),
  "utf8"
);
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function expectedState(overrides: Partial<SourceStateSummary> = {}): SourceStateSummary {
  return {
    historyRows: 210,
    dbRows: 210,
    bookingRows: 46,
    jalanRows: 38,
    rakutenRows: 126,
    aiContextRows: 210,
    inputArtifactsPresent: true,
    roles: buildSourceRoles(),
    ...overrides
  };
}

describe("AUTO-RUNNER00X source state", () => {
  it("1. summarizes current system state: history=210, DB=210, Booking=46, Jalan=38", () => {
    const p = buildProposal(expectedState());
    expect(p.sourceState.historyRows).toBe(210);
    expect(p.sourceState.dbRows).toBe(210);
    expect(p.sourceState.bookingRows).toBe(46);
    expect(p.sourceState.jalanRows).toBe(38);
  });

  it("2. identifies Booking as the primary directional source", () => {
    const booking = buildSourceRoles().find((r) => r.source === "booking");
    expect(booking?.role).toBe("primary_directional");
  });

  it("3. identifies Jalan as the supplementary source", () => {
    const jalan = buildSourceRoles().find((r) => r.source === "jalan");
    expect(jalan?.role).toBe("supplementary_directional");
  });

  it("4. marks Rakuten frozen/caution (and Google Hotels not adopted)", () => {
    const roles = buildSourceRoles();
    expect(roles.find((r) => r.source === "rakuten")?.role).toBe("frozen_caution");
    expect(roles.find((r) => r.source === "google_hotels")?.role).toBe("not_adopted");
  });
});

describe("AUTO-RUNNER00X architecture principles", () => {
  it("5. keeps live OTA collection on the always-on Mac, not cloud Actions", () => {
    const ids = buildProposal(expectedState()).architecturePrinciples.map((a) => a.id);
    expect(ids).toContain("live_collection_on_local_mac");
    expect(ids).toContain("no_live_browsers_in_cloud_actions");
  });

  it("6. allows GitHub only for code/artifact transfer and safe checks", () => {
    const principle = buildProposal(expectedState()).architecturePrinciples.find(
      (a) => a.id === "github_for_code_and_artifact_transfer"
    );
    expect(principle).toBeDefined();
    expect(principle?.detail).toMatch(/pull-only|manual PR review/i);
  });

  it("7. proposes no live browser collection in GitHub Actions", () => {
    const principle = buildProposal(expectedState()).architecturePrinciples.find(
      (a) => a.id === "no_live_browsers_in_cloud_actions"
    );
    expect(principle?.detail).toMatch(/No Playwright collection in cloud/i);
  });
});

describe("AUTO-RUNNER00X scheduling", () => {
  it("8. includes a near-term 60-day coverage concept", () => {
    const s = buildProposal(expectedState()).scheduleDesign;
    expect(s.nearTermCoverage.name).toBe("near_term_60_day");
    expect(s.nearTermCoverage.scope).toMatch(/60 days/);
  });

  it("9. includes 1-year major-date coverage concept", () => {
    const s = buildProposal(expectedState()).scheduleDesign;
    expect(s.majorDateCoverage.length).toBeGreaterThanOrEqual(3);
    expect(s.majorDateCoverage.every((b) => /1 year/.test(b.scope))).toBe(true);
  });

  it("10. splits schedules into small bounded batches", () => {
    const s = buildProposal(expectedState()).scheduleDesign;
    expect(s.principles).toContain("split_into_small_bounded_batches");
    expect(s.principles).toContain("no_massive_single_run");
    expect(s.bookingCadence.perRunCap).toMatch(/[Bb]ounded/);
    expect(s.jalanCadence.perRunCap).toMatch(/[Bb]ounded/);
  });
});

describe("AUTO-RUNNER00X bot-risk and transfer", () => {
  it("11. includes bot-risk controls", () => {
    const b = buildProposal(expectedState()).botRiskAssessment;
    expect(b.controls).toContain("run_live_collection_only_from_local_mac");
    expect(b.controls).toContain("no_stealth_plugin");
    expect(b.controls).toContain("no_captcha_bypass");
    expect(b.controls).toContain("no_paid_proxies");
    expect(b.controls).toContain("failure_rows_instead_of_inferred_prices");
  });

  it("12. includes a GitHub transfer plan", () => {
    const g = buildProposal(expectedState()).githubTransferPlan;
    expect(g.flow).toMatch(/github/i);
    expect(g.commit.length).toBeGreaterThan(0);
    expect(g.doNotCommit.length).toBeGreaterThan(0);
    expect(g.bootstrapSequence).toContain("git clone <repo>");
  });

  it("13. includes a local Mac setup checklist", () => {
    const c = buildProposal(expectedState()).localMacSetupChecklist;
    expect(c.length).toBeGreaterThanOrEqual(10);
    expect(c.join(" ")).toMatch(/keep-awake|no-sleep/i);
    expect(c.join(" ")).toMatch(/Playwright browsers installed/);
  });
});

describe("AUTO-RUNNER00X gates and pricing separation", () => {
  it("14. includes fail-closed gates", () => {
    const gates = buildProposal(expectedState()).failClosedGates.map((g) => g.flag);
    expect(gates).toContain("COLLECT_BOOKING=1");
    expect(gates).toContain("HISTORY_TO_DB_SYNC=1");
    expect(gates).toContain("BUILD_AI_CONTEXT=1");
    expect(gates).toContain("GENERATE_PRICE_CSV=1");
  });

  it("15. keeps price CSV gated and off by default", () => {
    const priceGate = buildProposal(expectedState()).failClosedGates.find((g) => g.flag === "GENERATE_PRICE_CSV=1");
    expect(priceGate?.defaultOff).toBe(true);
  });

  it("16. keeps PMS/Beds24 upload out of scope", () => {
    const stage10 = buildProposal(expectedState()).manualWorkflowDesign.find((w) => w.stage === 10);
    expect(stage10?.failureBehavior).toMatch(/No CSV; no upload/i);
    expect(stage10?.gate).toMatch(/no PMS\/Beds24\/AirHost upload/i);
  });

  it("17. includes a future phase plan (01X..08X)", () => {
    const phases = buildProposal(expectedState()).futurePhasePlan.map((f) => f.id);
    expect(phases).toContain("AUTO-RUNNER01X");
    expect(phases).toContain("AUTO-RUNNER08X");
    expect(phases.length).toBe(8);
  });
});

describe("AUTO-RUNNER00X decision", () => {
  it("26a. ready when state matches the expected 210 baseline", () => {
    expect(decideProposal(expectedState())).toBe("auto_runner_architecture_proposal_ready");
  });

  it("26b. basis_caution when state drifts but is still readable", () => {
    expect(decideProposal(expectedState({ jalanRows: 40 }))).toBe(
      "auto_runner_architecture_proposal_basis_caution"
    );
  });

  it("26c. not_ready when state cannot be verified or artifacts missing", () => {
    expect(decideProposal(expectedState({ dbRows: 0 }))).toBe("auto_runner_architecture_proposal_not_ready");
    expect(decideProposal(expectedState({ inputArtifactsPresent: false }))).toBe(
      "auto_runner_architecture_proposal_not_ready"
    );
  });
});

describe("AUTO-RUNNER00X rendering", () => {
  it("CSV header matches schema and emits a row per workflow stage", () => {
    const p = buildProposal(expectedState());
    const csv = renderProposalCsv(p.manualWorkflowDesign);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(PROPOSAL_CSV_HEADERS.join(","));
    expect(lines).toHaveLength(p.manualWorkflowDesign.length + 1);
  });

  it("markdown report includes the required sections and decision", () => {
    const p = buildProposal(expectedState());
    const md = renderProposalReport({
      generatedAtJst: "2026-06-05T11:30:00+09:00",
      runId: "auto_runner_architecture_proposal_test",
      decision: decideProposal(expectedState()),
      proposal: p,
      reportPath: "r.md",
      jsonPath: "r.json",
      csvPath: "r.csv",
      debugRootPath: "debug"
    });
    expect(md).toContain("# Auto Runner Architecture Proposal");
    expect(md).toContain("## 6. Bot-Risk Assessment");
    expect(md).toContain("## 11. Future Phase Plan");
    expect(md).toContain("auto_runner_architecture_proposal_ready");
    expect(md).toContain("history_rows=210");
  });

  it("exposes the proposal:auto-runner-architecture npm script", () => {
    expect(PACKAGE_JSON).toContain(
      '"proposal:auto-runner-architecture": "node --import tsx src/scripts/buildAutoRunnerArchitectureProposal.ts"'
    );
  });
});

describe("AUTO-RUNNER00X safety scans (executable patterns)", () => {
  it("18. no cron/launchd installation code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/crontab\s+-|launchctl\s+(load|bootstrap|enable)|\.plist['"`]\s*\)/i);
    }
  });

  it("19. no GitHub Actions workflow file is created", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|mkdirSync)\s*\([^)]*\.github\/workflows/u);
  });

  it("20 & 21. no live collector / Playwright / browser automation executed (executable patterns, not the guardrail prose)", () => {
    // The proposal text legitimately names Playwright as the forbidden cloud
    // action, so scan for imports / call sites only — not the bare word.
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(
        /from\s+["'`]playwright|require\(["'`]playwright|chromium\.launch|\.newContext\(|page\.goto\(|execFileSync|spawnSync/i
      );
    }
  });

  it("no external fetch", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\bfetch\(|axios|node-fetch/i);
    }
  });

  it("22. no history write code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/u);
  });

  it("23. no DB write/sync code exists (readonly open, no migration/INSERT/UPDATE/sync)", () => {
    expect(SCRIPT_SOURCE).toMatch(/new Database\([\s\S]{0,120}?readonly:\s*true/);
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|executeMigration|runHistoryToDbSync/i);
    }
  });

  it("24. no AI context refresh code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/buildAiContextPacks|refreshAiContext/);
    }
  });

  it("25. no pricing CSV / PMS output code exists (executable identifiers, not the guardrail prose)", () => {
    // The proposal text legitimately names "PMS/Beds24/AirHost upload" as a
    // forbidden action, so scan for executable identifiers / imports only.
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(
        /generatePricingRecommendations|exportPricingReview|approvePricingRecommendations|applyPrice|updatePrice|uploadToBeds24|uploadToAirhost/
      );
    }
  });

  it("no synthetic multiplier", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\*\s*1\.1\b/);
      expect(src).not.toMatch(/1\.1\s*\*/);
    }
  });

  it("no paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs|paid proxy/i);
    }
  });

  it("no commit/push code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/git\s+(commit|push)|simple-git/i);
  });
});

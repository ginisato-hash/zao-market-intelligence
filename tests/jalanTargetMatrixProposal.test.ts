import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TARGET_PROPERTIES,
  buildAuto03xBoundedMatrix,
  buildBotRiskSafetyRules,
  buildDateWindowMatrix,
  buildDirectDirectionalExcludedPolicy,
  buildEvidenceRequirements,
  buildFuturePhasePlan,
  buildLocalJalanEvidenceInventory,
  buildManualReviewProperties,
  buildPageCapPlan,
  buildSafetyConfirmation,
  buildTargetPropertyMatrix,
  decideJalanTargetMatrixProposal,
  renderTargetMatrixCsv,
  type LocalEvidenceFile
} from "../src/services/jalanTargetMatrixProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/jalanTargetMatrixProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildJalanTargetMatrixProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function fixtureFiles(): LocalEvidenceFile[] {
  return [
    {
      file_path: "data/seeds/jalan_verified_properties.990-2301.sample.json",
      source_text: JSON.stringify([
        {
          property_name: "ホテル　喜らく",
          property_url: "https://www.jalan.net/yad325153/",
          verification_status: "confirmed",
          notes: "confirmed locally"
        },
        {
          property_name: "蔵王温泉　BED’n ONSEN HAMMOND - ハモンド -",
          property_url: "https://www.jalan.net/yad348320/",
          verification_status: "confirmed"
        },
        {
          property_name: "蔵王温泉　吉田屋",
          property_url: "https://www.jalan.net/yad327282/",
          verification_status: "confirmed"
        },
        {
          property_name: "ル・ベール蔵王",
          property_url: "https://www.jalan.net/yad328232/",
          verification_status: "confirmed"
        },
        {
          property_name: "蔵王温泉　JURIN",
          property_url: "https://www.jalan.net/yad332556/",
          verification_status: "confirmed"
        }
      ])
    },
    {
      file_path: "data/seeds/source_coverage_candidates.990-2301.ai-discovered.local.json",
      source_text: JSON.stringify([
        {
          property_name: "ONSEN & STAY OAKHILL",
          source: "jalan",
          candidate_property_url: "https://www.jalan.net/yad388065/",
          candidate_source_property_id: "388065",
          verification_status: "needs_review",
          evidence_note: "candidate only"
        },
        {
          property_name: "シバママのお宿",
          source: "jalan",
          candidate_property_url: null,
          candidate_source_property_id: null,
          verification_status: "candidate",
          evidence_note: "No jalan candidate was discovered; manual discovery required; no identifier was invented."
        }
      ])
    }
  ];
}

function built() {
  const inventory = buildLocalJalanEvidenceInventory(fixtureFiles());
  const matrix = buildTargetPropertyMatrix(inventory);
  const dates = buildDateWindowMatrix();
  const auto03x = buildAuto03xBoundedMatrix(matrix, dates);
  const caps = buildPageCapPlan(auto03x);
  return { inventory, matrix, dates, auto03x, caps };
}

describe("JALAN-AUTO02X - target matrix", () => {
  it("builds target property matrix for Tier 1 and Tier 2", () => {
    const { matrix } = built();
    expect(matrix.length).toBe(TARGET_PROPERTIES.length);
    expect(matrix.some((row) => row.tier === "tier_1" && row.canonical_property_name === "ホテル喜らく")).toBe(true);
    expect(matrix.some((row) => row.tier === "tier_2" && row.canonical_property_name === "JURIN")).toBe(true);
  });

  it("does not invent Jalan URLs or IDs", () => {
    const { matrix } = built();
    const missing = matrix.find((row) => row.canonical_property_name === "ロッジスガノ");
    expect(missing?.jalan_source_url).toBeNull();
    expect(missing?.jalan_property_id).toBeNull();
  });

  it("marks missing properties for manual review", () => {
    const { matrix } = built();
    const manual = buildManualReviewProperties(matrix);
    expect(manual.map((row) => row.canonical_property_name)).toContain("シバママのお宿");
    expect(manual.map((row) => row.canonical_property_name)).toContain("OAKHILL");
  });

  it("selects AUTO03X targets only from verified local evidence", () => {
    const { matrix } = built();
    const selected = matrix.filter((row) => row.recommended_for_auto03x);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((row) => row.confidence === "verified" && row.jalan_source_url !== null && row.jalan_property_id !== null)).toBe(true);
    expect(selected.map((row) => row.canonical_property_name)).not.toContain("OAKHILL");
  });

  it("respects max_properties <= 5", () => {
    expect(built().caps.proposed_properties).toBeLessThanOrEqual(5);
  });

  it("respects max_dates_per_property <= 5", () => {
    expect(built().caps.proposed_dates_per_property).toBeLessThanOrEqual(5);
  });

  it("respects max_pages <= 25", () => {
    expect(built().caps.proposed_pages).toBeLessThanOrEqual(25);
    expect(built().caps.cap_respected).toBe(true);
  });
});

describe("JALAN-AUTO02X - dates, policy, and phases", () => {
  it("includes near-term Saturday dates", () => {
    const dates = buildDateWindowMatrix();
    expect(dates.filter((row) => row.category === "near_term_saturday").map((row) => row.date)).toEqual(
      expect.arrayContaining(["2026-06-06", "2026-06-13", "2026-06-20"])
    );
  });

  it("includes named peak dates", () => {
    const dates = buildDateWindowMatrix().map((row) => row.date);
    expect(dates).toEqual(expect.arrayContaining(["2026-07-18", "2026-08-12", "2026-09-21", "2026-10-10", "2026-11-21", "2026-12-12"]));
  });

  it("direct policy requires A-confidence and clear basis", () => {
    const policy = buildDirectDirectionalExcludedPolicy();
    expect(policy.direct_allowed_only_when).toContain("source confidence is A");
    expect(policy.direct_allowed_only_when).toContain("price basis is tax included total");
  });

  it("weak rows remain directional or excluded", () => {
    expect(buildDirectDirectionalExcludedPolicy().weak_rows_rule).toContain("do not promote");
  });

  it("evidence requirements include screenshot path", () => {
    expect(buildEvidenceRequirements().required_fields).toContain("screenshot_path");
  });

  it("no screenshot means not B/direct", () => {
    expect(buildEvidenceRequirements().screenshot_rule).toContain("cannot be B-confidence or direct");
  });

  it("future phases are separated", () => {
    const phases = buildFuturePhasePlan().map((phase) => phase.phase);
    expect(phases).toEqual(expect.arrayContaining(["JALAN-AUTO03X", "JALAN-AUTO04X", "JALAN-AUTO05X", "JALAN-AUTO05B", "JALAN-AUTO06X"]));
  });

  it("real write phases require approval", () => {
    const writePhases = buildFuturePhasePlan().filter((phase) => phase.phase === "JALAN-AUTO05X" || phase.phase === "JALAN-AUTO05B");
    expect(writePhases.every((phase) => phase.approval_gate.includes("Requires"))).toBe(true);
  });

  it("bot-risk rules prohibit broad search scraping", () => {
    expect(buildBotRiskSafetyRules().rules.join(" ")).toMatch(/Avoid broad area search scraping/u);
  });

  it("bot-risk rules prohibit stealth/CAPTCHA/proxy", () => {
    expect(buildBotRiskSafetyRules().rules.join(" ")).toMatch(/stealth.*CAPTCHA.*paid proxies/u);
  });
});

describe("JALAN-AUTO02X - safety and artifacts", () => {
  it("safety confirmation says no live fetch", () => {
    const safety = buildSafetyConfirmation();
    expect(safety.live_jalan_collection).toBe(false);
    expect(safety.external_fetch).toBe(false);
  });

  it("has no Playwright/browser automation code in this phase", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch|page\.goto|puppeteer/iu);
  });

  it("has no history write code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync|writeFileSync\([^)]*\.data\/history/iu);
  });

  it("has no DB write code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|prepare\(["'`]\s*(?:INSERT|UPDATE|DELETE)|\.exec\(/iu);
  });

  it("has no DB sync code", () => {
    expect(SCRIPT_SOURCE).not.toContain("real-run:history-to-db-sync");
  });

  it("has no AI context refresh code", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("has no PMS/Beds24/AirHost output", () => {
    expect(SERVICE_SOURCE).not.toMatch(/writeBeds|writeAir|exportApproved|pmsCsv/iu);
  });

  it("has no price update", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/pricing:recommend|pricing:approve|exportApprovedRecommendationPreview/iu);
  });

  it("returns decision ready/basis_caution/not_ready", () => {
    const { matrix, caps } = built();
    expect(decideJalanTargetMatrixProposal({ targetPropertyMatrix: matrix, pageCapPlan: caps })).toBe("jalan_target_matrix_proposal_basis_caution");
    expect(decideJalanTargetMatrixProposal({ targetPropertyMatrix: [], pageCapPlan: { ...caps, proposed_pages: 0 } })).toBe(
      "jalan_target_matrix_proposal_not_ready"
    );
  });

  it("renders CSV and has npm script", () => {
    expect(renderTargetMatrixCsv(built().matrix)).toContain("canonical_property_name");
    expect(PACKAGE_JSON).toContain("\"proposal:jalan-target-matrix\"");
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVED_JALAN_YAD_ID,
  APPROVED_RAKUTEN_HOTEL_NO,
  APPROVED_TARGET_ARTIFACTS,
  DEPRECATE_CANONICAL,
  REQUIRED_ALIASES,
  RETAIN_CANONICAL,
  applyAliasMapMerge,
  applyApprovedMatsukaneyaMerge,
  applySourceCandidatesMerge,
  applyUniversePropertiesMerge,
  backupTargets,
  createBackupDir,
  evaluateMatsukaneyaMergeGate,
  parseCsvTable,
  proposalHasExpectedMerge,
  renderCsvTable,
  restoreTargetsFromBackup,
  validateMergedArtifacts,
  writeTargetsAtomically
} from "../src/services/matsukaneyaCanonicalMerge";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/matsukaneyaCanonicalMerge.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runMatsukaneyaCanonicalMerge.ts"), "utf8");

const UNIVERSE_CSV = [
  "canonical_property_name,canonicalization_status,aliases,sources_present,jalan_url,jalan_id,rakuten_url,rakuten_id,local_source,evidence_note,needs_human_review,review_decision,reviewer_note",
  " unrelated,canonical,,jalan,,,,,,unchanged,false,pending,",
  `${RETAIN_CANONICAL},needs_review,蔵王温泉 ホテル松金屋アネックス,rakuten,,,https://travel.rakuten.co.jp/HOTEL/5097/,5097,,Canonicalized from rakuten.,true,pending,`,
  `${DEPRECATE_CANONICAL},needs_review,蔵王温泉 松金や －MATSUKANEYA ANNEX－,jalan,https://www.jalan.net/yad335940/,335940,,,,Canonicalized from jalan.,true,pending,`
].join("\n") + "\n";

const CANDIDATE_CSV = [
  "canonical_property_name,source,candidate_property_url,candidate_source_property_id,verification_status,evidence_note,current_reviewer_note,human_review_required,review_decision,reviewed_property_url,reviewed_source_property_id,reviewer_note",
  `${RETAIN_CANONICAL},jalan,,,candidate,No jalan candidate.,,true,pending,,,`,
  `${RETAIN_CANONICAL},rakuten,https://travel.rakuten.co.jp/HOTEL/5097/,5097,needs_review,Rakuten found.,,true,pending,,,`,
  `${DEPRECATE_CANONICAL},jalan,https://www.jalan.net/yad335940/,335940,needs_review,Jalan found.,,true,pending,,,`,
  `${DEPRECATE_CANONICAL},rakuten,,,candidate,No rakuten candidate.,,true,pending,,,`
].join("\n") + "\n";

const ALIAS_JSON = JSON.stringify({
  [RETAIN_CANONICAL]: ["蔵王温泉 ホテル松金屋アネックス"],
  [DEPRECATE_CANONICAL]: ["蔵王温泉 松金や －MATSUKANEYA ANNEX－"],
  unrelated: ["unchanged"]
}, null, 2) + "\n";

const TARGET_CONTENTS = {
  universeCsv: UNIVERSE_CSV,
  aliasJson: ALIAS_JSON,
  sourceCandidatesCsv: CANDIDATE_CSV,
  multiSourceCandidatesCsv: CANDIDATE_CSV
};

function validProposal(extraRows = false) {
  return {
    summary: {
      groupId: "matsukaneya_annex_zao",
      userConfirmedSameProperty: true,
      retainCanonical: RETAIN_CANONICAL,
      deprecateCanonical: DEPRECATE_CANONICAL
    },
    rows: extraRows ? [{}, {}, {}] : [{}, {}],
    plan: {
      retainCanonical: RETAIN_CANONICAL,
      deprecateCanonical: DEPRECATE_CANONICAL,
      targetArtifactsIfApproved: [
        "zao_universe_properties_20260531_231933.csv",
        "zao_alias_map_20260531_231933.json",
        "zao_source_candidates_20260531_231933.csv",
        "zao_source_candidates_multi_source_enriched_20260601_074617.csv"
      ],
      preservedSourceIds: {
        rakutenHotelNo: APPROVED_RAKUTEN_HOTEL_NO,
        jalanYadId: APPROVED_JALAN_YAD_ID
      },
      sourceCandidateRepoint: [
        { toCanonical: RETAIN_CANONICAL, source: "rakuten", candidateId: APPROVED_RAKUTEN_HOTEL_NO },
        { toCanonical: RETAIN_CANONICAL, source: "jalan", candidateId: APPROVED_JALAN_YAD_ID }
      ]
    }
  };
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("approval gate", () => {
  it("fails closed without the env flag", () => {
    const gate = evaluateMatsukaneyaMergeGate({
      explicitUserApproved: true,
      envMatsukaneyaMerge: undefined,
      proposal: validProposal(),
      targetArtifactPaths: APPROVED_TARGET_ARTIFACTS
    });
    expect(gate.realUpdateAllowed).toBe(false);
    expect(gate.decision).toBe("matsukaneya_canonical_merge_ready_not_run");
  });

  it("opens only with explicit approval, env flag, exact proposal, and exact target paths", () => {
    const gate = evaluateMatsukaneyaMergeGate({
      explicitUserApproved: true,
      envMatsukaneyaMerge: "1",
      proposal: validProposal(),
      targetArtifactPaths: APPROVED_TARGET_ARTIFACTS
    });
    expect(gate.realUpdateAllowed).toBe(true);
    expect(gate.decision).toBe("matsukaneya_canonical_merge_success");
  });

  it("blocks unexpected extra merge groups or wrong target paths", () => {
    expect(proposalHasExpectedMerge(validProposal(true))).toBe(false);
    const gate = evaluateMatsukaneyaMergeGate({
      explicitUserApproved: true,
      envMatsukaneyaMerge: "1",
      proposal: validProposal(),
      targetArtifactPaths: [APPROVED_TARGET_ARTIFACTS[0]]
    });
    expect(gate.realUpdateAllowed).toBe(false);
  });
});

describe("merge transforms", () => {
  it("marks the deprecated universe row duplicate and keeps the retained canonical", () => {
    const merged = applyUniversePropertiesMerge(UNIVERSE_CSV);
    const table = parseCsvTable(merged.content);
    const retain = table.rows.find((r) => r["canonical_property_name"] === RETAIN_CANONICAL);
    const dep = table.rows.find((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL);
    expect(retain?.["jalan_id"]).toBe(APPROVED_JALAN_YAD_ID);
    expect(retain?.["rakuten_id"]).toBe(APPROVED_RAKUTEN_HOTEL_NO);
    expect(retain?.["sources_present"]).toContain("jalan");
    expect(dep?.["canonicalization_status"]).toBe(`duplicate_of:${RETAIN_CANONICAL}`);
  });

  it("adds Matsukaneya aliases under retained canonical without duplicates", () => {
    const merged = applyAliasMapMerge(ALIAS_JSON);
    const map = JSON.parse(merged.content) as Record<string, string[]>;
    const retainedAliases = map[RETAIN_CANONICAL] ?? [];
    expect(map[DEPRECATE_CANONICAL]).toBeUndefined();
    for (const alias of REQUIRED_ALIASES) expect(retainedAliases).toContain(alias);
    expect(retainedAliases.length).toBe(new Set(retainedAliases).size);
  });

  it("repoints source candidates from both files while preserving Rakuten and Jalan IDs", () => {
    const merged = applySourceCandidatesMerge(CANDIDATE_CSV);
    const table = parseCsvTable(merged.content);
    expect(table.rows.some((r) => r["canonical_property_name"] === DEPRECATE_CANONICAL)).toBe(false);
    expect(table.rows.some((r) => r["canonical_property_name"] === RETAIN_CANONICAL && r["source"] === "rakuten" && r["candidate_source_property_id"] === APPROVED_RAKUTEN_HOTEL_NO)).toBe(true);
    expect(table.rows.some((r) => r["canonical_property_name"] === RETAIN_CANONICAL && r["source"] === "jalan" && r["candidate_source_property_id"] === APPROVED_JALAN_YAD_ID)).toBe(true);
  });

  it("preserves headers, unrelated names, valid JSON, and row counts", () => {
    const merged = applyApprovedMatsukaneyaMerge(TARGET_CONTENTS);
    const validation = validateMergedArtifacts(merged);
    expect(validation.valid).toBe(true);
    expect(parseCsvTable(merged.universeCsv).headers).toEqual(parseCsvTable(UNIVERSE_CSV).headers);
    expect(parseCsvTable(merged.sourceCandidatesCsv).rows.length).toBe(parseCsvTable(CANDIDATE_CSV).rows.length);
    expect(merged.universeCsv).toContain(" unrelated,canonical");
    expect(() => JSON.parse(merged.aliasJson)).not.toThrow();
  });

  it("is idempotent on a second run", () => {
    const once = applyApprovedMatsukaneyaMerge(TARGET_CONTENTS);
    const twice = applyApprovedMatsukaneyaMerge(once);
    expect(twice.universeCsv).toBe(once.universeCsv);
    expect(twice.aliasJson).toBe(once.aliasJson);
    expect(twice.sourceCandidatesCsv).toBe(once.sourceCandidatesCsv);
    expect(twice.multiSourceCandidatesCsv).toBe(once.multiSourceCandidatesCsv);
  });
});

describe("backup, atomic write, and rollback helpers", () => {
  function tempWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), "matsukaneya-"));
    tempRoots.push(root);
    for (const rel of APPROVED_TARGET_ARTIFACTS) {
      const path = resolve(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `before:${rel}`, "utf8");
    }
    return root;
  }

  it("generates the approved backup path and copies all four targets", () => {
    const root = tempWorkspace();
    const backup = createBackupDir(root, "20260603_220000");
    const actions = backupTargets(root, APPROVED_TARGET_ARTIFACTS, backup);
    expect(backup).toContain(".backup/20260603_220000_matsukaneya_merge");
    expect(actions).toHaveLength(4);
  });

  it("uses temp-file write plus atomic rename and can restore backups", () => {
    const root = tempWorkspace();
    const backup = createBackupDir(root, "20260603_220001");
    backupTargets(root, APPROVED_TARGET_ARTIFACTS, backup);
    const [first] = APPROVED_TARGET_ARTIFACTS;
    const actions = writeTargetsAtomically(root, { [first]: "after" });
    expect(actions[0]).toContain("atomic_rename:");
    expect(readFileSync(resolve(root, first), "utf8")).toBe("after");
    restoreTargetsFromBackup(root, APPROVED_TARGET_ARTIFACTS, backup);
    expect(readFileSync(resolve(root, first), "utf8")).toBe(`before:${first}`);
  });
});

describe("safety", () => {
  it("does not contain DB-write, GitHub Actions/GitOps, history, excluded-audit, or Demand Index mutation code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(src).not.toMatch(/\brate_snapshots\b|\binventory_snapshots\b|\bcollector_runs\b/);
      expect(src).not.toMatch(/\.github\/workflows/);
      expect(src).not.toMatch(/git\s+commit|git\s+push/);
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.data\/history/);
      expect(src).not.toMatch(/zao_excluded_audit/);
      expect(src).not.toMatch(/Demand Index recompute|computeDemandIndex|demand_index.*write/i);
    }
  });

  it("does not include forbidden PMS/upload columns", () => {
    const merged = applyApprovedMatsukaneyaMerge(TARGET_CONTENTS);
    const headers = [
      ...parseCsvTable(merged.universeCsv).headers,
      ...parseCsvTable(merged.sourceCandidatesCsv).headers
    ].join(",").toLowerCase();
    expect(headers).not.toMatch(/roomid|beds24|airhost|pms|price1|price2|multiplier/);
  });

  it("CSV rendering keeps headers stable", () => {
    const table = parseCsvTable(CANDIDATE_CSV);
    expect(renderCsvTable(table).split("\n")[0]).toBe(CANDIDATE_CSV.split("\n")[0]);
  });
});

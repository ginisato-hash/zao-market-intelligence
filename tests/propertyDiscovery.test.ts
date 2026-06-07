import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_CSV_HEADERS,
  buildExistingPropertyEntries,
  buildPropertyDiscoveryResult,
  classifyDiscoverySeed,
  normalizeDiscoveryName,
  renderDiscoveryCsv,
  renderDiscoveryJson,
  renderDiscoveryMarkdown,
  type DiscoverySeed,
  type ExistingPropertyEntry
} from "../src/services/propertyDiscovery";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/propertyDiscovery.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runPropertyDiscovery.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const EXISTING: ExistingPropertyEntry[] = [
  {
    canonical_property_name: "蔵王国際ホテル",
    key: "蔵王国際",
    normalized_name: "蔵王国際",
    aliases: ["zao-kokusai"],
    source_evidence: ["booking_target"]
  },
  {
    canonical_property_name: "深山荘 高見屋",
    key: "深山荘高見屋",
    normalized_name: "深山荘高見屋",
    aliases: ["深山荘高見屋", "shinzanso-takamiya"],
    source_evidence: ["booking_target", "alias_seed"]
  },
  {
    canonical_property_name: "ホテル喜らく",
    key: "喜らく",
    normalized_name: "喜らく",
    aliases: ["ホテル 喜らく"],
    source_evidence: ["jalan_target"]
  },
  {
    canonical_property_name: "名湯リゾート ルーセント",
    key: "名湯リゾートルーセント",
    normalized_name: "名湯リゾートルーセント",
    aliases: ["ルーセント", "蔵王温泉 名湯リゾート ルーセントタカミヤ"],
    source_evidence: ["alias_seed"]
  }
];

function seed(candidate_name: string, over: Partial<DiscoverySeed> = {}): DiscoverySeed {
  return {
    candidate_name,
    evidence_summary: "test seed",
    ...over
  };
}

describe("AUTO-RUNNER-DISCOVERY01 property discovery dry run", () => {
  it("normalizes width, punctuation, Zao Onsen prefix, and hotel/ryokan suffix for comparison", () => {
    expect(normalizeDiscoveryName("蔵王温泉　ホテル 喜らく")).toBe("喜らく");
    expect(normalizeDiscoveryName("ＫＫＲ蔵王 白銀荘")).toBe("kkr蔵王白銀荘");
  });

  it("detects exact duplicate candidates against existing targets", () => {
    const row = classifyDiscoverySeed(seed("蔵王国際ホテル"), EXISTING);
    expect(row.classification).toBe("duplicate_candidate");
    expect(row.recommended_action).toBe("reject_duplicate");
    expect(row.matched_existing_property).toBe("蔵王国際ホテル");
  });

  it("detects alias candidates without over-collapsing unrelated short names", () => {
    const alias = classifyDiscoverySeed(seed("蔵王温泉 深山荘高見屋"), EXISTING);
    expect(alias.classification).toBe("alias_candidate");
    expect(alias.recommended_action).toBe("approve_alias");

    const unrelated = classifyDiscoverySeed(seed("ル・ベール蔵王"), EXISTING);
    expect(unrelated.matched_existing_property).not.toBe("名湯リゾート ルーセント");
  });

  it("detects new lodging candidates when there is no existing match", () => {
    const row = classifyDiscoverySeed(seed("ロッジスガノ"), EXISTING);
    expect(row.classification).toBe("new_candidate");
    expect(row.recommended_action).toBe("approve_new");
  });

  it("uses hold_candidate for uncertain manual-hold seeds", () => {
    const row = classifyDiscoverySeed(seed("お食事処・お泊り処・お湯処 ろばた", { metadata: { hold: true } }), EXISTING);
    expect(row.classification).toBe("hold_candidate");
    expect(row.recommended_action).toBe("hold");
  });

  it("maps out-of-scope and inactive candidates to human review actions", () => {
    const out = classifyDiscoverySeed(seed("蔵王温泉大露天風呂", { metadata: { out_of_scope: true } }), EXISTING);
    expect(out.classification).toBe("out_of_scope_candidate");
    expect(out.recommended_action).toBe("reject_out_of_scope");

    const closed = classifyDiscoverySeed(seed("閉館したテスト旅館"), EXISTING);
    expect(closed.classification).toBe("closed_or_inactive_candidate");
    expect(closed.recommended_action).toBe("reject_inactive");
  });

  it("leaves human_decision blank by default and includes required output row shape", () => {
    const result = buildPropertyDiscoveryResult({ seeds: [seed("ロッジスガノ")], existing: EXISTING });
    const row = result.rows[0]!;
    for (const key of DISCOVERY_CSV_HEADERS) expect(row).toHaveProperty(key);
    expect(row.human_decision).toBe("");
  });

  it("renders markdown, csv, and json review artifacts", () => {
    const result = buildPropertyDiscoveryResult({ seeds: [seed("ロッジスガノ"), seed("蔵王国際ホテル")], existing: EXISTING });
    expect(renderDiscoveryMarkdown(result)).toContain("Human Approval Instructions");
    expect(renderDiscoveryMarkdown(result)).toContain("D05 approved properties master update");
    expect(renderDiscoveryCsv(result.rows)).toContain("candidate_name,normalized_name,classification");
    expect(JSON.parse(renderDiscoveryJson(result)).summary.total_candidates).toBe(2);
  });

  it("builds existing comparison entries from collector targets and alias seed", () => {
    const entries = buildExistingPropertyEntries({ aliasSeedJson: JSON.stringify([{ canonical_property_name: "JURIN", aliases: ["蔵王温泉 JURIN"] }]), historyCsvs: [] });
    expect(entries.some((e) => e.canonical_property_name === "蔵王国際ホテル")).toBe(true);
    expect(entries.some((e) => e.canonical_property_name === "JURIN" && e.aliases.includes("蔵王温泉 JURIN"))).toBe(true);
  });

  it("does not produce active master or collector target updates", () => {
    const result = buildPropertyDiscoveryResult({ seeds: [seed("ロッジスガノ")], existing: EXISTING });
    expect(result.summary.safety_confirmation.property_master_written).toBe(false);
    expect(result.summary.safety_confirmation.collector_target_updated).toBe(false);
    expect(result.summary.safety_confirmation.history_modified).toBe(false);
    expect(result.summary.safety_confirmation.db_synced).toBe(false);
    expect(result.summary.safety_confirmation.ai_context_refreshed).toBe(false);
  });

  it("contains no executable collector, sync, context, or pricing command path", () => {
    const executableSource = SCRIPT_SOURCE;
    expect(executableSource).not.toMatch(/COLLECT_BOOKING|COLLECT_JALAN|ALLOW_HISTORY_APPEND|HISTORY_TO_DB_SYNC|BUILD_AI_CONTEXT/u);
    expect(executableSource).not.toMatch(/auto-runner:market-refresh|sync:history-to-db:fresh|build:ai-context-packs/u);
    expect(executableSource).not.toMatch(/pricing|Beds24|AirHost|PMS/u);
    expect(SERVICE_SOURCE).not.toMatch(/chromium\.launch|page\.goto|fetch\s*\(|https\.get/u);
  });

  it("registers npm run discover:properties", () => {
    expect(PACKAGE_JSON).toContain("\"discover:properties\"");
    expect(PACKAGE_JSON).toContain("src/scripts/runPropertyDiscovery.ts");
  });
});

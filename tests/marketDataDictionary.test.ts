import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FILES_NOT_TO_MODIFY_WITHOUT_APPROVAL,
  buildMarketDataDictionary,
  parseCsvTable,
  renderMarketDataDictionaryCsv,
  renderMarketDataDictionaryMarkdown
} from "../src/services/marketDataDictionary";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/marketDataDictionary.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildMarketDataDictionary.ts"), "utf8");

const HISTORY_HEADER =
  "row_id,row_hash,shard_month,collected_date_jst,collected_at_jst,normalized_at_jst,source,source_phase,collector_stage,canonical_property_name,source_property_name,property_identity_match,source_property_id,source_slug_or_code,checkin,checkout,stay_nights,group_adults,no_rooms,group_children,currency,language,stay_scope,availability_status,sold_out_status,normalized_total_price,normalized_total_price_source,normalized_total_price_basis,normalized_total_price_confidence,basis_confidence,basis_note,source_primary_price,source_secondary_price_or_adder,source_computed_total,source_tax_or_fee_classification,source_classification,is_price_usable_for_dp_direct,is_price_usable_for_dp_directional,is_price_excluded_from_dp,dp_exclusion_reason,warning_flags,source_report_path,source_csv_path,debug_artifact_path,schema_version";
const DEMAND_HEADER =
  "run_id,generated_at_jst,checkin_date,checkout_date,stay_scope,row_count,source_count,property_count,direct_price_row_count,directional_price_row_count,excluded_row_count,sold_out_count,available_count,not_listed_count,cross_source_median_jpy,direct_only_median_jpy,directional_median_jpy,sold_out_pressure_score,price_pressure_score,confidence_score,calendar_score,booking_window_score,demand_index,demand_band,pricing_posture,congestion_forecast_rank,confidence_level,basis_note,recommended_human_action,debug_artifact_path";
const UNIVERSE_HEADER =
  "canonical_property_name,canonicalization_status,aliases,sources_present,jalan_url,jalan_id,rakuten_url,rakuten_id,local_source,evidence_note,needs_human_review,review_decision,reviewer_note";
const SOURCE_CANDIDATE_HEADER =
  "canonical_property_name,source,candidate_property_url,candidate_source_property_id,verification_status,evidence_note,current_reviewer_note,human_review_required,review_decision,reviewed_property_url,reviewed_source_property_id,reviewer_note";
const EXCLUDED_HEADER =
  "source,property_name_raw,property_url,source_property_id,exclusion_reason,evidence_note,human_review_required,review_decision,reviewer_note";

function dictionary() {
  return buildMarketDataDictionary({
    runId: "market_data_dictionary_test",
    generatedAtJst: "2026-06-03T22:30:00+09:00",
    historyHeaders: parseCsvTable(`${HISTORY_HEADER}\n`).headers,
    demandHeaders: parseCsvTable(`${DEMAND_HEADER}\n`).headers,
    propertyUniverseHeaders: parseCsvTable(`${UNIVERSE_HEADER}\n`).headers,
    sourceCandidateHeaders: parseCsvTable(`${SOURCE_CANDIDATE_HEADER}\n`).headers,
    excludedAuditHeaders: parseCsvTable(`${EXCLUDED_HEADER}\n`).headers
  });
}

describe("market data dictionary", () => {
  it("includes file inventory", () => {
    const d = dictionary();
    expect(d.file_inventory.length).toBeGreaterThan(10);
    expect(d.file_inventory.some((f) => f.file_path.includes("ai_readable_market_manifest_latest.json"))).toBe(true);
    expect(d.file_inventory.some((f) => f.file_path.includes("matsukaneya_canonical_merge_20260603_211617"))).toBe(true);
  });

  it("includes history shard schema", () => {
    const names = dictionary().schemas.history_shard.map((c) => c.column_name);
    expect(names).toContain("row_id");
    expect(names).toContain("basis_confidence");
    expect(names).toContain("is_price_usable_for_dp_directional");
  });

  it("includes Demand Index schema", () => {
    const names = dictionary().schemas.demand_index.map((c) => c.column_name);
    expect(names).toContain("demand_index");
    expect(names).toContain("pricing_posture");
    expect(names).toContain("congestion_forecast_rank");
  });

  it("includes property universe schema", () => {
    const names = dictionary().schemas.property_universe.map((c) => c.column_name);
    expect(names).toContain("canonical_property_name");
    expect(names).toContain("canonicalization_status");
    expect(names).toContain("aliases");
  });

  it("includes source-specific price basis for Jalan, Rakuten, and Booking", () => {
    const rules = dictionary().source_price_basis_rules;
    expect(rules.find((r) => r.source === "jalan")?.rule).toContain("coupon guard");
    expect(rules.find((r) => r.source === "rakuten")?.rule).toContain("CHARGE_PER_HUMAN");
    expect(rules.find((r) => r.source === "booking")?.rule).toContain("visible tax/fee adder");
  });

  it("explicitly says Booking uses no base × 1.1", () => {
    const text = renderMarketDataDictionaryMarkdown(dictionary());
    expect(text).toContain("no synthetic Booking.com base × 1.1");
  });

  it("explains Rakuten CHARGE_PER_HUMAN and price * 2", () => {
    const text = renderMarketDataDictionaryMarkdown(dictionary());
    expect(text).toContain("CHARGE_PER_HUMAN");
    expect(text).toContain("computed 2-adult total = raw_price * 2");
  });

  it("explains A/B/C/insufficient confidence semantics", () => {
    const semantics = dictionary().confidence_semantics;
    expect(semantics.A).toContain("Direct usable");
    expect(semantics.B).toContain("Directional");
    expect(semantics.C).toContain("Excluded or weak");
    expect(semantics.insufficient).toContain("Not enough data");
  });

  it("explains direct/directional/excluded DP usage", () => {
    const semantics = dictionary().dp_usage_semantics;
    expect(semantics.direct).toContain("direct medians");
    expect(semantics.directional).toContain("not automated pricing");
    expect(semantics.excluded).toContain("Not used");
  });

  it("says Demand Index is prototype-only and congestion rank is not exact footfall", () => {
    const d = dictionary();
    expect(d.demand_index_dictionary.prototype_only).toBe(true);
    expect(d.demand_index_dictionary.congestion_rank_note).toContain("not exact restaurant footfall");
    expect(renderMarketDataDictionaryMarkdown(d)).toContain("Pricing posture is advisory only.");
  });

  it("says OTA stock is not actual occupancy", () => {
    expect(dictionary().known_misread_risks.join("\n")).toContain("OTA stock is not actual occupancy.");
  });

  it("includes Matsukaneya resolved note", () => {
    expect(dictionary().property_universe_dictionary.matsukaneya_resolved_note).toContain("Matsukaneya duplicate resolved");
    expect(dictionary().property_universe_dictionary.matsukaneya_resolved_note).toContain("ホテル松金屋アネックス retained");
  });

  it("says DP03X/R01X remain paused unless user asks", () => {
    const text = renderMarketDataDictionaryMarkdown(dictionary());
    expect(text).toContain("DP03X");
    expect(text).toContain("R01X");
    expect(text).toContain("unless the user explicitly asks");
  });

  it("lists files not to modify without approval", () => {
    const text = renderMarketDataDictionaryMarkdown(dictionary());
    for (const path of FILES_NOT_TO_MODIFY_WITHOUT_APPROVAL) expect(text).toContain(path);
  });

  it("latest pointer files are copies, not symlinks", () => {
    expect(SCRIPT_SOURCE).toContain("copyFileSync(reportPath, latestMarkdownPath)");
    expect(SCRIPT_SOURCE).toContain("copyFileSync(jsonPath, latestJsonPath)");
    expect(SCRIPT_SOURCE).not.toMatch(/symlinkSync/);
  });

  it("does not modify history or property master artifacts", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.data\/history/);
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.data\/exports\/zao-universe-review/);
    }
  });

  it("has no DB-write, GitHub Actions/GitOps activation, or export code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i);
      expect(src).not.toMatch(/(writeFileSync|copyFileSync|renameSync)\s*\([^)]*\.github\/workflows/);
      expect(src).not.toMatch(/git\s+commit|git\s+push/);
      expect(src).not.toMatch(/\*\s*1\.1/);
    }
  });

  it("CSV has no Beds24/AirHost/PMS export columns and decision is ready", () => {
    const d = dictionary();
    const csv = renderMarketDataDictionaryCsv(d);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe("section,file_or_schema,column_name,meaning,safe_for_pricing,safe_for_demand_signal,safe_for_identity,common_misread_risk");
    expect(header.toLowerCase()).not.toMatch(/roomid|beds24|airhost|pms|price1|price2/);
    expect(d.decision).toBe("market_data_dictionary_ready");
  });
});

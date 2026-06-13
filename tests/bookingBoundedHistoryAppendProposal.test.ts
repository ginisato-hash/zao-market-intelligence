import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReportFixture } from "./helpers/reportFixtureResolver";
import {
  buildFutureB11XPlan,
  buildPricePressurePolicy,
  buildProposalRows,
  buildSafetyConfirmation,
  computePreflight,
  computeTouchedShards,
  decideB10X,
  renderProposalCsv,
  validateB09XArtifact,
  type B09XArtifactLike,
  type B09XPreviewRow,
  type CurrentHistorySummary,
  type ExistingHistoryKey
} from "../src/services/bookingBoundedHistoryAppendProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/bookingBoundedHistoryAppendProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildBookingBoundedHistoryAppendProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function row(overrides: Partial<B09XPreviewRow> = {}): B09XPreviewRow {
  return {
    row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-07|2026-06-08|2_adults_1_room_1_night",
    row_hash: "a".repeat(64),
    shard_month: "2026_06",
    collected_date_jst: "2026-06-04",
    source: "booking",
    canonical_property_name: "蔵王国際ホテル",
    source_property_id: "zao-kokusai",
    source_slug_or_code: "zao-kokusai",
    checkin: "2026-06-07",
    checkout: "2026-06-08",
    checkin_date: "2026-06-07",
    checkout_date: "2026-06-08",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_flag: 0,
    normalized_total_price: 33_300,
    normalized_total_jpy: 33_300,
    basis_confidence: "B",
    source_primary_price: 33_000,
    source_secondary_price_or_adder: 300,
    source_computed_total: 33_300,
    classification: "booking_official_total_directional",
    dp_usage: "directional",
    exclusion_reason: "",
    price_pressure_usable: true,
    dp_usable: false,
    schema_version: "zao_local_history_v1",
    ...overrides
  };
}

function artifact(rows: B09XPreviewRow[]): B09XArtifactLike {
  return {
    decision: "booking_bounded_expanded_collection_basis_caution",
    normalized_rows_summary: {
      total_rows: rows.length,
      directional_rows: rows.filter((r) => r.dp_usage === "directional").length,
      excluded_rows: rows.filter((r) => r.dp_usage === "excluded").length,
      direct_rows: 0
    },
    schema_compatibility_summary: { compatible: true, schema_version: "zao_local_history_v1" },
    normalized_rows_preview: rows
  };
}

function excluded(overrides: Partial<B09XPreviewRow> = {}): B09XPreviewRow {
  return row({
    row_id: "2026-06-04|booking|蔵王四季のホテル|zao-shiki-no|2026-06-07|2026-06-08|2_adults_1_room_1_night",
    row_hash: "b".repeat(64),
    canonical_property_name: "蔵王四季のホテル",
    source_property_id: "zao-shiki-no",
    source_slug_or_code: "zao-shiki-no",
    normalized_total_price: null,
    normalized_total_jpy: null,
    source_secondary_price_or_adder: null,
    source_computed_total: null,
    basis_confidence: "C",
    dp_usage: "excluded",
    classification: "booking_missing_official_tax_fee_adder",
    exclusion_reason: "missing_official_tax_fee_adder",
    price_pressure_usable: false,
    ...overrides
  });
}

function historySummary(total = 160): CurrentHistorySummary {
  return {
    total_rows: total,
    rows_by_shard: {
      "2026_05": 2,
      "2026_06": 66,
      "2026_07": 68,
      "2026_08": 16,
      "2026_10": 7,
      "2026_12": 1
    },
    source_files: []
  };
}

function actualHistorySummary(): CurrentHistorySummary {
  const dir = resolve(__dirname, "../.data/history");
  const rowsByShard: Record<string, number> = {};
  let total = 0;
  for (const file of readdirSync(dir).filter((f) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(f))) {
    const shard = /^zao_signals_(\d{4}_\d{2})\.csv$/u.exec(file)?.[1] ?? "unknown";
    const count = readFileSync(join(dir, file), "utf8").split(/\r?\n/u).filter(Boolean).length - 1;
    rowsByShard[shard] = count;
    total += count;
  }
  return { total_rows: total, rows_by_shard: rowsByShard, source_files: [] };
}

describe("BOOKING-B10X — source artifact validation", () => {
  it("loads B09X artifact", () => {
    const b09x = JSON.parse(
      readFileSync(
        resolveReportFixture(".data/reports/source-discovery/booking_bounded_expanded_collection_20260604_161623.json"),
        "utf8"
      )
    ) as B09XArtifactLike;
    expect(b09x.decision).toBe("booking_bounded_expanded_collection_basis_caution");
    expect(b09x.normalized_rows_preview).toHaveLength(30);
  });

  it("requires B09X decision ready or basis_caution", () => {
    expect(validateB09XArtifact(artifact(Array.from({ length: 30 }, (_, i) => row({ row_id: `id-${i}` }))))).toBeTruthy();
    expect(validateB09XArtifact({ ...artifact([]), decision: "booking_bounded_expanded_collection_not_ready" }).reasons).toContain(
      "b09x_decision_not_ready"
    );
  });

  it("validates B09X preview row count = 30, 28 directional, 2 excluded, direct rows = 0", () => {
    const rows = [
      ...Array.from({ length: 28 }, (_, i) => row({ row_id: `directional-${i}`, row_hash: `${i}`.padStart(64, "a") })),
      excluded({ row_id: "excluded-1", row_hash: "c".repeat(64) }),
      excluded({ row_id: "excluded-2", row_hash: "d".repeat(64) })
    ];
    const validation = validateB09XArtifact(artifact(rows));
    expect(validation.valid).toBe(true);
  });
});

describe("BOOKING-B10X — proposal row conversion", () => {
  it("converts B09X preview rows into proposal rows", () => {
    const [proposal] = buildProposalRows([row()], []);
    expect(proposal?.booking_slug).toBe("zao-kokusai");
    expect(proposal?.history_action).toBe("append_new");
  });

  it("marks B rows append_directional", () => {
    const [proposal] = buildProposalRows([row()], []);
    expect(proposal?.append_recommendation).toBe("append_directional");
    expect(proposal?.price_pressure_usable).toBe(true);
  });

  it("marks C rows append_excluded_audit", () => {
    const [proposal] = buildProposalRows([excluded()], []);
    expect(proposal?.append_recommendation).toBe("append_excluded_audit");
    expect(proposal?.price_pressure_usable).toBe(false);
  });

  it("keeps dp_usable false for all Booking rows", () => {
    const proposals = buildProposalRows([row(), excluded()], []);
    expect(proposals.every((r) => r.dp_usable === false)).toBe(true);
  });

  it("keeps price_pressure_usable true only for valid B rows", () => {
    const proposals = buildProposalRows([row(), excluded()], []);
    expect(proposals.map((r) => r.price_pressure_usable)).toEqual([true, false]);
  });

  it("rejects base times 1.1 implementation", () => {
    expect(SERVICE_SOURCE).not.toMatch(/=\s*[^;\n]*\*\s*1\.1\b/);
    expect(SCRIPT_SOURCE).not.toMatch(/=\s*[^;\n]*\*\s*1\.1\b/);
  });
});

describe("BOOKING-B10X — history preflight", () => {
  it("computes current history row count", () => {
    // 160 baseline + 25 approved Booking observations appended in Phase BOOKING-B11X = 185,
    // + 25 approved Jalan AUTO03B rows appended in Phase JALAN-AUTO05X = 210,
    // + 9 approved Booking preview rows appended in Phase AUTO-RUNNER08Z = 219,
    // + 24 approved rows (9 Booking + 15 Jalan) appended in Phase AUTO-RUNNER10X-PATCH = 243,
    // + 3 intraday Booking price-change rows appended in Phase AUTO-RUNNER11Y first live run = 246,
    // + 24 rows (9 Booking + 15 Jalan) from first scheduled 09:00 run on 2026-06-08 = 270,
    // + 5 intraday Booking price-change rows from 15X-B controlled planner-driven live run = 275,
    // + 24 rows each from scheduled 09:00 runs on 2026-06-09 and 2026-06-10 = 323,
    // + 24 rows each from scheduled 09:00 runs on 2026-06-11, 2026-06-12, 2026-06-13 = 395,
    // + 11 rows each from the AUTO-RUNNER16X-D manual live-append pilot (x2) on 2026-06-14 = 417,
    // + 10 rows from the AUTO-RUNNER16X-E2 rotating-live cutover kickstart = 427,
    // + AUTO-RUNNER16X-F expanded-universe kickstarts (jalan 12, then 12 booking +
    //   12 jalan after the source-cap fix) = 463.
    expect(actualHistorySummary().total_rows).toBe(463);
  });

  it("computes touched shards and expected after-append rows", () => {
    const proposals = buildProposalRows([row(), row({ row_id: "july", row_hash: "e".repeat(64), shard_month: "2026_07", checkin: "2026-07-18" })], []);
    const touched = computeTouchedShards(proposals, historySummary());
    expect(touched.touched_shards).toEqual(["2026_06", "2026_07"]);
    expect(touched.expected_rows_by_shard_after_append["2026_06"]).toBe(67);
    expect(touched.expected_rows_by_shard_after_append["2026_07"]).toBe(69);
  });

  it("skip_identical when row_id/hash match", () => {
    const incoming = row();
    const existing: ExistingHistoryKey[] = [{ row_id: incoming.row_id, row_hash: incoming.row_hash, shard_month: incoming.shard_month }];
    expect(buildProposalRows([incoming], existing)[0]?.history_action).toBe("skip_identical");
  });

  it("block_conflict when row_id matches but hash differs", () => {
    const incoming = row();
    const existing: ExistingHistoryKey[] = [{ row_id: incoming.row_id, row_hash: "f".repeat(64), shard_month: incoming.shard_month }];
    const [proposal] = buildProposalRows([incoming], existing);
    expect(proposal?.history_action).toBe("block_conflict");
    expect(proposal?.append_recommendation).toBe("block_until_review");
  });

  it("append_new when row_id is new", () => {
    expect(buildProposalRows([row()], [])[0]?.history_action).toBe("append_new");
  });

  it("computes preflight counts", () => {
    const proposals = buildProposalRows([row(), excluded()], []);
    const preflight = computePreflight(proposals, historySummary());
    expect(preflight.append_new_count).toBe(2);
    expect(preflight.append_directional_count).toBe(1);
    expect(preflight.append_excluded_audit_count).toBe(1);
    expect(preflight.expected_total_after_append).toBe(162);
  });
});

describe("BOOKING-B10X — decision and plans", () => {
  it("generates price policy and future B11X plan", () => {
    expect(buildPricePressurePolicy().booking_direct_rows_allowed).toBe(0);
    expect(buildFutureB11XPlan().approval_gate.env_flag).toBe("BOOKING_BOUNDED_HISTORY_APPEND=1");
  });

  it("returns ready / basis_caution / not_ready", () => {
    const clean = buildProposalRows([row()], []);
    expect(decideB10X({ artifactValid: true, preflight: computePreflight(clean, historySummary()), proposalRows: clean })).toBe(
      "booking_bounded_history_append_proposal_ready"
    );
    const withExcluded = buildProposalRows([row(), excluded()], []);
    expect(decideB10X({ artifactValid: true, preflight: computePreflight(withExcluded, historySummary()), proposalRows: withExcluded })).toBe(
      "booking_bounded_history_append_proposal_basis_caution"
    );
    const conflict = buildProposalRows([row()], [{ row_id: row().row_id, row_hash: "f".repeat(64), shard_month: row().shard_month }]);
    expect(decideB10X({ artifactValid: true, preflight: computePreflight(conflict, historySummary()), proposalRows: conflict })).toBe(
      "booking_bounded_history_append_proposal_not_ready"
    );
  });

  it("renders proposal CSV", () => {
    expect(renderProposalCsv(buildProposalRows([row()], []))).toContain("append_directional");
  });
});

describe("BOOKING-B10X — safety scans", () => {
  it("does not write history", () => {
    expect(SERVICE_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync/);
    expect(SCRIPT_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync/);
  });

  it("does not write DB", () => {
    expect(SERVICE_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE\s+/i);
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE\s+/i);
  });

  it("does not refresh AI context", () => {
    expect(SERVICE_SOURCE).not.toContain("build:ai-context-packs");
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("does not run Playwright", () => {
    expect(SERVICE_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch/iu);
  });

  it("does not run live Booking probe", () => {
    expect(SCRIPT_SOURCE).not.toContain("probe:booking-bounded-expanded");
    expect(SCRIPT_SOURCE).not.toContain("probeBookingBoundedExpandedCollection");
  });

  it("has no PMS/Beds24/AirHost output", () => {
    expect(buildSafetyConfirmation().pms_beds24_airhost_ota_output).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/exportApproved|writeBeds|writeAir|pmsCsv/iu);
  });

  it("has no paid-source tooling", () => {
    expect(SERVICE_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/iu);
  });

  it("adds the npm script", () => {
    expect(PACKAGE_JSON).toContain("\"proposal:booking-bounded-history-append\"");
  });
});

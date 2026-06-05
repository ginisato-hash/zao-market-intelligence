import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFutureB07XPlan,
  buildProposalRows,
  classifyProposalRow,
  computePreflight,
  decideB06X,
  deriveRowId,
  renderProposalCsv,
  type B05XInputRow,
  type ExistingHistoryKey
} from "../src/services/bookingHistoryAppendProposal";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/bookingHistoryAppendProposal.ts"),
  "utf8"
);
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildBookingHistoryAppendProposal.ts"),
  "utf8"
);

// A B-confidence directional priced B05X row (official base + visible adder).
function directionalRow(overrides: Partial<B05XInputRow> = {}): B05XInputRow {
  return {
    row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    row_hash: "97a7bc2b69a8f9172fdc6493c19f87b74a875fa53f7e224e53fdaa27f6c7f60e",
    shard_month: "2026_06",
    schema_version: "zao_local_history_v1",
    collected_date_jst: "2026-06-04",
    source: "booking",
    canonical_property_name: "蔵王国際ホテル",
    source_property_id: "zao-kokusai",
    source_slug_or_code: "zao-kokusai",
    checkin_date: "2026-06-14",
    checkout_date: "2026-06-15",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_flag: 0,
    normalized_total_jpy: 32_157,
    basis_confidence: "B",
    source_primary_price: 26_573,
    source_official_tax_fee_adder: 5_584,
    source_computed_total_with_tax_fee: 32_157,
    classification: "booking_b04a_official_base_plus_adder_numeric",
    dp_usage: "directional",
    exclusion_reason: "",
    ...overrides
  };
}

// The C-confidence excluded audit row (missing official tax/fee adder).
function excludedRow(overrides: Partial<B05XInputRow> = {}): B05XInputRow {
  return {
    row_id: "2026-06-04|booking|蔵王四季のホテル|zao-shiki-no|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    row_hash: "b3afcf37690e9d784e429828161119793bd558d2af21d37e4b14b2251bd71fda",
    shard_month: "2026_06",
    schema_version: "zao_local_history_v1",
    collected_date_jst: "2026-06-04",
    source: "booking",
    canonical_property_name: "蔵王四季のホテル",
    source_property_id: "zao-shiki-no",
    source_slug_or_code: "zao-shiki-no",
    checkin_date: "2026-06-14",
    checkout_date: "2026-06-15",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_flag: 0,
    normalized_total_jpy: null,
    basis_confidence: "C",
    source_primary_price: 33_000,
    source_official_tax_fee_adder: null,
    source_computed_total_with_tax_fee: null,
    classification: "booking_b04a_price_basis_unclear",
    dp_usage: "excluded",
    exclusion_reason: "missing_official_tax_fee_adder",
    ...overrides
  };
}

// 14 directional rows + 1 excluded row (the realistic B05X shape).
function realisticInputs(): B05XInputRow[] {
  const slugs = ["zao-kokusai", "zao-shiki-no", "shinzanso-takamiya"] as const;
  const names: Record<string, string> = {
    "zao-kokusai": "蔵王国際ホテル",
    "zao-shiki-no": "蔵王四季のホテル",
    "shinzanso-takamiya": "深山荘 高見屋"
  };
  const dates: { checkin: string; checkout: string; shard: string }[] = [
    { checkin: "2026-06-14", checkout: "2026-06-15", shard: "2026_06" },
    { checkin: "2026-06-21", checkout: "2026-06-22", shard: "2026_06" },
    { checkin: "2026-07-18", checkout: "2026-07-19", shard: "2026_07" },
    { checkin: "2026-08-12", checkout: "2026-08-13", shard: "2026_08" },
    { checkin: "2026-10-10", checkout: "2026-10-11", shard: "2026_10" }
  ];
  const rows: B05XInputRow[] = [];
  for (const slug of slugs) {
    for (const d of dates) {
      const isExcluded = slug === "zao-shiki-no" && d.checkin === "2026-06-14";
      const base = isExcluded
        ? excludedRow({
            canonical_property_name: names[slug]!,
            source_property_id: slug,
            source_slug_or_code: slug
          })
        : directionalRow({
            canonical_property_name: names[slug]!,
            source_property_id: slug,
            source_slug_or_code: slug
          });
      rows.push({
        ...base,
        row_id: `2026-06-04|booking|${names[slug]}|${slug}|${d.checkin}|${d.checkout}|2_adults_1_room_1_night`,
        row_hash: `hash_${slug}_${d.checkin}`,
        shard_month: d.shard,
        checkin_date: d.checkin,
        checkout_date: d.checkout
      });
    }
  }
  return rows;
}

describe("Phase BOOKING-B06X — load & classify B05X rows", () => {
  it("(1) loads B05X rows into proposal rows", () => {
    const rows = buildProposalRows(realisticInputs(), []);
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.source === "booking")).toBe(true);
  });

  it("(2) identifies B-confidence directional priced rows", () => {
    const cls = classifyProposalRow(directionalRow());
    expect(cls.append_recommendation).toBe("append_directional");
    expect(cls.price_pressure_usable).toBe(true);
  });

  it("(3) identifies C-confidence excluded audit rows", () => {
    const cls = classifyProposalRow(excludedRow());
    expect(cls.append_recommendation).toBe("append_excluded_audit");
    expect(cls.price_pressure_usable).toBe(false);
  });

  it("(4) does not mark Booking rows as direct (dp_usable false)", () => {
    const rows = buildProposalRows(realisticInputs(), []);
    expect(rows.every((r) => r.dp_usable === false)).toBe(true);
    expect(rows.some((r) => r.append_recommendation === "append_directional")).toBe(true);
  });
});

describe("Phase BOOKING-B06X — row identity & preflight actions", () => {
  it("(5) computes row_id matching the canonical helper", () => {
    const input = directionalRow();
    expect(deriveRowId(input)).toBe(input.row_id);
  });

  it("(6) carries a well-formed 64-hex row_hash", () => {
    const rows = buildProposalRows([directionalRow()], []);
    expect(rows[0]!.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(7) detects a new row_id as append_new", () => {
    const rows = buildProposalRows([directionalRow()], []);
    expect(rows[0]!.history_action).toBe("append_new");
  });

  it("(8) detects an identical row_id+row_hash as skip_identical", () => {
    const input = directionalRow();
    const existing: ExistingHistoryKey[] = [
      { row_id: input.row_id, row_hash: input.row_hash, shard_month: input.shard_month }
    ];
    const rows = buildProposalRows([input], existing);
    expect(rows[0]!.history_action).toBe("skip_identical");
  });

  it("(9) detects a same row_id + different row_hash as block_conflict", () => {
    const input = directionalRow();
    const existing: ExistingHistoryKey[] = [
      { row_id: input.row_id, row_hash: "different_hash", shard_month: input.shard_month }
    ];
    const rows = buildProposalRows([input], existing);
    expect(rows[0]!.history_action).toBe("block_conflict");
    expect(rows[0]!.append_recommendation).toBe("block_until_review");
  });

  it("(10) computes touched shard_months from appended rows", () => {
    const rows = buildProposalRows(realisticInputs(), []);
    const preflight = computePreflight(rows, 145);
    expect(preflight.touched_shards).toEqual(["2026_06", "2026_07", "2026_08", "2026_10"]);
  });
});

describe("Phase BOOKING-B06X — append recommendations", () => {
  it("(11) produces append_directional for valid official-total rows", () => {
    const rows = buildProposalRows([directionalRow()], []);
    expect(rows[0]!.append_recommendation).toBe("append_directional");
    expect(rows[0]!.history_action).toBe("append_new");
  });

  it("(12) produces append_excluded_audit for the missing-adder row", () => {
    const rows = buildProposalRows([excludedRow()], []);
    expect(rows[0]!.append_recommendation).toBe("append_excluded_audit");
  });

  it("(13) price_pressure_usable true for B directional priced rows", () => {
    const rows = buildProposalRows([directionalRow()], []);
    expect(rows[0]!.price_pressure_usable).toBe(true);
  });

  it("(14) price_pressure_usable false for C excluded rows", () => {
    const rows = buildProposalRows([excludedRow()], []);
    expect(rows[0]!.price_pressure_usable).toBe(false);
  });

  it("(15) dp_usable false for all rows", () => {
    const rows = buildProposalRows(realisticInputs(), []);
    expect(rows.every((r) => r.dp_usable === false)).toBe(true);
  });

  it("(16) direct count remains 0", () => {
    const rows = buildProposalRows(realisticInputs(), []);
    expect(rows.filter((r) => r.dp_usable === true)).toHaveLength(0);
    expect(rows.some((r) => r.append_recommendation === "append_directional")).toBe(true);
  });

  it("(17) excluded audit rows do not affect price pressure", () => {
    const rows = buildProposalRows(realisticInputs(), []);
    const excluded = rows.filter((r) => r.append_recommendation === "append_excluded_audit");
    expect(excluded).toHaveLength(1);
    expect(excluded.every((r) => r.price_pressure_usable === false)).toBe(true);
  });
});

describe("Phase BOOKING-B06X — preflight & decision", () => {
  it("(18) preflight: 14 directional + 1 excluded, 0 conflict, expected total +15", () => {
    const rows = buildProposalRows(realisticInputs(), []);
    const preflight = computePreflight(rows, 145);
    expect(preflight.directional_append_count).toBe(14);
    expect(preflight.excluded_append_count).toBe(1);
    expect(preflight.new_row_count).toBe(15);
    expect(preflight.skip_identical_count).toBe(0);
    expect(preflight.conflict_count).toBe(0);
    expect(preflight.expected_total_after_append).toBe(160);
  });

  it("(19) decision is ready for a clean conflict-free proposal", () => {
    const rows = buildProposalRows(realisticInputs(), []);
    const decision = decideB06X(computePreflight(rows, 145));
    expect(decision).toBe("booking_history_append_proposal_ready");
  });

  it("(20) decision is basis_caution when a conflict is present", () => {
    const input = directionalRow();
    const existing: ExistingHistoryKey[] = [
      { row_id: input.row_id, row_hash: "different_hash", shard_month: input.shard_month }
    ];
    const rows = buildProposalRows([input], existing);
    expect(decideB06X(computePreflight(rows, 145))).toBe("booking_history_append_proposal_basis_caution");
  });

  it("(21) future B07X plan includes explicit approval + env flag BOOKING_HISTORY_APPEND=1", () => {
    const plan = buildFutureB07XPlan();
    expect(plan.approval_gate.env_flag).toBe("BOOKING_HISTORY_APPEND=1");
    expect(plan.approval_gate.explicit_approval_sentence.length).toBeGreaterThan(0);
    expect(plan.not_executed_in_b06x).toBe(true);
  });
});

describe("Phase BOOKING-B06X — safety scans (proposal only)", () => {
  it("(22) no Booking base × 1.1 in service or script", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/);
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SCRIPT_SOURCE).not.toMatch(/1\.1\s*\*/);
  });

  it("(23) script performs no DB writes", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/better-sqlite3|new Database\(|INSERT\s+INTO|\.prepare\(/);
  });

  it("(24) script performs no history append (no write into .data/history)", () => {
    expect(SCRIPT_SOURCE).not.toMatch(
      /(writeFile|writeFileSync|appendFile|appendFileSync)\s*\([^)]*\.data\/history/
    );
  });

  it("(25) script runs no live Booking probe and no Playwright", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/playwright|chromium|page\.goto|newContext/);
  });

  it("(26) script triggers no AI context refresh and no paid-source tooling", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/build:ai-context|buildAiContextPacks|execFileSync|execSync|spawnSync/);
    expect(SCRIPT_SOURCE).not.toMatch(/serpapi|dataforseo|apify|brightdata|oxylabs/i);
  });

  it("(27) script emits no PMS/Beds24/AirHost output", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/beds24|airhost|pms_upload|ota_upload/i);
  });
});

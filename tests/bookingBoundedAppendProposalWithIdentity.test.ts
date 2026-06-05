import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProposalRows,
  decideB10Z,
  renderProposalCsv,
  summarizeProposal,
  EXPECTED_APPEND_NEW,
  EXPECTED_APPEND_AFTER_IDENTITY_FIX,
  EXPECTED_BLOCK_TRUE_CONFLICT,
  EXPECTED_SKIP_BENIGN_DUPLICATE,
  type B09XIdentityPreviewRow,
  type B10ZProposalRow,
  type B10ZProposalSummary,
  type CurrentHistorySummary,
  type ExistingHistoryKey
} from "../src/services/bookingBoundedAppendProposalWithIdentity";
import type { B10YConflictRow } from "../src/services/bookingObservationIdentity";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/bookingBoundedAppendProposalWithIdentity.ts"),
  "utf8"
);
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildBookingBoundedAppendProposalWithIdentity.ts"),
  "utf8"
);

const B09X_ARTIFACT = resolve(
  __dirname,
  "../.data/reports/source-discovery/booking_bounded_expanded_collection_20260604_161623.json"
);
const B10Y_ARTIFACT = resolve(
  __dirname,
  "../.data/reports/automation/booking_conflict_resolution_proposal_20260604_163851.json"
);

function loadB09XRows(): B09XIdentityPreviewRow[] {
  const json = JSON.parse(readFileSync(B09X_ARTIFACT, "utf8")) as { normalized_rows_preview: B09XIdentityPreviewRow[] };
  return json.normalized_rows_preview;
}

function loadB10YConflicts(): B10YConflictRow[] {
  const json = JSON.parse(readFileSync(B10Y_ARTIFACT, "utf8")) as { conflict_comparison_rows: B10YConflictRow[] };
  return json.conflict_comparison_rows;
}

// Build the existing-history identity snapshot the way it stands today: the 15
// B10Y conflict row_ids already live in history with their *existing* row_hash
// (which differs from the new B09X row_hash). The other 15 B09X rows are absent.
function buildExistingKeys(rows: B09XIdentityPreviewRow[], conflicts: B10YConflictRow[]): ExistingHistoryKey[] {
  const existingHashByRowId = new Map<string, string>();
  for (const c of conflicts) existingHashByRowId.set(c.row_id, c.existing_row_hash);
  const keys: ExistingHistoryKey[] = [];
  for (const row of rows) {
    const existingHash = existingHashByRowId.get(row.row_id);
    if (existingHash !== undefined) keys.push({ row_id: row.row_id, row_hash: existingHash, shard_month: row.shard_month });
  }
  return keys;
}

const HISTORY_SUMMARY: CurrentHistorySummary = {
  total_rows: 160,
  rows_by_shard: { "2026_06": 60, "2026_07": 60, "2026_08": 20, "2026_10": 12, "2026_05": 6, "2026_12": 2 },
  source_files: []
};

function buildRows(): B10ZProposalRow[] {
  const b09x = loadB09XRows();
  const conflicts = loadB10YConflicts();
  return buildProposalRows(b09x, buildExistingKeys(b09x, conflicts), conflicts);
}

describe("B10Z proposal rows", () => {
  const rows = buildRows();
  const summary = summarizeProposal(rows, HISTORY_SUMMARY);

  it("1. produces one proposal row per B09X preview row (30)", () => {
    expect(rows.length).toBe(30);
    expect(summary.proposal_row_count).toBe(30);
  });
  it("2. classifies 15 brand-new rows as append_new", () => {
    expect(summary.append_new_count).toBe(EXPECTED_APPEND_NEW);
  });
  it("3. classifies 5 metadata-only conflicts as skip_benign_duplicate", () => {
    expect(summary.skip_benign_duplicate_count).toBe(EXPECTED_SKIP_BENIGN_DUPLICATE);
  });
  it("4. classifies 10 market-value conflicts as append_new_observation_after_identity_fix", () => {
    expect(summary.append_new_observation_after_identity_fix_count).toBe(EXPECTED_APPEND_AFTER_IDENTITY_FIX);
  });
  it("5. blocks nothing (block_true_conflict=0, manual_review=0)", () => {
    expect(summary.block_true_conflict_count).toBe(EXPECTED_BLOCK_TRUE_CONFLICT);
    expect(summary.manual_review_count).toBe(0);
  });
  it("6. computes 25 appendable rows and expected_total_after_append=185", () => {
    expect(summary.total_appendable_count).toBe(25);
    expect(summary.expected_total_after_append).toBe(185);
  });
  it("7. has zero skip_identical (B09X rows all differ from history)", () => {
    expect(summary.skip_identical_count).toBe(0);
  });
  it("8. append_new rows carry no existing row identity", () => {
    const appendNew = rows.filter((r) => r.history_action === "append_new");
    expect(appendNew.length).toBe(15);
    for (const r of appendNew) {
      expect(r.existing_row_id).toBe("");
      expect(r.existing_row_hash).toBe("");
      expect(r.conflict_classification).toBe("no_conflict");
    }
  });
  it("9. conflict rows never reuse the existing row_hash (no overwrite/supersede)", () => {
    const conflictRows = rows.filter((r) => r.history_action !== "append_new");
    expect(conflictRows.length).toBe(15);
    for (const r of conflictRows) {
      expect(r.existing_row_hash).not.toBe("");
      expect(r.existing_row_hash).not.toBe(r.new_row_hash);
    }
  });
  it("10. every row carries the four derived identity values", () => {
    for (const r of rows) {
      expect(r.market_identity_key).toMatch(/^[0-9a-f]{64}$/u);
      expect(r.observation_id).toMatch(/^[0-9a-f]{64}$/u);
      expect(r.market_value_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(r.observation_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(r.market_identity_plain_key).toContain("|");
    }
  });
  it("11. derives observation_id from collected_at_jst (not degraded)", () => {
    for (const r of rows) {
      expect(r.observation_id_basis).toBe("collected_at_jst");
      expect(r.observation_id_degraded).toBe(false);
    }
  });
  it("12. keeps dp_usable=false on every row", () => {
    for (const r of rows) expect(r.dp_usable).toBe(false);
  });
  it("13. produces no direct rows and no block recommendations", () => {
    for (const r of rows) {
      expect(r.append_recommendation).not.toBe("block_until_manual_review");
    }
  });
  it("14. splits appendable rows into directional + excluded audit", () => {
    expect(summary.append_directional_count + summary.append_excluded_audit_count).toBe(summary.total_appendable_count);
    expect(summary.append_excluded_audit_count).toBeGreaterThanOrEqual(1);
  });
  it("15. carries B10Y difference detail on conflict rows", () => {
    const marketValueRows = rows.filter((r) => r.history_action === "append_new_observation_after_identity_fix");
    expect(marketValueRows.length).toBe(10);
    for (const r of marketValueRows) {
      expect(r.market_value_changed_fields.length).toBeGreaterThan(0);
    }
  });
});

describe("B10Z skip_identical detection", () => {
  it("16. marks a row whose hash already matches history as skip_identical", () => {
    const b09x = loadB09XRows();
    const conflicts = loadB10YConflicts();
    const target = b09x.find((r) => !conflicts.some((c) => c.row_id === r.row_id))!;
    const keys: ExistingHistoryKey[] = [
      ...buildExistingKeys(b09x, conflicts),
      { row_id: target.row_id, row_hash: target.row_hash, shard_month: target.shard_month }
    ];
    const rows = buildProposalRows(b09x, keys, conflicts);
    const hit = rows.find((r) => r.new_row_id === target.row_id)!;
    expect(hit.history_action).toBe("skip_identical");
    expect(hit.append_recommendation).toBe("skip");
  });
});

describe("B10Z decision", () => {
  const rows = buildRows();
  const summary = summarizeProposal(rows, HISTORY_SUMMARY);

  it("17. is ready when all inputs load and nothing blocks", () => {
    expect(
      decideB10Z({ b09xLoaded: true, id02xLoaded: true, historyParsed: true, summary, anyObservationIdDegraded: false })
    ).toBe("booking_bounded_append_with_identity_proposal_ready");
  });
  it("18. is not_ready when an input artifact is missing", () => {
    expect(
      decideB10Z({ b09xLoaded: false, id02xLoaded: true, historyParsed: true, summary, anyObservationIdDegraded: false })
    ).toBe("booking_bounded_append_with_identity_proposal_not_ready");
    expect(
      decideB10Z({ b09xLoaded: true, id02xLoaded: false, historyParsed: true, summary, anyObservationIdDegraded: false })
    ).toBe("booking_bounded_append_with_identity_proposal_not_ready");
    expect(
      decideB10Z({ b09xLoaded: true, id02xLoaded: true, historyParsed: false, summary, anyObservationIdDegraded: false })
    ).toBe("booking_bounded_append_with_identity_proposal_not_ready");
  });
  it("19. is not_ready when a true conflict or manual review exists", () => {
    const blocked: B10ZProposalSummary = { ...summary, block_true_conflict_count: 1 };
    expect(
      decideB10Z({ b09xLoaded: true, id02xLoaded: true, historyParsed: true, summary: blocked, anyObservationIdDegraded: false })
    ).toBe("booking_bounded_append_with_identity_proposal_not_ready");
    const manual: B10ZProposalSummary = { ...summary, manual_review_count: 1 };
    expect(
      decideB10Z({ b09xLoaded: true, id02xLoaded: true, historyParsed: true, summary: manual, anyObservationIdDegraded: false })
    ).toBe("booking_bounded_append_with_identity_proposal_not_ready");
  });
  it("20. is basis_caution when an observation_id is degraded", () => {
    expect(
      decideB10Z({ b09xLoaded: true, id02xLoaded: true, historyParsed: true, summary, anyObservationIdDegraded: true })
    ).toBe("booking_bounded_append_with_identity_proposal_basis_caution");
  });
});

describe("B10Z CSV rendering", () => {
  it("21. renders one header + one line per row", () => {
    const rows = buildRows();
    const csv = renderProposalCsv(rows);
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(rows.length + 1);
    expect(lines[0]).toContain("new_row_id");
    expect(lines[0]).toContain("history_action");
  });
});

describe("B10Z safety scans", () => {
  it("22. does not append history", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|renameSync|copyFileSync|appendFileSync)\s*\([^)]*\.data\/history/u);
    }
  });
  it("23. does not write or sync the DB", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/better-sqlite3|openLocalDatabase|INSERT\s+INTO|\.prepare\(|history-to-db-sync|syncHistoryToDb/iu);
    }
  });
  it("24. does not refresh AI context", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/buildAiContextPacks|refreshAiContext|ai-context-pack/iu);
    }
  });
  it("25. does not fetch Booking / no Playwright / no collector run", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/fetch\(|Playwright|chromium|page\.goto|probeBooking/u);
    }
  });
  it("26. no PMS/Beds24/AirHost output", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/Beds24|AirHost|PMS upload|OTA upload/u);
    }
  });
  it("27. no Booking base × 1.1", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\*\s*1\.1\b/u);
    }
  });
  it("28. never overwrites or supersedes existing rows", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/overwriteExisting|supersedeRow|UPDATE\s+|replaceRow/u);
    }
  });
});

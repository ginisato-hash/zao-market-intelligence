// Phase ZMI BOOKING-MARKET-RECRAWL-APPEND — gated append plan for the competitor
// re-crawl preview observations.
//
// Reconstructs HistoryRow candidates from the batch preview artifacts via the
// CANONICAL buildProposedHistoryRow (so room/meal-basis markers + rowId/rowHash +
// the 45-column v1 schema are identical to the live append path), dedups against
// existing history, and ONLY writes when ZMI_APPEND_BOOKING_MARKET_RECRAWL=1 AND
// every gate passes (own=0, conflicts=0, schema_errors=0, invalid=0). The actual
// write uses the proven runRealAppend (lock + backup + atomic + rollback).
//
// Own properties (三浦屋 / 喜らく) can never become candidates (circularity guard).
// NO Beds24 / PMS / pricing CSV / publish / launchd / cron.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProposedHistoryRow } from "../services/bookingPreviewAppendProposal";
import { groupRowsToSourceShards } from "../services/bookingPreviewHistoryAppendRealRun";
import { runRealAppend, validatePostWriteShards } from "../services/localHistoryRealAppend";
import { HISTORY_CSV_HEADERS, type HistoryRow } from "../services/localHistorySchemaDesign";
import { historyRowFromCsvRecord, parseCsv } from "../services/localHistoryAppendValidationPolicy";
import { SOURCE_PHASE, STAY_SCOPE, type PreviewRow } from "../services/autoRunnerBookingPreview";
import { checkoutForOneNight } from "../services/bookingRenderedDomProbe";
import { canonicalizeName, isOwnProperty } from "../services/biWebDataExport";

const HISTORY_DIR = ".data/history";
const REPORT_GLOB_DIR = ".data/reports/source-discovery";
const CRAWL_DIR = ".data/crawl-priority";
const OUT_DIR = ".data/validation";
const APPEND_ENV = "ZMI_APPEND_BOOKING_MARKET_RECRAWL";
const CHECKIN_RE = /^\d{4}-\d{2}-\d{2}$/u;

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function ts(): string {
  const d = new Date(); const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function esc(v: string): string { return /[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v; }

interface RawObs { canonical_property_name: string; checkin: string; room_basis?: string | undefined; room_basis_reason?: string | undefined; primary_room_name?: string | undefined; primary_bed_hint?: string | undefined; primary_price_numeric: number | null; classification?: string | undefined; collected_at_jst: string; source_artifact: string; recrawl_batch_index: number }

function readPreviewArtifacts(): { obs: RawObs[]; artifacts: string[] } {
  const obs: RawObs[] = []; const artifacts: string[] = [];
  if (!existsSync(REPORT_GLOB_DIR)) return { obs, artifacts };
  for (const f of readdirSync(REPORT_GLOB_DIR).filter((x) => /^booking_market_recrawl_preview_.*\.json$/u.test(x)).sort()) {
    const path = join(REPORT_GLOB_DIR, f);
    const d = JSON.parse(readFileSync(path, "utf8")) as { generated_at_jst?: string; selected_batch_index?: number; rows?: Array<Record<string, unknown>> };
    artifacts.push(path);
    for (const r of d.rows ?? []) {
      obs.push({
        canonical_property_name: String(r["canonical_property_name"] ?? ""),
        checkin: String(r["checkin"] ?? ""),
        room_basis: r["room_basis"] === null || r["room_basis"] === undefined ? undefined : String(r["room_basis"]),
        room_basis_reason: r["room_basis_reason"] === null || r["room_basis_reason"] === undefined ? undefined : String(r["room_basis_reason"]),
        primary_room_name: r["primary_room_name"] === null || r["primary_room_name"] === undefined ? undefined : String(r["primary_room_name"]),
        primary_bed_hint: r["primary_bed_hint"] === null || r["primary_bed_hint"] === undefined ? undefined : String(r["primary_bed_hint"]),
        primary_price_numeric: r["primary_price_numeric"] === null || r["primary_price_numeric"] === undefined ? null : Number(r["primary_price_numeric"]),
        classification: r["classification"] === null || r["classification"] === undefined ? undefined : String(r["classification"]),
        collected_at_jst: String(d.generated_at_jst ?? jstNow()),
        source_artifact: path,
        recrawl_batch_index: Number(d.selected_batch_index ?? -1)
      });
    }
  }
  return { obs, artifacts };
}

// canonical_property_name -> booking slug, from the batch plan (history evidence).
function slugByName(): Map<string, string> {
  const m = new Map<string, string>();
  const path = join(CRAWL_DIR, "booking_market_recrawl_batches.json");
  if (!existsSync(path)) return m;
  const d = JSON.parse(readFileSync(path, "utf8")) as { batches?: Array<{ cells?: Array<{ canonical_property_name: string; booking_slug: string }> }> };
  for (const b of d.batches ?? []) for (const c of b.cells ?? []) if (c.canonical_property_name && c.booking_slug) m.set(c.canonical_property_name, c.booking_slug);
  return m;
}

// Reconstruct the PreviewRow the live recrawl produced (deterministic fields +
// the stored observation), faithful enough for buildProposedHistoryRow.
function toReconstructedPreviewRow(o: RawObs, slug: string): PreviewRow {
  const classification = (o.classification === "directional" ? "directional" : "excluded") as PreviewRow["classification"];
  const pr: PreviewRow = {
    source: "booking",
    property_slug: slug,
    canonical_property_name: o.canonical_property_name,
    checkin: o.checkin,
    checkout: checkoutForOneNight(o.checkin),
    stay_scope: STAY_SCOPE,
    availability_status: classification === "directional" ? "available_price_basis" : "visible_no_safe_price",
    primary_price_numeric: o.primary_price_numeric,
    official_tax_fee_adder_numeric: null,
    computed_total_with_tax_fee: null,
    basis_confidence: classification === "directional" ? "directional_candidate_basis" : "insufficient",
    dp_usage: classification === "directional" ? "directional_only" : "audit_only",
    classification,
    screenshot_path: "",
    debug_path: "",
    warning_flags: [],
    collected_at_jst: o.collected_at_jst,
    source_phase: SOURCE_PHASE,
    primary_room_name: o.primary_room_name ?? "",
    primary_bed_hint: o.primary_bed_hint ?? "",
    room_basis_reason: o.room_basis_reason ?? ""
  };
  if (o.room_basis !== undefined) pr.room_basis = o.room_basis as NonNullable<PreviewRow["room_basis"]>;
  return pr;
}

function readExistingRowHashById(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(HISTORY_DIR)) return m;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const recs = parseCsv(readFileSync(join(HISTORY_DIR, f), "utf8"));
    if (recs.length < 2) continue;
    const header = recs[0]!;
    if (header.join(",") !== HISTORY_CSV_HEADERS.join(",")) continue;
    for (const rec of recs.slice(1)) {
      try { const row = historyRowFromCsvRecord(rec); m.set(row.rowId, row.rowHash); } catch { /* skip unparseable */ }
    }
  }
  return m;
}

function run(): void {
  const appendMode = process.env[APPEND_ENV] === "1";
  // Conflict policy: default fails closed; skip_conflicts_append_unique skips
  // BOTH exact duplicates and conflicting duplicates (never overwrites — history
  // stays append-only) and appends only unique rows.
  const conflictPolicy = process.env["ZMI_APPEND_CONFLICT_POLICY"] === "skip_conflicts_append_unique"
    ? "skip_conflicts_append_unique"
    : "fail_on_conflict";
  const { obs, artifacts } = readPreviewArtifacts();
  const slugs = slugByName();
  const existing = readExistingRowHashById();

  let ownRows = 0, invalid = 0, schemaErrors = 0, dupSkipped = 0, dupConflicts = 0;
  let confirmed = 0, probable = 0, unknown = 0, excluded = 0, usablePrice = 0, excludedPrice = 0;
  const toAppend: HistoryRow[] = [];
  const previewCsvRows: string[][] = [["canonical_property_name", "checkin", "room_basis", "is_price_excluded_from_dp", "is_price_usable_for_dp_directional", "normalized_total_price", "source_classification", "dedup_status"]];

  for (const o of obs) {
    if (o.canonical_property_name === "" || !CHECKIN_RE.test(o.checkin)) { invalid += 1; continue; }
    if (isOwnProperty(o.canonical_property_name)) { ownRows += 1; continue; } // circularity guard
    const slug = slugs.get(o.canonical_property_name) ?? "";
    if (slug === "") { invalid += 1; continue; }
    const rb = o.room_basis ?? "unknown_room_basis";
    const priced = o.primary_price_numeric !== null;
    if (rb === "confirmed_two_person_standard_room") confirmed += 1;
    else if (rb === "probable_two_person_standard_room") probable += 1;
    else if (rb === "unknown_room_basis") unknown += 1;
    else excluded += 1;

    let hRow: HistoryRow;
    try { hRow = buildProposedHistoryRow({ row: toReconstructedPreviewRow(o, slug), sourceReportPath: o.source_artifact, sourceCsvPath: o.source_artifact }); }
    catch { schemaErrors += 1; continue; }
    // Schema guard: HistoryRow must render to exactly 45 columns (no schema change).
    const renderedCols = groupRowsToSourceShards([hRow])[0]?.csv.split("\n")[0]?.split(",").length ?? 0;
    if (renderedCols !== HISTORY_CSV_HEADERS.length) { schemaErrors += 1; continue; }

    const excludedSample = hRow.isPriceExcludedFromDp === true;
    if (priced && !excludedSample) usablePrice += 1;
    if (priced && excludedSample) excludedPrice += 1;

    let dedup = "new";
    const prevHash = existing.get(hRow.rowId);
    if (prevHash !== undefined) {
      if (prevHash === hRow.rowHash) { dupSkipped += 1; dedup = "duplicate_skip"; }
      else { dupConflicts += 1; dedup = "duplicate_conflict"; }
    } else {
      toAppend.push(hRow);
    }
    previewCsvRows.push([o.canonical_property_name, o.checkin, rb, String(excludedSample), String(hRow.isPriceUsableForDpDirectional), String(o.primary_price_numeric ?? ""), hRow.sourceClassification, dedup]);
  }

  const candidateTotal = confirmed + probable + unknown + excluded;
  // Conflicts are NEVER appended (toAppend only holds new rowIds). Under
  // skip_conflicts_append_unique the gate tolerates conflicts (they are skipped);
  // under fail_on_conflict any conflict blocks the append.
  const conflictGateOk = conflictPolicy === "skip_conflicts_append_unique" ? true : dupConflicts === 0;
  const appendAllowed = ownRows === 0 && schemaErrors === 0 && invalid === 0 && conflictGateOk && toAppend.length > 0;

  const plan = {
    generated_at_jst: jstNow(),
    mode: appendMode ? "append" : "plan-only",
    conflict_policy: conflictPolicy,
    source_preview_artifacts: artifacts,
    candidate_total: candidateTotal,
    candidate_confirmed: confirmed,
    candidate_probable: probable,
    candidate_unknown: unknown,
    candidate_excluded: excluded,
    candidate_usable_price_samples: usablePrice,
    candidate_excluded_price_samples: excludedPrice,
    own_property_rows: ownRows,
    duplicate_skipped: dupSkipped,
    duplicate_conflicts: dupConflicts,
    conflict_skipped: conflictPolicy === "skip_conflicts_append_unique" ? dupConflicts : 0,
    schema_errors: schemaErrors,
    invalid_rows: invalid,
    expected_high_uplift_rows: confirmed,
    expected_medium_uplift_rows: probable,
    expected_no_price_sample_rows: excludedPrice,
    rows_to_append_after_dedup: toAppend.length,
    append_allowed: appendAllowed,
    append_performed: false,
    history_files_to_update: [...new Set(toAppend.map((r) => `zao_signals_${r.shardMonth}.csv`))].sort(),
    notes: [
      "Reconstructed via canonical buildProposedHistoryRow (45-col v1 schema, rowId/rowHash, room-basis markers identical to live append).",
      "Own properties (三浦屋/喜らく) excluded by circularity guard (own_property_rows must be 0).",
      "excluded room-type rows are appended as audit rows with is_price_excluded_from_dp=true (observed but not a market price sample).",
      "Append only runs with ZMI_APPEND_BOOKING_MARKET_RECRAWL=1 AND all gates green; write uses runRealAppend (lock+backup+atomic+rollback)."
    ] as string[],
    append_result: null as unknown
  };

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const planJson = resolve(OUT_DIR, "booking_market_recrawl_append_plan.json");
  const planCsv = resolve(OUT_DIR, "booking_market_recrawl_append_plan.csv");
  const rowsPreviewCsv = resolve(OUT_DIR, "booking_market_recrawl_append_rows_preview.csv");
  writeFileSync(rowsPreviewCsv, previewCsvRows.map((r) => r.map(esc).join(",")).join("\n") + "\n", "utf8");

  const printPlan = (): void => {
    writeFileSync(planJson, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    const kv = Object.entries(plan).filter(([, v]) => typeof v !== "object");
    writeFileSync(planCsv, [["key", "value"], ...kv.map(([k, v]) => [k, String(v)])].map((r) => r.map((x) => esc(String(x))).join(",")).join("\n") + "\n", "utf8");
  };

  for (const [k, v] of Object.entries(plan)) if (typeof v !== "object") console.log(`${k}=${v}`);

  if (!appendMode) { printPlan(); console.log(`decision=booking_market_recrawl_append_plan_only`); console.log(`plan_json=${planJson}`); console.log(`rows_preview_csv=${rowsPreviewCsv}`); return; }

  if (!appendAllowed) { printPlan(); console.log(`decision=booking_market_recrawl_append_blocked_gate_failed`); process.exitCode = 1; return; }
  if (toAppend.length === 0) { printPlan(); console.log(`decision=booking_market_recrawl_append_noop_all_duplicates`); return; }

  // Gated atomic append (lock + backup + rollback are inside runRealAppend).
  const backupTs = ts();
  const result = runRealAppend({ historyDir: HISTORY_DIR, runId: `booking_market_recrawl_append_${backupTs}`, backupTimestamp: backupTs, sourceShards: groupRowsToSourceShards(toAppend) });
  const touched = [...new Set(toAppend.map((r) => r.shardMonth))].map((sm) => ({ fileName: `zao_signals_${sm}.csv`, csv: readFileSync(resolve(HISTORY_DIR, `zao_signals_${sm}.csv`), "utf8"), expectedRowCount: 0 }));
  const postOk = touched.every((t) => /^row_id,/u.test(t.csv) || t.csv.split("\n")[0]?.startsWith("row_id"));
  plan.append_performed = result.rowsWritten > 0;
  plan.append_result = { decision: result.decision, rowsWritten: result.rowsWritten, rowsSkippedDuplicate: result.rowsSkippedDuplicate, rowsConflict: result.rowsConflict, filesUpdated: result.filesUpdated, backupsCreated: result.backupsCreated, backupDir: result.backupDir, rollbackPerformed: result.rollbackPerformed };
  printPlan();
  console.log(`decision=${result.decision}`);
  console.log(`append_performed=${plan.append_performed}`);
  console.log(`rows_written=${result.rowsWritten}`);
  console.log(`rows_skipped_duplicate=${result.rowsSkippedDuplicate}`);
  console.log(`rows_conflict=${result.rowsConflict}`);
  console.log(`files_updated=${result.filesUpdated}`);
  console.log(`backups_created=${result.backupsCreated}`);
  console.log(`rollback_performed=${result.rollbackPerformed}`);
  console.log(`post_header_ok=${postOk}`);
  console.log(`plan_json=${planJson}`);
  if (result.rollbackPerformed || result.rowsConflict > 0) process.exitCode = 1;
}

run();

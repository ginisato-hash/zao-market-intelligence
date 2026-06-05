// Phase BOOKING-B06X — build the Booking normalized history append PROPOSAL.
//
// Pure data-processing orchestrator (NO Playwright, NO live Booking fetch). It
// reads the latest B05X normalized-collection JSON artifact + a read-only
// snapshot of the existing .data/history shard row identities, classifies each
// B05X row as a directional price-pressure signal or an excluded audit signal,
// runs an append preflight (append_new / skip_identical / block_conflict) against
// existing history, and writes a proposal (MD/JSON/CSV) + debug artifacts.
//
// This script APPENDS NO history, writes NO DB rows, refreshes NO AI context,
// runs no live Booking fetch, drives no headless browser, emits no property-
// management or OTA upload output, performs NO price update, and uses NO Booking
// base × 1.1. It only reads existing files and writes report/debug artifacts.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildFutureB07XPlan,
  buildProposalRows,
  computePreflight,
  decideB06X,
  renderProposalCsv,
  renderProposalReport,
  type B05XInputRow,
  type ExistingHistoryKey
} from "../services/bookingHistoryAppendProposal";

const B05X_REPORT_DIR = ".data/reports/source-discovery";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-history-append-proposal";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

// Pick the most recent B05X normalized-collection JSON artifact.
function findLatestB05XJson(): string {
  const dir = resolve(B05X_REPORT_DIR);
  const candidates = readdirSync(dir)
    .filter((f) => /^booking_broader_normalized_collection_\d{8}_\d{6}\.json$/u.test(f))
    .sort();
  const latest = candidates.at(-1);
  if (!latest) throw new Error(`No B05X normalized-collection JSON found in ${dir}`);
  return join(dir, latest);
}

// Read existing .data/history shard row identities (row_id, row_hash, shard_month).
// row_id/row_hash/shard_month are the first three columns and contain no commas,
// so a simple split is safe for this read-only identity snapshot.
function readExistingHistoryKeys(): { keys: ExistingHistoryKey[]; rowCount: number } {
  const dir = resolve(HISTORY_DIR);
  let shardFiles: string[] = [];
  try {
    shardFiles = readdirSync(dir).filter((f) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(f));
  } catch {
    return { keys: [], rowCount: 0 };
  }
  const keys: ExistingHistoryKey[] = [];
  for (const file of shardFiles) {
    const text = readFileSync(join(dir, file), "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const rowId = cols[0] ?? "";
      const rowHash = cols[1] ?? "";
      const shardMonth = cols[2] ?? "";
      if (rowId) keys.push({ row_id: rowId, row_hash: rowHash, shard_month: shardMonth });
    }
  }
  return { keys, rowCount: keys.length };
}

async function run(): Promise<{ reportPath: string; jsonPath: string; csvPath: string; decision: string }> {
  const ts = timestamp();
  const runId = `booking_b06x_${ts}`;
  const generatedAtJst = jstIso();

  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const sourceB05XJsonPath = findLatestB05XJson();
  const b05x = JSON.parse(readFileSync(sourceB05XJsonPath, "utf8")) as { rows: B05XInputRow[] };
  const inputs = b05x.rows;

  const { keys: existingKeys, rowCount: existingHistoryRowCount } = readExistingHistoryKeys();

  const rows = buildProposalRows(inputs, existingKeys);
  const preflight = computePreflight(rows, existingHistoryRowCount);
  const decision = decideB06X(preflight);
  const futurePlan = buildFutureB07XPlan();

  const reportPath = resolve(REPORT_DIR, `booking_history_append_proposal_${ts}.md`);
  const csvPath = resolve(REPORT_DIR, `booking_history_append_proposal_${ts}.csv`);
  const jsonPath = resolve(REPORT_DIR, `booking_history_append_proposal_${ts}.json`);

  writeFileSync(csvPath, renderProposalCsv(rows), "utf8");
  writeFileSync(
    reportPath,
    renderProposalReport({
      generatedAtJst,
      runId,
      decision,
      sourceB05XJsonPath,
      preflight,
      rows,
      futurePlan,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );

  const safetyConfirmation = {
    history_appended: false,
    db_writes: false,
    ai_context_refreshed: false,
    live_booking_fetch: false,
    headless_browser_used: false,
    property_management_or_ota_output: false,
    price_update: false,
    github_actions_or_cron: false,
    paid_source_tooling_used: false,
    base_times_1_1_used: false,
    proposal_only: true
  };

  const summary = {
    decision,
    runId,
    generatedAtJst,
    sourceB05XJsonPath,
    pricePolicyVersion: "booking_official_visible_adder_v1",
    schemaVersion: "zao_local_history_v1",
    preflight,
    futurePlan,
    safetyConfirmation,
    rows
  };
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  await writeFile(
    join(debugRootPath, "source_b05x_artifact.json"),
    JSON.stringify({ sourceB05XJsonPath, rowCount: inputs.length }, null, 2),
    "utf8"
  );
  await writeFile(
    join(debugRootPath, "existing_history_summary.json"),
    JSON.stringify({ historyDir: resolve(HISTORY_DIR), existingHistoryRowCount }, null, 2),
    "utf8"
  );
  await writeFile(join(debugRootPath, "proposal_rows.json"), JSON.stringify(rows, null, 2), "utf8");
  await writeFile(join(debugRootPath, "preflight_summary.json"), JSON.stringify(preflight, null, 2), "utf8");
  await writeFile(
    join(debugRootPath, "touched_shards.json"),
    JSON.stringify(preflight.touched_shards, null, 2),
    "utf8"
  );
  await writeFile(
    join(debugRootPath, "price_pressure_policy.json"),
    JSON.stringify(
      {
        append_directional: { price_pressure_usable: true, dp_usable: false },
        append_excluded_audit: { price_pressure_usable: false, dp_usable: false },
        direct_count: 0
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(join(debugRootPath, "future_b07x_plan.json"), JSON.stringify(futurePlan, null, 2), "utf8");
  await writeFile(
    join(debugRootPath, "safety_confirmation.json"),
    JSON.stringify(safetyConfirmation, null, 2),
    "utf8"
  );

  return { reportPath, jsonPath, csvPath, decision };
}

run()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`json_summary_path=${result.jsonPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`decision=${result.decision}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

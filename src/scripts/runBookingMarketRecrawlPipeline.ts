// Phase ZMI BOOKING-MARKET-RECRAWL-PIPELINE — scheduled one-batch competitor
// re-crawl operator. Orchestrates the existing, separately-tested scripts (it
// adds NO new collection/append logic) in sequence:
//   lock -> preflight -> (re)build batch plan -> pick next batch -> preview-only
//   live recrawl (1 batch) -> append plan -> conflict-safe UNIQUE-only append ->
//   bi:web:export/check -> confidence review -> commit/push (data only) ->
//   bi:web:publish -> run report -> state advance -> unlock.
//
// Guarantees: one batch per run; own properties never in a batch (guarded by the
// underlying scripts); append-only with conflict-skip (never overwrite); the
// existing auto-runner:booking-preview global cap is untouched; commits ONLY
// generated data shards + BI data (never source). NO Beds24 / PMS / pricing CSV.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const STATE_PATH = ".data/state/booking_market_recrawl_state.json";
const LOCK_PATH = ".data/locks/booking_market_recrawl.lock";
const RUN_REPORT_DIR = ".data/reports/automation";
const BATCH_PLAN = ".data/crawl-priority/booking_market_recrawl_batches.json";
const APPEND_PLAN = ".data/validation/booking_market_recrawl_append_plan.json";
const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2h

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function tsId(): string { const d = new Date(); const p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function log(m: string): void { console.log(`[recrawl-pipeline] ${m}`); }

interface CmdResult { ok: boolean; out: string; status: number }
function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): CmdResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...extraEnv } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0, out, status: r.status ?? -1 };
}
function npmRun(script: string, extraEnv: Record<string, string> = {}, passthrough: string[] = []): CmdResult {
  return run("npm", ["run", script, ...(passthrough.length ? ["--", ...passthrough] : [])], extraEnv);
}
function kv(out: string, key: string): string | null {
  const m = out.split("\n").reverse().find((l) => l.startsWith(`${key}=`));
  return m ? m.slice(key.length + 1).trim() : null;
}

interface State { next_batch_index: number; last_success_at_jst: string | null; last_batch_index: number | null; last_rows_appended: number; last_publish_url: string | null }
function readState(): State {
  if (existsSync(STATE_PATH)) { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State; } catch { /* fall through */ } }
  return { next_batch_index: 0, last_success_at_jst: null, last_batch_index: null, last_rows_appended: 0, last_publish_url: null };
}
function writeState(s: State): void { mkdirSync(resolve(".data/state"), { recursive: true }); writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`, "utf8"); }

function finishReport(report: Record<string, unknown>): void {
  mkdirSync(resolve(RUN_REPORT_DIR), { recursive: true });
  const path = resolve(RUN_REPORT_DIR, `booking_market_recrawl_run_${tsId()}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  for (const [k, v] of Object.entries(report)) if (typeof v !== "object" || v === null) console.log(`${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  console.log(`run_report=${path}`);
}

function main(): void {
  const mode = process.env["ZMI_MARKET_RECRAWL_MODE"] === "scheduled" ? "scheduled" : "pilot";
  const report: Record<string, unknown> = { generated_at_jst: jstNow(), mode, decision: "started", conflict_policy: "skip_conflicts_append_unique" };

  // 1. Lock.
  mkdirSync(resolve(".data/locks"), { recursive: true });
  if (existsSync(LOCK_PATH)) {
    const ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs;
    if (ageMs < LOCK_STALE_MS) { report.decision = "aborted_locked"; report.lock_age_ms = ageMs; finishReport(report); process.exitCode = 1; return; }
    log(`stale lock (${Math.round(ageMs / 60000)}min) — removing`); report.stale_lock_removed = true; rmSync(LOCK_PATH, { force: true });
  }
  writeFileSync(LOCK_PATH, `${jstNow()} pid=${process.pid}\n`, "utf8");

  try {
    // 2. Preflight — no uncommitted SOURCE/TEST changes (data/generated allowed).
    const dirty = run("git", ["status", "--porcelain"]).out.split("\n").map((l) => l.trim()).filter(Boolean);
    const srcDirty = dirty.filter((l) => /\s(src\/|tests\/|package\.json|wrangler\.toml|ops\/)/u.test(l) || /\b(src\/|tests\/)/u.test(l));
    if (srcDirty.length > 0) { report.decision = "aborted_uncommitted_source"; report.uncommitted = srcDirty.slice(0, 20); finishReport(report); process.exitCode = 1; return; }
    const check = npmRun("bi:web:check");
    if (!check.ok || kv(check.out, "validation_ok") !== "true") { report.decision = "aborted_bi_check_failed"; finishReport(report); process.exitCode = 1; return; }

    // 3. Rebuild targeting + gap + batch plan (plan-only).
    npmRun("target:booking-low-confidence");
    npmRun("review:booking-verified-target-gap");
    const planOnly = npmRun("preview:booking-market-recrawl", {}, ["--plan-only"]);
    const batchCount = Number(kv(planOnly.out, "batch_count") ?? "0") || 0;
    if (batchCount === 0 || !existsSync(BATCH_PLAN)) { report.decision = "aborted_no_batches"; finishReport(report); process.exitCode = 1; return; }
    report.batch_count = batchCount;

    // 4. Pick next batch.
    const state = readState();
    const batchIndex = ((state.next_batch_index % batchCount) + batchCount) % batchCount;
    report.selected_batch_index = batchIndex;

    // 5. Bounded plan-only for the chosen batch (page-cap check + own guard).
    const batchPlan = npmRun("preview:booking-market-recrawl", { ZMI_RECRAWL_BATCH_INDEX: String(batchIndex) }, ["--plan-only"]);
    const estPages = Number(kv(batchPlan.out, "estimated_pages") ?? "999") || 999;
    const ownExcluded = Number(kv(batchPlan.out, "own_properties_excluded_count") ?? "0");
    report.estimated_pages = estPages; report.own_properties_excluded_count = ownExcluded;
    if (kv(batchPlan.out, "decision") === "booking_market_recrawl_stopped_page_cap_exceeded") { report.decision = "aborted_page_cap_exceeded"; finishReport(report); process.exitCode = 1; return; }

    // 6. Live preview-only recrawl (1 batch).
    const live = npmRun("preview:booking-market-recrawl", { COLLECT_BOOKING: "1", ZMI_RECRAWL_BATCH_INDEX: String(batchIndex) });
    const previewJson = kv(live.out, "preview_json");
    report.preview_decision = kv(live.out, "decision"); report.preview_selected_pages = kv(live.out, "selected_pages");
    report.preview_confirmed = kv(live.out, "confirmed"); report.preview_high_uplift_potential = kv(live.out, "preview_high_uplift_potential"); report.preview_medium_uplift_potential = kv(live.out, "preview_medium_uplift_potential");
    if (!live.ok || !previewJson || !existsSync(previewJson)) { report.decision = "aborted_preview_failed"; finishReport(report); process.exitCode = 1; return; }
    report.preview_json = previewJson;

    // 7. Append plan-only scoped to THIS batch's artifact.
    const appendEnv = { ZMI_APPEND_CONFLICT_POLICY: "skip_conflicts_append_unique", ZMI_RECRAWL_APPEND_ARTIFACT: previewJson };
    npmRun("plan:booking-market-recrawl-append", appendEnv);
    const plan = existsSync(APPEND_PLAN) ? JSON.parse(readFileSync(APPEND_PLAN, "utf8")) as Record<string, number | boolean> : {};
    report.append_plan = plan;
    const appendAllowed = plan["append_allowed"] === true;
    const ownRows = Number(plan["own_property_rows"] ?? 1);
    const schemaErrors = Number(plan["schema_errors"] ?? 1);
    const invalidRows = Number(plan["invalid_rows"] ?? 1);
    const rowsToAppend = Number(plan["rows_to_append_after_dedup"] ?? 0);
    report.duplicate_skipped = plan["duplicate_skipped"]; report.conflict_skipped = plan["conflict_skipped"]; report.rows_to_append = rowsToAppend;
    if (ownRows !== 0 || schemaErrors !== 0 || invalidRows !== 0) { report.decision = "aborted_append_gate_failed"; finishReport(report); process.exitCode = 1; return; }

    let rowsAppended = 0;
    if (appendAllowed && rowsToAppend > 0) {
      // 8. Gated conflict-safe append.
      const ap = npmRun("plan:booking-market-recrawl-append", { ...appendEnv, ZMI_APPEND_BOOKING_MARKET_RECRAWL: "1" });
      rowsAppended = Number(kv(ap.out, "rows_written") ?? "0") || 0;
      report.append_decision = kv(ap.out, "decision"); report.rows_written = rowsAppended; report.rollback_performed = kv(ap.out, "rollback_performed");
      if (kv(ap.out, "rollback_performed") === "true") { report.decision = "aborted_append_rollback"; finishReport(report); process.exitCode = 1; return; }
    } else {
      report.note_no_unique_rows = "no unique rows to append (all duplicate/conflict) — advancing state only";
    }

    // 9. BI export/check (always — reflects history state).
    npmRun("bi:web:export");
    const check2 = npmRun("bi:web:check");
    report.bi_check_decision = kv(check2.out, "decision"); report.bi_validation_ok = kv(check2.out, "validation_ok");
    if (!check2.ok || kv(check2.out, "validation_ok") !== "true") { report.decision = "aborted_bi_check_failed_post_append"; finishReport(report); process.exitCode = 1; return; }

    // 10. Confidence review (record).
    const conf = npmRun("review:booking-price-confidence");
    report.price_confidence_after = kv(conf.out, "price_confidence_after");

    let publishUrl: string | null = null;
    if (rowsAppended > 0) {
      // 11. Commit DATA only (history shards + BI data) + push.
      run("git", ["add", "--", ".data/history", "apps/zmi-bi-web/data/metadata.json", "apps/zmi-bi-web/data/zmi_market_unified.csv"]);
      const commit = run("git", ["commit", "-m", `Run Booking market recrawl batch ${batchIndex}`]);
      report.commit_ok = commit.ok; report.commit_out = commit.out.split("\n").slice(-3).join(" | ");
      if (commit.ok) {
        const push = run("git", ["push", "origin", "main"]);
        report.push_ok = push.ok;
        // 12. Publish.
        const pub = npmRun("bi:web:publish");
        publishUrl = kv(pub.out, "url"); report.publish_decision = kv(pub.out, "decision"); report.publish_url = publishUrl;
      }
    } else {
      // No data change: restore any timestamp-only BI re-export to keep tree clean.
      run("git", ["restore", "--", "apps/zmi-bi-web/data/metadata.json", "apps/zmi-bi-web/data/zmi_market_unified.csv"]);
    }

    // 13. Advance state.
    writeState({ next_batch_index: (batchIndex + 1) % batchCount, last_success_at_jst: jstNow(), last_batch_index: batchIndex, last_rows_appended: rowsAppended, last_publish_url: publishUrl });
    report.rows_appended = rowsAppended;
    report.decision = rowsAppended > 0 ? "booking_market_recrawl_run_success_appended" : "booking_market_recrawl_run_success_no_unique_rows";
    finishReport(report);
  } finally {
    rmSync(LOCK_PATH, { force: true });
  }
}

main();

// Phase AUTO-RUNNER16X-A3 — source mapping verification runner.
//
// Identity-only probe of candidate Booking slugs / Jalan yadIds: confirms the
// id maps to the expected property in the expected region. NEVER collects price,
// NEVER enters booking flow, NEVER logs in / injects cookies / bypasses captcha,
// NEVER uses a paid proxy. Candidates with no known id are reported not_found
// without guessing/searching. Writes report/debug artifacts only; mutates no
// history/DB/AI context.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CANDIDATE_ONLY_TARGETS } from "../services/marketRefreshTargetUniverse";
import {
  decideVerification,
  renderVerificationCsv,
  renderVerificationReport,
  summarize,
  type MappingVerificationCandidate,
  type MappingVerificationResult,
  type ProbeObservation
} from "../services/sourceMappingVerification";

const REPORT_DIR = ".data/reports/source-mapping-verification";
const DEBUG_ROOT = ".data/debug/source-mapping-verification";
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-mapping-verify/0.1; identity-only)";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function jstIso(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

// Candidate set: only candidate_only targets that carry a real slug/id are
// network-probeable. Those without an id are reported not_found (no guessing).
function gatherCandidates(): MappingVerificationCandidate[] {
  return CANDIDATE_ONLY_TARGETS.map((t) => ({
    source: (t.source === "booking" || t.source === "jalan" ? t.source : "jalan") as "booking" | "jalan",
    canonical_property_name: t.canonical_property_name,
    candidate_slug_or_id: t.property_slug,
    candidate_url: t.source === "booking" && t.property_slug ? `https://www.booking.com/hotel/jp/${t.property_slug}.ja.html?lang=ja`
      : t.source === "jalan" && t.property_slug ? `https://www.jalan.net/${t.property_slug}/`
        : "",
    evidence_source: "manual_candidate_universe" as const,
    tier: t.tier
  })).filter((c) => c.source === "booking" || c.source === "jalan");
}

async function probe(candidate: MappingVerificationCandidate, context: import("playwright").BrowserContext, artifactDir: string): Promise<ProbeObservation> {
  if (candidate.candidate_slug_or_id === "" || candidate.candidate_url === "") {
    return { has_id: false, loaded: false, http_status: 0, blocked_or_captcha: false, login_required: false, not_found: false, page_title: "", visible_text: "", error: "" };
  }
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  let loaded = false; let status = 0; let title = ""; let text = ""; let error = "";
  try {
    const resp = await page.goto(candidate.candidate_url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    loaded = resp !== null; status = resp?.status() ?? 0;
    await page.waitForTimeout(3_000);
    title = await page.title().catch(() => "");
    text = await page.locator("body").innerText({ timeout: 6_000 }).catch(() => "");
    await page.screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: false }).catch(() => undefined);
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  finally { await page.close().catch(() => undefined); }
  const hay = `${title}\n${text}`;
  return {
    has_id: true, loaded, http_status: status,
    blocked_or_captcha: /captcha|recaptcha|are you a robot|ロボットではありません|セキュリティチェック/iu.test(hay),
    login_required: /(ログイン|サインイン|sign in|log in)/iu.test(hay) && text.length < 1_000,
    not_found: /(page not found|ページが見つかりません|お探しのページ|指定された施設は存在しません)/iu.test(hay),
    page_title: title, visible_text: text.slice(0, 20_000), error
  };
}

async function run(): Promise<void> {
  const ts = timestamp();
  const generatedAtJst = jstIso();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const debugRoot = resolve(DEBUG_ROOT, ts);
  mkdirSync(debugRoot, { recursive: true });

  const candidates = gatherCandidates();
  const results: MappingVerificationResult[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  try {
    for (const candidate of candidates) {
      const artifactDir = join(debugRoot, `${candidate.source}_${candidate.candidate_slug_or_id || "noid"}`);
      mkdirSync(artifactDir, { recursive: true });
      const obs = await probe(candidate, context, artifactDir);
      const decided = decideVerification(candidate, obs);
      results.push({ ...decided, debug_artifact_path: artifactDir });
      writeFileSync(join(artifactDir, "observation.json"), `${JSON.stringify({ ...obs, visible_text: obs.visible_text.slice(0, 2_000) }, null, 2)}\n`, "utf8");
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const summary = summarize(results);
  const reportPath = resolve(REPORT_DIR, `source_mapping_verification_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `source_mapping_verification_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `source_mapping_verification_${ts}.csv`);
  writeFileSync(reportPath, renderVerificationReport({ generatedAtJst, results, summary }), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify({ generated_at_jst: generatedAtJst, summary, results }, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderVerificationCsv(results), "utf8");

  console.log(`decision=source_mapping_verification_complete`);
  console.log(`verified_booking_count=${summary.verified_booking_count}`);
  console.log(`verified_jalan_count=${summary.verified_jalan_count}`);
  console.log(`candidate_found_needs_review_count=${summary.candidate_found_needs_review_count}`);
  console.log(`not_found_count=${summary.not_found_count}`);
  console.log(`ambiguous_count=${summary.ambiguous_count}`);
  console.log(`blocked_or_captcha_count=${summary.blocked_or_captcha_count}`);
  console.log(`failed_count=${summary.failed_count}`);
  console.log(`safe_to_enable_live=${results.filter((r) => r.safe_to_enable_live).map((r) => `${r.source}:${r.candidate_slug_or_id}`).join(",") || "none"}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugRoot}`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

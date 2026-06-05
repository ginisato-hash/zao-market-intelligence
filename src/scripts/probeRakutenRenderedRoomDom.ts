// Phase RAKUTEN-ROOM04X — orchestrate the single-page rendered DOM feasibility
// probe for Lucent's Rakuten room-list page.
//
// This script opens EXACTLY ONE Lucent Rakuten room-list page with Playwright,
// using normal browser rendering only. It opens one page with one navigation,
// follows no links, calls no calendar endpoint, writes no DB rows, mutates no
// history, refreshes no AI context, uses no anti-bot evasion or authentication,
// uses no paid data tooling, and touches no other OTA. If a block / security
// challenge / 403 / consent wall appears, it records the state and stops.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  buildRakutenRenderedRoomDomResult,
  extractProbeTargetUrl,
  renderRakutenRenderedRoomDomCsv,
  renderRakutenRenderedRoomDomReport,
  ROOM01X_ARTIFACT_PATH,
  ROOM02X_ARTIFACT_PATH,
  ROOM03X_ARTIFACT_PATH,
  type RakutenRenderedRoomDomResult,
  type Room02xArtifactLike
} from "../services/rakutenRenderedRoomDomProbe";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-rendered-room-dom-probe";
const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-rendered-room-dom-probe/0.1; low-volume feasibility)";
const MAX_RUNTIME_MS = 30_000;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function runProbe(): Promise<{
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugRootPath: string;
  result: RakutenRenderedRoomDomResult;
}> {
  const ts = timestamp();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugRootPath, { recursive: true });

  const room01x = readJson(ROOM01X_ARTIFACT_PATH);
  const room02x = readJson(ROOM02X_ARTIFACT_PATH) as Room02xArtifactLike;
  const room03x = readJson(ROOM03X_ARTIFACT_PATH);
  const probeTargetUrl = extractProbeTargetUrl(room02x);

  // Single page, single navigation only.
  let loaded = false;
  let httpStatus = 0;
  let finalUrl = probeTargetUrl;
  let pageTitle = "";
  let bodyText = "";
  let bodyHtml = "";
  let error = "";

  if (probeTargetUrl) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
    const page = await context.newPage();
    page.setDefaultTimeout(MAX_RUNTIME_MS);
    try {
      const response = await page.goto(probeTargetUrl, { waitUntil: "domcontentloaded", timeout: MAX_RUNTIME_MS });
      loaded = response !== null;
      httpStatus = response?.status() ?? 0;
      await page.waitForTimeout(5_000);
      finalUrl = page.url();
      pageTitle = await page.title().catch(() => "");
      bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
      bodyHtml = await page.content().catch(() => "");
      await page.screenshot({ path: join(debugRootPath, "screenshot.png"), fullPage: true }).catch(() => undefined);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      finalUrl = page.url() || probeTargetUrl;
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  } else {
    error = "ROOM02X room-list URL was not found; no page opened.";
  }

  const result = buildRakutenRenderedRoomDomResult({
    runId: `rakuten_rendered_room_dom_probe_${ts}`,
    generatedAtJst: jstIso(),
    room02xArtifact: room02x,
    probeTargetUrl,
    rendered: {
      loaded,
      httpStatus,
      finalUrl,
      pageTitle,
      bodyText,
      bodyHtml,
      sourceUrl: probeTargetUrl,
      error
    },
    forbiddenMethodUsed: false
  });

  const reportPath = resolve(REPORT_DIR, `rakuten_rendered_room_dom_probe_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `rakuten_rendered_room_dom_probe_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `rakuten_rendered_room_dom_probe_${ts}.csv`);
  writeFileSync(reportPath, renderRakutenRenderedRoomDomReport(result), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderRakutenRenderedRoomDomCsv(result), "utf8");

  // Debug artifacts.
  await writeFile(join(debugRootPath, "source_room01x_artifact.json"), JSON.stringify(room01x, null, 2), "utf8");
  await writeFile(join(debugRootPath, "source_room02x_artifact.json"), JSON.stringify(room02x, null, 2), "utf8");
  await writeFile(join(debugRootPath, "source_room03x_artifact.json"), JSON.stringify(room03x, null, 2), "utf8");
  await writeFile(join(debugRootPath, "probe_target_url.json"), JSON.stringify({ probe_target_url: probeTargetUrl }, null, 2), "utf8");
  await writeFile(join(debugRootPath, "rendered_visible_text_excerpt.txt"), bodyText.slice(0, 250_000), "utf8");
  await writeFile(
    join(debugRootPath, "rendered_links.json"),
    JSON.stringify(result.room_identifier_candidates.map((c) => ({ url: c.candidate_url, type: c.candidate_type, room: c.candidate_room_name })), null, 2),
    "utf8"
  );
  await writeFile(
    join(debugRootPath, "rendered_data_attributes.json"),
    JSON.stringify({ data_attribute_count: result.data_attribute_count }, null, 2),
    "utf8"
  );
  await writeFile(
    join(debugRootPath, "rendered_script_state_candidates.json"),
    JSON.stringify({ script_state_candidate_count: result.script_state_candidate_count }, null, 2),
    "utf8"
  );
  await writeFile(
    join(debugRootPath, "rendered_room_identifier_candidates.json"),
    JSON.stringify(result.room_identifier_candidates, null, 2),
    "utf8"
  );
  await writeFile(join(debugRootPath, "blocked_or_captcha_detection.json"), JSON.stringify(result.blocked_or_captcha, null, 2), "utf8");
  await writeFile(
    join(debugRootPath, "rakuten_go_no_go_decision.json"),
    JSON.stringify(
      {
        decision: result.decision,
        rakuten_priority_decision: result.rakuten_priority_decision,
        recommended_next_action: result.recommended_next_action
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(join(debugRootPath, "safety_confirmation.json"), JSON.stringify(result.safety_confirmation, null, 2), "utf8");

  return { reportPath, jsonPath, csvPath, debugRootPath, result };
}

runProbe()
  .then((out) => {
    console.log(`report_path=${out.reportPath}`);
    console.log(`json_path=${out.jsonPath}`);
    console.log(`csv_path=${out.csvPath}`);
    console.log(`debug_root=${out.debugRootPath}`);
    console.log(`probe_target_url=${out.result.probe_target_url}`);
    console.log(`candidates=${out.result.room_identifier_candidates.length}`);
    console.log(`decision=${out.result.decision}`);
    console.log(`rakuten_priority_decision=${out.result.rakuten_priority_decision}`);
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });

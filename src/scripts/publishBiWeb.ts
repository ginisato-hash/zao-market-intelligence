// Phase ZMI BI Web — publish the static BI page to Cloudflare Pages (deploy-only).
//
// 1. runs the read-only data export, 2. verifies the data files exist, 3. if
// Cloudflare auth is present, runs `wrangler pages deploy`. If auth is missing
// it stops at deploy-ready WITHOUT failing — the live rotating collector is
// never affected by this script (separate process, no shared state). NEVER
// appends/syncs/refreshes/emits pricing/PMS.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const APP_DIR = "apps/zmi-bi-web";
const DATA_DIR = `${APP_DIR}/data`;
const PROJECT_NAME = "zmi-bi-web";
const ENV_FILE = ".env.cloudflare.local";

// Load Cloudflare auth from .env.cloudflare.local when it is not already in the
// environment. launchd does not inherit interactive `export`s, and under macOS
// TCC a launchd shell cannot `source` a file under ~/Documents — but node CAN
// read it (same as the rotating collector reads package.json/history). Only
// CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are read; values are never logged.
function loadCloudflareEnvFile(): void {
  if (process.env["CLOUDFLARE_API_TOKEN"] && process.env["CLOUDFLARE_ACCOUNT_ID"]) return;
  if (!existsSync(resolve(ENV_FILE))) return;
  const text = readFileSync(resolve(ENV_FILE), "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const m = line.match(/^\s*(?:export\s+)?(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*(.*)\s*$/u);
    if (!m) continue;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[m[1]!]) process.env[m[1]!] = val;
  }
}

function run(): void {
  loadCloudflareEnvFile();
  // 1. Export (read-only).
  const exp = spawnSync("npm", ["run", "bi:web:export"], { encoding: "utf8" });
  process.stdout.write(exp.stdout ?? "");
  if (exp.status !== 0) {
    console.log("decision=bi_web_publish_export_failed");
    process.exitCode = 1;
    return;
  }

  // 2. Verify deploy artifacts.
  const csvPath = resolve(DATA_DIR, "zmi_market_unified.csv");
  const metaPath = resolve(DATA_DIR, "metadata.json");
  const indexPath = resolve(APP_DIR, "index.html");
  const missing = [csvPath, metaPath, indexPath].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    console.log("decision=bi_web_publish_artifacts_missing");
    console.log(`missing=${missing.join(",")}`);
    process.exitCode = 1;
    return;
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { unified_rows?: number };
  if ((meta.unified_rows ?? 0) <= 0) {
    console.log("decision=bi_web_publish_empty_dataset");
    process.exitCode = 1;
    return;
  }

  // 3. Cloudflare auth gate. Missing auth is deploy-ready, NOT a failure.
  const hasAuth = !!process.env["CLOUDFLARE_API_TOKEN"] && !!process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (!hasAuth) {
    console.log("decision=bi_web_deploy_ready_cloudflare_auth_missing");
    console.log(`app_dir=${resolve(APP_DIR)}`);
    console.log(`csv_path=${csvPath}`);
    console.log(`metadata_path=${metaPath}`);
    console.log("note=set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, then re-run npm run bi:web:publish");
    return; // exit 0 — do not affect any other job
  }

  // 4. Deploy via wrangler.
  const dep = spawnSync("npx", ["wrangler", "pages", "deploy", APP_DIR, "--project-name", PROJECT_NAME, "--branch", "main", "--commit-dirty=true"], { encoding: "utf8" });
  process.stdout.write(dep.stdout ?? "");
  process.stderr.write(dep.stderr ?? "");
  if (dep.status !== 0) {
    console.log("decision=bi_web_deploy_failed");
    process.exitCode = 1; // failure is local to this script; live runner unaffected
    return;
  }
  const url = (dep.stdout ?? "").match(/https:\/\/[^\s]+\.pages\.dev[^\s]*/u)?.[0] ?? "";
  console.log("decision=bi_web_published");
  console.log(`url=${url}`);
}

run();

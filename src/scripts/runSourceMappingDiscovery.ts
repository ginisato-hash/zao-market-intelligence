// Phase AUTO-RUNNER16X-A4 — public OTA source mapping discovery runner.
//
// Discovers Booking hotel slugs / Jalan yadIds for candidate properties on
// PUBLIC first-party OTA pages, then identity-probes each discovered property
// page (name + region only). NEVER collects price, NEVER enters booking flow,
// NEVER logs in / injects cookies / bypasses captcha, NEVER uses stealth or a
// paid proxy/scraping service. Writes report/debug artifacts only; mutates no
// universe/history/DB/AI context (promotion to the live universe is a manual,
// reviewed code change).
//
// Public discovery surfaces:
//  - Jalan: keyword listing 蔵王温泉 (Shift_JIS form params, paginated 次へ),
//    plus per-candidate keyword fallback searches submitted via an in-page
//    form so the browser produces the site's native Shift_JIS encoding.
//  - Booking: first-party searchresults (ss=蔵王温泉 area scan, plus
//    per-candidate ss=<name> fallback), pairing card title <-> hotel slug.
//  - Phase 47X repo seeds (public first-party URL discovery) as candidate
//    Booking slugs; every seed still must pass the live identity probe.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  BOOKING_SLUG_SEEDS,
  DISCOVERY_CANDIDATES,
  alreadyLiveVerified,
  bookingHotelUrl,
  decideDiscovery,
  jalanYadUrl,
  matchPairsToCandidate,
  renderDiscoveryCsv,
  renderDiscoveryReport,
  summarizeDiscovery,
  type DiscoveredPagePair,
  type DiscoveryProbeObservation,
  type DiscoverySource,
  type SourceMappingDiscoveryCandidate,
  type SourceMappingDiscoveryResult
} from "../services/sourceMappingDiscovery";
import { liveBookingTargets, liveJalanTargets } from "../services/marketRefreshTargetUniverse";

const REPORT_DIR = ".data/reports/source-mapping-discovery";
const DEBUG_ROOT = ".data/debug/source-mapping-discovery";
const USER_AGENT = "Mozilla/5.0 (compatible; zao-market-intelligence-mapping-discovery/0.1; identity-only)";
// Shift_JIS percent-encoding of 蔵王温泉 (the listing endpoint decodes SJIS).
const JALAN_ZAO_LIST_URL = "https://www.jalan.net/uw/uwp2011/uww2011init.do?keyword=%91%A0%89%A4%89%B7%90%F2&distCd=06&rootCd=7701";
const JALAN_LIST_MAX_PAGES = 4;
const BOOKING_AREA_SEARCH_URL = `https://www.booking.com/searchresults.ja.html?ss=${encodeURIComponent("蔵王温泉")}`;
const BLOCK_RE = /captcha|recaptcha|are you a robot|ロボットではありません|セキュリティチェック|access denied|attention required/iu;
const NOT_FOUND_RE = /(page not found|ページが見つかりません|お探しのページ|指定された施設は存在しません|この施設は現在ご利用いただけません)/iu;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function jstIso(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

interface RunnerOptions {
  sources: DiscoverySource[];
  maxCandidates: number;
  maxPages: number;
  dryRun: boolean;
  candidateFilter: string;
}

function parseOptions(): RunnerOptions {
  const sourcesRaw = (process.env["DISCOVERY_SOURCES"] ?? "booking,jalan").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of sourcesRaw) {
    if (s !== "booking" && s !== "jalan") throw new Error(`DISCOVERY_SOURCES supports booking,jalan only (got: ${s})`);
  }
  const maxCandidates = Number.parseInt(process.env["DISCOVERY_MAX_CANDIDATES"] ?? "30", 10);
  const maxPages = Number.parseInt(process.env["DISCOVERY_MAX_PAGES"] ?? "60", 10);
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new Error("DISCOVERY_MAX_CANDIDATES must be a positive integer");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("DISCOVERY_MAX_PAGES must be a positive integer");
  return {
    sources: sourcesRaw as DiscoverySource[],
    maxCandidates,
    maxPages,
    dryRun: process.env["DISCOVERY_DRY_RUN"] !== "0",
    candidateFilter: (process.env["DISCOVERY_CANDIDATE_FILTER"] ?? "").trim()
  };
}

function selectCandidates(source: DiscoverySource, options: RunnerOptions): SourceMappingDiscoveryCandidate[] {
  return DISCOVERY_CANDIDATES
    .filter((c) => c.target_sources.includes(source))
    .filter((c) => options.candidateFilter === "" || c.canonical_property_name.includes(options.candidateFilter))
    .slice(0, options.maxCandidates);
}

// Page budget shared across every public page load (lists, searches, probes).
class PageBudget {
  used = 0;
  constructor(private readonly max: number) {}
  tryTake(): boolean {
    if (this.used >= this.max) return false;
    this.used += 1;
    return true;
  }
}

function cleanHtmlText(value: string): string {
  return value.replace(/<[^>]+>/gu, " ").replace(/&amp;/gu, "&").replace(/&#39;|&apos;/gu, "'").replace(/&quot;/gu, '"').replace(/[\s　]+/gu, " ").trim();
}

/** Extract (yadId, name) pairs from Jalan keyword-search HTML. */
function extractJalanPairs(html: string, foundOn: string): DiscoveredPagePair[] {
  const idRe = /openYadoSyosai\(\s*'(\d+)'\s*,\s*'(\d+_\d+_\d+)'/gu;
  const seenIndex = new Set<string>();
  const ids: string[] = [];
  for (let m = idRe.exec(html); m !== null; m = idRe.exec(html)) {
    if (seenIndex.has(m[2]!)) continue;
    seenIndex.add(m[2]!);
    ids.push(m[1]!);
  }
  const nameRe = /facilityName[^>]*>([\s\S]*?)<\/h2>/gu;
  const names: string[] = [];
  for (let m = nameRe.exec(html); m !== null; m = nameRe.exec(html)) names.push(cleanHtmlText(m[1]!));
  const pairs: DiscoveredPagePair[] = [];
  for (let i = 0; i < Math.min(ids.length, names.length); i++) {
    pairs.push({ source: "jalan", slug_or_id: `yad${ids[i]!}`, display_name: names[i]!, url: jalanYadUrl(ids[i]!), found_on: foundOn });
  }
  return pairs;
}

async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return page;
}

/** Walk the public Jalan 蔵王温泉 keyword listing (paginated). */
async function scanJalanZaoListing(context: BrowserContext, budget: PageBudget, debugRoot: string): Promise<DiscoveredPagePair[]> {
  const pairs: DiscoveredPagePair[] = [];
  const page = await newPage(context);
  try {
    let url = JALAN_ZAO_LIST_URL;
    for (let listPage = 1; listPage <= JALAN_LIST_MAX_PAGES; listPage++) {
      if (!budget.tryTake()) break;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2_500);
      const html = await page.content();
      writeFileSync(join(debugRoot, `jalan_zao_listing_p${listPage}.html`), html, "utf8");
      pairs.push(...extractJalanPairs(html, url));
      const next = html.match(/href="([^"]*uww2011search[^"]*dispStartIndex=\d+[^"]*)"[^>]*>\s*(?:<[^>]*>)*\s*次へ/u);
      if (!next?.[1]) break;
      url = `https://www.jalan.net${next[1].replace(/&amp;/gu, "&")}`;
      await page.waitForTimeout(1_500);
    }
  } finally {
    await page.close().catch(() => undefined);
  }
  return pairs;
}

/**
 * Per-candidate Jalan keyword fallback. Submitted via an in-page form on the
 * (Shift_JIS) listing page so the browser produces the site's native parameter
 * encoding — plain public navigation, no header/cookie tricks.
 */
async function jalanKeywordFallback(context: BrowserContext, budget: PageBudget, keyword: string, artifactPath: string): Promise<{ pairs: DiscoveredPagePair[]; query: string }> {
  const query = `jalan keyword search: ${keyword} (distCd=06)`;
  if (!budget.tryTake()) return { pairs: [], query: `${query} [skipped: page budget exhausted]` };
  const page = await newPage(context);
  try {
    await page.goto(JALAN_ZAO_LIST_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // form.submit() navigates and may tear down the execution context before
    // evaluate() resolves — that rejection is expected and harmless.
    await page.evaluate((kw) => {
      const form = document.createElement("form");
      form.method = "GET";
      form.action = "/uw/uwp2011/uww2011init.do";
      const add = (name: string, value: string): void => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      };
      add("keyword", kw);
      add("distCd", "06");
      add("rootCd", "7701");
      document.body.appendChild(form);
      form.submit();
    }, keyword).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(2_500);
    const html = await page.content();
    writeFileSync(artifactPath, html, "utf8");
    return { pairs: extractJalanPairs(html, page.url()), query: `${query} [result: ${page.url().slice(0, 160)}]` };
  } catch {
    return { pairs: [], query: `${query} [search page failed to load]` };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Fallback query variants: canonical (+蔵王温泉), width-normalized, ascii alias. */
function fallbackQueryVariants(candidate: SourceMappingDiscoveryCandidate): string[] {
  const nfkc = candidate.canonical_property_name.normalize("NFKC");
  const variants = [
    `${nfkc} 蔵王温泉`,
    nfkc.replace(/[\s　]+/gu, ""),
    ...candidate.aliases.filter((a) => a !== candidate.canonical_property_name).slice(0, 1)
  ];
  return [...new Set(variants)];
}

/** Extract (slug, display name) pairs from a Booking searchresults page DOM. */
async function extractBookingCards(page: Page, foundOn: string): Promise<DiscoveredPagePair[]> {
  const cards = await page.evaluate(() => {
    const out: Array<{ href: string; title: string }> = [];
    for (const a of Array.from(document.querySelectorAll('a[data-testid="title-link"]'))) {
      const title = a.querySelector('[data-testid="title"]')?.textContent ?? a.textContent ?? "";
      out.push({ href: (a as HTMLAnchorElement).href ?? "", title: title.trim() });
    }
    return out;
  }).catch(() => [] as Array<{ href: string; title: string }>);
  const pairs: DiscoveredPagePair[] = [];
  for (const card of cards) {
    const m = card.href.match(/hotel\/jp\/([a-z0-9-]+)\.(?:[a-z]{2}(?:-[a-z]{2})?\.)?html/u);
    if (!m?.[1]) continue;
    pairs.push({ source: "booking", slug_or_id: m[1], display_name: card.title, url: bookingHotelUrl(m[1]), found_on: foundOn });
  }
  return pairs;
}

async function scanBookingSearch(context: BrowserContext, budget: PageBudget, url: string, artifactPath: string): Promise<{ pairs: DiscoveredPagePair[]; blocked: boolean }> {
  if (!budget.tryTake()) return { pairs: [], blocked: false };
  const page = await newPage(context);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3_500);
    // Nudge lazy-loaded result cards into the DOM (still one page load).
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 2_400).catch(() => undefined);
      await page.waitForTimeout(800);
    }
    const html = await page.content();
    writeFileSync(artifactPath, html, "utf8");
    const blocked = BLOCK_RE.test(`${await page.title().catch(() => "")}\n${html.slice(0, 8_000)}`);
    return { pairs: blocked ? [] : await extractBookingCards(page, url), blocked };
  } catch {
    return { pairs: [], blocked: false };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Identity-only probe of one discovered property page. */
async function probePropertyPage(context: BrowserContext, budget: PageBudget, url: string, artifactDir: string): Promise<DiscoveryProbeObservation> {
  if (!budget.tryTake()) {
    return { loaded: false, http_status: 0, blocked_or_captcha: false, login_required: false, not_found_page: false, page_title: "", h1: "", visible_text: "", error: "page_budget_exhausted" };
  }
  const page = await newPage(context);
  let loaded = false;
  let status = 0;
  let title = "";
  let h1 = "";
  let text = "";
  let error = "";
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    loaded = resp !== null;
    status = resp?.status() ?? 0;
    await page.waitForTimeout(3_000);
    title = await page.title().catch(() => "");
    h1 = await page.locator("h1").first().innerText({ timeout: 5_000 }).catch(() => "");
    text = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    await page.screenshot({ path: join(artifactDir, "screenshot.png"), fullPage: false }).catch(() => undefined);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await page.close().catch(() => undefined);
  }
  const hay = `${title}\n${h1}\n${text}`;
  return {
    loaded,
    http_status: status,
    blocked_or_captcha: BLOCK_RE.test(hay),
    login_required: /(ログインが必要|サインインして続行|sign in to continue)/iu.test(hay),
    not_found_page: NOT_FOUND_RE.test(hay),
    page_title: title,
    h1,
    visible_text: text.slice(0, 20_000),
    error
  };
}

function artifactKey(source: DiscoverySource, candidate: SourceMappingDiscoveryCandidate): string {
  const safe = candidate.canonical_property_name.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40);
  return `${source}_${safe}`;
}

async function run(): Promise<void> {
  const options = parseOptions();
  const ts = timestamp();
  const generatedAtJst = jstIso();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const debugRoot = resolve(DEBUG_ROOT, ts);
  mkdirSync(debugRoot, { recursive: true });

  const budget = new PageBudget(options.maxPages);
  const results: SourceMappingDiscoveryResult[] = [];
  const liveBookingBefore = liveBookingTargets().length;
  const liveJalanBefore = liveJalanTargets().length;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "ja-JP" });
  try {
    // ---- Jalan ----
    if (options.sources.includes("jalan")) {
      const areaPairs = await scanJalanZaoListing(context, budget, debugRoot);
      writeFileSync(join(debugRoot, "jalan_zao_listing_pairs.json"), `${JSON.stringify(areaPairs, null, 2)}\n`, "utf8");
      const jalanCandidates = selectCandidates("jalan", options);
      for (const candidate of jalanCandidates) {
        const artifactDir = join(debugRoot, artifactKey("jalan", candidate));
        mkdirSync(artifactDir, { recursive: true });
        let searchedQuery = "jalan public keyword listing: 蔵王温泉 (distCd=06, rootCd=7701)";
        let matches = matchPairsToCandidate(candidate, areaPairs);
        if (matches.length === 0) {
          const nfkc = candidate.canonical_property_name.normalize("NFKC");
          const keywords = [...new Set([candidate.canonical_property_name, nfkc.replace(/[\s　]+/gu, ""), ...candidate.aliases.filter((a) => /[^\x20-\x7e]/u.test(a)).slice(0, 1)])];
          for (let i = 0; i < keywords.length && matches.length === 0; i++) {
            const fallback = await jalanKeywordFallback(context, budget, keywords[i]!, join(artifactDir, `jalan_fallback_search_${i + 1}.html`));
            searchedQuery = `${searchedQuery}; ${fallback.query}`;
            matches = matchPairsToCandidate(candidate, fallback.pairs);
          }
        }
        if (matches.length === 1 && alreadyLiveVerified("jalan", matches[0]!.slug_or_id)) continue; // already in live universe
        const probe = matches.length === 1
          ? await probePropertyPage(context, budget, matches[0]!.url, artifactDir)
          : undefined;
        const decided = decideDiscovery({ candidate, source: "jalan", searched_query: searchedQuery, matches, probe });
        results.push({ ...decided, debug_artifact_path: artifactDir });
        writeFileSync(join(artifactDir, "observation.json"), `${JSON.stringify({ matches, probe: probe ? { ...probe, visible_text: probe.visible_text.slice(0, 2_000) } : null, decided }, null, 2)}\n`, "utf8");
        await new Promise((r) => setTimeout(r, 1_200));
      }
    }

    // ---- Booking ----
    if (options.sources.includes("booking")) {
      const areaScan = await scanBookingSearch(context, budget, BOOKING_AREA_SEARCH_URL, join(debugRoot, "booking_zao_searchresults.html"));
      writeFileSync(join(debugRoot, "booking_zao_search_pairs.json"), `${JSON.stringify(areaScan.pairs, null, 2)}\n`, "utf8");
      const bookingCandidates = selectCandidates("booking", options);
      for (const candidate of bookingCandidates) {
        const artifactDir = join(debugRoot, artifactKey("booking", candidate));
        mkdirSync(artifactDir, { recursive: true });
        let searchedQuery = `booking searchresults: ss=蔵王温泉 (area scan)`;
        let matches = matchPairsToCandidate(candidate, areaScan.pairs);
        // Phase 47X public seed slug, if any, is an additional candidate URL.
        const seed = BOOKING_SLUG_SEEDS[candidate.canonical_property_name];
        if (seed && !matches.some((m) => m.slug_or_id === seed)) {
          matches = matchPairsToCandidate(candidate, [
            ...matches.map((m) => ({ ...m })),
            { source: "booking" as const, slug_or_id: seed, display_name: candidate.canonical_property_name, url: bookingHotelUrl(seed), found_on: "phase47X_public_seed" }
          ]);
        }
        if (matches.length === 0) {
          const queries = fallbackQueryVariants(candidate);
          for (let i = 0; i < queries.length && matches.length === 0; i++) {
            const q = queries[i]!;
            const fallback = await scanBookingSearch(context, budget, `https://www.booking.com/searchresults.ja.html?ss=${encodeURIComponent(q)}`, join(artifactDir, `booking_fallback_search_${i + 1}.html`));
            searchedQuery = `${searchedQuery}; booking searchresults: ss=${q}${fallback.blocked ? " [blocked]" : ""}`;
            matches = matchPairsToCandidate(candidate, fallback.pairs);
          }
        }
        if (matches.length === 1 && alreadyLiveVerified("booking", matches[0]!.slug_or_id)) continue;
        const probe = matches.length === 1
          ? await probePropertyPage(context, budget, matches[0]!.url, artifactDir)
          : undefined;
        const decided = decideDiscovery({ candidate, source: "booking", searched_query: searchedQuery, matches, probe });
        results.push({ ...decided, debug_artifact_path: artifactDir });
        writeFileSync(join(artifactDir, "observation.json"), `${JSON.stringify({ matches, probe: probe ? { ...probe, visible_text: probe.visible_text.slice(0, 2_000) } : null, decided }, null, 2)}\n`, "utf8");
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const summary = summarizeDiscovery(results);
  const reportPath = resolve(REPORT_DIR, `source_mapping_discovery_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `source_mapping_discovery_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `source_mapping_discovery_${ts}.csv`);
  writeFileSync(reportPath, renderDiscoveryReport({ generatedAtJst, dryRun: options.dryRun, pagesUsed: budget.used, maxPages: options.maxPages, results, summary, liveBookingBefore, liveJalanBefore }), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify({ generated_at_jst: generatedAtJst, dry_run: options.dryRun, pages_used: budget.used, max_pages: options.maxPages, summary, results: results.map((r) => ({ ...r })) }, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderDiscoveryCsv(results), "utf8");

  console.log(`decision=source_mapping_discovery_complete${options.dryRun ? "_dry_run" : ""}`);
  console.log(`booking_verified_new=${summary.booking_verified_new}`);
  console.log(`jalan_verified_new=${summary.jalan_verified_new}`);
  console.log(`verified_total_after_booking=${liveBookingBefore + summary.booking_verified_new}`);
  console.log(`verified_total_after_jalan=${liveJalanBefore + summary.jalan_verified_new}`);
  console.log(`needs_review_count=${summary.needs_review_count}`);
  console.log(`not_found_count=${summary.not_found_count}`);
  console.log(`ambiguous_count=${summary.ambiguous_count}`);
  console.log(`blocked_or_captcha_count=${summary.blocked_or_captcha_count}`);
  console.log(`failed_count=${summary.failed_count}`);
  console.log(`pages_used=${budget.used}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugRoot}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

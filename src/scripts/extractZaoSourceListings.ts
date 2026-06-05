import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractJalanListingsFromHtmlOrText,
  extractRakutenListingsFromHtmlOrText,
  type ExtractedSourceListing,
  type SourceListingSource
} from "../services/extractZaoSourceListings";

/**
 * Phase 46.6X Deliverable 2 — fetch the two pinned Zao Onsen source listing
 * pages, save raw debug artifacts, and write a faithful listings JSON
 * (timestamped + a stable `.latest.json`). No prices, no availability, no paid
 * APIs, no login. Jalan paginates (30 per page) so we walk pages until exhausted.
 */

const JALAN_BASE =
  "https://www.jalan.net/uw/uwp2011/uww2011search.do?actionId=G&keyword=%91%A0%89%A4%89%B7%90%F2&dateUndecided=1&stayYear=2026&stayMonth=06&stayDay=01&minPrice=0&maxPrice=999999&distCd=06&rootCd=7701&activeSort=0&screenId=UWW2011";
const JALAN_DISPLAY_URL =
  "https://www.jalan.net/uw/uwp2011/uww2011init.do?keyword=%91%A0%89%A4%89%B7%90%F2&distCd=06&rootCd=7701&screenId=FWPCTOP&ccnt=button-fw&image1=";
const RAKUTEN_URL = "https://travel.rakuten.co.jp/onsen/yamagata/OK00161.html";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEBUG_DIR = ".data/debug/source-pages";
const OUT_DIR = ".data/source-listings";
const LATEST_PATH = "data/seeds/zao_source_listings.latest.json";

interface SourcePageReport {
  source: SourceListingSource;
  url: string;
  status: "ok" | "failed" | "partial";
  final_url: string;
  http_status: number | null;
  extracted_count: number;
  notes: string;
}

interface FetchResult {
  html: string;
  finalUrl: string;
  httpStatus: number;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(
    d.getUTCMinutes()
  )}${p(d.getUTCSeconds())}`;
}

async function fetchDecoded(url: string): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "ja,en;q=0.8" },
    redirect: "follow"
  });
  const buffer = new Uint8Array(await response.arrayBuffer());
  // Both pages are Shift-JIS; decode leniently so stray bytes never throw.
  const html = new TextDecoder("shift_jis", { fatal: false }).decode(buffer);
  return { html, finalUrl: response.url || url, httpStatus: response.status };
}

function saveDebug(runDir: string, name: string, payload: unknown): void {
  writeFileSync(resolve(runDir, name), JSON.stringify(payload, null, 2), "utf-8");
}

function saveRaw(runDir: string, name: string, html: string): void {
  writeFileSync(resolve(runDir, name), html, "utf-8");
}

async function collectJalan(runDir: string): Promise<{
  listings: ExtractedSourceListing[];
  report: SourcePageReport;
}> {
  const listings: ExtractedSourceListing[] = [];
  let pageStatus: "ok" | "failed" | "partial" = "ok";
  let httpStatus: number | null = null;
  let finalUrl = JALAN_DISPLAY_URL;
  const noteParts: string[] = [];

  const seenIds = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const dispStartIndex = page * 30;
    const url = `${JALAN_BASE}&dispStartIndex=${dispStartIndex}`;
    try {
      const result = await fetchDecoded(url);
      httpStatus = result.httpStatus;
      if (page === 0) {
        finalUrl = result.finalUrl;
      }
      saveRaw(runDir, `jalan_page${page}.html`, result.html);
      const pageListings = extractJalanListingsFromHtmlOrText(result.html, JALAN_DISPLAY_URL);
      const fresh = pageListings.filter((l) => {
        const key = l.sourcePropertyId ?? `name:${l.propertyNameNormalized}`;
        if (seenIds.has(key)) {
          return false;
        }
        seenIds.add(key);
        return true;
      });
      listings.push(...fresh);
      noteParts.push(`page${page}(start=${dispStartIndex}):${fresh.length} new`);
      if (fresh.length === 0) {
        break;
      }
    } catch (error) {
      pageStatus = listings.length > 0 ? "partial" : "failed";
      noteParts.push(`page${page} fetch error: ${(error as Error).message}`);
      break;
    }
  }

  return {
    listings,
    report: {
      source: "jalan",
      url: JALAN_DISPLAY_URL,
      status: pageStatus,
      final_url: finalUrl,
      http_status: httpStatus,
      extracted_count: listings.length,
      notes: noteParts.join("; ")
    }
  };
}

async function collectRakuten(runDir: string): Promise<{
  listings: ExtractedSourceListing[];
  report: SourcePageReport;
}> {
  try {
    const result = await fetchDecoded(RAKUTEN_URL);
    saveRaw(runDir, "rakuten.html", result.html);
    const listings = extractRakutenListingsFromHtmlOrText(result.html, RAKUTEN_URL);
    return {
      listings,
      report: {
        source: "rakuten",
        url: RAKUTEN_URL,
        status: listings.length > 0 ? "ok" : "partial",
        final_url: result.finalUrl,
        http_status: result.httpStatus,
        extracted_count: listings.length,
        notes: `Parsed ${listings.length} hotelBox blocks.`
      }
    };
  } catch (error) {
    return {
      listings: [],
      report: {
        source: "rakuten",
        url: RAKUTEN_URL,
        status: "failed",
        final_url: RAKUTEN_URL,
        http_status: null,
        extracted_count: 0,
        notes: `fetch error: ${(error as Error).message}`
      }
    };
  }
}

async function main(): Promise<void> {
  const ts = timestamp();
  const runDir = resolve(DEBUG_DIR, ts);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(resolve(OUT_DIR), { recursive: true });

  const [jalan, rakuten] = await Promise.all([collectJalan(runDir), collectRakuten(runDir)]);

  const listings = [...jalan.listings, ...rakuten.listings];
  const output = {
    generated_at: new Date().toISOString(),
    method:
      "AI-assisted faithful extraction of two pinned public listing pages (Jalan keyword search + Rakuten onsen page). No prices, availability, paid APIs, or login.",
    source_pages: [jalan.report, rakuten.report],
    listings
  };

  const tsPath = resolve(OUT_DIR, `zao_source_listings_${ts}.json`);
  writeFileSync(tsPath, JSON.stringify(output, null, 2), "utf-8");
  writeFileSync(resolve(LATEST_PATH), JSON.stringify(output, null, 2), "utf-8");
  saveDebug(runDir, "source_pages_report.json", output.source_pages);

  console.log(`generated_at=${output.generated_at}`);
  for (const page of output.source_pages) {
    console.log(
      `source=${page.source} status=${page.status} http=${page.http_status ?? "n/a"} extracted=${page.extracted_count}`
    );
  }
  console.log(`total_listings=${listings.length}`);
  console.log(`timestamped_output=${tsPath}`);
  console.log(`latest_output=${resolve(LATEST_PATH)}`);
  console.log(`debug_dir=${runDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

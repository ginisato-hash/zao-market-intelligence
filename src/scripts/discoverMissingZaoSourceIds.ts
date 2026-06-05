import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildZaoMissingSourceDiscoveryReport,
  enrichZaoMissingSourceCandidates,
  readZaoCandidateReviewCsv,
  renderZaoCandidateReviewCsv,
  type ZaoDiscoverySource,
  type ZaoSourceDiscoveryResult
} from "../services/enrichZaoMissingSourceCandidates";

const REVIEW_DIR = ".data/exports/zao-universe-review";
const REPORT_DIR = ".data/reports/source-discovery";

export const DISCOVERY_PRIORITY_ORDER: Array<{
  canonicalPropertyName: string;
  source: ZaoDiscoverySource;
}> = [
  { canonicalPropertyName: "三浦屋", source: "rakuten" },
  { canonicalPropertyName: "三浦屋", source: "booking" },
  { canonicalPropertyName: "三浦屋", source: "google_hotels" },
  { canonicalPropertyName: "蔵王国際ホテル", source: "booking" },
  { canonicalPropertyName: "蔵王国際ホテル", source: "google_hotels" },
  { canonicalPropertyName: "蔵王四季のホテル", source: "booking" },
  { canonicalPropertyName: "蔵王四季のホテル", source: "google_hotels" },
  { canonicalPropertyName: "深山荘 高見屋", source: "booking" },
  { canonicalPropertyName: "深山荘 高見屋", source: "google_hotels" },
  { canonicalPropertyName: "名湯リゾート ルーセント", source: "booking" },
  { canonicalPropertyName: "名湯リゾート ルーセント", source: "google_hotels" },
  { canonicalPropertyName: "YuiLocalZao", source: "rakuten" },
  { canonicalPropertyName: "YuiLocalZao", source: "booking" },
  { canonicalPropertyName: "ZAO BASE", source: "rakuten" },
  { canonicalPropertyName: "ZAO BASE", source: "booking" },
  { canonicalPropertyName: "シバママのお宿", source: "jalan" },
  { canonicalPropertyName: "シバママのお宿", source: "rakuten" },
  { canonicalPropertyName: "松尾ハウス", source: "jalan" },
  { canonicalPropertyName: "松尾ハウス", source: "rakuten" },
  { canonicalPropertyName: "お食事処・お泊り処・お湯処 ろばた", source: "jalan" },
  { canonicalPropertyName: "お食事処・お泊り処・お湯処 ろばた", source: "rakuten" },
  // Seeded discovery results below are front-loaded so they fall within the
  // bounded maxRows window regardless of natural CSV ordering.
  { canonicalPropertyName: "ユニテ蔵王ジョーニダ・リゾート", source: "rakuten" },
  { canonicalPropertyName: "名湯舎 創", source: "booking" },
  { canonicalPropertyName: "BED'n ONSEN HAMMOND", source: "booking" },
  { canonicalPropertyName: "JURIN", source: "booking" },
  { canonicalPropertyName: "ONSEN & STAY OAKHILL", source: "booking" },
  { canonicalPropertyName: "おおみや旅館", source: "booking" },
  { canonicalPropertyName: "たかみや瑠璃倶楽", source: "booking" },
  { canonicalPropertyName: "ル・ベール蔵王", source: "booking" },
  { canonicalPropertyName: "源泉湯宿 蔵王プラザホテル", source: "booking" },
  { canonicalPropertyName: "蔵王・和歌（うた）の宿 わかまつや", source: "booking" }
];

/**
 * Phase 47X seed map. These entries came from targeted public first-party URL
 * discovery and remain review suggestions only; the script never marks them
 * confirmed or approved.
 */
export const BUILT_IN_DISCOVERY_RESULTS: ZaoSourceDiscoveryResult[] = [
  {
    canonicalPropertyName: "蔵王国際ホテル",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match 蔵王国際ホテル."
  },
  {
    canonicalPropertyName: "蔵王四季のホテル",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/zao-shiki-no.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match 蔵王四季のホテル."
  },
  {
    canonicalPropertyName: "深山荘 高見屋",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/shinzanso-takamiya.ja.html",
    evidenceNote:
      "Found public first-party Booking URL pattern matching the target property name/location.",
    warningNote:
      "Booking slug uses a non-canonical phonetic variant (shinzanso-takamiya); human must verify exact property identity before approval."
  },
  {
    canonicalPropertyName: "名湯リゾート ルーセント",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/lucent-takamiya.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match 名湯リゾート ルーセント."
  },
  {
    canonicalPropertyName: "YuiLocalZao",
    source: "rakuten",
    propertyUrl: "https://travel.rakuten.co.jp/HOTEL/198027/",
    evidenceNote:
      "Targeted public search found a first-party Rakuten Travel HOTEL URL whose title/location appears to match YuiLocalZao."
  },
  {
    canonicalPropertyName: "YuiLocalZao",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/yuilocalzao.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match YuiLocalZao."
  },
  {
    canonicalPropertyName: "ZAO BASE",
    source: "rakuten",
    propertyUrl: "https://travel.rakuten.co.jp/HOTEL/197787/",
    evidenceNote:
      "Targeted public search found a first-party Rakuten Travel HOTEL URL whose title/location appears to match ZAO BASE."
  },
  {
    canonicalPropertyName: "ZAO BASE",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/zao-base-sukichang-karatu-bu-1fen.ja.html",
    evidenceNote:
      "Found public first-party Booking URL pattern matching the target property name/location.",
    warningNote:
      "Booking slug is non-standard (zao-base-sukichang-karatu-bu-1fen); kept only as a candidate and must be human verified before approval."
  },
  {
    canonicalPropertyName: "BED'n ONSEN HAMMOND",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match BED'n ONSEN HAMMOND."
  },
  {
    canonicalPropertyName: "JURIN",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/jurin.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match JURIN."
  },
  {
    canonicalPropertyName: "ONSEN & STAY OAKHILL",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/onsen-amp-stay-oakhill.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match ONSEN & STAY OAKHILL."
  },
  {
    canonicalPropertyName: "おおみや旅館",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/omiya-ryokan-yamagata.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match おおみや旅館."
  },
  {
    canonicalPropertyName: "たかみや瑠璃倶楽",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/rurikura-resort.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match たかみや瑠璃倶楽."
  },
  {
    canonicalPropertyName: "ル・ベール蔵王",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match ル・ベール蔵王."
  },
  {
    canonicalPropertyName: "源泉湯宿 蔵王プラザホテル",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/zao-plaza.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match 源泉湯宿 蔵王プラザホテル."
  },
  {
    canonicalPropertyName: "蔵王・和歌（うた）の宿 わかまつや",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/wakamatsuya.ja.html",
    evidenceNote:
      "Targeted public search found a first-party Booking.com URL whose title/location appears to match 蔵王・和歌（うた）の宿 わかまつや."
  },
  {
    canonicalPropertyName: "ユニテ蔵王ジョーニダ・リゾート",
    source: "rakuten",
    propertyUrl: "https://travel.rakuten.co.jp/HOTEL/187977/",
    evidenceNote:
      "Found public first-party Rakuten URL pattern matching the target property name/location (Rakuten hotelNo 187977 surfaced on first-party hotelinfo/plan and review pages)."
  },
  {
    canonicalPropertyName: "名湯舎 創",
    source: "booking",
    propertyUrl: "https://www.booking.com/hotel/jp/meitoya-sou.ja.html",
    evidenceNote:
      "Found public first-party Booking URL pattern matching the target property name/location."
  }
];

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function latestCandidateCsvPath(): string {
  const files = readdirSync(resolve(REVIEW_DIR))
    .filter((file) => /^zao_source_candidates_\d{8}_\d{6}\.csv$/u.test(file))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(`No source candidate CSV found in ${REVIEW_DIR}`);
  }
  return resolve(REVIEW_DIR, latest);
}

function parseSourceFilter(value: string | undefined): ZaoDiscoverySource[] {
  const allowed: ZaoDiscoverySource[] = ["jalan", "rakuten", "booking", "google_hotels"];
  if (!value?.trim()) return allowed;
  const parsed = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (const source of parsed) {
    if (!allowed.includes(source as ZaoDiscoverySource)) {
      throw new Error(`DISCOVERY_SOURCE_FILTER contains unsupported source: ${source}`);
    }
  }
  return parsed as ZaoDiscoverySource[];
}

export function runMissingZaoSourceDiscovery(input: {
  inputCsvPath: string;
  enrichedCsvPath: string;
  reportPath: string;
  maxRows: number;
  sourceFilter: ZaoDiscoverySource[];
  generatedAt?: string;
}): ReturnType<typeof enrichZaoMissingSourceCandidates> {
  mkdirSync(resolve(REVIEW_DIR), { recursive: true });
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  const rows = readZaoCandidateReviewCsv(input.inputCsvPath);
  const result = enrichZaoMissingSourceCandidates(rows, BUILT_IN_DISCOVERY_RESULTS, {
    maxRows: input.maxRows,
    sourceFilter: input.sourceFilter,
    priorityOrder: DISCOVERY_PRIORITY_ORDER
  });
  writeFileSync(resolve(input.enrichedCsvPath), renderZaoCandidateReviewCsv(result.rows), "utf-8");
  writeFileSync(
    resolve(input.reportPath),
    buildZaoMissingSourceDiscoveryReport({
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      inputCsvPath: input.inputCsvPath,
      enrichedCsvPath: input.enrichedCsvPath,
      result,
      maxRows: input.maxRows,
      sourceFilter: input.sourceFilter
    }),
    "utf-8"
  );
  return result;
}

function main(): void {
  const inputCsvPath = process.env["ZAO_SOURCE_CANDIDATES_CSV"] ?? latestCandidateCsvPath();
  const maxRows = Number.parseInt(process.env["DISCOVERY_MAX_ROWS"] ?? "25", 10);
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error("DISCOVERY_MAX_ROWS must be a positive integer");
  }
  const sourceFilter = parseSourceFilter(process.env["DISCOVERY_SOURCE_FILTER"]);
  const ts = timestamp();
  const enrichedCsvPath = resolve(
    REVIEW_DIR,
    `zao_source_candidates_multi_source_enriched_${ts}.csv`
  );
  const reportPath = resolve(
    REPORT_DIR,
    `zao_multi_source_id_discovery_report_${ts}.md`
  );

  const result = runMissingZaoSourceDiscovery({
    inputCsvPath,
    enrichedCsvPath,
    reportPath,
    maxRows,
    sourceFilter
  });

  console.log(`input_csv_path=${resolve(inputCsvPath)}`);
  console.log(`enriched_csv_path=${enrichedCsvPath}`);
  console.log(`report_path=${reportPath}`);
  console.log(`input_candidate_row_count=${result.inputRowCount}`);
  console.log(`enriched_candidate_row_count=${result.outputRowCount}`);
  console.log(`missing_row_count=${result.missingRowCount}`);
  console.log(`rows_considered_for_discovery=${result.rowsConsideredForDiscovery}`);
  console.log(`filled_count=${result.filledCount}`);
  console.log(`filled_count_by_source=${JSON.stringify(result.filledBySource)}`);
  console.log(`still_missing_count_by_source=${JSON.stringify(result.stillMissingBySource)}`);
  console.log(`warning_count=${result.warnings.length + result.duplicateWarnings.length}`);
}

if (process.argv[1]?.endsWith("discoverMissingZaoSourceIds.ts")) {
  main();
}

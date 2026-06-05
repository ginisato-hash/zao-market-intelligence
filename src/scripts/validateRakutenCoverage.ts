import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readZaoCandidateReviewCsv } from "../services/enrichZaoMissingSourceCandidates";
import {
  buildRakutenCoverageRows,
  renderRakutenCoverageCsv,
  renderRakutenCoverageReport,
  type RakutenCoverageInput,
  type RakutenMissingRow,
  type RakutenPageObservation
} from "../services/buildRakutenCoverageValidation";

const REVIEW_DIR = ".data/exports/zao-universe-review";
const REPORT_DIR = ".data/reports/source-discovery";

/**
 * Publicly observed Rakuten page metadata (page title, displayed name, address)
 * captured by opening each first-party travel.rakuten.co.jp/HOTEL/[hotelNo] page
 * in Phase 52X. These are read-only observations used to validate identity; no
 * prices/availability were collected.
 */
export const RAKUTEN_PAGE_OBSERVATIONS: RakutenPageObservation[] = [
  {
    hotelNo: "198027",
    reachable: true,
    pageTitle: "ＹｕｉＬｏｃａｌＺａｏ 宿泊予約【楽天トラベル】",
    pagePropertyName: "ＹｕｉＬｏｃａｌＺａｏ",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉字三度川219-1",
    extraNote:
      "AI-discovered candidate (Phase 51X); independent Rakuten page check confirms a Zao Onsen listing with a matching name."
  },
  {
    hotelNo: "197787",
    reachable: true,
    pageTitle: "ＺＡＯ　ＢＡＳＥ 宿泊予約【楽天トラベル】",
    pagePropertyName: "ＺＡＯ　ＢＡＳＥ",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉字川前935-18",
    extraNote:
      "AI-discovered candidate (Phase 51X); independent Rakuten page check confirms a Zao Onsen listing with a matching name."
  },
  {
    hotelNo: "187977",
    reachable: true,
    pageTitle: "ユニテ蔵王ジョーニダリゾート 宿泊予約【楽天トラベル】",
    pagePropertyName: "ユニテ蔵王ジョーニダリゾート",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉丈二田752-2",
    extraNote:
      "AI-discovered candidate (Phase 51X); independent Rakuten page check confirms a Zao Onsen listing with a matching name (canonical uses a middle-dot variant)."
  },
  {
    hotelNo: "40033",
    reachable: true,
    pageTitle: "蔵王温泉　ＢＥＤ＇ｎ　ＯＮＳＥＮ　ＨＡＭＭＯＮＤ（ハモンド） 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　ＢＥＤ＇ｎ　ＯＮＳＥＮ　ＨＡＭＭＯＮＤ（ハモンド）",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉上ノ代94-1"
  },
  {
    hotelNo: "14585",
    reachable: true,
    pageTitle: "蔵王温泉　ＪＵＲＩＮ 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　ＪＵＲＩＮ",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉814"
  },
  {
    hotelNo: "40164",
    reachable: true,
    pageTitle: "蔵王温泉　ＫＫＲ蔵王　白銀荘（国家公務員共済組合連合会蔵王保養所） 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　ＫＫＲ蔵王　白銀荘（国家公務員共済組合連合会蔵王保養所）",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉904-8"
  },
  {
    hotelNo: "196553",
    reachable: true,
    pageTitle: "ＯＮＳＥＮ　＆　ＳＴＡＹ　ＯＡＫＨＩＬＬ 宿泊予約【楽天トラベル】",
    pagePropertyName: "ＯＮＳＥＮ　＆　ＳＴＡＹ　ＯＡＫＨＩＬＬ",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉756"
  },
  {
    hotelNo: "14790",
    reachable: true,
    pageTitle: "蔵王温泉　えびや旅館 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　えびや旅館",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉3"
  },
  {
    hotelNo: "5722",
    reachable: true,
    pageTitle: "蔵王温泉　おおみや旅館 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　おおみや旅館",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉46"
  },
  {
    hotelNo: "67903",
    reachable: true,
    pageTitle: "お食事処・お泊り処・お湯処　ろばた 宿泊予約【楽天トラベル】",
    pagePropertyName: "お食事処・お泊り処・お湯処　ろばた",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉川原42-5"
  },
  {
    hotelNo: "4877",
    reachable: true,
    pageTitle: "蔵王温泉　こけしの宿　招仙閣 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　こけしの宿　招仙閣",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉22"
  },
  {
    hotelNo: "67210",
    reachable: true,
    pageTitle: "蔵王温泉　たかみや瑠璃倶楽リゾート　‐ＲＵＲＩＫＵＲＡ　ＲＥＳＯＲＴ‐ 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　たかみや瑠璃倶楽リゾート　‐ＲＵＲＩＫＵＲＡ　ＲＥＳＯＲＴ‐",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉三度川1118-7"
  },
  {
    hotelNo: "41644",
    reachable: true,
    pageTitle: "蔵王温泉　ぼくのうち 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　ぼくのうち",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉904"
  },
  {
    hotelNo: "13603",
    reachable: true,
    pageTitle: "蔵王温泉　ホテル　ラルジャン蔵王 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　ホテル　ラルジャン蔵王",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉中森877-18"
  },
  {
    hotelNo: "12535",
    reachable: true,
    pageTitle: "蔵王温泉　ホテル喜らく 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　ホテル喜らく",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉935-25"
  },
  {
    hotelNo: "5097",
    reachable: true,
    pageTitle: "蔵王温泉　ホテル松金屋アネックス 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　ホテル松金屋アネックス",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉1267-16"
  },
  {
    hotelNo: "29465",
    reachable: true,
    pageTitle: "蔵王温泉　ル・ベール蔵王 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　ル・ベール蔵王",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉878-5"
  },
  {
    hotelNo: "80467",
    reachable: true,
    pageTitle: "蔵王温泉　暖炉の宿　ロッヂスガノ 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　暖炉の宿　ロッヂスガノ",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉878-25",
    extraNote:
      "Rakuten displays 'ロッヂスガノ' (ヂ) vs canonical 'ロッジスガノ' (ジ); confirm this katakana variant is the same property."
  },
  {
    hotelNo: "18758",
    reachable: true,
    pageTitle: "蔵王温泉　岩清水料理の宿　季の里 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　岩清水料理の宿　季の里",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉1271-1"
  },
  {
    hotelNo: "196554",
    reachable: true,
    pageTitle: "蔵王温泉　吉田屋 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　吉田屋",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉13"
  },
  {
    hotelNo: "7747",
    reachable: true,
    pageTitle: "蔵王温泉　源泉湯宿　蔵王プラザホテル 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　源泉湯宿　蔵王プラザホテル",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉2番地"
  },
  {
    hotelNo: "8411",
    reachable: true,
    pageTitle: "蔵王温泉　五感の湯つるや＜山形県＞ 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　五感の湯つるや＜山形県＞",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉710"
  },
  {
    hotelNo: "8084",
    reachable: true,
    pageTitle: "蔵王温泉　最上高湯　善七乃湯（旧：蔵王温泉　大平ホテル） 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　最上高湯　善七乃湯（旧：蔵王温泉　大平ホテル）",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉825"
  },
  {
    hotelNo: "38663",
    reachable: true,
    pageTitle: "蔵王温泉　堺屋森のホテルヴァルトベルク 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　堺屋森のホテルヴァルトベルク",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉清水坂889-1"
  },
  {
    hotelNo: "38534",
    reachable: true,
    pageTitle: "深山荘　高見屋 宿泊予約【楽天トラベル】",
    pagePropertyName: "深山荘　高見屋",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉54"
  },
  {
    hotelNo: "12587",
    reachable: true,
    pageTitle: "蔵王温泉　蔵王・和歌（うた）の宿　わかまつや 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　蔵王・和歌（うた）の宿　わかまつや",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉951-1"
  },
  {
    hotelNo: "145312",
    reachable: true,
    pageTitle: "蔵王アストリアホテル 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王アストリアホテル",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉横倉ゲレンデ"
  },
  {
    hotelNo: "149097",
    reachable: true,
    pageTitle: "蔵王つららぎの宿　花ゆらん 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王つららぎの宿　花ゆらん",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉878-12"
  },
  {
    hotelNo: "5723",
    reachable: true,
    pageTitle: "蔵王温泉　蔵王国際ホテル 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　蔵王国際ホテル",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉933"
  },
  {
    hotelNo: "16423",
    reachable: true,
    pageTitle: "蔵王温泉　蔵王四季のホテル 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　蔵王四季のホテル",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉1272"
  },
  {
    hotelNo: "39565",
    reachable: true,
    pageTitle: "蔵王温泉　名湯リゾート　ルーセントタカミヤ 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　名湯リゾート　ルーセントタカミヤ",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉942"
  },
  {
    hotelNo: "162736",
    reachable: true,
    pageTitle: "蔵王温泉　名湯舎　創　－MEITOYA　SO－ 宿泊予約【楽天トラベル】",
    pagePropertyName: "蔵王温泉　名湯舎　創　－MEITOYA　SO－",
    addressExcerpt: "〒990-2301山形県山形市蔵王温泉48"
  }
];

/** Public-search outcome notes for Rakuten rows that still have no hotelNo. */
const MISSING_SEARCH_NOTES: Record<string, string> = {
  "三浦屋":
    "Public search found no first-party Rakuten Zao Onsen listing; Rakuten '三浦屋' (HOTEL/8464) is in Hyogo, not Zao. Still missing.",
  "松金や －MATSUKANEYA ANNEX－":
    "Address (蔵王温泉1267-16) matches ホテル松金屋アネックス (Rakuten 5097); likely the same property under a duplicate canonical name — needs human dedup, not a new hotelNo.",
  "松尾ハウス": "Public search found no first-party Rakuten listing. Still missing.",
  "シバママのお宿": "Public search found no first-party Rakuten listing. Still missing."
};

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function latestEnrichedCsvPath(): string {
  const files = readdirSync(resolve(REVIEW_DIR))
    .filter((file) => /^zao_source_candidates_multi_source_enriched_\d{8}_\d{6}\.csv$/u.test(file))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(`No multi-source enriched candidate CSV found in ${REVIEW_DIR}`);
  }
  return resolve(REVIEW_DIR, latest);
}

export function collectRakutenCoverageInputs(
  rows: ReturnType<typeof readZaoCandidateReviewCsv>
): { inputs: RakutenCoverageInput[]; missingRows: RakutenMissingRow[] } {
  const inputs: RakutenCoverageInput[] = [];
  const missingRows: RakutenMissingRow[] = [];

  for (const row of rows) {
    if (row.source !== "rakuten") continue;
    const hotelNo = row.candidate_source_property_id.trim() || row.reviewed_source_property_id.trim();
    if (hotelNo) {
      inputs.push({
        canonicalPropertyName: row.canonical_property_name,
        hotelNo,
        rakutenUrl: `https://travel.rakuten.co.jp/HOTEL/${hotelNo}/`
      });
    } else {
      missingRows.push({
        canonicalPropertyName: row.canonical_property_name,
        searchNote:
          MISSING_SEARCH_NOTES[row.canonical_property_name] ??
          "No Rakuten hotelNo in the candidate CSV; not yet searched."
      });
    }
  }

  return { inputs, missingRows };
}

export function runRakutenCoverageValidation(input: {
  inputCsvPath: string;
  csvPath: string;
  reportPath: string;
  generatedAt?: string;
}): { csv: string; report: string; rowCount: number } {
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  const rows = readZaoCandidateReviewCsv(input.inputCsvPath);
  const { inputs, missingRows } = collectRakutenCoverageInputs(rows);
  const coverageRows = buildRakutenCoverageRows(inputs, RAKUTEN_PAGE_OBSERVATIONS);
  const csv = renderRakutenCoverageCsv(coverageRows);
  const report = renderRakutenCoverageReport({
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    inputCsvPath: input.inputCsvPath,
    csvPath: input.csvPath,
    rows: coverageRows,
    missingRows
  });

  writeFileSync(resolve(input.csvPath), csv, "utf-8");
  writeFileSync(resolve(input.reportPath), report, "utf-8");

  return { csv, report, rowCount: coverageRows.length };
}

function main(): void {
  const inputCsvPath = process.env["ZAO_SOURCE_CANDIDATES_CSV"] ?? latestEnrichedCsvPath();
  const ts = timestamp();
  const csvPath = resolve(REPORT_DIR, `rakuten_coverage_validation_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `rakuten_coverage_validation_report_${ts}.md`);

  const result = runRakutenCoverageValidation({ inputCsvPath, csvPath, reportPath });

  console.log(`input_csv_path=${resolve(inputCsvPath)}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`report_path=${reportPath}`);
  console.log(`validated_hotelno_rows=${result.rowCount}`);
}

if (process.argv[1]?.endsWith("validateRakutenCoverage.ts")) {
  main();
}

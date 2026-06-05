// Phase RAKUTEN-ROOM01X — build Rakuten room-type learning artifacts.
//
// This runner performs one bounded static HTML fetch of the approved Lucent
// plan-list URL, parses room/plan identifiers, and writes local artifacts only.
// It does not call calendar endpoints, write DB rows, mutate history, refresh AI
// context, run broad collectors, use Playwright, or touch Booking.com.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildRakutenRoomTypeLearningResult,
  renderRakutenRoomTypeLearningCsv,
  renderRakutenRoomTypeLearningMarkdown
} from "../services/rakutenRoomTypeLearning";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-room-type-learning";

const LUCENT_TARGET = {
  canonicalPropertyName: "名湯リゾート ルーセント",
  url: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/39565?f_flg=PLAN&f_teikei=&f_hizuke=&f_hak=&f_dai=japan&f_chu=yamagata&f_shou=yamagata&f_sai=&f_tel=&f_target_flg=&f_tscm_flg=&f_p_no=&f_custom_code=&f_search_type=&f_camp_id=&f_static=1&f_squeezes=&f_rm_equip=&f_hi1=24&f_tuki1=6&f_nen1=2026&f_hi2=25&f_tuki2=6&f_nen2=2026&f_heya_su=1&f_otona_su=2&f_s1=0&f_s2=0&f_y1=0&f_y2=0&f_y3=0&f_y4=0&f_kin2=0&f_kin="
};

interface FetchResult {
  html: string;
  finalUrl: string;
  httpStatus: number;
  warning: string;
}

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
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

async function fetchStaticHtml(url: string): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-room-type-learning/0.1; read-only)",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ja,en;q=0.8"
    },
    redirect: "follow"
  });
  const contentType = response.headers.get("content-type") ?? "";
  const buffer = new Uint8Array(await response.arrayBuffer());
  const charset = contentType.match(/charset=([^;\s]+)/iu)?.[1]?.toLowerCase() ?? "utf-8";
  let html = decode(buffer, charset);
  let warning = "";
  if (replacementCharCount(html) > 20) {
    const shiftJis = decode(buffer, "shift_jis");
    if (replacementCharCount(shiftJis) < replacementCharCount(html)) {
      html = shiftJis;
      warning = "Decoded response as shift_jis because the advertised charset produced replacement characters.";
    }
  }
  return { html, finalUrl: response.url || url, httpStatus: response.status, warning };
}

function decode(buffer: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

function replacementCharCount(value: string): number {
  return (value.match(/\uFFFD/gu) ?? []).length;
}

async function main(): Promise<void> {
  const ts = timestamp();
  const runId = `rakuten_room_type_learning_${ts}`;
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  let html = "";
  let fetchWarning = "";
  let finalUrl = LUCENT_TARGET.url;
  let httpStatus: number | null = null;
  try {
    const fetched = await fetchStaticHtml(LUCENT_TARGET.url);
    html = fetched.html;
    fetchWarning = fetched.warning;
    finalUrl = fetched.finalUrl;
    httpStatus = fetched.httpStatus;
  } catch (error) {
    fetchWarning = `Static fetch failed: ${(error as Error).message}`;
  }

  const result = buildRakutenRoomTypeLearningResult({
    runId,
    generatedAtJst: jstIso(),
    canonicalPropertyName: LUCENT_TARGET.canonicalPropertyName,
    sourceUrl: LUCENT_TARGET.url,
    html,
    fetchWarning
  });

  writeFileSync(reportPath, renderRakutenRoomTypeLearningMarkdown(result), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderRakutenRoomTypeLearningCsv(result), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_url.json", {
    canonical_property_name: LUCENT_TARGET.canonicalPropertyName,
    source_url: LUCENT_TARGET.url,
    final_url: finalUrl,
    http_status: httpStatus,
    fetch_warning: fetchWarning,
    bounded_fetch_count: html ? 1 : 0
  });
  writeFileSync(resolve(debugPath, "raw_html_excerpt.txt"), html.slice(0, 20000), "utf8");
  writeDebug("parsed_links.json", result.parsed_links);
  writeDebug("parsed_room_type_candidates.json", result.room_type_candidates);
  writeDebug("parsed_plan_candidates.json", result.plan_candidates);
  writeDebug("parsed_f_syu_candidates.json", result.f_syu_candidates);
  writeDebug("room_type_master_preview.json", result.room_type_master_preview);
  writeDebug("extraction_warnings.json", result.extraction_warnings);
  writeDebug("safety_confirmation.json", result.safety_confirmation);

  console.log(`decision=${result.decision}`);
  console.log(`hotel_no=${result.hotel_context.rakuten_hotel_no}`);
  console.log(`room_type_master_rows=${result.room_type_master_preview.length}`);
  console.log(`f_syu_candidates=${result.f_syu_candidates.length}`);
  console.log(`f_camp_id_candidates=${result.f_camp_id_candidates.length}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

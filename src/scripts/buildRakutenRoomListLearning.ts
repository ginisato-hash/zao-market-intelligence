// Phase RAKUTEN-ROOM02X — bounded Lucent room-list learning.
//
// Reads the ROOM01X artifact, fetches exactly one Lucent room-list page, parses
// static HTML, and writes local artifacts only. It does not call calendar
// endpoints, write DB rows, mutate history, refresh AI context, run collectors,
// use Playwright, or touch Booking.com.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOM01X_ARTIFACT_PATH,
  buildRakutenRoomListLearningResult,
  extractRoomListUrlFromRoom01xArtifact,
  renderRakutenRoomListLearningCsv,
  renderRakutenRoomListLearningMarkdown,
  type Room01xArtifactLike
} from "../services/rakutenRoomListLearning";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-room-list-learning";

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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

async function fetchStaticHtml(url: string): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; zao-market-intelligence-rakuten-room-list-learning/0.1; read-only)",
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
  const runId = `rakuten_room_list_learning_${ts}`;
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const room01x = readJson<Room01xArtifactLike>(ROOM01X_ARTIFACT_PATH);
  const roomListUrl = extractRoomListUrlFromRoom01xArtifact(room01x);
  let html = "";
  let fetchWarning = "";
  let finalUrl = roomListUrl;
  let httpStatus: number | null = null;
  try {
    if (!roomListUrl) throw new Error("ROOM01X room-list URL is missing.");
    const fetched = await fetchStaticHtml(roomListUrl);
    html = fetched.html;
    fetchWarning = fetched.warning;
    finalUrl = fetched.finalUrl;
    httpStatus = fetched.httpStatus;
  } catch (error) {
    fetchWarning = `Static room-list fetch failed: ${(error as Error).message}`;
  }

  const result = buildRakutenRoomListLearningResult({
    runId,
    generatedAtJst: jstIso(),
    sourceRoom01xArtifact: ROOM01X_ARTIFACT_PATH,
    room01xArtifact: room01x,
    html,
    fetchWarning
  });

  writeFileSync(reportPath, renderRakutenRoomListLearningMarkdown(result), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderRakutenRoomListLearningCsv(result), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_room01x_artifact.json", {
    path: ROOM01X_ARTIFACT_PATH,
    decision: room01x.decision,
    hotel_context: room01x.hotel_context
  });
  writeDebug("room_list_url.json", {
    room_list_url: roomListUrl,
    final_url: finalUrl,
    http_status: httpStatus,
    fetch_warning: fetchWarning,
    max_external_requests: 1,
    actual_external_requests: html ? 1 : 0
  });
  writeFileSync(resolve(debugPath, "raw_html_excerpt.txt"), html.slice(0, 20000), "utf8");
  writeDebug("parsed_room_links.json", result.parsed_room_links);
  writeDebug("parsed_room_type_candidates.json", result.room_type_candidates);
  writeDebug("parsed_f_syu_candidates.json", result.f_syu_candidates);
  writeDebug("room_type_master_preview.json", result.room_type_master_preview);
  writeDebug("extraction_warnings.json", result.extraction_warnings);
  writeDebug("sold_out_semantics_guard.json", result.sold_out_semantics_guard);
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

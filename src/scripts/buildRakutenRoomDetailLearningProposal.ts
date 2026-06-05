// Phase RAKUTEN-ROOM03X — build bounded room-detail learning proposal.
//
// Proposal-only. Reads ROOM01X/ROOM02X artifacts and saved ROOM02X HTML debug
// evidence. It never fetches room-detail pages, calls /hplan/calendar, writes
// DB rows, mutates history, refreshes AI context, runs collectors, or uses
// Playwright.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOM01X_ARTIFACT_PATH,
  ROOM02X_ARTIFACT_PATH,
  ROOM02X_RAW_HTML_PATH,
  buildRakutenRoomDetailLearningProposal,
  renderRakutenRoomDetailLearningProposalCsv,
  renderRakutenRoomDetailLearningProposalMarkdown,
  type Room01xLike
} from "../services/rakutenRoomDetailLearningProposal";
import type { RakutenRoomListLearningResult } from "../services/rakutenRoomListLearning";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/rakuten-room-detail-learning-proposal";

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

function main(): void {
  const ts = timestamp();
  const runId = `rakuten_room_detail_learning_proposal_${ts}`;
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const room01x = readJson<Room01xLike>(ROOM01X_ARTIFACT_PATH);
  const room02x = readJson<RakutenRoomListLearningResult>(ROOM02X_ARTIFACT_PATH);
  const savedHtml = readFileSync(resolve(ROOM02X_RAW_HTML_PATH), "utf8");
  const proposal = buildRakutenRoomDetailLearningProposal({
    runId,
    generatedAtJst: jstIso(),
    room01xPath: ROOM01X_ARTIFACT_PATH,
    room01x,
    room02xPath: ROOM02X_ARTIFACT_PATH,
    room02x,
    savedHtmlPath: ROOM02X_RAW_HTML_PATH,
    savedHtml
  });

  writeFileSync(reportPath, renderRakutenRoomDetailLearningProposalMarkdown(proposal), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderRakutenRoomDetailLearningProposalCsv(proposal), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_room01x_artifact.json", proposal.source_room01x_artifact);
  writeDebug("source_room02x_artifact.json", proposal.source_room02x_artifact);
  writeDebug("saved_room_list_html_inspection.json", proposal.saved_room_list_html_inspection);
  writeDebug("room_detail_link_candidates.json", proposal.room_detail_candidates);
  writeDebug("hidden_identifier_candidates.json", proposal.hidden_identifier_candidates);
  writeDebug("proposed_follow_up_targets.json", proposal.proposed_follow_up_targets);
  writeDebug("risk_assessment.json", proposal.risk_assessment);
  writeDebug("sold_out_semantics_guard.json", proposal.sold_out_semantics_guard);
  writeDebug("safety_confirmation.json", proposal.safety_confirmation);

  console.log(`decision=${proposal.decision}`);
  console.log(`room_detail_candidate_count=${proposal.room_detail_candidate_count}`);
  console.log(`hidden_f_syu_candidate_count=${proposal.hidden_f_syu_candidate_count}`);
  console.log(`hidden_f_camp_id_candidate_count=${proposal.hidden_f_camp_id_candidate_count}`);
  console.log(`future_fetch_targets=${proposal.proposed_follow_up_targets.length}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

main();

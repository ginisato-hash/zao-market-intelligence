// Market evidence sidecar exporter (default OFF). Isolated fixtures only: no browser, no network, no real history.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendHistoryRowsAtomic, buildAppendPlan, buildBookingSourceLevelCheck, buildJalanSourceLevelCheck } from "../src/services/autoRunnerMarketRefresh";
import type { PreviewRow } from "../src/services/autoRunnerBookingPreview";
import { TRUSTED_MARKET_DATA_PREFIXES } from "../src/services/marketDataCommitPolicy";
import {
  EVIDENCE_EXCERPT_MAX_CHARS, K27_T04_REFERENCE, MARKET_EVIDENCE_SIDECAR_DIR, appendEvidenceSidecar, buildBookingEvidence, buildEvidenceForAcceptedRows,
  buildJalanEvidence, canonicalJson, evidenceShardName, isEvidenceSidecarEnabled, recordSealOk, refundFromSelectedContext, scrubExcerpt,
  verifyEvidenceArtifact, type BookingEvidenceInput, type EvidenceRecord, type RowIdentity
} from "../src/services/marketEvidenceSidecar";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const PROBE = "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html?checkin=2027-02-13&checkout=2027-02-14&group_adults=2&no_rooms=1&group_children=0&selected_currency=JPY&lang=ja";
const ROW: RowIdentity = { rowId: "2026-10-18|booking|HAMMOND|hammond-takamiya|2027-02-13|2027-02-14|2_adults_1_room_1_night", shardMonth: "2027_02",
  checkin: "2027-02-13", checkout: "2027-02-14", collectedAtJst: "2026-10-18T12:00:06+09:00", sourceSlugOrCode: "hammond-takamiya" };
const ev = (o: Partial<BookingEvidenceInput> = {}): BookingEvidenceInput => ({
  propertySlug: "hammond-takamiya", checkin: "2027-02-13", checkout: "2027-02-14", probeUrl: PROBE, probeArtifactPath: "/probe.txt",
  checkinDetected: true, checkoutDetected: true, adultCountDetected: true, nightCountDetected: false,
  primaryPrice: { numericValue: 43_560, candidateTypeGuess: "total_tax_included", blockGuess: "main_room_card", contextBeforeAfter: "ツインルーム 1泊 税・手数料込み ￥43,560" },
  originalPriceNumeric: null, priceDiscountDetected: false, primaryRoomName: "ツインルーム", primaryRoomCardText: "ツインルーム シングルベッド2台 ￥43,560", selectedRoomId: null, ...o
});
const files = (m: Record<string, string>) => (p: string) => (p in m ? Buffer.from(m[p]!) : null);
const READ = files({ "/probe.txt": PROBE });
const built = (o: Partial<BookingEvidenceInput> = {}, row: RowIdentity = ROW) => buildBookingEvidence(row, ev(o), "run1", READ) as EvidenceRecord;

describe("flag and isolation", () => {
  it("is OFF unless ZMI_EVIDENCE_SIDECAR_ENABLED=1", () => {
    expect(isEvidenceSidecarEnabled({})).toBe(false);
    for (const v of ["0", "true", "yes", ""]) expect(isEvidenceSidecarEnabled({ ZMI_EVIDENCE_SIDECAR_ENABLED: v })).toBe(false);
    expect(isEvidenceSidecarEnabled({ ZMI_EVIDENCE_SIDECAR_ENABLED: "1" })).toBe(true);
  });
  it("lives outside the canonical history: separate dir, never matches zao_signals_*.csv, not staged by auto-commit, git-ignored", () => {
    expect(MARKET_EVIDENCE_SIDECAR_DIR).toBe(".data/history-evidence");
    for (const d of ["2027-01-01", "2027-03-31"]) expect(/^zao_signals_.*\.csv$/u.test(evidenceShardName(d))).toBe(false);
    for (const p of TRUSTED_MARKET_DATA_PREFIXES) expect(`${MARKET_EVIDENCE_SIDECAR_DIR}/`.startsWith(p)).toBe(false);
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\.data\/history-evidence\/$/mu);
  });
  it("the rotating script touches the sidecar only behind the flag and only after an accepted append", () => {
    const src = readFileSync("src/scripts/runAutoRunnerMarketRefreshRotating.ts", "utf8");
    expect(src).toMatch(/collectBookingLive\(bookingTargets, debugPath, jst\.iso, evidenceOn \? bookingEvidence : undefined\)/u);
    expect(src).toMatch(/rowsAppended = r\.rows_written;\n\s+if \(evidenceOn\) evidenceSidecar = exportEvidenceSidecar\(appendPlan\.approved_rows, bookingEvidence, runId\);/u);
    expect(src).toMatch(/\.\.\.\(evidenceOn \? \{ evidence_sidecar: evidenceSidecar \} : \{\}\)/u);
    expect((src.match(/appendEvidenceSidecar\(/gu) ?? []).length).toBe(1);
  });
});

describe("OFF-path / history byte identity on the real append path", () => {
  it("history shards are byte-identical before and after an ON export; the exporter writes only under its own dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zmi-evidence-"));
    try {
      const historyDir = join(tmp, "history"); const evDir = join(tmp, "history-evidence");
      const b: PreviewRow = { source: "booking", property_slug: "hammond-takamiya", canonical_property_name: "HAMMOND", checkin: "2027-02-13", checkout: "2027-02-14",
        stay_scope: "2_adults_1_room_1_night", availability_status: "available_price_basis", primary_price_numeric: 43_560, official_tax_fee_adder_numeric: null,
        computed_total_with_tax_fee: null, basis_confidence: "directional_candidate_basis", dp_usage: "directional_only", classification: "directional",
        screenshot_path: "/s.png", debug_path: "/dbg", warning_flags: [], collected_at_jst: "2026-10-18T12:00:06+09:00", source_phase: "AUTO-RUNNER08X" };
      const plan = buildAppendPlan({ bookingRows: [b], jalanRows: [], existingKeys: [], bookingSourceCheck: buildBookingSourceLevelCheck([b]), jalanSourceCheck: buildJalanSourceLevelCheck([]), bookingReportPath: "", bookingCsvPath: "" });
      appendHistoryRowsAtomic({ rows: plan.approved_rows, historyDir, backupDir: join(tmp, "bk"), historyBefore: 0 });
      const before = Object.fromEntries(readdirSync(historyDir).map((f) => [f, sha(readFileSync(join(historyDir, f)))]));
      const accepted = plan.approved_rows.map((r) => ({ ...r }));
      const out = buildEvidenceForAcceptedRows({ acceptedRows: accepted, booking: [ev({ propertySlug: "hammond-takamiya" })], runId: "run1", readBytes: READ });
      expect(out.rejected).toEqual([]); expect(out.records.length).toBe(1);
      expect(out.records[0]!.row_id).toBe(plan.approved_rows[0]!.rowId);
      appendEvidenceSidecar(out.records, evDir);
      expect(Object.fromEntries(readdirSync(historyDir).map((f) => [f, sha(readFileSync(join(historyDir, f)))]))).toEqual(before);
      expect(readdirSync(historyDir).every((f) => /^zao_signals_.*\.csv$/u.test(f))).toBe(true);
      expect(readdirSync(evDir)).toEqual(["zao_evidence_2027_02.jsonl"]);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  it("no record for a row the append did not accept (no phantom evidence)", () => {
    const out = buildEvidenceForAcceptedRows({ acceptedRows: [], booking: [ev()], runId: "r", readBytes: READ });
    expect(out.records).toEqual([]);
  });
});

describe("evidence semantics", () => {
  it("tax basis is a GUESS, never CONFIRMED; request and page-text evidence keep their own kinds", () => {
    const r = built();
    expect(r.fields.tax_basis).toMatchObject({ state: "GUESS", value: "total_tax_included" });
    expect(r.fields.request_checkin).toMatchObject({ state: "CONFIRMED", kind: "REQUEST_PARAMETER" });
    expect(r.fields.displayed_dates).toMatchObject({ state: "CONFIRMED", kind: "SOURCE_TEXT_MARKER" });
    expect(r.fields.displayed_one_night.state).toBe("UNKNOWN");
    expect(r.fields.price_jpy).toMatchObject({ state: "CONFIRMED", value: 43_560, kind: "SOURCE_PARSED_FIELD" });
    expect(r.fields.meal_room_only.state).toBe("UNKNOWN");
    expect(recordSealOk(r)).toBe(true);
  });
  it("no discount marker -> UNKNOWN (never 'no discount'); a selected-card discount pair -> CONFIRMED with the original price", () => {
    expect(built().fields.promotion).toEqual({ state: "UNKNOWN", reason: "NO_DISCOUNT_MARKER_IS_NOT_PROOF_OF_NONE" });
    expect(built({ priceDiscountDetected: true, originalPriceNumeric: 52_000 }).fields.promotion).toMatchObject({ state: "CONFIRMED", value: { adjusted: true, original_jpy: 52_000 } });
  });
  it("refund only from the selected price's own context; page-wide or ambiguous markers do not count", () => {
    expect(refundFromSelectedContext("ツイン ￥43,560 返金不可")).toMatchObject({ state: "CONFIRMED", value: false });
    expect(refundFromSelectedContext("ツイン ￥43,560 キャンセル無料")).toMatchObject({ state: "CONFIRMED", value: true });
    expect(refundFromSelectedContext("返金不可 / キャンセル無料").state).toBe("UNKNOWN");
    expect(refundFromSelectedContext("ツイン ￥43,560").state).toBe("UNKNOWN");
    // marker only in the room-card text (not the selected price context) is ignored
    expect(built({ primaryRoomCardText: "ツインルーム キャンセル無料 ￥43,560" }).fields.refundable.state).toBe("UNKNOWN");
  });
  it("a related-property (carousel) price is not a selected price", () => {
    const r = built({ primaryPrice: { numericValue: 9_000, candidateTypeGuess: "unknown", blockGuess: "related_property", contextBeforeAfter: "類似施設 ￥9,000" } });
    expect(r.fields.price_jpy.state).toBe("UNKNOWN"); expect(r.fields.tax_basis.state).toBe("UNKNOWN");
  });
  it("row identity must match the evidence (slug / checkin / checkout)", () => {
    expect(buildBookingEvidence(ROW, ev({ checkin: "2027-02-14" }), "r", READ)).toEqual({ rejected: "ROW_IDENTITY_MISMATCH" });
    expect(buildBookingEvidence(ROW, ev({ propertySlug: "oakhill" }), "r", READ)).toEqual({ rejected: "ROW_IDENTITY_MISMATCH" });
  });
});

describe("own K27 T04 reference (Booking roomId 1655515709, Standard 2P)", () => {
  const OWN: RowIdentity = { ...ROW, rowId: "own1", sourceSlugOrCode: "xi-raku" };
  const own = (o: Partial<BookingEvidenceInput>) => buildBookingEvidence(OWN, ev({ propertySlug: "xi-raku", probeUrl: PROBE.replace("hammond-takamiya", "xi-raku"), ...o }), "r", READ) as EvidenceRecord;
  it("never mapped from an arbitrary primary room: no room id -> UNKNOWN even when the name matches", () => {
    expect(own({ primaryRoomName: `${K27_T04_REFERENCE.roomName} 16m²` }).own_reference).toEqual({ state: "UNKNOWN", reason: "SELECTED_ROOM_ID_NOT_EXPOSED_BY_COLLECTOR" });
    expect(own({ selectedRoomId: "999", primaryRoomName: `${K27_T04_REFERENCE.roomName} 16m²` }).own_reference).toMatchObject({ state: "UNKNOWN", reason: "SELECTED_ROOM_IS_NOT_T04_STANDARD" });
  });
  it("recorded only with the exact room id, the T04 room name and a non-NR (free cancellation) selected price", () => {
    const ctx = { numericValue: 52_530, candidateTypeGuess: "total_tax_included", blockGuess: "main_room_card", contextBeforeAfter: "スタンダード ツインルーム ソファ付 ￥52,530 キャンセル無料" };
    expect(own({ selectedRoomId: "1655515709", primaryRoomName: "スタンダード ツインルーム ソファ付 16m²", primaryPrice: ctx }).own_reference)
      .toMatchObject({ state: "CONFIRMED", value: { booking_room_id: "1655515709", plan: "STANDARD" } });
    expect(own({ selectedRoomId: "1655515709", primaryRoomName: "スタンダード ツインルーム ソファ付 16m²", primaryPrice: { ...ctx, contextBeforeAfter: "￥47,277 返金不可" } }).own_reference?.state).toBe("UNKNOWN");
    expect(built().own_reference).toBeNull();                                   // not the own property
  });
});

describe("Jalan decision artifact", () => {
  const J = (o: { meal?: string; coupon?: boolean; slug?: string; price?: number } = {}) => JSON.stringify({
    target: { checkin: "2027-02-20", checkout: "2027-02-21" },
    pageResult: { price_total_tax_included: 25_000, final_url: "https://www.jalan.net/yad1/plan/?stayYear=2027&stayMonth=02&stayDay=20&stayCount=1&roomCount=1&adultNum=2" },
    row: { source_slug_or_code: o.slug ?? "yad1", checkin: "2027-02-20", checkout: "2027-02-21", plan_name: "素泊まりプラン", room_name: "和室", meal_condition: o.meal ?? "食事なし",
      normalized_total_price: o.price ?? 25_000, normalized_total_price_source: "jalan_visible_total_tax_included" },
    candidate: { selected_plan_coupon_or_discount_evidence: o.coupon ?? false, page_chrome_coupon_or_discount_evidence: true }
  });
  const JR: RowIdentity = { rowId: "j1", shardMonth: "2027_02", checkin: "2027-02-20", checkout: "2027-02-21", collectedAtJst: "2026-10-15T06:00:01+09:00", sourceSlugOrCode: "yad1" };
  it("binds plan / room / meal / tax-included total to the hashed decision file; page-chrome coupon is not a plan discount", () => {
    const raw = J(); const r = buildJalanEvidence(JR, "/d.json", "r", files({ "/d.json": raw })) as EvidenceRecord;
    expect(r.artifact).toEqual({ path: "/d.json", sha256: sha(raw) });
    expect(r.selected_rate_plan).toBe("素泊まりプラン");
    expect(r.fields.meal_room_only).toMatchObject({ state: "CONFIRMED", value: true });
    expect(r.fields.tax_basis).toMatchObject({ state: "CONFIRMED", value: "total_tax_included" });
    expect(r.fields.refundable.state).toBe("UNKNOWN");
    expect(r.fields.promotion.state).toBe("UNKNOWN");
    expect((buildJalanEvidence(JR, "/d.json", "r", files({ "/d.json": J({ coupon: true }) })) as EvidenceRecord).fields.promotion).toMatchObject({ state: "CONFIRMED" });
    expect((buildJalanEvidence(JR, "/d.json", "r", files({ "/d.json": J({ price: 24_000 }) })) as EvidenceRecord).fields.price_jpy.state).toBe("UNKNOWN");
    expect(buildJalanEvidence(JR, "/d.json", "r", files({ "/d.json": J({ slug: "yad2" }) }))).toEqual({ rejected: "ROW_IDENTITY_MISMATCH" });
    expect(buildJalanEvidence(JR, "/missing.json", "r", files({}))).toEqual({ rejected: "DECISION_ARTIFACT_MISSING" });
  });
});

describe("append-only, idempotent, conflict / tamper fail-closed, artifact re-verification, PII", () => {
  const withDir = (f: (dir: string) => void) => { const d = mkdtempSync(join(tmpdir(), "zmi-ev-")); try { f(d); } finally { rmSync(d, { recursive: true, force: true }); } };
  it("second identical export is a no-op; existing bytes stay an exact prefix; new rows append", () => withDir((d) => {
    const a = built(); const first = appendEvidenceSidecar([a], d);
    expect(first.written).toBe(1);
    const path = join(d, "zao_evidence_2027_02.jsonl"); const bytes1 = readFileSync(path);
    expect(appendEvidenceSidecar([a], d)).toMatchObject({ written: 0, identical: 1, conflicts: [] });
    expect(readFileSync(path).equals(bytes1)).toBe(true);
    const b = built({}, { ...ROW, rowId: `${ROW.rowId}::intraday::1400` });
    expect(appendEvidenceSidecar([b], d).written).toBe(1);
    const bytes2 = readFileSync(path);
    expect(bytes2.subarray(0, bytes1.length).equals(bytes1)).toBe(true);
    expect(bytes2.toString("utf8").trim().split("\n").length).toBe(2);
    expect(readdirSync(d).filter((f) => f.includes(".tmp-"))).toEqual([]);
  }));
  it("same row_id with different content is a conflict and is not written", () => withDir((d) => {
    appendEvidenceSidecar([built()], d);
    const res = appendEvidenceSidecar([built({ primaryRoomName: "和室" })], d);
    expect(res.written).toBe(0); expect(res.conflicts).toEqual([`${ROW.rowId}:CONTENT_DIFFERS`]);
  }));
  it("a tampered shard is never appended to", () => withDir((d) => {
    appendEvidenceSidecar([built()], d);
    const path = join(d, "zao_evidence_2027_02.jsonl");
    const before = readFileSync(path, "utf8"); writeFileSync(path, before.replace("43560", "33560"));
    const res = appendEvidenceSidecar([built({}, { ...ROW, rowId: "other" })], d);
    expect(res.tamperedShards).toEqual(["zao_evidence_2027_02.jsonl"]); expect(res.written).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before.replace("43560", "33560"));
  }));
  it("an unsealed / forged record is refused", () => withDir((d) => {
    const forged = { ...built(), fields: { ...built().fields, price_jpy: { state: "CONFIRMED" as const, value: 1, kind: "SOURCE_PARSED_FIELD" as const, pointer: "x" } } };
    expect(appendEvidenceSidecar([forged], d).conflicts).toEqual([`${ROW.rowId}:UNSEALED`]);
    expect(existsSync(join(d, "zao_evidence_2027_02.jsonl"))).toBe(false);
  }));
  it("artifact and excerpt hashes are recomputed (a hash string is not proof)", () => {
    const r = built();
    expect(verifyEvidenceArtifact(r, READ)).toEqual([]);
    expect(verifyEvidenceArtifact(r, files({ "/probe.txt": `${PROBE}&x=1` }))).toEqual(["ARTIFACT_HASH_MISMATCH"]);
    expect(verifyEvidenceArtifact(r, files({}))).toEqual(["ARTIFACT_MISSING"]);
    expect(verifyEvidenceArtifact({ ...r, excerpt: { text: "x", sha256: r.excerpt!.sha256 } } as EvidenceRecord, READ)).toContain("EXCERPT_HASH_MISMATCH");
  });
  it("excerpt is bounded and scrubbed of e-mail / phone / URL; no body text is stored", () => {
    const s = scrubExcerpt(`ツイン 連絡 guest@example.com 090-1234-5678 https://x.example/a ${"あ".repeat(2000)}`);
    expect(s).not.toMatch(/@|090-1234|https?:/u); expect(s.length).toBeLessThanOrEqual(EVIDENCE_EXCERPT_MAX_CHARS);
    const line = canonicalJson(built({ primaryRoomCardText: "ツイン guest@example.com" }));
    expect(line).not.toContain("guest@example.com"); expect(line).not.toContain("bodyText");
  });
});

describe("no new request path", () => {
  it("the exporter module performs no network or browser access", () => {
    const src = readFileSync("src/services/marketEvidenceSidecar.ts", "utf8");
    expect(src).not.toMatch(/fetch\(|playwright|chromium|https?\.request|goto\(/u);
    mkdirSync(join(tmpdir(), "zmi-noop"), { recursive: true });
  });
});

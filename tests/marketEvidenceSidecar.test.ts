// Market evidence export (default OFF). Isolated fixtures only: no browser, no network, no real history or debug dir.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendHistoryRowsAtomic, buildAppendPlan, buildBookingSourceLevelCheck, buildJalanSourceLevelCheck } from "../src/services/autoRunnerMarketRefresh";
import type { PreviewRow } from "../src/services/autoRunnerBookingPreview";
import { analyzeBookingRenderedDomSignals } from "../src/services/bookingRenderedDomProbe";
import { TRUSTED_MARKET_DATA_PREFIXES } from "../src/services/marketDataCommitPolicy";
import {
  BOOKING_CAPTURE_FILE, EVIDENCE_EXCERPT_MAX_CHARS, MARKET_EVIDENCE_EXPORT_SCHEMA, MARKET_EVIDENCE_SIDECAR_DIR, PRIVATE_K27_SIDECAR_SCHEMA,
  appendEvidenceSidecar, buildBookingCapture, buildBookingRecord, buildEvidenceForAcceptedRows, buildJalanRecord, canonicalJson, captureBookingEvidence,
  deriveBookingFields, evidenceExportStatus, evidenceShardName, exportContractProblems, guardedReader, isEvidenceSidecarEnabled, recordSealOk,
  scrubExcerpt, sealRecord, verifyEvidenceRecord, verifyEvidenceRecordFullTrust, canonicalHistoryLookup, type AcceptedRow, type BookingCaptureRef, type BookingSelectedCardCapture, type EvidenceRecord
} from "../src/services/marketEvidenceSidecar";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const FIX = "tests/fixtures/market-evidence";
const withDirResult = <T>(f: (d: string) => T): T => { const d = mkdtempSync(join(tmpdir(), "zmi-ev-")); try { return f(d); } finally { /* removed by OS tmp cleanup; read-only fixtures */ } };
const withDir = (f: (d: string) => void) => { const d = mkdtempSync(join(tmpdir(), "zmi-ev-")); try { f(d); } finally { rmSync(d, { recursive: true, force: true }); } };
const PROBE = "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html?checkin=2027-02-13&checkout=2027-02-14&group_adults=2&no_rooms=1&group_children=0&selected_currency=JPY&lang=ja";
const CAP = (o: Partial<BookingSelectedCardCapture> = {}): BookingSelectedCardCapture => ({
  ...buildBookingCapture({ propertySlug: "hammond-takamiya", checkin: "2027-02-13", checkout: "2027-02-14", collectedAtJst: "2026-10-18T12:00:06+09:00",
    probeUrlSanitized: PROBE, finalUrlSanitized: PROBE,
    primaryPrice: { rawText: "￥43,560", numericValue: 43_560, blockGuess: "main_room_card", roleGuess: "effective_price", contextBeforeAfter: "ツインルーム 1泊 大人2名 ￥43,560 税・手数料込み" },
    originalPriceNumeric: null, priceDiscountDetected: false, primaryRoomName: "ツインルーム", primaryRoomCardText: "ツインルーム シングルベッド2台 ￥43,560",
    bodyText: "2027年2月13日 - 2027年2月14日 大人2名 1泊 ツインルーム ￥43,560" }), ...o
});
const ROW = (o: Partial<AcceptedRow> = {}): AcceptedRow => ({ rowId: "2026-10-18|booking|HAMMOND|hammond-takamiya|2027-02-13|2027-02-14|2_adults_1_room_1_night", rowHash: "h1",
  shardMonth: "2027_02", source: "booking", sourceSlugOrCode: "hammond-takamiya", checkin: "2027-02-13", checkout: "2027-02-14",
  collectedAtJst: "2026-10-18T12:00:06+09:00", normalizedTotalPrice: 43_560, debugArtifactPath: "/dbg", sourcePrimaryPrice: 43_560, isPriceExcludedFromDp: false, availabilityStatus: "available_price_basis", ...o });
const mem = (m: Record<string, string>) => (p: string) => (p in m ? Buffer.from(m[p]!) : null);
const capFiles = (cap: BookingSelectedCardCapture = CAP()) => ({ "/cap.json": `${JSON.stringify(cap)}\n` });
const bookingRec = (cap = CAP(), row = ROW()) => buildBookingRecord(row, "/cap.json", "run1", mem(capFiles(cap))) as EvidenceRecord;

describe("flag, isolation, OFF path", () => {
  it("is OFF unless ZMI_EVIDENCE_SIDECAR_ENABLED=1", () => {
    expect(isEvidenceSidecarEnabled({})).toBe(false);
    for (const v of ["0", "true", "yes", ""]) expect(isEvidenceSidecarEnabled({ ZMI_EVIDENCE_SIDECAR_ENABLED: v })).toBe(false);
    expect(isEvidenceSidecarEnabled({ ZMI_EVIDENCE_SIDECAR_ENABLED: "1" })).toBe(true);
  });
  it("outside the canonical history: own dir, never zao_signals_*.csv, not auto-committed, git-ignored", () => {
    expect(MARKET_EVIDENCE_SIDECAR_DIR).toBe(".data/history-evidence");
    for (const d of ["2027-01-01", "2027-03-31"]) expect(/^zao_signals_.*\.csv$/u.test(evidenceShardName(d))).toBe(false);
    for (const p of TRUSTED_MARKET_DATA_PREFIXES) expect(`${MARKET_EVIDENCE_SIDECAR_DIR}/`.startsWith(p)).toBe(false);
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\.data\/history-evidence\/$/mu);
  });
  it("the rotating script touches evidence only behind the flag and only after an accepted append", () => {
    const src = readFileSync("src/scripts/runAutoRunnerMarketRefreshRotating.ts", "utf8");
    expect(src).toMatch(/collectBookingLive\(bookingTargets, debugPath, jst\.iso, evidenceOn \? bookingEvidence : undefined\)/u);
    expect(src).toMatch(/if \(evidenceSink !== undefined\) captureBookingEvidence\(/u);
    expect(src).toMatch(/rowsAppended = r\.rows_written;\n\s+if \(evidenceOn\) evidenceSidecar = exportEvidenceSidecar\(appendPlan\.approved_rows, bookingEvidence, runId\);/u);
    expect(src).toMatch(/\.\.\.\(evidenceOn \? \{ evidence_sidecar: evidenceSidecar \} : \{\}\)/u);
    expect((src.match(/appendEvidenceSidecar\(|captureBookingEvidence\(/gu) ?? []).length).toBe(2);
  });
  it("OFF live-path fixture: the real append path writes byte-identical history and no capture / sidecar file exists", () => withDir((tmp) => {
    const b: PreviewRow = { source: "booking", property_slug: "hammond-takamiya", canonical_property_name: "HAMMOND", checkin: "2027-02-13", checkout: "2027-02-14",
      stay_scope: "2_adults_1_room_1_night", availability_status: "available_price_basis", primary_price_numeric: 43_560, official_tax_fee_adder_numeric: null,
      computed_total_with_tax_fee: null, basis_confidence: "directional_candidate_basis", dp_usage: "directional_only", classification: "directional",
      screenshot_path: "/s.png", debug_path: "/dbg", warning_flags: [], collected_at_jst: "2026-10-18T12:00:06+09:00", source_phase: "AUTO-RUNNER08X" };
    const run = (dir: string) => {
      const plan = buildAppendPlan({ bookingRows: [b], jalanRows: [], existingKeys: [], bookingSourceCheck: buildBookingSourceLevelCheck([b]), jalanSourceCheck: buildJalanSourceLevelCheck([]), bookingReportPath: "", bookingCsvPath: "" });
      appendHistoryRowsAtomic({ rows: plan.approved_rows, historyDir: join(dir, "history"), backupDir: join(dir, "bk"), historyBefore: 0 });
      return { plan, files: Object.fromEntries(readdirSync(join(dir, "history")).map((f) => [f, sha(readFileSync(join(dir, "history", f)))])) };
    };
    const off = run(join(tmp, "off"));
    // ON: identical canonical append, then the export (into its own dir) leaves history untouched
    const on = run(join(tmp, "on"));
    expect(on.files).toEqual(off.files);
    const artifactDir = join(tmp, "on", "dbg"); mkdirSync(artifactDir, { recursive: true });
    const signals = analyzeBookingRenderedDomSignals({ target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" }, checkin: "2027-02-13", checkout: "2027-02-14",
      loaded: true, httpStatus: 200, finalUrl: PROBE, pageTitle: "HAMMOND", bodyText: "HAMMOND 2027年2月13日 大人2名 1泊 ツインルーム シングルベッド2台 ￥43,560 税・手数料込み", error: "" });
    const sink: BookingCaptureRef[] = [];
    captureBookingEvidence(sink, artifactDir, { slug: "hammond-takamiya", checkin: "2027-02-13", checkout: "2027-02-14", collectedAtJst: "2026-10-18T12:00:06+09:00", probeUrl: PROBE, signals });
    const built = buildEvidenceForAcceptedRows({ acceptedRows: on.plan.approved_rows, bookingCaptures: sink, runId: "r", read: guardedReader([tmp]) });
    appendEvidenceSidecar(built.records, join(tmp, "on", "history-evidence"));
    expect(Object.fromEntries(readdirSync(join(tmp, "on", "history")).map((f) => [f, sha(readFileSync(join(tmp, "on", "history", f)))]))).toEqual(off.files);
    expect(readdirSync(join(tmp, "on", "history")).every((f) => /^zao_signals_.*\.csv$/u.test(f))).toBe(true);
    // OFF never had a capture or sidecar
    expect(existsSync(join(tmp, "off", "dbg"))).toBe(false); expect(existsSync(join(tmp, "off", "history-evidence"))).toBe(false);
  }));
});

describe("P0-1 Booking: every field re-derived from the bounded selected-card capture", () => {
  it("price / room / displayed spans CONFIRMED only when provable from the capture; tax GUESS; meal and plan UNKNOWN", () => {
    const r = bookingRec();
    expect(verifyEvidenceRecord(r, mem(capFiles()))).toEqual([]);
    expect(r.fields.price_jpy).toMatchObject({ state: "CONFIRMED", value: 43_560, kind: "SOURCE_PARSED_FIELD" });
    expect(r.fields.room_name).toMatchObject({ state: "CONFIRMED", value: "ツインルーム" });
    expect(r.fields.displayed_checkin).toMatchObject({ state: "CONFIRMED", kind: "SOURCE_TEXT_MARKER" });
    expect(r.fields.tax_basis).toMatchObject({ state: "GUESS", value: "total_tax_included" });
    expect(r.fields.selected_rate_plan.state).toBe("UNKNOWN"); expect(r.fields.meal_room_only.state).toBe("UNKNOWN");
    expect(r.artifact.sha256).toBe(sha(capFiles()["/cap.json"]));
  });
  it("a forged value that is re-sealed is still refused: the source capture re-derivation disagrees", () => {
    const r = bookingRec();
    const { record_sha256: _, ...rest } = r;
    const forged = sealRecord({ ...rest, fields: { ...rest.fields, price_jpy: { state: "CONFIRMED", value: 39_000, kind: "SOURCE_PARSED_FIELD", pointer: "x" } } });
    expect(recordSealOk(forged)).toBe(true);
    expect(verifyEvidenceRecord(forged, mem(capFiles()))).toEqual(["FIELD_MISMATCH(price_jpy)"]);
    const unknownPromoted = sealRecord({ ...rest, fields: { ...rest.fields, meal_room_only: { state: "CONFIRMED", value: true, kind: "SOURCE_PARSED_FIELD", pointer: "x" } } });
    expect(verifyEvidenceRecord(unknownPromoted, mem(capFiles()))).toEqual(["FIELD_MISMATCH(meal_room_only)"]);
  });
  it("missing capture / changed capture bytes / unrelated-card or unprovable capture never yield CONFIRMED", () => {
    expect(verifyEvidenceRecord(bookingRec(), mem({}))).toEqual(["ARTIFACT_MISSING_OR_NOT_ALLOWED"]);
    expect(verifyEvidenceRecord(bookingRec(), mem({ "/cap.json": capFiles()["/cap.json"].replace("43,560", "43,000") }))).toEqual(["ARTIFACT_HASH_MISMATCH"]);
    expect(buildBookingRecord(ROW(), "/none.json", "r", mem({}))).toEqual({ rejected: "CAPTURE_MISSING_OR_NOT_ALLOWED" });
    const related = CAP({ selected_price: { raw_text: "￥9,000", numeric_value: 9_000, block_guess: "related_property", role_guess: "unknown", context: "類似施設 ￥9,000" } });
    expect(deriveBookingFields(related).price_jpy.state).toBe("UNKNOWN");
    const notInContext = CAP({ selected_price: { raw_text: "￥43,560", numeric_value: 43_560, block_guess: "main_room_card", role_guess: "effective_price", context: "ツインルーム" } });
    expect(deriveBookingFields(notInContext).price_jpy.state).toBe("UNKNOWN");
    const valueMismatch = CAP({ selected_price: { raw_text: "￥43,560", numeric_value: 44_000, block_guess: "main_room_card", role_guess: "effective_price", context: "￥43,560" } });
    expect(deriveBookingFields(valueMismatch).price_jpy.state).toBe("UNKNOWN");
    expect(deriveBookingFields(CAP({ room_card: { name: "和室", text: "ツインルーム" } })).room_name.state).toBe("UNKNOWN");
  });
  it("refund markers near the selected price are POSSIBLE at most; discount pairing is GUESS; no marker is UNKNOWN", () => {
    const ctx = (c: string) => CAP({ selected_price: { raw_text: "￥43,560", numeric_value: 43_560, block_guess: "main_room_card", role_guess: "effective_price", context: `ツイン ￥43,560 ${c}` } });
    expect(deriveBookingFields(ctx("キャンセル無料")).refundable).toMatchObject({ state: "POSSIBLE", value: true });
    expect(deriveBookingFields(ctx("返金不可")).refundable).toMatchObject({ state: "POSSIBLE", value: false });
    expect(deriveBookingFields(ctx("返金不可 キャンセル無料")).refundable.state).toBe("UNKNOWN");
    expect(deriveBookingFields(CAP({ room_card: { name: "ツインルーム", text: "ツインルーム キャンセル無料" } })).refundable.state).toBe("UNKNOWN");
    expect(deriveBookingFields(CAP()).promotion).toEqual({ state: "UNKNOWN", reason: "NO_DISCOUNT_MARKER_IS_NOT_PROOF_OF_NONE" });
    expect(deriveBookingFields(CAP({ price_discount_detected: true, original_price_numeric: 52_000 })).promotion).toMatchObject({ state: "GUESS", value: { original_jpy: 52_000 } });
  });
  it("own K27 T04 is never inferred: UNKNOWN without the selected room id and rate plan", () => {
    const own = CAP({ property_slug: "xi-raku", room_card: { name: "スタンダード ツインルーム ソファ付 16m²", text: "スタンダード ツインルーム ソファ付 16m² キャンセル無料" } });
    expect(deriveBookingFields(own).own_k27_t04).toEqual({ state: "UNKNOWN", reason: "SELECTED_ROOM_ID_AND_RATE_PLAN_NOT_EXPOSED_BY_COLLECTOR" });
  });
  it("the capture is bounded and scrubbed; no body text is stored", () => {
    const cap = buildBookingCapture({ propertySlug: "x", checkin: "2027-02-13", checkout: "2027-02-14", collectedAtJst: "t", probeUrlSanitized: PROBE, finalUrlSanitized: PROBE,
      primaryPrice: null, originalPriceNumeric: null, priceDiscountDetected: false, primaryRoomName: "ツイン", primaryRoomCardText: `ツイン guest@example.com 090-1234-5678 https://x.example/a ${"あ".repeat(2000)}`,
      bodyText: "SECRET-BODY 2027年2月13日 大人2名 1泊" });
    const s = JSON.stringify(cap);
    expect(s).not.toMatch(/@example|090-1234|https:\/\/x\.example|SECRET-BODY/u);
    expect(cap.room_card.text.length).toBeLessThanOrEqual(EVIDENCE_EXCERPT_MAX_CHARS);
    expect(cap.displayed_spans).toEqual({ checkin: "2027年2月13日", adults: "大人2名", nights: "1泊" });
    expect(scrubExcerpt("a\u0000b")).toBe("a b");
  });
});

describe("P0-2 accepted-row binding", () => {
  it("the accepted canonical price must equal the proven selected price; identity must match", () => {
    expect(buildBookingRecord(ROW({ normalizedTotalPrice: 40_000 }), "/cap.json", "r", mem(capFiles()))).toEqual({ rejected: "ACCEPTED_PRICE_NOT_PROVEN_BY_CAPTURE" });
    expect(buildBookingRecord(ROW({ sourcePrimaryPrice: 40_000 }), "/cap.json", "r", mem(capFiles()))).toEqual({ rejected: "ACCEPTED_PRICE_NOT_PROVEN_BY_CAPTURE" });
    expect(buildBookingRecord(ROW({ checkin: "2027-02-14" }), "/cap.json", "r", mem(capFiles()))).toEqual({ rejected: "ROW_IDENTITY_MISMATCH" });
    expect(buildBookingRecord(ROW({ collectedAtJst: "2026-10-18T14:00:06+09:00" }), "/cap.json", "r", mem(capFiles()))).toEqual({ rejected: "ROW_IDENTITY_MISMATCH" });
    expect(bookingRec().row).toMatchObject({ row_id: ROW().rowId, row_hash: "h1", normalized_total_price: 43_560 });
  });
  it("zero or several captures for one accepted row are rejected as ambiguous; intraday row ids keep their own binding", () => {
    const ref = { propertySlug: "hammond-takamiya", checkin: "2027-02-13", collectedAtJst: "2026-10-18T12:00:06+09:00", capturePath: "/cap.json" };
    const read = mem(capFiles());
    expect(buildEvidenceForAcceptedRows({ acceptedRows: [ROW()], bookingCaptures: [ref, { ...ref, capturePath: "/cap2.json" }], runId: "r", read }).rejected).toEqual([`${ROW().rowId}:AMBIGUOUS_CAPTURES(2)`]);
    expect(buildEvidenceForAcceptedRows({ acceptedRows: [ROW()], bookingCaptures: [], runId: "r", read }).rejected).toEqual([`${ROW().rowId}:NO_CAPTURE_FOR_ROW`]);
    const intraday = ROW({ rowId: `${ROW().rowId}::intraday::1400` });
    expect(buildEvidenceForAcceptedRows({ acceptedRows: [intraday], bookingCaptures: [ref], runId: "r", read }).records[0]!.row.row_id).toBe(intraday.rowId);
  });
});

describe("P0-3 Jalan: real collector-serialized decision JSON", () => {
  const load = (name: string) => readFileSync(join(FIX, name), "utf8");
  const rowOf = (raw: string): AcceptedRow => { const j = JSON.parse(raw) as { row: Record<string, unknown> };
    return { rowId: "jrow", rowHash: "jh", shardMonth: String(j.row["checkin"]).slice(0, 7).replace("-", "_"), source: "jalan", sourceSlugOrCode: String(j.row["source_slug_or_code"]),
      checkin: String(j.row["checkin"]), checkout: String(j.row["checkout"]), collectedAtJst: String(j.row["collected_at_jst"]), normalizedTotalPrice: j.row["normalized_total_price"] as number | null, debugArtifactPath: "/d.json",
      sourcePrimaryPrice: j.row["source_primary_price"] as number | null, isPriceExcludedFromDp: j.row["is_price_excluded_from_dp"] as boolean, availabilityStatus: String(j.row["availability_status"]) }; };
  it("the selected-plan discount is read from row.evidence_flags (real positive fixture)", () => {
    const raw = load("jalan_decision_plan_discount.json"); const r = buildJalanRecord(rowOf(raw), "/d.json", "r", mem({ "/d.json": raw })) as EvidenceRecord;
    expect(r.fields.promotion).toMatchObject({ state: "CONFIRMED", pointer: "row.evidence_flags.selected_plan_coupon_or_discount_evidence" });
    expect(r.fields.meal_room_only).toMatchObject({ state: "CONFIRMED", value: true });
    expect(r.fields.tax_basis).toMatchObject({ state: "CONFIRMED", value: "total_tax_included" });
    expect(r.fields.price_jpy).toMatchObject({ state: "CONFIRMED", value: 30_360 });
    expect(r.fields.selected_rate_plan.state).toBe("CONFIRMED"); expect(r.fields.refundable.state).toBe("UNKNOWN");
    expect(verifyEvidenceRecord(r, mem({ "/d.json": raw }))).toEqual([]);
  });
  it("a page-chrome-only coupon is not a plan discount (real negative fixture); missing flags -> UNKNOWN", () => {
    const raw = load("jalan_decision_no_plan_discount.json"); const r = buildJalanRecord(rowOf(raw), "/d.json", "r", mem({ "/d.json": raw })) as EvidenceRecord;
    expect(JSON.parse(raw).row.evidence_flags.page_chrome_coupon_or_discount_evidence).toBe(true);
    expect(r.fields.promotion).toEqual({ state: "UNKNOWN", reason: "NO_SELECTED_PLAN_DISCOUNT_MARKER_IS_NOT_PROOF_OF_NONE" });
    const j = JSON.parse(raw); delete j.row.evidence_flags; const noFlags = JSON.stringify(j);
    expect((buildJalanRecord(rowOf(noFlags), "/d.json", "r", mem({ "/d.json": noFlags })) as EvidenceRecord).fields.promotion).toEqual({ state: "UNKNOWN", reason: "EVIDENCE_FLAGS_ABSENT" });
    // a flag invented on `candidate` (the old, wrong location) is ignored
    const k = JSON.parse(raw); k.candidate.selected_plan_coupon_or_discount_evidence = true; const wrong = JSON.stringify(k);
    expect((buildJalanRecord(rowOf(wrong), "/d.json", "r", mem({ "/d.json": wrong })) as EvidenceRecord).fields.promotion.state).toBe("UNKNOWN");
  });
  it("accepted-row price and identity must match the decision; a DP-excluded row binds by its source price", () => {
    const raw = load("jalan_decision_plan_discount.json");
    expect(buildJalanRecord({ ...rowOf(raw), normalizedTotalPrice: 1 }, "/d.json", "r", mem({ "/d.json": raw }))).toEqual({ rejected: "ACCEPTED_PRICE_MISMATCH" });
    expect(buildJalanRecord({ ...rowOf(raw), sourcePrimaryPrice: 1 }, "/d.json", "r", mem({ "/d.json": raw }))).toEqual({ rejected: "ACCEPTED_PRICE_MISMATCH" });
    const excl = load("jalan_decision_no_plan_discount.json");      // real row: room type excluded -> history price blank, source price kept
    const er = rowOf(excl);
    expect(er.isPriceExcludedFromDp).toBe(true);
    const rec = buildJalanRecord({ ...er, normalizedTotalPrice: null }, "/d.json", "r", mem({ "/d.json": excl })) as EvidenceRecord;
    expect(rec.row).toMatchObject({ normalized_total_price: null, source_primary_price: er.sourcePrimaryPrice, price_excluded_from_dp: true });
    expect(buildJalanRecord({ ...rowOf(raw), sourceSlugOrCode: "yad0" }, "/d.json", "r", mem({ "/d.json": raw }))).toEqual({ rejected: "ROW_IDENTITY_MISMATCH" });
  });
});

describe("sold-out / unavailable pages carry no commercial evidence", () => {
  it("plan / room / meal / price / tax / discount are UNKNOWN when the page is not available", () => {
    const j = JSON.parse(readFileSync(join(FIX, "jalan_decision_plan_discount.json"), "utf8"));
    j.row.availability_status = "sold_out"; j.pageResult.final_status = "sold_out"; j.pageResult.price_total_tax_included = null; j.row.normalized_total_price = null; j.row.source_primary_price = null;
    const raw = JSON.stringify(j);
    const row: AcceptedRow = { rowId: "so", rowHash: "h", shardMonth: "2026_11", source: "jalan", sourceSlugOrCode: j.row.source_slug_or_code, checkin: j.row.checkin, checkout: j.row.checkout,
      collectedAtJst: j.row.collected_at_jst, normalizedTotalPrice: null, debugArtifactPath: "/d.json", sourcePrimaryPrice: null, isPriceExcludedFromDp: true, availabilityStatus: "sold_out" };
    const r = buildJalanRecord(row, "/d.json", "r", mem({ "/d.json": raw })) as EvidenceRecord;
    for (const k of ["room_name", "price_jpy", "selected_rate_plan", "tax_basis", "meal_room_only", "promotion"] as const) expect(r.fields[k]).toEqual({ state: "UNKNOWN", reason: "NOT_AVAILABLE(sold_out)" });
    expect(r.fields.request_checkin.state).toBe("CONFIRMED");
  });
});

describe("P0-R1 Booking accepted rows without a price (audit rows)", () => {
  const sig = (bodyText: string) => analyzeBookingRenderedDomSignals({ target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" }, checkin: "2027-02-13", checkout: "2027-02-14",
    loaded: true, httpStatus: 200, finalUrl: PROBE, pageTitle: "HAMMOND", bodyText, error: "" });
  const preview = (o: Partial<PreviewRow>): PreviewRow => ({ source: "booking", property_slug: "hammond-takamiya", canonical_property_name: "HAMMOND", checkin: "2027-02-13", checkout: "2027-02-14",
    stay_scope: "2_adults_1_room_1_night", availability_status: "sold_out_or_unavailable", primary_price_numeric: null, official_tax_fee_adder_numeric: null, computed_total_with_tax_fee: null,
    basis_confidence: "insufficient", dp_usage: "audit_only", classification: "excluded", screenshot_path: "/s.png", debug_path: "/dbg", warning_flags: [],
    collected_at_jst: "2026-10-18T12:00:06+09:00", source_phase: "AUTO-RUNNER08X", ...o });
  /** Real accepted-row path: preview -> buildAppendPlan -> approved canonical row -> capture -> export record. */
  const viaAppend = (p: PreviewRow, body: string) => withDirResult((d) => {
    const plan = buildAppendPlan({ bookingRows: [p], jalanRows: [], existingKeys: [], bookingSourceCheck: buildBookingSourceLevelCheck([p]), jalanSourceCheck: buildJalanSourceLevelCheck([]), bookingReportPath: "", bookingCsvPath: "" });
    const sink: BookingCaptureRef[] = [];
    captureBookingEvidence(sink, d, { slug: "hammond-takamiya", checkin: "2027-02-13", checkout: "2027-02-14", collectedAtJst: "2026-10-18T12:00:06+09:00", probeUrl: PROBE, signals: sig(body) });
    return { plan, built: buildEvidenceForAcceptedRows({ acceptedRows: plan.approved_rows, bookingCaptures: sink, runId: "r", read: guardedReader([d]) }), read: guardedReader([d]) };
  });
  it("sold out / no safe price / excluded no-price rows: accepted, bound, every commercial field UNKNOWN quoting the row's own label", () => {
    for (const [avail, body] of [["sold_out_or_unavailable", "HAMMOND 空室がありません 類似施設 ￥9,000"], ["visible_no_safe_price", "HAMMOND ツインルーム"], ["not_found", "ページが見つかりません"]] as const) {
      const { plan, built, read } = viaAppend(preview({ availability_status: avail }), body);
      expect(plan.approved_rows.length).toBe(1); expect(built.rejected).toEqual([]);
      const r = built.records[0]!;
      expect(r.row).toMatchObject({ source_primary_price: null, normalized_total_price: null, availability_status: avail });
      for (const k of ["room_name", "price_jpy", "selected_rate_plan", "tax_basis", "meal_room_only", "refundable", "promotion", "displayed_checkin"] as const)
        expect(r.fields[k]).toEqual({ state: "UNKNOWN", reason: `ACCEPTED_ROW_UNPRICED(${avail})` });
      expect(r.fields.request_checkin.state).toBe("CONFIRMED");
      expect(verifyEvidenceRecord(r, read)).toEqual([]);
      expect(JSON.stringify(r)).not.toMatch(/9000|9,000/u);                    // the carousel price is never carried
    }
  });
  it("blocked / CAPTCHA and degraded pages are rejected by the append policy, so they never get a record", () => {
    for (const [p, re] of [[preview({ availability_status: "blocked_captcha_or_security", warning_flags: ["captcha_or_security_detected"] }), /captcha|block/u],
      [preview({ availability_status: "degraded_empty" }), /degraded/u]] as const) {
      const { plan, built } = viaAppend(p, "captcha");
      expect(plan.approved_rows.length).toBe(0); expect(plan.rejected_rows[0]!.reason).toMatch(re);
      expect(built.records).toEqual([]); expect(built.rejected).toEqual([]);
    }
  });
  it("priced rows still fail closed: missing card, wrong price; blank price under a 'price found' label; an unpriced row whose capture proves a price", () => {
    const blankButPriced = viaAppend(preview({ availability_status: "available_price_basis" }), "HAMMOND ツインルーム");
    expect(blankButPriced.built.rejected).toEqual([`${blankButPriced.plan.approved_rows[0]!.rowId}:ACCEPTED_PRICE_NOT_PROVEN_BY_CAPTURE`]);
    const priced = preview({ availability_status: "available_price_basis", primary_price_numeric: 43_560, classification: "directional", basis_confidence: "directional_candidate_basis", dp_usage: "directional_only" });
    const missing = viaAppend(priced, "HAMMOND ツインルーム");                   // no price candidate in the page text
    expect(missing.built.rejected).toEqual([`${missing.plan.approved_rows[0]!.rowId}:ACCEPTED_PRICE_NOT_PROVEN_BY_CAPTURE`]);
    const wrong = viaAppend(priced, "HAMMOND ツインルーム シングルベッド2台 ￥45,000 税・手数料込み");
    expect(wrong.built.rejected).toEqual([`${wrong.plan.approved_rows[0]!.rowId}:ACCEPTED_PRICE_NOT_PROVEN_BY_CAPTURE`]);
    const contradiction = viaAppend(preview({ availability_status: "visible_no_safe_price" }), "HAMMOND ツインルーム シングルベッド2台 ￥43,560 税・手数料込み");
    expect(contradiction.built.rejected).toEqual([`${contradiction.plan.approved_rows[0]!.rowId}:CAPTURE_PRICE_BUT_ACCEPTED_ROW_UNPRICED`]);
  });
});

describe("P0-R2 full-trust verification re-binds to canonical history", () => {
  const appendAndExport = (d: string) => {
    const b: PreviewRow = { source: "booking", property_slug: "hammond-takamiya", canonical_property_name: "HAMMOND", checkin: "2027-02-13", checkout: "2027-02-14",
      stay_scope: "2_adults_1_room_1_night", availability_status: "available_price_basis", primary_price_numeric: 43_560, official_tax_fee_adder_numeric: null,
      computed_total_with_tax_fee: null, basis_confidence: "directional_candidate_basis", dp_usage: "directional_only", classification: "directional",
      screenshot_path: "/s.png", debug_path: "/dbg", warning_flags: [], collected_at_jst: "2026-10-18T12:00:06+09:00", source_phase: "AUTO-RUNNER08X" };
    const plan = buildAppendPlan({ bookingRows: [b], jalanRows: [], existingKeys: [], bookingSourceCheck: buildBookingSourceLevelCheck([b]), jalanSourceCheck: buildJalanSourceLevelCheck([]), bookingReportPath: "", bookingCsvPath: "" });
    appendHistoryRowsAtomic({ rows: plan.approved_rows, historyDir: join(d, "history"), backupDir: join(d, "bk"), historyBefore: 0 });
    const sink: BookingCaptureRef[] = []; mkdirSync(join(d, "dbg"));
    captureBookingEvidence(sink, join(d, "dbg"), { slug: "hammond-takamiya", checkin: "2027-02-13", checkout: "2027-02-14", collectedAtJst: "2026-10-18T12:00:06+09:00", probeUrl: PROBE,
      signals: analyzeBookingRenderedDomSignals({ target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" }, checkin: "2027-02-13", checkout: "2027-02-14", loaded: true, httpStatus: 200,
        finalUrl: PROBE, pageTitle: "HAMMOND", bodyText: "HAMMOND 2027年2月13日 大人2名 1泊 ツインルーム シングルベッド2台 ￥43,560 税・手数料込み", error: "" }) });
    const built = buildEvidenceForAcceptedRows({ acceptedRows: plan.approved_rows, bookingCaptures: sink, runId: "r", read: guardedReader([d]) });
    return { rec: built.records[0]!, read: guardedReader([d]), lookup: canonicalHistoryLookup(join(d, "history")) };
  };
  it("a genuine record is fully trusted against the independently read canonical history row", () => withDir((d) => {
    const { rec, read, lookup } = appendAndExport(d);
    expect(verifyEvidenceRecordFullTrust(rec, read, lookup)).toEqual([]);
  }));
  it("re-sealed forged history attributes with untouched source bytes are refused", () => withDir((d) => {
    const { rec, read, lookup } = appendAndExport(d);
    const reseal = (row: Partial<EvidenceRecord["row"]>) => { const { record_sha256: _, ...rest } = rec; return sealRecord({ ...rest, row: { ...rest.row, ...row } }); };
    expect(verifyEvidenceRecordFullTrust(reseal({ row_hash: "forged" }), read, lookup)).toContain("HISTORY_MISMATCH(row_hash)");
    expect(verifyEvidenceRecordFullTrust(reseal({ row_id: `${rec.row.row_id}x` }), read, lookup)).toContain("HISTORY_BINDING_UNVERIFIED");
    const date = verifyEvidenceRecordFullTrust(reseal({ checkin: "2027-02-14" }), read, lookup);
    expect(date).toEqual(expect.arrayContaining(["ROW_IDENTITY_NOT_BOUND_TO_ARTIFACT", "HISTORY_MISMATCH(checkin)"]));
    const price = verifyEvidenceRecordFullTrust(reseal({ source_primary_price: 39_000, normalized_total_price: 39_000 }), read, lookup);
    expect(price).toEqual(expect.arrayContaining(["ROW_PRICE_NOT_BOUND_TO_ARTIFACT", "HISTORY_MISMATCH(source_primary_price)", "HISTORY_MISMATCH(normalized_total_price)"]));
    expect(verifyEvidenceRecordFullTrust(reseal({ availability_status: "sold_out_or_unavailable" }), read, lookup)).toContain("HISTORY_MISMATCH(availability_status)");
    expect(verifyEvidenceRecordFullTrust(reseal({ collected_at_jst: "2026-10-18T14:00:06+09:00" }), read, lookup)).toContain("HISTORY_MISMATCH(collected_at_jst)");
  }));
  it("wrong record_kind / artifact kind / source, and no canonical row, are never fully trusted", () => withDir((d) => {
    const { rec, read, lookup } = appendAndExport(d);
    const { record_sha256: _, ...rest } = rec;
    expect(verifyEvidenceRecordFullTrust(sealRecord({ ...rest, record_kind: "jalan_decision" }), read, lookup)).toContain("KIND_SOURCE_ARTIFACT_INCONSISTENT");
    expect(verifyEvidenceRecordFullTrust(sealRecord({ ...rest, artifact: { ...rest.artifact, kind: "jalan_classification_decision" } }), read, lookup)).toContain("KIND_SOURCE_ARTIFACT_INCONSISTENT");
    expect(verifyEvidenceRecordFullTrust(sealRecord({ ...rest, row: { ...rest.row, source: "jalan" } }), read, lookup)).toContain("KIND_SOURCE_ARTIFACT_INCONSISTENT");
    expect(verifyEvidenceRecordFullTrust(rec, read, () => null)).toEqual(["HISTORY_BINDING_UNVERIFIED"]);
    expect(verifyEvidenceRecord(rec, read)).toEqual([]);                  // source-consistent, but that alone is not full trust
  }));
});

describe("P0-4 distinct wire schema + pinned cross-repo contract", () => {
  it("the export schema is not the private K27 sidecar schema, and a private-layout record is refused", () => {
    expect(MARKET_EVIDENCE_EXPORT_SCHEMA).toBe("zmi_market_evidence_export_v1");
    expect(MARKET_EVIDENCE_EXPORT_SCHEMA).not.toBe(PRIVATE_K27_SIDECAR_SCHEMA);
    const privateShaped = { schema: "zao_market_evidence_sidecar_v0", origin: "JALAN_DECISION", artifact: { path: "/a", sha256: "0".repeat(64), index: null }, key: {}, fields: {} };
    expect(exportContractProblems(privateShaped)).toEqual(["PRIVATE_K27_SIDECAR_SCHEMA_IS_NOT_THIS_EXPORT"]);
    expect(exportContractProblems({ ...privateShaped, schema: "zmi_market_evidence_export_v1" })).toContain("TOP_LEVEL_KEYS");
  });
  it("the pinned contract fixture validates and is reproduced byte-for-byte by the current builders", () => {
    const pinned = readFileSync(join(FIX, "zmi_market_evidence_export_v1.contract.jsonl"), "utf8");
    const jRaw = readFileSync(join(FIX, "jalan_decision_plan_discount.json"), "utf8");
    const j = JSON.parse(jRaw) as { row: Record<string, unknown> };
    const jRow: AcceptedRow = { rowId: "contract-jalan-row", rowHash: "contract-jalan-hash", shardMonth: "2026_11", source: "jalan", sourceSlugOrCode: String(j.row["source_slug_or_code"]),
      checkin: String(j.row["checkin"]), checkout: String(j.row["checkout"]), collectedAtJst: String(j.row["collected_at_jst"]), normalizedTotalPrice: j.row["normalized_total_price"] as number, debugArtifactPath: "fixtures/jalan_decision_plan_discount.json",
      sourcePrimaryPrice: j.row["source_primary_price"] as number, isPriceExcludedFromDp: j.row["is_price_excluded_from_dp"] as boolean, availabilityStatus: String(j.row["availability_status"]) };
    const regenerated = [bookingRec(CAP(), ROW({ rowHash: "contract-booking-hash" })), buildJalanRecord(jRow, jRow.debugArtifactPath, "run1", mem({ [jRow.debugArtifactPath]: jRaw })) as EvidenceRecord]
      .map((r) => `${canonicalJson(r)}\n`).join("");
    expect(regenerated).toBe(pinned);
    for (const line of pinned.trim().split("\n")) expect(exportContractProblems(JSON.parse(line))).toEqual([]);
    // a future private translator must fail closed on any drift
    const drift = JSON.parse(pinned.split("\n")[0]!); drift.fields.price_jpy.state = "MAYBE";
    expect(exportContractProblems(drift)).toEqual(expect.arrayContaining(["STATE(price_jpy)", "RECORD_SEAL_MISMATCH"]));
  });
});

describe("P1 append / status / reads", () => {
  it("append-only, idempotent, conflict and tamper fail closed, orphan temp cleaned", () => withDir((d) => {
    const a = bookingRec();
    expect(appendEvidenceSidecar([a], d).written).toBe(1);
    const path = join(d, evidenceShardName("2027-02-13")); const b1 = readFileSync(path);
    expect(appendEvidenceSidecar([a], d)).toMatchObject({ written: 0, identical: 1, conflicts: [] });
    expect(readFileSync(path).equals(b1)).toBe(true);
    const other = bookingRec(CAP(), ROW({ rowId: "other", rowHash: "h2" }));
    writeFileSync(`${path}.tmp-999-orphan`, "partial");
    expect(appendEvidenceSidecar([other], d).written).toBe(1);
    expect(readFileSync(path).subarray(0, b1.length).equals(b1)).toBe(true);
    expect(readdirSync(d).filter((f) => f.includes(".tmp-") || f.endsWith(".lock"))).toEqual([]);
    const changed = bookingRec(CAP({ room_card: { name: "和室", text: "和室 ￥43,560" } }), ROW({ rowId: "other", rowHash: "h2" }));
    expect(appendEvidenceSidecar([changed], d).conflicts).toEqual(["other:CONTENT_DIFFERS"]);
    const before = readFileSync(path, "utf8"); writeFileSync(path, before.replace("43560", "33560"));
    const t = appendEvidenceSidecar([bookingRec(CAP(), ROW({ rowId: "third" }))], d);
    expect(t.tamperedShards).toEqual([evidenceShardName("2027-02-13")]); expect(t.written).toBe(0);
  }));
  it("a held shard lock (concurrent writer) is never waited on or stolen: nothing written, reported", () => withDir((d) => {
    const path = join(d, evidenceShardName("2027-02-13")); writeFileSync(`${path}.lock`, "123 other-writer\n");
    const res = appendEvidenceSidecar([bookingRec()], d);
    expect(res).toMatchObject({ written: 0, lockedShards: [evidenceShardName("2027-02-13")] });
    expect(existsSync(path)).toBe(false); expect(readFileSync(`${path}.lock`, "utf8")).toBe("123 other-writer\n");
  }));
  it("status is OK only when every accepted row produced a record and nothing was refused", () => {
    const rec = bookingRec(); const clean = { written: 1, identical: 0, conflicts: [], tamperedShards: [], lockedShards: [], files: [] };
    expect(evidenceExportStatus(1, { records: [rec], rejected: [] }, clean)).toBe("OK");
    expect(evidenceExportStatus(2, { records: [rec], rejected: ["x:NO_CAPTURE_FOR_ROW"] }, clean)).toBe("PARTIAL_EVIDENCE_DEGRADED");
    expect(evidenceExportStatus(2, { records: [rec], rejected: [] }, clean)).toBe("PARTIAL_EVIDENCE_DEGRADED");
    expect(evidenceExportStatus(1, { records: [rec], rejected: [] }, { ...clean, lockedShards: ["s"] })).toBe("PARTIAL_EVIDENCE_DEGRADED");
  });
  it("guarded reads: allowlisted root only, no symlink, bounded size", () => withDir((d) => {
    const root = join(d, "debug"); mkdirSync(root); writeFileSync(join(root, "ok.json"), "{}"); writeFileSync(join(d, "outside.json"), "{}");
    symlinkSync(join(d, "outside.json"), join(root, "link.json")); writeFileSync(join(root, "big.json"), "x".repeat(50));
    const read = guardedReader([root], 20);
    expect(read(join(root, "ok.json"))?.toString()).toBe("{}");
    expect(read(join(d, "outside.json"))).toBeNull(); expect(read(join(root, "link.json"))).toBeNull(); expect(read(join(root, "big.json"))).toBeNull();
    expect(read(join(root, "..", "outside.json"))).toBeNull();
  }));
  it("capture writing never overwrites and never throws into the run", () => withDir((d) => {
    const signals = analyzeBookingRenderedDomSignals({ target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" }, checkin: "2027-02-13", checkout: "2027-02-14",
      loaded: true, httpStatus: 200, finalUrl: PROBE, pageTitle: "", bodyText: "ツインルーム ￥43,560", error: "" });
    const sink: BookingCaptureRef[] = []; const x = { slug: "hammond-takamiya", checkin: "2027-02-13", checkout: "2027-02-14", collectedAtJst: "t", probeUrl: PROBE, signals };
    captureBookingEvidence(sink, d, x); const first = readFileSync(join(d, BOOKING_CAPTURE_FILE));
    captureBookingEvidence(sink, d, x);
    expect(sink.length).toBe(1); expect(readFileSync(join(d, BOOKING_CAPTURE_FILE)).equals(first)).toBe(true);
    expect(() => captureBookingEvidence(sink, join(d, "missing-dir"), x)).not.toThrow();
  }));
  it("the module performs no network or browser access", () => {
    expect(readFileSync("src/services/marketEvidenceSidecar.ts", "utf8")).not.toMatch(/fetch\(|playwright|chromium|https?\.request|goto\(/u);
  });
});

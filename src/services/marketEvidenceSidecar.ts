// MARKET EVIDENCE SIDECAR EXPORTER -- default OFF (ZMI_EVIDENCE_SIDECAR_ENABLED=1 to enable).
//
// Keeps the commercial-basis facts the collectors ALREADY parse for the selected product of each fetched page --
// facts the canonical history (zao_local_history_v1, 45 columns) cannot carry -- in an append-only JSONL sidecar keyed
// by the accepted history row_id. It adds no page request, no browser action, no planner / quota / cadence change and
// never touches the canonical history files: .data/history-evidence/zao_evidence_YYYY_MM.jsonl is outside
// .data/history, never matches /^zao_signals_.*\.csv$/ (the downstream 05:30 import filter), is not staged by
// ops:auto-commit-push (which stages only .data/history, apps/zmi-bi-web/data and .data/market-observations) and is
// git-ignored.
//
// Evidence rules (TD #6245360507):
// - every field is CONFIRMED (with the kind of evidence and where it came from), GUESS, or UNKNOWN; absence of a
//   marker is UNKNOWN, never "no";
// - Booking's price-type classification (candidateTypeGuess) is a GUESS, never proof of tax inclusion;
// - a discount is CONFIRMED only from a marker on the selected product; no marker -> UNKNOWN;
// - a cancellation term is used only when it appears in the selected price's own local context and is unambiguous;
// - request parameters are REQUEST_PARAMETER, page-text detections SOURCE_TEXT_MARKER, parser fields
//   SOURCE_PARSED_FIELD -- never promoted;
// - the own K27 T04 reference (Booking roomId 1655515709, Standard 2P) is recorded only when the selected room id,
//   room name and a non-NR plan are all positively identified; the rendered-text collector exposes no room id, so
//   today it is UNKNOWN (never an arbitrary primary room);
// - records exist only for rows the history append ACCEPTED; a row_id already present with different content is a
//   conflict (fail closed, nothing written for it); identical content is an idempotent no-op;
// - every line carries record_sha256 over its canonical JSON; an existing shard that fails verification is never
//   appended to (tamper -> fail closed);
// - the stored room-card excerpt is bounded and scrubbed (hotel rate-card text only; e-mail / phone / URL removed).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const MARKET_EVIDENCE_SIDECAR_SCHEMA = "zao_market_evidence_sidecar_v0" as const;
export const MARKET_EVIDENCE_SIDECAR_DIR = ".data/history-evidence";
export const EVIDENCE_EXCERPT_MAX_CHARS = 600;
/** K27 T04 own reference (Beds24 737052). */
export const K27_T04_REFERENCE = Object.freeze({ ownSlug: "xi-raku", bookingRoomId: "1655515709", roomName: "スタンダード ツインルーム ソファ付" } as const);

export function isEvidenceSidecarEnabled(env: Record<string, string | undefined>): boolean { return env["ZMI_EVIDENCE_SIDECAR_ENABLED"] === "1"; }
export const evidenceShardName = (checkin: string): string => `zao_evidence_${checkin.slice(0, 4)}_${checkin.slice(5, 7)}.jsonl`;

export type EvidenceKind = "SOURCE_PARSED_FIELD" | "SOURCE_TEXT_MARKER" | "REQUEST_PARAMETER";
export type EvidenceField<T> =
  | { state: "CONFIRMED"; value: T; kind: EvidenceKind; pointer: string }
  | { state: "GUESS"; value: T; kind: EvidenceKind; pointer: string }
  | { state: "UNKNOWN"; reason: string };
const c = <T>(value: T, kind: EvidenceKind, pointer: string): EvidenceField<T> => ({ state: "CONFIRMED", value, kind, pointer });
const u = <T>(reason: string): EvidenceField<T> => ({ state: "UNKNOWN", reason });

export interface EvidenceRecord {
  schema: typeof MARKET_EVIDENCE_SIDECAR_SCHEMA;
  row_id: string; shard_month: string; source: "booking" | "jalan"; property_slug: string;
  checkin: string; checkout: string; observed_at: string; run_id: string;
  selected_rate_plan: string | null;
  artifact: { path: string; sha256: string } | null;
  excerpt: { text: string; sha256: string } | null;
  fields: {
    request_checkin: EvidenceField<string>; request_checkout: EvidenceField<string>; request_adults: EvidenceField<number>;
    displayed_dates: EvidenceField<boolean>; displayed_adults: EvidenceField<boolean>; displayed_one_night: EvidenceField<boolean>;
    room_name: EvidenceField<string>; price_jpy: EvidenceField<number>;
    tax_basis: EvidenceField<string>; meal_room_only: EvidenceField<boolean>;
    refundable: EvidenceField<boolean>; promotion: EvidenceField<{ adjusted: true; original_jpy: number | null }>;
  };
  own_reference: EvidenceField<{ booking_room_id: string; room_name: string; plan: "STANDARD" }> | null;
  record_sha256: string;
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
/** Canonical JSON: keys sorted recursively, so the record hash is independent of construction order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function sealRecord(r: Omit<EvidenceRecord, "record_sha256">): EvidenceRecord { return { ...r, record_sha256: sha256(canonicalJson(r)) }; }
export function recordSealOk(r: EvidenceRecord): boolean { const { record_sha256, ...rest } = r; return record_sha256 === sha256(canonicalJson(rest)); }

/** Bounded, scrubbed hotel rate-card excerpt (no e-mail / phone / URL; control characters folded). */
export function scrubExcerpt(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/gu, "[email]")
    .replace(/https?:\/\/\S+/gu, "[url]")
    .replace(/(?:\+?\d[\d\s-]{8,}\d)/gu, "[number]")
    .replace(/\s{2,}/gu, " ").trim().slice(0, EVIDENCE_EXCERPT_MAX_CHARS);
}

const REFUND_NO = /返金不可|払い戻し不可|払戻不可|non[- ]?refundable/iu;
const REFUND_YES = /キャンセル無料|無料キャンセル|free cancellation/iu;
/** Cancellation term from the SELECTED price's local context only; both or neither -> UNKNOWN. */
export function refundFromSelectedContext(context: string): EvidenceField<boolean> {
  const no = REFUND_NO.test(context); const yes = REFUND_YES.test(context);
  if (no && !yes) return c(false, "SOURCE_TEXT_MARKER", "signals.primaryPriceCandidate.contextBeforeAfter");
  if (yes && !no) return c(true, "SOURCE_TEXT_MARKER", "signals.primaryPriceCandidate.contextBeforeAfter");
  return u(no && yes ? "AMBIGUOUS_REFUND_MARKERS_IN_SELECTED_CONTEXT" : "NO_REFUND_MARKER_IN_SELECTED_CONTEXT");
}

/** What the Booking rendered-DOM extractor already holds in memory for one fetched page (no body text kept). */
export interface BookingEvidenceInput {
  propertySlug: string; checkin: string; checkout: string; probeUrl: string; probeArtifactPath: string;
  checkinDetected: boolean; checkoutDetected: boolean; adultCountDetected: boolean; nightCountDetected: boolean;
  primaryPrice: { numericValue: number; candidateTypeGuess: string; blockGuess: string; contextBeforeAfter: string } | null;
  originalPriceNumeric: number | null; priceDiscountDetected: boolean;
  primaryRoomName: string; primaryRoomCardText: string;
  /** Room id of the selected room card when the collector can see one (the rendered-text collector cannot: null). */
  selectedRoomId: string | null;
}
export interface RowIdentity { rowId: string; shardMonth: string; checkin: string; checkout: string; collectedAtJst: string; sourceSlugOrCode: string }

export function buildBookingEvidence(row: RowIdentity, e: BookingEvidenceInput, runId: string, readBytes: (p: string) => Buffer | null): EvidenceRecord | { rejected: string } {
  if (e.propertySlug !== row.sourceSlugOrCode || e.checkin !== row.checkin || e.checkout !== row.checkout) return { rejected: "ROW_IDENTITY_MISMATCH" };
  const probe = readBytes(e.probeArtifactPath);
  const qp = (k: string): string | null => { try { return new URL(e.probeUrl).searchParams.get(k); } catch { return null; } };
  const price = e.primaryPrice !== null && e.primaryPrice.blockGuess === "main_room_card" ? e.primaryPrice : null;
  const excerptText = scrubExcerpt(e.primaryRoomCardText);
  const refund = price === null ? u<boolean>("NO_SELECTED_MAIN_ROOM_CARD_PRICE") : refundFromSelectedContext(price.contextBeforeAfter);
  const isOwn = e.propertySlug === K27_T04_REFERENCE.ownSlug;
  return sealRecord({
    schema: MARKET_EVIDENCE_SIDECAR_SCHEMA, row_id: row.rowId, shard_month: row.shardMonth, source: "booking", property_slug: e.propertySlug,
    checkin: row.checkin, checkout: row.checkout, observed_at: row.collectedAtJst, run_id: runId, selected_rate_plan: null,
    artifact: probe === null ? null : { path: e.probeArtifactPath, sha256: sha256(probe) },
    excerpt: excerptText === "" ? null : { text: excerptText, sha256: sha256(excerptText) },
    fields: {
      request_checkin: qp("checkin") === e.checkin ? c(e.checkin, "REQUEST_PARAMETER", "probe_url?checkin") : u("REQUEST_CHECKIN_MISMATCH"),
      request_checkout: qp("checkout") === e.checkout ? c(e.checkout, "REQUEST_PARAMETER", "probe_url?checkout") : u("REQUEST_CHECKOUT_MISMATCH"),
      request_adults: qp("group_adults") !== null ? c(Number(qp("group_adults")), "REQUEST_PARAMETER", "probe_url?group_adults") : u("REQUEST_ADULTS_ABSENT"),
      displayed_dates: e.checkinDetected && e.checkoutDetected ? c(true, "SOURCE_TEXT_MARKER", "signals.checkinDetected&checkoutDetected") : u("DATES_NOT_DETECTED_IN_PAGE_TEXT"),
      displayed_adults: e.adultCountDetected ? c(true, "SOURCE_TEXT_MARKER", "signals.adultCountDetected") : u("ADULTS_NOT_DETECTED_IN_PAGE_TEXT"),
      displayed_one_night: e.nightCountDetected ? c(true, "SOURCE_TEXT_MARKER", "signals.nightCountDetected") : u("ONE_NIGHT_NOT_DETECTED_IN_PAGE_TEXT"),
      room_name: e.primaryRoomName !== "" ? c(e.primaryRoomName, "SOURCE_PARSED_FIELD", "signals.primaryRoomName") : u("NO_SELECTED_ROOM_NAME"),
      price_jpy: price !== null ? c(price.numericValue, "SOURCE_PARSED_FIELD", "signals.primaryPriceCandidate.numericValue") : u("NO_SELECTED_MAIN_ROOM_CARD_PRICE"),
      tax_basis: price !== null ? { state: "GUESS", value: price.candidateTypeGuess, kind: "SOURCE_TEXT_MARKER", pointer: "signals.primaryPriceCandidate.candidateTypeGuess" } : u("NO_SELECTED_MAIN_ROOM_CARD_PRICE"),
      meal_room_only: u("BOOKING_MEAL_NOT_PARSED_BY_COLLECTOR"),
      refundable: refund,
      promotion: e.priceDiscountDetected && e.originalPriceNumeric !== null && price !== null
        ? c({ adjusted: true as const, original_jpy: e.originalPriceNumeric }, "SOURCE_PARSED_FIELD", "signals.originalPriceNumeric&priceDiscountDetected")
        : u("NO_DISCOUNT_MARKER_IS_NOT_PROOF_OF_NONE")
    },
    own_reference: !isOwn ? null
      : e.selectedRoomId === K27_T04_REFERENCE.bookingRoomId && e.primaryRoomName.startsWith(K27_T04_REFERENCE.roomName) && refund.state === "CONFIRMED" && refund.value === true && price !== null
        ? c({ booking_room_id: e.selectedRoomId, room_name: e.primaryRoomName, plan: "STANDARD" as const }, "SOURCE_PARSED_FIELD", "selectedRoomId+primaryRoomName+refund")
        : u(e.selectedRoomId === null ? "SELECTED_ROOM_ID_NOT_EXPOSED_BY_COLLECTOR" : "SELECTED_ROOM_IS_NOT_T04_STANDARD")
  });
}

/** Jalan: the collector's own classification decision JSON for this target (hash-bound). */
export function buildJalanEvidence(row: RowIdentity, decisionPath: string, runId: string, readBytes: (p: string) => Buffer | null): EvidenceRecord | { rejected: string } {
  const bytes = readBytes(decisionPath);
  if (bytes === null) return { rejected: "DECISION_ARTIFACT_MISSING" };
  let j: { target?: Record<string, unknown>; pageResult?: Record<string, unknown>; row?: Record<string, unknown>; candidate?: Record<string, unknown> };
  try { j = JSON.parse(bytes.toString("utf8")) as typeof j; } catch { return { rejected: "DECISION_ARTIFACT_UNPARSEABLE" }; }
  const r = j.row ?? {}; const p = j.pageResult ?? {}; const cand = j.candidate ?? {};
  const s = (o: Record<string, unknown>, k: string): string | null => typeof o[k] === "string" && o[k] !== "" ? o[k] as string : null;
  const n = (o: Record<string, unknown>, k: string): number | null => typeof o[k] === "number" && Number.isFinite(o[k]) ? o[k] as number : null;
  if (s(r, "source_slug_or_code") !== row.sourceSlugOrCode || s(r, "checkin") !== row.checkin || s(r, "checkout") !== row.checkout) return { rejected: "ROW_IDENTITY_MISMATCH" };
  const served = s(p, "final_url") ?? "";
  const qp = (k: string): string | null => { try { return new URL(served).searchParams.get(k); } catch { return null; } };
  const servedCheckin = qp("stayYear") === null ? null : `${qp("stayYear")}-${(qp("stayMonth") ?? "").padStart(2, "0")}-${(qp("stayDay") ?? "").padStart(2, "0")}`;
  const total = n(p, "price_total_tax_included");
  const meal = s(r, "meal_condition");
  return sealRecord({
    schema: MARKET_EVIDENCE_SIDECAR_SCHEMA, row_id: row.rowId, shard_month: row.shardMonth, source: "jalan", property_slug: row.sourceSlugOrCode,
    checkin: row.checkin, checkout: row.checkout, observed_at: row.collectedAtJst, run_id: runId, selected_rate_plan: s(r, "plan_name"),
    artifact: { path: decisionPath, sha256: sha256(bytes) }, excerpt: null,
    fields: {
      request_checkin: servedCheckin === row.checkin ? c(row.checkin, "REQUEST_PARAMETER", "pageResult.final_url?stayYear,stayMonth,stayDay") : u("SERVED_URL_CHECKIN_MISMATCH"),
      request_checkout: qp("stayCount") === "1" && row.checkout !== "" ? c(row.checkout, "REQUEST_PARAMETER", "pageResult.final_url?stayCount") : u("SERVED_URL_STAYCOUNT_NOT_1"),
      request_adults: qp("adultNum") !== null ? c(Number(qp("adultNum")), "REQUEST_PARAMETER", "pageResult.final_url?adultNum") : u("SERVED_URL_ADULTS_ABSENT"),
      displayed_dates: u("JALAN_DISPLAYED_DATES_NOT_PARSED"), displayed_adults: u("JALAN_DISPLAYED_ADULTS_NOT_PARSED"), displayed_one_night: u("JALAN_DISPLAYED_NIGHTS_NOT_PARSED"),
      room_name: s(r, "room_name") !== null ? c(s(r, "room_name")!, "SOURCE_PARSED_FIELD", "row.room_name") : u("NO_SELECTED_ROOM_NAME"),
      price_jpy: total !== null && total === n(r, "normalized_total_price") ? c(total, "SOURCE_PARSED_FIELD", "pageResult.price_total_tax_included=row.normalized_total_price") : u("SELECTED_PRICE_ABSENT_OR_INCONSISTENT"),
      tax_basis: total !== null && s(r, "normalized_total_price_source") === "jalan_visible_total_tax_included"
        ? c("total_tax_included", "SOURCE_PARSED_FIELD", "pageResult.price_total_tax_included+row.normalized_total_price_source") : u("TAX_INCLUDED_TOTAL_NOT_PARSED"),
      meal_room_only: meal === null ? u("MEAL_CONDITION_ABSENT") : c(["素泊まり", "食事なし", "食事無し"].includes(meal), "SOURCE_PARSED_FIELD", "row.meal_condition"),
      refundable: u("CANCELLATION_TERMS_NOT_PARSED_BY_COLLECTOR"),
      promotion: cand["selected_plan_coupon_or_discount_evidence"] === true
        ? c({ adjusted: true as const, original_jpy: null }, "SOURCE_TEXT_MARKER", "candidate.selected_plan_coupon_or_discount_evidence")
        : u("NO_SELECTED_PLAN_DISCOUNT_MARKER_IS_NOT_PROOF_OF_NONE")
    },
    own_reference: null
  });
}

export interface SidecarAppendResult { written: number; identical: number; conflicts: string[]; tamperedShards: string[]; files: string[] }

/**
 * Append-only, idempotent, atomic: per shard, verify every existing line (seal + unique row_id); a shard that fails is
 * never touched (tamper -> fail closed). Same row_id + same content -> no-op; same row_id + different content ->
 * conflict, not written. New lines are written as (old bytes + new lines) to a temp file, fsynced, renamed; the old
 * bytes are re-checked as an exact prefix after the rename.
 */
export function appendEvidenceSidecar(records: readonly EvidenceRecord[], dir: string): SidecarAppendResult {
  const out: SidecarAppendResult = { written: 0, identical: 0, conflicts: [], tamperedShards: [], files: [] };
  const byShard = new Map<string, EvidenceRecord[]>();
  for (const r of records) byShard.set(evidenceShardName(r.checkin), [...(byShard.get(evidenceShardName(r.checkin)) ?? []), r]);
  for (const [shard, recs] of [...byShard.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(dir, shard);
    const old = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const existing = new Map<string, string>(); let tampered = false;
    for (const line of old.toString("utf8").split("\n")) {
      if (line === "") continue;
      try {
        const r = JSON.parse(line) as EvidenceRecord;
        if (r.schema !== MARKET_EVIDENCE_SIDECAR_SCHEMA || !recordSealOk(r) || existing.has(r.row_id)) { tampered = true; break; }
        existing.set(r.row_id, r.record_sha256);
      } catch { tampered = true; break; }
    }
    if (tampered || (old.length > 0 && old[old.length - 1] !== 0x0a)) { out.tamperedShards.push(shard); continue; }
    const lines: string[] = [];
    for (const r of recs) {
      if (!recordSealOk(r)) { out.conflicts.push(`${r.row_id}:UNSEALED`); continue; }
      const prev = existing.get(r.row_id);
      if (prev === r.record_sha256) { out.identical += 1; continue; }
      if (prev !== undefined) { out.conflicts.push(`${r.row_id}:CONTENT_DIFFERS`); continue; }
      existing.set(r.row_id, r.record_sha256); lines.push(`${canonicalJson(r)}\n`);
    }
    if (lines.length === 0) continue;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    const fd = openSync(tmp, "wx");
    try { writeSync(fd, old); writeSync(fd, lines.join("")); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    const after = readFileSync(path);
    if (!after.subarray(0, old.length).equals(old)) throw new Error(`EVIDENCE_SIDECAR_PREFIX_CHANGED(${shard})`);
    out.written += lines.length; out.files.push(path);
  }
  return out;
}

/** Re-verify a stored record against its artifact bytes (hash) -- a well-formed hash string is not proof. */
export function verifyEvidenceArtifact(r: EvidenceRecord, readBytes: (p: string) => Buffer | null): string[] {
  const p: string[] = [];
  if (!recordSealOk(r)) p.push("RECORD_SEAL_MISMATCH");
  if (r.artifact !== null) { const b = readBytes(r.artifact.path); if (b === null) p.push("ARTIFACT_MISSING"); else if (sha256(b) !== r.artifact.sha256) p.push("ARTIFACT_HASH_MISMATCH"); }
  if (r.excerpt !== null && sha256(r.excerpt.text) !== r.excerpt.sha256) p.push("EXCERPT_HASH_MISMATCH");
  return p;
}

/**
 * Builds records for the rows the history append ACCEPTED (approved rows only), matching each row to the in-memory
 * evidence of the same (source, slug, checkin). Unmatched / mismatched rows get no record (reported).
 */
export function buildEvidenceForAcceptedRows(input: {
  acceptedRows: ReadonlyArray<RowIdentity & { source: string; debugArtifactPath: string }>;
  booking: readonly BookingEvidenceInput[]; runId: string; readBytes: (p: string) => Buffer | null;
}): { records: EvidenceRecord[]; rejected: string[] } {
  const records: EvidenceRecord[] = []; const rejected: string[] = [];
  const bookingByKey = new Map(input.booking.map((b) => [`${b.propertySlug}|${b.checkin}`, b]));
  for (const row of input.acceptedRows) {
    let r: EvidenceRecord | { rejected: string };
    if (row.source === "booking") {
      const e = bookingByKey.get(`${row.sourceSlugOrCode}|${row.checkin}`);
      r = e === undefined ? { rejected: "NO_IN_MEMORY_BOOKING_EVIDENCE" } : buildBookingEvidence(row, e, input.runId, input.readBytes);
    } else if (row.source === "jalan") r = buildJalanEvidence(row, row.debugArtifactPath, input.runId, input.readBytes);
    else r = { rejected: "UNSUPPORTED_SOURCE" };
    if ("rejected" in r) rejected.push(`${row.rowId}:${r.rejected}`); else records.push(r);
  }
  return { records, rejected };
}

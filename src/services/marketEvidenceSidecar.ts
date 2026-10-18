// MARKET EVIDENCE EXPORT -- default OFF (ZMI_EVIDENCE_SIDECAR_ENABLED=1 to enable).
//
// Keeps the commercial-basis facts the collectors ALREADY parse for the selected product of each fetched page in an
// append-only JSONL export keyed by the ACCEPTED canonical history row. No page request, browser action, planner /
// quota / cadence change; the canonical history (zao_local_history_v1, 45 columns) is never touched.
//   .data/history-evidence/zmi_evidence_YYYY_MM.jsonl  -- outside .data/history, never /^zao_signals_.*\.csv$/,
//   not staged by ops:auto-commit-push (TRUSTED_MARKET_DATA_PREFIXES), git-ignored.
//
// WIRE SCHEMA: "zmi_market_evidence_export_v1". This is NOT the private K27 sidecar ("zao_market_evidence_sidecar_v0",
// layout {origin, artifact, key, fields}, CONFIRMED|UNKNOWN only). The two are deliberately distinct; a consumer must
// translate explicitly and fail closed (see exportContractProblems and the pinned contract fixture).
//
// SOURCE PROOF (TD #6248592366):
// - Booking: the collector writes, only when the flag is ON, a bounded selected-rate-card CAPTURE next to the probe URL
//   (selected_card_capture.json: selected price raw text + local context, room card name/text, displayed spans, parser
//   version, sanitized URLs, observedAt; scrubbed, no body text, no screenshot). Every Booking field is RE-DERIVED from
//   that capture's bytes; the record must equal the re-derivation. Values the capture cannot prove are never CONFIRMED.
// - Jalan: every field is re-derived from the collector's own classification decision JSON (hash-bound); the selected-
//   plan discount flag is read where the collector serializes it: row.evidence_flags.
// - Each record is bound to exactly ONE accepted history row (row_id, row_hash, slug, dates, collected_at, accepted
//   price). Duplicate candidates for one row are ambiguous and rejected; a price mismatch is rejected.
//
// EVIDENCE STATES: CONFIRMED (re-derivable fact) | GUESS (classifier output) | POSSIBLE (a marker near the selected price
// but not bound to the selected rate plan) | UNKNOWN. Booking tax basis = GUESS; Booking discount pairing = GUESS;
// Booking refund markers = POSSIBLE at most; no marker = UNKNOWN, never "no". Own K27 T04 (Booking roomId 1655515709,
// Standard 2P) requires the selected room id AND rate-plan identity; the rendered-text collector exposes neither -> UNKNOWN.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { guessPriceCandidateType, sanitizeBookingUrl, type BookingRenderedDomSignals } from "./bookingRenderedDomProbe";
import { parseCsv } from "./localHistoryAppendValidationPolicy";

export const MARKET_EVIDENCE_EXPORT_SCHEMA = "zmi_market_evidence_export_v1" as const;
export const BOOKING_CAPTURE_SCHEMA = "zmi_booking_selected_card_capture_v1" as const;
export const BOOKING_CAPTURE_PARSER_VERSION = "bookingRenderedDomProbe@selectPrimaryBookingPriceCandidate" as const;
/** The private K27 sidecar wire name -- a DIFFERENT layout; never accepted as this export. */
export const PRIVATE_K27_SIDECAR_SCHEMA = "zao_market_evidence_sidecar_v0" as const;
export const MARKET_EVIDENCE_SIDECAR_DIR = ".data/history-evidence";
export const BOOKING_CAPTURE_FILE = "selected_card_capture.json";
export const EVIDENCE_EXCERPT_MAX_CHARS = 600;
export const EVIDENCE_CONTEXT_MAX_CHARS = 300;
export const EVIDENCE_ARTIFACT_MAX_BYTES = 2_000_000;
export const K27_T04_REFERENCE = Object.freeze({ ownSlug: "xi-raku", bookingRoomId: "1655515709", ratePlan: "STANDARD" } as const);

export function isEvidenceSidecarEnabled(env: Record<string, string | undefined>): boolean { return env["ZMI_EVIDENCE_SIDECAR_ENABLED"] === "1"; }
export const evidenceShardName = (checkin: string): string => `zmi_evidence_${checkin.slice(0, 4)}_${checkin.slice(5, 7)}.jsonl`;

export type EvidenceKind = "SOURCE_PARSED_FIELD" | "SOURCE_TEXT_MARKER" | "REQUEST_PARAMETER";
export type EvidenceField<T> =
  | { state: "CONFIRMED" | "GUESS" | "POSSIBLE"; value: T; kind: EvidenceKind; pointer: string }
  | { state: "UNKNOWN"; reason: string };
const f = <T>(state: "CONFIRMED" | "GUESS" | "POSSIBLE", value: T, kind: EvidenceKind, pointer: string): EvidenceField<T> => ({ state, value, kind, pointer });
const u = <T>(reason: string): EvidenceField<T> => ({ state: "UNKNOWN", reason });

/** The accepted canonical history row an export record is bound to. */
export interface AcceptedRow {
  rowId: string; rowHash: string; shardMonth: string; source: string; sourceSlugOrCode: string;
  checkin: string; checkout: string; collectedAtJst: string; normalizedTotalPrice: number | null; debugArtifactPath: string;
  /** The raw source price the canonical row carries (present also when the row is excluded from DP use). */
  sourcePrimaryPrice: number | null; isPriceExcludedFromDp: boolean;
  /** The canonical row's own availability label (copied, never synthesized). */
  availabilityStatus: string;
}
export interface EvidenceFields {
  request_checkin: EvidenceField<string>; request_checkout: EvidenceField<string>; request_adults: EvidenceField<number>;
  displayed_checkin: EvidenceField<string>; displayed_adults: EvidenceField<string>; displayed_one_night: EvidenceField<string>;
  room_name: EvidenceField<string>; price_jpy: EvidenceField<number>; selected_rate_plan: EvidenceField<string>;
  tax_basis: EvidenceField<string>; meal_room_only: EvidenceField<boolean>;
  refundable: EvidenceField<boolean>; promotion: EvidenceField<{ adjusted: true; original_jpy: number | null }>;
  own_k27_t04: EvidenceField<{ booking_room_id: string; rate_plan: string }>;
}
export interface EvidenceRecord {
  schema: typeof MARKET_EVIDENCE_EXPORT_SCHEMA;
  record_kind: "booking_selected_card" | "jalan_decision";
  row: { row_id: string; row_hash: string; shard_month: string; source: "booking" | "jalan"; property_slug: string; checkin: string; checkout: string; collected_at_jst: string; normalized_total_price: number | null; source_primary_price: number | null; price_excluded_from_dp: boolean; availability_status: string };
  run_id: string;
  artifact: { path: string; sha256: string; kind: typeof BOOKING_CAPTURE_SCHEMA | "jalan_classification_decision" };
  fields: EvidenceFields;
  record_sha256: string;
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
/** Canonical JSON: keys sorted recursively. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function sealRecord(r: Omit<EvidenceRecord, "record_sha256">): EvidenceRecord { return { ...r, record_sha256: sha256(canonicalJson(r)) }; }
export function recordSealOk(r: EvidenceRecord): boolean { const { record_sha256, ...rest } = r; return record_sha256 === sha256(canonicalJson(rest)); }

/** Bounded, scrubbed text (no e-mail / phone / URL; control characters folded). */
export function scrubExcerpt(text: string, max = EVIDENCE_EXCERPT_MAX_CHARS): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/gu, "[email]")
    .replace(/https?:\/\/\S+/gu, "[url]")
    .replace(/(?:\+?\d[\d\s-]{8,}\d)/gu, "[number]")
    .replace(/\s{2,}/gu, " ").trim().slice(0, max);
}

// ------------------------------------------------------------------------------------------------- Booking capture
/** What the collector writes (flag ON only) from the page it already fetched. No body text is kept. */
export interface BookingSelectedCardCapture {
  capture_schema: typeof BOOKING_CAPTURE_SCHEMA; parser_version: string;
  property_slug: string; checkin: string; checkout: string; collected_at_jst: string;
  probe_url_sanitized: string; final_url_sanitized: string;
  selected_price: { raw_text: string; numeric_value: number; block_guess: string; role_guess: string; context: string } | null;
  original_price_numeric: number | null; price_discount_detected: boolean;
  room_card: { name: string; text: string };
  displayed_spans: { checkin: string | null; adults: string | null; nights: string | null };
}
const DATE_SPAN = (iso: string): RegExp => { const [y, m, d] = iso.split("-"); return new RegExp(`${y}年0?${Number(m)}月0?${Number(d)}日|0?${Number(m)}月0?${Number(d)}日`, "u"); };
const ADULTS_SPAN = /大人\s*[2２]\s*名|[2２]\s*名の大人/u;
const NIGHTS_SPAN = /[1１]\s*泊/u;
/** Extracts the displayed spans from the in-memory page text (collector side); only the short matches are kept. */
export function displayedSpans(bodyText: string, checkin: string): BookingSelectedCardCapture["displayed_spans"] {
  return { checkin: DATE_SPAN(checkin).exec(bodyText)?.[0] ?? null, adults: ADULTS_SPAN.exec(bodyText)?.[0] ?? null, nights: NIGHTS_SPAN.exec(bodyText)?.[0] ?? null };
}
const yen = (raw: string): number | null => { const m = /[￥¥]\s*([\d,]+)|([\d,]+)\s*円/u.exec(raw); const s = m?.[1] ?? m?.[2]; return s === undefined ? null : Number(s.replace(/,/gu, "")); };
const REFUND_NO = /返金不可|払い戻し不可|払戻不可|non[- ]?refundable/iu;
const REFUND_YES = /キャンセル無料|無料キャンセル|free cancellation/iu;
/** The collector's own price-type classifier (bookingRenderedDomProbe.guessPriceCandidateType): always a GUESS. */
export function guessTaxBasis(context: string): string { return guessPriceCandidateType(context); }

/** Builds the capture from the collector's in-memory signals (flag ON only). */
export function buildBookingCapture(input: {
  propertySlug: string; checkin: string; checkout: string; collectedAtJst: string; probeUrlSanitized: string; finalUrlSanitized: string;
  primaryPrice: { rawText: string; numericValue: number; blockGuess: string; roleGuess: string; contextBeforeAfter: string } | null;
  originalPriceNumeric: number | null; priceDiscountDetected: boolean; primaryRoomName: string; primaryRoomCardText: string; bodyText: string;
}): BookingSelectedCardCapture {
  const pc = input.primaryPrice;
  return {
    capture_schema: BOOKING_CAPTURE_SCHEMA, parser_version: BOOKING_CAPTURE_PARSER_VERSION,
    property_slug: input.propertySlug, checkin: input.checkin, checkout: input.checkout, collected_at_jst: input.collectedAtJst,
    probe_url_sanitized: input.probeUrlSanitized, final_url_sanitized: input.finalUrlSanitized,
    selected_price: pc === null ? null : { raw_text: scrubExcerpt(pc.rawText, 60), numeric_value: pc.numericValue, block_guess: pc.blockGuess, role_guess: pc.roleGuess, context: scrubExcerpt(pc.contextBeforeAfter, EVIDENCE_CONTEXT_MAX_CHARS) },
    original_price_numeric: input.originalPriceNumeric, price_discount_detected: input.priceDiscountDetected,
    room_card: { name: scrubExcerpt(input.primaryRoomName, 120), text: scrubExcerpt(input.primaryRoomCardText) },
    displayed_spans: displayedSpans(input.bodyText, input.checkin)
  };
}

/** One Booking selected-card capture written this run (flag ON only). */
export interface BookingCaptureRef { propertySlug: string; checkin: string; collectedAtJst: string; capturePath: string }
/**
 * Flag ON only (the caller passes a sink only then): writes the bounded selected-rate-card capture of the page ALREADY
 * fetched (no request, no body text, no screenshot) next to the probe URL. Never overwrites ("wx"); any failure leaves the
 * run untouched -- the row then simply gets no record.
 */
export function captureBookingEvidence(sink: BookingCaptureRef[], artifactDir: string, x: { slug: string; checkin: string; checkout: string; collectedAtJst: string; probeUrl: string; signals: BookingRenderedDomSignals }): void {
  try {
    const pc = x.signals.primaryPriceCandidate;
    const cap = buildBookingCapture({ propertySlug: x.slug, checkin: x.checkin, checkout: x.checkout, collectedAtJst: x.collectedAtJst,
      probeUrlSanitized: sanitizeBookingUrl(x.probeUrl), finalUrlSanitized: sanitizeBookingUrl(x.signals.finalUrl),
      primaryPrice: pc === null ? null : { rawText: pc.rawText, numericValue: pc.numericValue, blockGuess: pc.blockGuess, roleGuess: pc.roleGuess, contextBeforeAfter: pc.contextBeforeAfter },
      originalPriceNumeric: x.signals.originalPriceNumeric, priceDiscountDetected: x.signals.priceDiscountDetected,
      primaryRoomName: x.signals.primaryRoomName, primaryRoomCardText: x.signals.primaryRoomCardText, bodyText: x.signals.bodyText });
    const capturePath = join(artifactDir, BOOKING_CAPTURE_FILE);
    writeFileSync(capturePath, `${JSON.stringify(cap)}\n`, { encoding: "utf8", flag: "wx" });
    sink.push({ propertySlug: x.slug, checkin: x.checkin, collectedAtJst: x.collectedAtJst, capturePath });
  } catch { /* evidence is optional: no capture, no record */ }
}

/** Re-derives every Booking field from the capture alone. */
export function deriveBookingFields(cap: BookingSelectedCardCapture, unpricedRow: { availabilityStatus: string } | null = null): EvidenceFields {
  const qp = (url: string, k: string): string | null => { try { return new URL(url).searchParams.get(k); } catch { return null; } };
  const sp = cap.selected_price;
  // The selected price is CONFIRMED only when its raw text parses to the recorded value AND that raw text is present in
  // its own captured context AND it is a main-room-card (not related-property) candidate.
  const priceOk = sp !== null && sp.block_guess === "main_room_card" && yen(sp.raw_text) === sp.numeric_value && sp.context.includes(sp.raw_text);
  const nameOk = cap.room_card.name !== "" && cap.room_card.text.includes(cap.room_card.name);
  const refundNo = priceOk && REFUND_NO.test(sp!.context); const refundYes = priceOk && REFUND_YES.test(sp!.context);
  // The accepted canonical row carries no price: nothing commercial is evidence. The row's own availability label is
  // quoted as the reason; sold-out is never inferred here.
  const audit = <T>(): EvidenceField<T> => u(`ACCEPTED_ROW_UNPRICED(${unpricedRow?.availabilityStatus ?? ""})`);
  if (unpricedRow !== null) {
    return {
      request_checkin: qp(cap.probe_url_sanitized, "checkin") === cap.checkin ? f("CONFIRMED", cap.checkin, "REQUEST_PARAMETER", "capture.probe_url_sanitized?checkin") : u("REQUEST_CHECKIN_MISMATCH"),
      request_checkout: qp(cap.probe_url_sanitized, "checkout") === cap.checkout ? f("CONFIRMED", cap.checkout, "REQUEST_PARAMETER", "capture.probe_url_sanitized?checkout") : u("REQUEST_CHECKOUT_MISMATCH"),
      request_adults: qp(cap.probe_url_sanitized, "group_adults") !== null ? f("CONFIRMED", Number(qp(cap.probe_url_sanitized, "group_adults")), "REQUEST_PARAMETER", "capture.probe_url_sanitized?group_adults") : u("REQUEST_ADULTS_ABSENT"),
      displayed_checkin: audit(), displayed_adults: audit(), displayed_one_night: audit(),
      room_name: audit(), price_jpy: audit(), selected_rate_plan: audit(), tax_basis: audit(), meal_room_only: audit(), refundable: audit(), promotion: audit(),
      own_k27_t04: u(cap.property_slug === K27_T04_REFERENCE.ownSlug ? "SELECTED_ROOM_ID_AND_RATE_PLAN_NOT_EXPOSED_BY_COLLECTOR" : "NOT_OWN_PROPERTY")
    };
  }
  return {
    request_checkin: qp(cap.probe_url_sanitized, "checkin") === cap.checkin ? f("CONFIRMED", cap.checkin, "REQUEST_PARAMETER", "capture.probe_url_sanitized?checkin") : u("REQUEST_CHECKIN_MISMATCH"),
    request_checkout: qp(cap.probe_url_sanitized, "checkout") === cap.checkout ? f("CONFIRMED", cap.checkout, "REQUEST_PARAMETER", "capture.probe_url_sanitized?checkout") : u("REQUEST_CHECKOUT_MISMATCH"),
    request_adults: qp(cap.probe_url_sanitized, "group_adults") !== null ? f("CONFIRMED", Number(qp(cap.probe_url_sanitized, "group_adults")), "REQUEST_PARAMETER", "capture.probe_url_sanitized?group_adults") : u("REQUEST_ADULTS_ABSENT"),
    displayed_checkin: cap.displayed_spans.checkin !== null && DATE_SPAN(cap.checkin).test(cap.displayed_spans.checkin) ? f("CONFIRMED", cap.displayed_spans.checkin, "SOURCE_TEXT_MARKER", "capture.displayed_spans.checkin") : u("CHECKIN_NOT_DISPLAYED_IN_PAGE_TEXT"),
    displayed_adults: cap.displayed_spans.adults !== null && ADULTS_SPAN.test(cap.displayed_spans.adults) ? f("CONFIRMED", cap.displayed_spans.adults, "SOURCE_TEXT_MARKER", "capture.displayed_spans.adults") : u("ADULTS_NOT_DISPLAYED_IN_PAGE_TEXT"),
    displayed_one_night: cap.displayed_spans.nights !== null && NIGHTS_SPAN.test(cap.displayed_spans.nights) ? f("CONFIRMED", cap.displayed_spans.nights, "SOURCE_TEXT_MARKER", "capture.displayed_spans.nights") : u("ONE_NIGHT_NOT_DISPLAYED_IN_PAGE_TEXT"),
    room_name: nameOk ? f("CONFIRMED", cap.room_card.name, "SOURCE_PARSED_FIELD", "capture.room_card.name in capture.room_card.text") : u("SELECTED_ROOM_NAME_NOT_PROVEN"),
    price_jpy: priceOk ? f("CONFIRMED", sp!.numeric_value, "SOURCE_PARSED_FIELD", "capture.selected_price.raw_text in capture.selected_price.context") : u("SELECTED_MAIN_CARD_PRICE_NOT_PROVEN"),
    selected_rate_plan: u("BOOKING_RATE_PLAN_NOT_IDENTIFIED_BY_COLLECTOR"),
    tax_basis: priceOk ? f("GUESS", guessTaxBasis(sp!.context), "SOURCE_TEXT_MARKER", "capture.selected_price.context") : u("SELECTED_MAIN_CARD_PRICE_NOT_PROVEN"),
    meal_room_only: u("BOOKING_MEAL_NOT_PARSED_BY_COLLECTOR"),
    // A marker in the ±context of the selected price is not bound to the selected RATE PLAN -> POSSIBLE at most.
    refundable: refundNo !== refundYes ? f("POSSIBLE", refundYes, "SOURCE_TEXT_MARKER", "capture.selected_price.context") : u(refundNo && refundYes ? "AMBIGUOUS_REFUND_MARKERS" : "NO_REFUND_MARKER_NEAR_SELECTED_PRICE"),
    // The original/effective pairing is chosen from the eligible candidate set, not proven same-room -> GUESS.
    promotion: priceOk && cap.price_discount_detected && cap.original_price_numeric !== null ? f("GUESS", { adjusted: true as const, original_jpy: cap.original_price_numeric }, "SOURCE_TEXT_MARKER", "capture.original_price_numeric") : u("NO_DISCOUNT_MARKER_IS_NOT_PROOF_OF_NONE"),
    own_k27_t04: u(cap.property_slug === K27_T04_REFERENCE.ownSlug ? "SELECTED_ROOM_ID_AND_RATE_PLAN_NOT_EXPOSED_BY_COLLECTOR" : "NOT_OWN_PROPERTY")
  };
}

// ------------------------------------------------------------------------------------------------- Jalan decision
type JalanDecision = { target?: Record<string, unknown>; pageResult?: Record<string, unknown>; row?: Record<string, unknown>; candidate?: Record<string, unknown> };
export function deriveJalanFields(j: JalanDecision): EvidenceFields {
  const r = j.row ?? {}; const p = j.pageResult ?? {};
  const s = (o: Record<string, unknown>, k: string): string | null => typeof o[k] === "string" && o[k] !== "" ? o[k] as string : null;
  const n = (o: Record<string, unknown>, k: string): number | null => typeof o[k] === "number" && Number.isFinite(o[k]) ? o[k] as number : null;
  const served = s(p, "final_url") ?? "";
  const qp = (k: string): string | null => { try { return new URL(served).searchParams.get(k); } catch { return null; } };
  const servedCheckin = qp("stayYear") === null ? null : `${qp("stayYear")}-${(qp("stayMonth") ?? "").padStart(2, "0")}-${(qp("stayDay") ?? "").padStart(2, "0")}`;
  const total = n(p, "price_total_tax_included");
  const meal = s(r, "meal_condition");
  const flags = (r["evidence_flags"] ?? null) as Record<string, unknown> | null;
  const planDiscount = flags === null ? null : flags["selected_plan_coupon_or_discount_evidence"];
  const plan = s(r, "plan_name");
  // A sold-out / failed page has no selected product: its plan / room / meal / price / tax / discount are not evidence.
  const avail = s(r, "availability_status") === "available" && s(p, "final_status") === "available";
  const na = <T>(): EvidenceField<T> => u(`NOT_AVAILABLE(${s(r, "availability_status") ?? "unknown"})`);
  if (!avail) {
    return {
      request_checkin: servedCheckin !== null && servedCheckin === s(r, "checkin") ? f("CONFIRMED", servedCheckin, "REQUEST_PARAMETER", "pageResult.final_url?stayYear,stayMonth,stayDay") : u("SERVED_URL_CHECKIN_MISMATCH"),
      request_checkout: qp("stayCount") === "1" && s(r, "checkout") !== null ? f("CONFIRMED", s(r, "checkout")!, "REQUEST_PARAMETER", "pageResult.final_url?stayCount") : u("SERVED_URL_STAYCOUNT_NOT_1"),
      request_adults: qp("adultNum") !== null ? f("CONFIRMED", Number(qp("adultNum")), "REQUEST_PARAMETER", "pageResult.final_url?adultNum") : u("SERVED_URL_ADULTS_ABSENT"),
      displayed_checkin: u("JALAN_DISPLAYED_DATES_NOT_PARSED"), displayed_adults: u("JALAN_DISPLAYED_ADULTS_NOT_PARSED"), displayed_one_night: u("JALAN_DISPLAYED_NIGHTS_NOT_PARSED"),
      room_name: na(), price_jpy: na(), selected_rate_plan: na(), tax_basis: na(), meal_room_only: na(), refundable: na(), promotion: na(), own_k27_t04: u("NOT_OWN_PROPERTY")
    };
  }
  return {
    request_checkin: servedCheckin !== null && servedCheckin === s(r, "checkin") ? f("CONFIRMED", servedCheckin, "REQUEST_PARAMETER", "pageResult.final_url?stayYear,stayMonth,stayDay") : u("SERVED_URL_CHECKIN_MISMATCH"),
    request_checkout: qp("stayCount") === "1" && s(r, "checkout") !== null ? f("CONFIRMED", s(r, "checkout")!, "REQUEST_PARAMETER", "pageResult.final_url?stayCount") : u("SERVED_URL_STAYCOUNT_NOT_1"),
    request_adults: qp("adultNum") !== null ? f("CONFIRMED", Number(qp("adultNum")), "REQUEST_PARAMETER", "pageResult.final_url?adultNum") : u("SERVED_URL_ADULTS_ABSENT"),
    displayed_checkin: u("JALAN_DISPLAYED_DATES_NOT_PARSED"), displayed_adults: u("JALAN_DISPLAYED_ADULTS_NOT_PARSED"), displayed_one_night: u("JALAN_DISPLAYED_NIGHTS_NOT_PARSED"),
    room_name: s(r, "room_name") !== null ? f("CONFIRMED", s(r, "room_name")!, "SOURCE_PARSED_FIELD", "row.room_name") : u("NO_SELECTED_ROOM_NAME"),
    price_jpy: total !== null && total === n(r, "normalized_total_price") ? f("CONFIRMED", total, "SOURCE_PARSED_FIELD", "pageResult.price_total_tax_included=row.normalized_total_price") : u("SELECTED_PRICE_ABSENT_OR_INCONSISTENT"),
    selected_rate_plan: plan !== null ? f("CONFIRMED", plan, "SOURCE_PARSED_FIELD", "row.plan_name") : u("NO_SELECTED_PLAN_NAME"),
    tax_basis: total !== null && s(r, "normalized_total_price_source") === "jalan_visible_total_tax_included"
      ? f("CONFIRMED", "total_tax_included", "SOURCE_PARSED_FIELD", "pageResult.price_total_tax_included+row.normalized_total_price_source") : u("TAX_INCLUDED_TOTAL_NOT_PARSED"),
    meal_room_only: meal === null ? u("MEAL_CONDITION_ABSENT") : f("CONFIRMED", ["素泊まり", "食事なし", "食事無し"].includes(meal), "SOURCE_PARSED_FIELD", "row.meal_condition"),
    refundable: u("CANCELLATION_TERMS_NOT_PARSED_BY_COLLECTOR"),
    // Serialized by the collector at row.evidence_flags; the page-chrome coupon flag is never a plan discount.
    promotion: planDiscount === true ? f("CONFIRMED", { adjusted: true as const, original_jpy: null }, "SOURCE_TEXT_MARKER", "row.evidence_flags.selected_plan_coupon_or_discount_evidence")
      : u(planDiscount === false ? "NO_SELECTED_PLAN_DISCOUNT_MARKER_IS_NOT_PROOF_OF_NONE" : "EVIDENCE_FLAGS_ABSENT"),
    own_k27_t04: u("NOT_OWN_PROPERTY")
  };
}

// ------------------------------------------------------------------------------------------------- guarded reads
/** Reads an artifact only under an allowlisted root, never through a symlink, never above the byte limit. */
export function guardedReader(roots: readonly string[], maxBytes = EVIDENCE_ARTIFACT_MAX_BYTES): (path: string) => Buffer | null {
  const allowed = roots.map((r) => { try { return realpathSync(resolve(r)); } catch { return resolve(r); } });
  return (path: string): Buffer | null => {
    try {
      if (path === "" || !existsSync(path)) return null;
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
      const real = realpathSync(path);
      if (!allowed.some((r) => real.startsWith(`${r}/`))) return null;
      return readFileSync(real);
    } catch { return null; }
  };
}

// ------------------------------------------------------------------------------------------------- build + verify
export type BuildResult = EvidenceRecord | { rejected: string };
const rowPart = (row: AcceptedRow, source: "booking" | "jalan"): EvidenceRecord["row"] => ({ row_id: row.rowId, row_hash: row.rowHash, shard_month: row.shardMonth, source,
  property_slug: row.sourceSlugOrCode, checkin: row.checkin, checkout: row.checkout, collected_at_jst: row.collectedAtJst, normalized_total_price: row.normalizedTotalPrice,
  source_primary_price: row.sourcePrimaryPrice, price_excluded_from_dp: row.isPriceExcludedFromDp, availability_status: row.availabilityStatus });
/** Canonical availability labels that state a usable price was found (Booking preview / Jalan collector). */
const PRICED_AVAILABILITY = new Set(["available_price_basis", "available"]);
/**
 * An accepted canonical row that legitimately carries no price at all (audit row): BOTH prices blank AND the row's own
 * availability label says no usable price (sold out / no safe price / empty ...). Blank prices under a "price found"
 * label are inconsistent and are NOT an audit row.
 */
const isUnpricedAuditRow = (row: { sourcePrimaryPrice: number | null; normalizedTotalPrice: number | null; availabilityStatus: string }): boolean =>
  row.sourcePrimaryPrice === null && row.normalizedTotalPrice === null && row.availabilityStatus !== "" && !PRICED_AVAILABILITY.has(row.availabilityStatus);
/** The accepted canonical row's prices must both agree with the proven source price (normalized may be blank = excluded). */
const acceptedPriceAgrees = (row: AcceptedRow, proven: number | null): boolean =>
  row.sourcePrimaryPrice === proven && (row.normalizedTotalPrice === null || row.normalizedTotalPrice === proven);

export function buildBookingRecord(row: AcceptedRow, capturePath: string, runId: string, read: (p: string) => Buffer | null): BuildResult {
  const bytes = read(capturePath);
  if (bytes === null) return { rejected: "CAPTURE_MISSING_OR_NOT_ALLOWED" };
  let cap: BookingSelectedCardCapture;
  try { cap = JSON.parse(bytes.toString("utf8")) as BookingSelectedCardCapture; } catch { return { rejected: "CAPTURE_UNPARSEABLE" }; }
  if (cap.capture_schema !== BOOKING_CAPTURE_SCHEMA) return { rejected: "CAPTURE_SCHEMA" };
  if (cap.property_slug !== row.sourceSlugOrCode || cap.checkin !== row.checkin || cap.checkout !== row.checkout || cap.collected_at_jst !== row.collectedAtJst) return { rejected: "ROW_IDENTITY_MISMATCH" };
  const proven = deriveBookingFields(cap);
  let fields: EvidenceFields;
  if (isUnpricedAuditRow(row)) {
    // A legitimately accepted no-price audit row: bound, all commercial fields UNKNOWN. A capture that DOES prove a
    // selected price contradicts the canonical row -> refused.
    if (proven.price_jpy.state === "CONFIRMED") return { rejected: "CAPTURE_PRICE_BUT_ACCEPTED_ROW_UNPRICED" };
    fields = deriveBookingFields(cap, { availabilityStatus: row.availabilityStatus });
  } else {
    // Any accepted row WITH a price (usable or DP-excluded) must be exactly the proven selected price.
    if (proven.price_jpy.state !== "CONFIRMED" || !acceptedPriceAgrees(row, proven.price_jpy.value)) return { rejected: "ACCEPTED_PRICE_NOT_PROVEN_BY_CAPTURE" };
    fields = proven;
  }
  return sealRecord({ schema: MARKET_EVIDENCE_EXPORT_SCHEMA, record_kind: "booking_selected_card", row: rowPart(row, "booking"), run_id: runId,
    artifact: { path: capturePath, sha256: sha256(bytes), kind: BOOKING_CAPTURE_SCHEMA }, fields });
}

export function buildJalanRecord(row: AcceptedRow, decisionPath: string, runId: string, read: (p: string) => Buffer | null): BuildResult {
  const bytes = read(decisionPath);
  if (bytes === null) return { rejected: "DECISION_MISSING_OR_NOT_ALLOWED" };
  let j: JalanDecision;
  try { j = JSON.parse(bytes.toString("utf8")) as JalanDecision; } catch { return { rejected: "DECISION_UNPARSEABLE" }; }
  const r = j.row ?? {};
  if (r["source_slug_or_code"] !== row.sourceSlugOrCode || r["checkin"] !== row.checkin || r["checkout"] !== row.checkout || r["collected_at_jst"] !== row.collectedAtJst) return { rejected: "ROW_IDENTITY_MISMATCH" };
  const decided = typeof r["normalized_total_price"] === "number" ? r["normalized_total_price"] as number : null;
  if (!acceptedPriceAgrees(row, decided)) return { rejected: "ACCEPTED_PRICE_MISMATCH" };
  return sealRecord({ schema: MARKET_EVIDENCE_EXPORT_SCHEMA, record_kind: "jalan_decision", row: rowPart(row, "jalan"), run_id: runId,
    artifact: { path: decisionPath, sha256: sha256(bytes), kind: "jalan_classification_decision" }, fields: deriveJalanFields(j) });
}

/**
 * SOURCE verification: seal, record kind / artifact kind / source consistency, artifact bytes + hash, the record's row
 * identity and prices re-bound to the artifact, and EVERY field re-derived from those bytes. This proves the record is
 * consistent with its source capture -- NOT that it belongs to canonical history (see verifyEvidenceRecordFullTrust).
 */
export function verifyEvidenceRecord(rec: EvidenceRecord, read: (p: string) => Buffer | null): string[] {
  if (rec.schema !== MARKET_EVIDENCE_EXPORT_SCHEMA) return ["SCHEMA"];
  const p: string[] = [];
  if (!recordSealOk(rec)) p.push("RECORD_SEAL_MISMATCH");
  const kindOk = (rec.record_kind === "booking_selected_card" && rec.row.source === "booking" && rec.artifact.kind === BOOKING_CAPTURE_SCHEMA)
    || (rec.record_kind === "jalan_decision" && rec.row.source === "jalan" && rec.artifact.kind === "jalan_classification_decision");
  if (!kindOk) return [...p, "KIND_SOURCE_ARTIFACT_INCONSISTENT"];
  const bytes = read(rec.artifact.path);
  if (bytes === null) return [...p, "ARTIFACT_MISSING_OR_NOT_ALLOWED"];
  if (sha256(bytes) !== rec.artifact.sha256) return [...p, "ARTIFACT_HASH_MISMATCH"];
  const row = { sourcePrimaryPrice: rec.row.source_primary_price, normalizedTotalPrice: rec.row.normalized_total_price, availabilityStatus: rec.row.availability_status };
  let again: EvidenceFields;
  try {
    const raw = JSON.parse(bytes.toString("utf8")) as unknown;
    if (rec.record_kind === "booking_selected_card") {
      const cap = raw as BookingSelectedCardCapture;
      if (cap.property_slug !== rec.row.property_slug || cap.checkin !== rec.row.checkin || cap.checkout !== rec.row.checkout || cap.collected_at_jst !== rec.row.collected_at_jst) p.push("ROW_IDENTITY_NOT_BOUND_TO_ARTIFACT");
      const proven = deriveBookingFields(cap);
      if (isUnpricedAuditRow(row)) {
        if (proven.price_jpy.state === "CONFIRMED") p.push("ROW_PRICE_NOT_BOUND_TO_ARTIFACT");
        again = deriveBookingFields(cap, { availabilityStatus: rec.row.availability_status });
      } else {
        if (proven.price_jpy.state !== "CONFIRMED" || rec.row.source_primary_price !== proven.price_jpy.value || (rec.row.normalized_total_price !== null && rec.row.normalized_total_price !== proven.price_jpy.value)) p.push("ROW_PRICE_NOT_BOUND_TO_ARTIFACT");
        again = proven;
      }
    } else {
      const j = raw as JalanDecision; const r = j.row ?? {};
      if (r["source_slug_or_code"] !== rec.row.property_slug || r["checkin"] !== rec.row.checkin || r["checkout"] !== rec.row.checkout || r["collected_at_jst"] !== rec.row.collected_at_jst) p.push("ROW_IDENTITY_NOT_BOUND_TO_ARTIFACT");
      const decided = typeof r["normalized_total_price"] === "number" ? r["normalized_total_price"] as number : null;
      if (rec.row.source_primary_price !== decided || (rec.row.normalized_total_price !== null && rec.row.normalized_total_price !== decided)) p.push("ROW_PRICE_NOT_BOUND_TO_ARTIFACT");
      again = deriveJalanFields(j);
    }
  } catch { return [...p, "ARTIFACT_UNPARSEABLE"]; }
  for (const k of Object.keys(again) as Array<keyof EvidenceFields>) if (canonicalJson(rec.fields[k]) !== canonicalJson(again[k])) p.push(`FIELD_MISMATCH(${k})`);
  if (Object.keys(rec.fields).length !== Object.keys(again).length) p.push("FIELD_SET_MISMATCH");
  return p;
}

/**
 * FULL-TRUST verification: source verification PLUS re-binding to the canonical accepted history row, looked up
 * independently by (shard, row_id). Every history attribute the record carries must equal the canonical row exactly.
 * No canonical row -> HISTORY_BINDING_UNVERIFIED (never full trust, whatever the artifact hash says).
 */
export function verifyEvidenceRecordFullTrust(rec: EvidenceRecord, read: (p: string) => Buffer | null,
  lookupCanonical: (shardMonth: string, rowId: string) => AcceptedRow | null): string[] {
  const p = verifyEvidenceRecord(rec, read);
  const canonical = lookupCanonical(rec.row.shard_month, rec.row.row_id);
  if (canonical === null) return [...p, "HISTORY_BINDING_UNVERIFIED"];
  if (canonical.source !== rec.row.source) p.push("HISTORY_SOURCE_MISMATCH");
  const expected = rowPart(canonical, canonical.source === "jalan" ? "jalan" : "booking");
  for (const k of Object.keys(expected) as Array<keyof EvidenceRecord["row"]>) if (canonicalJson(rec.row[k]) !== canonicalJson(expected[k])) p.push(`HISTORY_MISMATCH(${k})`);
  if (rec.record_kind === "jalan_decision" && canonical.debugArtifactPath !== rec.artifact.path) p.push("HISTORY_ARTIFACT_PATH_MISMATCH");
  return p;
}

/** Independent read-only lookup of accepted rows in the canonical history shards (zao_signals_<shard>.csv). */
export function canonicalHistoryLookup(historyDir: string): (shardMonth: string, rowId: string) => AcceptedRow | null {
  const cache = new Map<string, Map<string, AcceptedRow>>();
  return (shardMonth: string, rowId: string): AcceptedRow | null => {
    if (!/^\d{4}_\d{2}$/u.test(shardMonth)) return null;
    if (!cache.has(shardMonth)) {
      const m = new Map<string, AcceptedRow>(); cache.set(shardMonth, m);
      const path = join(historyDir, `zao_signals_${shardMonth}.csv`);
      if (existsSync(path)) {
        const recs = parseCsv(readFileSync(path, "utf8")); const h = recs[0] ?? []; const ix = (n: string) => h.indexOf(n);
        const num = (v: string | undefined): number | null => v === undefined || v === "" ? null : Number(v);
        for (const c of recs.slice(1)) {
          const id = c[ix("row_id")]; if (id === undefined || id === "") continue;
          m.set(id, { rowId: id, rowHash: c[ix("row_hash")] ?? "", shardMonth, source: c[ix("source")] ?? "", sourceSlugOrCode: c[ix("source_slug_or_code")] ?? "",
            checkin: c[ix("checkin")] ?? "", checkout: c[ix("checkout")] ?? "", collectedAtJst: c[ix("collected_at_jst")] ?? "",
            normalizedTotalPrice: num(c[ix("normalized_total_price")]), debugArtifactPath: c[ix("debug_artifact_path")] ?? "",
            sourcePrimaryPrice: num(c[ix("source_primary_price")]), isPriceExcludedFromDp: c[ix("is_price_excluded_from_dp")] === "true",
            availabilityStatus: c[ix("availability_status")] ?? "" });
        }
      }
    }
    return cache.get(shardMonth)!.get(rowId) ?? null;
  };
}

/** Strict structural contract of this export (what a downstream translator may rely on). */
export function exportContractProblems(rec: unknown): string[] {
  const p: string[] = [];
  const r = rec as Partial<EvidenceRecord> & Record<string, unknown>;
  if (r === null || typeof r !== "object") return ["NOT_OBJECT"];
  if ((r.schema as string | undefined) === PRIVATE_K27_SIDECAR_SCHEMA) return ["PRIVATE_K27_SIDECAR_SCHEMA_IS_NOT_THIS_EXPORT"];
  if ((r.schema as string | undefined) !== MARKET_EVIDENCE_EXPORT_SCHEMA) return [`SCHEMA(${String(r.schema)})`];
  const keys = ["schema", "record_kind", "row", "run_id", "artifact", "fields", "record_sha256"];
  if (canonicalJson(Object.keys(r).sort()) !== canonicalJson([...keys].sort())) p.push("TOP_LEVEL_KEYS");
  const fieldKeys = ["request_checkin", "request_checkout", "request_adults", "displayed_checkin", "displayed_adults", "displayed_one_night", "room_name", "price_jpy",
    "selected_rate_plan", "tax_basis", "meal_room_only", "refundable", "promotion", "own_k27_t04"];
  if (r.fields === undefined || canonicalJson(Object.keys(r.fields).sort()) !== canonicalJson([...fieldKeys].sort())) p.push("FIELD_KEYS");
  for (const [k, v] of Object.entries(r.fields ?? {})) {
    const e = v as { state?: string; kind?: string };
    if (!["CONFIRMED", "GUESS", "POSSIBLE", "UNKNOWN"].includes(e.state ?? "")) p.push(`STATE(${k})`);
    if (e.state !== "UNKNOWN" && !["SOURCE_PARSED_FIELD", "SOURCE_TEXT_MARKER", "REQUEST_PARAMETER"].includes(e.kind ?? "")) p.push(`KIND(${k})`);
  }
  if (r.record_sha256 !== undefined && !recordSealOk(r as EvidenceRecord)) p.push("RECORD_SEAL_MISMATCH");
  return p;
}

/**
 * Builds records only for ACCEPTED rows. A Booking row must have exactly ONE capture for (slug, checkin, collectedAt);
 * zero or several are rejected (ambiguous), never guessed.
 */
export function buildEvidenceForAcceptedRows(input: {
  acceptedRows: readonly AcceptedRow[]; bookingCaptures: ReadonlyArray<{ propertySlug: string; checkin: string; collectedAtJst: string; capturePath: string }>;
  runId: string; read: (p: string) => Buffer | null;
}): { records: EvidenceRecord[]; rejected: string[] } {
  const records: EvidenceRecord[] = []; const rejected: string[] = [];
  for (const row of input.acceptedRows) {
    let r: BuildResult;
    if (row.source === "booking") {
      const hits = input.bookingCaptures.filter((c) => c.propertySlug === row.sourceSlugOrCode && c.checkin === row.checkin && c.collectedAtJst === row.collectedAtJst);
      r = hits.length !== 1 ? { rejected: hits.length === 0 ? "NO_CAPTURE_FOR_ROW" : `AMBIGUOUS_CAPTURES(${hits.length})` } : buildBookingRecord(row, hits[0]!.capturePath, input.runId, input.read);
    } else if (row.source === "jalan") r = buildJalanRecord(row, row.debugArtifactPath, input.runId, input.read);
    else r = { rejected: "UNSUPPORTED_SOURCE" };
    if ("rejected" in r) rejected.push(`${row.rowId}:${r.rejected}`); else records.push(r);
  }
  return { records, rejected };
}

// ------------------------------------------------------------------------------------------------- append
export interface SidecarAppendResult { written: number; identical: number; conflicts: string[]; tamperedShards: string[]; lockedShards: string[]; files: string[] }

/**
 * Append-only, idempotent, atomic, single writer per shard. Per shard: take an exclusive lock file (O_EXCL; held ->
 * that shard is skipped and reported, never waited on or stolen); remove this shard's orphaned temp files; verify every
 * existing line (seal, schema, unique row_id) -- a failing shard is never touched; same row_id + same content -> no-op;
 * same row_id + different content -> conflict, not written; write (old bytes + new lines) to a fresh temp file, fsync,
 * rename, fsync the directory, and re-check the old bytes as an exact prefix.
 */
export function appendEvidenceSidecar(records: readonly EvidenceRecord[], dir: string): SidecarAppendResult {
  const out: SidecarAppendResult = { written: 0, identical: 0, conflicts: [], tamperedShards: [], lockedShards: [], files: [] };
  const byShard = new Map<string, EvidenceRecord[]>();
  for (const r of records) byShard.set(evidenceShardName(r.row.checkin), [...(byShard.get(evidenceShardName(r.row.checkin)) ?? []), r]);
  if (byShard.size > 0) mkdirSync(dir, { recursive: true });
  for (const [shard, recs] of [...byShard.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(dir, shard); const lock = `${path}.lock`;
    let lockFd: number;
    try { lockFd = openSync(lock, "wx"); } catch { out.lockedShards.push(shard); continue; }
    try {
      writeSync(lockFd, `${process.pid} ${new Date().toISOString()}\n`); fsyncSync(lockFd);
      for (const t of readdirSync(dir)) if (t.startsWith(`${shard}.tmp-`)) unlinkSync(join(dir, t));
      const old = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
      const existing = new Map<string, string>(); let tampered = old.length > 0 && old[old.length - 1] !== 0x0a;
      for (const line of tampered ? [] : old.toString("utf8").split("\n")) {
        if (line === "") continue;
        try {
          const r = JSON.parse(line) as EvidenceRecord;
          if (r.schema !== MARKET_EVIDENCE_EXPORT_SCHEMA || !recordSealOk(r) || existing.has(r.row.row_id)) { tampered = true; break; }
          existing.set(r.row.row_id, r.record_sha256);
        } catch { tampered = true; break; }
      }
      if (tampered) { out.tamperedShards.push(shard); continue; }
      const lines: string[] = [];
      for (const r of recs) {
        if (!recordSealOk(r)) { out.conflicts.push(`${r.row.row_id}:UNSEALED`); continue; }
        const prev = existing.get(r.row.row_id);
        if (prev === r.record_sha256) { out.identical += 1; continue; }
        if (prev !== undefined) { out.conflicts.push(`${r.row.row_id}:CONTENT_DIFFERS`); continue; }
        existing.set(r.row.row_id, r.record_sha256); lines.push(`${canonicalJson(r)}\n`);
      }
      if (lines.length === 0) continue;
      const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      const fd = openSync(tmp, "wx");
      try { writeSync(fd, old); writeSync(fd, lines.join("")); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, path);
      const dfd = openSync(dirname(path), "r"); try { fsyncSync(dfd); } catch { /* directory fsync unsupported */ } finally { closeSync(dfd); }
      const after = readFileSync(path);
      if (!after.subarray(0, old.length).equals(old)) throw new Error(`EVIDENCE_SIDECAR_PREFIX_CHANGED(${basename(path)})`);
      out.written += lines.length; out.files.push(path);
    } finally { closeSync(lockFd); unlinkSync(lock); }
  }
  return out;
}

/** Run-level outcome: OK only when every accepted row produced a verified record and nothing was refused. */
export function evidenceExportStatus(acceptedRows: number, built: { records: EvidenceRecord[]; rejected: string[] }, res: SidecarAppendResult): "OK" | "PARTIAL_EVIDENCE_DEGRADED" {
  const complete = built.rejected.length === 0 && built.records.length === acceptedRows;
  const clean = res.conflicts.length === 0 && res.tamperedShards.length === 0 && res.lockedShards.length === 0;
  return complete && clean ? "OK" : "PARTIAL_EVIDENCE_DEGRADED";
}

/**
 * Rakuten public Thickbox iframe URL probe (Phase 56X).
 *
 * Pure helpers + renderers only. This module performs no network calls and no
 * database writes. The Playwright page rendering lives in
 * src/scripts/probeRakutenIframeUrl.ts.
 */

export type RakutenIframeClassification =
  | "iframe_date_scoped_total_found"
  | "iframe_date_scoped_per_person_found"
  | "iframe_no_plan_or_sold_out"
  | "iframe_date_scope_unverified"
  | "iframe_basis_unverified"
  | "iframe_url_failed";

export type RakutenIframeFeasibilityDecision =
  | "limited_iframe_collector_ready"
  | "iframe_basis_mapping_needed"
  | "not_ready";

export interface RakutenIframeParams {
  fNo: string | null;
  fOtonaSu: string | null;
  fHeyaSu: string | null;
  fSyu: string | null;
  fHizuke: string | null;
  fHak: string | null;
  tbIframe: string | null;
  fThick: string | null;
}

export interface RakutenIframeEvidence {
  propertyDetected: boolean;
  dateScopeDetected: boolean;
  adultCountDetected: boolean;
  roomCountDetected: boolean;
  nightCountDetected: boolean;
  taxIncludedTotalDetected: boolean;
  taxIncludedTotalText: string;
  perPersonPriceDetected: boolean;
  perPersonPriceText: string;
  soldOutOrNoPlanDetected: boolean;
  availabilityStatus: string;
}

export interface RakutenIframeProbeRow {
  canonicalPropertyName: string;
  hotelNo: string;
  stayDate: string;
  planUrl: string;
  extractedCalendarHref: string;
  generatedIframeUrl: string;
  iframeReachable: boolean;
  dateScopeDetected: boolean;
  roomCountDetected: boolean;
  adultCountDetected: boolean;
  nightCountDetected: boolean;
  taxIncludedTotalDetected: string;
  perPersonPriceDetected: string;
  availabilityStatus: string;
  classification: RakutenIframeClassification;
  riskNote: string;
  debugArtifactPath: string;
}

export const RAKUTEN_IFRAME_CSV_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "stay_date",
  "plan_url",
  "extracted_calendar_href",
  "generated_iframe_url",
  "iframe_reachable",
  "date_scope_detected",
  "room_count_detected",
  "adult_count_detected",
  "night_count_detected",
  "tax_included_total_detected",
  "per_person_price_detected",
  "availability_status",
  "classification",
  "risk_note",
  "debug_artifact_path"
] as const;

const TOTAL_TAX_PATTERN =
  /(合計\s*[（(]税込[)）]|合計料金|総額\s*[（(]税込[)）]|2名合計|2名で[^。\n]{0,32}税込|お支払い総額)/u;
const PER_PERSON_PATTERN =
  /([0-9,]+\s*円\s*[／/]\s*人|[0-9,]+\s*円\/人|1名あたり|お一人様|大人1名|[0-9]名利用時)/u;
const PRICE_NEAR_PATTERN = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u;
const SOLD_OUT_NO_PLAN_PATTERN =
  /(満室|空室なし|予約受付を終了|受付終了|プランがありません|該当するプランがありません|ご指定の条件に該当するプランはありません|該当する部屋タイプが見つかりません|部屋タイプが見つかりません|販売終了)/u;
const AVAILABLE_PATTERN = /(予約する|空室あり|残り[0-9０-９]+室|あと[0-9０-９]+室|○|△)/u;

export function extractRakutenHotelNo(url: string): string | null {
  const normalized = url.trim();
  return (
    /^https:\/\/travel\.rakuten\.co\.jp\/HOTEL\/(\d+)\/?$/u.exec(normalized)?.[1] ??
    /^https:\/\/hotel\.travel\.rakuten\.co\.jp\/hotelinfo\/plan\/(\d+)\/?$/u.exec(normalized)?.[1] ??
    null
  );
}

export function buildRakutenHotelPlanUrl(hotelNo: string): string {
  if (!/^\d+$/u.test(hotelNo)) {
    throw new Error(`invalid Rakuten hotelNo: ${hotelNo}`);
  }
  return `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${hotelNo}`;
}

export function extractTwoPersonCalendarHref(htmlOrText: string): string | null {
  const html = htmlOrText.replace(/&amp;/gu, "&");
  const anchorPattern = /<a\b[^>]*href=(["'])(?<href>.*?)\1[^>]*>(?<label>[\s\S]*?)<\/a>/giu;
  let fallback: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match.groups?.href?.trim();
    const label = stripTags(match.groups?.label ?? "");
    if (!href || !label.includes("空室カレンダー")) continue;
    if (/[?&]f_otona_su=2(?:&|$)/u.test(href.replace(/&amp;/gu, "&"))) {
      return normalizeHref(href);
    }
    fallback ??= href;
    const context = stripTags(html.slice(Math.max(0, match.index - 360), match.index + match[0].length));
    if (context.includes("2名利用時") || /2\s*名/u.test(context)) {
      return normalizeHref(href);
    }
  }

  if (fallback !== null) return normalizeHref(fallback);

  const urlMatch = /(https?:)?\/\/hotel\.travel\.rakuten\.co\.jp\/hotelinfo\/plan\/\?[^"'\s<>]+/u.exec(html);
  return urlMatch?.[0] ? normalizeHref(urlMatch[0]) : null;
}

export function parseRakutenIframeParams(rawUrl: string): RakutenIframeParams {
  const url = toRakutenUrl(rawUrl);
  const p = url.searchParams;
  return {
    fNo: p.get("f_no"),
    fOtonaSu: p.get("f_otona_su"),
    fHeyaSu: p.get("f_heya_su"),
    fSyu: p.get("f_syu"),
    fHizuke: p.get("f_hizuke"),
    fHak: p.get("f_hak"),
    tbIframe: p.get("TB_iframe"),
    fThick: p.get("f_thick")
  };
}

export function buildRakutenIframeUrlForDate(rawUrl: string, stayDate: string): string {
  const yyyymmdd = stayDateToRakutenDate(stayDate);
  const url = toRakutenUrl(rawUrl);
  const params = url.searchParams;

  const fNo = params.get("f_no");
  if (!fNo || !/^\d+$/u.test(fNo)) {
    throw new Error("Rakuten iframe URL is missing numeric f_no");
  }
  const fSyu = params.get("f_syu");
  if (!fSyu || fSyu.trim() === "") {
    throw new Error("Rakuten iframe URL is missing f_syu; refusing to guess property-specific room/plan key");
  }

  params.set("TB_iframe", "true");
  params.set("f_thick", "1");
  params.set("f_no", fNo);
  params.set("f_otona_su", "2");
  params.set("f_heya_su", "1");
  params.set("f_hizuke", yyyymmdd);
  if ((params.get("f_hak") ?? "") === "") {
    params.set("f_hak", "1");
  }
  return url.toString();
}

export function detectIframeDateScopedTotalEvidence(input: {
  text: string;
  stayDate: string;
  canonicalPropertyName: string;
}): RakutenIframeEvidence {
  const text = input.text.normalize("NFKC");
  const totalMatch = TOTAL_TAX_PATTERN.exec(text);
  let taxIncludedTotalDetected = false;
  let taxIncludedTotalText = "";
  if (totalMatch?.index !== undefined) {
    const window = text.slice(totalMatch.index, totalMatch.index + 180);
    const priceMatch = PRICE_NEAR_PATTERN.exec(window);
    if (priceMatch?.[0] !== undefined) {
      taxIncludedTotalDetected = true;
      taxIncludedTotalText = priceMatch[0];
    }
  }

  const perPerson = detectIframePerPersonEvidence(text);
  const soldOutOrNoPlanDetected = detectIframeSoldOutOrNoPlan(text);
  let availabilityStatus = "unknown";
  if (soldOutOrNoPlanDetected) availabilityStatus = "sold_out_or_no_plan";
  else if (AVAILABLE_PATTERN.test(text)) availabilityStatus = "available";

  return {
    propertyDetected: propertyNameAppears(text, input.canonicalPropertyName),
    dateScopeDetected: hasDateScope(text, input.stayDate),
    adultCountDetected: /(大人\s*2\s*名|2\s*名|2\s*人|大人2)/u.test(text),
    roomCountDetected: /(1\s*室|1\s*部屋)/u.test(text),
    nightCountDetected: /(1\s*泊|1\s*日間|1\s*night)/iu.test(text),
    taxIncludedTotalDetected,
    taxIncludedTotalText,
    perPersonPriceDetected: perPerson.detected,
    perPersonPriceText: perPerson.text,
    soldOutOrNoPlanDetected,
    availabilityStatus
  };
}

export function detectIframePerPersonEvidence(text: string): { detected: boolean; text: string } {
  const normalized = text.normalize("NFKC");
  const match = PER_PERSON_PATTERN.exec(normalized);
  if (!match?.[0]) return { detected: false, text: "" };
  const windowStart = Math.max(0, match.index - 64);
  const window = normalized.slice(windowStart, match.index + 96);
  const price = PRICE_NEAR_PATTERN.exec(window)?.[0] ?? match[0];
  return { detected: true, text: price };
}

export function detectIframeSoldOutOrNoPlan(text: string): boolean {
  return SOLD_OUT_NO_PLAN_PATTERN.test(text.normalize("NFKC"));
}

export function normalizeRakutenPriceText(text: string): number | null {
  const normalized = text.normalize("NFKC");
  const match = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,})/u.exec(normalized);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const value = Number(raw.replace(/,/gu, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function classifyRakutenIframeProbe(input: {
  iframeReachable: boolean;
  evidence: RakutenIframeEvidence;
}): RakutenIframeClassification {
  const e = input.evidence;
  if (!input.iframeReachable) return "iframe_url_failed";
  if (!e.dateScopeDetected) return "iframe_date_scope_unverified";
  if (e.soldOutOrNoPlanDetected) return "iframe_no_plan_or_sold_out";
  if (
    e.propertyDetected &&
    e.adultCountDetected &&
    e.roomCountDetected &&
    e.nightCountDetected &&
    e.taxIncludedTotalDetected &&
    e.availabilityStatus === "available"
  ) {
    return "iframe_date_scoped_total_found";
  }
  if (e.propertyDetected && e.perPersonPriceDetected && !e.taxIncludedTotalDetected) {
    return "iframe_date_scoped_per_person_found";
  }
  return "iframe_basis_unverified";
}

export function decideRakutenIframeFeasibility(
  classifications: RakutenIframeClassification[]
): RakutenIframeFeasibilityDecision {
  if (classifications.includes("iframe_date_scoped_total_found")) {
    return "limited_iframe_collector_ready";
  }
  const usefulEvidence = classifications.some(
    (c) =>
      c === "iframe_date_scoped_per_person_found" ||
      c === "iframe_no_plan_or_sold_out" ||
      c === "iframe_basis_unverified"
  );
  return usefulEvidence ? "iframe_basis_mapping_needed" : "not_ready";
}

export function renderRakutenIframeProbeCsv(rows: RakutenIframeProbeRow[]): string {
  const body = rows.map((row) =>
    [
      row.canonicalPropertyName,
      row.hotelNo,
      row.stayDate,
      row.planUrl,
      row.extractedCalendarHref,
      row.generatedIframeUrl,
      yn(row.iframeReachable),
      yn(row.dateScopeDetected),
      yn(row.roomCountDetected),
      yn(row.adultCountDetected),
      yn(row.nightCountDetected),
      row.taxIncludedTotalDetected,
      row.perPersonPriceDetected,
      row.availabilityStatus,
      row.classification,
      row.riskNote,
      row.debugArtifactPath
    ].map(csvEscape).join(",")
  );
  return [RAKUTEN_IFRAME_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRakutenIframeProbeReport(input: {
  generatedAt: string;
  csvPath: string;
  debugRootPath: string;
  rows: RakutenIframeProbeRow[];
  decision: RakutenIframeFeasibilityDecision;
  executionNote: string;
}): string {
  const counts = new Map<RakutenIframeClassification, number>();
  for (const row of input.rows) counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);

  return [
    "# Rakuten Calendar Iframe URL Probe",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- execution_note=${input.executionNote}`,
    `- feasibility_decision=${input.decision}`,
    `- probe_rows=${input.rows.length}`,
    `- classification_counts=${JSON.stringify(Object.fromEntries(counts))}`,
    "",
    "## 2. Inputs used",
    "",
    "- Public Rakuten hotel plan-list pages: https://hotel.travel.rakuten.co.jp/hotelinfo/plan/[hotelNo]",
    "- Public 2名利用時 空室カレンダー Thickbox / iframe hrefs extracted from the rendered DOM.",
    "- Target properties: ZAO BASE / 197787, YuiLocalZao / 198027, 蔵王国際ホテル / 5723.",
    "- Target dates: 2026-08-10, 2026-10-10.",
    `- csv_path=${input.csvPath}`,
    `- debug_root=${input.debugRootPath}`,
    "",
    "## 3. Properties/dates tested",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.hotelNo} / ${row.stayDate}`),
    "",
    "## 4. Extracted original calendar hrefs",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.stayDate}: ${row.extractedCalendarHref || "not_found"}`),
    "",
    "## 5. Generated iframe URLs",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.stayDate}: ${row.generatedIframeUrl || "not_generated"}`),
    "",
    "## 6. Iframe reachability results",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.stayDate}: reachable=${yn(row.iframeReachable)}, classification=${row.classification}`),
    "",
    "## 7. Date-scope findings",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.stayDate}: date_scope=${yn(row.dateScopeDetected)}`),
    "",
    "## 8. Adult/room/night basis findings",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.stayDate}: adults=${yn(row.adultCountDetected)}, rooms=${yn(row.roomCountDetected)}, nights=${yn(row.nightCountDetected)}`),
    "",
    "## 9. Tax-included total findings",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.stayDate}: total=${row.taxIncludedTotalDetected || "none"}, per_person=${row.perPersonPriceDetected || "none"}`),
    "",
    "## 10. Classification counts",
    "",
    `- ${JSON.stringify(Object.fromEntries(counts))}`,
    "",
    "## 11. Feasibility decision",
    "",
    `- ${input.decision}`,
    "",
    "## 12. Risk notes",
    "",
    ...input.rows.map((row) => `- ${row.canonicalPropertyName} / ${row.stayDate}: ${row.riskNote}`),
    "",
    "## 13. Debug artifact paths",
    "",
    ...input.rows.map((row) => `- ${row.debugArtifactPath}`),
    "",
    "## 14. Safety confirmation",
    "",
    "- Public rendered pages only; no login, no cookies, no CAPTCHA bypass, no stealth, no paid APIs, no proxies.",
    "- No DB writes, no rate_snapshots, no inventory_snapshots, no collector_runs.",
    "- No Beds24/AirHost/PMS/OTA upload files.",
    "",
    "## 15. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: RakutenIframeFeasibilityDecision): string {
  if (decision === "limited_iframe_collector_ready") {
    return "- Build a tiny one-property Rakuten iframe collector prototype, still writing debug artifacts first and DB snapshots only after explicit review.";
  }
  if (decision === "iframe_basis_mapping_needed") {
    return "- Inspect iframe debug DOM/screenshots and map total/per-person/date selectors before any DB-writing collector is built.";
  }
  return "- Continue iframe URL/selector mapping with the public Thickbox href path; do not abandon Rakuten based on static HTML.";
}

function stayDateToRakutenDate(stayDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(stayDate);
  if (!match) throw new Error(`stayDate must be YYYY-MM-DD: ${stayDate}`);
  return `${match[1]}${match[2]}${match[3]}`;
}

function hasDateScope(text: string, stayDate: string): boolean {
  const [year, monthRaw, dayRaw] = stayDate.split("-");
  if (!year || !monthRaw || !dayRaw) return false;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const yyyymmdd = `${year}${monthRaw}${dayRaw}`;
  return (
    text.includes(stayDate) ||
    text.includes(yyyymmdd) ||
    text.includes(`${year}年${month}月${day}日`) ||
    text.includes(`${month}月${day}日`)
  );
}

function propertyNameAppears(text: string, propertyName: string): boolean {
  const normalizedText = normalizeName(text);
  const normalizedName = normalizeName(propertyName);
  if (normalizedText.includes(normalizedName)) return true;
  if (propertyName === "ZAO BASE") return normalizedText.includes("zaobase");
  if (propertyName === "YuiLocalZao") return normalizedText.includes("yuilocalzao");
  return false;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s　・‐\-－ー]/gu, "");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim();
}

function normalizeHref(href: string): string {
  const decoded = href.replace(/&amp;/gu, "&").trim();
  const embedded = /(https?:)?\/\/hotel\.travel\.rakuten\.co\.jp\/hotelinfo\/plan\/\?[^"')\s<>]+/u.exec(decoded);
  if (embedded?.[0]) return embedded[0].startsWith("//") ? `https:${embedded[0]}` : embedded[0];
  if (decoded.startsWith("//")) return `https:${decoded}`;
  return decoded;
}

function toRakutenUrl(rawUrl: string): URL {
  const normalized = normalizeHref(rawUrl);
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return new URL(normalized);
  }
  return new URL(normalized, "https://hotel.travel.rakuten.co.jp");
}

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }
  return value;
}

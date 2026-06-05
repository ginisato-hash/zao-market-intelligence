/**
 * Rakuten source-coverage validation (Phase 52X).
 *
 * Read-only readiness check that takes the Rakuten candidate rows from the Zao
 * source-candidate review CSV, pairs each hotelNo with publicly observed page
 * metadata (page title, displayed property name, address excerpt), and decides
 * whether the property identity *likely* matches. It never marks anything
 * approved/confirmed, never collects prices, and never writes to the DB. The
 * recommended review decision is always `needs_change` so a human verifies the
 * exact property before any promotion.
 */
export { extractRakutenHotelNo } from "./enrichZaoMissingSourceCandidates";

export const RAKUTEN_COVERAGE_HEADERS = [
  "canonical_property_name",
  "hotel_no",
  "rakuten_url",
  "reachable",
  "page_title",
  "page_property_name",
  "address_excerpt",
  "identity_match_status",
  "risk_note",
  "recommended_review_decision"
] as const;

export type RakutenCoverageHeader = (typeof RAKUTEN_COVERAGE_HEADERS)[number];
export type RakutenCoverageRecord = Record<RakutenCoverageHeader, string>;

export type IdentityMatchStatus = "likely_match" | "needs_review" | "wrong_property" | "unreachable";

/** Recommended review decision is always human-review-only. Never approved/confirmed. */
export const RAKUTEN_RECOMMENDED_REVIEW_DECISION = "needs_change" as const;

export interface RakutenCoverageInput {
  canonicalPropertyName: string;
  hotelNo: string;
  rakutenUrl: string;
}

export interface RakutenPageObservation {
  hotelNo: string;
  reachable: boolean;
  pageTitle: string;
  pagePropertyName: string;
  addressExcerpt: string;
  /** Optional extra context appended to the generated risk note. */
  extraNote?: string;
}

/**
 * Normalize a property name for lenient comparison: NFKC folds full-width Latin
 * (ＪＵＲＩＮ→JURIN) and full-width spaces, then we drop whitespace and common
 * separators/brackets and lowercase. Japanese characters are preserved so a
 * genuine katakana variant (e.g. ロッヂ vs ロッジ) still fails to match and is
 * surfaced as needs_review rather than silently accepted.
 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-‐－―—_・,.、。「」『』()（）<>＜＞〈〉【】\[\]]/gu, "");
}

function looksLikeZaoOnsen(addressExcerpt: string): boolean {
  const normalized = addressExcerpt.normalize("NFKC");
  return normalized.includes("990-2301") || normalized.includes("蔵王温泉");
}

function nameLikelyMatches(canonicalPropertyName: string, pagePropertyName: string): boolean {
  const canonical = normalizeName(canonicalPropertyName);
  const page = normalizeName(pagePropertyName);
  if (canonical.length === 0 || page.length === 0) {
    return false;
  }
  return page.includes(canonical) || canonical.includes(page);
}

export function classifyIdentityMatch(
  canonicalPropertyName: string,
  observation: RakutenPageObservation
): IdentityMatchStatus {
  if (!observation.reachable) {
    return "unreachable";
  }
  if (!looksLikeZaoOnsen(observation.addressExcerpt)) {
    return "wrong_property";
  }
  return nameLikelyMatches(canonicalPropertyName, observation.pagePropertyName)
    ? "likely_match"
    : "needs_review";
}

function defaultRiskNote(status: IdentityMatchStatus): string {
  switch (status) {
    case "likely_match":
      return "Reachable Rakuten page; displayed name and Zao Onsen (990-2301) address are consistent with the canonical property. Human must still verify exact identity before approval.";
    case "needs_review":
      return "Reachable Zao Onsen page but displayed name differs from the canonical name (possible spelling/branding variant); human must verify identity.";
    case "wrong_property":
      return "Reachable page is outside Zao Onsen (990-2301); likely a different property. Do not use without human verification.";
    case "unreachable":
      return "Rakuten page did not return a valid hotel listing; cannot validate identity.";
  }
}

export function buildRakutenCoverageRows(
  inputs: RakutenCoverageInput[],
  observations: RakutenPageObservation[]
): RakutenCoverageRecord[] {
  const observationByHotelNo = new Map(observations.map((obs) => [obs.hotelNo, obs]));

  return inputs.map((input) => {
    const observation = observationByHotelNo.get(input.hotelNo);
    if (!observation) {
      return {
        canonical_property_name: input.canonicalPropertyName,
        hotel_no: input.hotelNo,
        rakuten_url: input.rakutenUrl,
        reachable: "false",
        page_title: "",
        page_property_name: "",
        address_excerpt: "",
        identity_match_status: "unreachable",
        risk_note: "No public page observation was captured for this hotelNo.",
        recommended_review_decision: RAKUTEN_RECOMMENDED_REVIEW_DECISION
      };
    }

    const status = classifyIdentityMatch(input.canonicalPropertyName, observation);
    const riskNote = observation.extraNote
      ? `${defaultRiskNote(status)} ${observation.extraNote}`
      : defaultRiskNote(status);

    return {
      canonical_property_name: input.canonicalPropertyName,
      hotel_no: input.hotelNo,
      rakuten_url: input.rakutenUrl,
      reachable: observation.reachable ? "true" : "false",
      page_title: observation.pageTitle,
      page_property_name: observation.pagePropertyName,
      address_excerpt: observation.addressExcerpt,
      identity_match_status: status,
      risk_note: riskNote,
      recommended_review_decision: RAKUTEN_RECOMMENDED_REVIEW_DECISION
    };
  });
}

export function renderRakutenCoverageCsv(rows: RakutenCoverageRecord[]): string {
  const header = RAKUTEN_COVERAGE_HEADERS.join(",");
  const body = rows.map((row) =>
    RAKUTEN_COVERAGE_HEADERS.map((key) => csvEscape(row[key] ?? "")).join(",")
  );
  return [header, ...body].join("\n") + "\n";
}

export interface RakutenMissingRow {
  canonicalPropertyName: string;
  searchNote: string;
}

export function renderRakutenCoverageReport(input: {
  generatedAt: string;
  inputCsvPath: string;
  csvPath: string;
  rows: RakutenCoverageRecord[];
  missingRows: RakutenMissingRow[];
}): string {
  const { rows } = input;
  const byStatus = (status: IdentityMatchStatus): RakutenCoverageRecord[] =>
    rows.filter((row) => row.identity_match_status === status);
  const likely = byStatus("likely_match");
  const needsReview = byStatus("needs_review");
  const wrong = byStatus("wrong_property");
  const unreachable = byStatus("unreachable");

  const lineFor = (row: RakutenCoverageRecord): string =>
    `- ${row.canonical_property_name} / ${row.hotel_no}: ${row.rakuten_url} — ${row.page_property_name} (${row.address_excerpt})`;

  return [
    "# Rakuten Coverage Validation Report",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## Summary",
    "",
    `- validated_hotelno_rows=${rows.length}`,
    `- likely_match=${likely.length}`,
    `- needs_review=${needsReview.length}`,
    `- wrong_property=${wrong.length}`,
    `- unreachable=${unreachable.length}`,
    `- remaining_rakuten_missing_rows=${input.missingRows.length}`,
    "- recommended_review_decision for every row: needs_change (no row approved/confirmed).",
    "",
    "## Inputs Used",
    "",
    `- input_csv=${input.inputCsvPath}`,
    `- output_csv=${input.csvPath}`,
    "- Validation method: opened public Rakuten travel.rakuten.co.jp/HOTEL/[hotelNo] pages and read page title, displayed name, and address.",
    "- No paid APIs, no SERP APIs, no proxy, no CAPTCHA bypass, no login cookies, no hidden APIs.",
    "- No price or availability collection; no DB writes.",
    "",
    "## Validated Rakuten hotelNo rows",
    "",
    ...rows.map(lineFor),
    "",
    "## Likely matches",
    "",
    ...(likely.length > 0 ? likely.map(lineFor) : ["- None"]),
    "",
    "## Needs review",
    "",
    ...(needsReview.length > 0
      ? needsReview.map((row) => `${lineFor(row)}\n  - ${row.risk_note}`)
      : ["- None"]),
    "",
    "## Unreachable / wrong property rows",
    "",
    ...(wrong.length + unreachable.length > 0
      ? [...wrong, ...unreachable].map((row) => `${lineFor(row)}\n  - ${row.risk_note}`)
      : ["- None"]),
    "",
    "## Remaining Rakuten missing rows",
    "",
    ...(input.missingRows.length > 0
      ? input.missingRows.map((row) => `- ${row.canonicalPropertyName}: ${row.searchNote}`)
      : ["- None"]),
    "",
    "## Collector readiness assessment",
    "",
    `- ${likely.length} of ${rows.length} Rakuten hotelNo candidates resolve to reachable Zao Onsen (990-2301) listings whose displayed name matches the canonical property.`,
    "- HotelNo → URL pattern (https://travel.rakuten.co.jp/HOTEL/[hotelNo]/) is stable and machine-extractable, so the IDs are sufficient to drive a Rakuten collector once a human confirms identity.",
    "- Blockers before enabling a Rakuten collector: (1) human confirmation of each likely_match identity, (2) resolution of needs_review name variants, (3) decision on the still-missing properties.",
    "- This phase did not collect any prices or availability and made no DB or PMS changes.",
    "",
    "## Next recommended step",
    "",
    "- Human reviewer opens each likely_match Rakuten URL, confirms the physical property identity, and resolves needs_review rows.",
    "- Only after identity sign-off should a separate, explicitly-approved step wire Rakuten in as the second read-only market data source after Jalan.",
    ""
  ].join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }
  return value;
}

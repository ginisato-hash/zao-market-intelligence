// Phase PD-FIX01X — Matsukaneya Duplicate Canonical Review / Merge Proposal.
//
// Pure, read-only proposal layer. The user has CONFIRMED that the two master
// canonical entries below are the SAME physical property:
//   - ホテル松金屋アネックス        (rakuten, hotelNo 5097)
//   - 松金や －MATSUKANEYA ANNEX－  (jalan, yad335940)
//
// This module produces a canonical-merge PROPOSAL / approval packet only. It
// MUTATES NOTHING. It NEVER executes the canonical merge, NEVER modifies the
// properties master, alias map, source candidates, or active-status flags,
// NEVER writes the DB, NEVER recomputes the Demand Index, NEVER live-fetches,
// NEVER re-runs a collector, NEVER enables GitHub Actions / GitOps / cron,
// NEVER commits or pushes, NEVER touches .data/history, and NEVER produces
// Beds24 / AirHost / PMS / OTA output. The real-merge approval gate stays
// CLOSED: the user confirmed same-property but did NOT approve a real master
// mutation.

// ---------------------------------------------------------------------------
// Confirmed duplicate group (user-confirmed same physical property)
// ---------------------------------------------------------------------------

export const CONFIRMED_DUPLICATE_GROUP_ID = "matsukaneya_annex_zao";
export const RETAIN_CANONICAL = "ホテル松金屋アネックス";
export const DEPRECATE_CANONICAL = "松金や －MATSUKANEYA ANNEX－";

// Aliases proposed to live under the retained canonical IF a future phase is
// approved. Listed here for the proposal only — NOT applied.
export const PROPOSED_ALIASES_FOR_RETAINED = [
  "松金や －MATSUKANEYA ANNEX－",
  "Matsukaneya Annex",
  "松金屋アネックス",
  "ホテル松金屋アネックス"
] as const;

// Master artifacts that a future approved phase (PD-FIX02X) would update.
export const FUTURE_TARGET_ARTIFACTS = [
  "zao_universe_properties_20260531_231933.csv",
  "zao_alias_map_20260531_231933.json",
  "zao_source_candidates_20260531_231933.csv",
  "zao_source_candidates_multi_source_enriched_20260601_074617.csv"
] as const;

// Verbatim sentence a future phase would require as explicit approval. Rendered
// in the report for reference only — NOT treated as an active approval here.
export const FUTURE_APPROVAL_SENTENCE =
  "Approve Phase PD-FIX02X Matsukaneya canonical merge. You may merge 松金や －MATSUKANEYA ANNEX－ into ホテル松金屋アネックス and update the approved master artifacts.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatsukaneyaDecision =
  | "matsukaneya_canonical_merge_proposal_ready"
  | "matsukaneya_canonical_merge_proposal_basis_caution"
  | "matsukaneya_canonical_merge_proposal_not_ready";

export type ProposedRole = "retain_canonical" | "deprecate_duplicate";

// One row of the read-only universe master (subset of columns used here).
export interface UniverseRow {
  canonicalPropertyName: string;
  canonicalizationStatus: string;
  aliases: string[];
  sourcesPresent: string[];
  jalanUrl: string;
  jalanId: string;
  rakutenUrl: string;
  rakutenId: string;
  evidenceNote: string;
}

// One row of the read-only source-candidate master (subset of columns used).
export interface SourceCandidateRow {
  canonicalPropertyName: string;
  source: string;
  candidatePropertyUrl: string;
  candidateSourcePropertyId: string;
  verificationStatus: string;
}

// The assembled confirmed-duplicate group (built by the script from artifacts).
export interface ConfirmedDuplicateGroup {
  groupId: string;
  userConfirmedSameProperty: boolean;
  retain: UniverseRow;
  deprecate: UniverseRow;
  retainCandidates: SourceCandidateRow[];
  deprecateCandidates: SourceCandidateRow[];
}

export interface ProposalContext {
  runId: string;
  generatedAtJst: string;
  debugArtifactPath: string;
}

export interface ProposalRow {
  runId: string;
  generatedAtJst: string;
  confirmedDuplicateGroupId: string;
  userConfirmedSamePhysicalProperty: boolean;
  candidateName: string;
  candidatePropertyId: string;
  canonicalName: string; // the RETAINED canonical for the whole group
  sourceNames: string;
  sourceUrls: string;
  rakutenHotelNo: string;
  jalanYadId: string;
  bookingSlug: string;
  googleHotelsId: string;
  address: string;
  evidenceType: string;
  evidenceValue: string;
  evidenceStrength: string;
  samePropertyStatus: string;
  proposedRole: ProposedRole;
  proposedAction: string;
  targetArtifactIfApproved: string;
  requiresExplicitApproval: boolean;
  realUpdateAllowed: boolean;
  reason: string;
  debugArtifactPath: string;
}

export const MATSUKANEYA_CSV_HEADERS = [
  "run_id",
  "generated_at_jst",
  "confirmed_duplicate_group_id",
  "user_confirmed_same_physical_property",
  "candidate_name",
  "candidate_property_id",
  "canonical_name",
  "source_names",
  "source_urls",
  "rakuten_hotel_no",
  "jalan_yad_id",
  "booking_slug",
  "google_hotels_id",
  "address",
  "evidence_type",
  "evidence_value",
  "evidence_strength",
  "same_property_status",
  "proposed_role",
  "proposed_action",
  "target_artifact_if_approved",
  "requires_explicit_approval",
  "real_update_allowed",
  "reason",
  "debug_artifact_path"
] as const;

// Columns that must NEVER appear in this proposal output (price-push / PMS).
export const FORBIDDEN_OUTPUT_COLUMN_TOKENS = [
  "roomid",
  "inventory",
  "minstay",
  "maxstay",
  "multiplier",
  "price1",
  "price2",
  "price3",
  "price4",
  "price5",
  "beds24",
  "airhost",
  "demand_index"
] as const;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface Evidence {
  evidenceType: string;
  evidenceValue: string;
  evidenceStrength: string;
  samePropertyStatus: string;
}

export function deriveEvidence(group: ConfirmedDuplicateGroup): Evidence {
  return {
    evidenceType: "name_match+shared_location+user_confirmation",
    evidenceValue:
      `Names ${group.retain.canonicalPropertyName} / ${group.deprecate.canonicalPropertyName} share the ` +
      `"松金屋 / 松金や / MATSUKANEYA ANNEX" identity; both records are located in 蔵王温泉; ` +
      `user confirmed they are the same physical property.`,
    // Strongest available basis: the user explicitly confirmed same-property.
    evidenceStrength: "user_confirmed",
    samePropertyStatus: "confirmed_same_property"
  };
}

// True only when a SINGLE source independently carries an identifier for BOTH
// records (i.e. the local artifacts can corroborate same-property without
// relying solely on the user's confirmation). Matsukaneya does NOT: the
// retained record is rakuten-only and the deprecated record is jalan-only, so
// the sources are complementary, not corroborating.
export function hasIndependentCrossSourceCorroboration(group: ConfirmedDuplicateGroup): boolean {
  const idsBySource = (row: UniverseRow): Set<string> => {
    const s = new Set<string>();
    if (row.rakutenId.trim() !== "") s.add("rakuten");
    if (row.jalanId.trim() !== "") s.add("jalan");
    return s;
  };
  const retainSources = idsBySource(group.retain);
  const deprecateSources = idsBySource(group.deprecate);
  for (const src of retainSources) {
    if (deprecateSources.has(src)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Proposal rows
// ---------------------------------------------------------------------------

function memberRow(input: {
  ctx: ProposalContext;
  group: ConfirmedDuplicateGroup;
  member: UniverseRow;
  role: ProposedRole;
  evidence: Evidence;
}): ProposalRow {
  const { ctx, group, member, role, evidence } = input;
  const isRetain = role === "retain_canonical";
  const candidatePropertyId = member.rakutenId.trim() || member.jalanId.trim() || "";
  const sourceUrls = [member.rakutenUrl, member.jalanUrl].filter((u) => u.trim() !== "").join(";");
  const proposedAction = isRetain
    ? "retain_as_primary_canonical_and_absorb_other_source_ids"
    : "merge_into_retained_canonical_and_mark_deprecated_alias_not_deleted";
  const reason = isRetain
    ? `Retain ${RETAIN_CANONICAL} as the primary canonical; it carries the rakuten identity (hotelNo ${member.rakutenId.trim() || "-"}).`
    : `Deprecate ${DEPRECATE_CANONICAL} into ${RETAIN_CANONICAL}; preserve its jalan identity (yad ${member.jalanId.trim() || "-"}) on the retained canonical. Record is marked duplicate/deprecated, NOT deleted.`;

  return {
    runId: ctx.runId,
    generatedAtJst: ctx.generatedAtJst,
    confirmedDuplicateGroupId: group.groupId,
    userConfirmedSamePhysicalProperty: group.userConfirmedSameProperty,
    candidateName: member.canonicalPropertyName,
    candidatePropertyId,
    canonicalName: RETAIN_CANONICAL,
    sourceNames: member.sourcesPresent.join(";"),
    sourceUrls,
    rakutenHotelNo: member.rakutenId.trim(),
    jalanYadId: member.jalanId.trim(),
    bookingSlug: "",
    googleHotelsId: "",
    address: "蔵王温泉",
    evidenceType: evidence.evidenceType,
    evidenceValue: evidence.evidenceValue,
    evidenceStrength: evidence.evidenceStrength,
    samePropertyStatus: evidence.samePropertyStatus,
    proposedRole: role,
    proposedAction,
    targetArtifactIfApproved: FUTURE_TARGET_ARTIFACTS.join(";"),
    requiresExplicitApproval: true,
    realUpdateAllowed: false,
    reason,
    debugArtifactPath: ctx.debugArtifactPath
  };
}

export function buildProposalRows(group: ConfirmedDuplicateGroup, ctx: ProposalContext): ProposalRow[] {
  const evidence = deriveEvidence(group);
  return [
    memberRow({ ctx, group, member: group.retain, role: "retain_canonical", evidence }),
    memberRow({ ctx, group, member: group.deprecate, role: "deprecate_duplicate", evidence })
  ];
}

// ---------------------------------------------------------------------------
// Proposed future merge plan (NOT executed)
// ---------------------------------------------------------------------------

export interface SourceCandidateRepoint {
  fromCanonical: string;
  toCanonical: string;
  source: string;
  candidateUrl: string;
  candidateId: string;
  verificationStatus: string;
}

export interface MergePlan {
  groupId: string;
  retainCanonical: string;
  deprecateCanonical: string;
  proposedAliasesForRetained: string[];
  preservedSourceIds: {
    rakutenHotelNo: string;
    jalanYadId: string;
    bookingSlug: string;
    googleHotelsId: string;
  };
  sourceCandidateRepoint: SourceCandidateRepoint[];
  deprecatedRecordDisposition: string;
  targetArtifactsIfApproved: string[];
}

export function buildMergePlan(group: ConfirmedDuplicateGroup): MergePlan {
  // Union of existing aliases + proposed new aliases (deduped, NFKC-stable).
  const aliasSet = new Set<string>();
  for (const a of group.retain.aliases) aliasSet.add(a);
  for (const a of group.deprecate.aliases) aliasSet.add(a);
  for (const a of PROPOSED_ALIASES_FOR_RETAINED) aliasSet.add(a);
  // The retained canonical name itself need not appear as its own alias.
  aliasSet.delete(RETAIN_CANONICAL);

  const repoint = (rows: SourceCandidateRow[], from: string): SourceCandidateRepoint[] =>
    rows
      .filter((r) => r.candidateSourcePropertyId.trim() !== "" || r.candidatePropertyUrl.trim() !== "")
      .map((r) => ({
        fromCanonical: from,
        toCanonical: RETAIN_CANONICAL,
        source: r.source,
        candidateUrl: r.candidatePropertyUrl,
        candidateId: r.candidateSourcePropertyId,
        verificationStatus: r.verificationStatus
      }));

  return {
    groupId: group.groupId,
    retainCanonical: RETAIN_CANONICAL,
    deprecateCanonical: DEPRECATE_CANONICAL,
    proposedAliasesForRetained: [...aliasSet],
    preservedSourceIds: {
      rakutenHotelNo: group.retain.rakutenId.trim() || group.deprecate.rakutenId.trim(),
      jalanYadId: group.deprecate.jalanId.trim() || group.retain.jalanId.trim(),
      bookingSlug: "",
      googleHotelsId: ""
    },
    sourceCandidateRepoint: [
      ...repoint(group.retainCandidates, RETAIN_CANONICAL),
      ...repoint(group.deprecateCandidates, DEPRECATE_CANONICAL)
    ],
    deprecatedRecordDisposition: "marked_duplicate_deprecated_not_deleted",
    targetArtifactsIfApproved: [...FUTURE_TARGET_ARTIFACTS]
  };
}

// ---------------------------------------------------------------------------
// Approval gate (ALWAYS closed in PD-FIX01X)
// ---------------------------------------------------------------------------

export interface ApprovalGate {
  explicitUserApprovedForRealMerge: boolean;
  realUpdateAllowed: boolean;
  requiresExplicitApproval: boolean;
  gateState: "closed";
  futureApprovalSentence: string;
}

export function buildApprovalGate(): ApprovalGate {
  return {
    explicitUserApprovedForRealMerge: false,
    realUpdateAllowed: false,
    requiresExplicitApproval: true,
    gateState: "closed",
    futureApprovalSentence: FUTURE_APPROVAL_SENTENCE
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideMatsukaneya(input: {
  proposalRowCount: number;
  userConfirmedSameProperty: boolean;
  hasIndependentCrossSourceCorroboration: boolean;
}): MatsukaneyaDecision {
  if (input.proposalRowCount === 0 || !input.userConfirmedSameProperty) {
    return "matsukaneya_canonical_merge_proposal_not_ready";
  }
  // Same-property is user-confirmed, but the local artifacts cannot
  // independently corroborate it (rakuten-only vs jalan-only). Flag caution.
  if (!input.hasIndependentCrossSourceCorroboration) {
    return "matsukaneya_canonical_merge_proposal_basis_caution";
  }
  return "matsukaneya_canonical_merge_proposal_ready";
}

// ---------------------------------------------------------------------------
// Summary + rendering
// ---------------------------------------------------------------------------

export interface ProposalSummary {
  runId: string;
  generatedAt: string;
  groupId: string;
  userConfirmedSameProperty: boolean;
  sourceArtifacts: string[];
  proposalRowCount: number;
  retainCanonical: string;
  deprecateCanonical: string;
  decision: MatsukaneyaDecision;
  gate: ApprovalGate;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function countBy<T>(values: T[], key: (v: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const k = key(v);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function renderProposalCsv(rows: ProposalRow[]): string {
  const body = rows.map((r) =>
    [
      r.runId,
      r.generatedAtJst,
      r.confirmedDuplicateGroupId,
      bool(r.userConfirmedSamePhysicalProperty),
      r.candidateName,
      r.candidatePropertyId,
      r.canonicalName,
      r.sourceNames,
      r.sourceUrls,
      r.rakutenHotelNo,
      r.jalanYadId,
      r.bookingSlug,
      r.googleHotelsId,
      r.address,
      r.evidenceType,
      r.evidenceValue,
      r.evidenceStrength,
      r.samePropertyStatus,
      r.proposedRole,
      r.proposedAction,
      r.targetArtifactIfApproved,
      bool(r.requiresExplicitApproval),
      bool(r.realUpdateAllowed),
      r.reason,
      r.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [MATSUKANEYA_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderProposalReport(input: {
  summary: ProposalSummary;
  rows: ProposalRow[];
  plan: MergePlan;
}): string {
  const { summary, rows, plan } = input;
  const retainRow = rows.find((r) => r.proposedRole === "retain_canonical");
  const deprecateRow = rows.find((r) => r.proposedRole === "deprecate_duplicate");

  return [
    "# Matsukaneya Duplicate Canonical Review / Merge Proposal (Phase PD-FIX01X)",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${summary.decision}`,
    `- confirmed_duplicate_group_id=${summary.groupId}`,
    `- user_confirmed_same_physical_property=${bool(summary.userConfirmedSameProperty)}`,
    `- retain_canonical=${summary.retainCanonical}`,
    `- deprecate_canonical=${summary.deprecateCanonical}`,
    `- proposal_row_count=${summary.proposalRowCount}`,
    `- real_update_allowed=${bool(summary.gate.realUpdateAllowed)} (approval gate CLOSED)`,
    "- This is a PROPOSAL / approval packet only. No master artifact was changed.",
    "",
    "## 2. User-confirmed Duplicate Group",
    "",
    "The user confirmed these are confirmed duplicate canonical entries for the SAME physical property:",
    `- RETAIN: ${summary.retainCanonical} (rakuten hotelNo ${retainRow?.rakutenHotelNo || "-"})`,
    `- DEPRECATE: ${summary.deprecateCanonical} (jalan yad ${deprecateRow?.jalanYadId || "-"})`,
    "- same_property_status=confirmed_same_property (NOT suspected).",
    "",
    "## 3. Local Artifact Evidence",
    "",
    ...rows.map(
      (r) =>
        `- ${r.candidateName} | sources=${r.sourceNames || "-"} | urls=${r.sourceUrls || "-"} | ` +
        `evidence=${r.evidenceType} | strength=${r.evidenceStrength}`
    ),
    `- evidence_detail: ${retainRow?.evidenceValue ?? ""}`,
    "",
    "## 4. Current Master Impact",
    "",
    "- No master artifact was modified by PD-FIX01X (read-only).",
    `- Both records currently have canonicalization_status=needs_review.`,
    `- retain currently carries: rakuten hotelNo ${retainRow?.rakutenHotelNo || "-"}, jalan yad ${retainRow?.jalanYadId || "-"}.`,
    `- deprecate currently carries: rakuten hotelNo ${deprecateRow?.rakutenHotelNo || "-"}, jalan yad ${deprecateRow?.jalanYadId || "-"}.`,
    "",
    "## 5. Proposed Future Merge Plan (NOT executed)",
    "",
    `- Retain canonical: ${plan.retainCanonical}`,
    `- Deprecate/merge canonical: ${plan.deprecateCanonical} (${plan.deprecatedRecordDisposition})`,
    `- Preserve rakuten hotelNo: ${plan.preservedSourceIds.rakutenHotelNo || "-"}`,
    `- Preserve jalan yad id: ${plan.preservedSourceIds.jalanYadId || "-"}`,
    `- Preserve booking slug: ${plan.preservedSourceIds.bookingSlug || "-"}`,
    `- Preserve google_hotels id: ${plan.preservedSourceIds.googleHotelsId || "-"}`,
    `- Proposed aliases on retained canonical: ${plan.proposedAliasesForRetained.join(" | ")}`,
    ...plan.sourceCandidateRepoint.map(
      (rp) => `- Source candidate repoint: ${rp.source} ${rp.candidateId || rp.candidateUrl} → ${rp.toCanonical}`
    ),
    "",
    "## 6. Target Artifacts If Approved",
    "",
    ...plan.targetArtifactsIfApproved.map((a) => `- ${a}`),
    "",
    "## 7. Risks",
    "",
    "- The two records are complementary (rakuten-only vs jalan-only); the local artifacts cannot independently corroborate same-property beyond the user's confirmation.",
    "- Both records are still canonicalization_status=needs_review.",
    "- Merging without the explicit future approval would mutate the master; that is deliberately NOT done here.",
    "",
    "## 8. Safety Confirmation",
    "",
    "- PD-FIX01X did not modify the properties master or any master artifact.",
    "- PD-FIX01X did not execute the canonical merge.",
    "- PD-FIX01X did not add, modify, or delete aliases, source candidates, or active-status flags.",
    "- PD-FIX01X did not write the DB or recompute the Demand Index.",
    "- PD-FIX01X did not live-fetch external pages or re-run any collector.",
    "- PD-FIX01X did not enable GitHub Actions / GitOps / cron, and did not commit or push.",
    "- PD-FIX01X did not contact paid sources or produce Beds24 / AirHost / PMS / OTA output.",
    "",
    "## 9. Next Steps",
    "",
    "- This packet is for human review only. The real-merge approval gate is CLOSED (real_update_allowed=false).",
    "- To authorize a future real merge, reply with the explicit approval sentence below (this packet does NOT treat it as already approved):",
    `  > ${summary.gate.futureApprovalSentence}`,
    `- report_path=${summary.reportPath}`,
    `- csv_path=${summary.csvPath}`,
    `- json_summary_path=${summary.jsonPath}`,
    `- debug_artifact_path=${summary.debugRootPath}`,
    ""
  ].join("\n");
}

export function assertNoForbiddenColumns(headerLine: string): void {
  const lower = headerLine.toLowerCase();
  for (const token of FORBIDDEN_OUTPUT_COLUMN_TOKENS) {
    if (lower.includes(token)) {
      throw new Error(`PD-FIX01X output must not include forbidden column token: ${token}`);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

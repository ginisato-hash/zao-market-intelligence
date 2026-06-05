// Phase JALAN-AUTO02X - Jalan target matrix and bounded collection proposal.
//
// Pure planning helpers only. This module does not fetch Jalan, launch a
// browser, append history, write DB rows, sync DB, refresh AI context, or
// generate pricing/PMS output.

export type JalanTargetMatrixDecision =
  | "jalan_target_matrix_proposal_ready"
  | "jalan_target_matrix_proposal_basis_caution"
  | "jalan_target_matrix_proposal_not_ready";

export type TargetTier = "tier_1" | "tier_2";
export type JalanEvidenceConfidence = "verified" | "candidate" | "missing" | "needs_manual_review";

export interface LocalEvidenceFile {
  file_path: string;
  source_text: string;
}

export interface JalanTargetProperty {
  canonical_property_name: string;
  tier: TargetTier;
  aliases: string[];
}

export interface LocalJalanEvidence {
  canonical_property_name: string;
  evidence_property_name: string;
  jalan_source_url: string | null;
  jalan_property_id: string | null;
  local_evidence_path: string;
  confidence: JalanEvidenceConfidence;
  evidence_note: string;
}

export interface TargetPropertyMatrixRow {
  canonical_property_name: string;
  tier: TargetTier;
  jalan_source_url: string | null;
  jalan_property_id: string | null;
  local_evidence_path: string | null;
  confidence: JalanEvidenceConfidence;
  recommended_for_auto03x: boolean;
  reason: string;
}

export interface DateWindowRow {
  date: string;
  category: "near_term_saturday" | "peak_holiday";
  purpose: string;
  recommended_for_auto03x: boolean;
}

export interface Auto03xBoundedTarget {
  canonical_property_name: string;
  tier: TargetTier;
  jalan_source_url: string;
  jalan_property_id: string;
  dates: string[];
  page_count: number;
}

export interface PageCapPlan {
  max_properties: number;
  max_dates_per_property: number;
  max_pages: number;
  proposed_properties: number;
  proposed_dates_per_property: number;
  proposed_pages: number;
  cap_respected: boolean;
}

export interface DirectDirectionalExcludedPolicy {
  direct_allowed_only_when: string[];
  directional_when: string[];
  excluded_when: string[];
  weak_rows_rule: string;
  unattended_pricing_rule: string;
}

export interface EvidenceRequirements {
  required_fields: string[];
  screenshot_rule: string;
  confidence_rules: Record<"A" | "B" | "C", string>;
}

export interface BotRiskSafetyRules {
  rules: string[];
  blocked_or_unstable_policy: string[];
}

export interface FuturePhase {
  phase: string;
  objective: string;
  allowed_actions: string[];
  forbidden_actions: string[];
  expected_outputs: string[];
  approval_gate: string;
  success_criteria: string[];
}

export interface SafetyConfirmation {
  live_jalan_collection: false;
  external_fetch: false;
  playwright_or_browser_automation: false;
  broad_ota_collection: false;
  history_append: false;
  history_modification: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  pricing_csv_generation: false;
  github_actions_cron_gitops: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  started_auto03x: false;
}

export interface JalanTargetMatrixProposal {
  run_id: string;
  generated_at_jst: string;
  decision: JalanTargetMatrixDecision;
  source_auto01x_summary: Record<string, unknown>;
  local_jalan_evidence_inventory: LocalJalanEvidence[];
  target_property_matrix: TargetPropertyMatrixRow[];
  manual_review_properties: TargetPropertyMatrixRow[];
  date_window_matrix: DateWindowRow[];
  auto03x_bounded_matrix: Auto03xBoundedTarget[];
  page_cap_plan: PageCapPlan;
  direct_directional_excluded_policy: DirectDirectionalExcludedPolicy;
  evidence_requirements: EvidenceRequirements;
  bot_risk_safety_rules: BotRiskSafetyRules;
  future_phase_plan: FuturePhase[];
  risks: string[];
  safety_confirmation: SafetyConfirmation;
  next_phase: string;
}

export const TARGET_PROPERTIES: JalanTargetProperty[] = [
  { canonical_property_name: "シバママのお宿", tier: "tier_1", aliases: ["シバママのお宿", "shibamama"] },
  { canonical_property_name: "ロッジスガノ", tier: "tier_1", aliases: ["ロッジスガノ", "ロッヂスガノ", "sugano"] },
  { canonical_property_name: "松尾ハウス", tier: "tier_1", aliases: ["松尾ハウス", "matsuo"] },
  { canonical_property_name: "ぼくのうち", tier: "tier_1", aliases: ["ぼくのうち", "bokunouchi"] },
  { canonical_property_name: "ホテル喜らく", tier: "tier_1", aliases: ["ホテル喜らく", "ホテル　喜らく", "喜らく", "kiraku"] },
  { canonical_property_name: "ル・ベール蔵王", tier: "tier_1", aliases: ["ル・ベール蔵王", "le_vert_zao", "levert"] },
  { canonical_property_name: "HAMMOND", tier: "tier_1", aliases: ["HAMMOND", "BED’n ONSEN HAMMOND", "BED'n ONSEN HAMMOND", "ハモンド", "hammond"] },
  { canonical_property_name: "OAKHILL", tier: "tier_1", aliases: ["OAKHILL", "ONSEN & STAY OAKHILL", "オークヒル", "oakhill"] },
  { canonical_property_name: "吉田屋", tier: "tier_1", aliases: ["吉田屋", "yoshidaya"] },
  { canonical_property_name: "JURIN", tier: "tier_2", aliases: ["JURIN", "jurin"] },
  { canonical_property_name: "ルーセント", tier: "tier_2", aliases: ["ルーセント", "名湯リゾート ルーセント", "ルーセントタカミヤ", "lucent"] },
  { canonical_property_name: "瑠璃倶楽", tier: "tier_2", aliases: ["瑠璃倶楽", "たかみや瑠璃倶楽", "ruri"] },
  { canonical_property_name: "名湯舎 創", tier: "tier_2", aliases: ["名湯舎 創", "名湯舎　創", "MEITOYA", "meitousha", "sou"] },
  { canonical_property_name: "深山荘 高見屋", tier: "tier_2", aliases: ["深山荘 高見屋", "深山荘", "MIYAMASO", "miyamaso", "takamiya"] }
];

export function buildLocalJalanEvidenceInventory(files: readonly LocalEvidenceFile[]): LocalJalanEvidence[] {
  const rows: LocalJalanEvidence[] = [];
  for (const file of files) {
    const parsedRows = parseEvidenceRows(file);
    for (const parsed of parsedRows) {
      const target = matchTarget(parsed.evidence_property_name);
      if (target === undefined) continue;
      rows.push({
        canonical_property_name: target.canonical_property_name,
        evidence_property_name: parsed.evidence_property_name,
        jalan_source_url: parsed.jalan_source_url,
        jalan_property_id: parsed.jalan_property_id,
        local_evidence_path: file.file_path,
        confidence: parsed.confidence,
        evidence_note: parsed.evidence_note
      });
    }
  }
  return dedupeEvidence(rows).sort((a, b) => {
    const targetOrder = targetIndex(a.canonical_property_name) - targetIndex(b.canonical_property_name);
    if (targetOrder !== 0) return targetOrder;
    return confidenceRank(a.confidence) - confidenceRank(b.confidence);
  });
}

function parseEvidenceRows(file: LocalEvidenceFile): LocalJalanEvidence[] {
  const jsonRows = parseJsonEvidenceRows(file);
  if (jsonRows.length > 0) return jsonRows;
  const text = file.source_text;
  const out: LocalJalanEvidence[] = [];
  for (const target of TARGET_PROPERTIES) {
    if (!target.aliases.some((alias) => includesLoose(text, alias) || includesLoose(file.file_path, alias))) continue;
    const url = extractJalanUrl(text);
    out.push({
      canonical_property_name: target.canonical_property_name,
      evidence_property_name: target.canonical_property_name,
      jalan_source_url: url,
      jalan_property_id: extractJalanPropertyId(url ?? text),
      local_evidence_path: file.file_path,
      confidence: url === null ? "needs_manual_review" : "candidate",
      evidence_note: url === null ? "Local text mentions property but no Jalan URL/ID is present." : "Local text contains a Jalan URL candidate."
    });
  }
  return out;
}

function parseJsonEvidenceRows(file: LocalEvidenceFile): LocalJalanEvidence[] {
  try {
    const parsed = JSON.parse(file.source_text) as unknown;
    const objects = flattenObjects(parsed);
    return objects
      .map((obj) => objectToEvidence(obj, file.file_path))
      .filter((row): row is LocalJalanEvidence => row !== null);
  } catch {
    return [];
  }
}

function objectToEvidence(obj: Record<string, unknown>, filePath: string): LocalJalanEvidence | null {
  const rawSource = stringField(obj, "source") ?? stringField(obj, "ota");
  const directUrlCandidates = [
    stringField(obj, "property_url"),
    stringField(obj, "propertyUrl"),
    stringField(obj, "candidate_property_url"),
    stringField(obj, "detectedUrl")
  ];
  const directJalanUrl = directUrlCandidates.find((value) => value !== null && /jalan\.net\/yad\d+/u.test(value)) ?? null;
  const hasJalanUrl = directJalanUrl !== null;
  if (rawSource !== null && !/jalan/iu.test(rawSource) && !hasJalanUrl) return null;
  const name =
    stringField(obj, "property_name") ??
    stringField(obj, "canonical_property_name") ??
    stringField(obj, "propertyNameRaw") ??
    stringField(obj, "propertyNameNormalized") ??
    stringField(obj, "detectedName") ??
    stringField(obj, "detectedNameRaw") ??
    stringField(obj, "facilityName");
  const target = matchTarget(name ?? JSON.stringify(obj));
  if (target === undefined) return null;
  const url = directJalanUrl;
  const id =
    stringField(obj, "source_property_id") ??
    stringField(obj, "candidate_source_property_id") ??
    stringField(obj, "yadNo") ??
    extractJalanPropertyId(url ?? "");
  const status =
    stringField(obj, "verification_status") ??
    stringField(obj, "coverage_status") ??
    stringField(obj, "access_status") ??
    "";
  const evidenceNote = stringField(obj, "evidence_note") ?? stringField(obj, "notes") ?? stringField(obj, "evidenceNote") ?? `Local Jalan evidence from ${filePath}.`;
  return {
    canonical_property_name: target.canonical_property_name,
    evidence_property_name: name ?? target.canonical_property_name,
    jalan_source_url: url,
    jalan_property_id: normalizeJalanId(id),
    local_evidence_path: filePath,
    confidence: classifyEvidenceConfidence({ status, url, id }),
    evidence_note: evidenceNote
  };
}

export function buildTargetPropertyMatrix(
  evidenceInventory: readonly LocalJalanEvidence[],
  targets: readonly JalanTargetProperty[] = TARGET_PROPERTIES
): TargetPropertyMatrixRow[] {
  const selectedNames = new Set(selectAuto03xTargets(evidenceInventory, targets).map((row) => row.canonical_property_name));
  return targets.map((target) => {
    const evidence = bestEvidenceFor(target.canonical_property_name, evidenceInventory);
    const hasVerified = evidence?.confidence === "verified" && evidence.jalan_source_url !== null && evidence.jalan_property_id !== null;
    const confidence: JalanEvidenceConfidence = evidence?.confidence ?? "missing";
    const recommended = selectedNames.has(target.canonical_property_name);
    const reason = hasVerified && recommended
      ? "Verified local Jalan URL/ID exists; selected for the first bounded AUTO03X matrix."
      : hasVerified
        ? "Verified local Jalan URL/ID exists, but this property is outside the first AUTO03X page cap."
      : confidence === "candidate"
        ? "Only candidate Jalan URL/ID evidence exists; manual property identity review required before live collection."
        : confidence === "needs_manual_review"
          ? "Local evidence exists but lacks a verified Jalan URL/ID."
          : "No local Jalan URL/ID evidence found; do not include in AUTO03X live matrix.";
    return {
      canonical_property_name: target.canonical_property_name,
      tier: target.tier,
      jalan_source_url: evidence?.jalan_source_url ?? null,
      jalan_property_id: evidence?.jalan_property_id ?? null,
      local_evidence_path: evidence?.local_evidence_path ?? null,
      confidence,
      recommended_for_auto03x: recommended,
      reason
    };
  });
}

export function buildManualReviewProperties(matrix: readonly TargetPropertyMatrixRow[]): TargetPropertyMatrixRow[] {
  return matrix.filter((row) => row.confidence !== "verified");
}

export function buildDateWindowMatrix(): DateWindowRow[] {
  const nearTerm = ["2026-06-06", "2026-06-13", "2026-06-20"].map((date, index) => ({
    date,
    category: "near_term_saturday" as const,
    purpose: "near-term Saturday domestic demand and price movement",
    recommended_for_auto03x: index < 2
  }));
  const peakDates = [
    "2026-07-18",
    "2026-07-19",
    "2026-07-20",
    "2026-08-08",
    "2026-08-12",
    "2026-08-15",
    "2026-09-19",
    "2026-09-20",
    "2026-09-21",
    "2026-10-10",
    "2026-10-11",
    "2026-11-21",
    "2026-12-05",
    "2026-12-12"
  ];
  const selectedPeak = new Set(["2026-07-18", "2026-08-08", "2026-10-10"]);
  return [
    ...nearTerm,
    ...peakDates.map((date) => ({
      date,
      category: "peak_holiday" as const,
      purpose: purposeForPeakDate(date),
      recommended_for_auto03x: selectedPeak.has(date)
    }))
  ];
}

export function buildAuto03xBoundedMatrix(matrix: readonly TargetPropertyMatrixRow[], dateWindow: readonly DateWindowRow[]): Auto03xBoundedTarget[] {
  const dates = dateWindow.filter((row) => row.recommended_for_auto03x).slice(0, 5).map((row) => row.date);
  return matrix
    .filter((row) => row.recommended_for_auto03x && row.jalan_source_url !== null && row.jalan_property_id !== null)
    .slice(0, 5)
    .map((row) => ({
      canonical_property_name: row.canonical_property_name,
      tier: row.tier,
      jalan_source_url: row.jalan_source_url as string,
      jalan_property_id: row.jalan_property_id as string,
      dates,
      page_count: dates.length
    }));
}

export function buildPageCapPlan(auto03xBoundedMatrix: readonly Auto03xBoundedTarget[]): PageCapPlan {
  const proposedProperties = auto03xBoundedMatrix.length;
  const proposedDatesPerProperty = Math.max(0, ...auto03xBoundedMatrix.map((row) => row.dates.length));
  const proposedPages = auto03xBoundedMatrix.reduce((sum, row) => sum + row.page_count, 0);
  return {
    max_properties: 5,
    max_dates_per_property: 5,
    max_pages: 25,
    proposed_properties: proposedProperties,
    proposed_dates_per_property: proposedDatesPerProperty,
    proposed_pages: proposedPages,
    cap_respected: proposedProperties <= 5 && proposedDatesPerProperty <= 5 && proposedPages <= 25
  };
}

export function buildDirectDirectionalExcludedPolicy(): DirectDirectionalExcludedPolicy {
  return {
    direct_allowed_only_when: [
      "source confidence is A",
      "price basis is tax included total",
      "stay scope is 2 adults / 1 room / 1 night",
      "date condition is confirmed",
      "property identity is confirmed",
      "coupon/member/point/suspicious discounts are excluded",
      "meal condition is captured or clearly absent",
      "screenshot/evidence path exists"
    ],
    directional_when: [
      "property/date/price are useful but one direct-safety requirement is uncertain",
      "source confidence is B",
      "screenshot exists but structured tax/meal/scope evidence is incomplete"
    ],
    excluded_when: [
      "blocked",
      "not_found",
      "not_listed",
      "sold_out with no price",
      "coupon-only price",
      "member-only price",
      "suspicious price",
      "date not confirmed",
      "room scope not confirmed",
      "price element missing"
    ],
    weak_rows_rule: "Weak Jalan rows must remain directional or excluded; do not promote weak rows to direct.",
    unattended_pricing_rule: "No Jalan row may drive unattended PMS/Beds24/AirHost updates without explicit later approval and direct-evidence validation."
  };
}

export function buildEvidenceRequirements(): EvidenceRequirements {
  return {
    required_fields: [
      "checked_at",
      "collected_date_jst",
      "collected_at_jst",
      "source",
      "canonical_property_name",
      "source_property_name",
      "source_property_id or source_slug_or_code",
      "source_url",
      "checkin",
      "checkout",
      "stay_nights",
      "group_adults",
      "no_rooms",
      "group_children",
      "currency",
      "language",
      "stay_scope",
      "room_or_plan_name",
      "meal_condition",
      "availability_status",
      "normalized_total_price",
      "normalized_total_price_source",
      "normalized_total_price_basis",
      "basis_confidence",
      "dp_usage",
      "classification",
      "exclusion_reason",
      "warning_flags",
      "source_report_path",
      "source_csv_path",
      "debug_artifact_path",
      "screenshot_path",
      "schema_version"
    ],
    screenshot_rule: "No screenshot / visual evidence => cannot be B-confidence or direct.",
    confidence_rules: {
      A: "Requires structured confirmation of property identity, date, 2-adult/1-room/1-night scope, tax-included total, meal condition, and exclusion of coupon/member/suspicious prices.",
      B: "Requires screenshot/visual evidence and useful price pressure evidence, but at least one direct-safety field remains uncertain.",
      C: "Use for blocked, missing, disqualified, or unclear rows; excluded from price pressure."
    }
  };
}

export function buildBotRiskSafetyRules(): BotRiskSafetyRules {
  return {
    rules: [
      "Use fixed known property URLs only.",
      "Avoid search result pagination where possible.",
      "Avoid broad area search scraping.",
      "Cap pages <= 25.",
      "Save screenshots.",
      "Retry at most once per target.",
      "Record failure rows rather than filling values.",
      "Avoid aggressive parallelism.",
      "Do not use stealth, CAPTCHA bypass, login/cookies, paid proxies, or paid APIs."
    ],
    blocked_or_unstable_policy: [
      "availability_status = failed",
      "basis_confidence = C",
      "dp_usage = excluded",
      "error_reason = block / captcha / date_not_confirmed / price_missing / unknown"
    ]
  };
}

export function buildFuturePhasePlan(): FuturePhase[] {
  return [
    {
      phase: "JALAN-AUTO03X",
      objective: "Run a bounded Jalan collection probe and produce preview rows only.",
      allowed_actions: ["Fetch/render only approved fixed Jalan property/date pages", "Save screenshots/debug artifacts", "Create preview rows and report artifacts"],
      forbidden_actions: ["No history append", "No DB write", "No AI context refresh", "No pricing/PMS output"],
      expected_outputs: ["bounded collection report", "normalized preview rows", "screenshot/debug evidence"],
      approval_gate: "No write approval required; live scope must be exactly the AUTO02X-approved matrix.",
      success_criteria: ["pages <= 25", "fixed URLs only", "preview rows classified as direct/directional/excluded"]
    },
    {
      phase: "JALAN-AUTO04X",
      objective: "Create a Jalan history append proposal from AUTO03X preview rows.",
      allowed_actions: ["Read preview rows", "Compare row_id/row_hash against history in memory", "Generate append proposal"],
      forbidden_actions: ["No history append", "No DB write", "No live fetch"],
      expected_outputs: ["append proposal report", "dedupe/conflict summary", "touched shard plan"],
      approval_gate: "Proposal only; no real write approval active.",
      success_criteria: ["append/skip/conflict decisions are explicit", "no weak rows promoted to direct"]
    },
    {
      phase: "JALAN-AUTO05X",
      objective: "Approved guarded Jalan history append.",
      allowed_actions: ["Back up touched shards", "Append approved rows", "Validate and rollback on failure"],
      forbidden_actions: ["No DB sync", "No AI context refresh", "No pricing/PMS output"],
      expected_outputs: ["real append report", "backup paths", "post-append validation"],
      approval_gate: "Requires exact user approval sentence and a future env flag such as JALAN_HISTORY_APPEND=1.",
      success_criteria: ["only approved rows appended", "history row counts and row_hashes validate"]
    },
    {
      phase: "JALAN-AUTO05B",
      objective: "DB mirror sync plus AI context refresh after approved append.",
      allowed_actions: ["Run dry-run sync", "Run approved DB sync", "Rebuild AI context", "Run query smoke checks"],
      forbidden_actions: ["No live collection", "No history mutation", "No PMS/OTA output"],
      expected_outputs: ["DB sync report", "AI context refresh report", "query smoke summary"],
      approval_gate: "Requires explicit approval for DB sync and existing sync env flag.",
      success_criteria: ["DB/context row counts match cleaned history", "Jalan rows visible in pricing_support context"]
    },
    {
      phase: "JALAN-AUTO06X",
      objective: "Verify Jalan price-pressure usability in market_report and pricing_support.",
      allowed_actions: ["Read DB/context", "Run read-only query recipes", "Generate usability report"],
      forbidden_actions: ["No data writes", "No live collection", "No price update output"],
      expected_outputs: ["usability report", "direct/directional/excluded validation"],
      approval_gate: "Read-only; approval optional unless scope changes.",
      success_criteria: ["direct rows justified", "B/C rows not promoted", "pricing_support caveats are clear"]
    }
  ];
}

export function buildRisks(): string[] {
  return [
    "Several priority Tier 1 properties still lack verified Jalan URL/ID evidence and must stay out of AUTO03X.",
    "Existing Jalan rows are market_aggregate only; property-level identity must be revalidated before broader automation.",
    "Meal condition and coupon/member/suspicious price guards are direct-safety gaps.",
    "Future live collection can encounter block/CAPTCHA/unstable DOM states; record failures instead of bypassing."
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    live_jalan_collection: false,
    external_fetch: false,
    playwright_or_browser_automation: false,
    broad_ota_collection: false,
    history_append: false,
    history_modification: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    pricing_csv_generation: false,
    github_actions_cron_gitops: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    started_auto03x: false
  };
}

export function decideJalanTargetMatrixProposal(input: {
  targetPropertyMatrix: readonly TargetPropertyMatrixRow[];
  pageCapPlan: PageCapPlan;
}): JalanTargetMatrixDecision {
  if (!input.pageCapPlan.cap_respected) return "jalan_target_matrix_proposal_not_ready";
  const verified = input.targetPropertyMatrix.filter((row) => row.confidence === "verified").length;
  const proposed = input.targetPropertyMatrix.filter((row) => row.recommended_for_auto03x).length;
  if (proposed === 0 || verified === 0) return "jalan_target_matrix_proposal_not_ready";
  const manualReview = input.targetPropertyMatrix.some((row) => row.confidence !== "verified");
  return manualReview ? "jalan_target_matrix_proposal_basis_caution" : "jalan_target_matrix_proposal_ready";
}

export function renderTargetMatrixCsv(rows: readonly TargetPropertyMatrixRow[]): string {
  const header = [
    "canonical_property_name",
    "tier",
    "jalan_source_url",
    "jalan_property_id",
    "confidence",
    "recommended_for_auto03x",
    "local_evidence_path",
    "reason"
  ];
  return [header.join(","), ...rows.map((row) => header.map((key) => csvCell(String(row[key as keyof TargetPropertyMatrixRow] ?? ""))).join(","))].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: JalanTargetMatrixDecision;
  sourceAuto01xSummary: Record<string, unknown>;
  targetPropertyMatrix: readonly TargetPropertyMatrixRow[];
  manualReviewProperties: readonly TargetPropertyMatrixRow[];
  dateWindowMatrix: readonly DateWindowRow[];
  auto03xBoundedMatrix: readonly Auto03xBoundedTarget[];
  pageCapPlan: PageCapPlan;
  policy: DirectDirectionalExcludedPolicy;
  evidenceRequirements: EvidenceRequirements;
  botRiskSafetyRules: BotRiskSafetyRules;
  futurePhasePlan: readonly FuturePhase[];
  risks: readonly string[];
  safetyConfirmation: SafetyConfirmation;
}): string {
  return `# Jalan Target Matrix and Bounded Collection Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

JALAN-AUTO02X is proposal-only. It found ${input.targetPropertyMatrix.filter((row) => row.confidence === "verified").length} verified target-property Jalan URLs/IDs, ${input.targetPropertyMatrix.filter((row) => row.confidence === "candidate").length} candidate targets, and ${input.manualReviewProperties.length} targets requiring manual review or exclusion from the first live probe. The proposed AUTO03X matrix is ${input.pageCapPlan.proposed_properties} properties x ${input.pageCapPlan.proposed_dates_per_property} dates = ${input.pageCapPlan.proposed_pages} pages.

## 2. Source AUTO01X Findings

- AUTO01X decision: ${String(input.sourceAuto01xSummary["decision"] ?? "unknown")}
- Jalan rows: ${JSON.stringify(input.sourceAuto01xSummary["jalan_rows"] ?? input.sourceAuto01xSummary["jalan_db_summary"] ?? {})}
- Key gaps: property-level identity, meal condition, and direct-row revalidation before broader automation.

## 3. Target Property Matrix

${input.targetPropertyMatrix.map((row) => `- ${row.canonical_property_name} (${row.tier}): ${row.confidence}, ${row.jalan_property_id ?? "no_id"}, AUTO03X=${row.recommended_for_auto03x}`).join("\n")}

## 4. Manual Review Properties

${input.manualReviewProperties.map((row) => `- ${row.canonical_property_name}: ${row.reason}`).join("\n")}

## 5. Date Window Matrix

${input.dateWindowMatrix.map((row) => `- ${row.date} (${row.category}): ${row.purpose}; AUTO03X=${row.recommended_for_auto03x}`).join("\n")}

## 6. Proposed AUTO03X Bounded Matrix

${input.auto03xBoundedMatrix.map((row) => `- ${row.canonical_property_name} ${row.jalan_property_id}: ${row.dates.join(", ")} (${row.page_count} pages)`).join("\n")}

## 7. Direct / Directional / Excluded Policy

- Direct requires: ${input.policy.direct_allowed_only_when.join("; ")}
- Directional when: ${input.policy.directional_when.join("; ")}
- Excluded when: ${input.policy.excluded_when.join("; ")}
- ${input.policy.weak_rows_rule}
- ${input.policy.unattended_pricing_rule}

## 8. Evidence Requirements

- Required fields include: ${input.evidenceRequirements.required_fields.join(", ")}
- ${input.evidenceRequirements.screenshot_rule}

## 9. Bot-Risk / Safety Rules

${input.botRiskSafetyRules.rules.map((rule) => `- ${rule}`).join("\n")}

## 10. Future Phase Plan

${input.futurePhasePlan.map((phase) => `- ${phase.phase}: ${phase.objective}; gate: ${phase.approval_gate}`).join("\n")}

## 11. Risks

${input.risks.map((risk) => `- ${risk}`).join("\n")}

## 12. Safety Confirmation

${Object.entries(input.safetyConfirmation).map(([key, value]) => `- ${key}: ${String(value)}`).join("\n")}

## 13. Decision

${input.decision}

## 14. Next Phase

JALAN-AUTO03X — Bounded Jalan collection probe / preview rows. Do not start without explicit instruction.
`;
}

function selectAuto03xTargets(
  evidenceInventory: readonly LocalJalanEvidence[],
  targets: readonly JalanTargetProperty[]
): LocalJalanEvidence[] {
  const eligible = targets
    .map((target) => bestEvidenceFor(target.canonical_property_name, evidenceInventory))
    .filter((row): row is LocalJalanEvidence => row !== undefined && row.confidence === "verified" && row.jalan_source_url !== null && row.jalan_property_id !== null)
    .sort((a, b) => {
      const targetA = targets.find((target) => target.canonical_property_name === a.canonical_property_name);
      const targetB = targets.find((target) => target.canonical_property_name === b.canonical_property_name);
      const tierA = targetA?.tier === "tier_1" ? 0 : 1;
      const tierB = targetB?.tier === "tier_1" ? 0 : 1;
      if (tierA !== tierB) return tierA - tierB;
      return targetIndex(a.canonical_property_name) - targetIndex(b.canonical_property_name);
    });
  return eligible.slice(0, 5);
}

function bestEvidenceFor(name: string, rows: readonly LocalJalanEvidence[]): LocalJalanEvidence | undefined {
  return rows
    .filter((row) => row.canonical_property_name === name)
    .sort((a, b) => {
      const rank = confidenceRank(a.confidence) - confidenceRank(b.confidence);
      if (rank !== 0) return rank;
      const aHasUrl = a.jalan_source_url === null ? 1 : 0;
      const bHasUrl = b.jalan_source_url === null ? 1 : 0;
      if (aHasUrl !== bHasUrl) return aHasUrl - bHasUrl;
      return a.local_evidence_path.localeCompare(b.local_evidence_path);
    })[0];
}

function classifyEvidenceConfidence(input: { status: string; url: string | null; id: string | null }): JalanEvidenceConfidence {
  if (/confirmed|collector_working/iu.test(input.status) && input.url !== null && input.id !== null) return "verified";
  if (/needs_review|candidate/iu.test(input.status) && input.url !== null && input.id !== null) return "candidate";
  if (input.url !== null && input.id !== null) return "candidate";
  if (/manual|needs_review|candidate/iu.test(input.status)) return "needs_manual_review";
  return "missing";
}

function flattenObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenObjects);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return [obj, ...Object.values(obj).flatMap(flattenObjects)];
  }
  return [];
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function matchTarget(text: string): JalanTargetProperty | undefined {
  return TARGET_PROPERTIES.find((target) => target.aliases.some((alias) => includesLoose(text, alias)));
}

function includesLoose(text: string, query: string): boolean {
  return normalizeLoose(text).includes(normalizeLoose(query));
}

function normalizeLoose(value: string): string {
  return value.toLocaleLowerCase().replace(/[　\s'’"‐−\-・＆&]/gu, "");
}

function extractJalanUrl(text: string): string | null {
  return text.match(/https:\/\/www\.jalan\.net\/yad\d+\/?/u)?.[0] ?? null;
}

function extractJalanPropertyId(text: string): string | null {
  return normalizeJalanId(text.match(/yad(\d{6})/u)?.[1] ?? text.match(/\b(\d{6})\b/u)?.[1] ?? null);
}

function normalizeJalanId(id: string | null): string | null {
  if (id === null) return null;
  const digits = id.match(/\d{6}/u)?.[0] ?? null;
  return digits === null ? null : `yad${digits}`;
}

function dedupeEvidence(rows: readonly LocalJalanEvidence[]): LocalJalanEvidence[] {
  const seen = new Set<string>();
  const out: LocalJalanEvidence[] = [];
  for (const row of rows) {
    const key = `${row.canonical_property_name}|${row.jalan_source_url ?? ""}|${row.jalan_property_id ?? ""}|${row.local_evidence_path}|${row.confidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function confidenceRank(confidence: JalanEvidenceConfidence): number {
  return { verified: 0, candidate: 1, needs_manual_review: 2, missing: 3 }[confidence];
}

function targetIndex(name: string): number {
  return TARGET_PROPERTIES.findIndex((target) => target.canonical_property_name === name);
}

function purposeForPeakDate(date: string): string {
  if (date.startsWith("2026-07") || date.startsWith("2026-08")) return "summer holiday / Obon domestic pressure";
  if (date.startsWith("2026-09") || date.startsWith("2026-10") || date === "2026-11-21") return "autumn foliage / long-weekend pressure";
  return "early winter / ski-season signal";
}

function csvCell(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

// Phase JALAN-AUTO01X - Jalan collector / market signal integration plan.
//
// Read-only planning helpers. This module builds inventory, coverage summaries,
// policy, and future phase design for integrating Jalan into the existing
// history -> DB mirror -> AI context -> query pipeline. It does not collect,
// append history, write DB, sync DB, refresh context, or export pricing output.

export type JalanAutoIntegrationPlanDecision =
  | "jalan_auto_integration_plan_ready"
  | "jalan_auto_integration_plan_basis_caution"
  | "jalan_auto_integration_plan_not_ready";

export type JalanFileCategory =
  | "source_probe"
  | "source_collector_candidate"
  | "normalizer"
  | "history_append"
  | "report"
  | "test"
  | "legacy_or_unsafe";

export type JalanFileStatus = "usable" | "partial" | "needs_review" | "deprecated";

export interface FileSource {
  file_path: string;
  source_text: string;
}

export interface JalanFileInventoryRow {
  file_path: string;
  category: JalanFileCategory;
  current_status: JalanFileStatus;
  reads_external_network: boolean;
  writes_history: boolean;
  writes_db: boolean;
  writes_context: boolean;
  safe_for_current_phase: boolean;
  safe_for_future_bounded_run: boolean;
  notes: string;
}

export interface SignalRowLike {
  source?: string;
  canonical_property_name?: string;
  source_property_id?: string;
  source_slug_or_code?: string;
  checkin?: string;
  checkin_date?: string;
  availability_status?: string;
  basis_confidence?: string;
  dp_usage?: string;
  classification?: string;
  source_classification?: string;
  normalized_total_price?: string | number | null;
  normalized_total_jpy?: string | number | null;
  is_price_usable_for_dp_direct?: string | boolean;
  is_price_usable_for_dp_directional?: string | boolean;
  is_price_excluded_from_dp?: string | boolean;
  price_basis?: string;
  normalized_total_price_basis?: string;
  stay_scope?: string;
  group_adults?: string | number;
  no_rooms?: string | number;
  stay_nights?: string | number;
  warning_flags?: string;
  dp_exclusion_reason?: string;
  exclusion_reason?: string;
  source_report_path?: string;
  debug_artifact_path?: string;
}

export interface SourceSummary {
  total_rows: number;
  rows_by_source: Record<string, number>;
  rows_by_dp_usage: Record<string, number>;
  rows_by_basis_confidence: Record<string, number>;
  rows_by_availability_status: Record<string, number>;
  rows_by_classification: Record<string, number>;
  priced_rows: number;
  direct_rows: number;
  directional_rows: number;
  excluded_rows: number;
  date_range: { min: string | null; max: string | null };
  property_coverage: Record<string, number>;
}

export interface BookingBaseline {
  history_rows?: number;
  db_market_signal_history_rows: number;
  booking_rows_total: number;
  booking_directional: number;
  booking_excluded: number;
  booking_direct: number;
  booking_price_pressure_usable_rows: number;
  policy: string[];
}

export interface JalanDataQualityAudit {
  tax_included_basis: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  room_total_scope: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  coupon_suspicious_guards: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  status_separation: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  meal_condition: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  property_identity: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  evidence_paths: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  direct_rows_justification: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  directional_rows_policy: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
  excluded_rows_policy: { status: "pass" | "partial" | "gap"; evidence: string[]; gaps: string[] };
}

export interface DirectDirectionalExcludedPolicy {
  booking_policy: string;
  jalan_direct_allowed_only_when: string[];
  jalan_directional_when: string[];
  jalan_excluded_when: string[];
  weak_rows_rule: string;
  unattended_pricing_rule: string;
}

export interface IntegrationStep {
  step: number;
  name: string;
  action: string;
  output: string;
  approval_required: boolean;
}

export interface FutureJalanPhase {
  phase: string;
  objective: string;
  allowed_actions: string[];
  forbidden_actions: string[];
  expected_outputs: string[];
  approval_gate: string;
}

export interface RiskItem {
  risk: string;
  severity: "low" | "medium" | "high";
  mitigation: string;
}

export interface SafetyConfirmation {
  live_broad_jalan_collection: false;
  external_fetch: false;
  playwright_run: false;
  browser_automation: false;
  history_append: false;
  history_modification: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  pricing_csv_generation: false;
  github_actions_cron_gitops: false;
  paid_apis_or_proxies: false;
  captcha_bypass: false;
  stealth_login_cookies: false;
  started_next_phase: false;
}

export function buildJalanFileInventory(files: readonly FileSource[]): JalanFileInventoryRow[] {
  return files
    .filter((file) => /jalan|dpSafe|dp-safe|buildDpSafe|crossSource|localHistory|marketSignal/iu.test(file.file_path))
    .map((file) => {
      const text = file.source_text;
      const category = classifyFile(file.file_path);
      const readsExternalNetwork = /chromium\.launch|page\.goto|fetch\(|new JalanCollector/u.test(text);
      const writesHistory = /runLocalHistoryRealAppend|real-run:local-history-append|writeFileSync\([^)]*\.data\/history|renameSync/u.test(text);
      const writesContext = /build:ai-context-packs|latest_ai_task_entrypoint|latest_market_snapshot/u.test(text);
      const writesDb = /persistCollectorResult|insertCollectionJobAttempt|computeAndUpsert|executeMigration|INSERT INTO|UPDATE\s+|DELETE FROM/iu.test(text);
      const safeForCurrentPhase = !readsExternalNetwork && !writesHistory && !writesDb && !writesContext;
      return {
        file_path: file.file_path,
        category,
        current_status: statusFor({ category, readsExternalNetwork, writesHistory, writesDb }),
        reads_external_network: readsExternalNetwork,
        writes_history: writesHistory,
        writes_db: writesDb,
        writes_context: writesContext,
        safe_for_current_phase: safeForCurrentPhase,
        safe_for_future_bounded_run: category !== "legacy_or_unsafe" && !writesHistory,
        notes: notesFor({ category, readsExternalNetwork, writesHistory, writesDb })
      };
    })
    .sort((a, b) => a.file_path.localeCompare(b.file_path));
}

function classifyFile(path: string): JalanFileCategory {
  if (/tests\//u.test(path)) return "test";
  if (/buildDpSafe|computeMarketSignals|crossSource|marketSignal|localHistorySchema|localHistoryAppendValidation/iu.test(path)) {
    return "normalizer";
  }
  if (/localHistoryRealAppend|runLocalHistoryAppendDryRun|bookingHistoryAppend|historyAppend/iu.test(path)) {
    return "history_append";
  }
  if (/inspect|print|planJalan|build.*Report|report/iu.test(path)) return "report";
  if (/runJalan|jalanCollector|jalanPlanBlock|jalanAcceptedPrice|jalanEvidence|jalanStatus|jalanPrice|jalanLink|jalanNavigation/iu.test(path)) {
    return "source_collector_candidate";
  }
  if (/prototype|probe|discovery/iu.test(path)) return "source_probe";
  return "legacy_or_unsafe";
}

function statusFor(input: { category: JalanFileCategory; readsExternalNetwork: boolean; writesHistory: boolean; writesDb: boolean }): JalanFileStatus {
  if (input.category === "test" || input.category === "normalizer" || input.category === "report") return "usable";
  if (input.writesHistory) return "needs_review";
  if (input.readsExternalNetwork || input.writesDb) return "partial";
  return "needs_review";
}

function notesFor(input: { category: JalanFileCategory; readsExternalNetwork: boolean; writesHistory: boolean; writesDb: boolean }): string {
  if (input.readsExternalNetwork) return "Contains live collection/browser network behavior; do not run in AUTO01X.";
  if (input.writesHistory) return "History append related; proposal/real-run separation required.";
  if (input.writesDb) return "DB/persistence behavior present; only safe in future approved bounded phases.";
  if (input.category === "normalizer") return "Useful for Jalan market-signal normalization and quality policy.";
  return "Safe for local inspection in this planning phase.";
}

export function summarizeSignalRows(rows: readonly SignalRowLike[]): SourceSummary {
  const dates = rows.map((row) => row.checkin_date ?? row.checkin ?? "").filter(Boolean).sort();
  return {
    total_rows: rows.length,
    rows_by_source: countBy(rows.map((row) => row.source ?? "unknown")),
    rows_by_dp_usage: countBy(rows.map(deriveDpUsage)),
    rows_by_basis_confidence: countBy(rows.map((row) => row.basis_confidence ?? "unknown")),
    rows_by_availability_status: countBy(rows.map((row) => row.availability_status ?? "unknown")),
    rows_by_classification: countBy(rows.map((row) => row.classification ?? row.source_classification ?? "unknown")),
    priced_rows: rows.filter((row) => numberOrNull(row.normalized_total_jpy ?? row.normalized_total_price) !== null).length,
    direct_rows: rows.filter((row) => deriveDpUsage(row) === "direct").length,
    directional_rows: rows.filter((row) => deriveDpUsage(row) === "directional").length,
    excluded_rows: rows.filter((row) => deriveDpUsage(row) === "excluded").length,
    date_range: { min: dates[0] ?? null, max: dates[dates.length - 1] ?? null },
    property_coverage: countBy(rows.map((row) => row.canonical_property_name ?? "unknown"))
  };
}

export function buildBookingBaseline(input: { dbSummary: SourceSummary; bookingSummary: SourceSummary; historyRowCount?: number }): BookingBaseline {
  const bookingRows = input.bookingSummary.total_rows;
  const bookingDirectional = input.bookingSummary.directional_rows;
  const bookingExcluded = input.bookingSummary.excluded_rows;
  const bookingDirect = input.bookingSummary.direct_rows;
  return {
    ...(input.historyRowCount === undefined ? {} : { history_rows: input.historyRowCount }),
    db_market_signal_history_rows: input.dbSummary.total_rows,
    booking_rows_total: bookingRows,
    booking_directional: bookingDirectional,
    booking_excluded: bookingExcluded,
    booking_direct: bookingDirect,
    booking_price_pressure_usable_rows: bookingDirectional,
    policy: [
      "Booking.com remains directional price-pressure evidence only.",
      "Booking direct rows must remain zero.",
      "Booking rows must never drive unattended PMS/Beds24/AirHost price updates."
    ]
  };
}

export function buildJalanDataQualityAudit(input: {
  jalanRows: readonly SignalRowLike[];
  inventory: readonly JalanFileInventoryRow[];
}): JalanDataQualityAudit {
  const priced = input.jalanRows.filter((row) => numberOrNull(row.normalized_total_jpy ?? row.normalized_total_price) !== null);
  const direct = input.jalanRows.filter((row) => deriveDpUsage(row) === "direct");
  const directional = input.jalanRows.filter((row) => deriveDpUsage(row) === "directional");
  const excluded = input.jalanRows.filter((row) => deriveDpUsage(row) === "excluded");
  const hasCollectorPolicy = input.inventory.some((row) => /jalanAcceptedPricePolicy|jalanPlanBlockExtractor|jalanCollectorDecision/u.test(row.file_path));
  const hasDpSafe = input.inventory.some((row) => /buildDpSafe|dp_safe/iu.test(row.file_path));
  const allOneNightTwoAdults = input.jalanRows.every(
    (row) =>
      String(row.stay_scope ?? "").includes("2_adults_1_room_1_night") ||
      (String(row.group_adults ?? "") === "2" && String(row.no_rooms ?? "") === "1" && String(row.stay_nights ?? "") === "1")
  );
  const sourcePaths = input.jalanRows.filter((row) => row.source_report_path || row.debug_artifact_path).length;
  const propertyNames = new Set(input.jalanRows.map((row) => row.canonical_property_name ?? ""));

  return {
    tax_included_basis: {
      status: hasCollectorPolicy && priced.length > 0 ? "partial" : "gap",
      evidence: [
        "Jalan collector code accepts total_tax_included plan evidence only.",
        `${priced.length} current Jalan rows have normalized prices.`
      ],
      gaps: ["Current history rows are aggregate DP-safe medians, not raw per-property plan evidence."]
    },
    room_total_scope: {
      status: allOneNightTwoAdults ? "partial" : "gap",
      evidence: [`${input.jalanRows.length} rows use or imply 2 adults / 1 room / 1 night.`],
      gaps: ["Future bounded collector should persist explicit adults/rooms/nights fields in every preview row."]
    },
    coupon_suspicious_guards: {
      status: hasDpSafe ? "pass" : "gap",
      evidence: ["DP-safe code excludes coupon/suspicious price-basis and per-person/basis mismatch rows."],
      gaps: ["Future append proposals must carry warning_flags and dp_exclusion_reason into history."]
    },
    status_separation: {
      status: "partial",
      evidence: [`Availability counts: ${JSON.stringify(countBy(input.jalanRows.map((row) => row.availability_status ?? "unknown")))}`],
      gaps: ["Current Jalan rows do not include sold_out rows; future collection must preserve sold_out/not_listed/failed separately."]
    },
    meal_condition: {
      status: "gap",
      evidence: [],
      gaps: ["Meal condition is not reliable in current Jalan aggregate rows and must not be inferred."]
    },
    property_identity: {
      status: propertyNames.size === 1 && propertyNames.has("market_aggregate") ? "gap" : "partial",
      evidence: [`Current property coverage: ${JSON.stringify(countBy(input.jalanRows.map((row) => row.canonical_property_name ?? "unknown")))}`],
      gaps: ["Current Jalan history contribution is market_aggregate, so property-level pricing support needs bounded property rows."]
    },
    evidence_paths: {
      status: sourcePaths === input.jalanRows.length ? "pass" : "partial",
      evidence: [`${sourcePaths}/${input.jalanRows.length} Jalan rows carry report/debug evidence paths.`],
      gaps: sourcePaths === input.jalanRows.length ? [] : ["Some rows lack direct debug/report evidence paths."]
    },
    direct_rows_justification: {
      status: direct.length > 0 && hasDpSafe ? "partial" : "gap",
      evidence: [`${direct.length} current Jalan rows are direct, all from DP-safe aggregate logic.`],
      gaps: ["Direct capability should be revalidated for bounded property-level rows before expanding automation."]
    },
    directional_rows_policy: {
      status: directional.length > 0 ? "pass" : "gap",
      evidence: [`${directional.length} Jalan rows are directional.`],
      gaps: []
    },
    excluded_rows_policy: {
      status: excluded.length > 0 ? "pass" : "gap",
      evidence: [`${excluded.length} Jalan rows are excluded.`],
      gaps: []
    }
  };
}

export function buildDirectDirectionalExcludedPolicy(): DirectDirectionalExcludedPolicy {
  return {
    booking_policy: "Booking.com is directional price-pressure evidence only; direct rows remain zero.",
    jalan_direct_allowed_only_when: [
      "price basis is clear",
      "tax-included total is clear",
      "2 adults / 1 room / 1 night scope is clear",
      "coupon/member/point/suspicious discounts are excluded",
      "source confidence is A",
      "evidence path links to report/debug proof"
    ],
    jalan_directional_when: [
      "basis confidence is B",
      "price is useful for market pressure but not safe for unattended DP",
      "coverage is aggregate or otherwise not property-specific enough for direct action"
    ],
    jalan_excluded_when: [
      "basis confidence is C or insufficient",
      "tax/room/person basis is unclear",
      "coupon/point/member discount contamination is suspected",
      "price is missing, blocked, failed, or unavailable"
    ],
    weak_rows_rule: "Weak Jalan rows must remain directional or excluded; do not promote them to direct.",
    unattended_pricing_rule: "No Jalan-derived row may update PMS/Beds24/AirHost/OTA prices without explicit future approval."
  };
}

export function buildIntegrationPath(): IntegrationStep[] {
  return [
    { step: 1, name: "Jalan bounded collection", action: "Collect a capped target matrix only after a proposal phase.", output: "normalized preview rows", approval_required: false },
    { step: 2, name: "History append proposal", action: "Compare row_id/row_hash against .data/history in memory.", output: "append proposal JSON/CSV/MD", approval_required: false },
    { step: 3, name: "Guarded history append", action: "Append approved rows with backups, temp files, validation, and rollback.", output: "updated history shards", approval_required: true },
    { step: 4, name: "DB mirror sync", action: "Run the existing history-to-DB sync after append succeeds.", output: "market_signal_history mirror", approval_required: true },
    { step: 5, name: "AI context refresh", action: "Rebuild context packs after DB mirror matches history.", output: "latest AI context packs", approval_required: false },
    { step: 6, name: "Query smoke and pricing_support verification", action: "Run read-only market_report/pricing_support checks.", output: "usability report", approval_required: false }
  ];
}

export function buildFuturePhasePlan(): FutureJalanPhase[] {
  return [
    {
      phase: "JALAN-AUTO02X",
      objective: "Jalan target matrix and bounded collection proposal.",
      allowed_actions: ["Read property/source coverage", "Propose target properties/dates/page caps"],
      forbidden_actions: ["No live collection", "No history append", "No DB write"],
      expected_outputs: ["target matrix proposal", "risk/page cap plan"],
      approval_gate: "proposal-only; no real write approval required"
    },
    {
      phase: "JALAN-AUTO03X",
      objective: "Bounded Jalan collection probe / preview rows.",
      allowed_actions: ["Run capped Jalan collection only for approved targets", "Generate normalized preview rows"],
      forbidden_actions: ["No history append", "No DB write", "No AI context refresh"],
      expected_outputs: ["preview row report", "debug evidence", "basis-quality summary"],
      approval_gate: "explicit scope approval for bounded live collection"
    },
    {
      phase: "JALAN-AUTO04X",
      objective: "Jalan history append proposal.",
      allowed_actions: ["Read AUTO03X preview rows", "Run in-memory dedupe/conflict preflight"],
      forbidden_actions: ["No history modification", "No DB write"],
      expected_outputs: ["append proposal", "touched shard plan", "direct/directional/excluded split"],
      approval_gate: "proposal-only; no real write approval required"
    },
    {
      phase: "JALAN-AUTO05X",
      objective: "Approved Jalan history append.",
      allowed_actions: ["Back up touched shards", "Append approved rows", "Validate and rollback on failure"],
      forbidden_actions: ["No DB sync", "No context refresh in this phase"],
      expected_outputs: ["real append report", "backup paths", "post-write validation"],
      approval_gate: "requires exact user approval sentence and env flag"
    },
    {
      phase: "JALAN-AUTO05B",
      objective: "DB sync + AI context refresh.",
      allowed_actions: ["Dry-run history-to-DB sync", "Approved DB mirror sync", "Rebuild AI context packs", "Run query smoke checks"],
      forbidden_actions: ["No collector run", "No history append"],
      expected_outputs: ["DB sync report", "AI context refresh report", "query smoke summary"],
      approval_gate: "requires DB sync approval/env flag for real DB write"
    },
    {
      phase: "JALAN-AUTO06X",
      objective: "Jalan price-pressure usability verification.",
      allowed_actions: ["Read DB/context", "Verify pricing_support can use Jalan evidence safely"],
      forbidden_actions: ["No PMS/Beds24/AirHost output", "No price update"],
      expected_outputs: ["usability report", "direct/directional guard validation"],
      approval_gate: "read-only"
    }
  ];
}

export function buildRisks(): RiskItem[] {
  return [
    { risk: "Current Jalan history rows are market_aggregate, not property-level rows.", severity: "high", mitigation: "Require bounded property-level preview rows before broad integration." },
    { risk: "Direct-capable Jalan rows can be over-trusted if basis evidence is weak.", severity: "high", mitigation: "Direct only with A confidence, tax-included total, stay scope, and coupon/suspicious guards." },
    { risk: "Live Jalan collectors use Playwright/network and write DB snapshots in older scripts.", severity: "medium", mitigation: "Keep AUTO01X read-only; future live phases must be bounded and explicitly approved." },
    { risk: "Meal condition is not currently reliable in aggregate rows.", severity: "medium", mitigation: "Persist meal condition only when extracted; do not infer it." }
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    live_broad_jalan_collection: false,
    external_fetch: false,
    playwright_run: false,
    browser_automation: false,
    history_append: false,
    history_modification: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    pricing_csv_generation: false,
    github_actions_cron_gitops: false,
    paid_apis_or_proxies: false,
    captcha_bypass: false,
    stealth_login_cookies: false,
    started_next_phase: false
  };
}

export function decideJalanAutoIntegrationPlan(input: {
  inventory: readonly JalanFileInventoryRow[];
  jalanSummary: SourceSummary;
  audit: JalanDataQualityAudit;
}): JalanAutoIntegrationPlanDecision {
  if (input.inventory.length === 0 || input.jalanSummary.total_rows === 0) {
    return "jalan_auto_integration_plan_not_ready";
  }
  if (input.audit.property_identity.status === "gap" || input.audit.meal_condition.status === "gap") {
    return "jalan_auto_integration_plan_basis_caution";
  }
  return "jalan_auto_integration_plan_ready";
}

export function renderInventoryCsv(rows: readonly JalanFileInventoryRow[]): string {
  const headers = [
    "file_path",
    "category",
    "current_status",
    "reads_external_network",
    "writes_history",
    "writes_db",
    "writes_context",
    "safe_for_current_phase",
    "safe_for_future_bounded_run",
    "notes"
  ];
  const body = rows.map((row) =>
    [
      row.file_path,
      row.category,
      row.current_status,
      String(row.reads_external_network),
      String(row.writes_history),
      String(row.writes_db),
      String(row.writes_context),
      String(row.safe_for_current_phase),
      String(row.safe_for_future_bounded_run),
      row.notes
    ].map(csvEscape).join(",")
  );
  return [headers.join(","), ...body].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: JalanAutoIntegrationPlanDecision;
  bookingBaseline: BookingBaseline;
  jalanCurrentState: string;
  fileInventory: readonly JalanFileInventoryRow[];
  jalanDbSummary: SourceSummary;
  jalanHistorySummary: SourceSummary;
  jalanAiContextSummary: Record<string, unknown>;
  audit: JalanDataQualityAudit;
  policy: DirectDirectionalExcludedPolicy;
  integrationPath: readonly IntegrationStep[];
  futurePhasePlan: readonly FutureJalanPhase[];
  risks: readonly RiskItem[];
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): string {
  return [
    "# Jalan Auto Integration Plan",
    "",
    `Generated at JST: ${input.generatedAtJst}`,
    `Decision: ${input.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    "- Jalan already contributes domestic OTA market signal rows, but current history coverage is aggregate rather than property-level.",
    "- Safest path is the Booking-style separation: bounded collection, append proposal, approved append, DB/context refresh, usability verification.",
    "",
    "## 2. Current Booking Baseline",
    "",
    `- DB market_signal_history rows: ${input.bookingBaseline.db_market_signal_history_rows}`,
    `- Booking rows: ${input.bookingBaseline.booking_rows_total}`,
    `- Booking directional/excluded/direct: ${input.bookingBaseline.booking_directional}/${input.bookingBaseline.booking_excluded}/${input.bookingBaseline.booking_direct}`,
    "",
    "## 3. Current Jalan State",
    "",
    `- ${input.jalanCurrentState}`,
    "",
    "## 4. Jalan File / Script Inventory",
    "",
    `- Jalan-related local files inventoried: ${input.fileInventory.length}`,
    `- Files safe for current phase: ${input.fileInventory.filter((row) => row.safe_for_current_phase).length}`,
    "",
    "## 5. Jalan DB / History Coverage",
    "",
    `- DB Jalan rows: ${input.jalanDbSummary.total_rows}`,
    `- DB Jalan direct/directional/excluded: ${input.jalanDbSummary.direct_rows}/${input.jalanDbSummary.directional_rows}/${input.jalanDbSummary.excluded_rows}`,
    `- History Jalan rows: ${input.jalanHistorySummary.total_rows}`,
    `- Jalan date range: ${input.jalanDbSummary.date_range.min ?? "null"} to ${input.jalanDbSummary.date_range.max ?? "null"}`,
    "",
    "## 6. Jalan Data Quality Audit",
    "",
    `- tax_included_basis=${input.audit.tax_included_basis.status}`,
    `- room_total_scope=${input.audit.room_total_scope.status}`,
    `- coupon_suspicious_guards=${input.audit.coupon_suspicious_guards.status}`,
    `- meal_condition=${input.audit.meal_condition.status}`,
    `- property_identity=${input.audit.property_identity.status}`,
    "",
    "## 7. Direct / Directional / Excluded Policy",
    "",
    `- ${input.policy.weak_rows_rule}`,
    `- ${input.policy.unattended_pricing_rule}`,
    "",
    "## 8. Integration Path",
    "",
    ...input.integrationPath.map((step) => `- ${step.step}. ${step.name}: ${step.output}`),
    "",
    "## 9. Future Jalan Phases",
    "",
    ...input.futurePhasePlan.map((phase) => `- ${phase.phase}: ${phase.objective}`),
    "",
    "## 10. Risks",
    "",
    ...input.risks.map((risk) => `- ${risk.severity}: ${risk.risk} Mitigation: ${risk.mitigation}`),
    "",
    "## 11. Safety Confirmation",
    "",
    "- Read-only planning phase: no live collection, no history append, no DB write, no DB sync, no context refresh.",
    "- No PMS/Beds24/AirHost output, no price update, no pricing CSV generation.",
    "",
    "## 12. Decision",
    "",
    `- ${input.decision}`,
    "",
    "## 13. Next Phase",
    "",
    "- JALAN-AUTO02X - Jalan target matrix and bounded collection proposal.",
    "",
    "Artifacts:",
    "",
    `- report=${input.reportPath}`,
    `- json=${input.jsonPath}`,
    `- csv=${input.csvPath}`,
    `- debug=${input.debugPath}`,
    ""
  ].join("\n");
}

function deriveDpUsage(row: SignalRowLike): string {
  if (row.dp_usage !== undefined && row.dp_usage !== "") return row.dp_usage;
  if (truthy(row.is_price_usable_for_dp_direct)) return "direct";
  if (truthy(row.is_price_usable_for_dp_directional)) return "directional";
  if (truthy(row.is_price_excluded_from_dp)) return "excluded";
  return "unknown";
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value || "unknown"] = (out[value || "unknown"] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function csvEscape(value: string): string {
  if (/[",\n]/u.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

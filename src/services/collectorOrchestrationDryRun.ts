// Phase AUTO07X — collector orchestration dry-run / low-bot-risk collection
// strategy (pure, design-only).
//
// This module produces an orchestration PLAN and a collection-method comparison
// from knowledge of the existing codebase + artifacts. It MUTATES NOTHING and
// triggers NOTHING: no DB access, no fs writes, no live external fetch, no
// collector run, no .data/history append, no .data/ai-context mutation, no
// GitHub Actions / cron / GitOps, no paid sources, no CAPTCHA/stealth/login, no
// Booking base × 1.1. Every "action" it emits is a dry-run description of what a
// FUTURE, separately-approved real run would do — never an execution.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollectorOrchestrationDecision =
  | "collector_orchestration_dry_run_ready"
  | "collector_orchestration_dry_run_basis_caution"
  | "collector_orchestration_dry_run_not_ready";

export type BotRiskLevel = "none" | "low" | "medium" | "high" | "forbidden";
export type DataQualityLevel = "high" | "medium" | "low" | "depends_on_last_run";

export type CollectorCategory =
  | "source_probe"
  | "source_collector_candidate"
  | "normalizer"
  | "history_append"
  | "db_sync"
  | "ai_context_refresh"
  | "ai_query"
  | "property_discovery"
  | "report_only"
  | "unsafe_for_automation";

export type CollectionMethodId = "A" | "B" | "C" | "D" | "E" | "F";

export interface CollectionMethod {
  id: CollectionMethodId;
  name: string;
  description: string;
  bot_risk: BotRiskLevel;
  cost: "free" | "not_free";
  data_quality: DataQualityLevel;
  efficiency: "high" | "medium" | "low";
  complexity: "low" | "medium" | "high";
  status: "preferred" | "conditional" | "last_resort" | "forbidden";
  expected_role: string;
}

export interface CollectorInventoryEntry {
  name: string;
  file_path: string;
  source: "jalan" | "rakuten" | "booking" | "google_hotels" | "property_discovery" | "cross_source" | "pipeline" | "mock";
  category: CollectorCategory;
  current_status: string;
  collection_method: CollectionMethodId | "n/a";
  bot_risk_level: BotRiskLevel;
  data_quality_level: DataQualityLevel;
  reads_external_network: boolean;
  writes_db: boolean;
  writes_history: boolean;
  requires_approval: boolean;
  safe_for_dry_run: boolean;
  safe_for_scheduled_automation_now: boolean;
  reason: string;
}

export interface SourceStrategy {
  source: string;
  preferred_method: CollectionMethodId;
  fallback_method: CollectionMethodId | "none";
  bot_risk: BotRiskLevel;
  data_quality: DataQualityLevel;
  notes: string[];
}

export interface DateWindowPlan {
  near_term_daily: { description: string; start: string; end: string; dates: string[] };
  peak_weekly: { description: string; horizon_days: number; dates: string[] };
  far_baseline: { description: string; start: string; end: string; dates: string[] };
}

export interface MicroBatchConstraints {
  max_sources_per_run: number;
  max_properties_per_source: number;
  max_dates_per_property: number;
  max_requests_per_run: number;
  max_browser_pages_per_run: number;
  source_timeout_ms: number;
  run_timeout_ms: number;
  justification: Record<string, string>;
  source_specific: Record<string, string[]>;
}

export interface DryRunAction {
  step: number;
  description: string;
  source: string | "all";
  method: CollectionMethodId | "n/a";
  would_execute: boolean; // always false in a dry-run
  reason: string;
}

export interface ApprovalGate {
  phase: string;
  gate: string;
  requires_explicit_approval: boolean;
}

export interface OrchestrationDryRun {
  run_id: string;
  generated_at_jst: string;
  decision: CollectorOrchestrationDecision;
  collection_method_comparison: CollectionMethod[];
  recommended_collection_strategy: string[];
  collector_inventory: CollectorInventoryEntry[];
  candidate_collectors: CollectorInventoryEntry[];
  source_specific_strategy: SourceStrategy[];
  date_window_plan: DateWindowPlan;
  micro_batch_constraints: MicroBatchConstraints;
  normalized_row_contract: { schema_version: string; columns: string[] };
  dry_run_actions: DryRunAction[];
  downstream_pipeline_plan: string[];
  approval_gates: ApprovalGate[];
  risks: string[];
  safety_confirmation: Record<string, boolean>;
  next_phase: string;
}

// ---------------------------------------------------------------------------
// 4. Collection-method comparison
// ---------------------------------------------------------------------------

export function buildCollectionMethodComparison(): CollectionMethod[] {
  return [
    {
      id: "A",
      name: "Existing artifact / DB reuse first",
      description: "Reuse .data/history, the DB mirror, context packs, and prior source-discovery reports before any external access.",
      bot_risk: "none",
      cost: "free",
      data_quality: "depends_on_last_run",
      efficiency: "high",
      complexity: "low",
      status: "preferred",
      expected_role: "Always the first step. Never fetch externally if existing data answers the task."
    },
    {
      id: "B",
      name: "Lightweight public endpoint / JSON / static HTML",
      description: "Use public, unauthenticated, already-validated endpoints or static HTML (e.g. Rakuten /hplan/calendar JSONP with corrected live-faithful params; proven Jalan static extraction).",
      bot_risk: "low",
      cost: "free",
      data_quality: "high",
      efficiency: "high",
      complexity: "medium",
      status: "preferred",
      expected_role: "Preferred external method when stable and already source-validated."
    },
    {
      id: "C",
      name: "Playwright rendered DOM, bounded",
      description: "Use a real browser only when static/public extraction is insufficient (e.g. Booking rendered rate-card pages). Small page count, no stealth, no CAPTCHA bypass, no login, no cookie injection, no high-frequency browsing.",
      bot_risk: "high",
      cost: "free",
      data_quality: "high",
      efficiency: "low",
      complexity: "high",
      status: "conditional",
      expected_role: "Only for small, high-value checks or sources that cannot be extracted otherwise."
    },
    {
      id: "D",
      name: "Local / manual scheduled runner before cloud",
      description: "Run bounded collectors locally / manually before any GitHub Actions scheduling.",
      bot_risk: "low",
      cost: "free",
      data_quality: "high",
      efficiency: "medium",
      complexity: "medium",
      status: "conditional",
      expected_role: "Best next step before GitHub Actions when WAF risk is high (residential IP, lower block rate)."
    },
    {
      id: "E",
      name: "GitHub Actions / cloud runner",
      description: "Run collectors on GitHub Actions free tier.",
      bot_risk: "high",
      cost: "free",
      data_quality: "medium",
      efficiency: "medium",
      complexity: "medium",
      status: "last_resort",
      expected_role: "Do not schedule immediately. Run a WAF smoke test first; activate a schedule only after cloud-runner risk is measured."
    },
    {
      id: "F",
      name: "Paid APIs / paid scraping / proxies / CAPTCHA bypass / stealth",
      description: "SerpAPI, DataForSEO, Apify, Bright Data, Oxylabs, paid proxies, CAPTCHA solving, stealth plugins.",
      bot_risk: "forbidden",
      cost: "not_free",
      data_quality: "medium",
      efficiency: "medium",
      complexity: "medium",
      status: "forbidden",
      expected_role: "Explicitly rejected. Violates project constraints. Do not use and do not recommend."
    }
  ];
}

export function buildRecommendedStrategy(): string[] {
  return [
    "1. Reuse existing artifacts / DB / context packs whenever possible (Method A).",
    "2. Prefer static HTML / public endpoint / JSON extraction over browser rendering (Method B before C).",
    "3. Use Playwright (Method C) only for small bounded cases where required.",
    "4. Run local/manual bounded collectors (Method D) before any scheduled GitHub Actions.",
    "5. Run a GitHub Actions WAF smoke test (Method E) before any scheduled activation.",
    "6. Only then consider scheduled automation.",
    "Reject Method F (paid APIs/proxies/CAPTCHA/stealth) entirely."
  ];
}

// ---------------------------------------------------------------------------
// 9. Collector inventory (grounded in the real repo)
// ---------------------------------------------------------------------------

export function buildCollectorInventory(): CollectorInventoryEntry[] {
  return [
    // ---- Jalan ----
    {
      name: "jalanCollector",
      file_path: "src/collectors/jalanCollector.ts",
      source: "jalan",
      category: "source_collector_candidate",
      current_status: "prototype_validated",
      collection_method: "C",
      bot_risk_level: "medium",
      data_quality_level: "high",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Playwright rendered DOM; strongest/direct-capable source but must stay micro-batched with coupon/sold_out guards; cloud WAF risk untested."
    },
    {
      name: "runJalanBudgetedCollection",
      file_path: "src/scripts/runJalanBudgetedCollection.ts",
      source: "jalan",
      category: "source_collector_candidate",
      current_status: "bounded_runner",
      collection_method: "C",
      bot_risk_level: "medium",
      data_quality_level: "high",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Live budgeted collection; run locally/manually first, never auto-scheduled before a WAF smoke test."
    },
    {
      name: "inspectLatestJalanRun",
      file_path: "src/scripts/inspectLatestJalanRun.ts",
      source: "jalan",
      category: "report_only",
      current_status: "read_only",
      collection_method: "A",
      bot_risk_level: "none",
      data_quality_level: "depends_on_last_run",
      reads_external_network: false,
      writes_db: false,
      writes_history: false,
      requires_approval: false,
      safe_for_dry_run: true,
      safe_for_scheduled_automation_now: true,
      reason: "Reads prior Jalan artifacts only; safe to run anytime."
    },
    // ---- Rakuten ----
    {
      name: "rakutenCollector",
      file_path: "src/collectors/rakutenCollector.ts",
      source: "rakuten",
      category: "source_collector_candidate",
      current_status: "prototype_validated",
      collection_method: "C",
      bot_risk_level: "high",
      data_quality_level: "medium",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Playwright path; prefer the corrected /hplan/calendar JSONP endpoint (Method B) over browser/reservation-adjacent transitions."
    },
    {
      name: "rakutenHplanCalendarProbe",
      file_path: "src/services/rakutenHplanCalendarProbe.ts",
      source: "rakuten",
      category: "source_probe",
      current_status: "validated_public_endpoint",
      collection_method: "B",
      bot_risk_level: "low",
      data_quality_level: "high",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Lightweight JSONP calendar endpoint; preferred Rakuten method but still external — bounded/manual first, watch for silent all-empty responses."
    },
    {
      name: "rakutenLimitedCollectorPrototype",
      file_path: "src/services/rakutenLimitedCollectorPrototype.ts",
      source: "rakuten",
      category: "source_collector_candidate",
      current_status: "prototype_validated",
      collection_method: "B",
      bot_risk_level: "low",
      data_quality_level: "medium",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "B-confidence directional rows from per-person CHARGE_PER_HUMAN; total is computed, never raw; cap requests."
    },
    // ---- Booking ----
    {
      name: "bookingRenderedDomProbe",
      file_path: "src/services/bookingRenderedDomProbe.ts",
      source: "booking",
      category: "source_probe",
      current_status: "probe",
      collection_method: "C",
      bot_risk_level: "high",
      data_quality_level: "high",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Rendered DOM, highest cloud WAF risk; very small page caps; official visible base + visible tax/fee adder only — never a synthetic base × 1.1."
    },
    {
      name: "bookingLimitedExtractorPrototype",
      file_path: "src/services/bookingLimitedExtractorPrototype.ts",
      source: "booking",
      category: "source_collector_candidate",
      current_status: "prototype",
      collection_method: "C",
      bot_risk_level: "high",
      data_quality_level: "high",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Small bounded rendered extraction; run a cloud smoke test before any scheduling."
    },
    {
      name: "bookingMarketSignalNormalization",
      file_path: "src/services/bookingMarketSignalNormalization.ts",
      source: "booking",
      category: "normalizer",
      current_status: "validated",
      collection_method: "A",
      bot_risk_level: "none",
      data_quality_level: "high",
      reads_external_network: false,
      writes_db: false,
      writes_history: false,
      requires_approval: false,
      safe_for_dry_run: true,
      safe_for_scheduled_automation_now: true,
      reason: "Pure normalization of captured Booking rows; no network."
    },
    // ---- Google Hotels (rejected/feasibility) ----
    {
      name: "googleHotelsFreeDirectProbe",
      file_path: "src/feasibility/googleHotelsFreeDirectProbe.ts",
      source: "google_hotels",
      category: "unsafe_for_automation",
      current_status: "feasibility_only",
      collection_method: "C",
      bot_risk_level: "high",
      data_quality_level: "low",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Feasibility probe only; not an approved automation source."
    },
    // ---- Cross-source / normalizer ----
    {
      name: "crossSourceMarketSignalNormalization",
      file_path: "src/services/crossSourceMarketSignalNormalization.ts",
      source: "cross_source",
      category: "normalizer",
      current_status: "validated",
      collection_method: "A",
      bot_risk_level: "none",
      data_quality_level: "high",
      reads_external_network: false,
      writes_db: false,
      writes_history: false,
      requires_approval: false,
      safe_for_dry_run: true,
      safe_for_scheduled_automation_now: true,
      reason: "Pure cross-source normalization into the DP-safe row shape; no network."
    },
    // ---- History append ----
    {
      name: "localHistoryAppendDryRun",
      file_path: "src/services/localHistoryAppendDryRun.ts",
      source: "pipeline",
      category: "history_append",
      current_status: "dry_run",
      collection_method: "A",
      bot_risk_level: "none",
      data_quality_level: "high",
      reads_external_network: false,
      writes_db: false,
      writes_history: false,
      requires_approval: false,
      safe_for_dry_run: true,
      safe_for_scheduled_automation_now: false,
      reason: "Dry-run only; the real append is a separately-approved later phase (AUTO08X)."
    },
    {
      name: "localHistoryRealAppend",
      file_path: "src/services/localHistoryRealAppend.ts",
      source: "pipeline",
      category: "history_append",
      current_status: "guarded_real_run",
      collection_method: "A",
      bot_risk_level: "none",
      data_quality_level: "high",
      reads_external_network: false,
      writes_db: false,
      writes_history: true,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Writes .data/history; requires explicit approval and an env gate; never auto-run from this orchestrator."
    },
    // ---- DB sync ----
    {
      name: "historyToDbSyncRealRun",
      file_path: "src/services/historyToDbSyncRealRun.ts",
      source: "pipeline",
      category: "db_sync",
      current_status: "guarded_real_run",
      collection_method: "A",
      bot_risk_level: "none",
      data_quality_level: "high",
      reads_external_network: false,
      writes_db: true,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Writes the DB mirror; runs only after a stable history-first append; requires approval."
    },
    // ---- AI context refresh ----
    {
      name: "aiContextPackGenerator",
      file_path: "src/services/aiContextPackGenerator.ts",
      source: "pipeline",
      category: "ai_context_refresh",
      current_status: "validated",
      collection_method: "A",
      bot_risk_level: "none",
      data_quality_level: "high",
      reads_external_network: false,
      writes_db: false,
      writes_history: false,
      requires_approval: false,
      safe_for_dry_run: true,
      safe_for_scheduled_automation_now: true,
      reason: "Reads DB mirror read-only and writes derived context packs; safe but should run after a DB sync."
    },
    {
      name: "aiTaskQueryRecipes",
      file_path: "src/services/aiTaskQueryRecipes.ts",
      source: "pipeline",
      category: "ai_query",
      current_status: "validated",
      collection_method: "A",
      bot_risk_level: "none",
      data_quality_level: "high",
      reads_external_network: false,
      writes_db: false,
      writes_history: false,
      requires_approval: false,
      safe_for_dry_run: true,
      safe_for_scheduled_automation_now: true,
      reason: "Read-only task query over context packs + DB mirror."
    },
    // ---- Property discovery ----
    {
      name: "propertyDiscoveryInventory",
      file_path: "src/services/propertyDiscoveryInventory.ts",
      source: "property_discovery",
      category: "property_discovery",
      current_status: "manual_cadence",
      collection_method: "B",
      bot_risk_level: "low",
      data_quality_level: "medium",
      reads_external_network: true,
      writes_db: false,
      writes_history: false,
      requires_approval: true,
      safe_for_dry_run: false,
      safe_for_scheduled_automation_now: false,
      reason: "Weekly/manual source inventory; no automatic active promotion and no immediate price-target expansion."
    }
  ];
}

// ---------------------------------------------------------------------------
// 5/7. Source-specific strategy
// ---------------------------------------------------------------------------

export function buildSourceStrategies(): SourceStrategy[] {
  return [
    {
      source: "jalan",
      preferred_method: "A",
      fallback_method: "C",
      bot_risk: "medium",
      data_quality: "high",
      notes: [
        "Prefer existing DP-safe / static extraction where possible.",
        "Use as the strongest/direct-capable confidence source (A only when basis_confidence is A).",
        "Keep coupon guard and sold_out handling.",
        "Micro-batch by date/property."
      ]
    },
    {
      source: "rakuten",
      preferred_method: "B",
      fallback_method: "C",
      bot_risk: "low",
      data_quality: "medium",
      notes: [
        "Prefer the corrected /hplan/calendar JSONP path.",
        "Avoid condition/booking page transitions.",
        "Treat as B-confidence directional unless basis is further confirmed.",
        "Watch for silent all-empty responses.",
        "Total is computed from per-person CHARGE_PER_HUMAN — never raw."
      ]
    },
    {
      source: "booking",
      preferred_method: "C",
      fallback_method: "none",
      bot_risk: "high",
      data_quality: "high",
      notes: [
        "Use rendered DOM only when necessary, with very small caps.",
        "No stealth / login / cookies.",
        "Expect higher cloud WAF risk; run a cloud smoke test before scheduling.",
        "Use official visible base + visible tax/fee adder — never a synthetic base × 1.1."
      ]
    },
    {
      source: "property_discovery",
      preferred_method: "B",
      fallback_method: "A",
      bot_risk: "low",
      data_quality: "medium",
      notes: [
        "Weekly or manual source inventory.",
        "No automatic active promotion.",
        "No immediate price-target expansion."
      ]
    }
  ];
}

// ---------------------------------------------------------------------------
// 10. Date window plan (plan-only — no fetch)
// ---------------------------------------------------------------------------

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
}

export function buildDateWindowPlan(todayJst: string): DateWindowPlan {
  const nearEnd = addDays(todayJst, 14);
  const nearDates: string[] = [];
  for (let i = 0; i <= 14; i++) nearDates.push(addDays(todayJst, i));

  const peakDates: string[] = [];
  for (let i = 0; i <= 90; i++) {
    const d = addDays(todayJst, i);
    const dow = dayOfWeek(d);
    if (dow === 5 || dow === 6) peakDates.push(d); // Fri/Sat (holidays added manually later)
  }

  const farStart = addDays(todayJst, 90);
  const farEnd = addDays(todayJst, 180);
  const farDates: string[] = [];
  for (let i = 90; i <= 180; i += 7) farDates.push(addDays(todayJst, i));

  return {
    near_term_daily: {
      description: "today_jst → today_jst + 14 days, to capture short-term movement and sold-out pressure.",
      start: todayJst,
      end: nearEnd,
      dates: nearDates
    },
    peak_weekly: {
      description: "Next 90 days Fridays/Saturdays (holidays/known peaks added manually) to capture medium-term demand waves.",
      horizon_days: 90,
      dates: peakDates
    },
    far_baseline: {
      description: "90→180 days out, weekly (or manual), to baseline future availability and price pulse.",
      start: farStart,
      end: farEnd,
      dates: farDates
    }
  };
}

// ---------------------------------------------------------------------------
// 11. Micro-batch constraints
// ---------------------------------------------------------------------------

export function buildMicroBatchConstraints(): MicroBatchConstraints {
  return {
    max_sources_per_run: 1,
    max_properties_per_source: 5,
    max_dates_per_property: 7,
    max_requests_per_run: 50,
    max_browser_pages_per_run: 10,
    source_timeout_ms: 30000,
    run_timeout_ms: 600000,
    justification: {
      max_sources_per_run: "One source per run isolates WAF risk and makes each run attributable to a single site.",
      max_properties_per_source: "3–5 properties keeps request volume low and human-reviewable.",
      max_dates_per_property: "2–7 dates per property covers a window without bursty traffic.",
      max_requests_per_run: "<=50 requests keeps a run well under any reasonable rate threshold.",
      max_browser_pages_per_run: "<=10 rendered pages caps the heaviest, highest-risk method.",
      source_timeout_ms: "30s per source avoids hanging on a blocked/slow page.",
      run_timeout_ms: "10min hard run cap bounds total exposure."
    },
    source_specific: {
      jalan: [
        "Use smaller property/date batches if pages are dynamic.",
        "Keep coupon/sold_out guard.",
        "Prefer static/public extraction where possible."
      ],
      rakuten: [
        "Direct JSONP requests are more efficient than browser.",
        "Cap requests and detect suspicious all-empty responses.",
        "Never follow reservation-adjacent links."
      ],
      booking: [
        "Rendered DOM is expensive and higher WAF risk.",
        "Keep very small browser page caps.",
        "Prefer smoke tests and local/manual runner before Actions."
      ],
      property_discovery: ["Weekly/manual cadence.", "No automatic active promotion."]
    }
  };
}

// ---------------------------------------------------------------------------
// 12. Normalized row contract (aligns with history/DB schema)
// ---------------------------------------------------------------------------

export const NORMALIZED_ROW_COLUMNS: string[] = [
  "row_id",
  "row_hash",
  "shard_month",
  "collected_date_jst",
  "collected_at_jst",
  "normalized_at_jst",
  "source",
  "canonical_property_name",
  "source_property_id",
  "source_url",
  "checkin_date",
  "checkout_date",
  "stay_scope",
  "availability_status",
  "sold_out_flag",
  "normalized_total_jpy",
  "price_basis",
  "basis_confidence",
  "dp_usage",
  "classification",
  "exclusion_reason",
  "debug_artifact_path",
  "schema_version",
  "raw_json"
];

export function buildNormalizedRowContract(): { schema_version: string; columns: string[] } {
  return { schema_version: "zao_local_history_v1", columns: NORMALIZED_ROW_COLUMNS };
}

// ---------------------------------------------------------------------------
// 11/13. Dry-run actions + downstream pipeline
// ---------------------------------------------------------------------------

export function buildDryRunActions(): DryRunAction[] {
  return [
    { step: 1, description: "Reuse existing artifacts/DB/context packs; only proceed externally if the task needs fresher data.", source: "all", method: "A", would_execute: false, reason: "Dry-run: no external access performed." },
    { step: 2, description: "If fresher data is needed, run Rakuten /hplan/calendar JSONP (Method B), 1 source, ≤5 properties, ≤7 dates, ≤50 requests.", source: "rakuten", method: "B", would_execute: false, reason: "Dry-run: bounded plan only; not executed." },
    { step: 3, description: "Run Jalan bounded collection (static-first, Method C fallback) micro-batched with coupon/sold_out guards.", source: "jalan", method: "A", would_execute: false, reason: "Dry-run: bounded plan only; not executed." },
    { step: 4, description: "Run Booking rendered DOM only if required, ≤10 pages, no stealth/login/cookies.", source: "booking", method: "C", would_execute: false, reason: "Dry-run: bounded plan only; not executed." },
    { step: 5, description: "Normalize collected rows into the zao_local_history_v1 contract (cross-source normalizer).", source: "all", method: "A", would_execute: false, reason: "Dry-run: no rows collected to normalize." },
    { step: 6, description: "history append DRY-RUN to validate the normalized rows (no write).", source: "pipeline", method: "A", would_execute: false, reason: "Dry-run: append dry-run is itself non-writing; real append is AUTO08X." }
  ];
}

export function buildDownstreamPipelinePlan(): string[] {
  return [
    "collector orchestration",
    "→ normalized rows (zao_local_history_v1)",
    "→ history append dry-run",
    "→ guarded history append real run (AUTO08X, explicit approval)",
    "→ DB mirror sync (history-to-db real run, explicit approval)",
    "→ AI context pack refresh (AUTO05X generator)",
    "→ AI task query available (AUTO06X recipes)",
    "NOTE: AUTO07X does NOT append history, does NOT sync DB, and does NOT refresh latest AI context packs — those are later phases."
  ];
}

// ---------------------------------------------------------------------------
// 14. Approval gates
// ---------------------------------------------------------------------------

export function buildApprovalGates(): ApprovalGate[] {
  return [
    { phase: "AUTO08X", gate: "First guarded auto history append real run", requires_explicit_approval: true },
    { phase: "AUTO09X", gate: "GitHub Actions / cloud WAF smoke test (if using cloud runner)", requires_explicit_approval: true },
    { phase: "AUTO10X", gate: "Scheduled activation proposal (proposal only)", requires_explicit_approval: false },
    { phase: "AUTO11X", gate: "Scheduled activation real run", requires_explicit_approval: true }
  ];
}

export function buildRisks(): string[] {
  return [
    "Cloud/data-center IP (GitHub Actions) carries high WAF/bot-detection risk for Booking/Rakuten/Jalan rendered pages — untested.",
    "Rakuten JSONP can return silent all-empty responses; a run must detect and flag this rather than emit empty rows as real data.",
    "Booking rendered DOM is the heaviest/highest-risk method; over-use risks blocks.",
    "DB mirror is thin (145 rows) so downstream confidence stays directional/B until coverage broadens.",
    "Any move to scheduled automation before a WAF smoke test risks silent, sustained blocking."
  ];
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideCollectorOrchestration(input: {
  methodCount: number;
  paidRejected: boolean;
  inventoryCount: number;
  liveCollectorsExecuted: boolean;
}): CollectorOrchestrationDecision {
  if (input.methodCount < 6 || !input.paidRejected || input.inventoryCount === 0) {
    return "collector_orchestration_dry_run_not_ready";
  }
  // The plan is generated but real collectors are not executed and cloud/WAF
  // risk remains untested → conservative caution.
  if (!input.liveCollectorsExecuted) return "collector_orchestration_dry_run_basis_caution";
  return "collector_orchestration_dry_run_ready";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, "\"\"")}"` : value;
}

export function renderInventoryCsv(rows: CollectorInventoryEntry[]): string {
  const headers = [
    "name",
    "file_path",
    "source",
    "category",
    "collection_method",
    "bot_risk_level",
    "data_quality_level",
    "reads_external_network",
    "writes_db",
    "writes_history",
    "requires_approval",
    "safe_for_dry_run",
    "safe_for_scheduled_automation_now"
  ];
  const body = rows.map((r) =>
    [
      r.name,
      r.file_path,
      r.source,
      r.category,
      r.collection_method,
      r.bot_risk_level,
      r.data_quality_level,
      String(r.reads_external_network),
      String(r.writes_db),
      String(r.writes_history),
      String(r.requires_approval),
      String(r.safe_for_dry_run),
      String(r.safe_for_scheduled_automation_now)
    ]
      .map(csvEscape)
      .join(",")
  );
  return `${headers.join(",")}\n${body.join("\n")}\n`;
}

export function renderOrchestrationReport(plan: OrchestrationDryRun): string {
  const m = plan.collection_method_comparison;
  const candidates = plan.candidate_collectors;
  return [
    "# Collector Orchestration Dry-Run / Low-Bot-Risk Collection Strategy",
    "",
    `Generated at: ${plan.generated_at_jst}`,
    `Decision: ${plan.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${plan.decision}`,
    "- This is a PLAN/dry-run only. No collectors were executed, no DB written, no history appended, no AI latest packs mutated.",
    `- ${m.length} collection methods compared; paid/proxy/CAPTCHA/stealth (Method F) explicitly rejected.`,
    "",
    "## 2. Current Automation Stack",
    "",
    "- Read-only AI layer: aiContextPackGenerator (AUTO05X) + aiTaskQueryRecipes (AUTO06X).",
    "- Pipeline (guarded): localHistoryRealAppend → historyToDbSyncRealRun → context refresh → task query.",
    "",
    "## 3. Collection Method Comparison",
    "",
    ...m.map((x) => `- [${x.id}] ${x.name} — bot_risk=${x.bot_risk}, cost=${x.cost}, quality=${x.data_quality}, status=${x.status}. ${x.expected_role}`),
    "",
    "## 4. Recommended Collection Strategy",
    "",
    ...plan.recommended_collection_strategy.map((s) => `- ${s}`),
    "",
    "## 5. Collector Inventory",
    "",
    `- ${plan.collector_inventory.length} scripts/services classified.`,
    ...plan.collector_inventory.map((r) => `- ${r.name} [${r.category}/${r.source}] method=${r.collection_method} bot_risk=${r.bot_risk_level} auto_ready=${r.safe_for_scheduled_automation_now}`),
    "",
    "## 6. Candidate Source Collectors",
    "",
    ...candidates.map((r) => `- ${r.name} (${r.source}) — ${r.reason}`),
    "",
    "## 7. Source-Specific Strategy",
    "",
    ...plan.source_specific_strategy.flatMap((s) => [
      `- ${s.source}: preferred=Method ${s.preferred_method}, fallback=${s.fallback_method}, bot_risk=${s.bot_risk}`,
      ...s.notes.map((n) => `  - ${n}`)
    ]),
    "",
    "## 8. Date Window Plan",
    "",
    `- near_term_daily: ${plan.date_window_plan.near_term_daily.start} → ${plan.date_window_plan.near_term_daily.end} (${plan.date_window_plan.near_term_daily.dates.length} dates)`,
    `- peak_weekly: next ${plan.date_window_plan.peak_weekly.horizon_days} days Fri/Sat (${plan.date_window_plan.peak_weekly.dates.length} dates)`,
    `- far_baseline: ${plan.date_window_plan.far_baseline.start} → ${plan.date_window_plan.far_baseline.end} (${plan.date_window_plan.far_baseline.dates.length} dates)`,
    "- Plan-only dates; none are fetched in AUTO07X.",
    "",
    "## 9. Micro-Batch Constraints",
    "",
    `- max_sources_per_run=${plan.micro_batch_constraints.max_sources_per_run}`,
    `- max_properties_per_source=${plan.micro_batch_constraints.max_properties_per_source}`,
    `- max_dates_per_property=${plan.micro_batch_constraints.max_dates_per_property}`,
    `- max_requests_per_run=${plan.micro_batch_constraints.max_requests_per_run}`,
    `- max_browser_pages_per_run=${plan.micro_batch_constraints.max_browser_pages_per_run}`,
    `- source_timeout_ms=${plan.micro_batch_constraints.source_timeout_ms}, run_timeout_ms=${plan.micro_batch_constraints.run_timeout_ms}`,
    "",
    "## 10. Normalized Row Contract",
    "",
    `- schema_version=${plan.normalized_row_contract.schema_version}`,
    `- columns (${plan.normalized_row_contract.columns.length}): ${plan.normalized_row_contract.columns.join(", ")}`,
    "",
    "## 11. Dry-Run Actions",
    "",
    ...plan.dry_run_actions.map((a) => `- step ${a.step} [${a.source}/${a.method}] would_execute=${a.would_execute}: ${a.description}`),
    "",
    "## 12. Downstream Pipeline Plan",
    "",
    ...plan.downstream_pipeline_plan.map((s) => `- ${s}`),
    "",
    "## 13. Approval Gates",
    "",
    ...plan.approval_gates.map((g) => `- ${g.phase}: ${g.gate} (explicit_approval=${g.requires_explicit_approval})`),
    "",
    "## 14. Risks",
    "",
    ...plan.risks.map((r) => `- ${r}`),
    "",
    "## 15. Safety Confirmation",
    "",
    ...Object.entries(plan.safety_confirmation).map(([k, v]) => `- ${k}=${v}`),
    "",
    "## 16. Next Phase",
    "",
    `- ${plan.next_phase}`,
    ""
  ].join("\n");
}

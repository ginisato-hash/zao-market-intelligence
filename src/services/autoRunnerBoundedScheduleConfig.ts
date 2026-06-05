// Phase AUTO-RUNNER05X - bounded collector schedule config proposal.
//
// Pure config/report helpers only. This module does not execute collectors,
// launch browsers, append history, sync DB, refresh AI context, install
// schedules, or generate pricing/PMS output.

export type AutoRunnerBoundedScheduleDecision =
  | "auto_runner_bounded_schedule_config_ready"
  | "auto_runner_bounded_schedule_config_basis_caution"
  | "auto_runner_bounded_schedule_config_not_ready";

export interface AutoRunner04xArtifactLike {
  decision?: string;
  current_state_summary?: CurrentStateSummary;
  risks?: string[];
}

export interface CurrentStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number; role: string };
  jalan: { rows: number; directional: number; excluded: number; direct: number; role: string };
  rakuten: { rows: number; role: string };
  known_cautions: string[];
}

export interface TargetInventory {
  booking_verified_slugs: Array<{ canonical_property_name: string; slug: string; status: "verified" }>;
  jalan_verified_yads: Array<{ canonical_property_name: string; yad_id: string; status: "verified" }>;
  manual_review_targets: Array<{ source: "booking" | "jalan"; canonical_property_name: string; reason: string }>;
}

export interface DateWindowPolicy {
  near_term_60d: {
    description: string;
    batch_strategy: string;
  };
  major_dates_1y: {
    categories: string[];
    batch_strategy: string;
  };
  manual_override_dates: {
    allowed: boolean;
    rule: string;
  };
}

export interface BatchPlan {
  plan_id: string;
  source: "booking" | "jalan";
  role: string;
  cadence: string;
  enabled_by_default: false;
  requires_global_gate: "ZMI_AUTORUN_ENABLED=1";
  requires_source_gate: "COLLECT_BOOKING=1" | "COLLECT_JALAN=1";
  targets: string[];
  date_window: string;
  max_properties_per_run: number;
  max_dates_per_property: number;
  max_pages_per_run: number;
  command_candidate: string;
  output: "preview_report_artifacts_only";
  excludes: string[];
}

export interface GateMatrixRow {
  gate: string;
  default_value: "0";
  applies_to: string[];
  behavior_when_missing: string;
}

export interface FailureBehavior {
  rules: string[];
}

export interface FutureRunnerIntegration {
  consuming_phase: string;
  integration_points: string[];
  not_included: string[];
}

export interface SafetyConfirmation {
  live_booking_collection: false;
  live_jalan_collection: false;
  playwright_launch: false;
  browser_automation: false;
  external_fetch: false;
  launchd_install: false;
  launchctl: false;
  cron: false;
  github_actions_creation: false;
  history_modification: false;
  history_append: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  git_add_commit_push: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  started_auto_runner06x: false;
}

export function buildCurrentStateSummary(input: AutoRunner04xArtifactLike): CurrentStateSummary {
  const current = input.current_state_summary;
  return {
    history_rows: current?.history_rows ?? 210,
    db_rows: current?.db_rows ?? 210,
    ai_context_rows: current?.ai_context_rows ?? 210,
    booking: current?.booking ?? { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary directional backbone" },
    jalan: current?.jalan ?? { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary domestic OTA signal" },
    rakuten: current?.rakuten ?? { rows: 126, role: "frozen / caution" },
    known_cautions: [...(current?.known_cautions ?? []), ...(input.risks ?? [])]
  };
}

export function buildTargetInventory(): TargetInventory {
  return {
    booking_verified_slugs: [
      { canonical_property_name: "蔵王国際ホテル", slug: "zao-kokusai", status: "verified" },
      { canonical_property_name: "蔵王四季のホテル", slug: "zao-shiki-no", status: "verified" },
      { canonical_property_name: "深山荘 高見屋", slug: "shinzanso-takamiya", status: "verified" }
    ],
    jalan_verified_yads: [
      { canonical_property_name: "ホテル喜らく", yad_id: "yad325153", status: "verified" },
      { canonical_property_name: "ル・ベール蔵王", yad_id: "yad328232", status: "verified" },
      { canonical_property_name: "HAMMOND", yad_id: "yad348320", status: "verified" },
      { canonical_property_name: "吉田屋", yad_id: "yad327282", status: "verified" },
      { canonical_property_name: "JURIN", yad_id: "yad332556", status: "verified" }
    ],
    manual_review_targets: [
      { source: "booking", canonical_property_name: "名湯リゾート ルーセント", reason: "Booking slug remains unverified for scheduled collection." },
      { source: "booking", canonical_property_name: "JURIN", reason: "Booking slug remains unverified for scheduled collection." },
      { source: "jalan", canonical_property_name: "OAKHILL", reason: "Jalan target was not included in verified AUTO03X/AUTO03B matrix." },
      { source: "jalan", canonical_property_name: "瑠璃倶楽", reason: "Jalan target requires manual source verification." }
    ]
  };
}

export function buildDateWindowPolicy(): DateWindowPolicy {
  return {
    near_term_60d: {
      description: "Rolling next 60 days for nearer price-pressure movement.",
      batch_strategy: "Split into rotating small batches; do not collect all dates in one run."
    },
    major_dates_1y: {
      categories: ["all Saturdays", "long weekends", "Obon", "autumn foliage peak", "early winter ski-start dates", "New Year / peak winter"],
      batch_strategy: "Split into named major-date batches A/B/C per source."
    },
    manual_override_dates: {
      allowed: true,
      rule: "Human may add special event dates to a reviewed batch plan; still subject to source page caps and gates."
    }
  };
}

export function buildBookingBatchPlans(inventory: TargetInventory = buildTargetInventory()): BatchPlan[] {
  const targets = inventory.booking_verified_slugs.map((target) => target.slug);
  return [
    bookingPlan("booking_near_term_rotating", "daily or 5x/week", targets, "near_term_60d rotating slice", 10),
    bookingPlan("booking_major_dates_a", "weekly", targets, "major_dates_1y A: Saturdays / long weekends", 10),
    bookingPlan("booking_major_dates_b", "weekly", targets, "major_dates_1y B: Obon / autumn foliage", 10),
    bookingPlan("booking_major_dates_c", "weekly", targets, "major_dates_1y C: early winter / New Year peak", 10)
  ];
}

export function buildJalanBatchPlans(inventory: TargetInventory = buildTargetInventory()): BatchPlan[] {
  const targets = inventory.jalan_verified_yads.map((target) => target.yad_id);
  return [
    jalanPlan("jalan_supplemental_rotating", "2-3x/week", targets, "near_term_60d rotating slice", 5),
    jalanPlan("jalan_major_dates_a", "weekly", targets, "major_dates_1y A: Saturdays / long weekends / Obon", 5),
    jalanPlan("jalan_major_dates_b", "weekly", targets, "major_dates_1y B: autumn foliage / winter peak", 5)
  ];
}

export function buildGateMatrix(): GateMatrixRow[] {
  return [
    { gate: "ZMI_AUTORUN_ENABLED", default_value: "0", applies_to: ["booking batch plans", "jalan batch plans"], behavior_when_missing: "skip safely and write disabled-gate run-state" },
    { gate: "COLLECT_BOOKING", default_value: "0", applies_to: ["booking batch plans"], behavior_when_missing: "skip Booking collection safely" },
    { gate: "COLLECT_JALAN", default_value: "0", applies_to: ["jalan batch plans"], behavior_when_missing: "skip Jalan collection safely" }
  ];
}

export function buildFailureBehavior(): FailureBehavior {
  return {
    rules: [
      "If gate missing: skip safely.",
      "If blocked/CAPTCHA/degraded page: mark batch failed, do not append, and do not retry aggressively.",
      "If screenshot missing: row cannot be B-confidence.",
      "If price missing: record failed/excluded and do not infer.",
      "If many failures: pause source schedule and require human review.",
      "If Mac wakes after missed run: do not catch up with burst."
    ]
  };
}

export function buildFutureRunnerIntegration(): FutureRunnerIntegration {
  return {
    consuming_phase: "AUTO-RUNNER06X or AUTO-RUNNER07X",
    integration_points: [
      "Read batch plan config by plan_id.",
      "Check ZMI_AUTORUN_ENABLED and source gate before planning any collector command.",
      "Emit preview/report artifacts only from collector batches.",
      "Hand off append, DB sync, AI context, and pricing steps to separately gated workflow stages."
    ],
    not_included: ["No live collector execution in AUTO-RUNNER05X.", "No launchd installation.", "No active plist file.", "No append/DB/context/pricing output."]
  };
}

export function buildRisks(current: CurrentStateSummary): string[] {
  return [
    "Live execution remains intentionally disabled.",
    "Date expansion logic is a future implementation detail.",
    "Always-on Mac runtime and WAF behavior remain unverified for scheduled operation.",
    "Manual-review targets must not be silently promoted into scheduled batches.",
    ...current.known_cautions
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    live_booking_collection: false,
    live_jalan_collection: false,
    playwright_launch: false,
    browser_automation: false,
    external_fetch: false,
    launchd_install: false,
    launchctl: false,
    cron: false,
    github_actions_creation: false,
    history_modification: false,
    history_append: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke: false,
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    git_add_commit_push: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    started_auto_runner06x: false
  };
}

export function decideAutoRunnerBoundedSchedule(input: {
  sourcePresent: boolean;
  inventory: TargetInventory;
  bookingPlans: readonly BatchPlan[];
  jalanPlans: readonly BatchPlan[];
}): AutoRunnerBoundedScheduleDecision {
  if (!input.sourcePresent || input.inventory.booking_verified_slugs.length < 3 || input.inventory.jalan_verified_yads.length < 5) {
    return "auto_runner_bounded_schedule_config_not_ready";
  }
  if (input.bookingPlans.every((plan) => plan.enabled_by_default === false) && input.jalanPlans.every((plan) => plan.enabled_by_default === false)) {
    return "auto_runner_bounded_schedule_config_basis_caution";
  }
  return "auto_runner_bounded_schedule_config_ready";
}

export function renderBatchPlanCsv(plans: readonly BatchPlan[]): string {
  const header = ["plan_id", "source", "role", "cadence", "enabled_by_default", "max_properties_per_run", "max_dates_per_property", "max_pages_per_run", "requires_source_gate", "output"];
  return [header.join(","), ...plans.map((plan) => header.map((key) => csvCell(String(plan[key as keyof BatchPlan] ?? ""))).join(","))].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: AutoRunnerBoundedScheduleDecision;
  sourceArtifactPath: string;
  current: CurrentStateSummary;
  inventory: TargetInventory;
  datePolicy: DateWindowPolicy;
  bookingPlans: readonly BatchPlan[];
  jalanPlans: readonly BatchPlan[];
  gates: readonly GateMatrixRow[];
  failure: FailureBehavior;
  integration: FutureRunnerIntegration;
  risks: readonly string[];
  safety: SafetyConfirmation;
}): string {
  return `# Bounded Collector Schedule Config Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

AUTO-RUNNER05X defines disabled-by-default bounded collector schedule config. It produces fixed Booking/Jalan batch plans and gate rules only; it runs no collection and performs no writes.

## 2. Source AUTO-RUNNER04X Result

- Artifact: ${input.sourceArtifactPath}
- Decision: ${input.decision}

## 3. Current State

${JSON.stringify(input.current, null, 2)}

## 4. Target Inventory

- Booking verified slugs: ${input.inventory.booking_verified_slugs.map((item) => item.slug).join(", ")}
- Jalan verified yads: ${input.inventory.jalan_verified_yads.map((item) => item.yad_id).join(", ")}
- Manual review targets: ${input.inventory.manual_review_targets.length}

## 5. Date Window Policy

${JSON.stringify(input.datePolicy, null, 2)}

## 6. Booking Batch Plans

${input.bookingPlans.map((plan) => `- ${plan.plan_id}: max_pages=${plan.max_pages_per_run}, gate=${plan.requires_source_gate}`).join("\n")}

## 7. Jalan Batch Plans

${input.jalanPlans.map((plan) => `- ${plan.plan_id}: max_pages=${plan.max_pages_per_run}, gate=${plan.requires_source_gate}`).join("\n")}

## 8. Gate Matrix

${input.gates.map((gate) => `- ${gate.gate}=0 default: ${gate.behavior_when_missing}`).join("\n")}

## 9. Failure Behavior

${input.failure.rules.map((rule) => `- ${rule}`).join("\n")}

## 10. Future Runner Integration

${input.integration.integration_points.map((point) => `- ${point}`).join("\n")}

## 11. Risks

${input.risks.map((risk) => `- ${risk}`).join("\n")}

## 12. Safety Confirmation

${JSON.stringify(input.safety, null, 2)}

## 13. Decision

${input.decision}

## 14. Next Phase

AUTO-RUNNER06X — GitHub artifact sync / release archive proposal. Do not start without explicit instruction.
`;
}

function bookingPlan(planId: string, cadence: string, targets: string[], dateWindow: string, maxDatesPerProperty: number): BatchPlan {
  return {
    plan_id: planId,
    source: "booking",
    role: "primary directional backbone",
    cadence,
    enabled_by_default: false,
    requires_global_gate: "ZMI_AUTORUN_ENABLED=1",
    requires_source_gate: "COLLECT_BOOKING=1",
    targets,
    date_window: dateWindow,
    max_properties_per_run: 3,
    max_dates_per_property: maxDatesPerProperty,
    max_pages_per_run: 30,
    command_candidate: "npm run manual-run:market-workflow -- --stage booking-small-batch --plan " + planId,
    output: "preview_report_artifacts_only",
    excludes: ["history append", "DB sync", "AI context refresh", "pricing CSV", "PMS/Beds24/AirHost output"]
  };
}

function jalanPlan(planId: string, cadence: string, targets: string[], dateWindow: string, maxDatesPerProperty: number): BatchPlan {
  return {
    plan_id: planId,
    source: "jalan",
    role: "supplementary domestic OTA signal",
    cadence,
    enabled_by_default: false,
    requires_global_gate: "ZMI_AUTORUN_ENABLED=1",
    requires_source_gate: "COLLECT_JALAN=1",
    targets,
    date_window: dateWindow,
    max_properties_per_run: 5,
    max_dates_per_property: maxDatesPerProperty,
    max_pages_per_run: 25,
    command_candidate: "npm run manual-run:market-workflow -- --stage jalan-small-batch --plan " + planId,
    output: "preview_report_artifacts_only",
    excludes: ["history append", "DB sync", "AI context refresh", "pricing CSV", "PMS/Beds24/AirHost output"]
  };
}

function csvCell(value: string): string {
  if (!/[",\n]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

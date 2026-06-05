// Phase AUTO01X — automated DB update + AI retrieval architecture plan.
//
// Planning only. No DB writes, no collectors, no workflow creation, no GitOps
// push, no history/master mutation, no external fetch, and no PMS/channel output.

export type AutomatedDbAiRetrievalDecision =
  | "automated_db_ai_retrieval_plan_ready"
  | "automated_db_ai_retrieval_plan_basis_caution"
  | "automated_db_ai_retrieval_plan_not_ready";

export interface CurrentState {
  aiManifestDecision: string;
  dataDictionaryDecision: string;
  gitopsDesignDecision: string;
  localHistoryRealAppendDecision: string;
  localHistoryValidationPolicyDecision: string;
  historyFileCount: number;
  historyRowCount: number;
  dbRelatedScriptCount: number;
  dbBaseline: {
    collectorRunsCount: number;
    rateSnapshotsCount: number;
    inventorySnapshotsCount: number;
    collectionJobAttemptsCount: number;
  };
}

export interface ExistingAssets {
  aiManifestAndDictionary: string[];
  historyAppendAssets: string[];
  gitopsAssets: string[];
  dbRelatedAssets: string[];
  readOnlyProbeScripts: string[];
  collectorScripts: string[];
}

export interface ArchitectureOption {
  option: "A" | "B" | "C" | "D";
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  recommendation: "recommended" | "not_first" | "supporting_reference";
}

export interface AiReadableView {
  name: string;
  purpose: string;
  source: string;
  guardrail: string;
}

export interface ContextPack {
  path: string;
  purpose: string;
  source: string;
  editPolicy: string;
}

export interface QueryRecipe {
  name: string;
  input: string[];
  output: string[];
  guardrail: string;
}

export interface RoadmapPhase {
  phase: string;
  goal: string;
  writesAllowed: string;
  approvalGate: string;
  successCriteria: string;
}

export interface AutomatedDbAiRetrievalPlan {
  run_id: string;
  generated_at_jst: string;
  decision: AutomatedDbAiRetrievalDecision;
  final_goal: string;
  current_state: CurrentState;
  existing_assets: ExistingAssets;
  option_comparison: ArchitectureOption[];
  recommended_architecture: {
    summary: string;
    canonicalStore: string;
    queryStore: string;
    retrievalInterface: string;
    firstStepsNotAllowed: string[];
  };
  db_auto_update_target_state: string;
  ai_retrieval_layer: string[];
  ai_readable_views: AiReadableView[];
  context_packs: ContextPack[];
  task_query_recipes: QueryRecipe[];
  phased_roadmap: RoadmapPhase[];
  safety_gates: string[];
  approval_points: string[];
  risks: string[];
  next_phase: string;
  safety_confirmation: Record<string, boolean>;
}

export const AI_READABLE_VIEWS: AiReadableView[] = [
  {
    name: "v_ai_market_daily_summary",
    purpose: "Date-level source/property counts, availability, price medians, confidence, and caveats.",
    source: "DB mirror derived from validated history shards",
    guardrail: "B-confidence rows remain directional; excluded rows stay out of medians."
  },
  {
    name: "v_ai_property_latest_signal",
    purpose: "Latest market signal by canonical property and source.",
    source: "DB mirror plus property/source mapping context",
    guardrail: "Do not infer actual occupancy from OTA stock."
  },
  {
    name: "v_ai_date_demand_index",
    purpose: "DP01X/DP02X demand index values by stay date.",
    source: "Demand Index rows derived from history",
    guardrail: "Prototype/advisory until calibrated."
  },
  {
    name: "v_ai_sold_out_pressure",
    purpose: "Sold-out pressure dates and source coverage.",
    source: "History availability_status and sold_out_status",
    guardrail: "Sold-out pressure is a market signal, not full occupancy."
  },
  {
    name: "v_ai_price_pressure",
    purpose: "Direct and directional price pressure by date/source/property.",
    source: "History price/basis fields",
    guardrail: "Only direct/A-confidence rows are strong price signals."
  },
  {
    name: "v_ai_source_quality_summary",
    purpose: "Source counts, confidence mix, excluded rows, and known caveats.",
    source: "History + data dictionary",
    guardrail: "Weak sources should not be promoted silently."
  },
  {
    name: "v_ai_property_master_context",
    purpose: "Canonical property, aliases, source IDs, coverage, duplicate/excluded context.",
    source: "Property universe/source candidates/alias map/excluded audit",
    guardrail: "Candidates are not confirmed unless verification status supports it."
  },
  {
    name: "v_ai_task_context_latest",
    purpose: "Compact latest context for future AI task bootstrap.",
    source: "Manifest, data dictionary, DB mirror status, context packs",
    guardrail: "Read first before performing task-specific analysis."
  }
];

export const CONTEXT_PACKS: ContextPack[] = [
  {
    path: ".data/ai-context/latest_market_snapshot.json",
    purpose: "Current market summary for quick future AI bootstrap.",
    source: "Derived from AI DB views or history mirror",
    editPolicy: "derived artifact; do not manually edit"
  },
  {
    path: ".data/ai-context/latest_property_master_context.json",
    purpose: "Canonical properties, aliases, source IDs, and caveats.",
    source: "Derived from property universe exports",
    editPolicy: "derived artifact; do not manually edit"
  },
  {
    path: ".data/ai-context/latest_demand_index_context.json",
    purpose: "Latest demand index and posture/caveat summary.",
    source: "Derived from Demand Index outputs",
    editPolicy: "derived artifact; do not manually edit"
  },
  {
    path: ".data/ai-context/latest_caveats_and_guardrails.json",
    purpose: "Confidence, dp_usage, source-basis, and approval guardrails.",
    source: "Derived from manifest/data dictionary",
    editPolicy: "derived artifact; do not manually edit"
  }
];

export const TASK_QUERY_RECIPES: QueryRecipe[] = [
  {
    name: "market_report_task",
    input: ["date_range", "area", "confidence_minimum"],
    output: ["market_summary", "high_demand_dates", "weak_demand_dates", "sold_out_pressure", "source_caveats"],
    guardrail: "Summarize confidence and caveats; do not output PMS updates."
  },
  {
    name: "pricing_support_task",
    input: ["property_name", "date_range", "current_own_inventory_if_provided"],
    output: ["demand_signal", "competitor_pressure", "pricing_posture", "caution_flags"],
    guardrail: "Do not auto-update PMS or use B-confidence rows as final price commands."
  },
  {
    name: "data_quality_task",
    input: ["property_name_or_source_id"],
    output: ["source_mapping", "aliases", "duplicate_risk", "source_coverage"],
    guardrail: "Do not promote source candidates without explicit review."
  },
  {
    name: "ai_context_bootstrap_task",
    input: ["none"],
    output: ["latest_manifest", "latest_data_dictionary", "latest_db_view_status", "latest_caveats"],
    guardrail: "Use curated context packs/views before raw file hunting."
  }
];

export const ROADMAP_PHASES: RoadmapPhase[] = [
  {
    phase: "AUTO02X",
    goal: "DB schema + AI-readable views design.",
    writesAllowed: "design/report artifacts only",
    approvalGate: "no DB mutation",
    successCriteria: "History-to-DB mirror schema, AI views, and context-pack contracts are approved."
  },
  {
    phase: "AUTO03X",
    goal: "History-to-DB sync dry-run.",
    writesAllowed: "dry-run report only",
    approvalGate: "no DB mutation",
    successCriteria: "Validated history rows produce deterministic DB upsert/diff plan."
  },
  {
    phase: "AUTO04X",
    goal: "First guarded DB mirror sync real run.",
    writesAllowed: "DB mirror sync only after explicit approval",
    approvalGate: "DB backup/rollback and idempotency proof required",
    successCriteria: "DB mirror is populated from history shards without collector raw writes."
  },
  {
    phase: "AUTO05X",
    goal: "AI context pack generator.",
    writesAllowed: ".data/ai-context derived artifacts only",
    approvalGate: "no source-of-truth mutation",
    successCriteria: "Future AI can read compact JSON context packs."
  },
  {
    phase: "AUTO06X",
    goal: "Task-specific query recipes / CLI.",
    writesAllowed: "read-only query/report artifacts only",
    approvalGate: "no pricing/PMS side effects",
    successCriteria: "Market report, pricing support, data-quality, and bootstrap tasks have query recipes."
  },
  {
    phase: "AUTO07X",
    goal: "Collector orchestration dry-run.",
    writesAllowed: "dry-run normalized rows only",
    approvalGate: "no history/DB mutation",
    successCriteria: "Daily collector output can normalize into history schema."
  },
  {
    phase: "AUTO08X",
    goal: "First guarded auto history append run.",
    writesAllowed: ".data/history or approved data repo only after explicit approval",
    approvalGate: "history append validation, dedupe, and conflict checks",
    successCriteria: "Validated collector rows append to canonical history."
  },
  {
    phase: "AUTO09X",
    goal: "GitHub Actions / cloud WAF smoke test.",
    writesAllowed: "smoke-test report only",
    approvalGate: "no schedule activation",
    successCriteria: "Cloud access risk is understood before scheduling."
  },
  {
    phase: "AUTO10X",
    goal: "Scheduled activation proposal.",
    writesAllowed: "proposal/draft only",
    approvalGate: "no workflow activation",
    successCriteria: "Schedule, caps, retry, alerting, and rollback are approved."
  },
  {
    phase: "AUTO11X",
    goal: "Scheduled activation real run with approval.",
    writesAllowed: "workflow/schedule only after explicit approval",
    approvalGate: "explicit activation approval",
    successCriteria: "Controlled schedule updates history, DB mirror, views, and context packs."
  }
];

export function buildAutomatedDbAiRetrievalPlan(input: {
  runId: string;
  generatedAtJst: string;
  currentState: CurrentState;
  packageScripts: Record<string, string>;
}): AutomatedDbAiRetrievalPlan {
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: decideAutomatedDbAiRetrievalPlan(input.currentState),
    final_goal:
      "Build an automatically updated market-intelligence DB/context system that future AI agents can query or read to complete the user-requested task at that time, with no write/action side effects unless explicitly approved.",
    current_state: input.currentState,
    existing_assets: classifyExistingAssets(input.packageScripts),
    option_comparison: architectureOptions(),
    recommended_architecture: {
      summary:
        "Recommended architecture: canonical append log = .data/history monthly shards; AI query datastore = DB mirror rebuilt/synced from validated history; AI retrieval = views, query recipes, and derived context packs.",
      canonicalStore: ".data/history monthly shards remain the audit-grade canonical append log.",
      queryStore: "DB mirror/query datastore is derived from validated history shards and can be rebuilt if corrupted.",
      retrievalInterface: "AI-readable DB views plus JSON context packs and task-specific query recipes.",
      firstStepsNotAllowed: [
        "Do not start with direct raw collector DB writes.",
        "Do not start with scheduled GitHub Actions activation.",
        "Do not dual-write collectors to history and DB in the first implementation."
      ]
    },
    db_auto_update_target_state:
      "Collectors run on a controlled schedule; raw/source-specific data is normalized; normalized rows append to canonical history; DB mirror syncs from history; AI views and context packs refresh; future AI reads curated views/context packs to complete tasks; no write/action side effects occur without explicit approval.",
    ai_retrieval_layer: [
      "AI-readable database views",
      "Task-specific query recipes",
      "JSON context pack generation",
      "Schema dictionary linkage",
      "Confidence and dp_usage guardrails",
      "Approval gates for write actions"
    ],
    ai_readable_views: AI_READABLE_VIEWS,
    context_packs: CONTEXT_PACKS,
    task_query_recipes: TASK_QUERY_RECIPES,
    phased_roadmap: ROADMAP_PHASES,
    safety_gates: [
      "History-to-DB sync dry-run before DB real sync.",
      "DB mirror sync from validated history before any direct collector-to-DB write.",
      "WAF smoke test before scheduled cloud activation.",
      "Manual approval before workflow creation or activation.",
      "Manual approval before first real history append automation.",
      "Manual approval before any DB real sync.",
      "Backups and rollback path before real writes.",
      "No paid APIs, CAPTCHA bypass, stealth, login, or cookie injection.",
      "No PMS/Beds24/AirHost output without explicit approval."
    ],
    approval_points: [
      "AUTO04X first real DB mirror sync.",
      "AUTO08X first guarded auto history append.",
      "AUTO10X scheduled activation proposal acceptance.",
      "AUTO11X scheduled activation real run.",
      "Any direct collector-to-DB write path.",
      "Any PMS/OTA/export or pricing-action behavior."
    ],
    risks: [
      "Git growth risk from history shard commits; mitigate with monthly shards, data repo separation, and compaction policy.",
      "Cloud-run WAF risk for Booking/Rakuten; mitigate with AUTO09X smoke test before schedule activation.",
      "Direct DB corruption risk if raw collectors write unvalidated rows; mitigate with history canonical log and DB mirror rebuildability.",
      "DB/history inconsistency risk; mitigate with one-way history-to-DB sync status tracking.",
      "AI over-inference risk; mitigate with curated views/context packs, confidence semantics, and data dictionary guardrails.",
      "Current history is thin and many rows are B-confidence/directional."
    ],
    next_phase: "AUTO02X — DB schema + AI-readable views design",
    safety_confirmation: {
      dbWrites: false,
      liveExternalFetch: false,
      collectorRun: false,
      workflowCreatedOrActivated: false,
      cronActivated: false,
      gitCommitOrPush: false,
      dataRepoCreated: false,
      historyModified: false,
      propertyMasterModified: false,
      pmsOrChannelOutput: false,
      priceUpdate: false,
      paidSourceTooling: false
    }
  };
}

export function classifyExistingAssets(packageScripts: Record<string, string>): ExistingAssets {
  const names = Object.keys(packageScripts).sort();
  return {
    aiManifestAndDictionary: names.filter((s) => s.includes("ai-readable") || s.includes("market-data-dictionary")),
    historyAppendAssets: names.filter((s) => s.includes("local-history")),
    gitopsAssets: names.filter((s) => s.includes("gitops")),
    dbRelatedAssets: names.filter((s) => s.includes("db:") || s.includes("cf:d1") || s === "market:compute" || s === "quality:compute"),
    readOnlyProbeScripts: names.filter((s) => s.startsWith("probe:") || s.startsWith("feasibility:")),
    collectorScripts: names.filter((s) => s.startsWith("collect:"))
  };
}

export function architectureOptions(): ArchitectureOption[] {
  return [
    {
      option: "A",
      name: "History-shard-first, then AI retrieval layer",
      description: "Collectors append normalized rows to .data/history; AI-readable views/context packs are generated from history; DB sync comes later.",
      pros: ["Existing M02X-M06X guardrails already work.", "Rollback is file-based.", "Dedupe/conflict logic already exists.", "Safe intermediate step."],
      cons: ["Not a true query DB yet.", "AI may still need file parsing unless query packs are generated."],
      recommendation: "supporting_reference"
    },
    {
      option: "B",
      name: "DB-first with AI views",
      description: "Collectors write normalized rows directly into DB; DB exposes AI-readable tables/views and context packs.",
      pros: ["Best long-term queryability.", "Can support direct task-specific queries.", "Cleaner than parsing CSV forever."],
      cons: ["Higher risk if schema or writes are wrong.", "Requires migrations, rollback, idempotency, and view design.", "DB corruption risk is higher."],
      recommendation: "not_first"
    },
    {
      option: "C",
      name: "History canonical + DB mirror",
      description: "History shards remain canonical append log; DB is a derived mirror for AI retrieval; DB can be rebuilt from history.",
      pros: ["Best balance.", "History provides audit log.", "DB provides queryability.", "AI gets stable views.", "DB can be rebuilt."],
      cons: ["More components.", "Must prevent inconsistency.", "Need sync status tracking."],
      recommendation: "recommended"
    },
    {
      option: "D",
      name: "Dual-write collectors",
      description: "Collectors write history shards and DB in one run.",
      pros: ["Immediate parity."],
      cons: ["Highest consistency risk.", "Two failure modes.", "Hard rollback.", "Not recommended initially."],
      recommendation: "not_first"
    }
  ];
}

export function decideAutomatedDbAiRetrievalPlan(state: CurrentState): AutomatedDbAiRetrievalDecision {
  if (state.historyFileCount === 0 || state.historyRowCount === 0) return "automated_db_ai_retrieval_plan_not_ready";
  if (state.dataDictionaryDecision !== "market_data_dictionary_ready") return "automated_db_ai_retrieval_plan_basis_caution";
  return "automated_db_ai_retrieval_plan_ready";
}

export function renderAutomatedDbAiRetrievalCsv(plan: AutomatedDbAiRetrievalPlan): string {
  const headers = ["section", "key", "value"];
  const rows: string[][] = [
    ["summary", "decision", plan.decision],
    ["summary", "final_goal", plan.final_goal],
    ["summary", "recommended_architecture", plan.recommended_architecture.summary],
    ["summary", "next_phase", plan.next_phase],
    ...plan.option_comparison.map((o) => ["option", o.option, `${o.name}: ${o.recommendation}`]),
    ...plan.ai_readable_views.map((v) => ["ai_view", v.name, v.purpose]),
    ...plan.context_packs.map((p) => ["context_pack", p.path, p.purpose]),
    ...plan.task_query_recipes.map((r) => ["query_recipe", r.name, r.guardrail]),
    ...plan.phased_roadmap.map((r) => ["roadmap", r.phase, r.goal])
  ];
  return `${headers.join(",")}\n${rows.map((r) => r.map(csvEscape).join(",")).join("\n")}\n`;
}

export function renderAutomatedDbAiRetrievalReport(plan: AutomatedDbAiRetrievalPlan): string {
  return [
    "# Automated DB Update + AI Retrieval Architecture Plan",
    "",
    `Generated at: ${plan.generated_at_jst}`,
    `Decision: ${plan.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    plan.recommended_architecture.summary,
    "",
    "## 2. Final Goal",
    "",
    plan.final_goal,
    "",
    "## 3. Current System State",
    "",
    `- AI manifest decision=${plan.current_state.aiManifestDecision}`,
    `- data dictionary decision=${plan.current_state.dataDictionaryDecision}`,
    `- GitOps design decision=${plan.current_state.gitopsDesignDecision}`,
    `- local history real append decision=${plan.current_state.localHistoryRealAppendDecision}`,
    `- history files=${plan.current_state.historyFileCount}`,
    `- history rows=${plan.current_state.historyRowCount}`,
    `- DB baseline collector_runs=${plan.current_state.dbBaseline.collectorRunsCount}, rate_snapshots=${plan.current_state.dbBaseline.rateSnapshotsCount}, inventory_snapshots=${plan.current_state.dbBaseline.inventorySnapshotsCount}, attempts=${plan.current_state.dbBaseline.collectionJobAttemptsCount}`,
    "",
    "## 4. Existing Assets Ready for Automation",
    "",
    `- AI manifest/dictionary assets: ${plan.existing_assets.aiManifestAndDictionary.join(", ") || "-"}`,
    `- history append assets: ${plan.existing_assets.historyAppendAssets.join(", ") || "-"}`,
    `- GitOps assets: ${plan.existing_assets.gitopsAssets.join(", ") || "-"}`,
    `- DB-related assets: ${plan.existing_assets.dbRelatedAssets.join(", ") || "-"}`,
    `- read-only probes: ${plan.existing_assets.readOnlyProbeScripts.join(", ") || "-"}`,
    `- collector scripts: ${plan.existing_assets.collectorScripts.join(", ") || "-"}`,
    "",
    "## 5. Architecture Option Comparison",
    "",
    ...plan.option_comparison.flatMap((o) => [
      `### Option ${o.option} — ${o.name}`,
      `- description=${o.description}`,
      `- pros=${o.pros.join(" | ")}`,
      `- cons=${o.cons.join(" | ")}`,
      `- recommendation=${o.recommendation}`,
      ""
    ]),
    "## 6. Recommended Architecture",
    "",
    `- summary=${plan.recommended_architecture.summary}`,
    `- canonical_store=${plan.recommended_architecture.canonicalStore}`,
    `- query_store=${plan.recommended_architecture.queryStore}`,
    `- retrieval_interface=${plan.recommended_architecture.retrievalInterface}`,
    ...plan.recommended_architecture.firstStepsNotAllowed.map((s) => `- ${s}`),
    "",
    "## 7. DB Auto-update Target State",
    "",
    plan.db_auto_update_target_state,
    "",
    "## 8. AI Retrieval Layer",
    "",
    ...plan.ai_retrieval_layer.map((l) => `- ${l}`),
    "",
    "## 9. AI-readable Views / Context Packs",
    "",
    ...plan.ai_readable_views.map((v) => `- ${v.name}: ${v.purpose}; source=${v.source}; guardrail=${v.guardrail}`),
    ...plan.context_packs.map((p) => `- ${p.path}: ${p.purpose}; source=${p.source}; policy=${p.editPolicy}`),
    "",
    "## 10. Task-specific Query Recipes",
    "",
    ...plan.task_query_recipes.map((r) => `- ${r.name}: input=${r.input.join(", ")}; output=${r.output.join(", ")}; guardrail=${r.guardrail}`),
    "",
    "## 11. Why Not Direct DB First",
    "",
    "- Direct raw collector DB writes are not recommended first because bad source output could corrupt the query store before history validation catches it.",
    "- Use history-to-DB sync before any direct collector-to-DB write.",
    "",
    "## 12. Why Not Scheduled GitHub Actions First",
    "",
    "- Scheduled cloud collection should wait for WAF smoke tests and manual-trigger proof.",
    "- No workflow files are created or activated in AUTO01X.",
    "",
    "## 13. Phased Roadmap",
    "",
    ...plan.phased_roadmap.map((r) => `- ${r.phase}: ${r.goal}; writes=${r.writesAllowed}; gate=${r.approvalGate}; success=${r.successCriteria}`),
    "",
    "## 14. Safety Gates",
    "",
    ...plan.safety_gates.map((g) => `- ${g}`),
    "",
    "## 15. Required Approval Points",
    "",
    ...plan.approval_points.map((p) => `- ${p}`),
    "",
    "## 16. Risks",
    "",
    ...plan.risks.map((r) => `- ${r}`),
    "",
    "## 17. Next Phase: AUTO02X",
    "",
    `- ${plan.next_phase}`,
    "",
    "## 18. Safety Confirmation",
    "",
    ...Object.entries(plan.safety_confirmation).map(([k, v]) => `- ${k}=${v ? "true" : "false"}`),
    ""
  ].join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

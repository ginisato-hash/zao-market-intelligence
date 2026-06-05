// Phase AUTO02X — DB schema + AI-readable views design.
//
// Design/report generation only. This module does not execute SQL, open the DB,
// create migrations, mutate history/property exports, run collectors, or fetch
// live pages.

export type DbAiViewsSchemaDesignDecision =
  | "db_ai_views_schema_design_ready"
  | "db_ai_views_schema_design_basis_caution"
  | "db_ai_views_schema_design_not_ready";

export interface SourceArtifact {
  path: string;
  purpose: string;
  inspected: boolean;
}

export interface ColumnDesign {
  name: string;
  type: string;
  constraints: string;
  purpose: string;
}

export interface TableDesign {
  name: string;
  purpose: string;
  source_of_truth: string;
  columns: ColumnDesign[];
  notes: string[];
}

export interface IndexDesign {
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
  purpose: string;
}

export interface ViewDesign {
  name: string;
  grain: string;
  purpose: string;
  columns: string[];
  guardrails: string[];
}

export interface QueryRecipe {
  name: string;
  purpose: string;
  input: string[];
  sample_sql: string;
  caveats: string[];
}

export interface DbAiViewsSchemaDesign {
  run_id: string;
  generated_at_jst: string;
  decision: DbAiViewsSchemaDesignDecision;
  source_artifacts: SourceArtifact[];
  table_designs: TableDesign[];
  index_designs: IndexDesign[];
  view_designs: ViewDesign[];
  query_recipes: QueryRecipe[];
  rebuild_strategy: string[];
  context_pack_strategy: string[];
  approval_gates: string[];
  draft_sql_paths: {
    schema_draft_sql: string;
    views_draft_sql: string;
    location_policy: string;
  };
  risks: string[];
  next_phase: string;
  safety_confirmation: Record<string, boolean>;
}

export const REQUIRED_QUERY_CAVEATS = [
  "Do not treat B-confidence as automated pricing signal.",
  "Do not infer actual occupancy from OTA stock.",
  "Do not infer restaurant footfall from lodging-derived congestion.",
  "Do not update PMS/OTA from query results."
] as const;

export const SOURCE_ARTIFACTS: SourceArtifact[] = [
  {
    path: ".data/reports/automation/automated_db_ai_retrieval_plan_20260603_214830.json",
    purpose: "AUTO01X architecture recommendation and AI retrieval target.",
    inspected: true
  },
  {
    path: ".data/reports/market-update/ai_readable_market_manifest_latest.json",
    purpose: "Current project entrypoint, latest pointers, and caveats.",
    inspected: true
  },
  {
    path: ".data/reports/market-update/market_data_dictionary_latest.json",
    purpose: "Column semantics, source-basis rules, and AI usage guardrails.",
    inspected: true
  },
  {
    path: ".data/history/zao_signals_*.csv",
    purpose: "Canonical append log to mirror into DB.",
    inspected: true
  },
  {
    path: "src/db/schema.ts, src/db/client.ts, src/db/migrations/*.sql",
    purpose: "Existing DB mechanism inspected for design compatibility only; no SQL execution.",
    inspected: true
  },
  {
    path: "package.json, src/services/*, src/scripts/*",
    purpose: "Existing scripts inspected to distinguish collectors, report builders, and DB utilities.",
    inspected: true
  }
];

export function tableDesigns(): TableDesign[] {
  return [
    {
      name: "market_signal_history",
      purpose: "DB mirror of .data/history monthly shard rows.",
      source_of_truth: ".data/history/zao_signals_YYYY_MM.csv",
      columns: [
        col("row_id", "TEXT", "PRIMARY KEY", "Stable row identity from the history append log."),
        col("row_hash", "TEXT", "NOT NULL", "Content hash used to detect identical rows versus conflicts."),
        col("shard_month", "TEXT", "NOT NULL", "History shard month, for rebuild/debug partitioning."),
        col("collected_date_jst", "TEXT", "", "Collection date in JST."),
        col("collected_at_jst", "TEXT", "", "Collection timestamp in JST."),
        col("normalized_at_jst", "TEXT", "", "Normalization timestamp in JST."),
        col("source", "TEXT", "NOT NULL", "Source channel such as jalan, rakuten, or booking."),
        col("canonical_property_name", "TEXT", "", "Canonical lodging property name."),
        col("source_property_id", "TEXT", "", "Source-specific property identifier."),
        col("source_url", "TEXT", "", "Source URL when available."),
        col("checkin_date", "TEXT", "", "Stay check-in date."),
        col("checkout_date", "TEXT", "", "Stay check-out date."),
        col("stay_scope", "TEXT", "", "Stay scope such as 2 adults / 1 room / 1 night."),
        col("availability_status", "TEXT", "", "available, sold_out, not_listed, excluded, or equivalent normalized status."),
        col("sold_out_flag", "INTEGER", "", "1 when sold-out pressure is present, otherwise 0/null."),
        col("normalized_total_jpy", "INTEGER", "", "Normalized total JPY when safe enough for its dp_usage class."),
        col("price_basis", "TEXT", "", "Source-specific price basis or total/per-person interpretation."),
        col("basis_confidence", "TEXT", "", "A/B/C/insufficient confidence guardrail."),
        col("dp_usage", "TEXT", "", "direct, directional, or excluded demand/pricing usage class."),
        col("classification", "TEXT", "", "Normalized row classification."),
        col("exclusion_reason", "TEXT", "", "Reason a row is excluded from direct pricing medians."),
        col("debug_artifact_path", "TEXT", "", "Local debug artifact pointer."),
        col("schema_version", "TEXT", "", "History schema version."),
        col("raw_json", "TEXT", "", "Original history row payload for rebuild/debug."),
        col("created_at", "TEXT", "", "DB mirror insertion timestamp."),
        col("updated_at", "TEXT", "", "DB mirror update timestamp, only for metadata corrections after approved sync.")
      ],
      notes: [
        "row_id is the primary identity.",
        "row_hash detects changes/conflicts.",
        "raw_json keeps the original row payload so the mirror can be audited and rebuilt."
      ]
    },
    {
      name: "market_signal_sync_runs",
      purpose: "Track history-to-DB sync runs and their idempotency/conflict outcome.",
      source_of_truth: "Sync process reports derived from .data/history.",
      columns: [
        col("sync_run_id", "TEXT", "PRIMARY KEY", "Stable sync run identifier."),
        col("started_at", "TEXT", "", "Sync start timestamp."),
        col("finished_at", "TEXT", "", "Sync finish timestamp."),
        col("status", "TEXT", "", "dry_run, success, blocked_conflict, failed, or rolled_back."),
        col("source_history_files", "TEXT", "", "JSON list of source history shard files."),
        col("input_rows", "INTEGER", "", "Total input rows read from history shards."),
        col("inserted_rows", "INTEGER", "", "New mirror rows inserted."),
        col("skipped_identical_rows", "INTEGER", "", "Existing row_id + same row_hash rows skipped."),
        col("conflict_rows", "INTEGER", "", "Existing row_id + different row_hash rows that block sync."),
        col("error_message", "TEXT", "", "Failure or conflict summary."),
        col("report_path", "TEXT", "", "Local sync report path."),
        col("created_at", "TEXT", "", "Sync-run metadata creation timestamp.")
      ],
      notes: ["Sync run rows are metadata only; they do not replace history shards as source of truth."]
    },
    {
      name: "property_master_context",
      purpose: "AI-readable mirror of property universe, aliases, and source mappings.",
      source_of_truth: ".data/exports/zao-universe-review/*",
      columns: [
        col("canonical_property_name", "TEXT", "PRIMARY KEY", "Canonical property identity."),
        col("canonicalization_status", "TEXT", "", "canonical, duplicate/deprecated, excluded, or review status."),
        col("area", "TEXT", "", "Area label such as Zao Onsen."),
        col("property_type", "TEXT", "", "Lodging type hint when known."),
        col("aliases_json", "TEXT", "", "JSON alias list."),
        col("source_candidates_json", "TEXT", "", "JSON source candidate rows/IDs."),
        col("source_coverage_json", "TEXT", "", "JSON source coverage summary."),
        col("notes", "TEXT", "", "Human-readable caveats and resolved duplicate notes."),
        col("updated_at", "TEXT", "", "Derived mirror update timestamp.")
      ],
      notes: ["This table is derived context. Property master exports remain approval-gated source artifacts."]
    },
    {
      name: "ai_context_packs",
      purpose: "Store generated AI-readable context snapshots.",
      source_of_truth: "Generated from DB mirror, property context, manifest, and data dictionary.",
      columns: [
        col("context_pack_id", "TEXT", "PRIMARY KEY", "Stable context pack identifier."),
        col("pack_type", "TEXT", "", "market_snapshot, property_master_context, demand_index_context, caveats_guardrails, or task_context."),
        col("generated_at", "TEXT", "", "Pack generation timestamp."),
        col("source_sync_run_id", "TEXT", "", "Sync run used to generate the context pack."),
        col("payload_json", "TEXT", "", "AI-readable JSON payload."),
        col("report_path", "TEXT", "", "Local report/context path."),
        col("created_at", "TEXT", "", "DB mirror insertion timestamp.")
      ],
      notes: ["Context packs are derived artifacts and should be regenerated, not manually edited."]
    }
  ];
}

export function indexDesigns(): IndexDesign[] {
  return [
    idx("market_signal_history", "idx_market_signal_history_row_hash", ["row_hash"], false, "Conflict lookup by row hash."),
    idx("market_signal_history", "idx_market_signal_history_checkin_date", ["checkin_date"], false, "Date-range AI queries."),
    idx("market_signal_history", "idx_market_signal_history_source", ["source"], false, "Source quality and source-filtered queries."),
    idx("market_signal_history", "idx_market_signal_history_property", ["canonical_property_name"], false, "Property-level latest signal queries."),
    idx("market_signal_history", "idx_market_signal_history_dp_usage", ["dp_usage"], false, "Direct/directional/excluded guardrail filtering."),
    idx("market_signal_history", "idx_market_signal_history_basis_confidence", ["basis_confidence"], false, "A/B/C/insufficient guardrail filtering."),
    idx("market_signal_history", "idx_market_signal_history_availability", ["availability_status"], false, "Sold-out/available pressure queries."),
    idx("market_signal_history", "uq_market_signal_history_row_id_hash", ["row_id", "row_hash"], true, "Supported unique pair for identical-row skip verification.")
  ];
}

export function idempotencyRules(): string[] {
  return [
    "same row_id + same row_hash = skip identical",
    "same row_id + different row_hash = conflict, block sync",
    "new row_id = insert"
  ];
}

export function viewDesigns(): ViewDesign[] {
  return [
    view("v_ai_market_daily_summary", "one row per checkin_date / stay_scope", "Date-level market summary for reports and demand scanning", [
      "checkin_date", "checkout_date", "stay_scope", "source_count", "property_count", "direct_row_count", "directional_row_count", "excluded_row_count", "available_count", "sold_out_count", "not_listed_count", "median_total_jpy", "direct_median_total_jpy", "directional_median_total_jpy", "max_basis_confidence", "has_direct_signal", "has_sold_out_pressure", "data_quality_level", "basis_note"
    ]),
    view("v_ai_property_latest_signal", "one row per property / checkin_date / source", "Latest source signal for property-specific AI tasks", [
      "canonical_property_name", "source", "source_property_id", "checkin_date", "checkout_date", "stay_scope", "availability_status", "sold_out_flag", "normalized_total_jpy", "basis_confidence", "dp_usage", "classification", "collected_at_jst", "row_id", "row_hash"
    ]),
    view("v_ai_sold_out_pressure", "one row per checkin_date / stay_scope", "Sold-out pressure ratio and affected properties", [
      "checkin_date", "stay_scope", "property_count", "sold_out_count", "sold_out_ratio", "sold_out_properties_json", "source_count", "data_quality_level"
    ]),
    view("v_ai_price_pressure", "one row per checkin_date / stay_scope", "Price pressure distribution for direct/directional rows", [
      "checkin_date", "stay_scope", "price_row_count", "direct_price_row_count", "directional_price_row_count", "median_total_jpy", "p75_total_jpy", "p90_total_jpy", "min_total_jpy", "max_total_jpy", "data_quality_level"
    ]),
    view("v_ai_property_master_context", "one row per canonical property", "Canonical property/alias/source coverage context for AI retrieval", [
      "canonical_property_name", "canonicalization_status", "area", "property_type", "aliases_json", "source_coverage_json", "source_candidates_json", "notes"
    ]),
    view("v_ai_task_context_latest", "one row per context pack type", "Latest compact AI task context payloads", [
      "context_pack_type", "generated_at", "payload_json"
    ])
  ];
}

export function queryRecipes(): QueryRecipe[] {
  return [
    recipe("market_report_for_date_range", "Market report for a date range.", ["date_from", "date_to", "minimum_confidence"], "SELECT * FROM v_ai_market_daily_summary WHERE checkin_date BETWEEN :date_from AND :date_to ORDER BY checkin_date;"),
    recipe("high_demand_dates", "Find high-demand dates using sold-out and price pressure.", ["date_from", "date_to"], "SELECT * FROM v_ai_market_daily_summary WHERE checkin_date BETWEEN :date_from AND :date_to AND (has_sold_out_pressure = 1 OR median_total_jpy IS NOT NULL) ORDER BY sold_out_count DESC, median_total_jpy DESC;"),
    recipe("weak_demand_dates", "Find weak-demand dates with low sold-out pressure and weak price signal.", ["date_from", "date_to"], "SELECT * FROM v_ai_market_daily_summary WHERE checkin_date BETWEEN :date_from AND :date_to AND sold_out_count = 0 ORDER BY median_total_jpy ASC;"),
    recipe("sold_out_pressure_dates", "Inspect sold-out pressure dates.", ["date_from", "date_to"], "SELECT * FROM v_ai_sold_out_pressure WHERE checkin_date BETWEEN :date_from AND :date_to ORDER BY sold_out_ratio DESC, sold_out_count DESC;"),
    recipe("property_latest_signal", "Latest signal for one property/date range.", ["canonical_property_name", "date_from", "date_to"], "SELECT * FROM v_ai_property_latest_signal WHERE canonical_property_name = :property AND checkin_date BETWEEN :date_from AND :date_to ORDER BY checkin_date, source;"),
    recipe("source_quality_summary", "Summarize source quality and confidence mix.", ["date_from", "date_to"], "SELECT source, dp_usage, basis_confidence, COUNT(*) AS row_count FROM market_signal_history WHERE checkin_date BETWEEN :date_from AND :date_to GROUP BY source, dp_usage, basis_confidence;"),
    recipe("pricing_support_context", "Retrieve guarded pricing support context for one property/date range.", ["canonical_property_name", "date_from", "date_to"], "SELECT p.*, d.median_total_jpy, d.direct_median_total_jpy, d.data_quality_level FROM v_ai_property_latest_signal p LEFT JOIN v_ai_market_daily_summary d USING (checkin_date, stay_scope) WHERE p.canonical_property_name = :property AND p.checkin_date BETWEEN :date_from AND :date_to ORDER BY p.checkin_date, p.source;"),
    recipe("data_quality_property_mapping_check", "Check aliases and source mappings for one property.", ["canonical_property_name"], "SELECT * FROM v_ai_property_master_context WHERE canonical_property_name = :property;"),
    recipe("ai_bootstrap_context", "Load latest AI bootstrap context.", ["none"], "SELECT * FROM v_ai_task_context_latest ORDER BY generated_at DESC;")
  ];
}

export function rebuildStrategy(): string[] {
  return [
    "Take a DB backup before any approved real sync.",
    "Truncate or rebuild mirror tables from scratch when a full rebuild is requested.",
    "Read .data/history monthly shards in deterministic filename order.",
    "Validate schema_version and required history columns before planning inserts.",
    "For each history row, compute/read row_id and row_hash.",
    "Apply idempotency rules: identical row_id+row_hash skips, row_id+different row_hash blocks, new row_id inserts.",
    "Record a market_signal_sync_runs row with input, inserted, skipped, conflict, and report counts during approved real sync.",
    "Generate a sync report and refresh AI views/context packs after sync.",
    "If corruption is detected, rebuild DB mirror from .data/history because history remains source of truth."
  ];
}

export function contextPackStrategy(): string[] {
  return [
    "Generate .data/ai-context/latest_market_snapshot.json from v_ai_market_daily_summary, v_ai_sold_out_pressure, and v_ai_price_pressure.",
    "Generate .data/ai-context/latest_property_master_context.json from v_ai_property_master_context.",
    "Generate .data/ai-context/latest_demand_index_context.json from demand-index views or derived history rows.",
    "Generate .data/ai-context/latest_caveats_and_guardrails.json from manifest, data dictionary, and sync status.",
    "Treat context packs as derived artifacts; future AI should read them before raw rows but never manually edit them."
  ];
}

export function approvalGates(): string[] {
  return [
    "AUTO03X history-to-DB sync dry-run: no approval required if read-only.",
    "AUTO04X first DB mirror real sync: requires explicit approval.",
    "AUTO05X AI context pack generation: read-only derived files, approval optional.",
    "AUTO07X collector orchestration dry-run: explicit scope required.",
    "AUTO08X auto history append real run: explicit approval.",
    "AUTO10X scheduled activation proposal: proposal only.",
    "AUTO11X scheduled activation real run: explicit approval."
  ];
}

export function risks(): string[] {
  return [
    "Existing DB platform/schema readiness may require migration review before AUTO04X.",
    "Direct DB corruption risk remains if collectors ever bypass the history append log.",
    "row_hash conflict handling must block sync rather than overwrite rows.",
    "Median/p75/p90 implementation may differ by DB engine; draft SQL should be validated in AUTO03X.",
    "B-confidence/directional rows can be overread by AI unless views expose guardrails.",
    "Current history is thin, so AI views must preserve data_quality_level and basis_note."
  ];
}

export function buildDbAiViewsSchemaDesign(input: {
  runId: string;
  generatedAtJst: string;
  schemaDraftSqlPath: string;
  viewsDraftSqlPath: string;
  historyFileCount: number;
  historyHeaderCount: number;
  dbArtifactCount: number;
}): DbAiViewsSchemaDesign {
  const decision = input.historyFileCount > 0 && input.historyHeaderCount > 0
    ? "db_ai_views_schema_design_ready"
    : "db_ai_views_schema_design_basis_caution";
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision,
    source_artifacts: SOURCE_ARTIFACTS,
    table_designs: tableDesigns(),
    index_designs: indexDesigns(),
    view_designs: viewDesigns(),
    query_recipes: queryRecipes(),
    rebuild_strategy: rebuildStrategy(),
    context_pack_strategy: contextPackStrategy(),
    approval_gates: approvalGates(),
    draft_sql_paths: {
      schema_draft_sql: input.schemaDraftSqlPath,
      views_draft_sql: input.viewsDraftSqlPath,
      location_policy: "Draft SQL is written under .data/debug/db-ai-views-schema-design only; it is not a migration, no migrations are created, and no SQL is executed."
    },
    risks: risks(),
    next_phase: "AUTO03X — History-to-DB sync dry-run",
    safety_confirmation: {
      dbWrites: false,
      sqlExecuted: false,
      migrationsCreated: false,
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
      paidSourceTooling: false,
      inspectedHistoryFileCount: input.historyFileCount > 0,
      inspectedDbArtifacts: input.dbArtifactCount > 0
    }
  };
}

export function renderDbAiViewsSchemaCsv(design: DbAiViewsSchemaDesign): string {
  const rows: string[][] = [
    ["summary", "decision", design.decision],
    ["summary", "next_phase", design.next_phase],
    ...design.table_designs.map((t) => ["table", t.name, t.purpose]),
    ...design.index_designs.map((i) => ["index", i.name, `${i.table}(${i.columns.join("|")}) unique=${i.unique}`]),
    ...design.view_designs.map((v) => ["view", v.name, `${v.grain}: ${v.purpose}`]),
    ...design.query_recipes.map((q) => ["query_recipe", q.name, q.purpose]),
    ...design.approval_gates.map((g) => ["approval_gate", g.split(":")[0] ?? "gate", g]),
    ...design.risks.map((r) => ["risk", "risk", r])
  ];
  return `section,key,value\n${rows.map((r) => r.map(csvEscape).join(",")).join("\n")}\n`;
}

export function renderDbAiViewsSchemaReport(design: DbAiViewsSchemaDesign): string {
  return [
    "# DB Schema + AI-Readable Views Design",
    "",
    `Generated at: ${design.generated_at_jst}`,
    `Decision: ${design.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    "The DB should initially be a derived mirror of .data/history monthly shards, not the source of truth. AI agents should query curated views and context packs that preserve confidence, dp_usage, and source-basis guardrails.",
    "",
    "## 2. Current Data Sources",
    "",
    ...design.source_artifacts.map((a) => `- ${a.path}: ${a.purpose}; inspected=${a.inspected}`),
    "",
    "## 3. Table Design",
    "",
    ...design.table_designs.flatMap((t) => [
      `### ${t.name}`,
      `- purpose=${t.purpose}`,
      `- source_of_truth=${t.source_of_truth}`,
      ...t.columns.map((c) => `- ${c.name} ${c.type}${c.constraints ? ` ${c.constraints}` : ""}: ${c.purpose}`),
      ...t.notes.map((n) => `- note=${n}`),
      ""
    ]),
    "## 4. Constraints and Idempotency",
    "",
    ...design.index_designs.map((i) => `- ${i.name}: ${i.table}(${i.columns.join(", ")}); unique=${i.unique}; purpose=${i.purpose}`),
    ...idempotencyRules().map((r) => `- ${r}`),
    "",
    "## 5. AI-readable Views",
    "",
    ...design.view_designs.flatMap((v) => [
      `### ${v.name}`,
      `- grain=${v.grain}`,
      `- purpose=${v.purpose}`,
      `- columns=${v.columns.join(", ")}`,
      `- guardrails=${v.guardrails.join(" | ")}`,
      ""
    ]),
    "## 6. Query Recipes",
    "",
    ...design.query_recipes.flatMap((q) => [
      `### ${q.name}`,
      `- purpose=${q.purpose}`,
      `- input=${q.input.join(", ")}`,
      "```sql",
      q.sample_sql,
      "```",
      ...q.caveats.map((c) => `- caveat=${c}`),
      ""
    ]),
    "## 7. Rebuild Strategy",
    "",
    ...design.rebuild_strategy.map((s) => `- ${s}`),
    "",
    "## 8. Context Pack Strategy",
    "",
    ...design.context_pack_strategy.map((s) => `- ${s}`),
    "",
    "## 9. Approval Gates",
    "",
    ...design.approval_gates.map((g) => `- ${g}`),
    "",
    "## 10. Risks",
    "",
    ...design.risks.map((r) => `- ${r}`),
    "",
    "## 11. Draft SQL Location",
    "",
    `- schema_draft_sql=${design.draft_sql_paths.schema_draft_sql}`,
    `- views_draft_sql=${design.draft_sql_paths.views_draft_sql}`,
    `- policy=${design.draft_sql_paths.location_policy}`,
    "",
    "## 12. Safety Confirmation",
    "",
    ...Object.entries(design.safety_confirmation).map(([k, v]) => `- ${k}=${v}`),
    "",
    "## 13. Next Phase: AUTO03X",
    "",
    design.next_phase,
    ""
  ].join("\n");
}

export function renderSchemaDraftSql(design: DbAiViewsSchemaDesign): string {
  return [
    "-- AUTO02X draft only. Do not execute in this phase.",
    "-- Location policy: debug artifact only; not a migration.",
    "",
    ...design.table_designs.flatMap((t) => [
      `CREATE TABLE ${t.name} (`,
      t.columns.map((c) => `  ${c.name} ${c.type}${c.constraints ? ` ${c.constraints}` : ""}`).join(",\n"),
      ");",
      ""
    ]),
    ...design.index_designs.map((i) => `${i.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX"} ${i.name} ON ${i.table} (${i.columns.join(", ")});`),
    ""
  ].join("\n");
}

export function renderViewsDraftSql(design: DbAiViewsSchemaDesign): string {
  const viewSql: Record<string, string> = {
    v_ai_market_daily_summary: `CREATE VIEW v_ai_market_daily_summary AS
SELECT
  checkin_date,
  MAX(checkout_date) AS checkout_date,
  stay_scope,
  COUNT(DISTINCT source) AS source_count,
  COUNT(DISTINCT canonical_property_name) AS property_count,
  SUM(CASE WHEN dp_usage = 'direct' THEN 1 ELSE 0 END) AS direct_row_count,
  SUM(CASE WHEN dp_usage = 'directional' THEN 1 ELSE 0 END) AS directional_row_count,
  SUM(CASE WHEN dp_usage = 'excluded' THEN 1 ELSE 0 END) AS excluded_row_count,
  SUM(CASE WHEN availability_status = 'available' THEN 1 ELSE 0 END) AS available_count,
  SUM(CASE WHEN availability_status = 'sold_out' OR sold_out_flag = 1 THEN 1 ELSE 0 END) AS sold_out_count,
  SUM(CASE WHEN availability_status = 'not_listed' THEN 1 ELSE 0 END) AS not_listed_count,
  NULL AS median_total_jpy,
  NULL AS direct_median_total_jpy,
  NULL AS directional_median_total_jpy,
  MAX(basis_confidence) AS max_basis_confidence,
  MAX(CASE WHEN dp_usage = 'direct' THEN 1 ELSE 0 END) AS has_direct_signal,
  MAX(CASE WHEN availability_status = 'sold_out' OR sold_out_flag = 1 THEN 1 ELSE 0 END) AS has_sold_out_pressure,
  CASE WHEN SUM(CASE WHEN dp_usage = 'direct' THEN 1 ELSE 0 END) > 0 THEN 'direct_present' ELSE 'directional_or_sparse' END AS data_quality_level,
  'Median percentile implementation to be validated per DB engine in AUTO03X.' AS basis_note
FROM market_signal_history
GROUP BY checkin_date, stay_scope;`,
    v_ai_property_latest_signal: `CREATE VIEW v_ai_property_latest_signal AS
SELECT *
FROM (
  SELECT
    canonical_property_name,
    source,
    source_property_id,
    checkin_date,
    checkout_date,
    stay_scope,
    availability_status,
    sold_out_flag,
    normalized_total_jpy,
    basis_confidence,
    dp_usage,
    classification,
    collected_at_jst,
    row_id,
    row_hash,
    ROW_NUMBER() OVER (
      PARTITION BY canonical_property_name, source, checkin_date, stay_scope
      ORDER BY collected_at_jst DESC, row_id DESC
    ) AS rn
  FROM market_signal_history
)
WHERE rn = 1;`,
    v_ai_sold_out_pressure: `CREATE VIEW v_ai_sold_out_pressure AS
SELECT
  checkin_date,
  stay_scope,
  COUNT(DISTINCT canonical_property_name) AS property_count,
  SUM(CASE WHEN availability_status = 'sold_out' OR sold_out_flag = 1 THEN 1 ELSE 0 END) AS sold_out_count,
  1.0 * SUM(CASE WHEN availability_status = 'sold_out' OR sold_out_flag = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(DISTINCT canonical_property_name), 0) AS sold_out_ratio,
  json_group_array(CASE WHEN availability_status = 'sold_out' OR sold_out_flag = 1 THEN canonical_property_name ELSE NULL END) AS sold_out_properties_json,
  COUNT(DISTINCT source) AS source_count,
  CASE WHEN COUNT(DISTINCT source) >= 2 THEN 'multi_source' ELSE 'thin' END AS data_quality_level
FROM market_signal_history
GROUP BY checkin_date, stay_scope;`,
    v_ai_price_pressure: `CREATE VIEW v_ai_price_pressure AS
SELECT
  checkin_date,
  stay_scope,
  COUNT(normalized_total_jpy) AS price_row_count,
  SUM(CASE WHEN dp_usage = 'direct' AND normalized_total_jpy IS NOT NULL THEN 1 ELSE 0 END) AS direct_price_row_count,
  SUM(CASE WHEN dp_usage = 'directional' AND normalized_total_jpy IS NOT NULL THEN 1 ELSE 0 END) AS directional_price_row_count,
  NULL AS median_total_jpy,
  NULL AS p75_total_jpy,
  NULL AS p90_total_jpy,
  MIN(normalized_total_jpy) AS min_total_jpy,
  MAX(normalized_total_jpy) AS max_total_jpy,
  CASE WHEN SUM(CASE WHEN dp_usage = 'direct' THEN 1 ELSE 0 END) > 0 THEN 'direct_present' ELSE 'directional_or_sparse' END AS data_quality_level
FROM market_signal_history
WHERE normalized_total_jpy IS NOT NULL
GROUP BY checkin_date, stay_scope;`,
    v_ai_property_master_context: `CREATE VIEW v_ai_property_master_context AS
SELECT
  canonical_property_name,
  canonicalization_status,
  area,
  property_type,
  aliases_json,
  source_coverage_json,
  source_candidates_json,
  notes
FROM property_master_context;`,
    v_ai_task_context_latest: `CREATE VIEW v_ai_task_context_latest AS
SELECT pack_type AS context_pack_type, generated_at, payload_json
FROM (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY pack_type ORDER BY generated_at DESC, context_pack_id DESC) AS rn
  FROM ai_context_packs
)
WHERE rn = 1;`
  };
  return [
    "-- AUTO02X draft only. Do not execute in this phase.",
    "-- Percentile/median expressions are intentionally left for AUTO03X DB-engine validation.",
    "",
    ...design.view_designs.map((v) => viewSql[v.name] ?? `-- Missing draft for ${v.name}`),
    ""
  ].join("\n\n");
}

function col(name: string, type: string, constraints: string, purpose: string): ColumnDesign {
  return { name, type, constraints, purpose };
}

function idx(table: string, name: string, columns: string[], unique: boolean, purpose: string): IndexDesign {
  return { table, name, columns, unique, purpose };
}

function view(name: string, grain: string, purpose: string, columns: string[]): ViewDesign {
  return {
    name,
    grain,
    purpose,
    columns,
    guardrails: [
      "Expose basis_confidence/dp_usage where relevant.",
      "Do not hide excluded rows from quality counts.",
      "Do not imply PMS/OTA update permission."
    ]
  };
}

function recipe(name: string, purpose: string, input: string[], sampleSql: string): QueryRecipe {
  return {
    name,
    purpose,
    input,
    sample_sql: sampleSql,
    caveats: [...REQUIRED_QUERY_CAVEATS]
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

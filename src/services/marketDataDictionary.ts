// Phase AI-READ02X — market data dictionary / schema documentation.
//
// Documentation/indexing only. This module renders dictionaries for existing
// local artifacts; it does not write the DB, mutate history/property masters,
// fetch live pages, run collectors, or produce channel/PMS outputs.

export type MarketDataDictionaryDecision =
  | "market_data_dictionary_ready"
  | "market_data_dictionary_basis_caution"
  | "market_data_dictionary_not_ready";

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export interface FileInventoryItem {
  file_path: string;
  file_type: string;
  purpose: string;
  source_phase: string;
  safe_to_read: boolean;
  safe_to_modify_without_approval: boolean;
  primary_key_or_row_identity: string;
  recommended_use: string;
  do_not_use_for: string;
}

export interface ColumnDictionaryItem {
  column_name: string;
  meaning: string;
  data_type: string;
  allowed_values: string;
  safe_for_pricing: "yes" | "directional_only" | "no";
  safe_for_demand_signal: "yes" | "directional_only" | "no";
  safe_for_identity: "yes" | "no";
  common_misread_risk: string;
}

export interface SourcePriceBasisRule {
  source: "jalan" | "rakuten" | "booking";
  rule: string;
  confidence: string;
  pricing_use: string;
  demand_use: string;
  do_not_infer: string;
}

export interface MarketDataDictionary {
  run_id: string;
  generated_at_jst: string;
  file_inventory: FileInventoryItem[];
  schemas: {
    history_shard: ColumnDictionaryItem[];
    demand_index: ColumnDictionaryItem[];
    property_universe: ColumnDictionaryItem[];
    source_candidates: ColumnDictionaryItem[];
    excluded_audit: ColumnDictionaryItem[];
  };
  source_price_basis_rules: SourcePriceBasisRule[];
  confidence_semantics: Record<string, string>;
  dp_usage_semantics: Record<string, string>;
  demand_index_dictionary: {
    prototype_only: boolean;
    advisory_only: boolean;
    congestion_rank_note: string;
    columns: ColumnDictionaryItem[];
  };
  property_universe_dictionary: {
    matsukaneya_resolved_note: string;
    columns: ColumnDictionaryItem[];
  };
  future_ai_usage_rules: string[];
  known_misread_risks: string[];
  safety_confirmation: Record<string, boolean>;
  decision: MarketDataDictionaryDecision;
}

export const HISTORY_FILES = [
  ".data/history/zao_signals_2026_05.csv",
  ".data/history/zao_signals_2026_06.csv",
  ".data/history/zao_signals_2026_07.csv",
  ".data/history/zao_signals_2026_08.csv",
  ".data/history/zao_signals_2026_10.csv",
  ".data/history/zao_signals_2026_12.csv"
] as const;

export const IMPORTANT_FILES = [
  ".data/reports/market-update/ai_readable_market_manifest_latest.md",
  ".data/reports/market-update/ai_readable_market_manifest_latest.json",
  ...HISTORY_FILES,
  ".data/reports/market-update/zao_demand_index_design_20260603_200932.md",
  ".data/reports/market-update/zao_demand_index_design_20260603_200932.csv",
  ".data/reports/market-update/zao_demand_index_design_20260603_200932.json",
  ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv",
  ".data/exports/zao-universe-review/zao_source_candidates_20260531_231933.csv",
  ".data/exports/zao-universe-review/zao_source_candidates_multi_source_enriched_20260601_074617.csv",
  ".data/exports/zao-universe-review/zao_alias_map_20260531_231933.json",
  ".data/exports/zao-universe-review/zao_excluded_audit_20260531_231933.csv",
  ".data/reports/source-discovery/matsukaneya_canonical_merge_20260603_211617.md",
  ".data/reports/source-discovery/matsukaneya_canonical_merge_20260603_211617.json"
] as const;

export const FUTURE_AI_USAGE_RULES = [
  "Start by reading ai_readable_market_manifest_latest.md/json.",
  "Then read market_data_dictionary_latest.md/json.",
  "Use history shards for time-series market signals.",
  "Use Demand Index only as prototype signal.",
  "Do not use B-confidence rows for automated price changes.",
  "Do not infer actual occupancy from OTA stock.",
  "Do not infer restaurant footfall from congestion rank.",
  "Do not modify master/history/workflows without explicit approval.",
  "Do not run live collectors unless explicitly instructed.",
  "Do not proceed to DP03X or R01X unless the user explicitly asks."
] as const;

export const FILES_NOT_TO_MODIFY_WITHOUT_APPROVAL = [
  ".data/exports/zao-universe-review/*",
  ".data/history/*",
  ".github/workflows/*",
  "DB / migrations / production schemas",
  "PMS export scripts"
] as const;

export function parseCsvTable(csv: string): CsvTable {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    const next = csv[i + 1];
    if (inQuotes && ch === "\"" && next === "\"") {
      cell += "\"";
      i++;
    } else if (ch === "\"") {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((v) => v !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((v) => v !== "")) matrix.push(row);
  }
  const headers = matrix.shift() ?? [];
  return { headers, rows: matrix.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}

export function buildFileInventory(paths: readonly string[]): FileInventoryItem[] {
  return paths.map((path) => ({
    file_path: path,
    file_type: fileType(path),
    purpose: filePurpose(path),
    source_phase: sourcePhase(path),
    safe_to_read: true,
    safe_to_modify_without_approval: false,
    primary_key_or_row_identity: rowIdentity(path),
    recommended_use: recommendedUse(path),
    do_not_use_for: doNotUseFor(path)
  }));
}

export function buildHistorySchema(headers: readonly string[]): ColumnDictionaryItem[] {
  return headers.map((h) => column(h, HISTORY_COLUMN_DEFINITIONS[h] ?? {
    meaning: "History shard field carried from the normalized market signal row.",
    data_type: "string",
    allowed_values: "",
    safe_for_pricing: "no",
    safe_for_demand_signal: "directional_only",
    safe_for_identity: "no",
    common_misread_risk: "Do not infer more than the column explicitly states."
  }));
}

export function buildStaticSchema(headers: readonly string[], definitions: Record<string, Partial<ColumnDictionaryItem>>): ColumnDictionaryItem[] {
  return headers.map((h) => column(h, definitions[h] ?? {
    meaning: "Documented artifact field.",
    data_type: "string",
    allowed_values: "",
    safe_for_pricing: "no",
    safe_for_demand_signal: "no",
    safe_for_identity: "no",
    common_misread_risk: "Do not treat metadata as an approved operational value."
  }));
}

export function sourcePriceBasisRules(): SourcePriceBasisRule[] {
  return [
    {
      source: "jalan",
      rule: "Strongest/direct-capable source when A-confidence; coupon guard and sold_out handling are present.",
      confidence: "A rows are stronger direct price signals.",
      pricing_use: "Use direct rows for stronger price signal; still require human workflow before any price update.",
      demand_use: "Available/sold_out status and direct price movement can support demand pressure.",
      do_not_infer: "Do not ignore coupon/discount guard or treat failed rows as market absence."
    },
    {
      source: "rakuten",
      rule: "/hplan/calendar JSONP returns CHARGE_PER_HUMAN; raw price is per-person; computed 2-adult total = raw_price * 2.",
      confidence: "B-confidence directional unless final total basis is later confirmed.",
      pricing_use: "Use for direction/pressure, not automated price changes.",
      demand_use: "Sold_out pressure can be useful even when price is null.",
      do_not_infer: "Do not claim final all-in room total confidence A from JSONP alone."
    },
    {
      source: "booking",
      rule: "Uses official visible base plus official visible tax/fee adder; no synthetic Booking.com base × 1.1.",
      confidence: "B-confidence directional unless final all-in marker is confirmed.",
      pricing_use: "Use visible official components only; do not synthesize unknown tax/fee multipliers.",
      demand_use: "Rendered price/availability can support directional pressure if identity and scope match.",
      do_not_infer: "Do not use synthetic multipliers or hidden/internal data."
    }
  ];
}

export function buildMarketDataDictionary(input: {
  runId: string;
  generatedAtJst: string;
  historyHeaders: string[];
  demandHeaders: string[];
  propertyUniverseHeaders: string[];
  sourceCandidateHeaders: string[];
  excludedAuditHeaders: string[];
}): MarketDataDictionary {
  const historySchema = buildHistorySchema(input.historyHeaders);
  const demandSchema = buildStaticSchema(input.demandHeaders, DEMAND_COLUMN_DEFINITIONS);
  const propertySchema = buildStaticSchema(input.propertyUniverseHeaders, PROPERTY_UNIVERSE_COLUMN_DEFINITIONS);
  const sourceCandidateSchema = buildStaticSchema(input.sourceCandidateHeaders, SOURCE_CANDIDATE_COLUMN_DEFINITIONS);
  const excludedSchema = buildStaticSchema(input.excludedAuditHeaders, EXCLUDED_AUDIT_COLUMN_DEFINITIONS);
  const decision = decideMarketDataDictionary({
    historySchemaCount: historySchema.length,
    demandSchemaCount: demandSchema.length,
    propertySchemaCount: propertySchema.length
  });

  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    file_inventory: buildFileInventory(IMPORTANT_FILES),
    schemas: {
      history_shard: historySchema,
      demand_index: demandSchema,
      property_universe: propertySchema,
      source_candidates: sourceCandidateSchema,
      excluded_audit: excludedSchema
    },
    source_price_basis_rules: sourcePriceBasisRules(),
    confidence_semantics: {
      A: "Direct usable, stronger confidence. Appropriate for direct medians / strongest available signal, still not an automated price-update approval.",
      B: "Directional. Usable for trend/pressure, not final price automation.",
      C: "Excluded or weak. Treat with caution and do not use for price medians.",
      insufficient: "Not enough data to support an inference."
    },
    dp_usage_semantics: {
      direct: "Can be used in direct medians / strongest available signal.",
      directional: "Use for direction/pressure, not automated pricing.",
      excluded: "Not used for price medians."
    },
    demand_index_dictionary: {
      prototype_only: true,
      advisory_only: true,
      congestion_rank_note: "Congestion forecast rank is a lodging-derived tendency, not exact restaurant footfall.",
      columns: demandSchema
    },
    property_universe_dictionary: {
      matsukaneya_resolved_note:
        "Matsukaneya duplicate resolved: ホテル松金屋アネックス retained; 松金や －MATSUKANEYA ANNEX－ merged/deprecated; Rakuten 5097 + Jalan 335940 preserved.",
      columns: propertySchema
    },
    future_ai_usage_rules: [...FUTURE_AI_USAGE_RULES],
    known_misread_risks: [
      "B-confidence rows are directional and must not trigger automated price changes.",
      "OTA stock is not actual occupancy.",
      "Congestion rank is not exact restaurant footfall.",
      "Demand Index is prototype-only and pricing posture is advisory only.",
      "Debug paths and report paths are traceability metadata, not market signals.",
      "Canonical source candidates are not confirmed coverage unless verification status and review context support it.",
      "DP03X and R01X remain paused unless the user explicitly asks."
    ],
    safety_confirmation: {
      dbWrites: false,
      liveExternalFetch: false,
      collectorRerun: false,
      priceUpdate: false,
      propertyMasterMutation: false,
      historyModification: false,
      githubActionsOrGitOps: false,
      pmsOrChannelOutput: false,
      paidSourceTooling: false
    },
    decision
  };
}

export function decideMarketDataDictionary(input: {
  historySchemaCount: number;
  demandSchemaCount: number;
  propertySchemaCount: number;
}): MarketDataDictionaryDecision {
  if (input.historySchemaCount === 0 || input.demandSchemaCount === 0 || input.propertySchemaCount === 0) {
    return "market_data_dictionary_not_ready";
  }
  return "market_data_dictionary_ready";
}

export function renderMarketDataDictionaryMarkdown(dictionary: MarketDataDictionary): string {
  return [
    "# Market Data Dictionary / Schema Documentation (AI-READ02X)",
    "",
    `Generated at: ${dictionary.generated_at_jst}`,
    `Decision: ${dictionary.decision}`,
    "",
    "## 1. File Inventory",
    "",
    ...dictionary.file_inventory.map((f) =>
      `- ${f.file_path} | type=${f.file_type} | phase=${f.source_phase} | safe_to_read=${bool(f.safe_to_read)} | safe_to_modify_without_approval=${bool(f.safe_to_modify_without_approval)} | use=${f.recommended_use} | do_not_use_for=${f.do_not_use_for}`
    ),
    "",
    "## 2. History Shard Schema",
    "",
    ...schemaLines(dictionary.schemas.history_shard),
    "",
    "## 3. Source-Specific Price Basis Rules",
    "",
    ...dictionary.source_price_basis_rules.map((r) =>
      `- ${r.source}: ${r.rule} Confidence: ${r.confidence} Pricing use: ${r.pricing_use} Demand use: ${r.demand_use} Do not infer: ${r.do_not_infer}`
    ),
    "",
    "## 4. Confidence Semantics",
    "",
    ...Object.entries(dictionary.confidence_semantics).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 5. DP Usage Semantics",
    "",
    ...Object.entries(dictionary.dp_usage_semantics).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 6. Demand Index Schema",
    "",
    "- Demand Index is prototype-only.",
    "- Pricing posture is advisory only.",
    "- Congestion forecast rank is a lodging-derived tendency, not exact footfall.",
    ...schemaLines(dictionary.schemas.demand_index),
    "",
    "## 7. Property Universe Schema",
    "",
    `- ${dictionary.property_universe_dictionary.matsukaneya_resolved_note}`,
    ...schemaLines(dictionary.schemas.property_universe),
    "",
    "## 8. Source Candidate / Excluded Audit Schema",
    "",
    ...schemaLines(dictionary.schemas.source_candidates),
    ...schemaLines(dictionary.schemas.excluded_audit),
    "",
    "## 9. Future AI Usage Rules",
    "",
    ...dictionary.future_ai_usage_rules.map((r) => `- ${r}`),
    "",
    "## 10. Known Misread Risks",
    "",
    ...dictionary.known_misread_risks.map((r) => `- ${r}`),
    "",
    "## 11. Files Not To Modify Without Approval",
    "",
    ...FILES_NOT_TO_MODIFY_WITHOUT_APPROVAL.map((f) => `- ${f}`),
    "",
    "## 12. Safety Confirmation",
    "",
    ...Object.entries(dictionary.safety_confirmation).map(([k, v]) => `- ${k}=${bool(v)}`),
    ""
  ].join("\n");
}

export function renderMarketDataDictionaryCsv(dictionary: MarketDataDictionary): string {
  const header = [
    "section",
    "file_or_schema",
    "column_name",
    "meaning",
    "safe_for_pricing",
    "safe_for_demand_signal",
    "safe_for_identity",
    "common_misread_risk"
  ];
  const rows: string[][] = [];
  for (const item of dictionary.file_inventory) {
    rows.push(["file_inventory", item.file_path, "", item.purpose, "no", "no", "no", item.do_not_use_for]);
  }
  for (const [schemaName, columns] of Object.entries(dictionary.schemas)) {
    for (const col of columns) {
      rows.push([
        "schema",
        schemaName,
        col.column_name,
        col.meaning,
        col.safe_for_pricing,
        col.safe_for_demand_signal,
        col.safe_for_identity,
        col.common_misread_risk
      ]);
    }
  }
  return `${header.join(",")}\n${rows.map((r) => r.map(csvEscape).join(",")).join("\n")}\n`;
}

function schemaLines(items: ColumnDictionaryItem[]): string[] {
  return items.map((c) =>
    `- ${c.column_name}: ${c.meaning} type=${c.data_type}; allowed=${c.allowed_values || "-"}; pricing=${c.safe_for_pricing}; demand=${c.safe_for_demand_signal}; identity=${c.safe_for_identity}; risk=${c.common_misread_risk}`
  );
}

function column(name: string, def: Partial<ColumnDictionaryItem>): ColumnDictionaryItem {
  return {
    column_name: name,
    meaning: def.meaning ?? "Documented artifact field.",
    data_type: def.data_type ?? "string",
    allowed_values: def.allowed_values ?? "",
    safe_for_pricing: def.safe_for_pricing ?? "no",
    safe_for_demand_signal: def.safe_for_demand_signal ?? "no",
    safe_for_identity: def.safe_for_identity ?? "no",
    common_misread_risk: def.common_misread_risk ?? "Do not treat this field as stronger evidence than documented."
  };
}

const HISTORY_COLUMN_DEFINITIONS: Record<string, Partial<ColumnDictionaryItem>> = {
  row_id: { meaning: "Stable row identity for one normalized source/date/property/stay-scope signal.", data_type: "string", safe_for_identity: "yes" },
  row_hash: { meaning: "Content hash used for local history dedupe/integrity.", data_type: "string", safe_for_identity: "yes" },
  shard_month: { meaning: "Monthly shard key in YYYY_MM form.", data_type: "string" },
  collected_date_jst: { meaning: "Date when the source observation was collected in Japan time.", data_type: "date" },
  collected_at_jst: { meaning: "Timestamp when the source observation was collected in Japan time.", data_type: "datetime" },
  normalized_at_jst: { meaning: "Timestamp when the source row was normalized.", data_type: "datetime" },
  source: { meaning: "Source system such as jalan, rakuten, or booking.", data_type: "enum", allowed_values: "jalan|rakuten|booking", safe_for_demand_signal: "yes", safe_for_identity: "yes" },
  source_phase: { meaning: "Collection/prototype phase that produced the row.", data_type: "string" },
  collector_stage: { meaning: "Stage such as prototype_read_only; distinguishes production vs prototype artifacts.", data_type: "string" },
  canonical_property_name: { meaning: "Canonical lodging property name used in local market intelligence artifacts.", data_type: "string", safe_for_identity: "yes" },
  source_property_name: { meaning: "Property name visible or inferred from the source.", data_type: "string", safe_for_identity: "yes" },
  property_identity_match: { meaning: "Whether source identity was considered matching for the normalized row.", data_type: "boolean", allowed_values: "true|false", safe_for_identity: "yes" },
  source_property_id: { meaning: "Source-specific property identifier such as Rakuten hotelNo or Jalan yad id.", data_type: "string", safe_for_identity: "yes" },
  source_slug_or_code: { meaning: "Source slug/code when applicable.", data_type: "string", safe_for_identity: "yes" },
  checkin: { meaning: "Check-in date for the market signal.", data_type: "date", safe_for_demand_signal: "yes" },
  checkout: { meaning: "Checkout date for the market signal.", data_type: "date", safe_for_demand_signal: "yes" },
  stay_nights: { meaning: "Number of nights in the scoped stay.", data_type: "integer", safe_for_demand_signal: "yes" },
  group_adults: { meaning: "Adult count in the scoped query.", data_type: "integer", safe_for_demand_signal: "yes" },
  no_rooms: { meaning: "Room count in the scoped query.", data_type: "integer", safe_for_demand_signal: "yes" },
  group_children: { meaning: "Child count in the scoped query.", data_type: "integer" },
  currency: { meaning: "Currency of normalized/source price.", data_type: "string" },
  language: { meaning: "Language context used for source rendering/extraction.", data_type: "string" },
  stay_scope: { meaning: "Human-readable stay scope such as 2_adults_1_room_1_night.", data_type: "string", safe_for_demand_signal: "yes" },
  availability_status: { meaning: "Availability classification for the scoped stay.", data_type: "enum", allowed_values: "available|sold_out|not_listed|unavailable_or_unknown", safe_for_demand_signal: "yes" },
  sold_out_status: { meaning: "Sold-out pressure classification.", data_type: "enum", allowed_values: "available|sold_out|unknown", safe_for_demand_signal: "yes" },
  normalized_total_price: { meaning: "Normalized scoped total when available and safe under the basis rules.", data_type: "number", safe_for_pricing: "directional_only", safe_for_demand_signal: "yes", common_misread_risk: "Only A-confidence/direct rows are stronger price signals; B rows are directional." },
  normalized_total_price_source: { meaning: "How normalized total price was produced.", data_type: "string", safe_for_demand_signal: "directional_only" },
  normalized_total_price_basis: { meaning: "Basis of normalized total price.", data_type: "string", safe_for_demand_signal: "directional_only" },
  normalized_total_price_confidence: { meaning: "Confidence for normalized total price.", data_type: "enum", allowed_values: "A|B|C|insufficient", safe_for_demand_signal: "yes" },
  basis_confidence: { meaning: "A/B/C/insufficient confidence semantics for market use.", data_type: "enum", allowed_values: "A|B|C|insufficient", safe_for_demand_signal: "yes" },
  basis_note: { meaning: "Short explanation of source basis and limitations.", data_type: "string", safe_for_demand_signal: "directional_only" },
  source_primary_price: { meaning: "Primary raw price from the source.", data_type: "number", safe_for_pricing: "directional_only", safe_for_demand_signal: "directional_only", common_misread_risk: "Raw source price may be per-person, base-only, or otherwise not final total." },
  source_secondary_price_or_adder: { meaning: "Secondary source price component such as visible fee/tax adder.", data_type: "number", safe_for_pricing: "directional_only", safe_for_demand_signal: "directional_only" },
  source_computed_total: { meaning: "Computed source total under documented source-specific rules.", data_type: "number", safe_for_pricing: "directional_only", safe_for_demand_signal: "yes" },
  source_tax_or_fee_classification: { meaning: "Source-specific tax/fee basis classification.", data_type: "string", safe_for_demand_signal: "directional_only" },
  source_classification: { meaning: "Source-specific row classification.", data_type: "string", safe_for_demand_signal: "yes" },
  is_price_usable_for_dp_direct: { meaning: "True when row can be used in direct DP medians.", data_type: "boolean", allowed_values: "true|false", safe_for_pricing: "yes", safe_for_demand_signal: "yes" },
  is_price_usable_for_dp_directional: { meaning: "True when row can support directional pressure only.", data_type: "boolean", allowed_values: "true|false", safe_for_pricing: "directional_only", safe_for_demand_signal: "yes" },
  is_price_excluded_from_dp: { meaning: "True when row is excluded from price medians.", data_type: "boolean", allowed_values: "true|false" },
  dp_exclusion_reason: { meaning: "Reason row is excluded from DP price medians.", data_type: "string" },
  warning_flags: { meaning: "Semicolon/string warning flags for cautionary interpretation.", data_type: "string" },
  source_report_path: { meaning: "Traceability path to source report.", data_type: "path" },
  source_csv_path: { meaning: "Traceability path to source CSV.", data_type: "path" },
  debug_artifact_path: { meaning: "Traceability path to debug artifacts.", data_type: "path" },
  schema_version: { meaning: "History row schema version.", data_type: "string" }
};

const DEMAND_COLUMN_DEFINITIONS: Record<string, Partial<ColumnDictionaryItem>> = {
  checkin_date: { meaning: "Demand Index check-in date.", data_type: "date", safe_for_demand_signal: "yes" },
  checkout_date: { meaning: "Demand Index checkout date.", data_type: "date", safe_for_demand_signal: "yes" },
  stay_scope: { meaning: "Stay scope aggregated by DP01X.", data_type: "string", safe_for_demand_signal: "yes" },
  row_count: { meaning: "History rows contributing to this date/scope.", data_type: "integer", safe_for_demand_signal: "yes" },
  source_count: { meaning: "Number of sources contributing.", data_type: "integer", safe_for_demand_signal: "yes" },
  property_count: { meaning: "Number of properties represented.", data_type: "integer", safe_for_demand_signal: "yes" },
  direct_price_row_count: { meaning: "Rows usable for direct price medians.", data_type: "integer", safe_for_pricing: "yes", safe_for_demand_signal: "yes" },
  directional_price_row_count: { meaning: "Rows usable directionally only.", data_type: "integer", safe_for_pricing: "directional_only", safe_for_demand_signal: "yes" },
  excluded_row_count: { meaning: "Rows excluded from price medians.", data_type: "integer" },
  sold_out_count: { meaning: "Sold-out rows.", data_type: "integer", safe_for_demand_signal: "yes" },
  available_count: { meaning: "Available rows.", data_type: "integer", safe_for_demand_signal: "yes" },
  not_listed_count: { meaning: "Not-listed rows.", data_type: "integer", safe_for_demand_signal: "directional_only" },
  cross_source_median_jpy: { meaning: "Cross-source median using usable rows.", data_type: "number", safe_for_pricing: "directional_only", safe_for_demand_signal: "yes" },
  direct_only_median_jpy: { meaning: "Median using direct rows only.", data_type: "number", safe_for_pricing: "yes", safe_for_demand_signal: "yes" },
  directional_median_jpy: { meaning: "Median using directional rows.", data_type: "number", safe_for_pricing: "directional_only", safe_for_demand_signal: "yes" },
  sold_out_pressure_score: { meaning: "Score derived from sold-out pressure.", data_type: "number", safe_for_demand_signal: "yes" },
  price_pressure_score: { meaning: "Score derived from price level.", data_type: "number", safe_for_demand_signal: "yes" },
  confidence_score: { meaning: "Score reflecting source confidence.", data_type: "number", safe_for_demand_signal: "yes" },
  calendar_score: { meaning: "Calendar/seasonality score.", data_type: "number", safe_for_demand_signal: "yes" },
  booking_window_score: { meaning: "Booking-window proximity score.", data_type: "number", safe_for_demand_signal: "yes" },
  demand_index: { meaning: "Prototype demand index score.", data_type: "number", safe_for_demand_signal: "yes", common_misread_risk: "Prototype score; not a final pricing command." },
  demand_band: { meaning: "Prototype demand band.", data_type: "enum", allowed_values: "S_extreme|A_strong|B_moderate_high|C_normal|D_weak|E_very_weak", safe_for_demand_signal: "yes" },
  pricing_posture: { meaning: "Advisory pricing posture.", data_type: "enum", allowed_values: "raise_now|hold_strong|hold|sell_through|discount_candidate|insufficient_data", safe_for_demand_signal: "directional_only", common_misread_risk: "Advisory only; not automated price update approval." },
  congestion_forecast_rank: { meaning: "Lodging-derived congestion tendency.", data_type: "enum", allowed_values: "S|A|B|C|D|E", safe_for_demand_signal: "directional_only", common_misread_risk: "Not exact restaurant footfall." },
  confidence_level: { meaning: "DP01X confidence level.", data_type: "enum", allowed_values: "high|medium|low|insufficient", safe_for_demand_signal: "yes" },
  basis_note: { meaning: "DP01X scoring basis note.", data_type: "string", safe_for_demand_signal: "directional_only" },
  recommended_human_action: { meaning: "Human-facing advisory action.", data_type: "string", common_misread_risk: "Not an automated action." }
};

const PROPERTY_UNIVERSE_COLUMN_DEFINITIONS: Record<string, Partial<ColumnDictionaryItem>> = {
  canonical_property_name: { meaning: "Canonical property name.", data_type: "string", safe_for_identity: "yes" },
  canonicalization_status: { meaning: "Canonicalization status, including canonical/needs_review/duplicate_of.", data_type: "string", safe_for_identity: "yes" },
  aliases: { meaning: "Semicolon-separated aliases.", data_type: "string", safe_for_identity: "yes" },
  sources_present: { meaning: "Sources represented in source listing extraction/local extensions.", data_type: "string", safe_for_identity: "yes" },
  jalan_url: { meaning: "Jalan property URL if known.", data_type: "url", safe_for_identity: "yes" },
  jalan_id: { meaning: "Jalan yad id if known.", data_type: "string", safe_for_identity: "yes" },
  rakuten_url: { meaning: "Rakuten HOTEL URL if known.", data_type: "url", safe_for_identity: "yes" },
  rakuten_id: { meaning: "Rakuten hotelNo if known.", data_type: "string", safe_for_identity: "yes" },
  local_source: { meaning: "Local/operator extension source if applicable.", data_type: "string", safe_for_identity: "yes" },
  evidence_note: { meaning: "Human-readable evidence/canonicalization note.", data_type: "string", safe_for_identity: "yes" }
};

const SOURCE_CANDIDATE_COLUMN_DEFINITIONS: Record<string, Partial<ColumnDictionaryItem>> = {
  canonical_property_name: { meaning: "Canonical property name for candidate source row.", data_type: "string", safe_for_identity: "yes" },
  source: { meaning: "Source channel for candidate.", data_type: "enum", allowed_values: "jalan|rakuten|booking|google_hotels", safe_for_identity: "yes" },
  candidate_property_url: { meaning: "Candidate source URL, not necessarily confirmed.", data_type: "url", safe_for_identity: "yes" },
  candidate_source_property_id: { meaning: "Candidate source-specific ID, not necessarily confirmed.", data_type: "string", safe_for_identity: "yes" },
  verification_status: { meaning: "Candidate verification status.", data_type: "enum", allowed_values: "candidate|needs_review|confirmed", safe_for_identity: "yes" },
  evidence_note: { meaning: "Evidence note for candidate source row.", data_type: "string", safe_for_identity: "yes" }
};

const EXCLUDED_AUDIT_COLUMN_DEFINITIONS: Record<string, Partial<ColumnDictionaryItem>> = {
  source: { meaning: "Source where excluded listing was found.", data_type: "string", safe_for_identity: "yes" },
  property_name_raw: { meaning: "Raw excluded listing/property-like name.", data_type: "string", safe_for_identity: "yes" },
  property_url: { meaning: "URL for excluded listing if available.", data_type: "url", safe_for_identity: "yes" },
  source_property_id: { meaning: "Source ID for excluded listing if available.", data_type: "string", safe_for_identity: "yes" },
  exclusion_reason: { meaning: "Reason the row is excluded from core universe.", data_type: "string", safe_for_identity: "yes" },
  evidence_note: { meaning: "Evidence explaining exclusion.", data_type: "string", safe_for_identity: "yes" }
};

function fileType(path: string): string {
  if (path.endsWith(".csv")) return "csv";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "artifact";
}

function sourcePhase(path: string): string {
  if (path.includes("ai_readable_market_manifest")) return "AI-READ01X";
  if (path.includes("zao_signals_")) return "M06X";
  if (path.includes("zao_demand_index_design")) return "DP01X";
  if (path.includes("zao-universe-review")) return "Phase46-48 property universe/source candidates";
  if (path.includes("matsukaneya_canonical_merge")) return "PD-FIX02X";
  return "unknown";
}

function filePurpose(path: string): string {
  if (path.includes("ai_readable_market_manifest")) return "Stable orientation manifest for future AI sessions.";
  if (path.includes("zao_signals_")) return "Monthly local market-signal history shard.";
  if (path.includes("zao_demand_index_design")) return "Prototype Demand Index / DP Matrix design output.";
  if (path.includes("zao_universe_properties")) return "Current approved property universe master export.";
  if (path.includes("source_candidates")) return "Source URL/ID candidate coverage review rows.";
  if (path.includes("alias_map")) return "Canonical alias lookup map.";
  if (path.includes("excluded_audit")) return "Audit list of excluded/ambiguous source listings.";
  if (path.includes("matsukaneya_canonical_merge")) return "Approved Matsukaneya duplicate canonical merge evidence.";
  return "Market intelligence artifact.";
}

function rowIdentity(path: string): string {
  if (path.includes("zao_signals_")) return "row_id";
  if (path.includes("zao_demand_index_design") && path.endsWith(".csv")) return "checkin_date + checkout_date + stay_scope";
  if (path.includes("zao_universe_properties")) return "canonical_property_name";
  if (path.includes("source_candidates")) return "canonical_property_name + source + candidate_source_property_id";
  if (path.includes("alias_map")) return "canonical property key";
  if (path.includes("excluded_audit")) return "source + property_name_raw + source_property_id";
  return "file-level document";
}

function recommendedUse(path: string): string {
  if (path.includes("zao_signals_")) return "Time-series market signal analysis.";
  if (path.includes("zao_demand_index_design")) return "Prototype demand posture review.";
  if (path.includes("zao-universe-review")) return "Property/source identity context.";
  if (path.includes("ai_readable_market_manifest")) return "Session orientation.";
  return "Traceability and human review.";
}

function doNotUseFor(path: string): string {
  if (path.includes("zao_signals_")) return "Do not treat as approval for automated price updates.";
  if (path.includes("zao_demand_index_design")) return "Do not treat pricing posture as an automated command.";
  if (path.includes("source_candidates")) return "Do not treat candidates as confirmed source coverage without review.";
  return "Do not modify without approval.";
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

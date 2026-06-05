// Phase AI-READ01X — AI-readable market intelligence manifest.
//
// Documentation/indexing only. This module reads local artifact summaries and
// renders manifest outputs; it does not write the DB, mutate history shards,
// mutate property master artifacts, fetch live pages, or create PMS output.

export type AiReadableManifestDecision =
  | "ai_readable_market_manifest_ready"
  | "ai_readable_market_manifest_basis_caution"
  | "ai_readable_market_manifest_not_ready";

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export interface HistoryShardSummary {
  path: string;
  rowCount: number;
}

export interface HistorySummary {
  historyFileCount: number;
  totalHistoryRows: number;
  dateRange: { minCheckin: string | null; maxCheckin: string | null };
  sourceCounts: Record<string, number>;
  dpUsageCounts: Record<string, number>;
  basisConfidenceCounts: Record<string, number>;
  availabilityCounts: Record<string, number>;
  soldOutCounts: Record<string, number>;
  propertyCount: number;
  shardRowCounts: HistoryShardSummary[];
}

export interface DemandIndexStatus {
  decision: string;
  demandRowCount: number;
  demandBandCounts: Record<string, number>;
  pricingPostureCounts: Record<string, number>;
  congestionRankCounts: Record<string, number>;
  highDemandSampleDates: string[];
  weakDemandSampleDates: string[];
  basisCautionReason: string;
}

export interface AiReadableMarketManifest {
  run_id: string;
  generated_at_jst: string;
  project_status: Record<string, unknown>;
  latest_entrypoints: Record<string, string[]>;
  history_summary: HistorySummary;
  source_status: Record<string, Record<string, string>>;
  property_discovery_status: Record<string, string>;
  matsukaneya_merge_status: Record<string, string>;
  demand_index_status: DemandIndexStatus;
  known_caveats: string[];
  resolved_issues: string[];
  recommended_next_tasks: string[];
  paused_tasks: string[];
  forbidden_without_approval: string[];
  safe_readonly_commands: string[];
  safety_confirmation: Record<string, boolean>;
  decision: AiReadableManifestDecision;
}

export const HISTORY_SHARD_ENTRYPOINTS = [
  ".data/history/zao_signals_2026_05.csv",
  ".data/history/zao_signals_2026_06.csv",
  ".data/history/zao_signals_2026_07.csv",
  ".data/history/zao_signals_2026_08.csv",
  ".data/history/zao_signals_2026_10.csv",
  ".data/history/zao_signals_2026_12.csv"
] as const;

export const PROPERTY_UNIVERSE_ENTRYPOINTS = [
  ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv",
  ".data/exports/zao-universe-review/zao_source_candidates_20260531_231933.csv",
  ".data/exports/zao-universe-review/zao_source_candidates_multi_source_enriched_20260601_074617.csv",
  ".data/exports/zao-universe-review/zao_alias_map_20260531_231933.json",
  ".data/exports/zao-universe-review/zao_excluded_audit_20260531_231933.csv"
] as const;

export const DEMAND_INDEX_ENTRYPOINTS = [
  ".data/reports/market-update/zao_demand_index_design_20260603_200932.md",
  ".data/reports/market-update/zao_demand_index_design_20260603_200932.csv",
  ".data/reports/market-update/zao_demand_index_design_20260603_200932.json"
] as const;

export const MATSUKANEYA_ENTRYPOINTS = [
  ".data/reports/source-discovery/matsukaneya_canonical_merge_20260603_211617.md",
  ".data/reports/source-discovery/matsukaneya_canonical_merge_20260603_211617.json"
] as const;

export const MANIFEST_LATEST_ENTRYPOINTS = [
  ".data/reports/market-update/ai_readable_market_manifest_latest.md",
  ".data/reports/market-update/ai_readable_market_manifest_latest.json"
] as const;

export const SAFE_READONLY_COMMANDS = [
  "npm run typecheck",
  "npm run test",
  "npm run check:no-paid-sources",
  "npm run db:verify",
  "npm run report:ai-readable-market-manifest"
] as const;

export const FORBIDDEN_WITHOUT_APPROVAL = [
  ".data/exports/zao-universe-review/*",
  ".data/history/*",
  ".github/workflows/*",
  "DB / migrations / production schemas",
  "PMS export scripts"
] as const;

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
  "pms"
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

export function buildHistorySummary(shards: Array<{ path: string; csv: string }>): HistorySummary {
  const sourceCounts: Record<string, number> = {};
  const dpUsageCounts: Record<string, number> = {};
  const basisConfidenceCounts: Record<string, number> = {};
  const availabilityCounts: Record<string, number> = {};
  const soldOutCounts: Record<string, number> = {};
  const properties = new Set<string>();
  const checkins: string[] = [];
  const shardRowCounts: HistoryShardSummary[] = [];
  let totalHistoryRows = 0;

  for (const shard of shards) {
    const parsed = parseCsvTable(shard.csv);
    shardRowCounts.push({ path: shard.path, rowCount: parsed.rows.length });
    totalHistoryRows += parsed.rows.length;
    for (const row of parsed.rows) {
      count(sourceCounts, row["source"] || "unknown");
      count(dpUsageCounts, dpUsage(row));
      count(basisConfidenceCounts, row["basis_confidence"] || "none");
      count(availabilityCounts, row["availability_status"] || "unknown");
      count(soldOutCounts, row["sold_out_status"] || "unknown");
      if (row["canonical_property_name"]) properties.add(row["canonical_property_name"]);
      if (row["checkin"]) checkins.push(row["checkin"]);
    }
  }

  checkins.sort();
  return {
    historyFileCount: shards.length,
    totalHistoryRows,
    dateRange: {
      minCheckin: checkins[0] ?? null,
      maxCheckin: checkins[checkins.length - 1] ?? null
    },
    sourceCounts,
    dpUsageCounts,
    basisConfidenceCounts,
    availabilityCounts,
    soldOutCounts,
    propertyCount: properties.size,
    shardRowCounts
  };
}

export function buildDemandIndexStatus(demandJson: string): DemandIndexStatus {
  const parsed = JSON.parse(demandJson) as {
    summary?: Record<string, unknown>;
    rows?: Array<Record<string, unknown>>;
  };
  const rows = parsed.rows ?? [];
  const highDemand = rows
    .filter((r) => ["S_extreme", "A_strong", "B_moderate_high"].includes(String(r["demandBand"])))
    .slice(0, 5)
    .map((r) => String(r["checkinDate"]));
  const weakDemand = rows
    .filter((r) => ["D_weak", "E_very_weak"].includes(String(r["demandBand"])))
    .slice(0, 5)
    .map((r) => String(r["checkinDate"]));

  return {
    decision: String(parsed.summary?.["decision"] ?? "unknown"),
    demandRowCount: Number(parsed.summary?.["demandRowCount"] ?? rows.length),
    demandBandCounts: asCountMap(parsed.summary?.["demandBandCounts"]),
    pricingPostureCounts: asCountMap(parsed.summary?.["pricingPostureCounts"]),
    congestionRankCounts: asCountMap(parsed.summary?.["congestionRankCounts"]),
    highDemandSampleDates: highDemand,
    weakDemandSampleDates: weakDemand,
    basisCautionReason:
      "DP01X is design/prototype only; current history is thin and mostly B-confidence/directional, so no automated price update is allowed."
  };
}

export function buildAiReadableManifest(input: {
  runId: string;
  generatedAtJst: string;
  historySummary: HistorySummary;
  demandIndexStatus: DemandIndexStatus;
}): AiReadableMarketManifest {
  const decision = decideAiReadableManifest({
    historyRowCount: input.historySummary.totalHistoryRows,
    historyFileCount: input.historySummary.historyFileCount,
    demandDecision: input.demandIndexStatus.decision
  });

  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    project_status: {
      summary:
        "Zao Market Intelligence is a local artifact-based lodging market intelligence system with source-specific probes, cross-source normalization, monthly history shards, Property Discovery workflow, Matsukaneya canonical merge, and a Demand Index prototype. Current outputs are decision-support signals, not automated price updates.",
      propertyDiscovery: "D01X-D05X complete",
      demandIndex: "DP01X complete; design/prototype only; no price update",
      history: "M06X real history append complete; monthly shards exist",
      gitops: "M07X design complete; automation not enabled"
    },
    latest_entrypoints: {
      aiManifest: [...MANIFEST_LATEST_ENTRYPOINTS],
      historyShards: [...HISTORY_SHARD_ENTRYPOINTS],
      propertyUniverse: [...PROPERTY_UNIVERSE_ENTRYPOINTS],
      latestDemandIndex: [...DEMAND_INDEX_ENTRYPOINTS],
      matsukaneyaMerge: [...MATSUKANEYA_ENTRYPOINTS]
    },
    history_summary: input.historySummary,
    source_status: {
      Jalan: {
        status: "strongest source",
        confidence: "A-confidence/direct capable",
        notes: "coupon guard present; sold_out handling present"
      },
      Rakuten: {
        status: "/hplan/calendar JSONP proven",
        confidence: "B-confidence directional unless basis further confirmed",
        notes: "CHARGE_PER_HUMAN; price * 2 used for 2-adult total"
      },
      Booking: {
        status: "official visible base plus visible tax/fee adder",
        confidence: "B-confidence directional where no final all-in marker",
        notes: "no synthetic Booking.com base × 1.1"
      },
      PropertyDiscovery: {
        status: "D01X-D05X complete",
        confidence: "reviewed workflow",
        notes: "蔵王温泉とは and 蔵王温泉について resolved in excluded audit"
      },
      Matsukaneya: {
        status: "duplicate canonical resolved",
        confidence: "approved real merge",
        notes: `${RETAIN_CANONICAL} retained; ${DEPRECATE_CANONICAL} merged`
      }
    },
    property_discovery_status: {
      phases: "D01X-D05X complete",
      genericFalsePositives: "蔵王温泉とは and 蔵王温泉について resolved in excluded audit"
    },
    matsukaneya_merge_status: {
      status: "resolved",
      retainedCanonical: RETAIN_CANONICAL,
      mergedCanonical: DEPRECATE_CANONICAL,
      rakutenHotelNo: "5097",
      jalanYadId: "335940",
      pdFix02xDecision: "matsukaneya_canonical_merge_success"
    },
    demand_index_status: input.demandIndexStatus,
    known_caveats: [
      "DP01X is design/prototype only.",
      "Current history is thin.",
      "Most usable rows are B-confidence/directional.",
      "No automated price update is allowed from DP01X.",
      "Restaurant congestion forecast is not currently requested.",
      "DP03X and R01X are intentionally paused unless user explicitly asks.",
      "GitHub Actions automation is not enabled.",
      "Data repo push is not enabled.",
      "Booking/Rakuten cloud-run WAF risk remains.",
      "Demand Index should be recalibrated after more history accumulates."
    ],
    resolved_issues: [
      "Resolved data-quality fix: Matsukaneya duplicate canonical merge completed in PD-FIX02X."
    ],
    recommended_next_tasks: [
      "AI-READ02X — Data dictionary / schema documentation refinement",
      "DP02X — Demand Index calibration after more history accumulates",
      "M08X — GitHub Actions smoke-test / workflow draft only, not activation"
    ],
    paused_tasks: [
      "DP03X — property-specific price judgment matrix is paused unless the user explicitly asks.",
      "R01X — restaurant-facing congestion forecast prototype is paused unless the user explicitly asks."
    ],
    forbidden_without_approval: [...FORBIDDEN_WITHOUT_APPROVAL],
    safe_readonly_commands: [...SAFE_READONLY_COMMANDS],
    safety_confirmation: {
      dbWrites: false,
      liveExternalFetch: false,
      collectorRerun: false,
      priceUpdate: false,
      pmsOutput: false,
      githubActionsOrGitOps: false,
      propertyMasterMutation: false,
      historyModification: false,
      paidSourceTooling: false
    },
    decision
  };
}

export function decideAiReadableManifest(input: {
  historyFileCount: number;
  historyRowCount: number;
  demandDecision: string;
}): AiReadableManifestDecision {
  if (input.historyFileCount === 0 || input.historyRowCount === 0) return "ai_readable_market_manifest_not_ready";
  if (input.demandDecision.includes("basis_caution") || input.historyRowCount < 300) {
    return "ai_readable_market_manifest_basis_caution";
  }
  return "ai_readable_market_manifest_ready";
}

export function renderAiReadableManifestMarkdown(manifest: AiReadableMarketManifest): string {
  return [
    "# AI-Readable Market Intelligence Manifest (AI-READ01X)",
    "",
    `Generated at: ${manifest.generated_at_jst}`,
    `Decision: ${manifest.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    String(manifest.project_status["summary"]),
    "",
    "## 2. Current Project Status",
    "",
    `- Property Discovery: ${manifest.project_status["propertyDiscovery"]}`,
    "- Matsukaneya duplicate: PD-FIX01X proposal complete; PD-FIX02X real merge complete.",
    `  - retained canonical = ${manifest.matsukaneya_merge_status.retainedCanonical}`,
    `  - merged canonical = ${manifest.matsukaneya_merge_status.mergedCanonical}`,
    "  - Rakuten 5097 and Jalan 335940 preserved under retained canonical.",
    `- Demand Index: ${manifest.project_status["demandIndex"]}`,
    `- History: ${manifest.project_status["history"]}`,
    `- GitOps: ${manifest.project_status["gitops"]}`,
    "",
    "## 3. Latest Stable Entry Points",
    "",
    ...entrypointLines(manifest.latest_entrypoints),
    "",
    "## 4. Source Status Summary",
    "",
    ...Object.entries(manifest.source_status).map(
      ([source, status]) => `- ${source}: ${status.status}; ${status.confidence}; ${status.notes}`
    ),
    "",
    "## 5. History Summary",
    "",
    `- history_file_count=${manifest.history_summary.historyFileCount}`,
    `- total_history_rows=${manifest.history_summary.totalHistoryRows}`,
    `- date_range=${manifest.history_summary.dateRange.minCheckin ?? "-"} to ${manifest.history_summary.dateRange.maxCheckin ?? "-"}`,
    `- source_counts=${JSON.stringify(manifest.history_summary.sourceCounts)}`,
    `- dp_usage_counts=${JSON.stringify(manifest.history_summary.dpUsageCounts)}`,
    `- basis_confidence_counts=${JSON.stringify(manifest.history_summary.basisConfidenceCounts)}`,
    `- availability_counts=${JSON.stringify(manifest.history_summary.availabilityCounts)}`,
    `- sold_out_counts=${JSON.stringify(manifest.history_summary.soldOutCounts)}`,
    `- property_count=${manifest.history_summary.propertyCount}`,
    "- shard_row_counts:",
    ...manifest.history_summary.shardRowCounts.map((s) => `  - ${s.path}: ${s.rowCount}`),
    "",
    "## 6. Latest Demand Index Summary",
    "",
    `- decision=${manifest.demand_index_status.decision}`,
    `- demand_row_count=${manifest.demand_index_status.demandRowCount}`,
    `- demand_band_counts=${JSON.stringify(manifest.demand_index_status.demandBandCounts)}`,
    `- pricing_posture_counts=${JSON.stringify(manifest.demand_index_status.pricingPostureCounts)}`,
    `- congestion_rank_counts=${JSON.stringify(manifest.demand_index_status.congestionRankCounts)}`,
    `- high_demand_sample_dates=${manifest.demand_index_status.highDemandSampleDates.join(", ") || "-"}`,
    `- weak_demand_sample_dates=${manifest.demand_index_status.weakDemandSampleDates.join(", ") || "-"}`,
    `- basis_caution_reason=${manifest.demand_index_status.basisCautionReason}`,
    "",
    "## 7. Known Caveats",
    "",
    ...manifest.known_caveats.map((c) => `- ${c}`),
    "",
    "## 8. Resolved Issues",
    "",
    ...manifest.resolved_issues.map((r) => `- ${r}`),
    "",
    "## 9. What Future AI Should Do Next",
    "",
    ...manifest.recommended_next_tasks.map((t) => `- ${t}`),
    ...manifest.paused_tasks.map((t) => `- Do not proceed to ${t}`),
    "",
    "## 10. Files Future AI Must Not Modify Without Approval",
    "",
    ...manifest.forbidden_without_approval.map((f) => `- ${f}`),
    "",
    "## 11. Safe Read-Only Commands",
    "",
    "```bash",
    ...manifest.safe_readonly_commands,
    "```",
    "",
    "## 12. Safety Confirmation",
    "",
    ...Object.entries(manifest.safety_confirmation).map(([k, v]) => `- ${k}=${v ? "true" : "false"}`),
    ""
  ].join("\n");
}

export function renderAiReadableManifestCsv(manifest: AiReadableMarketManifest): string {
  const rows: Array<[string, string]> = [
    ["run_id", manifest.run_id],
    ["generated_at_jst", manifest.generated_at_jst],
    ["decision", manifest.decision],
    ["history_file_count", String(manifest.history_summary.historyFileCount)],
    ["total_history_rows", String(manifest.history_summary.totalHistoryRows)],
    ["history_date_range", `${manifest.history_summary.dateRange.minCheckin ?? ""}..${manifest.history_summary.dateRange.maxCheckin ?? ""}`],
    ["demand_row_count", String(manifest.demand_index_status.demandRowCount)],
    ["demand_decision", manifest.demand_index_status.decision],
    ["matsukaneya_status", manifest.matsukaneya_merge_status["status"] ?? ""],
    ["recommended_next_tasks", manifest.recommended_next_tasks.join(";")]
  ];
  return `key,value\n${rows.map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`).join("\n")}\n`;
}

export function assertNoForbiddenOutputColumns(headerLine: string): void {
  const lower = headerLine.toLowerCase();
  for (const token of FORBIDDEN_OUTPUT_COLUMN_TOKENS) {
    if (lower.includes(token)) throw new Error(`AI-READ01X output must not include forbidden token: ${token}`);
  }
}

function entrypointLines(entrypoints: Record<string, string[]>): string[] {
  const lines: string[] = [];
  for (const [group, paths] of Object.entries(entrypoints)) {
    lines.push(`- ${group}:`);
    for (const path of paths) lines.push(`  - ${path}`);
  }
  return lines;
}

function dpUsage(row: Record<string, string>): string {
  if (row["is_price_usable_for_dp_direct"] === "true") return "direct";
  if (row["is_price_usable_for_dp_directional"] === "true") return "directional";
  if (row["is_price_excluded_from_dp"] === "true") return "excluded";
  return "unusable";
}

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function asCountMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, Number(v)]));
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

const RETAIN_CANONICAL = "ホテル松金屋アネックス";
const DEPRECATE_CANONICAL = "松金や －MATSUKANEYA ANNEX－";

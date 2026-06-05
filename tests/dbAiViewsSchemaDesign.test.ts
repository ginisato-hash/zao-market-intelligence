import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDbAiViewsSchemaDesign,
  idempotencyRules,
  renderDbAiViewsSchemaReport,
  renderSchemaDraftSql,
  renderViewsDraftSql,
  tableDesigns,
  viewDesigns
} from "../src/services/dbAiViewsSchemaDesign";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/dbAiViewsSchemaDesign.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildDbAiViewsSchemaDesign.ts"), "utf8");

function design() {
  return buildDbAiViewsSchemaDesign({
    runId: "db_ai_views_schema_design_test",
    generatedAtJst: "2026-06-03T22:30:00+09:00",
    schemaDraftSqlPath: ".data/debug/db-ai-views-schema-design/test/schema_draft.sql",
    viewsDraftSqlPath: ".data/debug/db-ai-views-schema-design/test/views_draft.sql",
    historyFileCount: 6,
    historyHeaderCount: 45,
    dbArtifactCount: 7
  });
}

function table(name: string) {
  const found = tableDesigns().find((t) => t.name === name);
  expect(found).toBeTruthy();
  return found!;
}

function view(name: string) {
  const found = viewDesigns().find((v) => v.name === name);
  expect(found).toBeTruthy();
  return found!;
}

describe("DB AI views schema design", () => {
  it("designs market_signal_history", () => {
    expect(table("market_signal_history").purpose).toContain("DB mirror");
  });

  it("designs market_signal_sync_runs", () => {
    expect(table("market_signal_sync_runs").columns.map((c) => c.name)).toContain("sync_run_id");
  });

  it("designs property_master_context", () => {
    expect(table("property_master_context").columns.map((c) => c.name)).toContain("source_candidates_json");
  });

  it("designs ai_context_packs", () => {
    expect(table("ai_context_packs").columns.map((c) => c.name)).toContain("payload_json");
  });

  it("market_signal_history has row_id primary key", () => {
    const rowId = table("market_signal_history").columns.find((c) => c.name === "row_id");
    expect(rowId?.constraints).toContain("PRIMARY KEY");
  });

  it("market_signal_history has row_hash conflict detection", () => {
    const rowHash = table("market_signal_history").columns.find((c) => c.name === "row_hash");
    expect(rowHash?.constraints).toContain("NOT NULL");
    expect(rowHash?.purpose).toContain("detect");
  });

  it("includes row_id plus same hash skip rule", () => {
    expect(idempotencyRules().join("\n")).toContain("same row_id + same row_hash = skip identical");
  });

  it("includes row_id plus different hash conflict rule", () => {
    expect(idempotencyRules().join("\n")).toContain("same row_id + different row_hash = conflict, block sync");
  });

  it("designs v_ai_market_daily_summary", () => {
    expect(view("v_ai_market_daily_summary").columns).toContain("direct_median_total_jpy");
  });

  it("designs v_ai_property_latest_signal", () => {
    expect(view("v_ai_property_latest_signal").columns).toContain("row_hash");
  });

  it("designs v_ai_sold_out_pressure", () => {
    expect(view("v_ai_sold_out_pressure").columns).toContain("sold_out_ratio");
  });

  it("designs v_ai_price_pressure", () => {
    expect(view("v_ai_price_pressure").columns).toContain("p90_total_jpy");
  });

  it("designs v_ai_property_master_context", () => {
    expect(view("v_ai_property_master_context").columns).toContain("aliases_json");
  });

  it("designs v_ai_task_context_latest", () => {
    expect(view("v_ai_task_context_latest").columns).toContain("payload_json");
  });

  it("query recipes include market report", () => {
    expect(design().query_recipes.map((q) => q.name)).toContain("market_report_for_date_range");
  });

  it("query recipes include pricing support context", () => {
    expect(design().query_recipes.map((q) => q.name)).toContain("pricing_support_context");
  });

  it("query recipes include data-quality check", () => {
    expect(design().query_recipes.map((q) => q.name)).toContain("data_quality_property_mapping_check");
  });

  it("query recipes include AI bootstrap", () => {
    expect(design().query_recipes.map((q) => q.name)).toContain("ai_bootstrap_context");
  });

  it("query caveats include no automated pricing from B-confidence", () => {
    const caveats = design().query_recipes.flatMap((q) => q.caveats).join("\n");
    expect(caveats).toContain("Do not treat B-confidence as automated pricing signal.");
    expect(caveats).toContain("Do not update PMS/OTA from query results.");
  });

  it("rebuild strategy starts from .data/history", () => {
    expect(design().rebuild_strategy.join("\n")).toContain("Read .data/history monthly shards");
  });

  it("real DB sync requires explicit approval", () => {
    expect(design().approval_gates.join("\n")).toContain("AUTO04X first DB mirror real sync: requires explicit approval.");
  });

  it("draft SQL is written under debug only", () => {
    const paths = design().draft_sql_paths;
    expect(paths.schema_draft_sql).toContain(".data/debug/db-ai-views-schema-design");
    expect(paths.views_draft_sql).toContain(".data/debug/db-ai-views-schema-design");
    expect(paths.location_policy).toContain("no migrations are created");
  });

  it("does not create migrations", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*migrations/);
    expect(design().draft_sql_paths.location_policy).toContain("not a migration");
  });

  it("does not execute SQL", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/openLocalDatabase|executeMigration|better-sqlite3|\.exec\s*\(|\.prepare\s*\(/);
    }
  });

  it("does not write DB", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i);
      expect(src).not.toMatch(/rate_snapshots|inventory_snapshots|collector_runs/);
    }
  });

  it("does not modify .data/history", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/);
    }
  });

  it("does not modify property master", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/exports\/zao-universe-review/);
    }
  });

  it("has no GitHub Actions activation", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\.github\/workflows|workflow_dispatch|schedule:/);
    }
  });

  it("has no paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs|paid proxy/i);
    }
  });

  it("decision is ready or basis_caution when report is generated", () => {
    expect(["db_ai_views_schema_design_ready", "db_ai_views_schema_design_basis_caution"]).toContain(design().decision);
    expect(renderDbAiViewsSchemaReport(design())).toContain("# DB Schema + AI-Readable Views Design");
  });

  it("renders schema and view draft SQL without executing it", () => {
    expect(renderSchemaDraftSql(design())).toContain("CREATE TABLE market_signal_history");
    expect(renderViewsDraftSql(design())).toContain("CREATE VIEW v_ai_market_daily_summary");
    expect(renderViewsDraftSql(design())).toContain("Do not execute in this phase");
  });
});

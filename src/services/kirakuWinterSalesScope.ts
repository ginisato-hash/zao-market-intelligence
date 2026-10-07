// Kiraku winter sales-scope manifest reader (read-only, no network).
//
// RMS 側が生成する JSON (schema kiraku_winter_sales_scope_v1) を読むだけ。
// RMS のコードには依存しない。契約:
//   { schema_version, property_id, generated_at, season:{from,to},
//     dates:[{stay_date,state,sellable_room_count,newly_sellable,transition_detected_at}] }
//
// 安全側ルール (NEVER treat missing as selling):
//  - env 未設定 / ファイル無し / parse 不能 / schema 不一致 / generated_at が
//    MAX_AGE_HOURS 超の stale => manifest なし。冬季全日が WARM。warning を返す。
//  - state === "SELLABLE" の日だけ ACTIVE。NO_SELLABLE_INVENTORY / UNKNOWN /
//    manifest に載っていない日は WARM。
//  - 販売窓外の日は無視。

import { existsSync, readFileSync } from "node:fs";
import { isInKirakuWinterSalesWindow } from "./kirakuWinterSalesWindow";

export const WINTER_SALES_SCOPE_ENV = "KIRAKU_WINTER_SALES_SCOPE_PATH";
export const WINTER_SALES_SCOPE_SCHEMA = "kiraku_winter_sales_scope_v1";
export const WINTER_SALES_SCOPE_MAX_AGE_HOURS = 6;

export type WinterSalesState = "SELLABLE" | "NO_SELLABLE_INVENTORY" | "UNKNOWN";
export type WinterLane = "ACTIVE" | "WARM";

export interface WinterScopeDate {
  stay_date: string;
  state: WinterSalesState;
  sellable_room_count: number;
  newly_sellable: boolean;
  transition_detected_at: string | null;
}

export type WinterScopeStatus = "ok" | "no_env" | "missing_file" | "unparseable" | "invalid_schema" | "stale" | "invalid_generated_at";

export interface WinterSalesScope {
  status: WinterScopeStatus;
  warning: string | null;
  generated_at: string | null;
  // 窓内の SELLABLE な日のみ (status==="ok" のときだけ非空)。
  dates: ReadonlyMap<string, WinterScopeDate>;
}

const STATES: readonly string[] = ["SELLABLE", "NO_SELLABLE_INVENTORY", "UNKNOWN"];

function noManifest(status: WinterScopeStatus, warning: string, generatedAt: string | null = null): WinterSalesScope {
  return { status, warning: `winter_sales_scope_${status}:${warning}; all winter dates treated as WARM`, generated_at: generatedAt, dates: new Map() };
}

export function parseWinterSalesScope(raw: unknown, nowMs: number, maxAgeHours: number = WINTER_SALES_SCOPE_MAX_AGE_HOURS): WinterSalesScope {
  if (typeof raw !== "object" || raw === null) return noManifest("invalid_schema", "not_an_object");
  const m = raw as Record<string, unknown>;
  if (m["schema_version"] !== WINTER_SALES_SCOPE_SCHEMA) return noManifest("invalid_schema", `schema_version=${String(m["schema_version"])}`);
  if (!Array.isArray(m["dates"])) return noManifest("invalid_schema", "dates_not_array");
  const genRaw = m["generated_at"];
  const genMs = typeof genRaw === "string" ? Date.parse(genRaw) : Number.NaN;
  if (!Number.isFinite(genMs)) return noManifest("invalid_generated_at", String(genRaw));
  const ageH = (nowMs - genMs) / 3_600_000;
  // 未来すぎる generated_at (時計ずれ) も信用しない。
  if (ageH > maxAgeHours || ageH < -1) return noManifest("stale", `age_hours=${ageH.toFixed(1)}`, String(genRaw));

  const dates = new Map<string, WinterScopeDate>();
  for (const d of m["dates"] as unknown[]) {
    if (typeof d !== "object" || d === null) continue;
    const r = d as Record<string, unknown>;
    const stay = r["stay_date"];
    if (typeof stay !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(stay) || !isInKirakuWinterSalesWindow(stay)) continue;
    const state = typeof r["state"] === "string" && STATES.includes(r["state"]) ? (r["state"] as WinterSalesState) : "UNKNOWN";
    if (state !== "SELLABLE") continue; // 非 SELLABLE は WARM (載せない)
    const tdRaw = r["transition_detected_at"];
    const td = typeof tdRaw === "string" && Number.isFinite(Date.parse(tdRaw)) ? tdRaw : null;
    dates.set(stay, {
      stay_date: stay,
      state,
      sellable_room_count: typeof r["sellable_room_count"] === "number" ? r["sellable_room_count"] : 0,
      // newly_sellable は検出時刻 (世代) がある場合のみ有効。世代無しは bounded override できない。
      newly_sellable: r["newly_sellable"] === true && td !== null,
      transition_detected_at: td
    });
  }
  return { status: "ok", warning: null, generated_at: String(genRaw), dates };
}

export function loadWinterSalesScope(env: Record<string, string | undefined>, nowMs: number = Date.now()): WinterSalesScope {
  const path = (env[WINTER_SALES_SCOPE_ENV] ?? "").trim();
  if (path === "") return noManifest("no_env", WINTER_SALES_SCOPE_ENV);
  if (!existsSync(path)) return noManifest("missing_file", path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return noManifest("unparseable", path);
  }
  return parseWinterSalesScope(parsed, nowMs);
}

export function winterLaneOf(scope: WinterSalesScope | undefined, stayDate: string): WinterLane | null {
  if (!isInKirakuWinterSalesWindow(stayDate)) return null;
  return scope !== undefined && scope.status === "ok" && scope.dates.get(stayDate)?.state === "SELLABLE" ? "ACTIVE" : "WARM";
}


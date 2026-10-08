// Kiraku winter coverage simulation (READ-ONLY).
//
// 旧 planner と新 planner (冬季販売レーン) を、リポジトリにコミット済みの
// .data/history を初期状態として ~14 日 (12 slots/day, 本番 caps = base x
// ZMI_CRAWL_VOLUME_MULTIPLIER=3) 再生する。ネットワーク/ブラウザ/DB/history 書込み
// は一切しない。全 selected が成功し collected_at が更新されると仮定する。
//
// 旧 planner:
//   ZMI_SIM_OLD_PLANNER=/path/to/base/src/services/rotatingCollectionScopePlanner.ts
//   を指定すると base commit の実ファイルを動的 import する (推奨)。未指定なら
//   新コードを winterLaneEnabled:false で動かす近似になる。
//
// 採用基準・最小構成の選択は services/winterLaneAcceptance.ts (単体テストあり)。
//
// 使い方: node --import tsx src/scripts/simulateWinterCoverage.ts [--out docs/xxx.md]

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { liveTargets } from "../services/marketRefreshTargetUniverse";
import {
  SLOT_HOURS,
  buildRotatingPlan as buildNewPlan,
  scaledRotatingCaps,
  RMS_CRITICAL_LEAD_DAYS,
  OWN_PROPERTY_CRITICAL_LEAD_DAYS,
  DEFAULT_SERVICE_DEADLINE_HOURS,
  PRIMARY_COMPARABLE_BOOKING_SLUGS,
  type RotatingDemandConfig,
  type RotatingPlan
} from "../services/rotatingCollectionScopePlanner";
import { LEGACY_SKI_SEASON_WINDOW, MARKET_RESEARCH_SKI_SEASON_WINDOW, kirakuWinterSalesDates } from "../services/kirakuWinterSalesWindow";
import { parseWinterSalesScope, winterLaneOf, type WinterSalesScope } from "../services/kirakuWinterSalesScope";
import { winterTargetHours } from "../services/winterSalesLanePlanner";
import { getOwnPropertyKey, isOwnPropertyName } from "../services/ownPropertyTargets";
import {
  ACCEPT_MIN_PCT, CANDIDATE_MULTIPLIERS, CANDIDATE_SHARES, checkAcceptance, selectMinimalConfig,
  type AcceptanceInput, type ConfigResult
} from "../services/winterLaneAcceptance";

const HISTORY_DIR = ".data/history";
const SIM_DAYS = 14;
const WARMUP_DAYS = 7; // 後半 7 日を定常状態として時間平均する
const KIRAKU_SLUG = "xi-raku";

// 本番 runner (runAutoRunnerMarketRefreshRotating.ts) の DEMAND_CONFIG と同内容。
const DEMAND_CONFIG: RotatingDemandConfig = {
  public_holidays: {
    "2026-07-20": "海の日", "2026-08-11": "山の日", "2026-09-21": "敬老の日",
    "2026-09-22": "国民の休日", "2026-09-23": "秋分の日", "2026-10-12": "スポーツの日",
    "2026-11-03": "文化の日", "2026-11-23": "勤労感謝の日", "2027-01-01": "元日",
    "2027-01-11": "成人の日", "2027-02-11": "建国記念の日", "2027-02-23": "天皇誕生日"
  },
  long_weekend_dates: new Set([
    "2026-07-18", "2026-07-19", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22",
    "2026-10-10", "2026-10-11", "2026-11-21", "2026-11-22", "2027-01-09", "2027-01-10"
  ]),
  peak_periods: [
    { code: "obon", from: "2026-08-08", to: "2026-08-16" },
    { code: "autumn_foliage", from: "2026-10-10", to: "2026-11-08", saturday_only: true },
    { code: "ski_season", from: MARKET_RESEARCH_SKI_SEASON_WINDOW.from, to: MARKET_RESEARCH_SKI_SEASON_WINDOW.to, saturday_only: true },
    { code: "year_end_peak", from: "2026-12-28", to: "2027-01-03" }
  ]
};

type PlanFn = (input: Record<string, unknown>) => RotatingPlan;
// 新 planner は冬季レーン有効 (本番では gate: ZMI_WINTER_SALES_LANE_ENABLED=1 かつ multiplier>=4)。
const newPlan: PlanFn = (i) => buildNewPlan({ ...(i as Parameters<typeof buildNewPlan>[0]), winterLaneEnabled: true });

function parseCsvLine(line: string): string[] {
  const cells: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur);
  return cells;
}

function readHistoryLastCollected(): { map: Map<string, string>; latest: string; rows: number } {
  const map = new Map<string, string>();
  let latest = ""; let rows = 0;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x)).sort()) {
    const lines = readFileSync(join(HISTORY_DIR, f), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const h = parseCsvLine(lines[0]!);
    const si = h.indexOf("source"); const slugI = h.indexOf("source_slug_or_code"); const ci = h.indexOf("checkin"); const atI = h.indexOf("collected_at_jst");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const at = c[atI] ?? "";
      rows += 1;
      const key = `${c[si]}|${c[slugI]}|${c[ci]}`;
      const prev = map.get(key);
      if (prev === undefined || at > prev) map.set(key, at);
      if (at > latest) latest = at;
    }
  }
  return { map, latest, rows };
}

// ---- JST wall-clock helpers (naive, same convention as the planner) ----
const HOUR_MS = 3_600_000;
function msOf(iso: string): number { return Date.parse(`${iso.slice(0, 19)}Z`); }
function isoOf(ms: number): string { return `${new Date(ms).toISOString().slice(0, 19)}+09:00`; }
function ageHours(pastIso: string, nowMs: number): number { return (nowMs - msOf(pastIso)) / HOUR_MS; }
function daysBetween(fromYmd: string, toYmd: string): number { return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000); }

type ScenarioId = "a_nothing_selling" | "b_0101_0331_selling" | "c_full_selling_bulk_transition";

function scopeFor(sc: ScenarioId, nowMs: number, dayIdx: number, transitionAt: string): WinterSalesScope {
  const all = kirakuWinterSalesDates();
  let dates: { stay_date: string; state: string; newly_sellable: boolean; transition_detected_at: string | null }[];
  if (sc === "a_nothing_selling") dates = all.map((d) => ({ stay_date: d, state: "NO_SELLABLE_INVENTORY", newly_sellable: false, transition_detected_at: null }));
  else if (sc === "b_0101_0331_selling") dates = all.map((d) => ({ stay_date: d, state: d >= "2027-01-01" ? "SELLABLE" : "NO_SELLABLE_INVENTORY", newly_sellable: false, transition_detected_at: null }));
  else if (dayIdx < 3) dates = all.map((d) => ({ stay_date: d, state: "NO_SELLABLE_INVENTORY", newly_sellable: false, transition_detected_at: null }));
  else {
    // 一括 open: transition_detected_at の世代は sim 3 日目 00:00 で固定。newly_sellable は 24h 保持。
    const fresh = nowMs - msOf(transitionAt) < 24 * HOUR_MS;
    dates = all.map((d) => ({ stay_date: d, state: "SELLABLE", newly_sellable: fresh, transition_detected_at: fresh ? transitionAt : null }));
  }
  return parseWinterSalesScope({
    schema_version: "kiraku_winter_sales_scope_v1", property_id: "330695", generated_at: `${isoOf(nowMs).slice(0, 19)}Z`, // nowMs は naive JST を UTC とみなす内部時計なので同じ規約に揃える
    season: { from: "2026-12-20", to: "2027-03-31" },
    dates: dates.map((d) => ({ ...d, sellable_room_count: d.state === "SELLABLE" ? 1 : 0 }))
  }, nowMs);
}

interface Metrics {
  planner: "old" | "new";
  scenario: ScenarioId;
  start_date: string;
  booking_pages_per_day_total: number;
  booking_pages_per_day_on_winter_cells: number;
  winter_required_pages_per_day: number | null;
  global_booking_cap_per_day: number;
  global_cap_utilisation_pct: number;
  jalan_pages_per_day: number;
  winter_budget_per_run: number | null;
  primary_cov_within_sla_final_pct: number;
  primary_cov_within_sla_steady_pct: number;
  primary_cov_within_1_5x_steady_pct: number;
  kiraku_own_cov_within_sla_steady_pct: number | null;
  max_service_age_hours_final: number | null;
  never_served_primary_cells_final: number;
  near_term_cells_total: number;
  near_term_starved_final: number;
  near_term_starved_steady_avg: number;
  max_cell_booking_pages_per_run_one_property: number;
  transition_cooldown_overrides: number;
  multiplier: number;
  share: number | null;
  never_served_steady_max: number;
  near_over96_steady_avg: number;
  effective_winter_share_pct: number;
  backpressure_runs: number;
}

async function loadOldPlanner(): Promise<{ fn: PlanFn; source: string }> {
  const p = process.env["ZMI_SIM_OLD_PLANNER"];
  if (p !== undefined && p !== "" && existsSync(p)) {
    const mod = (await import(pathToFileURL(p).href)) as { buildRotatingPlan: PlanFn };
    return { fn: mod.buildRotatingPlan, source: `base commit planner file (${p})` };
  }
  return { fn: ((i: Record<string, unknown>) => buildNewPlan({ ...(i as Parameters<typeof buildNewPlan>[0]), winterLaneEnabled: false })) as PlanFn, source: "new code with winterLaneEnabled=false (approximation)" };
}

function simulate(args: { planner: "old" | "new"; plan: PlanFn; scenario: ScenarioId; startDate: string; history: Map<string, string>; maxShare?: number; multiplier: number }): Metrics {
  const { planner, plan, scenario, startDate } = args;
  const CAPS = scaledRotatingCaps(args.multiplier);
  const last = new Map(args.history); // 各 run 独立 (history は不変)
  const targets = liveTargets();
  const bookingTargets = targets.filter((t) => t.source === "booking" && t.enabled_for_live && t.verified_mapping);
  const primarySlugs = [...PRIMARY_COMPARABLE_BOOKING_SLUGS].sort();
  const winterDates = kirakuWinterSalesDates();
  const attempted = new Set<string>();
  const startMs = msOf(`${startDate}T00:00:00`);
  const transitionAt = isoOf(startMs + 3 * 24 * HOUR_MS);

  let bookingTotal = 0; let bookingWinter = 0; let jalanTotal = 0; let requiredSum = 0; let requiredN = 0; let overrides = 0; let maxPerProp = 0; let budget: number | null = null; let bpRuns = 0;
  const steadyCov: number[] = []; const steadyCov15: number[] = []; const steadyOwn: number[] = []; const steadyStarved: number[] = []; const steadyOver96: number[] = []; let neverSteadyMax = 0;
  let finalCov = 0; let finalMaxAge: number | null = null; let finalNever = 0; let finalStarved = 0; let nearTermTotal = 0;

  const evaluate = (nowMs: number, scope: WinterSalesScope): { cov: number; cov15: number; own: number | null; maxAge: number | null; never: number; starved: number; nearTotal: number; over96: number } => {
    const today = isoOf(nowMs).slice(0, 10);
    let ok = 0; let ok15 = 0; let n = 0; let maxAge: number | null = null; let never = 0;
    for (const slug of primarySlugs) {
      for (const d of winterDates) {
        const off = daysBetween(today, d);
        if (off < 1) continue;
        const lane = winterLaneOf(scope, d)!; // SLA は両 planner 共通の定義 (manifest 準拠)
        const target = winterTargetHours(lane, off);
        const at = last.get(`booking|${slug}|${d}`);
        n += 1;
        if (at === undefined) { never += 1; continue; }
        const age = ageHours(at, nowMs);
        if (maxAge === null || age > maxAge) maxAge = age;
        if (age <= target) ok += 1;
        if (age <= target * 1.5) ok15 += 1;
      }
    }
    let own: number | null = null;
    let ownN = 0; let ownOk = 0;
    for (const d of winterDates) {
      const off = daysBetween(today, d);
      if (off < 1 || winterLaneOf(scope, d) !== "ACTIVE") continue;
      ownN += 1;
      const at = last.get(`booking|${KIRAKU_SLUG}|${d}`);
      if (at !== undefined && ageHours(at, nowMs) <= winterTargetHours("ACTIVE", off)) ownOk += 1;
    }
    if (ownN > 0) own = ownOk / ownN;
    // near-term (RMS-critical) cells = 既存 planner の critical 定義 (competitor <=56d / own <=90d)。
    let starved = 0; let nearTotal = 0; let over96 = 0;
    for (const t of bookingTargets) {
      const horizon = isOwnPropertyName(t.canonical_property_name) ? OWN_PROPERTY_CRITICAL_LEAD_DAYS : RMS_CRITICAL_LEAD_DAYS;
      for (let off = 1; off <= horizon; off += 1) {
        const d = isoOf(msOf(`${today}T00:00:00`) + off * 86_400_000).slice(0, 10);
        nearTotal += 1;
        const at = last.get(`booking|${t.property_slug}|${d}`);
        if (at === undefined || ageHours(at, nowMs) >= DEFAULT_SERVICE_DEADLINE_HOURS) starved += 1;
        if (at === undefined || ageHours(at, nowMs) > 96) over96 += 1;
      }
    }
    return { cov: n === 0 ? 0 : ok / n, cov15: n === 0 ? 0 : ok15 / n, own, maxAge, never, starved, nearTotal, over96 };
  };

  const totalSlots = SIM_DAYS * SLOT_HOURS.length;
  for (let s = 0; s < totalSlots; s += 1) {
    const dayIdx = Math.floor(s / SLOT_HOURS.length);
    const hour = SLOT_HOURS[s % SLOT_HOURS.length]!;
    const nowMs = startMs + dayIdx * 24 * HOUR_MS + hour * HOUR_MS;
    const nowIso = isoOf(nowMs);
    const scope = scopeFor(scenario, nowMs, dayIdx, transitionAt);
    const p = plan({
      runDateIso: nowIso.slice(0, 10), nowIso, slotHourJst: hour, liveTargets: targets, config: planner === "new" ? DEMAND_CONFIG : { ...DEMAND_CONFIG, peak_periods: DEMAND_CONFIG.peak_periods.map((p) => (p.code === "ski_season" ? { ...p, from: LEGACY_SKI_SEASON_WINDOW.from, to: LEGACY_SKI_SEASON_WINDOW.to } : p)) },
      lastCollectedAt: last, caps: CAPS, nearTermDenseDays: 30, forcedDates: [],
      winterScope: scope, winterTransitionAttempted: attempted,
      ...(args.maxShare !== undefined ? { winterLaneMaxBookingShare: args.maxShare } : {})
    });
    const wl = (p as RotatingPlan).winter_lane;
    if (planner === "new" && wl !== undefined) {
      for (const k of wl.transition_keys_selected) attempted.add(k);
      overrides += wl.transition_cooldown_overrides.length;
      budget = wl.lane_budget_per_run;
      if (wl.backpressure_active === true) bpRuns += 1;
      requiredSum += wl.required_pages_per_day; requiredN += 1;
    }
    const perProp = new Map<string, number>();
    for (const t of p.selected) {
      last.set(`${t.source}|${t.property_slug}|${t.stay_date}`, nowIso);
      if (t.source === "booking") {
        bookingTotal += 1;
        if (winterDates.includes(t.stay_date) && (PRIMARY_COMPARABLE_BOOKING_SLUGS.has(t.property_slug) || getOwnPropertyKey(t.canonical_property_name) === "kiraku")) bookingWinter += 1;
        perProp.set(t.property_slug, (perProp.get(t.property_slug) ?? 0) + 1);
      } else jalanTotal += 1;
    }
    maxPerProp = Math.max(maxPerProp, ...perProp.values(), 0);
    if (dayIdx >= WARMUP_DAYS) {
      const e = evaluate(nowMs + 2 * HOUR_MS - 1, scope); // 次 slot 直前 (= この slot 実行後の状態)
      steadyCov.push(e.cov); steadyCov15.push(e.cov15); steadyStarved.push(e.starved); steadyOver96.push(e.over96); neverSteadyMax = Math.max(neverSteadyMax, e.never);
      if (e.own !== null) steadyOwn.push(e.own);
    }
    if (s === totalSlots - 1) {
      const e = evaluate(nowMs + 2 * HOUR_MS - 1, scope);
      finalCov = e.cov; finalMaxAge = e.maxAge; finalNever = e.never; finalStarved = e.starved; nearTermTotal = e.nearTotal;
    }
  }
  const avg = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length);
  const pct = (x: number): number => Math.round(x * 1000) / 10;
  const capPerDay = CAPS.booking_pages_per_run * SLOT_HOURS.length;
  return {
    planner, scenario, start_date: startDate,
    booking_pages_per_day_total: Math.round(bookingTotal / SIM_DAYS),
    booking_pages_per_day_on_winter_cells: Math.round((bookingWinter / SIM_DAYS) * 10) / 10,
    winter_required_pages_per_day: planner === "new" && requiredN > 0 ? Math.round((requiredSum / requiredN) * 10) / 10 : null,
    global_booking_cap_per_day: capPerDay,
    global_cap_utilisation_pct: pct(bookingTotal / SIM_DAYS / capPerDay),
    jalan_pages_per_day: Math.round(jalanTotal / SIM_DAYS),
    winter_budget_per_run: budget,
    primary_cov_within_sla_final_pct: pct(finalCov),
    primary_cov_within_sla_steady_pct: pct(avg(steadyCov)),
    primary_cov_within_1_5x_steady_pct: pct(avg(steadyCov15)),
    kiraku_own_cov_within_sla_steady_pct: steadyOwn.length > 0 ? pct(avg(steadyOwn)) : null,
    max_service_age_hours_final: finalMaxAge === null ? null : Math.round(finalMaxAge * 10) / 10,
    never_served_primary_cells_final: finalNever,
    near_term_cells_total: nearTermTotal,
    near_term_starved_final: finalStarved,
    near_term_starved_steady_avg: Math.round(avg(steadyStarved) * 10) / 10,
    max_cell_booking_pages_per_run_one_property: maxPerProp,
    transition_cooldown_overrides: overrides,
    multiplier: args.multiplier, share: args.maxShare ?? null,
    never_served_steady_max: neverSteadyMax,
    near_over96_steady_avg: Math.round(avg(steadyOver96) * 10) / 10,
    effective_winter_share_pct: bookingTotal === 0 ? 0 : pct(bookingWinter / bookingTotal),
    backpressure_runs: bpRuns
  };
}

interface Case { key: string; start: string; scenario: ScenarioId; kind: "ACTIVE" | "WARM"; label: string }
const CASES: Case[] = [
  { key: "oct_warm", start: "2026-10-08", scenario: "a_nothing_selling", kind: "WARM", label: "10/08 全日 WARM" },
  { key: "oct_active", start: "2026-10-08", scenario: "b_0101_0331_selling", kind: "ACTIVE", label: "10/08 1/1-3/31 ACTIVE" },
  { key: "dec_warm", start: "2026-12-10", scenario: "a_nothing_selling", kind: "WARM", label: "12/10 全日 WARM" },
  { key: "dec_active", start: "2026-12-10", scenario: "b_0101_0331_selling", kind: "ACTIVE", label: "12/10 1/1-3/31 ACTIVE" },
  { key: "dec_bulk", start: "2026-12-10", scenario: "c_full_selling_bulk_transition", kind: "ACTIVE", label: "12/10 全窓 ACTIVE + bulk transition" }
];

function toAcceptance(c: Case, n: Metrics, base: Metrics): AcceptanceInput {
  return {
    kind: c.kind,
    primary_cov_steady_pct: n.primary_cov_within_sla_steady_pct,
    primary_cov_final_pct: n.primary_cov_within_sla_final_pct,
    primary_cov_1_5x_steady_pct: n.primary_cov_within_1_5x_steady_pct,
    own_cov_steady_pct: n.kiraku_own_cov_within_sla_steady_pct,
    never_served_steady_max: n.never_served_steady_max,
    near_starved_steady_avg: n.near_term_starved_steady_avg,
    near_over96_steady_avg: n.near_over96_steady_avg,
    base_near_starved_steady_avg: base.near_term_starved_steady_avg,
    base_near_over96_steady_avg: base.near_over96_steady_avg,
    near_term_cells_total: n.near_term_cells_total
  };
}

function render(a: { old: Map<string, Metrics>; grid: Map<string, Metrics>; configs: ConfigResult[]; sel: ReturnType<typeof selectMinimalConfig>; meta: { historyRows: number; historyLatest: string; oldSource: string } }): string {
  const L: string[] = [];
  const key = (c: string, m: number, sh?: number): string => `${c}|${m}|${sh ?? "old"}`;
  L.push("# Kiraku 冬季販売窓 coverage simulation / multiplier x share 感度分析");
  L.push("");
  L.push("`npm run simulate:winter-coverage` が生成 (read-only: ネットワーク/ブラウザ/history 書込みなし)。数値は実走行の出力。");
  L.push("");
  L.push("## 前提");
  L.push(`- 初期状態: コミット済み .data/history (${a.meta.historyRows.toLocaleString("en-US")} 行, 最新 collected_at=${a.meta.historyLatest}) の (source, slug, checkin) 別 最終収集時刻。`);
  L.push(`- 期間 ${SIM_DAYS} 日 (${SIM_DAYS * 12} slots, 2h cadence)。後半 ${WARMUP_DAYS} 日を各 slot 実行後に評価し時間平均 (steady)。全 selected は成功と仮定。cooldown 24h・near-term dense 30 日・per-run cap の基数 (booking 12) は不変。multiplier のみ {3,4,5} で変化 (hard max 5)。`);
  L.push(`- 旧 planner = ${a.meta.oldSource}。新 planner = 本ブランチ。SLA 定義は両者共通 (ACTIVE: lead<=21d 24h / 22-60d 48h / >60d 72h、WARM 72h)。`);
  L.push("- near-term starved = RMS-critical Booking セル (competitor lead<=56d / own lead<=90d, 総数 1412) のうち未収集または 84h 超。base = 旧 planner @ multiplier 3 (現行本番)。");
  L.push(`- 採用基準 (自動): ACTIVE: primary SLA steady>=${ACCEPT_MIN_PCT}% かつ final-slot>=${ACCEPT_MIN_PCT}% かつ own ACTIVE>=${ACCEPT_MIN_PCT}%。WARM: primary 1.5x SLA steady>=${ACCEPT_MIN_PCT}% かつ steady 未収集 0。既存レーン: near-term starved steady 平均 <= base + 5% x 総数 (約+70)、96h 超セル数も同許容。multiplier 最小 -> share 最小を採用。`);
  L.push("- 配分は固定予約でなく緊急度順 (1.TRANSITION 2.ACTIVE 3.RMS-critical never/overdue 4.WARM 5.research)。share は冬季の上限 (ceiling)、未使用 capacity は他 lane へ返る。near-term starved が (12%+5%) x 総数 を超えると WARM と lead>60d の ACTIVE を抑制 (backpressure)。");
  L.push("");
  L.push("## 結果");
  L.push("");
  if (a.sel.selected !== null) {
    L.push(`**採用: multiplier=${a.sel.selected.multiplier}, winter max share=${a.sel.selected.share}** (全シナリオが基準を満たす最小構成)。`);
  } else {
    L.push(`**基準を満たす組合せなし (multiplier 3/4/5 x share)。最良案: multiplier=${a.sel.best?.multiplier}, share=${a.sel.best?.share}。未達: ${a.sel.failures.map((f, i) => `${CASES[i]!.key}:[${f.join(",")}]`).join(" / ")}**`);
  }
  L.push("");
  for (const c of CASES) {
    L.push(`### ${c.label} (${c.kind} 基準)`);
    L.push("");
    L.push("| mult | share | 判定 | 未達 | winter pages/day | effective winter share | total Booking/day (cap 利用) | primary SLA steady / final | primary 1.5x | own ACTIVE | 未収集 steady max | near starved steady (base) | >96h steady (base) | backpressure runs |");
    L.push("|---:|---:|:--|:--|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const m of CANDIDATE_MULTIPLIERS) {
      const o = a.old.get(key(c.key, m))!;
      L.push(`| ${m} | 旧 | - | - | ${o.booking_pages_per_day_on_winter_cells} | - | ${o.booking_pages_per_day_total} (${o.global_cap_utilisation_pct}%) | ${o.primary_cov_within_sla_steady_pct}% / ${o.primary_cov_within_sla_final_pct}% | ${o.primary_cov_within_1_5x_steady_pct}% | ${o.kiraku_own_cov_within_sla_steady_pct ?? "-"}% | ${o.never_served_steady_max} | ${o.near_term_starved_steady_avg} | ${o.near_over96_steady_avg} | - |`);
      for (const sh of CANDIDATE_SHARES) {
        const n = a.grid.get(key(c.key, m, sh))!;
        const base = a.old.get(key(c.key, 3))!;
        const chk = checkAcceptance(toAcceptance(c, n, base));
        L.push(`| ${m} | ${sh} | ${chk.pass ? "PASS" : "fail"} | ${chk.failures.join(", ") || "-"} | ${n.booking_pages_per_day_on_winter_cells} | ${n.effective_winter_share_pct}% | ${n.booking_pages_per_day_total} (${n.global_cap_utilisation_pct}%) | ${n.primary_cov_within_sla_steady_pct}% / ${n.primary_cov_within_sla_final_pct}% | ${n.primary_cov_within_1_5x_steady_pct}% | ${n.kiraku_own_cov_within_sla_steady_pct ?? "-"}% | ${n.never_served_steady_max} | ${n.near_term_starved_steady_avg} (${base.near_term_starved_steady_avg}) | ${n.near_over96_steady_avg} (${base.near_over96_steady_avg}) | ${n.backpressure_runs} |`);
      }
    }
    L.push("");
  }
  if (a.sel.selected !== null) {
    const m = a.sel.selected.multiplier; const sh = a.sel.selected.share;
    L.push(`## 採用構成の before/after (multiplier ${m}, share ${sh}; before = 現行 multiplier 3 の旧 planner)`);
    L.push("");
    L.push("| シナリオ | total Booking/day before→after | winter pages/day before→after | effective winter share | primary SLA steady (before→after) | final-slot | WARM 1.5x | own ACTIVE | near starved steady before→after | max service age h (final, 収集済み) before→after |");
    L.push("|---|---|---|---:|---|---:|---:|---:|---|---|");
    for (const c of CASES) {
      const o = a.old.get(key(c.key, 3))!; const n = a.grid.get(key(c.key, m, sh))!;
      L.push(`| ${c.label} | ${o.booking_pages_per_day_total}→${n.booking_pages_per_day_total} | ${o.booking_pages_per_day_on_winter_cells}→${n.booking_pages_per_day_on_winter_cells} | ${n.effective_winter_share_pct}% | ${o.primary_cov_within_sla_steady_pct}%→${n.primary_cov_within_sla_steady_pct}% | ${n.primary_cov_within_sla_final_pct}% | ${n.primary_cov_within_1_5x_steady_pct}% | ${n.kiraku_own_cov_within_sla_steady_pct ?? "-"}% | ${o.near_term_starved_steady_avg}→${n.near_term_starved_steady_avg} | ${o.max_service_age_hours_final ?? "-"}→${n.max_service_age_hours_final ?? "-"} |`);
    }
    L.push("");
    L.push(`- 推奨 production 値: ZMI_CRAWL_VOLUME_MULTIPLIER=${m} (launchd 側設定。コード既定は変更しない)。冬季 lane の share 上限既定は WINTER_LANE_MAX_BOOKING_SHARE=${sh}。`);
  }
  L.push("- 不変条件 (anti-block): 2h cadence (12 slots/day)、24h cooldown、sequential/jitter/backoff/captcha・block early-stop、multiplier<=5 (hard max)。");
  return L.join("\n");
}

async function main(): Promise<void> {
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
  const hist = readHistoryLastCollected();
  const old = await loadOldPlanner();
  const oldM = new Map<string, Metrics>(); const grid = new Map<string, Metrics>();
  const key = (c: string, m: number, sh?: number): string => `${c}|${m}|${sh ?? "old"}`;
  for (const c of CASES) {
    for (const m of CANDIDATE_MULTIPLIERS) {
      oldM.set(key(c.key, m), simulate({ planner: "old", plan: old.fn, scenario: c.scenario, startDate: c.start, history: hist.map, multiplier: m }));
      for (const sh of CANDIDATE_SHARES) grid.set(key(c.key, m, sh), simulate({ planner: "new", plan: newPlan, scenario: c.scenario, startDate: c.start, history: hist.map, multiplier: m, maxShare: sh }));
      console.error(`done ${c.key} m=${m}`);
    }
  }
  const configs: ConfigResult[] = [];
  for (const m of CANDIDATE_MULTIPLIERS) for (const sh of CANDIDATE_SHARES) {
    configs.push({ multiplier: m, share: sh, cases: CASES.map((c) => toAcceptance(c, grid.get(key(c.key, m, sh))!, oldM.get(key(c.key, 3))!)) });
  }
  const sel = selectMinimalConfig(configs);
  const md = render({ old: oldM, grid, configs, sel, meta: { historyRows: hist.rows, historyLatest: hist.latest, oldSource: old.source } });
  if (out !== undefined) writeFileSync(out, `${md}\n`, "utf8");
  console.log(md);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Kiraku winter sales lane (pure; no I/O, no network).
//
// 喜らく冬季販売窓 (KIRAKU_WINTER_SALES_WINDOW) の Booking 鮮度を、既存の
// グローバル上限 (booking 12/run x multiplier, 12 slots/day)・2h cadence・
// cooldown・anti-block を一切変えずに温めるレーン。
//
//  ACTIVE : Beds24 で実際に販売中 (manifest state=SELLABLE) の日。
//           対象 = 喜らく自身の公開価格 + PRIMARY_COMPARABLE (CORE_COMPETITORS)。
//           鮮度目標: lead<=21d 24h / 22-60d 48h / >60d 72h。
//  WARM   : 非販売 (NO_SELLABLE_INVENTORY / UNKNOWN / manifest 無し/stale)。
//           対象 = PRIMARY_COMPARABLE のみ。72h 以内に一巡。
//  TRANSITION : newly_sellable な日。最優先。primary comparable のみ
//           transition_detected_at 世代ごとに 1 回だけ 24h cooldown を上書き。
//
// per-property quota (MAX_TARGETS_PER_PROPERTY_PER_RUN=2 は冬季レーンでは足りない):
//   required_p  = Σ_cells 24 / target_hours(cell)            [pages/day]
//   quota_raw_p = ceil(required_p / slots_per_day)           [pages/run]
// レーン総量は booking cap の WINTER_LANE_MAX_BOOKING_SHARE 以内に按分し、
// 残りは必ず既存の near-term RMS-critical / research レーンに残す。
// 未使用の予算は既存レーンへ戻る (work-conserving)。

import { kirakuWinterSalesDates } from "./kirakuWinterSalesWindow";
import { winterLaneOf, type WinterSalesScope } from "./kirakuWinterSalesScope";

export const WINTER_ACTIVE_NEAR_LEAD_DAYS = 21;
export const WINTER_ACTIVE_MID_LEAD_DAYS = 60;
export const WINTER_ACTIVE_FRESHNESS_HOURS = { near: 24, mid: 48, far: 72 } as const;
export const WINTER_WARM_FRESHNESS_HOURS = 72;
// セルは target の 75% に達したら "due" (既存 DUE_SOON_FRACTION と同じ考え方)。
export const WINTER_DUE_FRACTION = 0.75;
// 冬季レーンが 1 run で使える booking cap の上限割合。残り (>=50%) は
// near-term RMS-critical / research レーン専用に必ず残る (starvation guard)。
export const WINTER_LANE_MAX_BOOKING_SHARE = 0.5;

export type WinterLaneClass = "TRANSITION" | "ACTIVE" | "WARM";
export type WinterPropertyKind = "own_kiraku" | "primary_comparable";

export interface WinterLaneProperty {
  slug: string;
  canonical_property_name: string;
  kind: WinterPropertyKind;
}

export interface WinterLaneCell {
  slug: string;
  canonical_property_name: string;
  kind: WinterPropertyKind;
  stay_date: string;
  offset: number;
  lane_class: WinterLaneClass;
  target_hours: number;
  age_hours: number | null;
  ratio: number; // age/target; 未収集は Infinity
  in_cooldown: boolean;
  override_cooldown: boolean;
  transition_key: string | null;
}

export function winterTargetHours(lane: "ACTIVE" | "WARM", offset: number): number {
  if (lane === "WARM") return WINTER_WARM_FRESHNESS_HOURS;
  if (offset <= WINTER_ACTIVE_NEAR_LEAD_DAYS) return WINTER_ACTIVE_FRESHNESS_HOURS.near;
  if (offset <= WINTER_ACTIVE_MID_LEAD_DAYS) return WINTER_ACTIVE_FRESHNESS_HOURS.mid;
  return WINTER_ACTIVE_FRESHNESS_HOURS.far;
}

export interface WinterLaneDiagnostics {
  manifest_status: string;
  manifest_warning: string | null;
  window_dates_remaining: number;
  active_dates: number;
  warm_dates: number;
  required_pages_per_day: number;
  required_pages_per_day_by_property: Record<string, number>;
  quota_raw_by_property: Record<string, number>;
  quota_by_property: Record<string, number>;
  slots_per_day: number;
  booking_cap_per_run: number;
  lane_budget_per_run: number;
  lane_max_share: number;
  selected_count: number;
  selected_by_class: Record<WinterLaneClass, number>;
  pending_transition_cells: number;
  transition_cooldown_overrides: string[];
  transition_keys_selected: string[];
}

export interface WinterLaneInput {
  runDateIso: string;
  nowIso: string;
  slotsPerDay: number;
  bookingCap: number;
  properties: readonly WinterLaneProperty[];
  scope: WinterSalesScope | undefined;
  lastCollectedAt: ReadonlyMap<string, string>;
  transitionAttempted: ReadonlySet<string>;
  cooldownHours: number;
  ageHours: (pastIso: string, nowIso: string) => number;
  offsetDays: (fromIso: string, toIso: string) => number;
  // 感度分析 (simulateWinterCoverage) 用。省略時は WINTER_LANE_MAX_BOOKING_SHARE。
  maxBookingShare?: number;
}

function cellOrder(a: WinterLaneCell, b: WinterLaneCell): number {
  if (a.ratio !== b.ratio) return a.ratio === Infinity ? -1 : b.ratio === Infinity ? 1 : b.ratio - a.ratio;
  return a.stay_date.localeCompare(b.stay_date);
}

// 総量 B に収まるよう quota を最大剰余法で按分 (決定的: slug 順 tiebreak)。
function scaleQuotas(raw: Record<string, number>, budget: number): Record<string, number> {
  const slugs = Object.keys(raw).sort();
  const sum = slugs.reduce((n, s) => n + raw[s]!, 0);
  if (sum <= budget) return { ...raw };
  const exact = slugs.map((s) => ({ s, x: (raw[s]! * budget) / sum }));
  const out: Record<string, number> = {};
  let used = 0;
  for (const e of exact) { out[e.s] = Math.floor(e.x); used += out[e.s]!; }
  const byRem = [...exact].sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)) || a.s.localeCompare(b.s));
  for (let i = 0; used < budget && i < byRem.length; i += 1, used += 1) out[byRem[i]!.s] = out[byRem[i]!.s]! + 1;
  return out;
}

export function planWinterLane(input: WinterLaneInput): { selected: WinterLaneCell[]; diagnostics: WinterLaneDiagnostics } {
  const dates = kirakuWinterSalesDates().filter((d) => input.offsetDays(input.runDateIso, d) >= 1);
  const slotsPerDay = Math.max(1, input.slotsPerDay);
  const maxShare = input.maxBookingShare ?? WINTER_LANE_MAX_BOOKING_SHARE;
  const budget = Math.floor(input.bookingCap * maxShare);

  const required: Record<string, number> = {};
  const requiredWarm: Record<string, number> = {};
  const cellsBySlug = new Map<string, WinterLaneCell[]>();
  let activeDates = 0;
  let warmDates = 0;
  let pendingTransitions = 0;
  for (const d of dates) { if (winterLaneOf(input.scope, d) === "ACTIVE") activeDates += 1; else warmDates += 1; }

  for (const p of input.properties) {
    required[p.slug] = 0;
    requiredWarm[p.slug] = 0;
    const cells: WinterLaneCell[] = [];
    for (const d of dates) {
      const lane = winterLaneOf(input.scope, d)!;
      if (lane === "WARM" && p.kind === "own_kiraku") continue; // 非販売日の自社価格は取らない
      const offset = input.offsetDays(input.runDateIso, d);
      const targetHours = winterTargetHours(lane, offset);
      const perDay = 24 / targetHours;
      required[p.slug] = required[p.slug]! + perDay;
      if (lane === "WARM") requiredWarm[p.slug] = requiredWarm[p.slug]! + perDay;

      const lastIso = input.lastCollectedAt.get(`booking|${p.slug}|${d}`);
      const age = lastIso === undefined || lastIso === "" ? null : input.ageHours(lastIso, input.nowIso);
      const known = age !== null && Number.isFinite(age) && age >= 0;
      const ageH = known ? age : null;
      const inCooldown = ageH !== null && ageH < input.cooldownHours;
      const ratio = ageH === null ? Infinity : ageH / targetHours;

      const meta = lane === "ACTIVE" ? input.scope?.dates.get(d) : undefined;
      const tKey = meta?.newly_sellable === true && meta.transition_detected_at !== null ? `${meta.transition_detected_at}|${p.slug}|${d}` : null;
      const servedAfterDetect = tKey !== null && lastIso !== undefined && lastIso !== "" && Date.parse(lastIso) >= Date.parse(meta!.transition_detected_at!);
      const isTransition = tKey !== null && !input.transitionAttempted.has(tKey) && !servedAfterDetect;
      if (isTransition) pendingTransitions += 1;

      const due = isTransition || (!inCooldown && ratio >= WINTER_DUE_FRACTION);
      if (!due) continue;
      cells.push({
        slug: p.slug,
        canonical_property_name: p.canonical_property_name,
        kind: p.kind,
        stay_date: d,
        offset,
        lane_class: isTransition ? "TRANSITION" : lane,
        target_hours: targetHours,
        age_hours: ageH,
        ratio,
        in_cooldown: inCooldown,
        // cooldown 上書きは primary comparable の transition のみ。
        override_cooldown: isTransition && inCooldown && p.kind === "primary_comparable",
        transition_key: isTransition ? tKey : null
      });
    }
    // 自社 (own) の transition は cooldown を上書きしない: cooldown 中なら除外。
    cellsBySlug.set(p.slug, cells.filter((c) => !(c.lane_class === "TRANSITION" && c.in_cooldown && c.kind !== "primary_comparable")));
  }

  const quotaRaw: Record<string, number> = {};
  for (const p of input.properties) quotaRaw[p.slug] = Math.ceil(required[p.slug]! / slotsPerDay - 1e-9);
  const quota = scaleQuotas(quotaRaw, budget);

  const selected: WinterLaneCell[] = [];
  const byClass: Record<WinterLaneClass, number> = { TRANSITION: 0, ACTIVE: 0, WARM: 0 };
  for (const p of [...input.properties].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const q = quota[p.slug] ?? 0;
    if (q <= 0) continue;
    const cells = cellsBySlug.get(p.slug) ?? [];
    const trans = cells.filter((c) => c.lane_class === "TRANSITION").sort((a, b) => a.stay_date.localeCompare(b.stay_date));
    const act = cells.filter((c) => c.lane_class === "ACTIVE").sort(cellOrder);
    const warm = cells.filter((c) => c.lane_class === "WARM").sort(cellOrder);
    // WARM の保護枠 (starvation guard): WARM の required を 1 run あたりに換算した数
    // (>0 なら最低 1)。ただし ACTIVE の必要枠 (ceil(required_active/slots)) は先に確保し、
    // transition/ACTIVE が quota を食い切っても WARM が 0 にならない。
    const activeNeed = Math.ceil((required[p.slug]! - requiredWarm[p.slug]!) / slotsPerDay - 1e-9);
    let warmFloor = requiredWarm[p.slug]! > 0
      ? Math.min(Math.max(1, Math.round(requiredWarm[p.slug]! / slotsPerDay)), Math.max(0, q - activeNeed))
      : 0;
    if (requiredWarm[p.slug]! > 0 && warmFloor === 0 && q >= 2) warmFloor = 1;
    const picked: WinterLaneCell[] = [];
    for (const c of [...trans, ...act]) { if (picked.length >= q - warmFloor) break; picked.push(c); }
    for (const c of warm) { if (picked.length >= q || picked.filter((x) => x.lane_class === "WARM").length >= warmFloor) break; picked.push(c); }
    // 余り枠: ACTIVE 側、次に WARM から (work-conserving)。
    for (const c of [...trans, ...act, ...warm]) { if (picked.length >= q) break; if (!picked.includes(c)) picked.push(c); }
    for (const c of picked) { selected.push(c); byClass[c.lane_class] += 1; }
  }

  const totalRequired = Object.values(required).reduce((n, x) => n + x, 0);
  return {
    selected,
    diagnostics: {
      manifest_status: input.scope?.status ?? "no_manifest",
      manifest_warning: input.scope?.warning ?? null,
      window_dates_remaining: dates.length,
      active_dates: activeDates,
      warm_dates: warmDates,
      required_pages_per_day: Math.round(totalRequired * 100) / 100,
      required_pages_per_day_by_property: Object.fromEntries(Object.entries(required).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      quota_raw_by_property: quotaRaw,
      quota_by_property: quota,
      slots_per_day: slotsPerDay,
      booking_cap_per_run: input.bookingCap,
      lane_budget_per_run: budget,
      lane_max_share: maxShare,
      selected_count: selected.length,
      selected_by_class: byClass,
      pending_transition_cells: pendingTransitions,
      transition_cooldown_overrides: selected.filter((c) => c.override_cooldown).map((c) => c.transition_key!),
      transition_keys_selected: selected.filter((c) => c.transition_key !== null).map((c) => c.transition_key!)
    }
  };
}

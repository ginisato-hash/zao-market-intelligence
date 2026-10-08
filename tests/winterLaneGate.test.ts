import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveWinterSalesLaneEnabled, resolveCrawlVolumeMultiplier, scaleCap } from "../src/services/crawlVolumeConfig";
import { parseWinterSalesScope } from "../src/services/kirakuWinterSalesScope";
import { LEGACY_SKI_SEASON_WINDOW, kirakuWinterSalesDates } from "../src/services/kirakuWinterSalesWindow";
import { liveTargets } from "../src/services/marketRefreshTargetUniverse";
import { buildRotatingPlan, scaledRotatingCaps, type RotatingDemandConfig } from "../src/services/rotatingCollectionScopePlanner";

const BASE_SHA = "1565f292";
const OLD_FILE = join("src", "services", "zzOldRotatingPlannerForGateTest.ts");
const CONFIG: RotatingDemandConfig = {
  public_holidays: { "2026-11-03": "文化の日" },
  long_weekend_dates: new Set(["2026-11-21", "2026-11-22"]),
  peak_periods: [{ code: "ski_season", from: LEGACY_SKI_SEASON_WINDOW.from, to: LEGACY_SKI_SEASON_WINDOW.to, saturday_only: true }]
};
const NOW_MS = Date.parse("2026-10-08T08:00:00+09:00");
const scope = parseWinterSalesScope({
  schema_version: "kiraku_winter_sales_scope_v1", property_id: "330695", generated_at: "2026-10-08T07:00:00+09:00",
  season: { from: "2026-12-20", to: "2027-03-31" },
  dates: kirakuWinterSalesDates().map((d) => ({ stay_date: d, state: "SELLABLE", sellable_room_count: 1, newly_sellable: true, transition_detected_at: "2026-10-08T06:00:00+09:00" }))
}, NOW_MS);

describe("winter lane feature gate (ZMI_WINTER_SALES_LANE_ENABLED && multiplier>=4)", () => {
  const env = (gate: string | undefined, mult: string | undefined) => ({ ...(gate !== undefined ? { ZMI_WINTER_SALES_LANE_ENABLED: gate } : {}), ...(mult !== undefined ? { ZMI_CRAWL_VOLUME_MULTIPLIER: mult } : {}) });
  it("truth table", () => {
    expect(resolveWinterSalesLaneEnabled(env(undefined, undefined))).toBe(false);
    expect(resolveWinterSalesLaneEnabled(env(undefined, "4"))).toBe(false); // gate 未設定
    expect(resolveWinterSalesLaneEnabled(env("0", "4"))).toBe(false);
    expect(resolveWinterSalesLaneEnabled(env("true", "4"))).toBe(false); // "1" のみ有効
    expect(resolveWinterSalesLaneEnabled(env("1", undefined))).toBe(false); // multiplier 既定 1
    expect(resolveWinterSalesLaneEnabled(env("1", "3"))).toBe(false); // multiplier 3 のまま ENABLED=1 は無効
    expect(resolveWinterSalesLaneEnabled(env("1", "3.9"))).toBe(false); // 整数化 (floor) 後 3
    expect(resolveWinterSalesLaneEnabled(env("1", "abc"))).toBe(false);
    expect(resolveWinterSalesLaneEnabled(env("1", "4"))).toBe(true);
    expect(resolveWinterSalesLaneEnabled(env("1", "5"))).toBe(true);
    expect(resolveWinterSalesLaneEnabled(env("1", "99"))).toBe(true); // hard max 5 にクランプされ有効
    expect(resolveCrawlVolumeMultiplier(env("1", "99"))).toBe(5);
  });
  it("planner default is disabled (old allocation); only winterLaneEnabled:true activates the lane", () => {
    const base = { runDateIso: "2026-10-08", nowIso: "2026-10-08T08:00:00+09:00", slotHourJst: 8, liveTargets: liveTargets(), config: CONFIG, lastCollectedAt: new Map<string, string>(), caps: scaledRotatingCaps(4), winterScope: scope, nearTermStarvedLimitFraction: 1 };
    const off = buildRotatingPlan(base);
    const on = buildRotatingPlan({ ...base, winterLaneEnabled: true });
    expect(off.selected.some((t) => t.winter_lane !== undefined)).toBe(false);
    expect(off.winter_lane.selected_count).toBe(0);
    expect(on.selected.some((t) => t.winter_lane === "TRANSITION")).toBe(true); // 有効時 TRANSITION 優先
    expect(on.selected[0]?.winter_lane).toBe("TRANSITION");
    expect(on.selected.filter((t) => t.source === "booking").length).toBeLessThanOrEqual(scaleCap(12, 4)); // global cap 超過なし
    expect(on.selected.length).toBeLessThanOrEqual(scaleCap(24, 4));
  });
  it("enabled with stale manifest => all WARM (never ACTIVE)", () => {
    const stale = parseWinterSalesScope({ ...(JSON.parse(JSON.stringify({ schema_version: "kiraku_winter_sales_scope_v1", generated_at: "2026-10-01T00:00:00+09:00", dates: [] })) as object) }, NOW_MS);
    const p = buildRotatingPlan({ runDateIso: "2026-10-08", nowIso: "2026-10-08T08:00:00+09:00", slotHourJst: 8, liveTargets: liveTargets(), config: CONFIG, lastCollectedAt: new Map(), caps: scaledRotatingCaps(4), winterScope: stale, winterLaneEnabled: true, nearTermStarvedLimitFraction: 1 });
    expect(stale.status).toBe("stale");
    expect(p.selected.filter((t) => t.winter_lane !== undefined).every((t) => t.winter_lane === "WARM")).toBe(true);
    expect(p.winter_lane.active_dates).toBe(0);
  });
  it("runner uses the gate: no manifest read / ledger write when disabled (static check)", () => {
    const src = readFileSync("src/scripts/runAutoRunnerMarketRefreshRotating.ts", "utf8");
    expect(src).toContain("resolveWinterSalesLaneEnabled(env)");
    expect(src).toContain("winterLaneEnabled ? loadWinterSalesScope(env) : undefined");
    expect(src).toContain("winterLaneEnabled ? readWinterTransitionLedger()");
    expect(src).toContain("if (winterLaneEnabled && liveMode");
  });
});

describe("gate OFF == base planner (regression vs commit 1565f292)", () => {
  let oldPlan: ((i: unknown) => Record<string, unknown>) | null = null;
  beforeAll(async () => {
    try {
      const text = execFileSync("git", ["show", `${BASE_SHA}:src/services/rotatingCollectionScopePlanner.ts`], { encoding: "utf8" });
      writeFileSync(OLD_FILE, text);
      oldPlan = ((await import(pathToFileURL(join(process.cwd(), OLD_FILE)).href)) as { buildRotatingPlan: (i: unknown) => Record<string, unknown> }).buildRotatingPlan;
    } catch { oldPlan = null; } // base commit が取得できない shallow checkout ではスキップ
  });
  afterAll(() => { if (existsSync(OLD_FILE)) rmSync(OLD_FILE); });

  it("identical output (except the additive winter_lane field) for multiplier 3 and 4 across slots/dates/histories", () => {
    if (oldPlan === null) return;
    const last = new Map<string, string>([
      ["booking|hammond-takamiya|2026-10-12", "2026-10-08T02:00:00+09:00"],
      ["booking|xi-raku|2026-10-20", "2026-10-07T20:00:00+09:00"],
      ["jalan|yad325153|2026-10-15", "2026-10-06T10:00:00+09:00"]
    ]);
    for (const mult of [3, 4]) for (const runDate of ["2026-10-08", "2026-12-10"]) for (const hour of [0, 8, 14, 22]) for (const history of [new Map<string, string>(), last]) {
      const input = { runDateIso: runDate, nowIso: `${runDate}T${String(hour).padStart(2, "0")}:00:00+09:00`, slotHourJst: hour, liveTargets: liveTargets(), config: CONFIG, lastCollectedAt: history, caps: scaledRotatingCaps(mult), nearTermDenseDays: 30, forcedDates: [] as string[] };
      const a = oldPlan(input);
      // 新 planner: gate 無効 (既定) で winter 入力が渡っても影響しない。
      const b = { ...buildRotatingPlan({ ...input, winterScope: scope }) } as Record<string, unknown>;
      delete b["winter_lane"];
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });
});

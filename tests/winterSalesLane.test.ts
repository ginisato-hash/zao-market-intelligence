import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIRAKU_WINTER_SALES_WINDOW,
  MARKET_RESEARCH_SKI_SEASON_WINDOW,
  isInKirakuWinterSalesWindow,
  kirakuWinterSalesDates
} from "../src/services/kirakuWinterSalesWindow";
import {
  loadWinterSalesScope,
  parseWinterSalesScope,
  winterLaneOf,
  type WinterSalesScope
} from "../src/services/kirakuWinterSalesScope";
import {
  ROTATING_CAPS,
  SLOT_HOURS,
  buildRotatingPlan,
  scaledRotatingCaps,
  type RotatingDemandConfig,
  type RotatingPlan
} from "../src/services/rotatingCollectionScopePlanner";
import {
  WINTER_LANE_MAX_BOOKING_SHARE,
  winterTargetHours
} from "../src/services/winterSalesLanePlanner";
import { liveTargets } from "../src/services/marketRefreshTargetUniverse";
import { applyPeriodRetention, periodKey, type UnifiedRow } from "../src/services/biWebDataExport";

const CONFIG: RotatingDemandConfig = {
  public_holidays: {},
  long_weekend_dates: new Set(),
  peak_periods: [
    { code: "ski_season", from: MARKET_RESEARCH_SKI_SEASON_WINDOW.from, to: MARKET_RESEARCH_SKI_SEASON_WINDOW.to, saturday_only: true }
  ]
};
const RUN_DATE = "2026-10-07";
const NOW_MS = Date.parse("2026-10-07T08:00:00+09:00");
const CAPS3 = scaledRotatingCaps(3);
const HAMMOND = "hammond-takamiya";
const KIRAKU = "xi-raku";

function manifest(dates: { d: string; state?: string; newly?: boolean; at?: string | null }[], generatedAt = "2026-10-07T07:00:00+09:00"): unknown {
  return {
    schema_version: "kiraku_winter_sales_scope_v1",
    property_id: "330695",
    generated_at: generatedAt,
    season: { from: "2026-12-20", to: "2027-03-31" },
    dates: dates.map((x) => ({
      stay_date: x.d,
      state: x.state ?? "SELLABLE",
      sellable_room_count: 1,
      newly_sellable: x.newly ?? false,
      transition_detected_at: x.at ?? null
    }))
  };
}
function scopeOf(dates: Parameters<typeof manifest>[0]): WinterSalesScope {
  return parseWinterSalesScope(manifest(dates), NOW_MS);
}
function allDates(from: string, to: string): string[] {
  return kirakuWinterSalesDates().filter((d) => d >= from && d <= to);
}

function plan(opts: { hour?: number; scope?: WinterSalesScope; last?: Map<string, string>; attempted?: Set<string>; caps?: typeof CAPS3; runDate?: string } = {}): RotatingPlan {
  const hour = opts.hour ?? 8;
  const runDate = opts.runDate ?? RUN_DATE;
  return buildRotatingPlan({
    runDateIso: runDate,
    nowIso: `${runDate}T${String(hour).padStart(2, "0")}:00:00+09:00`,
    slotHourJst: hour,
    liveTargets: liveTargets(),
    config: CONFIG,
    lastCollectedAt: opts.last ?? new Map(),
    caps: opts.caps ?? CAPS3,
    ...(opts.scope !== undefined ? { winterScope: opts.scope } : {}),
    ...(opts.attempted !== undefined ? { winterTransitionAttempted: opts.attempted } : {})
  });
}
const winterOf = (p: RotatingPlan) => p.selected.filter((t) => t.winter_lane !== undefined);

describe("canonical Kiraku winter sales window", () => {
  it("is 2026-12-20..2027-03-31 inclusive (102 nights)", () => {
    expect(KIRAKU_WINTER_SALES_WINDOW).toEqual({ from: "2026-12-20", to: "2027-03-31" });
    const dates = kirakuWinterSalesDates();
    expect(dates).toHaveLength(102);
    expect(dates[0]).toBe("2026-12-20");
    expect(dates.at(-1)).toBe("2027-03-31");
    for (const d of allDates("2027-03-16", "2027-03-31")) expect(dates).toContain(d);
  });
  it("12/19 and 4/1 are outside the winter sales lane window", () => {
    expect(isInKirakuWinterSalesWindow("2026-12-19")).toBe(false);
    expect(isInKirakuWinterSalesWindow("2027-04-01")).toBe(false);
    expect(isInKirakuWinterSalesWindow("2027-03-31")).toBe(true);
  });
  it("general market research may still include 12/19 (derived, not a literal)", () => {
    expect(MARKET_RESEARCH_SKI_SEASON_WINDOW).toEqual({ from: "2026-12-19", to: "2027-03-31" });
  });
  it("production code no longer hardcodes the old winter literals", () => {
    const files = [
      "src/services/rotatingCollectionScopePlanner.ts",
      "src/scripts/runCollectionScopePlanner.ts",
      "src/scripts/runPlannedMarketRefreshDryRun.ts",
      "src/scripts/runAutoRunnerMarketRefresh.ts",
      "src/scripts/runAutoRunner16xBManualLivePilot.ts",
      "src/scripts/runAutoRunnerMarketRefreshRotating.ts"
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain("2027-03-15");
      expect(text, f).not.toMatch(/from: "2026-12-19"/u);
    }
  });
});

describe("sales-scope manifest reader", () => {
  it("only SELLABLE is ACTIVE; NO_SELLABLE_INVENTORY / UNKNOWN / unlisted are WARM; outside window is null", () => {
    const s = scopeOf([{ d: "2027-01-10" }, { d: "2027-01-11", state: "NO_SELLABLE_INVENTORY" }, { d: "2027-01-12", state: "UNKNOWN" }, { d: "2026-12-19" }, { d: "2027-04-01" }]);
    expect(s.status).toBe("ok");
    expect(winterLaneOf(s, "2027-01-10")).toBe("ACTIVE");
    expect(winterLaneOf(s, "2027-01-11")).toBe("WARM");
    expect(winterLaneOf(s, "2027-01-12")).toBe("WARM");
    expect(winterLaneOf(s, "2027-01-13")).toBe("WARM");
    expect(winterLaneOf(s, "2026-12-19")).toBeNull();
    expect(winterLaneOf(s, "2027-04-01")).toBeNull();
  });
  it("unknown state strings are never selling", () => {
    const s = scopeOf([{ d: "2027-01-10", state: "sellable" }, { d: "2027-01-11", state: "WHATEVER" }]);
    expect(winterLaneOf(s, "2027-01-10")).toBe("WARM");
    expect(winterLaneOf(s, "2027-01-11")).toBe("WARM");
  });
  it("missing env / missing file / unparseable / bad schema / stale / bad generated_at => no manifest, all WARM", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-scope-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    const stale = join(dir, "stale.json");
    writeFileSync(stale, JSON.stringify(manifest([{ d: "2027-01-10" }], "2026-10-06T20:00:00+09:00"))); // 12h old
    const fresh = join(dir, "fresh.json");
    writeFileSync(fresh, JSON.stringify(manifest([{ d: "2027-01-10" }])));
    const cases: [string, WinterSalesScope][] = [
      ["no_env", loadWinterSalesScope({}, NOW_MS)],
      ["missing_file", loadWinterSalesScope({ KIRAKU_WINTER_SALES_SCOPE_PATH: join(dir, "nope.json") }, NOW_MS)],
      ["unparseable", loadWinterSalesScope({ KIRAKU_WINTER_SALES_SCOPE_PATH: bad }, NOW_MS)],
      ["stale", loadWinterSalesScope({ KIRAKU_WINTER_SALES_SCOPE_PATH: stale }, NOW_MS)],
      ["invalid_schema", parseWinterSalesScope({ schema_version: "v0", dates: [] }, NOW_MS)],
      ["invalid_generated_at", parseWinterSalesScope({ ...(manifest([{ d: "2027-01-10" }]) as object), generated_at: "nonsense" }, NOW_MS)]
    ];
    for (const [status, s] of cases) {
      expect(s.status).toBe(status);
      expect(s.warning).toContain("treated as WARM");
      expect(winterLaneOf(s, "2027-01-10")).toBe("WARM");
    }
    const ok = loadWinterSalesScope({ KIRAKU_WINTER_SALES_SCOPE_PATH: fresh }, NOW_MS);
    expect(ok.status).toBe("ok");
    expect(winterLaneOf(ok, "2027-01-10")).toBe("ACTIVE");
  });
  it("newly_sellable without transition_detected_at is not a bounded transition", () => {
    const s = scopeOf([{ d: "2027-01-10", newly: true, at: null }]);
    expect(s.dates.get("2027-01-10")?.newly_sellable).toBe(false);
  });
});

describe("winter lane freshness policy", () => {
  it("ACTIVE targets: lead<=21d 24h, 22-60d 48h, >60d 72h; WARM 72h", () => {
    expect(winterTargetHours("ACTIVE", 1)).toBe(24);
    expect(winterTargetHours("ACTIVE", 21)).toBe(24);
    expect(winterTargetHours("ACTIVE", 22)).toBe(48);
    expect(winterTargetHours("ACTIVE", 60)).toBe(48);
    expect(winterTargetHours("ACTIVE", 61)).toBe(72);
    expect(winterTargetHours("WARM", 5)).toBe(72);
  });
});

describe("winter lane planning", () => {
  it("no manifest: everything is WARM, only PRIMARY comparables, never own Kiraku, only inside 12/20..3/31", () => {
    const p = plan();
    const w = winterOf(p);
    expect(w.length).toBeGreaterThan(0);
    expect(w.every((t) => t.winter_lane === "WARM" && t.source === "booking")).toBe(true);
    expect(w.some((t) => t.property_slug === KIRAKU)).toBe(false);
    expect(w.every((t) => isInKirakuWinterSalesWindow(t.stay_date))).toBe(true);
    expect(p.winter_lane.active_dates).toBe(0);
    expect(p.winter_lane.warm_dates).toBe(102);
    expect(p.winter_lane.manifest_status).toBe("no_manifest");
  });
  it("UNKNOWN / stale manifests never produce ACTIVE selections", () => {
    const unknown = parseWinterSalesScope(manifest(allDates("2026-12-20", "2027-03-31").map((d) => ({ d, state: "UNKNOWN" }))), NOW_MS);
    const stale = parseWinterSalesScope(manifest(allDates("2026-12-20", "2027-03-31").map((d) => ({ d })), "2026-10-01T00:00:00+09:00"), NOW_MS);
    for (const s of [unknown, stale]) {
      const p = plan({ scope: s });
      expect(winterOf(p).some((t) => t.winter_lane !== "WARM")).toBe(false);
      expect(p.winter_lane.active_dates).toBe(0);
    }
  });
  it("3/16..3/31 become winter lane candidates once due; 12/19 and 4/1 never are", () => {
    // 3/16 以降だけ未収集、それ以前は新鮮 => 3/16..3/31 が選ばれる。
    const last = new Map<string, string>();
    for (const slug of [HAMMOND, "ji-tian-wu-shan-xing-shi", "onsen-amp-stay-oakhill"]) {
      for (const d of kirakuWinterSalesDates()) if (d < "2027-03-16") last.set(`booking|${slug}|${d}`, "2026-10-07T07:00:00+09:00");
    }
    const p = plan({ last, runDate: "2026-10-07", hour: 8 });
    const w = winterOf(p);
    expect(w.length).toBeGreaterThan(0);
    expect(w.every((t) => t.stay_date >= "2027-03-16" && t.stay_date <= "2027-03-31")).toBe(true);
    const all = plan();
    expect(winterOf(all).some((t) => t.stay_date === "2026-12-19" || t.stay_date > "2027-03-31")).toBe(false);
  });
  it("ACTIVE vs WARM separation: SELLABLE 1/1..3/31 => Kiraku own + comparables ACTIVE there; WARM only comparables in 12/20..12/31", () => {
    const sell = allDates("2027-01-01", "2027-03-31").map((d) => ({ d }));
    const scope = scopeOf(sell);
    expect(scope.dates.size).toBe(sell.length);
    // 全セル未収集で複数 slot を回して選択を集める。
    const seen = new Map<string, Set<string>>();
    const last = new Map<string, string>();
    for (let day = 0; day < 6; day += 1) {
      for (const h of SLOT_HOURS) {
        const p = plan({ scope, last, hour: h });
        for (const t of winterOf(p)) {
          const k = `${t.winter_lane}`;
          (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(`${t.property_slug}|${t.stay_date}`);
          last.set(`booking|${t.property_slug}|${t.stay_date}`, "2026-10-07T08:00:00+09:00");
        }
      }
    }
    const active = [...(seen.get("ACTIVE") ?? [])];
    const warm = [...(seen.get("WARM") ?? [])];
    expect(active.length).toBeGreaterThan(0);
    expect(warm.length).toBeGreaterThan(0);
    expect(active.every((k) => k.split("|")[1]! >= "2027-01-01")).toBe(true);
    expect(warm.every((k) => k.split("|")[1]! <= "2026-12-31")).toBe(true);
    expect(active.some((k) => k.startsWith(`${KIRAKU}|`))).toBe(true);
    expect(warm.some((k) => k.startsWith(`${KIRAKU}|`))).toBe(false);
  });
});

describe("winter lane quota and global caps", () => {
  it("quota = ceil(required_pages_per_day / slots_per_day) per property, lane budget <= floor(cap x share)", () => {
    const p = plan();
    const w = p.winter_lane;
    expect(w.slots_per_day).toBe(12);
    expect(w.booking_cap_per_run).toBe(36);
    expect(w.lane_budget_per_run).toBe(Math.floor(36 * WINTER_LANE_MAX_BOOKING_SHARE));
    // all WARM: 102 dates x 24/72 = 34 pages/day per comparable => ceil(34/12) = 3
    expect(w.required_pages_per_day_by_property[HAMMOND]).toBe(34);
    expect(w.quota_raw_by_property[HAMMOND]).toBe(3);
    expect(w.quota_by_property[HAMMOND]).toBe(3);
    expect(w.required_pages_per_day).toBe(102);
    expect(Object.values(w.quota_by_property).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(w.lane_budget_per_run);
    // 旧 MAX_TARGETS_PER_PROPERTY_PER_RUN=2 を超える専用 quota
    expect(winterOf(p).filter((t) => t.property_slug === HAMMOND)).toHaveLength(3);
  });
  it("when fully selling the quota grows but stays inside the lane budget and global booking cap", () => {
    const scope = scopeOf(kirakuWinterSalesDates().map((d) => ({ d })));
    const p = plan({ scope });
    expect(p.winter_lane.required_pages_per_day).toBeGreaterThan(102);
    expect(Object.values(p.winter_lane.quota_by_property).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(18);
    expect(p.selected.filter((t) => t.source === "booking").length).toBeLessThanOrEqual(CAPS3.booking_pages_per_run);
    expect(p.selected.length).toBeLessThanOrEqual(CAPS3.total_pages_per_run);
  });
  it("global caps and 2h cadence are unchanged", () => {
    expect(ROTATING_CAPS).toEqual({ total_pages_per_run: 24, booking_pages_per_run: 12, jalan_pages_per_run: 12, rakuten_pages_per_run: 0, google_hotels_pages_per_run: 0 });
    expect(CAPS3.booking_pages_per_run).toBe(36);
    expect([...SLOT_HOURS]).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    for (const h of SLOT_HOURS) {
      const p = plan({ hour: h, scope: scopeOf(kirakuWinterSalesDates().map((d) => ({ d }))) });
      expect(p.selected.filter((t) => t.source === "booking").length).toBeLessThanOrEqual(36);
      expect(p.selected.filter((t) => t.source === "jalan").length).toBeLessThanOrEqual(36);
      expect(p.selected.filter((t) => t.source !== "booking" && t.source !== "jalan")).toHaveLength(0);
    }
  });
  it("anti-starvation: regular (near-term RMS-critical / research) lanes keep >= half of the booking cap", () => {
    const scope = scopeOf(kirakuWinterSalesDates().map((d) => ({ d })));
    const p = plan({ scope });
    const regularBooking = p.selected.filter((t) => t.source === "booking" && t.winter_lane === undefined);
    expect(regularBooking.length).toBeGreaterThanOrEqual(CAPS3.booking_pages_per_run - p.winter_lane.lane_budget_per_run);
    expect(regularBooking.some((t) => t.rms_critical)).toBe(true);
    expect(regularBooking.every((t) => !t.reason_codes.includes("winter_sales_lane"))).toBe(true);
  });
  it("anti-starvation: WARM keeps a protected floor even when ACTIVE demand saturates the quota", () => {
    // ほぼ全日 SELLABLE (12/20 だけ WARM) + 小さい cap (multiplier 1 => lane budget 6)。
    const scope = scopeOf(kirakuWinterSalesDates().filter((d) => d > "2026-12-20").map((d) => ({ d })));
    const p = plan({ scope, caps: scaledRotatingCaps(1) });
    expect(winterOf(p).some((t) => t.winter_lane === "WARM")).toBe(true);
    expect(winterOf(p).some((t) => t.winter_lane === "ACTIVE")).toBe(true);
    expect(winterOf(p).length).toBeLessThanOrEqual(6);
  });
  it("is deterministic", () => {
    const scope = scopeOf(allDates("2027-01-01", "2027-03-31").map((d) => ({ d })));
    const a = plan({ scope, hour: 14 });
    const b = plan({ scope, hour: 14 });
    expect(JSON.stringify(a.selected)).toBe(JSON.stringify(b.selected));
    expect(JSON.stringify(a.winter_lane)).toBe(JSON.stringify(b.winter_lane));
  });
  it("cooldown applies to ordinary winter cells (collected <24h ago never re-selected)", () => {
    const last = new Map<string, string>();
    for (const d of kirakuWinterSalesDates()) last.set(`booking|${HAMMOND}|${d}`, "2026-10-07T02:00:00+09:00");
    const p = plan({ last });
    expect(winterOf(p).some((t) => t.property_slug === HAMMOND)).toBe(false);
  });
});

describe("transition (newly_sellable) priority and bounded cooldown override", () => {
  const AT = "2026-10-07T06:00:00+09:00";
  const scope = scopeOf([{ d: "2027-01-15", newly: true, at: AT }, { d: "2027-01-16" }]);
  const recent = (slug: string) => new Map([[`booking|${slug}|2027-01-15`, "2026-10-07T04:00:00+09:00"]]); // 4h前 (cooldown中, detection より前)

  it("transition dates rank first and override cooldown once for a primary comparable", () => {
    const p = plan({ scope, last: recent(HAMMOND) });
    const t = p.selected.find((x) => x.property_slug === HAMMOND && x.stay_date === "2027-01-15");
    expect(t?.winter_lane).toBe("TRANSITION");
    expect(t?.winter_cooldown_override).toBe(true);
    expect(t?.reason_codes).toContain("forced_checkin_date");
    expect(p.winter_lane.transition_cooldown_overrides).toContain(`${AT}|${HAMMOND}|2027-01-15`);
    expect(p.winter_lane.transition_keys_selected).toContain(`${AT}|${HAMMOND}|2027-01-15`);
    // transition は ACTIVE/WARM より先頭。
    const firstWinterIdx = p.selected.findIndex((x) => x.winter_lane !== undefined);
    expect(p.selected[firstWinterIdx]?.winter_lane).toBe("TRANSITION");
  });
  it("is not repeated once recorded in the ledger (same generation)", () => {
    const p = plan({ scope, last: recent(HAMMOND), attempted: new Set([`${AT}|${HAMMOND}|2027-01-15`]) });
    expect(p.selected.some((x) => x.winter_lane === "TRANSITION" && x.property_slug === HAMMOND)).toBe(false);
    expect(p.winter_lane.transition_cooldown_overrides).toHaveLength(0);
  });
  it("is not repeated once the cell was served after detection", () => {
    const last = new Map([[`booking|${HAMMOND}|2027-01-15`, "2026-10-07T07:00:00+09:00"]]);
    const p = plan({ scope, last });
    expect(p.selected.some((x) => x.winter_lane === "TRANSITION" && x.property_slug === HAMMOND)).toBe(false);
  });
  it("a new transition_detected_at generation re-arms exactly one more override", () => {
    const scope2 = scopeOf([{ d: "2027-01-15", newly: true, at: "2026-10-07T07:30:00+09:00" }]);
    const p = plan({ scope: scope2, last: recent(HAMMOND), attempted: new Set([`${AT}|${HAMMOND}|2027-01-15`]) });
    expect(p.winter_lane.transition_cooldown_overrides).toContain(`2026-10-07T07:30:00+09:00|${HAMMOND}|2027-01-15`);
  });
  it("own Kiraku never gets a cooldown override (primary comparables only)", () => {
    const p = plan({ scope, last: recent(KIRAKU) });
    expect(p.selected.some((x) => x.property_slug === KIRAKU && x.stay_date === "2027-01-15" && x.winter_lane === "TRANSITION")).toBe(false);
    expect(p.winter_lane.transition_cooldown_overrides.some((k) => k.includes(`|${KIRAKU}|`))).toBe(false);
  });
  it("bulk-open transition drains inside the lane budget and global cap", () => {
    const bulk = scopeOf(kirakuWinterSalesDates().map((d) => ({ d, newly: true, at: AT })));
    const p = plan({ scope: bulk });
    expect(winterOf(p).every((t) => t.winter_lane === "TRANSITION")).toBe(true);
    expect(winterOf(p).length).toBeLessThanOrEqual(p.winter_lane.lane_budget_per_run);
    expect(p.selected.filter((t) => t.source === "booking").length).toBeLessThanOrEqual(36);
    // 近い日から決定的に。
    const dates = winterOf(p).filter((t) => t.property_slug === HAMMOND).map((t) => t.stay_date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("BI retention keeps the full winter sales window (audit)", () => {
  it("2027-03_late (3/16-3/31) and 03-31 are retained, never cut at 2027-03_early", () => {
    expect(periodKey("2027-03-31")).toBe("2027-03_late");
    const rows = ["2026-10-10", "2026-12-20", "2027-02-20", "2027-03-15", "2027-03-16", "2027-03-31"].map((d) => ({ period_key: periodKey(d) }) as unknown as UnifiedRow);
    const r = applyPeriodRetention(rows, new Date("2026-10-07T12:00:00+09:00"));
    expect(r.retained_period_keys).toContain("2027-03_late");
    expect(r.retainedRows).toHaveLength(rows.length);
  });
});

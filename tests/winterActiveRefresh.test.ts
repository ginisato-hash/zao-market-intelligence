// Winter far-lead ACTIVE refresh + own reserve + versioned comparable set: default OFF.
import { describe, expect, it } from "vitest";
import { MARKET_RESEARCH_SKI_SEASON_WINDOW, kirakuWinterSalesDates } from "../src/services/kirakuWinterSalesWindow";
import { parseWinterSalesScope, type WinterSalesScope } from "../src/services/kirakuWinterSalesScope";
import {
  PRIMARY_COMPARABLE_BOOKING_SLUGS, WINTER_COMPARABLE_SETS,
  buildRotatingPlan, scaledRotatingCaps, type RotatingDemandConfig, type RotatingPlan
} from "../src/services/rotatingCollectionScopePlanner";
import { WINTER_ACTIVE_MID_LEAD_DAYS, WINTER_LANE_MAX_BOOKING_SHARE } from "../src/services/winterSalesLanePlanner";
import { resolveWinterActiveRefreshEnabled, resolveWinterComparableSet } from "../src/services/crawlVolumeConfig";
import { liveTargets } from "../src/services/marketRefreshTargetUniverse";
import {
  addDaysYmd, evaluateNight, freshnessSloHours, ingestCutoffMs, isFreshAt, jstIso, jstSlotMs, jstYmd, lastCollectedFromCsv, parseModel, posterior, SYNTHETIC_MODEL, V1_PRIMARY_NAMES as SIM_V1_NAMES
} from "../src/scripts/simulateWinterActiveRefresh";

const CONFIG: RotatingDemandConfig = {
  public_holidays: {}, long_weekend_dates: new Set(),
  peak_periods: [{ code: "ski_season", from: MARKET_RESEARCH_SKI_SEASON_WINDOW.from, to: MARKET_RESEARCH_SKI_SEASON_WINDOW.to, saturday_only: true }]
};
const RUN_DATE = "2026-10-15";
const NOW_MS = Date.parse("2026-10-15T08:00:00+09:00");
const KIRAKU = "xi-raku";
// Property names RMS classified PRIMARY_COMPARABLE in rms_v4_peer_membership (peer_membership_v1_2026-09-02), read 2026-10-15.
const V1_PRIMARY_NAMES = new Set(["ル・ベール蔵王", "名湯舎 創", "ONSEN & STAY OAKHILL", "HAMMOND", "ペンション木いちご", "松尾ハウス",
  "蔵王温泉 高砂屋旅館", "ロッジスガノ", "ペンションぷうたろう", "吉田屋"]);

/** Q1 on sale (ACTIVE, not newly), 12/20-12/31 not on sale (WARM). */
function q1Scope(): WinterSalesScope {
  return parseWinterSalesScope({
    schema_version: "kiraku_winter_sales_scope_v1", property_id: "330695", generated_at: "2026-10-15T07:45:00+09:00",
    season: { from: "2026-12-20", to: "2027-03-31" },
    dates: kirakuWinterSalesDates().map((d) => ({ stay_date: d, state: d >= "2027-01-01" ? "SELLABLE" : "NO_SELLABLE_INVENTORY",
      sellable_room_count: d >= "2027-01-01" ? 1 : 0, newly_sellable: false, transition_detected_at: null }))
  }, NOW_MS);
}
function plan(opts: { multiplier?: number; backpressure?: boolean; activeRefresh?: boolean; set?: "registry_v0" | "primary_v1_best5"; explicitOff?: boolean } = {}): RotatingPlan {
  return buildRotatingPlan({
    runDateIso: RUN_DATE, nowIso: `${RUN_DATE}T08:00:00+09:00`, slotHourJst: 8, liveTargets: liveTargets(), config: CONFIG,
    lastCollectedAt: new Map(), caps: scaledRotatingCaps(opts.multiplier ?? 4), winterLaneEnabled: true, winterScope: q1Scope(),
    nearTermStarvedLimitFraction: opts.backpressure === true ? 0 : 1,
    ...(opts.activeRefresh !== undefined ? { winterActiveRefresh: opts.activeRefresh } : opts.explicitOff ? { winterActiveRefresh: false } : {}),
    ...(opts.set !== undefined ? { winterComparableSet: opts.set } : {})
  });
}
const winterSel = (p: RotatingPlan) => p.selected.filter((t) => t.winter_lane !== undefined);
const lead = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${RUN_DATE}T00:00:00Z`)) / 86_400_000);

describe("flag OFF is the current planner", () => {
  it("default inputs and explicit OFF/registry produce identical plans, with or without backpressure", () => {
    for (const backpressure of [false, true]) for (const multiplier of [4, 5]) {
      const base = JSON.stringify(plan({ backpressure, multiplier }));
      expect(JSON.stringify(plan({ backpressure, multiplier, explicitOff: true }))).toBe(base);
      expect(JSON.stringify(plan({ backpressure, multiplier, set: "registry_v0", explicitOff: true }))).toBe(base);
    }
  });
  it("adds no diagnostics fields when OFF", () => {
    const wl = plan({ backpressure: true }).winter_lane;
    expect("active_refresh_enabled" in wl).toBe(false);
    expect("comparable_set" in wl).toBe(false);
  });
  it("under backpressure, OFF still drops far-lead (>60d) ACTIVE cells", () => {
    const p = plan({ backpressure: true });
    expect(p.winter_lane.backpressure_active).toBe(true);
    expect(winterSel(p).filter((t) => t.winter_lane === "ACTIVE" && lead(t.stay_date) > WINTER_ACTIVE_MID_LEAD_DAYS)).toHaveLength(0);
  });
});

describe("flag ON", () => {
  it("keeps far-lead ACTIVE cells under backpressure, within the existing 0.40 lane budget and booking cap", () => {
    for (const multiplier of [4, 5]) {
      const caps = scaledRotatingCaps(multiplier);
      const p = plan({ backpressure: true, activeRefresh: true, multiplier });
      const ws = winterSel(p);
      const far = ws.filter((t) => t.winter_lane === "ACTIVE" && lead(t.stay_date) > WINTER_ACTIVE_MID_LEAD_DAYS);
      expect(far.length).toBeGreaterThan(0);
      expect(ws.length).toBeLessThanOrEqual(Math.floor(caps.booking_pages_per_run * WINTER_LANE_MAX_BOOKING_SHARE));
      expect(p.selected.filter((t) => t.source === "booking").length).toBeLessThanOrEqual(caps.booking_pages_per_run);
      expect(p.selected.length).toBeLessThanOrEqual(caps.total_pages_per_run);
      expect(p.winter_lane.far_active_kept_under_backpressure).toBe(far.length);
      // backpressure still suppresses WARM
      expect(ws.filter((t) => t.winter_lane === "WARM")).toHaveLength(0);
    }
  });

  it("own Kiraku quota is SLA-derived (not a fixed 1), reserved first, separate from comparables; own+comps within the lane budget", () => {
    for (const multiplier of [4, 5]) for (const set of ["registry_v0", "primary_v1_best5"] as const) {
      const p = plan({ backpressure: true, activeRefresh: true, multiplier, set });
      const wl = p.winter_lane; const q = wl.quota_by_property; const raw = wl.quota_raw_by_property;
      // 82 future Q1 ACTIVE nights at the far-lead 72h SLA over 12 slots/day -> ceil(82/3/12) = 3 own pages/run.
      const activeNights = kirakuWinterSalesDates().filter((d) => d >= "2027-01-01" && lead(d) >= 1).length;
      expect(raw[KIRAKU]).toBe(Math.ceil(activeNights / 3 / 12 - 1e-9));
      expect(q[KIRAKU]).toBe(Math.min(raw[KIRAKU]!, wl.lane_budget_per_run));
      expect(wl.own_quota_per_run).toBe(q[KIRAKU]);
      expect(wl.own_quota_raw_per_run).toBe(raw[KIRAKU]);
      const compRaw = Object.entries(raw).filter(([s]) => s !== KIRAKU).reduce((n, [, x]) => n + x, 0);
      const comps = Object.entries(q).filter(([s]) => s !== KIRAKU).reduce((n, [, x]) => n + x, 0);
      expect(comps).toBe(Math.min(compRaw, wl.lane_budget_per_run - q[KIRAKU]!));
      expect(q[KIRAKU]! + comps).toBeLessThanOrEqual(wl.lane_budget_per_run);
      expect(winterSel(p).filter((t) => t.property_slug === KIRAKU)).toHaveLength(q[KIRAKU]!);
      // the >=3 independent-peer quota never counts Kiraku
      expect(winterSel(p).filter((t) => t.property_slug !== KIRAKU).length).toBeLessThanOrEqual(comps);
    }
  });

  it("own quota covers the 72h own SLA in page terms: own pages/day x 3 days >= future Q1 ACTIVE nights", () => {
    const p = plan({ backpressure: true, activeRefresh: true, set: "primary_v1_best5" });
    const activeNights = kirakuWinterSalesDates().filter((d) => d >= "2027-01-01" && lead(d) >= 1).length;
    expect(p.winter_lane.own_quota_per_run! * 12 * 3).toBeGreaterThanOrEqual(activeNights);
  });

  it("does not change the Jalan page count or cap (composition can shift via the shared per-date cap; quantified in the simulator)", () => {
    const jalanN = (p: RotatingPlan) => p.selected.filter((t) => t.source === "jalan").length;
    for (const multiplier of [4, 5]) {
      const on = plan({ backpressure: true, activeRefresh: true, multiplier });
      expect(jalanN(on)).toBe(jalanN(plan({ backpressure: true, multiplier })));
      expect(jalanN(on)).toBeLessThanOrEqual(scaledRotatingCaps(multiplier).jalan_pages_per_run);
    }
  });
});

describe("versioned comparable sets", () => {
  it("registry_v0 is exactly the current registry; primary_v1_best5 uses only v1 PRIMARY slugs", () => {
    expect([...WINTER_COMPARABLE_SETS.registry_v0.slugs].sort()).toEqual([...PRIMARY_COMPARABLE_BOOKING_SLUGS].sort());
    const best5 = WINTER_COMPARABLE_SETS.primary_v1_best5;
    expect(best5.version).toBe("peer_membership_v1_2026-09-02");
    expect(best5.slugs.size).toBe(5);
    for (const s of best5.slugs) {
      const t = liveTargets().find((x) => x.source === "booking" && x.property_slug === s);
      expect(t !== undefined && t.enabled_for_live && t.verified_mapping).toBe(true);
      expect(V1_PRIMARY_NAMES.has(t!.canonical_property_name)).toBe(true);
    }
  });
  it("best5 lane covers the 5 peers plus Kiraku, and records its version", () => {
    const p = plan({ backpressure: true, activeRefresh: true, set: "primary_v1_best5" });
    const slugs = new Set(winterSel(p).map((t) => t.property_slug));
    for (const s of WINTER_COMPARABLE_SETS.primary_v1_best5.slugs) expect(slugs.has(s)).toBe(true);
    expect(slugs.has(KIRAKU)).toBe(true);
    expect([...slugs].every((s) => s === KIRAKU || WINTER_COMPARABLE_SETS.primary_v1_best5.slugs.has(s))).toBe(true);
    expect(p.winter_lane.comparable_set_version).toBe("peer_membership_v1_2026-09-02");
  });
});

describe("env gates", () => {
  it("active refresh needs the winter lane (flag + multiplier>=4) and its own flag; unknown set falls back to registry", () => {
    expect(resolveWinterActiveRefreshEnabled({ ZMI_WINTER_SALES_LANE_ENABLED: "1", ZMI_CRAWL_VOLUME_MULTIPLIER: "4", ZMI_WINTER_ACTIVE_REFRESH_ENABLED: "1" })).toBe(true);
    expect(resolveWinterActiveRefreshEnabled({ ZMI_WINTER_SALES_LANE_ENABLED: "1", ZMI_CRAWL_VOLUME_MULTIPLIER: "4" })).toBe(false);
    expect(resolveWinterActiveRefreshEnabled({ ZMI_WINTER_SALES_LANE_ENABLED: "1", ZMI_CRAWL_VOLUME_MULTIPLIER: "3", ZMI_WINTER_ACTIVE_REFRESH_ENABLED: "1" })).toBe(false);
    expect(resolveWinterActiveRefreshEnabled({ ZMI_CRAWL_VOLUME_MULTIPLIER: "4", ZMI_WINTER_ACTIVE_REFRESH_ENABLED: "1" })).toBe(false);
    expect(resolveWinterComparableSet({})).toBe("registry_v0");
    expect(resolveWinterComparableSet({ ZMI_WINTER_COMPARABLE_SET: "primary_v1_best5" })).toBe("primary_v1_best5");
    expect(resolveWinterComparableSet({ ZMI_WINTER_COMPARABLE_SET: "everyone" })).toBe("registry_v0");
  });
});

describe("simulator clock: JST/UTC, 04:00 collect -> 05:30 ingest -> 06:00 decide", () => {
  it("JST helpers are true instants", () => {
    const ms = jstSlotMs("2026-10-16", 6);
    expect(new Date(ms).toISOString()).toBe("2026-10-15T21:00:00.000Z");
    expect(jstIso(ms)).toBe("2026-10-16T06:00:00+09:00");
    expect(jstYmd(jstSlotMs("2026-10-16", 0))).toBe("2026-10-16");
    expect(jstYmd(jstSlotMs("2026-10-15", 23, 59))).toBe("2026-10-15");
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("the 06:00 decision sees the 04:00 fetch, not the 06:00 one, and the 72h window crosses JST midnight", () => {
    const decision = jstSlotMs("2026-10-16", 6);
    expect(new Date(ingestCutoffMs(decision)).toISOString()).toBe("2026-10-15T20:30:00.000Z");
    expect(isFreshAt(jstSlotMs("2026-10-16", 4), decision, 90)).toBe(true);
    expect(isFreshAt(jstSlotMs("2026-10-16", 6), decision, 90)).toBe(false);          // after ingest
    expect(isFreshAt(jstSlotMs("2026-10-13", 6), decision, 90)).toBe(true);           // exactly 72h, prior JST days
    expect(isFreshAt(jstSlotMs("2026-10-13", 4), decision, 90)).toBe(false);          // 74h
    expect(isFreshAt(jstSlotMs("2026-10-14", 6), decision, 30)).toBe(true);           // 48h band
    expect(isFreshAt(jstSlotMs("2026-10-14", 4), decision, 30)).toBe(false);
    expect([freshnessSloHours(21), freshnessSloHours(22), freshnessSloHours(60), freshnessSloHours(61)]).toEqual([24, 48, 48, 72]);
  });
  it("night verdict: proxy needs 3 fresh peers; the median-set proxy also needs every visible peer quote fresh; own judged separately", () => {
    const d = jstSlotMs("2026-10-20", 6); const f = jstSlotMs("2026-10-19", 4); const stale = jstSlotMs("2026-10-15", 4);
    expect(evaluateNight(d, 80, [f, f, f, undefined], f)).toMatchObject({ proxy3: true, medianSetProxy: true, own: true });
    expect(evaluateNight(d, 80, [f, f, f, stale], undefined)).toMatchObject({ proxy3: true, medianSetProxy: false, own: false, staleVisible: 1 });
    expect(evaluateNight(d, 80, [f, f, stale], f)).toMatchObject({ proxy3: false, medianSetProxy: false, own: true });
    expect(evaluateNight(d, 80, [f, f, f, jstSlotMs("2026-10-20", 6)], f).medianSetProxy).toBe(true); // not yet ingested => not visible
  });
});

describe("simulator history reader", () => {
  const head = "row_id,canonical_property_name,source,source_slug_or_code,checkin,collected_at_jst,basis_note";
  it("handles quoted commas/quotes before the key columns and keeps the latest instant", () => {
    const csv = [head,
      `1,"Hotel, ""Quoted"" Name",booking,hotel-a,2027-01-10,2026-10-10T10:00:00+09:00,"note, with comma"`,
      `2,Plain,booking,hotel-a,2027-01-10,2026-10-11T08:00:00+09:00,x`,
      `3,Plain,jalan,yad1,2027-01-10,2026-10-09T08:00:00+09:00,x`, ""].join("\n");
    const r = lastCollectedFromCsv([csv], Date.parse("2026-10-15T00:00:00+09:00"));
    expect(r.map.get("booking|hotel-a|2027-01-10")).toBe("2026-10-11T08:00:00+09:00");
    expect(r.map.get("jalan|yad1|2027-01-10")).toBe("2026-10-09T08:00:00+09:00");
    expect(r.accepted).toBe(3);
    expect(r.rejected).toEqual({});
  });
  it("rejects malformed rows and never invents a timestamp", () => {
    const csv = [head,
      `1,A,booking,hotel-a,2027-01-10,2026-10-10T10:00:00+09:00`,                  // missing column
      `2,A,booking,hotel-a,2027-01-10,2026-10-10 10:00:00,x`,                       // naive timestamp
      `3,A,booking,hotel-a,2027-01-10,2026-10-10T01:00:00Z,x`,                      // not JST convention
      `4,A,booking,,2027-01-10,2026-10-10T10:00:00+09:00,x`,
      `5,A,booking,hotel-a,20270110,2026-10-10T10:00:00+09:00,x`,
      `6,A,booking,hotel-a,2027-01-10,2026-10-16T10:00:00+09:00,x`,                 // after cutoff: skipped
      `7,A,rakuten,r1,2027-01-10,2026-10-10T10:00:00+09:00,x`].join("\n");
    const r = lastCollectedFromCsv([csv, "a,b\n1,2"], Date.parse("2026-10-15T00:00:00+09:00"));
    expect(r.map.size).toBe(0);
    expect(r.rejected).toEqual({ column_count_mismatch: 1, collected_at_not_jst_offset_iso: 2, empty_slug: 1, checkin_not_ymd: 1, file_missing_required_column: 1 });
    expect(r.skipped).toBe(2);
  });
});

describe("simulator success-rate uncertainty", () => {
  it("Jeffreys posterior: a small perfect sample is not near-certain; large samples are tight (synthetic counts)", () => {
    const small = posterior({ s: 5, n: 5 });
    expect(small.mean).toBeCloseTo(5.5 / 6, 6);
    expect(small.p05).toBeLessThan(0.8);
    const big = posterior({ s: 900, n: 1000 });
    expect(big.p95 - big.p05).toBeLessThan(0.05);
    expect(posterior({ p: 0.5 })).toEqual({ mean: 0.5, p05: 0.5, p95: 0.5 });
  });
  it("public default is a labelled synthetic fixture; private models come only via a validated file", () => {
    expect(Object.keys(SYNTHETIC_MODEL).filter((k) => k !== "__own__").sort()).toEqual([...SIM_V1_NAMES].sort());
    expect(parseModel({ A: { booking: { s: 1, n: 2 }, jalan: { p: 0.3 } } })).toEqual({ A: { booking: { s: 1, n: 2 }, jalan: { p: 0.3 } } });
    for (const bad of [null, [], { A: { booking: { s: 3, n: 2 } } }, { A: { rakuten: { p: 0.1 } } }, { A: { booking: { p: 1.5 } } }, { A: { booking: { s: 1.5, n: 2 } } }, { A: 1 }])
      expect(() => parseModel(bad)).toThrow();
  });
});

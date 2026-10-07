import { describe, expect, it } from "vitest";
import {
  CANDIDATE_MULTIPLIERS,
  CANDIDATE_SHARES,
  checkAcceptance,
  selectMinimalConfig,
  type AcceptanceInput,
  type ConfigResult
} from "../src/services/winterLaneAcceptance";
import { MAX_MULTIPLIER } from "../src/services/crawlVolumeConfig";

const good = (kind: "ACTIVE" | "WARM"): AcceptanceInput => ({
  kind,
  primary_cov_steady_pct: 99, primary_cov_final_pct: 98, primary_cov_1_5x_steady_pct: 100,
  own_cov_steady_pct: kind === "ACTIVE" ? 100 : null,
  never_served_steady_max: 0,
  near_starved_steady_avg: 200, near_over96_steady_avg: 150,
  base_near_starved_steady_avg: 170, base_near_over96_steady_avg: 120,
  near_term_cells_total: 1412
});
const cfg = (multiplier: number, share: number, mutate?: (c: AcceptanceInput[]) => void): ConfigResult => {
  const cases = [good("WARM"), good("ACTIVE")];
  mutate?.(cases);
  return { multiplier, share, cases };
};

describe("winter lane acceptance criteria", () => {
  it("ACTIVE requires steady/final/own >=95%", () => {
    expect(checkAcceptance(good("ACTIVE")).pass).toBe(true);
    expect(checkAcceptance({ ...good("ACTIVE"), primary_cov_final_pct: 94.9 }).failures).toContain("primary_sla_final<95");
    expect(checkAcceptance({ ...good("ACTIVE"), own_cov_steady_pct: 90 }).pass).toBe(false);
    expect(checkAcceptance({ ...good("ACTIVE"), own_cov_steady_pct: null }).pass).toBe(false);
  });
  it("WARM requires 1.5x SLA >=95% and no uncollected primary cell in steady state", () => {
    expect(checkAcceptance(good("WARM")).pass).toBe(true);
    expect(checkAcceptance({ ...good("WARM"), primary_cov_1_5x_steady_pct: 94 }).pass).toBe(false);
    expect(checkAcceptance({ ...good("WARM"), never_served_steady_max: 1 }).failures).toContain("uncollected_primary_cells_remain");
  });
  it("near-term starvation allowance is base + 5% of total (~+70) and 96h-chronic is bounded likewise", () => {
    const base = good("WARM");
    expect(checkAcceptance({ ...base, near_starved_steady_avg: 170 + 70 }).pass).toBe(true);
    expect(checkAcceptance({ ...base, near_starved_steady_avg: 170 + 71 }).failures).toContain("near_term_starved_over_base+5%");
    expect(checkAcceptance({ ...base, near_over96_steady_avg: 120 + 71 }).failures).toContain("near_term_over_96h_chronic");
  });
});

describe("minimal valid configuration selection", () => {
  it("candidate grid stays inside the existing hard max multiplier", () => {
    expect(Math.max(...CANDIDATE_MULTIPLIERS)).toBeLessThanOrEqual(MAX_MULTIPLIER);
    expect([...CANDIDATE_SHARES]).toEqual([0.25, 0.33, 0.4, 0.5]);
  });
  it("picks the smallest multiplier first, then smallest share (order-independent => deterministic)", () => {
    const bad = (c: AcceptanceInput[]): void => { c[1]!.primary_cov_steady_pct = 50; };
    const all: ConfigResult[] = [
      cfg(5, 0.25), cfg(4, 0.5), cfg(4, 0.33), cfg(3, 0.5, bad), cfg(3, 0.25, bad), cfg(4, 0.25, bad)
    ];
    const a = selectMinimalConfig(all);
    const b = selectMinimalConfig([...all].reverse());
    expect(a.selected).toMatchObject({ multiplier: 4, share: 0.33 });
    expect(b.selected).toEqual(a.selected);
  });
  it("does not raise to 5 when 3 or 4 is acceptable; uses 3 if it passes", () => {
    expect(selectMinimalConfig([cfg(5, 0.25), cfg(3, 0.4), cfg(4, 0.25)]).selected).toMatchObject({ multiplier: 3, share: 0.4 });
  });
  it("reports the best unmet configuration honestly when nothing passes", () => {
    const worse = (c: AcceptanceInput[]): void => { c[0]!.primary_cov_1_5x_steady_pct = 10; c[1]!.own_cov_steady_pct = 1; };
    const less = (c: AcceptanceInput[]): void => { c[1]!.own_cov_steady_pct = 1; };
    const r = selectMinimalConfig([cfg(3, 0.5, worse), cfg(5, 0.5, less)]);
    expect(r.selected).toBeNull();
    expect(r.best).toMatchObject({ multiplier: 5, share: 0.5 });
    expect(r.failures.flat().length).toBeGreaterThan(0);
  });
  it("ignores configurations above the hard max multiplier", () => {
    expect(selectMinimalConfig([cfg(6, 0.25)]).selected).toBeNull();
  });
});

// 冬季レーンの自動採用基準 (pure)。simulateWinterCoverage の結果から、基準を満たす
// 最小 (crawl multiplier, winter share) を決定的に選ぶ。Owner に選択を戻さない。
//
// 採用基準:
//  ACTIVE シナリオ: PRIMARY within SLA (steady / final-slot) >= 95%, Kiraku own ACTIVE >= 95%
//  WARM シナリオ  : PRIMARY within 1.5x SLA (steady) >= 95%, steady で未収集 primary 0
//  既存レーン     : near-term starved (steady avg) <= base + 5% x RMS-critical 総数、
//                   96h 超セル (steady avg) も同じ許容内 (96h 超の常態化なし)
//  anti-block     : multiplier は既存 hard max (MAX_MULTIPLIER=5) 以内。小さい multiplier
//                   を最優先し、同 multiplier なら小さい share。

import { MAX_MULTIPLIER } from "./crawlVolumeConfig";

export const ACCEPT_MIN_PCT = 95;
export const ACCEPT_NEAR_TERM_ALLOWANCE_FRACTION = 0.05;
export const CANDIDATE_MULTIPLIERS = [3, 4, 5] as const;
export const CANDIDATE_SHARES = [0.25, 0.33, 0.4, 0.5] as const;

export interface AcceptanceInput {
  kind: "ACTIVE" | "WARM";
  primary_cov_steady_pct: number;
  primary_cov_final_pct: number;
  primary_cov_1_5x_steady_pct: number;
  own_cov_steady_pct: number | null;
  never_served_steady_max: number;
  near_starved_steady_avg: number;
  near_over96_steady_avg: number;
  base_near_starved_steady_avg: number;
  base_near_over96_steady_avg: number;
  near_term_cells_total: number;
}

export function checkAcceptance(i: AcceptanceInput): { pass: boolean; failures: string[] } {
  const f: string[] = [];
  if (i.kind === "ACTIVE") {
    if (i.primary_cov_steady_pct < ACCEPT_MIN_PCT) f.push(`primary_sla_steady<${ACCEPT_MIN_PCT}`);
    if (i.primary_cov_final_pct < ACCEPT_MIN_PCT) f.push(`primary_sla_final<${ACCEPT_MIN_PCT}`);
    if (i.own_cov_steady_pct === null || i.own_cov_steady_pct < ACCEPT_MIN_PCT) f.push(`own_active_sla<${ACCEPT_MIN_PCT}`);
  } else {
    if (i.primary_cov_1_5x_steady_pct < ACCEPT_MIN_PCT) f.push(`warm_1_5x_sla<${ACCEPT_MIN_PCT}`);
    if (i.never_served_steady_max > 0) f.push("uncollected_primary_cells_remain");
  }
  const allowance = ACCEPT_NEAR_TERM_ALLOWANCE_FRACTION * i.near_term_cells_total;
  if (i.near_starved_steady_avg > i.base_near_starved_steady_avg + allowance) f.push("near_term_starved_over_base+5%");
  if (i.near_over96_steady_avg > i.base_near_over96_steady_avg + allowance) f.push("near_term_over_96h_chronic");
  return { pass: f.length === 0, failures: f };
}

export interface ConfigResult { multiplier: number; share: number; cases: AcceptanceInput[] }

// 基準を満たす最小 multiplier -> 最小 share。無ければ最も多くの case を満たす最良案 (未達を返す)。
export function selectMinimalConfig(results: readonly ConfigResult[]): { selected: ConfigResult | null; best: ConfigResult | null; failures: string[][] } {
  const ordered = [...results].filter((r) => r.multiplier <= MAX_MULTIPLIER).sort((a, b) => a.multiplier - b.multiplier || a.share - b.share);
  const evalOne = (r: ConfigResult): string[][] => r.cases.map((c) => checkAcceptance(c).failures);
  for (const r of ordered) if (evalOne(r).every((x) => x.length === 0)) return { selected: r, best: r, failures: [] };
  let best: ConfigResult | null = null; let bestScore = Infinity;
  for (const r of ordered) {
    const score = evalOne(r).reduce((n, x) => n + x.length, 0);
    if (score < bestScore) { bestScore = score; best = r; }
  }
  return { selected: null, best, failures: best === null ? [] : evalOne(best) };
}

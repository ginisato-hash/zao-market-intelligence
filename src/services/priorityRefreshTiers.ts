// Phase ZMI PRICING-CRITICAL02 — tiered, STATELESS freshness-SLA refresh plan.
//
// Replaces simple round-robin batching (competitor 34-batch / own 23-batch —
// ~34 days to cycle once) with a freshness SLA: D+1..D+30 is refreshed on
// EVERY run (near-term is exactly where the reported HAMMOND/OAKHILL gaps
// hurt most), D+31..D+60 cycles within 3 days, D+61..D+90 within 7 days.
//
// The rotation needs NO stored state file: a date's rotation bucket is a pure
// function of its own calendar day (epochDay(checkin) % rotationDays), and
// "today's selected bucket" is the same function of today (epochDay(today) %
// rotationDays). Since todayEpoch increases by 1 every calendar day, today's
// selected bucket cycles through every residue 0..rotationDays-1 once every
// rotationDays days — so ANY date whose fixed bucket is b will be selected on
// exactly one of any rotationDays consecutive days. This provably bounds the
// cycle time to rotationDays regardless of missed/skipped runs (self-healing,
// unlike stored round-robin state which drifts if a run is skipped).

import type { RecrawlTarget } from "./priorityRecrawlTargets";

export type RefreshTier = "near_term" | "mid_term" | "far_term";

export const NEAR_TERM_MAX_OFFSET_DAYS = 30;
export const MID_TERM_MAX_OFFSET_DAYS = 60;
export const FAR_TERM_MAX_OFFSET_DAYS = 90;
export const MID_TERM_ROTATION_DAYS = 3;
export const FAR_TERM_ROTATION_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function epochDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / MS_PER_DAY);
}

export function offsetDays(fromIso: string, toIso: string): number {
  return epochDay(toIso) - epochDay(fromIso);
}

export function tierForOffset(offset: number): RefreshTier | null {
  if (offset < 1 || offset > FAR_TERM_MAX_OFFSET_DAYS) return null;
  if (offset <= NEAR_TERM_MAX_OFFSET_DAYS) return "near_term";
  if (offset <= MID_TERM_MAX_OFFSET_DAYS) return "mid_term";
  return "far_term";
}

export function tierForCheckin(checkinIso: string, todayIso: string): RefreshTier | null {
  return tierForOffset(offsetDays(todayIso, checkinIso));
}

/** Is this checkin selected for TODAY's run, given its tier? near_term: always. */
export function isSelectedToday(checkinIso: string, tier: RefreshTier, todayIso: string): boolean {
  if (tier === "near_term") return true;
  const rotationDays = tier === "mid_term" ? MID_TERM_ROTATION_DAYS : FAR_TERM_ROTATION_DAYS;
  return ((epochDay(checkinIso) % rotationDays) + rotationDays) % rotationDays === ((epochDay(todayIso) % rotationDays) + rotationDays) % rotationDays;
}

export interface RefreshPlanBucket<T> {
  near_term: T[]; // D+1..D+30, always full — every run
  mid_term_selected_today: T[]; // D+31..D+60 subset selected today (cycles within 3 days)
  mid_term_full_universe: T[]; // D+31..D+60, all of it (for target-count visibility)
  far_term_selected_today: T[]; // D+61..D+90 subset selected today (cycles within 7 days)
  far_term_full_universe: T[]; // D+61..D+90, all of it
}

export function buildRefreshPlan<T extends { checkin: string }>(targets: readonly T[], todayIso: string): RefreshPlanBucket<T> {
  const near_term: T[] = [];
  const mid_term_full_universe: T[] = [];
  const mid_term_selected_today: T[] = [];
  const far_term_full_universe: T[] = [];
  const far_term_selected_today: T[] = [];
  for (const t of targets) {
    const tier = tierForCheckin(t.checkin, todayIso);
    if (tier === "near_term") { near_term.push(t); continue; }
    if (tier === "mid_term") {
      mid_term_full_universe.push(t);
      if (isSelectedToday(t.checkin, "mid_term", todayIso)) mid_term_selected_today.push(t);
      continue;
    }
    if (tier === "far_term") {
      far_term_full_universe.push(t);
      if (isSelectedToday(t.checkin, "far_term", todayIso)) far_term_selected_today.push(t);
    }
  }
  return { near_term, mid_term_selected_today, mid_term_full_universe, far_term_selected_today, far_term_full_universe };
}

/** Convenience: the exact set of targets this run should actually crawl today. */
export function todaysSelectedTargets<T extends { checkin: string }>(targets: readonly T[], todayIso: string): T[] {
  const plan = buildRefreshPlan(targets, todayIso);
  return [...plan.near_term, ...plan.mid_term_selected_today, ...plan.far_term_selected_today];
}

export type { RecrawlTarget };

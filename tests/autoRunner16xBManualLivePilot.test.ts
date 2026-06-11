import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORCED_BOOKING_OBSERVATION_SLUGS,
  MATSUO_HOUSE_BOOKING_SLUG,
  applyForcedBookingObservationTargets,
  bookingStatusBucket,
  jalanStatusBucket,
  summarizePilotStatuses
} from "../src/scripts/runAutoRunner16xBManualLivePilot";
import { isLiveVerified } from "../src/services/marketRefreshTargetUniverse";
import type { RotatingTarget } from "../src/services/rotatingCollectionScopePlanner";

const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunner16xBManualLivePilot.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function target(over: Partial<RotatingTarget>): RotatingTarget {
  return {
    source: "booking",
    property_slug: "zao-kokusai",
    canonical_property_name: "蔵王国際ホテル",
    stay_date: "2026-06-20",
    checkin: "2026-06-20",
    bucket: "mid",
    tier: "tier_anchor_high",
    priority_score: 10,
    reason_codes: ["weekend"],
    estimated_page_count: 1,
    ...over
  };
}

describe("16X-B pilot — forced observation targets", () => {
  const FORCED = [
    { property_slug: "le-vert-zao", canonical_property_name: "ル・ベール蔵王", tier: "tier_direct_mid" as const },
    { property_slug: MATSUO_HOUSE_BOOKING_SLUG, canonical_property_name: "松尾ハウス", tier: "tier_budget_small" as const }
  ];

  it("replaces non-forced booking targets without growing page count", () => {
    const selected = [
      target({ property_slug: "zao-kokusai", stay_date: "2026-06-20", checkin: "2026-06-20" }),
      target({ property_slug: "zao-shiki-no", stay_date: "2026-06-27", checkin: "2026-06-27" }),
      target({ property_slug: "jurin", stay_date: "2026-07-04", checkin: "2026-07-04" }),
      target({ source: "jalan", property_slug: "yad309590", stay_date: "2026-07-11", checkin: "2026-07-11" })
    ];
    const r = applyForcedBookingObservationTargets({ selected, forced: FORCED, cooledKeys: new Set() });
    expect(r.selected).toHaveLength(4);
    expect(r.forced_added.sort()).toEqual(["le-vert-zao", MATSUO_HOUSE_BOOKING_SLUG].sort());
    const bookingSlugs = r.selected.filter((t) => t.source === "booking").map((t) => t.property_slug);
    expect(bookingSlugs).toContain("le-vert-zao");
    expect(bookingSlugs).toContain(MATSUO_HOUSE_BOOKING_SLUG);
    // jalan row untouched
    expect(r.selected.filter((t) => t.source === "jalan")).toHaveLength(1);
    // forced rows are tagged
    expect(r.selected.filter((t) => t.reason_codes.includes("forced_pilot_observation"))).toHaveLength(2);
  });

  it("leaves selection unchanged when forced slugs already selected", () => {
    const selected = [
      target({ property_slug: "le-vert-zao" }),
      target({ property_slug: MATSUO_HOUSE_BOOKING_SLUG, stay_date: "2026-06-21", checkin: "2026-06-21" })
    ];
    const r = applyForcedBookingObservationTargets({ selected, forced: FORCED, cooledKeys: new Set() });
    expect(r.forced_added).toHaveLength(0);
    expect(r.replaced).toHaveLength(0);
    expect(r.selected.map((t) => t.property_slug)).toEqual(["le-vert-zao", MATSUO_HOUSE_BOOKING_SLUG]);
  });

  it("shifts stay_date past cooldown conflicts", () => {
    const selected = [target({ property_slug: "zao-kokusai", stay_date: "2026-06-20", checkin: "2026-06-20" })];
    const cooled = new Set(["le-vert-zao|2026-06-20", "le-vert-zao|2026-06-21"]);
    const r = applyForcedBookingObservationTargets({ selected, forced: [FORCED[0]!], cooledKeys: cooled });
    expect(r.selected[0]!.property_slug).toBe("le-vert-zao");
    expect(r.selected[0]!.stay_date).toBe("2026-06-22");
    expect(r.selected[0]!.checkin).toBe("2026-06-22");
  });

  it("never decreases distinct booking property count", () => {
    const selected = [
      target({ property_slug: "zao-kokusai", stay_date: "2026-06-20" }),
      target({ property_slug: "zao-kokusai", stay_date: "2026-06-27" }),
      target({ property_slug: "zao-shiki-no", stay_date: "2026-07-04" }),
      target({ property_slug: "jurin", stay_date: "2026-07-11" })
    ];
    const distinctBefore = new Set(selected.map((t) => t.property_slug)).size;
    const r = applyForcedBookingObservationTargets({ selected, forced: FORCED, cooledKeys: new Set() });
    const distinctAfter = new Set(r.selected.map((t) => t.property_slug)).size;
    expect(distinctAfter).toBeGreaterThanOrEqual(distinctBefore);
  });

  it("all forced observation slugs are live-verified booking mappings", () => {
    for (const slug of FORCED_BOOKING_OBSERVATION_SLUGS) {
      expect(isLiveVerified("booking", slug)).toBe(true);
    }
  });
});

describe("16X-B pilot — status classification", () => {
  it("maps booking availability statuses to pilot buckets", () => {
    expect(bookingStatusBucket("available_price_basis")).toBe("available");
    expect(bookingStatusBucket("sold_out_or_unavailable")).toBe("sold_out");
    expect(bookingStatusBucket("visible_no_safe_price")).toBe("visible_no_safe_price");
    expect(bookingStatusBucket("blocked_captcha_or_security")).toBe("blocked");
    expect(bookingStatusBucket("blocked_login_required")).toBe("blocked");
    expect(bookingStatusBucket("not_found")).toBe("not_found");
    expect(bookingStatusBucket("degraded_empty")).toBe("failed");
    expect(bookingStatusBucket("navigation_failed")).toBe("failed");
    expect(bookingStatusBucket("unexpected_error")).toBe("failed");
  });

  it("maps jalan availability statuses to pilot buckets", () => {
    expect(jalanStatusBucket("available")).toBe("available");
    expect(jalanStatusBucket("sold_out")).toBe("sold_out");
    expect(jalanStatusBucket("not_listed")).toBe("not_listed");
    expect(jalanStatusBucket("not_found")).toBe("not_found");
    expect(jalanStatusBucket("failed")).toBe("failed");
  });

  it("summarizes bucket counts", () => {
    const s = summarizePilotStatuses(["available", "available", "sold_out", "blocked", "failed"]);
    expect(s.available).toBe(2);
    expect(s.sold_out).toBe(1);
    expect(s.blocked).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.not_listed).toBe(0);
  });
});

describe("16X-B pilot — static safety", () => {
  it("pilot never appends history, syncs db, refreshes ai context, or publishes", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/appendHistoryRowsAtomic|buildAppendPlan|sync:history-to-db|build:ai-context-packs|publish:chatgpt-db|spawnSync/u);
  });

  it("pilot opens the db read-only and never writes outside report/debug dirs", () => {
    expect(SCRIPT_SOURCE).toContain("readonly: true");
    expect(SCRIPT_SOURCE).toContain(".data/reports/auto-runner16x-b-manual-live-pilot");
    expect(SCRIPT_SOURCE).toContain(".data/debug/auto-runner16x-b-manual-live-pilot");
  });

  it("no captcha bypass / stealth / proxy / cookie injection", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/2captcha|solveCaptcha|stealth-plugin|StealthPlugin|addCookies|storageState|proxy:\s*\{/iu);
  });

  it("pilot aborts when a non-verified target would mix in", () => {
    expect(SCRIPT_SOURCE).toContain("manual_live_pilot_aborted_candidate_only_mixed");
    expect(SCRIPT_SOURCE).toContain("isLiveVerified");
  });

  it("matsuo house semantics note marks needs_observation", () => {
    expect(SCRIPT_SOURCE).toContain("seasonal_room_listing");
    expect(SCRIPT_SOURCE).toContain("needs_observation");
  });

  it("package wires the manual pilot command", () => {
    expect(PACKAGE_JSON).toContain('"auto-runner:16x-b:manual-live-pilot"');
  });
});

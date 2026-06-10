import { describe, expect, it } from "vitest";
import {
  candidateTargets,
  isLiveVerified,
  liveBookingTargets,
  liveJalanTargets,
  liveTargets,
  summarizeUniverse,
  tierOf,
  VERIFIED_LIVE_TARGETS,
  CANDIDATE_ONLY_TARGETS
} from "../src/services/marketRefreshTargetUniverse";

describe("AUTO-RUNNER16X - target universe", () => {
  it("all verified live targets are booking or jalan only", () => {
    expect(VERIFIED_LIVE_TARGETS.every((t) => t.source === "booking" || t.source === "jalan")).toBe(true);
  });

  it("no verified live target for rakuten or google_hotels", () => {
    expect(liveTargets("rakuten")).toHaveLength(0);
    expect(liveTargets("google_hotels")).toHaveLength(0);
  });

  it("verified live targets all have verified_mapping and enabled_for_live", () => {
    expect(liveTargets().every((t) => t.verified_mapping && t.enabled_for_live)).toBe(true);
  });

  it("verified live targets all have non-empty property_slug", () => {
    expect(liveTargets().every((t) => t.property_slug.length > 0)).toBe(true);
  });

  it("candidate-only targets are never live and carry no invented slug", () => {
    expect(candidateTargets().every((t) => !t.enabled_for_live && !t.verified_mapping)).toBe(true);
    expect(candidateTargets().every((t) => t.property_slug === "")).toBe(true);
    expect(CANDIDATE_ONLY_TARGETS.length).toBeGreaterThan(0);
  });

  it("known verified slugs resolve to a tier", () => {
    expect(tierOf("booking", "zao-kokusai")).toBe("tier_anchor_high");
    expect(tierOf("jalan", "yad325153")).toBe("tier_direct_mid");
    expect(tierOf("booking", "nonexistent")).toBeNull();
  });

  it("isLiveVerified true only for verified slugs", () => {
    expect(isLiveVerified("booking", "zao-kokusai")).toBe(true);
    expect(isLiveVerified("booking", "ghost")).toBe(false);
    expect(isLiveVerified("rakuten", "anything")).toBe(false);
  });

  it("summary reports counts", () => {
    const s = summarizeUniverse();
    expect(s.booking_live_verified).toBe(liveBookingTargets().length);
    expect(s.jalan_live_verified).toBe(liveJalanTargets().length);
    expect(s.rakuten_live).toBe(0);
    expect(s.google_hotels_live).toBe(0);
    expect(s.booking_live_verified).toBeGreaterThanOrEqual(3);
    expect(s.jalan_live_verified).toBeGreaterThanOrEqual(5);
  });
});

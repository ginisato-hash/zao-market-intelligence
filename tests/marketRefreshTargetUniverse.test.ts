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

  it("candidate-only targets are never live", () => {
    expect(candidateTargets().every((t) => !t.enabled_for_live && !t.verified_mapping)).toBe(true);
    expect(CANDIDATE_ONLY_TARGETS.length).toBeGreaterThan(0);
  });

  it("no candidate-only target leaks into the live set", () => {
    const liveKeys = new Set(liveTargets().map((t) => `${t.source}|${t.property_slug}`));
    for (const c of candidateTargets()) {
      // even le-vert-zao (real slug, needs_review) must not be live
      expect(c.enabled_for_live).toBe(false);
      if (c.property_slug !== "") expect(liveKeys.has(`${c.source}|${c.property_slug}`)).toBe(false);
    }
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
    // AUTO-RUNNER16X-F expansion goals: booking >= 20, jalan >= 20.
    expect(s.booking_live_verified).toBeGreaterThanOrEqual(20);
    expect(s.jalan_live_verified).toBeGreaterThanOrEqual(20);
  });

  it("16X-F promoted targets carry slug + url + discovery evidence note", () => {
    const promoted = liveTargets().filter((t) => t.verification_note.includes("16X-F"));
    expect(promoted.length).toBeGreaterThanOrEqual(13);
    for (const t of promoted) {
      expect(t.property_slug.length).toBeGreaterThan(0);
      expect(t.source_url ?? "").toMatch(/^https:\/\/(www\.)?(jalan\.net\/yad\d+\/|booking\.com\/hotel\/jp\/[a-z0-9-]+\.ja\.html)$/u);
      expect(t.verification_note).toContain("name+region match");
      if (t.source === "jalan") expect(t.source_property_id).toBe(t.property_slug);
    }
  });

  it("16X-F adds 三浦屋 (own property self-monitor) on both sources", () => {
    expect(isLiveVerified("jalan", "yad302145")).toBe(true);
    expect(isLiveVerified("booking", "japanese-hostel-miuraya")).toBe(true);
  });

  it("16X-A4 promoted targets carry slug + url + discovery evidence note", () => {
    const promoted = liveTargets().filter((t) => t.verification_note.includes("16X-A4"));
    expect(promoted.length).toBeGreaterThanOrEqual(20);
    for (const t of promoted) {
      expect(t.property_slug.length).toBeGreaterThan(0);
      expect(t.source_url ?? "").toMatch(/^https:\/\/(www\.)?(jalan\.net\/yad\d+\/|booking\.com\/hotel\/jp\/[a-z0-9-]+\.ja\.html)$/u);
      expect(t.verification_note).toContain("name+region match");
      if (t.source === "jalan") expect(t.source_property_id).toBe(t.property_slug);
    }
  });

  it("no duplicate (source, property_slug) across the live universe", () => {
    const keys = VERIFIED_LIVE_TARGETS.map((t) => `${t.source}|${t.property_slug}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

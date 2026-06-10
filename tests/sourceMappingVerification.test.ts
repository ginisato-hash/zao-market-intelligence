import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideVerification,
  nameMatches,
  regionMatches,
  renderVerificationCsv,
  summarize,
  type MappingVerificationCandidate,
  type ProbeObservation
} from "../src/services/sourceMappingVerification";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/sourceMappingVerification.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runSourceMappingVerification.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function candidate(overrides: Partial<MappingVerificationCandidate> = {}): MappingVerificationCandidate {
  return {
    source: "jalan",
    canonical_property_name: "ル・ベール蔵王",
    candidate_slug_or_id: "yad328232",
    candidate_url: "https://www.jalan.net/yad328232/",
    evidence_source: "manual_candidate_universe",
    tier: "tier_direct_mid",
    ...overrides
  };
}

function obs(overrides: Partial<ProbeObservation> = {}): ProbeObservation {
  return {
    has_id: true, loaded: true, http_status: 200, blocked_or_captcha: false, login_required: false, not_found: false,
    page_title: "ル・ベール蔵王 — 蔵王温泉 山形県", visible_text: "ル・ベール蔵王 蔵王温泉 山形市の宿", error: "",
    ...overrides
  };
}

describe("AUTO-RUNNER16X-A3 - name/region matching", () => {
  it("matches canonical name in page text", () => {
    expect(nameMatches("ル・ベール蔵王", "ようこそ ル・ベール蔵王 へ")).toBe(true);
    expect(nameMatches("ル・ベール蔵王", "全く別のホテル")).toBe(false);
  });
  it("matches zao/yamagata region tokens", () => {
    expect(regionMatches("山形県山形市蔵王温泉")).toBe(true);
    expect(regionMatches("Zao Onsen, Yamagata")).toBe(true);
    expect(regionMatches("Tokyo Shibuya")).toBe(false);
  });
});

describe("AUTO-RUNNER16X-A3 - verification decision", () => {
  it("verified only when name + region match on a clean load", () => {
    const r = decideVerification(candidate(), obs());
    expect(r.status).toBe("verified");
    expect(r.safe_to_enable_live).toBe(true);
    expect(r.identity_confidence).toBe("A");
  });

  it("name match but no region => needs_review, not live", () => {
    const r = decideVerification(
      candidate({ canonical_property_name: "OAKHILL" }),
      obs({ page_title: "OAKHILL Hotel", visible_text: "Welcome to OAKHILL Hotel" })
    );
    expect(r.status).toBe("candidate_found_needs_review");
    expect(r.safe_to_enable_live).toBe(false);
  });

  it("no name match => ambiguous, not live", () => {
    const r = decideVerification(candidate(), obs({ page_title: "別のホテル", visible_text: "蔵王温泉 山形 別施設" }));
    expect(r.status).toBe("ambiguous");
    expect(r.safe_to_enable_live).toBe(false);
  });

  it("captcha/security => blocked_or_captcha, not live", () => {
    const r = decideVerification(candidate(), obs({ blocked_or_captcha: true }));
    expect(r.status).toBe("blocked_or_captcha");
    expect(r.safe_to_enable_live).toBe(false);
  });

  it("login required => blocked_or_captcha, not live", () => {
    const r = decideVerification(candidate(), obs({ login_required: true }));
    expect(r.status).toBe("blocked_or_captcha");
    expect(r.safe_to_enable_live).toBe(false);
  });

  it("not found / 404 => not_found, not live", () => {
    expect(decideVerification(candidate(), obs({ not_found: true })).status).toBe("not_found");
    expect(decideVerification(candidate(), obs({ http_status: 404 })).status).toBe("not_found");
  });

  it("load failure => failed, not live", () => {
    const r = decideVerification(candidate(), obs({ loaded: false, error: "timeout" }));
    expect(r.status).toBe("failed");
    expect(r.safe_to_enable_live).toBe(false);
  });

  it("candidate with no id => not_found (no guessing), not live", () => {
    const r = decideVerification(candidate({ candidate_slug_or_id: "", candidate_url: "" }), obs({ has_id: false, loaded: false }));
    expect(r.status).toBe("not_found");
    expect(r.rejection_reason).toBe("no_source_id_no_guess");
    expect(r.safe_to_enable_live).toBe(false);
  });

  it("only verified results are safe_to_enable_live", () => {
    const all = [
      decideVerification(candidate(), obs()),
      decideVerification(candidate(), obs({ blocked_or_captcha: true })),
      decideVerification(candidate(), obs({ not_found: true })),
      decideVerification(candidate({ candidate_slug_or_id: "" }), obs({ has_id: false }))
    ];
    expect(all.filter((r) => r.safe_to_enable_live).every((r) => r.status === "verified")).toBe(true);
  });
});

describe("AUTO-RUNNER16X-A3 - summary/render and safety", () => {
  it("summarize counts by status and source", () => {
    const results = [
      { ...decideVerification(candidate(), obs()), debug_artifact_path: "" },
      { ...decideVerification(candidate({ source: "booking", canonical_property_name: "蔵王国際ホテル", candidate_slug_or_id: "zao-kokusai" }), obs({ page_title: "蔵王国際ホテル 蔵王温泉" , visible_text: "蔵王国際ホテル 山形 蔵王温泉"})), debug_artifact_path: "" }
    ];
    const s = summarize(results);
    expect(s.verified_jalan_count).toBe(1);
    expect(s.verified_booking_count).toBe(1);
  });

  it("CSV has the verification header", () => {
    const r = [{ ...decideVerification(candidate(), obs()), debug_artifact_path: "/tmp" }];
    expect(renderVerificationCsv(r).split("\n")[0]).toContain("status,property_identity_match");
  });

  it("service/script contain no paid-source/proxy/stealth/login/cookie/captcha-bypass", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/serpapi|brightdata|smartproxy|2captcha|solveCaptcha|stealth-plugin|StealthPlugin|addCookies|storageState|proxy:\s*\{/iu);
  });

  it("script does not collect price or enter booking flow", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/normalized_total_price|book now|予約する|add_to_cart|checkout|append/iu);
  });

  it("package wires verify:source-mappings", () => {
    expect(PACKAGE_JSON).toContain("verify:source-mappings");
  });
});

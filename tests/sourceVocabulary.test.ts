import { describe, expect, it } from "vitest";
import {
  CANONICAL_SOURCES,
  isAllowedSource,
  isCanonicalSource,
  isCanonicalAccessStatus,
  CANONICAL_ACCESS_STATUSES
} from "../src/services/sourceVocabulary";

describe("sourceVocabulary: canonical sources", () => {
  it("includes all expected free/direct sources", () => {
    for (const expected of ["jalan", "rakuten", "booking", "google_hotels", "yahoo_travel", "ikyu"]) {
      expect(CANONICAL_SOURCES).toContain(expected as (typeof CANONICAL_SOURCES)[number]);
    }
  });

  it("isCanonicalSource returns true for each canonical source", () => {
    for (const source of CANONICAL_SOURCES) {
      expect(isCanonicalSource(source)).toBe(true);
    }
  });

  it("rejects drift names that are not canonical", () => {
    const driftNames = ["rakuten_travel", "booking_com", "google_travel_paid", "serpapi", "dataforseo"];
    for (const name of driftNames) {
      expect(isCanonicalSource(name)).toBe(false);
    }
  });

  it("does not include paid infrastructure sources", () => {
    const forbidden = ["serpapi", "dataforseo", "apify", "brightdata", "oxylabs"];
    for (const name of forbidden) {
      expect(CANONICAL_SOURCES).not.toContain(name as never);
    }
  });

  it("isAllowedSource accepts canonical sources and 'other'", () => {
    expect(isAllowedSource("jalan")).toBe(true);
    expect(isAllowedSource("rakuten")).toBe(true);
    expect(isAllowedSource("other")).toBe(true);
  });

  it("isAllowedSource rejects drift and paid names", () => {
    expect(isAllowedSource("rakuten_travel")).toBe(false);
    expect(isAllowedSource("booking_com")).toBe(false);
    expect(isAllowedSource("serpapi")).toBe(false);
  });
});

describe("sourceVocabulary: canonical access statuses", () => {
  it("includes expected statuses from prior phases", () => {
    const expected = [
      "collector_working",
      "expected_fields_missing",
      "consent_or_js_wall",
      "empty_body_or_upstream_bot_detection",
      "content_visible_no_safe_price"
    ];
    for (const status of expected) {
      expect(CANONICAL_ACCESS_STATUSES).toContain(status as (typeof CANONICAL_ACCESS_STATUSES)[number]);
    }
  });

  it("isCanonicalAccessStatus returns true for each canonical status", () => {
    for (const status of CANONICAL_ACCESS_STATUSES) {
      expect(isCanonicalAccessStatus(status)).toBe(true);
    }
  });

  it("rejects unknown access statuses", () => {
    expect(isCanonicalAccessStatus("rakuten_overview_page")).toBe(false);
    expect(isCanonicalAccessStatus("google_travel_paid_api")).toBe(false);
  });
});

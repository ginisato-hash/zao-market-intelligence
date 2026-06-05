import { describe, expect, it } from "vitest";
import {
  propertySourceCoverageSeedRecordSchema
} from "../src/seeds/propertySourceCoverageSeedSchema";

const confirmedJalan = {
  property_name: "ル・ベール蔵王",
  source: "jalan",
  source_property_id: "yad328232",
  property_url: "https://www.jalan.net/yad328232/",
  coverage_status: "confirmed",
  access_status: "collector_working",
  last_verified_at: "2026-05-29T00:00:00+09:00",
  notes: "Jalan prototype and batch collection succeeded.",
  active: true
};

const blockedBooking = {
  property_name: "ル・ベール蔵王",
  source: "booking",
  source_property_id: "le-vert-zao",
  property_url: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html",
  coverage_status: "blocked",
  access_status: "empty_body_or_upstream_bot_detection",
  notes: "empty body / upstream bot detection",
  active: false
};

const needsReviewRakuten = {
  property_name: "ル・ベール蔵王",
  source: "rakuten",
  source_property_id: "29465",
  property_url: "https://travel.rakuten.co.jp/HOTEL/29465/",
  coverage_status: "needs_review",
  access_status: "date_specific_results_not_reached",
  active: true
};

describe("propertySourceCoverageSeedRecordSchema", () => {
  it("accepts a valid confirmed Jalan row", () => {
    expect(propertySourceCoverageSeedRecordSchema.safeParse(confirmedJalan).success).toBe(true);
  });

  it("accepts a blocked Booking row", () => {
    expect(propertySourceCoverageSeedRecordSchema.safeParse(blockedBooking).success).toBe(true);
  });

  it("accepts a needs_review Rakuten row", () => {
    expect(propertySourceCoverageSeedRecordSchema.safeParse(needsReviewRakuten).success).toBe(true);
  });

  it("rejects the paid source serpapi", () => {
    expect(
      propertySourceCoverageSeedRecordSchema.safeParse({ ...needsReviewRakuten, source: "serpapi" }).success
    ).toBe(false);
  });

  it("rejects the paid source dataforseo", () => {
    expect(
      propertySourceCoverageSeedRecordSchema.safeParse({ ...needsReviewRakuten, source: "dataforseo" }).success
    ).toBe(false);
  });

  it("rejects an unknown coverage_status", () => {
    expect(
      propertySourceCoverageSeedRecordSchema.safeParse({ ...confirmedJalan, coverage_status: "maybe" }).success
    ).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(
      propertySourceCoverageSeedRecordSchema.safeParse({ ...confirmedJalan, property_url: "not a url" }).success
    ).toBe(false);
  });

  it("rejects a blank property_name", () => {
    expect(
      propertySourceCoverageSeedRecordSchema.safeParse({ ...confirmedJalan, property_name: "  " }).success
    ).toBe(false);
  });

  it("rejects a blank source", () => {
    expect(
      propertySourceCoverageSeedRecordSchema.safeParse({ ...confirmedJalan, source: "  " }).success
    ).toBe(false);
  });
});

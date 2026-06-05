import { describe, expect, it } from "vitest";
import {
  validateAllPropertyCandidates,
  EXPECTED_ZAO_ANCHORS,
  type ALL_PROPERTY_SOURCES
} from "../src/scripts/validateAllPropertySourceCandidates";

type Source = (typeof ALL_PROPERTY_SOURCES)[number];

function row(property_name: string, source: Source, found = false) {
  const foundValues = {
    jalan: ["https://www.jalan.net/yad321744/", "321744"],
    rakuten: ["https://travel.rakuten.co.jp/HOTEL/38534/", "38534"],
    booking: ["https://www.booking.com/hotel/jp/miyamaso-takamiya.ja.html", "miyamaso-takamiya"],
    google_hotels: ["https://www.google.com/travel/hotels/entity/CgoITestToken", "CgoITestToken"]
  } as const;
  const [url, id] = foundValues[source];
  return {
    property_name,
    source,
    candidate_property_url: found ? url : null,
    candidate_source_property_id: found ? id : null,
    candidate_label: found ? `${source} ${id}` : null,
    evidence_note: found
      ? `AI-discovered ${source} candidate; human review required.`
      : `No ${source} candidate discovered; no identifier invented.`,
    verification_status: found ? "needs_review" : "candidate",
    reviewer_note: null
  };
}

function rowsFor(propertyName: string) {
  return [
    row(propertyName, "jalan", true),
    row(propertyName, "rakuten", true),
    row(propertyName, "booking", false),
    row(propertyName, "google_hotels", false)
  ];
}

function rowsForAllAnchors() {
  return EXPECTED_ZAO_ANCHORS.flatMap((propertyName) => rowsFor(propertyName));
}

const retainedProperties = ["YuiLocalZao", "ZAO BASE", "ユニテ蔵王ジョーニダ・リゾート"];

function rowsForValidUniverse() {
  return [...EXPECTED_ZAO_ANCHORS, ...retainedProperties].flatMap((propertyName) => rowsFor(propertyName));
}

describe("validateAllPropertyCandidates", () => {
  it("returns ready_for_human_review=true and ready_for_import=false for valid AI-discovered rows", () => {
    const result = validateAllPropertyCandidates(rowsForValidUniverse(), "fixture.json");
    expect(result.structurallyValid).toBe(true);
    expect(result.readyForHumanReview).toBe(true);
    expect(result.readyForImport).toBe(false);
    expect(result.rowsCount).toBe((EXPECTED_ZAO_ANCHORS.length + retainedProperties.length) * 4);
    expect(result.expectedRows).toBe((EXPECTED_ZAO_ANCHORS.length + retainedProperties.length) * 4);
    expect(result.countBySource).toEqual({
      jalan: EXPECTED_ZAO_ANCHORS.length + retainedProperties.length,
      rakuten: EXPECTED_ZAO_ANCHORS.length + retainedProperties.length,
      booking: EXPECTED_ZAO_ANCHORS.length + retainedProperties.length,
      google_hotels: EXPECTED_ZAO_ANCHORS.length + retainedProperties.length
    });
  });

  it("fails on mock/test property names", () => {
    const result = validateAllPropertyCandidates(rowsFor("property_mock_zao_001"), "bad.json");
    expect(result.structurallyValid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("mock/test"))).toBe(true);
  });

  it("fails on duplicate property/source pairs", () => {
    const rows = rowsFor("深山荘 高見屋");
    rows[3] = row("深山荘 高見屋", "jalan", true);
    const result = validateAllPropertyCandidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("duplicate property/source pair"))).toBe(true);
  });

  it("checks row_count equals canonical_property_count times four sources", () => {
    const rows = rowsFor("深山荘 高見屋").slice(0, 3);
    const result = validateAllPropertyCandidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    expect(result.expectedRows).toBe(4);
    expect(result.errors.some((e) => e.message.includes("missing source rows"))).toBe(true);
    expect(result.errors.some((e) => e.message.includes("row count"))).toBe(true);
  });

  it("fails when AI-discovered rows are marked confirmed", () => {
    const rows = rowsForValidUniverse();
    rows[0]!.verification_status = "confirmed";
    const result = validateAllPropertyCandidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("confirmed"))).toBe(true);
  });

  it("fails when 三浦屋 is missing", () => {
    const rows = [...EXPECTED_ZAO_ANCHORS.filter((name) => name !== "三浦屋"), ...retainedProperties].flatMap(
      (propertyName) => rowsFor(propertyName)
    );
    const result = validateAllPropertyCandidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("三浦屋"))).toBe(true);
  });

  it("rejects duplicated 善七乃湯 variants as standalone canonical names", () => {
    const rows = [
      ...rowsForAllAnchors(),
      ...retainedProperties.flatMap((propertyName) => rowsFor(propertyName)),
      ...rowsFor("善七乃湯・oohira HOTEL"),
      ...rowsFor("最上高湯 善七乃湯（旧：蔵王温泉 大平ホテル）")
    ];
    const result = validateAllPropertyCandidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("善七乃湯 variants"))).toBe(true);
  });

  it("fails when approved retained properties are missing", () => {
    const result = validateAllPropertyCandidates(rowsForAllAnchors(), "bad.json");
    expect(result.structurallyValid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("YuiLocalZao"))).toBe(true);
    expect(result.errors.some((e) => e.message.includes("ZAO BASE"))).toBe(true);
    expect(result.errors.some((e) => e.message.includes("ユニテ蔵王ジョーニダ・リゾート"))).toBe(true);
  });

  it("rejects Kaminoyama / Zao Bodaira boundary properties", () => {
    const rows = [...rowsForValidUniverse(), ...rowsFor("蔵王エコー山荘"), ...rowsFor("蔵王ライザウッディロッジ")];
    const result = validateAllPropertyCandidates(rows, "bad.json");
    expect(result.structurallyValid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("outside Yamagata City Zao Onsen village"))).toBe(true);
  });
});

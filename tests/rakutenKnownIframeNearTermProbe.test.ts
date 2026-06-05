import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRakutenIframeUrlForDate,
  classifyRakutenNearTermProbe,
  decideRakutenNearTermFeasibility,
  detectNoMatchingRoomType,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  RAKUTEN_NEAR_TERM_CSV_HEADERS,
  renderRakutenNearTermCsv,
  type RakutenIframeEvidence,
  type RakutenNearTermProbeRow
} from "../src/services/rakutenKnownIframeNearTermProbe";

const NEAR_TERM_DATES = ["2026-06-15", "2026-06-22", "2026-07-01", "2026-07-12"] as const;

const evidence = (overrides: Partial<RakutenIframeEvidence> = {}): RakutenIframeEvidence => ({
  propertyDetected: true,
  dateScopeDetected: true,
  adultCountDetected: true,
  roomCountDetected: true,
  nightCountDetected: true,
  taxIncludedTotalDetected: true,
  taxIncludedTotalText: "33,000円",
  perPersonPriceDetected: false,
  perPersonPriceText: "",
  soldOutOrNoPlanDetected: false,
  availabilityStatus: "available",
  ...overrides
});

const row = (overrides: Partial<RakutenNearTermProbeRow> = {}): RakutenNearTermProbeRow => ({
  canonicalPropertyName: "ZAO BASE",
  hotelNo: "197787",
  stayDate: "2026-06-15",
  knownBaseUrl: KNOWN_ZAO_BASE_IFRAME_URL,
  generatedUrl: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?...",
  reachable: true,
  dateScopeDetected: false,
  roomCountDetected: false,
  adultCountDetected: false,
  nightCountDetected: false,
  taxIncludedTotalDetected: "",
  perPersonPriceDetected: "",
  availabilityStatus: "unknown",
  classification: "near_term_no_matching_room_type",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-known-iframe-nearterm-probe/x",
  ...overrides
});

describe("near-term date variants", () => {
  it("generate the four near-term f_hizuke values while preserving identity params", () => {
    const expected = ["20260615", "20260622", "20260701", "20260712"];
    NEAR_TERM_DATES.forEach((stayDate, i) => {
      const url = buildRakutenIframeUrlForDate(KNOWN_ZAO_BASE_IFRAME_URL, stayDate);
      const params = parseRakutenIframeParams(url);
      expect(params.fHizuke).toBe(expected[i]);
      expect(params.fHak).toBe("1");
      expect(params.fSyu).toBe("zaobase3");
      expect(params.fNo).toBe("197787");
      expect(params.fOtonaSu).toBe("2");
      expect(params.fHeyaSu).toBe("1");
    });
  });
});

describe("detectNoMatchingRoomType", () => {
  it("detects the no-matching-room-type message", () => {
    expect(detectNoMatchingRoomType("該当する部屋タイプが見つかりません。")).toBe(true);
  });
  it("returns false otherwise", () => {
    expect(detectNoMatchingRoomType("合計（税込）33,000円 予約する")).toBe(false);
  });
});

describe("classifyRakutenNearTermProbe", () => {
  it("classifies near_term_url_failed when unreachable", () => {
    expect(
      classifyRakutenNearTermProbe({ reachable: false, noMatchingRoomType: false, evidence: evidence() })
    ).toBe("near_term_url_failed");
  });
  it("classifies near_term_no_matching_room_type", () => {
    expect(
      classifyRakutenNearTermProbe({ reachable: true, noMatchingRoomType: true, evidence: evidence() })
    ).toBe("near_term_no_matching_room_type");
  });
  it("classifies near_term_no_plan_or_sold_out", () => {
    expect(
      classifyRakutenNearTermProbe({
        reachable: true,
        noMatchingRoomType: false,
        evidence: evidence({ soldOutOrNoPlanDetected: true })
      })
    ).toBe("near_term_no_plan_or_sold_out");
  });
  it("classifies near_term_date_scope_unverified", () => {
    expect(
      classifyRakutenNearTermProbe({
        reachable: true,
        noMatchingRoomType: false,
        evidence: evidence({ dateScopeDetected: false })
      })
    ).toBe("near_term_date_scope_unverified");
  });
  it("classifies near_term_date_scoped_total_found", () => {
    expect(
      classifyRakutenNearTermProbe({ reachable: true, noMatchingRoomType: false, evidence: evidence() })
    ).toBe("near_term_date_scoped_total_found");
  });
  it("classifies near_term_date_scoped_per_person_found", () => {
    expect(
      classifyRakutenNearTermProbe({
        reachable: true,
        noMatchingRoomType: false,
        evidence: evidence({
          taxIncludedTotalDetected: false,
          taxIncludedTotalText: "",
          perPersonPriceDetected: true,
          perPersonPriceText: "6,000円/人"
        })
      })
    ).toBe("near_term_date_scoped_per_person_found");
  });
});

describe("decideRakutenNearTermFeasibility", () => {
  it("returns near_term_iframe_ready when a total is found", () => {
    expect(
      decideRakutenNearTermFeasibility([
        "near_term_no_matching_room_type",
        "near_term_date_scoped_total_found"
      ])
    ).toBe("near_term_iframe_ready");
  });
  it("returns near_term_iframe_basis_mapping_needed with useful but unclear evidence", () => {
    expect(decideRakutenNearTermFeasibility(["near_term_basis_unverified"])).toBe(
      "near_term_iframe_basis_mapping_needed"
    );
  });
  it("returns near_term_iframe_not_ready when all rows are no-room/no-date/url-failed", () => {
    expect(
      decideRakutenNearTermFeasibility([
        "near_term_no_matching_room_type",
        "near_term_no_matching_room_type",
        "near_term_date_scope_unverified",
        "near_term_url_failed"
      ])
    ).toBe("near_term_iframe_not_ready");
  });
});

describe("renderRakutenNearTermCsv", () => {
  it("emits the fixed header and no PMS/upload/inventory columns", () => {
    const csv = renderRakutenNearTermCsv([row()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_NEAR_TERM_CSV_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(
      resolve(__dirname, "../src/scripts/probeRakutenKnownIframeNearTerm.ts"),
      "utf-8"
    );
    expect(source).not.toMatch(
      /INSERT INTO rate_snapshots|INSERT INTO inventory_snapshots|INSERT INTO collector_runs/iu
    );
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRakutenIframeUrlForDate,
  classifyRakutenKnownIframeProbe,
  decideRakutenKnownIframeFeasibility,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  RAKUTEN_KNOWN_IFRAME_CSV_HEADERS,
  renderRakutenKnownIframeCsv,
  type RakutenIframeEvidence,
  type RakutenKnownIframeProbeRow
} from "../src/services/rakutenKnownIframeProbe";

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

const row = (overrides: Partial<RakutenKnownIframeProbeRow> = {}): RakutenKnownIframeProbeRow => ({
  canonicalPropertyName: "ZAO BASE",
  hotelNo: "197787",
  stayDate: "2026-08-10",
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
  classification: "known_iframe_date_scope_unverified",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-known-iframe-probe/x",
  ...overrides
});

describe("KNOWN_ZAO_BASE_IFRAME_URL parsing", () => {
  const params = parseRakutenIframeParams(KNOWN_ZAO_BASE_IFRAME_URL);
  it("preserves f_no=197787", () => {
    expect(params.fNo).toBe("197787");
  });
  it("preserves f_syu=zaobase3", () => {
    expect(params.fSyu).toBe("zaobase3");
  });
  it("preserves f_otona_su=2", () => {
    expect(params.fOtonaSu).toBe("2");
  });
  it("preserves f_heya_su=1", () => {
    expect(params.fHeyaSu).toBe("1");
  });
});

describe("buildRakutenIframeUrlForDate (known base URL)", () => {
  it("sets f_hizuke and f_hak=1 while preserving identity params", () => {
    const url = buildRakutenIframeUrlForDate(KNOWN_ZAO_BASE_IFRAME_URL, "2026-08-10");
    const params = parseRakutenIframeParams(url);
    expect(params.fHizuke).toBe("20260810");
    expect(params.fHak).toBe("1");
    expect(params.fSyu).toBe("zaobase3");
    expect(params.fNo).toBe("197787");
    expect(params.fOtonaSu).toBe("2");
    expect(params.fHeyaSu).toBe("1");
    expect(params.tbIframe).toBe("true");
    expect(params.fThick).toBe("1");
  });

  it("sets the second date variant f_hizuke=20261010", () => {
    const url = buildRakutenIframeUrlForDate(KNOWN_ZAO_BASE_IFRAME_URL, "2026-10-10");
    expect(parseRakutenIframeParams(url).fHizuke).toBe("20261010");
  });
});

describe("classifyRakutenKnownIframeProbe", () => {
  it("classifies known_iframe_url_failed when unreachable", () => {
    expect(classifyRakutenKnownIframeProbe({ reachable: false, evidence: evidence() })).toBe(
      "known_iframe_url_failed"
    );
  });
  it("classifies known_iframe_date_scope_unverified when date missing", () => {
    expect(
      classifyRakutenKnownIframeProbe({ reachable: true, evidence: evidence({ dateScopeDetected: false }) })
    ).toBe("known_iframe_date_scope_unverified");
  });
  it("classifies known_iframe_no_plan_or_sold_out", () => {
    expect(
      classifyRakutenKnownIframeProbe({
        reachable: true,
        evidence: evidence({ soldOutOrNoPlanDetected: true })
      })
    ).toBe("known_iframe_no_plan_or_sold_out");
  });
  it("classifies known_iframe_date_scoped_total_found", () => {
    expect(classifyRakutenKnownIframeProbe({ reachable: true, evidence: evidence() })).toBe(
      "known_iframe_date_scoped_total_found"
    );
  });
  it("classifies known_iframe_date_scoped_per_person_found", () => {
    expect(
      classifyRakutenKnownIframeProbe({
        reachable: true,
        evidence: evidence({
          taxIncludedTotalDetected: false,
          taxIncludedTotalText: "",
          perPersonPriceDetected: true,
          perPersonPriceText: "6,000円/人"
        })
      })
    ).toBe("known_iframe_date_scoped_per_person_found");
  });
  it("classifies known_iframe_basis_unverified otherwise", () => {
    expect(
      classifyRakutenKnownIframeProbe({
        reachable: true,
        evidence: evidence({
          taxIncludedTotalDetected: false,
          taxIncludedTotalText: "",
          availabilityStatus: "unknown"
        })
      })
    ).toBe("known_iframe_basis_unverified");
  });
});

describe("decideRakutenKnownIframeFeasibility", () => {
  it("returns known_iframe_ready when a total is found", () => {
    expect(
      decideRakutenKnownIframeFeasibility([
        "known_iframe_url_failed",
        "known_iframe_date_scoped_total_found"
      ])
    ).toBe("known_iframe_ready");
  });
  it("returns known_iframe_basis_mapping_needed with useful but unclear evidence", () => {
    expect(decideRakutenKnownIframeFeasibility(["known_iframe_basis_unverified"])).toBe(
      "known_iframe_basis_mapping_needed"
    );
  });
  it("returns known_iframe_not_ready when nothing useful", () => {
    expect(
      decideRakutenKnownIframeFeasibility(["known_iframe_url_failed", "known_iframe_date_scope_unverified"])
    ).toBe("known_iframe_not_ready");
  });
});

describe("renderRakutenKnownIframeCsv", () => {
  it("emits the fixed header and no PMS/upload/inventory columns", () => {
    const csv = renderRakutenKnownIframeCsv([row()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_KNOWN_IFRAME_CSV_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(
      resolve(__dirname, "../src/scripts/probeRakutenKnownIframeUrl.ts"),
      "utf-8"
    );
    expect(source).not.toMatch(/INSERT INTO rate_snapshots|INSERT INTO inventory_snapshots|INSERT INTO collector_runs/iu);
  });
});

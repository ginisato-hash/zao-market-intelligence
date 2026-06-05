import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMatrixVariants,
  classifyRakutenMatrixProbe,
  decideRakutenMatrixFeasibility,
  detectAvailabilityGrid,
  KNOWN_ZAO_BASE_IFRAME_URL,
  parseRakutenIframeParams,
  RAKUTEN_MATRIX_CSV_HEADERS,
  renderRakutenMatrixCsv,
  type FHakVariant,
  type FSyuVariant,
  type RakutenIframeEvidence,
  type RakutenMatrixProbeRow
} from "../src/services/rakutenIframeMatrixProbe";

const variants = buildMatrixVariants({
  baseUrl: KNOWN_ZAO_BASE_IFRAME_URL,
  liveSyuValue: "zaobaseLIVE",
  stayDate: "2026-06-15"
});

function pick(fSyuVariant: FSyuVariant, fHakVariant: FHakVariant) {
  const v = variants.find((x) => x.fSyuVariant === fSyuVariant && x.fHakVariant === fHakVariant);
  if (!v) throw new Error(`variant not found: ${fSyuVariant}/${fHakVariant}`);
  return v;
}

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

const row = (overrides: Partial<RakutenMatrixProbeRow> = {}): RakutenMatrixProbeRow => ({
  canonicalPropertyName: "ZAO BASE",
  hotelNo: "197787",
  stayDate: "2026-06-15",
  fSyuVariant: "known_zaobase3",
  fSyuValue: "zaobase3",
  fHakVariant: "f_hak_1",
  fHakValue: "1",
  generatedUrl: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?...",
  reachable: true,
  dateScopeDetected: false,
  roomCountDetected: false,
  adultCountDetected: false,
  nightCountDetected: false,
  taxIncludedTotalDetected: "",
  perPersonPriceDetected: "",
  availabilityStatus: "unknown",
  classification: "matrix_no_matching_room_type",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-iframe-matrix-probe/x",
  ...overrides
});

describe("buildMatrixVariants", () => {
  it("creates 8 initial rows (4 f_syu × 2 f_hak)", () => {
    expect(variants).toHaveLength(8);
  });

  it("live variant preserves the extracted f_syu value", () => {
    expect(parseRakutenIframeParams(pick("live_extracted_f_syu", "f_hak_1").generatedUrl).fSyu).toBe(
      "zaobaseLIVE"
    );
  });

  it("known_zaobase3 variant sets f_syu=zaobase3", () => {
    expect(parseRakutenIframeParams(pick("known_zaobase3", "f_hak_1").generatedUrl).fSyu).toBe("zaobase3");
  });

  it("all variant sets f_syu=all", () => {
    expect(parseRakutenIframeParams(pick("all", "f_hak_1").generatedUrl).fSyu).toBe("all");
  });

  it("omitted variant removes f_syu entirely", () => {
    const url = pick("omitted_f_syu", "f_hak_1").generatedUrl;
    expect(parseRakutenIframeParams(url).fSyu).toBeNull();
    expect(url).not.toMatch(/[?&]f_syu=/u);
  });

  it("blank_f_hak variant leaves f_hak blank", () => {
    const url = pick("known_zaobase3", "blank_f_hak").generatedUrl;
    expect(parseRakutenIframeParams(url).fHak).toBe("");
    expect(url).toMatch(/[?&]f_hak=(&|$)/u);
  });

  it("f_hak_1 variant sets f_hak=1", () => {
    expect(parseRakutenIframeParams(pick("known_zaobase3", "f_hak_1").generatedUrl).fHak).toBe("1");
  });

  it("sets f_hizuke=20260615 and preserves identity params", () => {
    const params = parseRakutenIframeParams(pick("known_zaobase3", "f_hak_1").generatedUrl);
    expect(params.fHizuke).toBe("20260615");
    expect(params.fNo).toBe("197787");
    expect(params.fOtonaSu).toBe("2");
    expect(params.fHeyaSu).toBe("1");
    expect(params.tbIframe).toBe("true");
    expect(params.fThick).toBe("1");
  });
});

describe("detectAvailabilityGrid", () => {
  it("detects the vacancy calendar legend / click instruction", () => {
    expect(detectAvailabilityGrid("○：残室 1 以上，×：残室なし")).toBe(true);
    expect(detectAvailabilityGrid("ご希望日の空室数をクリックすると…")).toBe(true);
  });
  it("returns false for a no-matching-room page", () => {
    expect(detectAvailabilityGrid("該当する部屋タイプが見つかりません。")).toBe(false);
  });
});

describe("classifyRakutenMatrixProbe", () => {
  it("classifies matrix_url_failed when unreachable", () => {
    expect(
      classifyRakutenMatrixProbe({
        reachable: false,
        noMatchingRoomType: false,
        availabilityGridDetected: false,
        evidence: evidence()
      })
    ).toBe("matrix_url_failed");
  });
  it("classifies 該当する部屋タイプが見つかりません as matrix_no_matching_room_type", () => {
    expect(
      classifyRakutenMatrixProbe({
        reachable: true,
        noMatchingRoomType: true,
        availabilityGridDetected: false,
        evidence: evidence()
      })
    ).toBe("matrix_no_matching_room_type");
  });
  it("classifies matrix_date_scoped_total_found", () => {
    expect(
      classifyRakutenMatrixProbe({
        reachable: true,
        noMatchingRoomType: false,
        availabilityGridDetected: false,
        evidence: evidence()
      })
    ).toBe("matrix_date_scoped_total_found");
  });
  it("classifies a rendered availability grid (no total) as matrix_basis_unverified", () => {
    expect(
      classifyRakutenMatrixProbe({
        reachable: true,
        noMatchingRoomType: false,
        availabilityGridDetected: true,
        evidence: evidence({
          propertyDetected: false,
          dateScopeDetected: false,
          taxIncludedTotalDetected: false,
          taxIncludedTotalText: "",
          availabilityStatus: "unknown"
        })
      })
    ).toBe("matrix_basis_unverified");
  });
  it("classifies matrix_date_scope_unverified when no grid and no date", () => {
    expect(
      classifyRakutenMatrixProbe({
        reachable: true,
        noMatchingRoomType: false,
        availabilityGridDetected: false,
        evidence: evidence({ dateScopeDetected: false })
      })
    ).toBe("matrix_date_scope_unverified");
  });
});

describe("decideRakutenMatrixFeasibility", () => {
  it("returns rakuten_matrix_ready when a total is found", () => {
    expect(
      decideRakutenMatrixFeasibility(["matrix_no_matching_room_type", "matrix_date_scoped_total_found"])
    ).toBe("rakuten_matrix_ready");
  });
  it("returns rakuten_matrix_basis_mapping_needed with useful evidence", () => {
    expect(decideRakutenMatrixFeasibility(["matrix_basis_unverified"])).toBe(
      "rakuten_matrix_basis_mapping_needed"
    );
  });
  it("returns rakuten_matrix_not_ready when all rows are no-room/no-date/url-failed", () => {
    expect(
      decideRakutenMatrixFeasibility([
        "matrix_no_matching_room_type",
        "matrix_date_scope_unverified",
        "matrix_url_failed"
      ])
    ).toBe("rakuten_matrix_not_ready");
  });
});

describe("renderRakutenMatrixCsv", () => {
  it("emits the fixed header and no PMS/upload/inventory columns", () => {
    const csv = renderRakutenMatrixCsv([row()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_MATRIX_CSV_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(resolve(__dirname, "../src/scripts/probeRakutenIframeMatrix.ts"), "utf-8");
    expect(source).not.toMatch(
      /INSERT INTO rate_snapshots|INSERT INTO inventory_snapshots|INSERT INTO collector_runs/iu
    );
  });
});

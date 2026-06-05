import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRakutenDateScopedPlanUrl,
  buildRakutenHotelPlanUrl,
  extractRakutenHotelNo,
  RAKUTEN_FEASIBILITY_CSV_HEADERS,
  renderRakutenFeasibilityCsv,
  renderRakutenFeasibilityReport,
  type RakutenFeasibilityProbeRow
} from "../src/services/buildRakutenCollectorFeasibility";

const probeRow = (overrides: Partial<RakutenFeasibilityProbeRow> = {}): RakutenFeasibilityProbeRow => ({
  canonicalPropertyName: "ZAO BASE",
  hotelNo: "197787",
  probeDate: "2026-08-10",
  planPageReachable: true,
  dateParamApplied: false,
  dateScopedRateAvailable: false,
  rateBasisObserved: "per_person_guideline_range",
  perRoomTotalExtractable: false,
  soldOutDetectable: false,
  notes: "Static plan page only.",
  ...overrides
});

describe("extractRakutenHotelNo", () => {
  it("extracts the hotelNo from a Rakuten HOTEL URL", () => {
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/197787/")).toBe("197787");
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/5723/")).toBe("5723");
  });

  it("rejects non-Rakuten URLs", () => {
    expect(extractRakutenHotelNo("https://www.jalan.net/yad328232/")).toBeNull();
    expect(extractRakutenHotelNo("https://www.booking.com/hotel/jp/yuilocalzao.ja.html")).toBeNull();
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/abc/")).toBeNull();
  });
});

describe("buildRakutenHotelPlanUrl", () => {
  it("builds the canonical first-party plan URL", () => {
    expect(buildRakutenHotelPlanUrl("197787")).toBe(
      "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/197787"
    );
  });

  it("rejects a non-numeric hotelNo", () => {
    expect(() => buildRakutenHotelPlanUrl("abc")).toThrow(/invalid Rakuten hotelNo/u);
  });
});

describe("buildRakutenDateScopedPlanUrl", () => {
  it("emits the documented check-in/nights/rooms/adults query params", () => {
    const url = buildRakutenDateScopedPlanUrl({
      hotelNo: "197787",
      checkInDate: "2026-08-10",
      nights: 1,
      rooms: 1,
      adults: 2
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/197787"
    );
    expect(parsed.searchParams.get("f_nen1")).toBe("2026");
    expect(parsed.searchParams.get("f_tuki1")).toBe("08");
    expect(parsed.searchParams.get("f_hi1")).toBe("10");
    expect(parsed.searchParams.get("f_hak")).toBe("1");
    expect(parsed.searchParams.get("f_heya_su")).toBe("1");
    expect(parsed.searchParams.get("f_otona_su")).toBe("2");
  });

  it("rejects a malformed check-in date", () => {
    expect(() =>
      buildRakutenDateScopedPlanUrl({
        hotelNo: "197787",
        checkInDate: "2026/08/10",
        nights: 1,
        rooms: 1,
        adults: 2
      })
    ).toThrow(/YYYY-MM-DD/u);
  });

  it("rejects non-positive nights/rooms/adults", () => {
    expect(() =>
      buildRakutenDateScopedPlanUrl({
        hotelNo: "197787",
        checkInDate: "2026-08-10",
        nights: 0,
        rooms: 1,
        adults: 2
      })
    ).toThrow(/nights must be a positive integer/u);
  });
});

describe("renderRakutenFeasibilityCsv", () => {
  it("emits the fixed header and no price/upload/availability/inventory columns", () => {
    const csv = renderRakutenFeasibilityCsv([probeRow()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_FEASIBILITY_CSV_HEADERS.join(","));
    expect(header).not.toMatch(/price|upload|inventory|beds24|airhost|roomid|multiplier/iu);
  });
});

describe("renderRakutenFeasibilityReport", () => {
  it("renders all 12 sections with a valid feasibility decision and no upload/PMS columns", () => {
    const report = renderRakutenFeasibilityReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      validationCsvPath: "a.csv",
      validationReportPath: "a.md",
      csvPath: "b.csv",
      rows: [probeRow()],
      urlPatternsTested: ["https://hotel.travel.rakuten.co.jp/hotelinfo/plan/197787"],
      decision: "manual_probe_needed"
    });
    for (let section = 1; section <= 12; section += 1) {
      expect(report).toContain(`## ${section}.`);
    }
    expect(report).toContain("feasibility_decision=manual_probe_needed");
    expect(report).not.toMatch(/beds24|airhost|pms upload/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(
      resolve(__dirname, "../src/scripts/probeRakutenCollectorFeasibility.ts"),
      "utf-8"
    );
    expect(source).not.toMatch(/rate_snapshots|inventory_snapshots|collector_runs|INSERT INTO/iu);
  });
});

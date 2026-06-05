import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHplanCalendarResponse, type HplanDay } from "../src/services/rakutenCorrectedHplanUrlProbe";
import {
  buildRakutenLimitedCollectorPrototypeSummary,
  buildRakutenPrototypeRequestSummary,
  classifyRakutenPrototypeDay,
  classifyRakutenPrototypeRequest,
  dateIsoFromViewDateAndViewDay,
  decideRakutenLimitedCollectorPrototype,
  mapHplanDayToPrototypeRow,
  RAKUTEN_LIMITED_COLLECTOR_BASIS_CONFIDENCE,
  RAKUTEN_LIMITED_COLLECTOR_SOURCE_PRICE_BASIS,
  renderRakutenLimitedCollectorPrototypeCsv,
  renderRakutenLimitedCollectorPrototypeReport,
  type RakutenPrototypeRequestTarget
} from "../src/services/rakutenLimitedCollectorPrototype";

const target: RakutenPrototypeRequestTarget = {
  propertyName: "蔵王国際ホテル",
  hotelNo: "5723",
  fSyu: "00",
  fCampId: "6468227",
  monthAnchor: "20260601"
};

const positiveJsonp = (): string =>
  `cb(${JSON.stringify({
    viewDate: "2026年06月",
    isEmpty: false,
    isTaxExclusive: false,
    hotelNo: 5723,
    roomCode: "00",
    roomInfoDto: { chargeType: "CHARGE_PER_HUMAN" },
    dayList: [
      {
        viewDay: "3",
        day: 0,
        stock: 2,
        price: 32395,
        priceWithoutTax: 29450,
        discountedPrice: 0,
        link: "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723",
        vacantCondition: "2室",
        monthClass: "thisMonth",
        isPast: false,
        isFull: false,
        isVacant: true
      },
      {
        viewDay: "4",
        day: 0,
        stock: 0,
        price: 0,
        priceWithoutTax: 0,
        discountedPrice: 0,
        link: "",
        vacantCondition: "",
        monthClass: "thisMonth",
        isPast: false,
        isFull: true,
        isVacant: false
      }
    ]
  })});`;

const parsedPositive = () => parseHplanCalendarResponse(positiveJsonp(), 200);

const day = (overrides: Partial<HplanDay> = {}): HplanDay => ({
  viewDay: "3",
  epoch: 0,
  stock: 2,
  price: 32395,
  priceWithoutTax: 29450,
  discountedPrice: 0,
  link: "https://example.test/condition",
  vacantCondition: "2室",
  monthClass: "thisMonth",
  isPast: false,
  isFull: false,
  isVacant: true,
  enabled: true,
  ...overrides
});

describe("date helpers", () => {
  it("computes date_iso from Japanese viewDate and viewDay", () => {
    expect(dateIsoFromViewDateAndViewDay("2026年06月", "3")).toBe("2026-06-03");
    expect(dateIsoFromViewDateAndViewDay("2026年06月", "5/31")).toBe("2026-05-31");
    expect(dateIsoFromViewDateAndViewDay("2026年06月", "7/1")).toBe("2026-07-01");
  });

  it("does not derive date_iso from Rakuten epoch values that can be timezone-shifted", () => {
    const parsed = parsedPositive();
    const row = mapHplanDayToPrototypeRow({
      runId: "run1",
      collectedAtJst: "2026-06-01T12:00:00+09:00",
      target,
      parsed,
      day: { ...parsed.days[0]!, epoch: 1780412400000 },
      debugArtifactPath: ".data/debug/x"
    });
    expect(row.dateIso).toBe("2026-06-03");
  });
});

describe("day row mapping", () => {
  it("maps JSONP dayList rows to conservative prototype rows", () => {
    const parsed = parsedPositive();
    const row = mapHplanDayToPrototypeRow({
      runId: "run1",
      collectedAtJst: "2026-06-01T12:00:00+09:00",
      target,
      parsed,
      day: parsed.days[0]!,
      debugArtifactPath: ".data/debug/x"
    });
    expect(row.dateIso).toBe("2026-06-03");
    expect(row.sourcePriceBasis).toBe(RAKUTEN_LIMITED_COLLECTOR_SOURCE_PRICE_BASIS);
    expect(row.basisConfidence).toBe(RAKUTEN_LIMITED_COLLECTOR_BASIS_CONFIDENCE);
    expect(row.computed2AdultTotal).toBe(64790);
    expect(row.classification).toBe("rakuten_day_available_price_link");
    expect(row.collectorStage).toBe("prototype_read_only");
  });

  it("leaves computed total blank when price is unavailable", () => {
    const parsed = parsedPositive();
    const row = mapHplanDayToPrototypeRow({
      runId: "run1",
      collectedAtJst: "2026-06-01T12:00:00+09:00",
      target,
      parsed,
      day: day({ price: 0 }),
      debugArtifactPath: ".data/debug/x"
    });
    expect(row.computed2AdultTotal).toBeNull();
  });
});

describe("day and request classification", () => {
  it("classifies available day with price and link", () => {
    expect(classifyRakutenPrototypeDay(day())).toBe("rakuten_day_available_price_link");
  });

  it("classifies full and past days", () => {
    expect(classifyRakutenPrototypeDay(day({ isVacant: false, isFull: true, price: 0, link: "" }))).toBe(
      "rakuten_day_full"
    );
    expect(classifyRakutenPrototypeDay(day({ isVacant: false, isPast: true, price: 0, link: "" }))).toBe(
      "rakuten_day_past"
    );
  });

  it("classifies positive request when available price/link rows exist", () => {
    const parsed = parsedPositive();
    const rows = parsed.days.map((d) =>
      mapHplanDayToPrototypeRow({
        runId: "run1",
        collectedAtJst: "2026-06-01T12:00:00+09:00",
        target,
        parsed,
        day: d,
        debugArtifactPath: ".data/debug/x"
      })
    );
    expect(classifyRakutenPrototypeRequest({ httpStatus: 200, parsed, dayRows: rows })).toBe("rakuten_request_positive");
  });
});

describe("decision and renderers", () => {
  const parsed = parsedPositive();
  const rows = parsed.days.map((d) =>
    mapHplanDayToPrototypeRow({
      runId: "run1",
      collectedAtJst: "2026-06-01T12:00:00+09:00",
      target,
      parsed,
      day: d,
      debugArtifactPath: ".data/debug/x"
    })
  );
  const requestSummary = buildRakutenPrototypeRequestSummary({
    target,
    httpStatus: 200,
    parsed,
    dayRows: rows,
    debugArtifactPath: ".data/debug/x"
  });
  const decision = decideRakutenLimitedCollectorPrototype({ requestSummaries: [requestSummary], dayRows: rows });
  const summary = buildRakutenLimitedCollectorPrototypeSummary({
    runId: "run1",
    collectedAtJst: "2026-06-01T12:00:00+09:00",
    requestSummaries: [requestSummary],
    dayRows: rows,
    decision
  });

  it("returns basis_caution, not ready, while total basis confidence remains B", () => {
    expect(decision).toBe("rakuten_limited_collector_prototype_basis_caution");
  });

  it("renders CSV without upload/PMS columns", () => {
    const csv = renderRakutenLimitedCollectorPrototypeCsv(rows);
    const header = csv.split("\n")[0] ?? "";
    for (const forbidden of ["roomid", "inventory", "minstay", "maxstay", "multiplier", "price1", "price2", "price3", "price4", "price5"]) {
      expect(header).not.toContain(forbidden);
    }
    expect(header).toContain("computed_2_adult_total");
  });

  it("renders report with basis caution and without claiming A-confidence total basis", () => {
    const report = renderRakutenLimitedCollectorPrototypeReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      reportPath: ".data/reports/r.md",
      csvPath: ".data/reports/r.csv",
      jsonPath: ".data/reports/r.json",
      debugRootPath: ".data/debug/x",
      targets: [target],
      requestSummaries: [requestSummary],
      dayRows: rows,
      summary
    });
    expect(report).toContain("basis_confidence=B");
    expect(report).toContain("does not claim confirmed 2-adult total basis");
    expect(report).not.toContain("basis_confidence=A");
  });
});

describe("script safety", () => {
  it("does not contain DB insert statements", () => {
    const source = readFileSync(resolve("src/scripts/probeRakutenLimitedCollectorPrototype.ts"), "utf8");
    expect(source).not.toMatch(/INSERT\s+INTO\s+rate_snapshots/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+inventory_snapshots/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+collector_runs/iu);
  });
});

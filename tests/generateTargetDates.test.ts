import { describe, expect, it } from "vitest";
import { generateTargetDates } from "../src/services/generateTargetDates";

const holidays = [
  { date: "2026-07-20", name: "海の日" },
  { date: "2026-08-11", name: "山の日" },
  { date: "2027-01-01", name: "元日" }
];

describe("generateTargetDates", () => {
  it("generates an inclusive date range", () => {
    const dates = generateTargetDates({ from: "2026-06-01", to: "2026-06-03", today: "2026-05-29", holidays });
    expect(dates.map((date) => date.stayDate)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it("assigns S for national holidays", () => {
    expect(one("2026-07-20").priority).toBe("S");
    expect(one("2026-07-20").reason).toBe("national_holiday:海の日");
  });

  it("assigns S for day before national holiday", () => {
    expect(one("2026-07-19").priority).toBe("S");
    expect(one("2026-07-19").reason).toBe("day_before_national_holiday:海の日");
  });

  it("assigns S for Obon peak", () => {
    expect(one("2026-08-08").priority).toBe("S");
    expect(one("2027-08-15").priority).toBe("S");
  });

  it("assigns S for New Year / ski peak", () => {
    expect(one("2026-12-26").priority).toBe("S");
    expect(one("2027-01-03").priority).toBe("S");
  });

  it("assigns S for January and February Saturdays", () => {
    expect(one("2027-01-09").priority).toBe("S");
    expect(one("2027-02-06").priority).toBe("S");
  });

  it("assigns A for high-season Fridays", () => {
    const generated = one("2026-10-09", "2026-05-29");
    expect(generated.priority).toBe("A");
    expect(generated.reason).toBe("summer_autumn_friday");
  });

  it("assigns B for near-term weekdays", () => {
    const generated = one("2026-06-02", "2026-05-29");
    expect(generated.priority).toBe("B");
    expect(generated.reason).toBe("near_term_weekday");
  });

  it("assigns C for low-demand far weekdays", () => {
    const generated = one("2027-05-12", "2026-05-29");
    expect(generated.priority).toBe("C");
    expect(generated.reason).toBe("low_demand_weekday");
  });

  it("uses priority order S over A and B", () => {
    const generated = one("2026-08-14", "2026-05-29");
    expect(generated.priority).toBe("S");
    expect(generated.reason).toBe("obon_peak");
  });
});

function one(date: string, today = "2026-05-29") {
  return generateTargetDates({ from: date, to: date, today, holidays })[0]!;
}

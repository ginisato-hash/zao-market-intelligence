import { describe, expect, it } from "vitest";
import {
  PRIORITY_COMPETITORS,
  getPriorityCompetitorKey,
  isPriorityCompetitorName,
  normalizePriorityCompetitorName
} from "../src/services/priorityCompetitors";

describe("PRICING-CRITICAL01 - priority competitor name matching (§12.1)", () => {
  it("has exactly 3 priority competitors, all critical", () => {
    expect(PRIORITY_COMPETITORS).toHaveLength(3);
    expect(PRIORITY_COMPETITORS.every((c) => c.priority_level === "critical")).toBe(true);
    expect(PRIORITY_COMPETITORS.map((c) => c.canonical_property_key).sort()).toEqual(["hammond", "oakhill", "yoshidaya"]);
  });

  const HAMMOND_VARIANTS = ["HAMMOND", "Hammond", "ハモンド", "ペンションハモンド"];
  for (const v of HAMMOND_VARIANTS) {
    it(`"${v}" -> hammond`, () => {
      expect(getPriorityCompetitorKey(v)).toBe("hammond");
      expect(isPriorityCompetitorName(v)).toBe(true);
      expect(normalizePriorityCompetitorName(v)).toBe("HAMMOND");
    });
  }

  const OAKHILL_VARIANTS = ["OAKHILL", "Oakhill", "オークヒル", "ONSEN & STAY OAKHILL"];
  for (const v of OAKHILL_VARIANTS) {
    it(`"${v}" -> oakhill`, () => {
      expect(getPriorityCompetitorKey(v)).toBe("oakhill");
      expect(normalizePriorityCompetitorName(v)).toBe("ONSEN & STAY OAKHILL");
    });
  }

  const YOSHIDAYA_VARIANTS = ["吉田屋", "吉田や", "よしだや", "Yoshidaya", "Yoshida-ya"];
  for (const v of YOSHIDAYA_VARIANTS) {
    it(`"${v}" -> yoshidaya`, () => {
      expect(getPriorityCompetitorKey(v)).toBe("yoshidaya");
      expect(normalizePriorityCompetitorName(v)).toBe("吉田屋");
    });
  }

  it("unrelated names do not match", () => {
    expect(isPriorityCompetitorName("三浦屋")).toBe(false);
    expect(isPriorityCompetitorName("蔵王国際ホテル")).toBe(false);
    expect(getPriorityCompetitorKey("")).toBeNull();
  });
});

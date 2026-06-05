import { describe, expect, it } from "vitest";
import { parseConservativeJalanPrice } from "../src/collectors/jalanPriceParser";

describe("parseConservativeJalanPrice", () => {
  it("extracts Japanese yen total tax-included patterns", () => {
    expect(parseConservativeJalanPrice("合計 税込12,000円")?.priceJpy).toBe(12000);
    expect(parseConservativeJalanPrice("総額 ¥24,500円")?.priceJpy).toBe(24500);
    expect(parseConservativeJalanPrice("¥18,000 税込")?.priceJpy).toBe(18000);
  });

  it("does not invent price from failed or no-price text", () => {
    expect(parseConservativeJalanPrice("満室のため予約できません")).toBeNull();
    expect(parseConservativeJalanPrice("料金はお問い合わせください")).toBeNull();
    expect(parseConservativeJalanPrice("12,000円")).toBeNull();
  });

  it("skips coupon / discount amounts and picks the real total", () => {
    // Coupon amount appears first after the total label but must be rejected.
    expect(parseConservativeJalanPrice("合計 税込3,000円分クーポン 合計 税込45,000円")?.priceJpy).toBe(45000);
    expect(parseConservativeJalanPrice("総額 税込2,000円割引 総額 税込30,000円")?.priceJpy).toBe(30000);
  });

  it("returns null when the only candidate is a coupon amount", () => {
    expect(parseConservativeJalanPrice("税込3,000円クーポンを獲得")).toBeNull();
  });
});

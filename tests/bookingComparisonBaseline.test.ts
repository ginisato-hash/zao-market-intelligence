import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readComparisonBaseline } from "../src/services/bookingComparisonBaseline";

const blank = { pageTitle: "Hotel", bodyText: "" };
const listing = { pageTitle: "Hotel", bodyText: "public listing ".repeat(32) };

function fixture() {
  const evaluate = vi.fn().mockResolvedValue(listing);
  const input = {
    page: { locator: () => ({ evaluate }) } as unknown as Page,
    target: { canonicalPropertyName: "Hotel", slug: "hotel" },
    checkin: "2027-01-02", checkout: "2027-01-03", finalUrl: "https://example.org/hotel",
    assertSameDocument: vi.fn(async () => {}), guardClear: vi.fn(() => true)
  };
  return { input, evaluate };
}

describe("rendered baseline of a bound comparison revisit", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("keeps the first ordinary listing that renders in the same document within the budget", async () => {
    const { input, evaluate } = fixture();
    const result = readComparisonBaseline(input, blank, performance.now() + 1000);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toEqual({ ...listing, samples: 2, block: null });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(input.assertSameDocument).toHaveBeenCalledTimes(2);
  });

  it("leaves a persistently empty listing empty at the original deadline", async () => {
    const { input, evaluate } = fixture();
    evaluate.mockResolvedValue(blank);
    const result = readComparisonBaseline(input, blank, performance.now() + 800);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ ...blank, samples: 4, block: null });
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it.each(["満室", "ページが見つかりません", "セキュリティチェック", "login", listing.bodyText])(
    "retains a terminal first observation without another read", async bodyText => {
      const { input, evaluate } = fixture();
      const result = await readComparisonBaseline(input, { ...blank, bodyText }, performance.now() + 1000);
      expect(result.bodyText).toBe(bodyText);
      expect(result.block).toBe(["セキュリティチェック", "login"].includes(bodyText) ? "captcha_or_login_wall" : null);
      expect(evaluate).not.toHaveBeenCalled();
    }
  );

  it("stops on an intervening restriction without looking for a later listing", async () => {
    const { input, evaluate } = fixture();
    evaluate.mockResolvedValueOnce({ ...blank, bodyText: "セキュリティチェック" });
    const result = readComparisonBaseline(input, blank, performance.now() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).block).toBe("captcha_or_login_wall");
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("drops a candidate after a document replacement", async () => {
    const { input } = fixture();
    input.assertSameDocument.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("CURRENT_DOCUMENT_CHANGED"));
    const rejection = expect(readComparisonBaseline(input, blank, performance.now() + 1000)).rejects.toThrow("CURRENT_DOCUMENT_CHANGED");
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
  });

  it("ends when the observing guard closes during the wait", async () => {
    const { input, evaluate } = fixture();
    const result = readComparisonBaseline(input, blank, performance.now() + 1000);
    input.guardClear.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(250);
    expect((await result).bodyText).toBe("");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("does not accept a price that only passes its document check after expiry", async () => {
    const { input } = fixture();
    input.assertSameDocument.mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(resolve, 300)));
    const result = readComparisonBaseline(input, blank, performance.now() + 500);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).bodyText).toBe("");
  });
});

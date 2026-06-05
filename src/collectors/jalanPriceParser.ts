export interface ParsedJalanPrice {
  priceJpy: number;
  basis: "total_tax_included";
}

const TAX_INCLUDED_PRICE_PATTERNS = [
  /税込[^\d¥￥]{0,12}[¥￥]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u,
  /[¥￥]\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})[^\n]{0,20}税込/u,
  /合計[^\d¥￥]{0,12}[¥￥]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u,
  /総額[^\d¥￥]{0,12}[¥￥]?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円/u
];

const COUPON_CONTEXT_TOKENS = ["クーポン", "円分", "円引", "円OFF", "円off", "割引", "ポイント", "獲得"];

/**
 * Returns true when the matched price is immediately followed by a coupon /
 * discount / points token (e.g. "3,000円分クーポン", "2,000円割引"), meaning the
 * captured number is a coupon amount rather than a real tax-included total.
 *
 * The window is forward-looking only: these tokens attach after the price digits
 * in Jalan layouts, and a backward window would wrongly catch the coupon token
 * belonging to an adjacent earlier price. Exported so the plan-block extractor
 * reuses one source of truth.
 */
export function isNearCouponToken(text: string, matchIndex: number, matchLength: number): boolean {
  const window = text.slice(matchIndex, matchIndex + matchLength + 12);
  return COUPON_CONTEXT_TOKENS.some((token) => window.includes(token));
}

export function parseConservativeJalanPrice(text: string): ParsedJalanPrice | null {
  for (const pattern of TAX_INCLUDED_PRICE_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(globalPattern)) {
      const rawPrice = match[1];
      if (rawPrice === undefined || match.index === undefined) {
        continue;
      }
      if (isNearCouponToken(text, match.index, match[0].length)) {
        continue;
      }
      return {
        priceJpy: Number(rawPrice.replace(/,/g, "")),
        basis: "total_tax_included"
      };
    }
  }

  return null;
}

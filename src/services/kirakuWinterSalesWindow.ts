// Kiraku winter sales window — single source of truth (pure).
//
// 喜らくの冬季販売期間は 2026-12-20 .. 2027-03-31 (両端含む / 102 泊)。
// 以前は 2026-12-19..2027-03-15 のリテラルが planner / scripts / tests に
// 重複していた。窓の定義はこのモジュールだけに置き、全 production path と
// test はここを参照する。
//
// 一般市況リサーチ (ski_season peak scoring) は従来どおり 12/19 を含めて
// 収集してよい (MARKET_RESEARCH_SKI_SEASON_WINDOW)。Kiraku の冬季販売レーン
// (ACTIVE/WARM) だけが KIRAKU_WINTER_SALES_WINDOW を使う。

export interface DateWindow {
  readonly from: string;
  readonly to: string;
}

export const KIRAKU_WINTER_SALES_WINDOW: DateWindow = { from: "2026-12-20", to: "2027-03-31" };

// 一般市況リサーチのスキー期間: 販売窓の前日 (12/19 Sat) から窓末まで。
// 販売窓から導出し、リテラルを増やさない。
export const MARKET_RESEARCH_SKI_SEASON_WINDOW: DateWindow = {
  from: shiftYmd(KIRAKU_WINTER_SALES_WINDOW.from, -1),
  to: KIRAKU_WINTER_SALES_WINDOW.to
};

function shiftYmd(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function isInWindow(iso: string, window: DateWindow): boolean {
  return iso >= window.from && iso <= window.to;
}

export function isInKirakuWinterSalesWindow(iso: string): boolean {
  return isInWindow(iso, KIRAKU_WINTER_SALES_WINDOW);
}

// 窓内の全泊日 (昇順, 両端含む)。
export function kirakuWinterSalesDates(): string[] {
  const out: string[] = [];
  for (let d = KIRAKU_WINTER_SALES_WINDOW.from; d <= KIRAKU_WINTER_SALES_WINDOW.to; d = shiftYmd(d, 1)) out.push(d);
  return out;
}

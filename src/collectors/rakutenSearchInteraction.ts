import type { Page } from "playwright";

export interface RakutenSearchConditions {
  checkinDate: string;  // "2026/08/08"
  checkoutDate: string; // "2026/08/09"
  adults: number;
  rooms: number;
}

export interface RakutenSearchConditionSetResult {
  checkinSet: boolean;
  checkoutSet: boolean;
  adultsSet: boolean;
  roomsSet: boolean;
  reason?: string;
}

export interface RakutenSearchInteractionResult {
  attempted: boolean;
  success: boolean;
  strategy: "click_visible_search_button" | "fill_conditions_then_click_search" | "not_attempted";
  beforeUrl: string;
  afterUrl?: string;
  errorReason?: string;
  visibleSignals?: string[];
  searchConditions?: RakutenSearchConditionSetResult;
}

// ─── Pure helpers (testable without a browser) ──────────────────────────────

export function isRakutenSearchButtonText(text: string): boolean {
  return text.trim() === "検索";
}

export function isRakutenSearchFormText(text: string): boolean {
  return /合計料金\s*※1部屋あたりの税込金額/u.test(text);
}

export function isRakutenConditionsBlank(text: string): boolean {
  return /日付指定なし/u.test(text);
}

export function extractRakutenPageSignals(text: string): string[] {
  const signals: string[] = [];
  if (/予約する/u.test(text)) signals.push("予約する");
  if (/空室/u.test(text)) signals.push("空室");
  if (/満室/u.test(text)) signals.push("満室");
  if (/プランなし|該当なし|条件に合う.*プラン.*(?:ありません|見つかりません)/u.test(text)) signals.push("no_plans_found");
  if (/合計料金\s*※1部屋あたりの税込金額/u.test(text)) signals.push("overview_form_visible");
  if (/日付指定なし/u.test(text)) signals.push("date_not_set");
  if (/2名合計|合計\s*[\(（]税込[\)）]/u.test(text)) signals.push("total_price_visible");
  return signals;
}

// ─── Playwright interaction ──────────────────────────────────────────────────

export async function performRakutenSearchInteraction(
  page: Page,
  conditions: RakutenSearchConditions,
  timeoutMs = 20_000
): Promise<RakutenSearchInteractionResult> {
  const beforeUrl = page.url();

  try {
    // Step 1: verify search button is present
    const searchButton = page.locator('button:has-text("検索")').first();
    if ((await searchButton.count()) === 0) {
      return {
        attempted: true,
        success: false,
        strategy: "not_attempted",
        beforeUrl,
        errorReason: "rakuten_search_button_not_found"
      };
    }

    // Step 2: check / set search conditions via form inputs (expanded selector set)
    const condResult = await checkAndSetConditions(page, conditions);
    const searchConditions: RakutenSearchConditionSetResult = {
      checkinSet: condResult.checkinSet,
      checkoutSet: condResult.checkoutSet,
      adultsSet: condResult.adultsSet,
      roomsSet: condResult.roomsSet,
      ...(condResult.reason !== undefined ? { reason: condResult.reason } : {})
    };

    // Date fields are required to proceed — without them the search would be undated
    if (!condResult.checkinSet || !condResult.checkoutSet) {
      return {
        attempted: true,
        success: false,
        strategy: "not_attempted",
        beforeUrl,
        errorReason: "rakuten_search_conditions_not_set",
        searchConditions
      };
    }

    const clickStrategy: RakutenSearchInteractionResult["strategy"] =
      condResult.changedAny
        ? "fill_conditions_then_click_search"
        : "click_visible_search_button";

    // Step 3: click search
    await searchButton.click();

    // Step 4: wait for plan results to potentially load (no networkidle — it times out)
    await page.waitForTimeout(8_000);

    const afterUrl = page.url();
    const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
    const visibleSignals = extractRakutenPageSignals(bodyText);

    return {
      attempted: true,
      success: true,
      strategy: clickStrategy,
      beforeUrl,
      afterUrl,
      visibleSignals,
      searchConditions
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      success: false,
      strategy: "not_attempted",
      beforeUrl,
      errorReason: `rakuten_search_interaction_failed: ${msg}`
    };
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface ConditionSetDetail {
  checkinSet: boolean;
  checkoutSet: boolean;
  adultsSet: boolean;
  roomsSet: boolean;
  /** Whether we changed any value (vs all already being correct). */
  changedAny: boolean;
  reason?: string;
}

/**
 * Tries an expanded set of selectors for each search condition.
 * Fires input/change events after any value change.
 * Returns per-field booleans and whether anything was actually changed.
 */
async function checkAndSetConditions(
  page: Page,
  conditions: RakutenSearchConditions
): Promise<ConditionSetDetail> {
  // Build CSS multi-selectors on the Node.js side and pass as strings.
  // This avoids any for...of or Array iteration inside page.evaluate() that
  // tsx/esbuild might transform using helpers (__values, __name, etc.) not
  // available in the browser evaluate context.
  const SEL = {
    checkin:  '[name="f_checkin_date"],[id="f_checkin_date"],input[name*="checkin"],input[id*="checkin"],input[name*="check_in"],input[id*="check_in"],input[type="date"]',
    checkout: '[name="f_checkout_date"],[id="f_checkout_date"],input[name*="checkout"],input[id*="checkout"],input[name*="check_out"],input[id*="check_out"]',
    adults:   'select[name="f_adult_num"],select[id="f_adult_num"],input[name="f_adult_num"],select[name*="adult"],select[id*="adult"]',
    rooms:    'select[name="f_room_num"],select[id="f_room_num"],select[name*="room"],select[id*="room"]'
  };

  const raw = await page.evaluate(
    (args: { checkin: string; checkout: string; adults: number; rooms: number;
             selCheckin: string; selCheckout: string; selAdults: string; selRooms: string }) => {
      // Avoid named arrow-function assignments — esbuild/tsx injects __name() for them
      // which is not available in the browser evaluate context.
      // All logic is inlined; only plain variable/const declarations are used.
      let changedAny = false;

      let _el: HTMLInputElement | HTMLSelectElement | null;

      _el = document.querySelector<HTMLInputElement | HTMLSelectElement>(args.selCheckin);
      const checkinSet = _el !== null;
      if (_el !== null && _el.value !== args.checkin) {
        _el.value = args.checkin;
        _el.dispatchEvent(new Event("input", { bubbles: true }));
        _el.dispatchEvent(new Event("change", { bubbles: true }));
        changedAny = true;
      }

      _el = document.querySelector<HTMLInputElement | HTMLSelectElement>(args.selCheckout);
      const checkoutSet = _el !== null;
      if (_el !== null && _el.value !== args.checkout) {
        _el.value = args.checkout;
        _el.dispatchEvent(new Event("input", { bubbles: true }));
        _el.dispatchEvent(new Event("change", { bubbles: true }));
        changedAny = true;
      }

      _el = document.querySelector<HTMLInputElement | HTMLSelectElement>(args.selAdults);
      const adultsSet = _el !== null;
      if (_el !== null && _el.value !== String(args.adults)) {
        _el.value = String(args.adults);
        _el.dispatchEvent(new Event("input", { bubbles: true }));
        _el.dispatchEvent(new Event("change", { bubbles: true }));
        changedAny = true;
      }

      _el = document.querySelector<HTMLInputElement | HTMLSelectElement>(args.selRooms);
      const roomsSet = _el !== null;
      if (_el !== null && _el.value !== String(args.rooms)) {
        _el.value = String(args.rooms);
        _el.dispatchEvent(new Event("input", { bubbles: true }));
        _el.dispatchEvent(new Event("change", { bubbles: true }));
        changedAny = true;
      }

      return { checkinSet, checkoutSet, adultsSet, roomsSet, changedAny };
    },
    {
      checkin:     conditions.checkinDate,
      checkout:    conditions.checkoutDate,
      adults:      conditions.adults,
      rooms:       conditions.rooms,
      selCheckin:  SEL.checkin,
      selCheckout: SEL.checkout,
      selAdults:   SEL.adults,
      selRooms:    SEL.rooms
    }
  ) as { checkinSet: boolean; checkoutSet: boolean; adultsSet: boolean; roomsSet: boolean; changedAny: boolean };

  // Produce a human-readable reason for why dates couldn't be set
  const reason =
    !raw.checkinSet && !raw.checkoutSet
      ? "date_inputs_not_found"
      : !raw.checkinSet
        ? "checkin_input_not_found"
        : !raw.checkoutSet
          ? "checkout_input_not_found"
          : undefined;

  return {
    ...raw,
    ...(reason !== undefined ? { reason } : {})
  };
}

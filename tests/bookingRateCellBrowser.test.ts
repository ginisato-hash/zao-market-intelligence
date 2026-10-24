import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { captureBookingRateCells, deriveBookingRateCell } from '../src/services/bookingRateCellEvidence';
import { BookingUiBlockGuard } from '../src/services/bookingUiBlockGuard';

// Entirely synthetic browser pages; all requests are intercepted locally.
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
const blockId = '1655515709_445461931_2_0_0', control = `policyModal_${blockId}`;
const url = 'https://www.booking.com/hotel/jp/xi-raku.ja.html?checkin=2027-01-03&checkout=2027-01-04&group_adults=2&group_children=0&no_rooms=1&selected_currency=JPY';
const label = '食事およびキャンセルポリシーと前払いポリシーに関する詳細';
const input = { propertySlug: 'xi-raku', checkin: '2027-01-03', checkout: '2027-01-04', observedAt: '2026-10-24T19:00:00Z' };
async function fixture(mode: 'normal' | 'other-container' | 'date-challenge' | 'policy-challenge' = 'normal') {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>Room prices</title></head><body>
  <div id="hp_availability_style_changes"><button data-testid="searchbox-dates-container" aria-expanded="false" onclick="document.documentElement.dataset.dateClicks=1+Number(document.documentElement.dataset.dateClicks||0);${mode === 'date-challenge' ? "document.body.textContent='Security check: are you human';" : "this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='false'?'true':'false');document.getElementById('dates').hidden=this.getAttribute('aria-expanded')==='false';"}">Dates</button>
  <button aria-label="宿泊人数と部屋数。選択済みの内容：大人2名 · 子供0名 · 1部屋">Party</button></div>
  <div id="dates" hidden><div role="gridcell" aria-selected="true"><span data-date="2027-01-03" aria-label="2027年1月3日 チェックイン日">3</span></div><div role="gridcell" aria-selected="true"><span data-date="2027-01-04" aria-label="2027年1月4日 チェックアウト日">4</span></div></div>
  <table id="hprt-table"><tr data-block-id="${blockId}"><th><a id="room_type_id_1655515709">Test room</a>16m²</th><td class="hprt-table-cell-occupancy">人数: 2</td><td class="hprt-table-cell-price">￥50,000 税・手数料込</td><td class="hprt-table-cell-conditions"><button aria-controls="${control}" aria-label="${label}" onclick="document.documentElement.dataset.policyClicks=1+Number(document.documentElement.dataset.policyClicks||0);${mode === 'policy-challenge' ? "document.body.textContent='Security check: CAPTCHA';" : `document.getElementById('overlay').hidden=false;`}">Details</button></td><td><select><option value="0">0</option><option value="1">1 (￥50,000)</option></select></td></tr></table>
  <template id="${control}">Hidden wrong terms</template>
  <div id="overlay" hidden><div id="${mode === 'other-container' ? 'policyModal_OTHER' : control}"><section role="dialog" aria-label="${label}"><button onclick="document.getElementById('overlay').hidden=true">閉じる</button>お食事は含まれておりません。キャンセル無料</section></div></div>
  </body></html>` }));
  await page.goto(url);
  return page;
}

it('binds the actual visible controlled ancestor despite the same-ID hidden template', async () => {
  const page = await fixture();
  try {
    const cap = await captureBookingRateCells(page, input, 1);
    expect(cap.blockReason).toBeNull(); expect(cap.cells).toHaveLength(1);
    expect(cap.cells[0]?.policyContainerId).toBe(control);
    expect(deriveBookingRateCell(cap, cap.cells[0]!).tupleAndProductBound).toBe(true);
    expect(await page.locator('#overlay').isVisible()).toBe(false);
    expect(await page.locator('select').inputValue()).toBe('0');
  } finally { await page.close(); }
});

it('rejects a same-name dialog opened in another container', async () => {
  const page = await fixture('other-container');
  try {
    const cap = await captureBookingRateCells(page, input, 1);
    expect(cap.cells).toHaveLength(1); expect(cap.cells[0]?.policyText).toBeNull();
    expect(deriveBookingRateCell(cap, cap.cells[0]!).tupleAndProductBound).toBe(false);
  } finally { await page.close(); }
});

for (const phase of ['date-challenge', 'policy-challenge'] as const) it(`stops interactions at a ${phase} and exposes a sticky backoff reason`, async () => {
  const page = await fixture(phase);
  try {
    const cap = await captureBookingRateCells(page, input, 1);
    expect(cap.blockReason).toBe('captcha_or_login_wall'); expect(cap.cells).toEqual([]);
    expect(cap.problems).toContain('UI_BLOCKED_OR_UNVERIFIED');
    const actions=await page.locator('html').evaluate(e=>({dates:Number(e.getAttribute('data-date-clicks')??0),policies:Number(e.getAttribute('data-policy-clicks')??0)}));
    expect(actions).toEqual(phase==='date-challenge'?{dates:1,policies:0}:{dates:2,policies:1});
  } finally { await page.close(); }
});

for (const status of [403, 429]) it(`retains HTTP ${status} even if the visible page is unchanged`, async () => {
  const page = await fixture();
  const guard = new BookingUiBlockGuard(page);
  try {
    await page.route('**/policy-response', route => route.fulfill({ status, body: 'blocked' }));
    await page.evaluate(async () => { await fetch('/policy-response'); });
    expect(await guard.checkpoint()).toBe(false);
    expect(guard.reason).toBe(status === 429 ? 'rate_limited_429' : 'forbidden_403');
  } finally { guard.dispose(); await page.close(); }
});

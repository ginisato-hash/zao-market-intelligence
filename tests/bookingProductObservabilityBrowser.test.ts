import {productFactsFixtureHtml} from './fixtures/bookingProductFactsPage';
// Synthetic DOM only. All HTTP requests are fulfilled by local HTML in a fresh owned browser context.
import {beforeAll,afterAll,it,expect,vi} from 'vitest';import {chromium,type Browser,type Locator} from 'playwright';
import {createAnonymousBookingCaptureContext,readBookingProductFacts} from '../src/services/bookingProductObservability';
import {BookingUiBlockGuard} from '../src/services/bookingUiBlockGuard';
import {captureBookingRateCells,deriveBookingRateCell} from '../src/services/bookingRateCellEvidence';
let browser:Browser;beforeAll(async()=>{browser=await chromium.launch({headless:true});});afterAll(async()=>{await browser?.close();});
const block='123_456_2_0_0',date='2027-01-15',url=`https://www.booking.com/hotel/jp/external.ja.html?checkin=${date}&checkout=2027-01-16&group_adults=2&group_children=0&no_rooms=1&selected_currency=JPY`;
async function fixture(mode:'normal'|'wrong-room'|'wrong-tax'|'challenge'|'member'|'unbound-context'|'other-policy-fail'='normal'){
 const context=mode==='unbound-context'?await browser.newContext():await createAnonymousBookingCaptureContext(browser,'synthetic-agent'),page=await context.newPage();let requests=0;
 await page.route('**/*',route=>{requests++;return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:productFactsFixtureHtml(mode)});});await page.goto(url);return {context,page,requests:()=>requests};
}
async function capture(f:Awaited<ReturnType<typeof fixture>>,guard?:BookingUiBlockGuard){return captureBookingRateCells(f.page,{propertySlug:'external',checkin:date,checkout:'2027-01-16',observedAt:'2026-10-30T00:00:00Z'},3,guard);}
it('v4 proves explicit passive dates without clicking a datepicker capable of POST',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);
 try{await f.page.locator('[data-testid="searchbox-dates-container"]').evaluate(e=>e.setAttribute('onclick',"document.documentElement.dataset.dateClicks='1';void fetch('/datepicker-post',{method:'POST',body:'synthetic'}).catch(()=>{});"));
  const cap=await capture(f,guard);expect(cap.cells).toHaveLength(1);expect(cap.displayedCheckin).toBe(date);expect(deriveBookingRateCell(cap,cap.cells[0]! ).tupleAndProductBound).toBe(true);
  expect(await f.page.locator('html').getAttribute('data-date-clicks')).toBeNull();expect(guard.informationRequestRefused).toBe(false);expect(f.requests()).toBe(1);
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
async function typedDates(f:Awaited<ReturnType<typeof fixture>>){await f.page.locator('[data-testid="searchbox-dates-container"]').evaluate(e=>{e.removeAttribute('aria-label');e.innerHTML='<span data-testid="date-display-field-start" aria-label="チェックイン日：2027年1月15日金曜日">1月15日(金)</span> — <span data-testid="date-display-field-end" aria-label="チェックアウト日：2027年1月16日土曜日">1月16日(土)</span>';e.setAttribute('onclick',"document.documentElement.dataset.dateClicks='1';void fetch('/date-post',{method:'POST',body:'synthetic'}).catch(()=>{});");});}
async function extraDates(f:Awaited<ReturnType<typeof fixture>>,kind:string){await typedDates(f);await f.page.getByTestId('searchbox-dates-container').evaluate((e,mode)=>{
 const fields=Array.from(e.querySelectorAll('[data-testid^="date-display-field-"]'));
 fields.forEach((field,i)=>{field.removeAttribute('aria-label');const iso=i===0?'2027-01-15':'2027-01-16',text=i===0?'1月15日(金)':'1月16日(土)';
  if(mode==='title'||mode==='opacity-field-title'||mode==='aria-hidden-field-title'){field.setAttribute('title',iso);
   if(mode==='opacity-field-title')(field as HTMLElement).style.opacity='0';if(mode==='aria-hidden-field-title'){const wrapper=document.createElement('span');wrapper.setAttribute('aria-hidden','true');field.before(wrapper);wrapper.append(field);}}
  else if(mode==='semantic-self'){const t=document.createElement('time');t.setAttribute('data-testid',field.getAttribute('data-testid')!);t.setAttribute('datetime',iso);t.textContent=text;field.replaceWith(t);}
  else if(mode==='hidden-state'){field.innerHTML=text+'<input type="hidden" value="'+iso+'">';}
  else if(mode==='generic-data'){field.setAttribute('data-date',iso);}
  else{field.innerHTML='<time datetime="'+(mode==='timestamp'?iso+'T00:00:00Z':iso)+'">'+text+'</time>';const time=field.querySelector('time')!;
   if(mode==='hidden-time')time.setAttribute('hidden','');if(mode==='opacity-time')(time as HTMLElement).style.opacity='0';if(mode==='duplicate-time')time.after(time.cloneNode(true));if(mode==='outside-time'){document.body.append(time);field.textContent=text;}
  }
 });
 },kind);}
for(const kind of ['title','semantic','semantic-self'])it('v4 uses role-bound '+kind+' explicit years without calendar/network actions',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{await extraDates(f,kind);const cap=await capture(f,guard);expect(cap.cells).toHaveLength(1);expect(cap.displayedCheckin).toBe(date);expect(cap.displayedCheckout).toBe('2027-01-16');expect(await f.page.locator('html').getAttribute('data-date-clicks')).toBeNull();expect(f.requests()).toBe(1);expect(guard.informationRequestRefused).toBe(false);
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
for(const kind of ['hidden-time','opacity-time','duplicate-time','outside-time','hidden-state','generic-data','timestamp','opacity-field-title','aria-hidden-field-title'])it('v4 refuses '+kind+' as a selected-year witness',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page),arm=vi.spyOn(guard,'armReadOnlyInformation');try{await extraDates(f,kind);const cap=await capture(f,guard);expect(cap.cells).toEqual([]);expect(arm).not.toHaveBeenCalled();expect(f.requests()).toBe(1);expect(guard.informationRequestRefused).toBe(false);
 }finally{arm.mockRestore();await f.page.close();guard.dispose();await f.context.close();}
});
for(const kind of ['title','semantic'])it('v4 rejects '+kind+' year changing during information capture',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{await extraDates(f,kind);await f.page.locator('#room_type_id_123').evaluate((e,mode)=>e.setAttribute('onclick',e.getAttribute('onclick')+(mode==='title'?";document.querySelector('[data-testid=\"date-display-field-start\"]').setAttribute('title','2028-01-15');":";document.querySelector('[data-testid=\"date-display-field-start\"] time').setAttribute('datetime','2028-01-15');")),kind);const cap=await capture(f,guard);expect(cap.cells).toEqual([]);expect(f.requests()).toBe(1);
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
it('v4 reads explicit years from visible same-control typed fields without opening the calendar',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{await typedDates(f);const cap=await capture(f,guard);expect(cap.cells).toHaveLength(1);expect(cap.displayedCheckin).toBe(date);expect(cap.displayedCheckout).toBe('2027-01-16');expect(await f.page.locator('html').getAttribute('data-date-clicks')).toBeNull();expect(f.requests()).toBe(1);expect(guard.informationRequestRefused).toBe(false);
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
for(const mode of ['hidden','duplicate','outside-control','one-year-missing','conflict']as const)it('typed field '+mode+' cannot prove the stay or trigger information interactions',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page),arm=vi.spyOn(guard,'armReadOnlyInformation');try{await typedDates(f);const start=f.page.getByTestId('date-display-field-start');
  if(mode==='hidden')await start.evaluate(e=>(e as HTMLElement).style.display='none');if(mode==='duplicate')await start.evaluate(e=>e.after(e.cloneNode(true)));if(mode==='outside-control')await start.evaluate(e=>document.body.append(e));
  if(mode==='one-year-missing')await start.evaluate(e=>e.setAttribute('aria-label','1月15日(金)'));if(mode==='conflict')await start.evaluate(e=>e.setAttribute('aria-label','2027年1月14日木曜日'));
  const cap=await capture(f,guard);expect(cap.cells).toEqual([]);expect(arm).not.toHaveBeenCalled();expect(f.requests()).toBe(1);expect(guard.informationRequestRefused).toBe(false);
  if(mode==='duplicate'||mode==='outside-control')expect(cap.problems).toContain('PASSIVE_TYPED_DATE_FIELDS_ABSENT_OR_NOT_UNIQUE_NO_INTERACTION');
  if(mode==='conflict'){expect(cap.problems).toContain('PASSIVE_OUTER_DATE_NO_YEAR_TOKENS_NO_INTERACTION');expect(cap.problems).toContain('PASSIVE_DATE_LABEL_CONFLICT_OR_INVALID_NO_INTERACTION');expect(cap.problems).not.toContain('PASSIVE_DATE_EXPLICIT_YEAR_MISSING_NO_INTERACTION');}
 }finally{arm.mockRestore();await f.page.close();guard.dispose();await f.context.close();}
});
for(const conflict of [false,true])it('an explicit parent range '+(conflict?'refuses conflicting':'confirms partial')+' typed descendant labels',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{await typedDates(f);await f.page.locator('[data-testid="searchbox-dates-container"]').evaluate(e=>e.setAttribute('aria-label','2027年1月15日(金) — 2027年1月16日(土)'));
  await f.page.getByTestId('date-display-field-start').evaluate((e,bad)=>e.setAttribute('aria-label',bad?'2028年1月15日':'1月15日(金)'),conflict);
  await f.page.getByTestId('date-display-field-end').evaluate(e=>e.setAttribute('aria-label','1月16日(土)'));
  const cap=await capture(f,guard);expect(cap.cells).toHaveLength(conflict?0:1);expect(f.requests()).toBe(1);
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
it('a typed field changing after an information click invalidates the capture',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{await typedDates(f);await f.page.locator('#room_type_id_123').evaluate(e=>e.setAttribute('onclick',e.getAttribute('onclick')+";document.querySelector('[data-testid=\\\"date-display-field-start\\\"]').setAttribute('aria-label','2027年1月14日木曜日');"));
  const cap=await capture(f,guard);expect(cap.cells).toEqual([]);expect(await f.page.getByTestId('date-display-field-start').getAttribute('aria-label')).toBe('2027年1月14日木曜日');expect(f.requests()).toBe(1);
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
for(const mode of ['missing-year','conflicting-label','hidden-control','ambiguous-party','negated-party','alternative-party','conditional-party']as const)it('v4 '+mode+' remains empty without information interaction or global denial',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page),arm=vi.spyOn(guard,'armReadOnlyInformation');
 try{
  const dateControl=f.page.locator('[data-testid="searchbox-dates-container"]');
  if(mode==='missing-year')await dateControl.evaluate(e=>{e.setAttribute('aria-label','1月15日(金) — 1月16日(土)');});
  if(mode==='conflicting-label')await dateControl.evaluate(e=>{e.textContent='2027年1月14日(木) — 2027年1月15日(金)';});
  if(mode==='hidden-control')await dateControl.evaluate(e=>(e as HTMLElement).style.display='none');
  if(mode==='ambiguous-party')await f.page.getByRole('button',{name:/宿泊人数と部屋数/}).evaluate(e=>e.setAttribute('aria-label','宿泊人数と部屋数。大人2名 子供0名 1部屋 または 大人3名'));
  if(mode==='negated-party')await f.page.getByRole('button',{name:/宿泊人数と部屋数/}).evaluate(e=>e.setAttribute('aria-label','宿泊人数と部屋数。大人2名 子供0名 1部屋ではありません'));
  if(mode==='alternative-party')await f.page.getByRole('button',{name:/宿泊人数と部屋数/}).evaluate(e=>e.setAttribute('aria-label','宿泊人数と部屋数。大人2名 子供0名 1部屋 または3名'));
  if(mode==='conditional-party')await f.page.getByRole('button',{name:/宿泊人数と部屋数/}).evaluate(e=>e.setAttribute('aria-label','宿泊人数と部屋数。大人2名 子供0名 1部屋の場合'));
  const cap=await capture(f,guard);expect(cap.cells).toEqual([]);expect(cap.problems).toContain('PASSIVE_STAY_HEADER_UNPROVEN_NO_INTERACTION');expect(arm).not.toHaveBeenCalled();
  const denial=mode==='missing-year'?'PASSIVE_DATE_EXPLICIT_YEAR_MISSING':mode==='conflicting-label'?'PASSIVE_DATE_LABEL_CONFLICT_OR_INVALID':mode==='hidden-control'?'PASSIVE_DATE_CONTROL_NOT_VISIBLE':'PASSIVE_PARTY_LABEL_UNPROVEN';
  expect(cap.problems).toContain(denial+'_NO_INTERACTION');
  expect(guard.informationRequestRefused).toBe(false);expect(guard.stateVerified).toBe(true);expect(f.requests()).toBe(1);expect(await f.page.locator('html').getAttribute('data-room-clicks')).toBeNull();
 }finally{arm.mockRestore();await f.page.close();guard.dispose();await f.context.close();}
});
for(const expanded of [null,'true','unknown']as const)it('v4 records a closed denial for date aria-expanded='+String(expanded)+' without exporting the header',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page),arm=vi.spyOn(guard,'armReadOnlyInformation');
 try{await f.page.locator('[data-testid="searchbox-dates-container"]').evaluate((e,value)=>{if(value===null)e.removeAttribute('aria-expanded');else e.setAttribute('aria-expanded',value);},expanded);
  const cap=await capture(f,guard);expect(cap.cells).toEqual([]);expect(cap.problems).toContain('PASSIVE_DATE_CONTROL_NOT_CLOSED_NO_INTERACTION');expect(arm).not.toHaveBeenCalled();
  expect(cap.displayedCheckin).toBeNull();expect(cap.displayedParty).toBe('');expect(f.requests()).toBe(1);expect(guard.stateVerified).toBe(true);
 }finally{arm.mockRestore();await f.page.close();guard.dispose();await f.context.close();}
});
for(const target of ['date','party']as const)it('v4 rejects '+target+' control becoming hidden during information capture',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{
  await f.page.locator('#room_type_id_123').evaluate((e,t)=>e.setAttribute('onclick',e.getAttribute('onclick')+`;document.querySelector('${t==='date'?'[data-testid="searchbox-dates-container"]':'#hp_availability_style_changes button[aria-label*="宿泊人数"]'}').style.display='none';`),target);
  const cap=await capture(f,guard);expect(cap.cells).toEqual([]);expect(cap.problems).toContain('CAPTURE_UNVERIFIED');expect(guard.informationRequestRefused).toBe(false);
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
it('v4 normalizes explicit fullwidth party digits without inferring missing counts',async()=>{
 const f=await fixture();try{await f.page.getByRole('button',{name:/宿泊人数と部屋数/}).evaluate(e=>e.setAttribute('aria-label','宿泊人数と部屋数。大人２名 子供０名 １部屋'));
  const cap=await capture(f);expect(cap.cells).toHaveLength(1);expect(deriveBookingRateCell(cap,cap.cells[0]!).tupleAndProductBound).toBe(true);
 }finally{await f.context.close();}
});
it('captures positive controlled facts without any quantity selection, login, additional navigation or network',async()=>{const f=await fixture();try{const cap=await capture(f);expect(cap.problems,JSON.stringify(cap)).toEqual([]);expect(cap.parserVersion).toBe('booking-rate-cell-v4');expect(cap.cells).toHaveLength(1);const d=deriveBookingRateCell(cap,cap.cells[0]!);expect(d.tupleAndProductBound).toBe(true);expect(readBookingProductFacts(cap,cap.cells[0]!,d)).toMatchObject({maximumAdults:2,publicPriceProved:true,allMandatoryText:'すべての税金と料金が含まれています。'});expect(await f.page.locator('select').inputValue()).toBe('0');expect(await f.page.locator('[role="dialog"]:visible').count()).toBe(0);expect(f.page.url()).toBe(url);expect(f.requests()).toBe(1);}finally{await f.context.close();}});
it('a page without exact rate rows never arms information controls and retains an explicit missing-row reason',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page),arm=vi.spyOn(guard,'armReadOnlyInformation');
 try{await f.page.locator('#hprt-table').evaluate(e=>e.remove());const cap=await capture(f,guard);
  expect(arm).not.toHaveBeenCalled();expect(cap.cells).toHaveLength(0);expect(cap.problems).toContain('NO_RATE_TABLE_NO_INTERACTION');
  expect(cap.problems).toContain('CAPTURE_STAGE_PAGE_PRECHECK');expect(guard.stateVerified).toBe(true);expect(guard.informationRequestRefused).toBe(false);
  expect(await f.page.locator('[data-testid="searchbox-dates-container"]').getAttribute('aria-expanded')).toBe('false');expect(f.requests()).toBe(1);
 }finally{arm.mockRestore();await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
for(const mode of ['wrong-room','wrong-tax','challenge']as const)it(`stops without policy or reservation interaction after ${mode}`,async()=>{const f=await fixture(mode);try{const cap=await capture(f);expect(cap.cells).toHaveLength(0);expect(await f.page.evaluate(()=>document.documentElement.dataset.policyClicks??null)).toBeNull();expect(f.requests()).toBe(1);}finally{await f.context.close();}},15000);
it('member rates cannot become public merely because a fresh guest context observed them',async()=>{const f=await fixture('member');try{const cap=await capture(f),d=deriveBookingRateCell(cap,cap.cells[0]!);expect(readBookingProductFacts(cap,cap.cells[0]!,d).publicPriceProved).toBe(false);}finally{await f.context.close();}});
it('an unbranded caller context stays legacy with no new room or tax interaction',async()=>{const f=await fixture('unbound-context');try{const cap=await capture(f);expect(cap.parserVersion).toBe('booking-rate-cell-v3');expect(await f.page.evaluate(()=>document.documentElement.dataset.roomClicks??null)).toBeNull();expect(await f.page.evaluate(()=>document.documentElement.dataset.taxClicks??null)).toBeNull();}finally{await f.context.close();}});
it('v4 records another row failure locally while preserving the first row proof',async()=>{const f=await fixture('other-policy-fail');try{const cap=await capture(f);expect(cap.problems,JSON.stringify(cap)).toEqual([]);expect(cap.cells[1]!.rowProblems).toContain('RATE_POLICY_UNVERIFIED');expect(deriveBookingRateCell(cap,cap.cells[0]!).tupleAndProductBound).toBe(true);expect(deriveBookingRateCell(cap,cap.cells[1]!).tupleAndProductBound).toBe(false);}finally{await f.context.close();}});
it('a room anchor referring to a different room or a reservation URL is never clicked',async()=>{const f=await fixture();try{await f.page.locator('#room_type_id_123').evaluate(e=>{e.setAttribute('aria-controls','RD999');e.setAttribute('href','/reserve');});const cap=await capture(f);expect(cap.cells[0]?.productFacts?.roomCapacity).toBeNull();expect(await f.page.evaluate(()=>document.documentElement.dataset.roomClicks??null)).toBeNull();expect(f.requests()).toBe(1);}finally{await f.context.close();}});
it('unexpected document navigation is refused before it reaches the fixture server',async()=>{const f=await fixture();try{await f.page.locator('#room_type_id_123').evaluate(e=>e.setAttribute('onclick',"event.preventDefault();location.href='/reserve';"));const cap=await capture(f);expect(cap.cells).toHaveLength(0);expect(cap.problems).toContain('UNEXPECTED_INFORMATION_REQUEST_REFUSED');expect(f.requests()).toBe(1);}finally{await f.context.close();}});
it('an opened wrong policy dialog stops the whole capture instead of contaminating a later row',async()=>{const f=await fixture('other-policy-fail');try{await f.page.locator(`[aria-controls='policyModal_${block}']`).evaluate(e=>e.setAttribute('onclick',"document.getElementById('OTHER').hidden=false;document.documentElement.dataset.policyClicks=1"));const cap=await capture(f);expect(cap.cells).toHaveLength(0);expect(cap.problems).toContain('CAPTURE_UNVERIFIED');expect(f.requests()).toBe(1);}finally{await f.context.close();}},15000);
for(const text of ['09012345678','+819012345678','０９０（１２３４）５６７８','+1 415 555 2671','name@example.test','https://example.test/private','api_key=synthetic','Bearer synthetic','cookie=synthetic'])it(`sensitive tax text is not copied (${text.split(/[=:]/)[0]})`,async()=>{
 const f=await fixture();try{await f.page.locator('#tax123').evaluate((e,s)=>{e.firstChild!.textContent='すべての税金と料金が含まれています。'+s;},text);const cap=await capture(f);expect(cap.cells[0]?.productFacts?.taxTotal).toBeNull();expect(JSON.stringify(cap)).not.toContain(text);expect(f.requests()).toBe(1);}finally{await f.context.close();}
});

for(const phase of ['room','tax','policy']as const)it(`a click error after its UI effect fails closed for ${phase}`,async()=>{
 const f=await fixture('other-policy-fail'),proto=Object.getPrototypeOf(f.page.locator('button')),actual=proto.click;
 const expected=phase==='room'?'RD123':phase==='tax'?'tax123':'policyModal_'+block;
 const spy=vi.spyOn(proto,'click').mockImplementation(async function(this:unknown,...args:unknown[]){const locator=this as Locator,control=await locator.getAttribute('aria-controls');await actual.call(locator,args[0] as Parameters<Locator['click']>[0]);if(control===expected)throw Error('SYNTHETIC_AFTER_CLICK_EFFECT');});
 try{const cap=await capture(f);expect(cap.cells).toHaveLength(0);if(phase==='room')expect(await f.page.evaluate(()=>document.documentElement.dataset.taxClicks??null)).toBeNull();if(phase!=='policy')expect(await f.page.evaluate(()=>document.documentElement.dataset.policyClicks??null)).toBeNull();expect(f.requests()).toBe(1);}finally{spy.mockRestore();await f.context.close();}
},15000);
for(const phase of ['room','tax','policy']as const)it(`a missing close control after opening ${phase} stops later interactions`,async()=>{
 const f=await fixture('other-policy-fail');try{const id=phase==='room'?'RD123':phase==='tax'?'tax123':'policyModal_'+block;await f.page.locator('[id="'+id+'"]').locator('button').evaluate(e=>e.remove());const cap=await capture(f);expect(cap.cells).toHaveLength(0);if(phase==='room')expect(await f.page.evaluate(()=>document.documentElement.dataset.taxClicks??null)).toBeNull();if(phase!=='policy')expect(await f.page.evaluate(()=>document.documentElement.dataset.policyClicks??null)).toBeNull();expect(f.requests()).toBe(1);}finally{await f.context.close();}
},15000);

it('information controls cannot silently change the selected price before evidence is published',async()=>{
 const f=await fixture();try{await f.page.locator(`[aria-controls='policyModal_${block}']`).evaluate(e=>e.setAttribute('onclick',e.getAttribute('onclick')+";document.querySelector('.prco-wrapper').textContent='￥99,000'"));const cap=await capture(f);expect(cap.cells).toHaveLength(0);expect(f.requests()).toBe(1);}finally{await f.context.close();}
});

for(const fault of ['member-label','tax-label','party','room-name','occupancy','hidden-row','logged-in']as const)it(`same numerical price does not hide changed material conditions: ${fault}`,async()=>{
 const f=await fixture();try{const js=fault==='member-label'?"document.querySelector('.hprt-table-cell-price').append(' Genius 会員限定料金')":fault==='tax-label'?"document.querySelector('.hprt-table-cell-price').append(' 別途サービス料500円')":fault==='party'?"document.querySelector('[aria-label^=宿泊人数]').setAttribute('aria-label','宿泊人数と部屋数。大人3名 子供0名 1部屋')":fault==='room-name'?"document.getElementById('room_type_id_123').textContent='別の客室'":fault==='occupancy'?"document.querySelector('.hprt-table-cell-occupancy').textContent='人数: 3'":fault==='hidden-row'?"document.querySelector('#hprt-table tr').hidden=true":"document.querySelector('header').hidden=true";
 await f.page.locator(`[aria-controls='policyModal_${block}']`).evaluate((e,s)=>e.setAttribute('onclick',e.getAttribute('onclick')+';'+s),js);const cap=await capture(f);expect(cap.cells).toHaveLength(0);expect(f.requests()).toBe(1);}finally{await f.context.close();}
});
it('a delayed document navigation after capture remains blocked through screenshot/page close',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{await f.page.evaluate(()=>{(window as unknown as {release:()=>void}).release=()=>{location.href='/late-navigation';};});const cap=await capture(f,guard);expect(cap.cells).toHaveLength(1);
 const request=f.context.waitForEvent('request',r=>r.isNavigationRequest()&&r.url().includes('/late-navigation'));await f.page.evaluate(()=>(window as unknown as {release:()=>void}).release());await request;await f.page.close();await guard.finishReadOnlyInformation();expect(guard.informationRequestRefused).toBe(true);expect(guard.stateVerified).toBe(false);expect(f.requests()).toBe(1);
 }finally{guard.dispose();await f.context.close();}
});
it('an initial popup navigation cannot escape the page-owned information guard',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{const cap=await capture(f,guard);expect(cap.cells).toHaveLength(1);const request=f.context.waitForEvent('request',r=>r.isNavigationRequest()&&r.url().includes('/unexpected-popup'));await f.page.evaluate(()=>{window.open('/unexpected-popup','_blank');});await request;await f.page.close();await guard.finishReadOnlyInformation();expect(guard.informationRequestRefused).toBe(true);expect(guard.stateVerified).toBe(false);expect(f.requests()).toBe(1);
 }finally{guard.dispose();await f.context.close();}
});

for(const method of ['GET','POST']as const)it(`an unknown child-frame document ${method} is blocked before network`,async()=>{
 const f=await fixture();try{await f.page.evaluate(m=>{const frame=document.createElement('iframe');frame.name='unapproved-target';frame.hidden=true;document.body.append(frame);const form=document.createElement('form');form.id='unexpected-form';form.action='/unexpected-frame';form.method=m;form.target=frame.name;document.body.append(form);},method);
 await f.page.locator('[aria-controls="tax123"]').evaluate(e=>e.setAttribute('onclick',e.getAttribute('onclick')+";document.getElementById('unexpected-form').submit()"));const cap=await capture(f);expect(cap.cells).toHaveLength(0);expect(cap.problems).toContain('UNEXPECTED_INFORMATION_REQUEST_REFUSED');expect(f.requests()).toBe(1);
 }finally{await f.context.close();}
});

for(const phase of ['room','tax','policy']as const)for(const kind of ['fetch-post','xhr-post','beacon','fetch-get','fetch-head']as const)it(`an information ${phase} click cannot send a non-navigation ${kind}`,async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);
 const control=phase==='room'?'#room_type_id_123':phase==='tax'?'[aria-controls="tax123"]':`[aria-controls="policyModal_${block}"]`;
 const path='/unexpected-information-'+kind;
 const script=kind==='xhr-post'?`{const x=new XMLHttpRequest();x.open('POST','${path}');x.send('synthetic');}`:kind==='beacon'?`navigator.sendBeacon('${path}','synthetic');`:`void fetch('${path}',{method:'${kind==='fetch-post'?'POST':kind==='fetch-head'?'HEAD':'GET'}'${kind==='fetch-post'?",body:'synthetic'":''}}).catch(()=>{});`;
 try{
  await f.page.locator(control).evaluate((e,s)=>e.setAttribute('onclick',e.getAttribute('onclick')+';'+s),script);
  const denied=f.context.waitForEvent('requestfailed',r=>r.url().endsWith(path));
  const cap=await capture(f,guard),request=await denied;
  expect(request.isNavigationRequest()).toBe(false);expect(request.failure()?.errorText).toContain('ERR_BLOCKED_BY_CLIENT');
  expect(cap.cells).toHaveLength(0);expect(cap.problems).toContain('UNEXPECTED_INFORMATION_REQUEST_REFUSED');
  expect(guard.informationRequestRefused).toBe(true);expect(guard.stateVerified).toBe(false);expect(f.requests()).toBe(1);
  await expect.poll(()=>guard.informationDeniedRequest).not.toBeNull();
  expect(guard.informationDeniedRequest).toMatchObject({method:kind==='fetch-get'?'GET':kind==='fetch-head'?'HEAD':'POST',navigation:false,abortOutcome:'SUCCEEDED'});
  expect(Object.keys(guard.informationDeniedRequest!).sort()).toEqual(['abortOutcome','method','navigation','resourceType']);
  expect(JSON.stringify(guard.informationDeniedRequest)).not.toContain('synthetic');
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
for(const method of ['PUT','PATCH','DELETE']as const)it(`unapproved ${method} is denied without method-dependent fallback`,async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{
  await f.page.locator('[aria-controls="tax123"]').evaluate((e,m)=>e.setAttribute('onclick',e.getAttribute('onclick')+`;void fetch('/unexpected-method',{method:'${m}',body:'synthetic'}).catch(()=>{});`),method);
  const denied=f.context.waitForEvent('requestfailed',r=>r.url().endsWith('/unexpected-method'));
  const cap=await capture(f,guard);await denied;expect(cap.cells).toHaveLength(0);expect(guard.informationRequestRefused).toBe(true);expect(guard.stateVerified).toBe(false);expect(f.requests()).toBe(1);
 }finally{await f.page.close();await guard.finishReadOnlyInformation();guard.dispose();await f.context.close();}
});
it('a late non-navigation POST stays blocked through page close and final-state recording',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{const cap=await capture(f,guard);expect(cap.cells).toHaveLength(1);
  const request=f.context.waitForEvent('request',r=>r.url().endsWith('/late-post'));await f.page.evaluate(()=>{void fetch('/late-post',{method:'POST',body:'synthetic'}).catch(()=>{});});await request;
  await f.page.close();await guard.finishReadOnlyInformation();expect(guard.informationRequestRefused).toBe(true);expect(guard.stateVerified).toBe(false);expect(f.requests()).toBe(1);
 }finally{guard.dispose();await f.context.close();}
});
it('normal information access uses no extra network and releases the context guard only after page close',async()=>{
 const f=await fixture(),guard=new BookingUiBlockGuard(f.page);try{expect((await capture(f,guard)).cells).toHaveLength(1);expect(guard.stateVerified).toBe(true);
  await f.page.close();await guard.finishReadOnlyInformation();const next=await f.context.newPage();let served=0;await next.route('**/*',r=>{served++;return r.fulfill({status:200,body:'next owned page'});});
  await next.goto('https://synthetic.test/after-owner-close');expect(served).toBe(1);expect(guard.stateVerified).toBe(true);expect(guard.informationRequestRefused).toBe(false);await next.close();
 }finally{guard.dispose();await f.context.close();}
});
it('the anonymous context blocks service workers rather than allowing a worker to bypass HTTP routing',async()=>{
 const f=await fixture();try{const state=await f.page.evaluate(async()=>{try{const registration=await navigator.serviceWorker.register('/unapproved-worker.js');return registration===undefined?'BLOCKED_WITHOUT_REGISTRATION':'REGISTERED';}catch{return 'REFUSED';}});
  expect(state).toBe('BLOCKED_WITHOUT_REGISTRATION');expect(f.context.serviceWorkers()).toHaveLength(0);expect(f.requests()).toBe(1);expect((await capture(f)).cells).toHaveLength(1);
 }finally{await f.context.close();}
});

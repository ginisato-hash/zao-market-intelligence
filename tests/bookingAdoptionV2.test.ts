// Synthetic public-page fixtures only; no live provider or business-policy approval.
import{beforeAll,afterAll,it,expect}from'vitest';import{chromium,type Browser}from'playwright';
import{productFactsFixtureHtml}from'./fixtures/bookingProductFactsPage';
import{readBookingHeaderSnapshot,readBookingCompositeStay,createAnonymousBookingCaptureContext,BOOKING_ADOPTION_V2,bookingOneNightQuoteText,bookingServedTuple,bookingSelectedQuotePartyConflict,validateBookingStayBindingV2}from'../src/services/bookingProductObservability';
import{BookingUiBlockGuard}from'../src/services/bookingUiBlockGuard';
import{captureBookingRateCells,deriveBookingRateCell,sealBookingRateCellCapture}from'../src/services/bookingRateCellEvidence';
import{selectedBookingTotalV2}from'../src/services/bookingTwoPersonMarketAdmission';
import{bookingSemanticTermsV2}from'../src/services/bookingPaymentTerms';
import{diagnoseBookingFixedProductCapture}from'../src/services/bookingFixedProductDiagnostic';
let browser:Browser;beforeAll(async()=>{browser=await chromium.launch({headless:true});});afterAll(async()=>{await browser?.close();});
const url='https://www.booking.com/hotel/jp/external.ja.html?checkin=2027-01-15&checkout=2027-01-16&group_adults=2&group_children=0&no_rooms=1&selected_currency=JPY';
async function run(mode:string='normal'){
 const context=await createAnonymousBookingCaptureContext(browser,'synthetic'),page=await context.newPage();let external=0;
 let html=productFactsFixtureHtml(mode==='member'?'member':'normal').replace("aria-label='2027年1月15日(金) — 2027年1月16日(土)'",'').replace('>Dates</button>','><span data-testid="date-display-field-start">1月15日(金)</span> — <span data-testid="date-display-field-end">1月16日(土)</span></button>');
 if(mode==='duplicateFullYear')html=productFactsFixtureHtml('normal');
 if(mode==='opaqueTokens'||mode==='quotePartyConflict')html=html.replaceAll('123_456_2_0_0','123_456_3_0_7').replace('人数: 2','最大宿泊人数：大人3名').replace('ツインルーム</a>21㎡','ツインルーム</a>21㎡ 定員3名');
 if(mode==='quotePartyConflict')html=html.replace('1泊 大人2名','1泊 大人3名');
 if(mode==='delayedPolicyClose')html=html.replace("document.getElementById('policyModal_123_456_2_0_0').hidden=true","setTimeout(()=>document.getElementById('policyModal_123_456_2_0_0').hidden=true,75)");
 if(mode==='policyTitle')html=html.replace('食事およびキャンセルポリシーと前払いポリシーに関する詳細','この選択料金の条件');
 if(mode==='replacementPolicy')html=html.replace("document.getElementById('policyModal_123_456_2_0_0').hidden=true","document.getElementById('policyModal_123_456_2_0_0').hidden=true;const extra=document.createElement('div');extra.setAttribute('role','dialog');extra.textContent='unverified';document.body.append(extra)");
 if(mode==='movedPolicy')html=html.replace("document.getElementById('policyModal_123_456_2_0_0').hidden=true","document.getElementById('policyModal_123_456_2_0_0').id='moved-unverified'");
 if(mode==='uncloseablePolicy')html=html.replace("document.getElementById('policyModal_123_456_2_0_0').hidden=true","void 0");
 if(mode==='removedPolicy')html=html.replace("document.getElementById('policyModal_123_456_2_0_0').hidden=true","document.getElementById('policyModal_123_456_2_0_0').remove()");
 if(mode==='clearedPolicy')html=html.replace("document.getElementById('policyModal_123_456_2_0_0').hidden=true","document.getElementById('policyModal_123_456_2_0_0').innerHTML='';document.getElementById('policyModal_123_456_2_0_0').hidden=true");
 if(mode==='policyChangedOnClose')html=html.replace("document.getElementById('policyModal_123_456_2_0_0').hidden=true","document.getElementById('policyModal_123_456_2_0_0').textContent='変更後：返金不可。前払い不要。';document.getElementById('policyModal_123_456_2_0_0').hidden=true");
 if(mode==='mealChangedOnClose')html=html.replace("document.getElementById('policyModal_123_456_2_0_0').hidden=true","document.getElementById('policyModal_123_456_2_0_0').innerHTML=document.getElementById('policyModal_123_456_2_0_0').innerHTML.replace('お食事は含まれておりません','朝食が含まれています');document.getElementById('policyModal_123_456_2_0_0').hidden=true");
 if(mode==='noNightWeekday')html=html.replace(/1泊 大人2名 /gu,'').replace(/\([金土]\)/gu,'');
 if(mode==='noChildLiteral')html=html.replace('子供0名 · ','');
 if(mode==='unrelatedNight')html=html.replace("<table id='hprt-table'>","<table id='hprt-table'><caption>他のプランは2泊以上</caption>");
 if(mode==='twoNight')html=html.replace('1泊 大人2名','2泊 大人2名');
 if(mode==='taxEnglish')html=html.replace('税・手数料込','taxes and fees included');
 if(mode==='taxShort')html=html.replace('税・手数料込','税込');
 if(mode==='capacity1')html=html.replace('ツインルーム</a>21㎡','ツインルーム</a>21㎡ 定員1名');
 if(mode==='capacity3')html=html.replace('ツインルーム</a>21㎡','ツインルーム</a>21㎡ 定員3名');
 if(mode==='conflict')html=html.replace('>1月15日(金)</span>',' title="2028年1月15日">1月15日(金)</span>');
 const guard=new BookingUiBlockGuard(page,undefined,true);
 await context.route('**/*',route=>{external++;return route.fulfill({status:mode==='429'?429:200,contentType:'text/html; charset=utf-8',body:html});});await page.goto(mode==='duplicateFullYear'?url+'&group_adults=3':url);
 if(mode==='unrelatedNight')expect(await page.locator('#hprt-table caption').innerText()).toContain('2泊');
 if(mode==='post'||mode==='drift')await page.locator('button[aria-controls^="policyModal_"]').evaluate((e,m)=>e.setAttribute('onclick',e.getAttribute('onclick')+(m==='post'?";void fetch('/background',{method:'POST'}).catch(()=>{});":";document.querySelector('[data-testid=date-display-field-start]').textContent='1月14日(木)';")),mode);
 try{const cap=await captureBookingRateCells(page,{propertySlug:'external',checkin:'2027-01-15',checkout:'2027-01-16',observedAt:'2026-11-01T00:00:00Z',adoptionPolicy:BOOKING_ADOPTION_V2},3,guard);await guard.closeReadOnlyInformationPage();await guard.finishReadOnlyInformation();return{cap,derived:cap.cells.map(c=>deriveBookingRateCell(cap,c)),external,refused:guard.informationRequestRefused,hardStop:guard.hardStop};}
 finally{if(!page.isClosed())await page.close();await guard.finishReadOnlyInformation();guard.dispose();await context.close();}
}
it('v2 uses compound date proof without inventing displayed years or clicking calendar/capacity/tax',async()=>{const x=await run();expect(x.cap.parserVersion).toBe('booking-rate-cell-v5');expect(x.cap.displayedCheckin).toBeNull();expect(x.cap.stayBinding?.yearSource,JSON.stringify(x.cap)).toBe('REQUEST_TUPLE_FINAL_SERVED_URL_AND_VISIBLE_CALENDAR_LABELS');expect(x.cap.cells).toHaveLength(1);expect(x.derived[0]?.tupleAndProductBound).toBe(true);expect(x.external).toBe(1);expect(x.cap.cells[0]?.productFacts?.roomCapacity).toBeNull();});
it('v2 safely aborts background POST and retains independently checked row',async()=>{const x=await run('post');expect(x.external).toBe(1);expect(x.refused).toBe(true);expect(x.hardStop).toBe(false);expect(x.derived[0]?.tupleAndProductBound).toBe(true);});
it.each(['capacity3','capacity1'])('capacity remains a recorded auxiliary fact (%s)',async mode=>{const x=await run(mode);expect(x.cap.cells[0]?.productFacts?.passiveMaximumAdults).toBe(mode==='capacity1'?1:3);expect(x.external).toBe(1);});
it('limited member price is recorded but not claimed public',async()=>{const x=await run('member');expect(x.cap.cells).toHaveLength(1);expect(x.derived[0]?.memberConditional).toBe(true);expect(x.cap.cells[0]?.productFacts?.anonymousPublicContext).toBeNull();});
it.each(['drift','conflict'])('contradictory or changed date refuses (%s)',async mode=>{const x=await run(mode);expect(x.cap.cells).toHaveLength(0);expect(x.external).toBe(1);});
it('real429 remains a whole-source stop',async()=>{const x=await run('429');expect(x.hardStop).toBe(true);expect(x.cap.cells).toHaveLength(0);});
it('one-night proof cannot come from a tax unit or a two-night quote',()=>{expect(bookingOneNightQuoteText('1名/1泊につき¥150')).toBe(false);expect(bookingOneNightQuoteText('2泊 大人2名')).toBe(false);expect(bookingOneNightQuoteText('1泊 大人2名')).toBe(true);});
it('duplicate/redirected tuples cannot become composite proof',()=>{expect(bookingServedTuple(url+'&checkin=2028-01-15','external','2027-01-15','2027-01-16')).toBeNull();expect(bookingServedTuple(url.replace('/external.','/other.'),'external','2027-01-15','2027-01-16')).toBeNull();});
it('selected tax-inclusive total needs no redundant tooltip or local tax unit',()=>{expect(selectedBookingTotalV2({priceText:'1泊 税・手数料込',conditionsText:''},{currentDisplayedJpy:20000,localTaxTreatment:'UNKNOWN',localTaxPerAdultNightJpy:null})).toMatchObject({comparisonTotalJpy:20000,addedMandatoryFeesJpy:0});});
it('explicit separately payable adult/night fee is added without changing original amount',()=>{expect(selectedBookingTotalV2({priceText:'税・手数料込 別途入湯税',conditionsText:'',taxDetails:[{label:'別',details:'1名/1泊につき¥150の入湯税'}]},{currentDisplayedJpy:20000,localTaxTreatment:'EXPLICIT_EXCLUDED',localTaxPerAdultNightJpy:150})).toMatchObject({originalDisplayedJpy:20000,comparisonTotalJpy:20300,addedMandatoryFeesJpy:300});});
it('unknown/excluded fee never becomes zero',()=>{expect(selectedBookingTotalV2({priceText:'税・手数料込 別途入湯税',conditionsText:''},{currentDisplayedJpy:20000,localTaxTreatment:'UNKNOWN',localTaxPerAdultNightJpy:null})).toBeNull();});
it('semantic conditions ignore harmless whitespace and synonyms but retain timing uncertainty',()=>{expect(bookingSemanticTermsV2('お食事は含まれておりません。返金不可。宿泊料金の全額が予約時に請求されます。','NON_REFUNDABLE')).toEqual(bookingSemanticTermsV2('食事は含まれていません。\n返金不可。 予約時に全額支払いが必要です。','NON_REFUNDABLE'));expect(bookingSemanticTermsV2('返金不可。事前に全額支払う必要があります。','NON_REFUNDABLE')).toBeNull();});
it('negative total declarations and unknown other mandatory fees cannot become zero-cost inclusions',()=>{
 for(const text of ['税込ではありません','税・手数料込ではありません','税・手数料込。別途サービス料あり','税・手数料込。清掃料金は含まれておりません'])expect(selectedBookingTotalV2({priceText:text,conditionsText:''},{currentDisplayedJpy:20000,localTaxTreatment:'UNKNOWN',localTaxPerAdultNightJpy:null})).toBeNull();
 expect(selectedBookingTotalV2({priceText:'税・手数料込 別途サービス料 入湯税',conditionsText:'',taxDetails:[{label:'別',details:'1名/1泊につき¥150の入湯税'}]},{currentDisplayedJpy:20000,localTaxTreatment:'EXPLICIT_EXCLUDED',localTaxPerAdultNightJpy:150})).toBeNull();
});
it('NR labels cannot hide penalty amounts or time conditions',()=>{for(const x of ['キャンセル料は宿泊料金の50%です','キャンセル料は¥500です','キャンセル料は1日前から全額です','キャンセル料は半額です'])expect(bookingSemanticTermsV2('返金不可。'+x+'。予約時に全額支払いが必要です。','NON_REFUNDABLE')).toBeNull();});
it('v2 cannot fall back from a forged composite or mismatched party/tuple to displayed years',async()=>{
 const x=await run(),cell=x.cap.cells[0]!;
 for(const change of [{request:{...x.cap.request,adults:3}},{request:{...x.cap.request,rooms:2}},{request:{...x.cap.request,currency:'USD'}},{stayBinding:{...x.cap.stayBinding!,servedTupleSha256:'0'.repeat(64)},displayedCheckin:x.cap.request.checkin,displayedCheckout:x.cap.request.checkout},{displayedParty:'大人2名 子供0名 1部屋'}]){
  const cap=sealBookingRateCellCapture({...x.cap,...change} as any);expect(deriveBookingRateCell(cap,cell).tupleAndProductBound).toBe(false);
 }
});
it('retry storms stay blocked and bounded and trigger a whole-source stop',async()=>{
 const context=await createAnonymousBookingCaptureContext(browser,'synthetic'),page=await context.newPage();let served=0;await context.route('**/*',r=>{served++;return r.fulfill({status:200,contentType:'text/html',body:'<html>synthetic</html>'});});await page.goto(url);const guard=new BookingUiBlockGuard(page,undefined,true);
 try{await guard.armReadOnlyInformation();await page.evaluate(async()=>{await Promise.all(Array.from({length:1002},(_,i)=>fetch('/storm/'+i,{method:'POST'}).catch(()=>{})));});await guard.checkpoint();expect(served).toBe(1);expect(guard.hardStop).toBe(true);const s=guard as any;expect(s.seen.size).toBeLessThanOrEqual(1000);expect(s.safelyAborted.size).toBeLessThanOrEqual(1000);expect(s.aborts.size).toBeLessThanOrEqual(1000);}finally{await page.close();await guard.finishReadOnlyInformation();guard.dispose();await context.close();}
});

it.each(['noNightWeekday','noChildLiteral'])('TD6545970990 confirmed tuple retains quote without redundant literal labels (%s)',async mode=>{const x=await run(mode);expect(x.cap.cells).toHaveLength(1);expect(x.derived[0]?.tupleAndProductBound).toBe(true);expect(x.cap.stayBinding?.oneNightBasis).toBe('CONFIRMED_CALENDAR_DATE_DIFFERENCE');});
it('explicit multi-night contradiction still refuses',async()=>{const x=await run('twoNight');expect(x.derived[0]?.tupleAndProductBound).toBe(false);});

it.each(['キャンセル料は全額ではありません','ただしノーショーの場合はキャンセル料全額を免除します'])('NR exception and negation never inherit full penalty semantics (%s)',clause=>{expect(bookingSemanticTermsV2('返金不可。'+clause+'。予約時に全額支払いが必要です。','NON_REFUNDABLE')).toBeNull();});

it.each(['入湯税は含まれておりません','サービス料を含まない','入湯税は現地で支払います'])('unknown excluded mandatory fee never becomes zero (%s)',clause=>{expect(selectedBookingTotalV2({priceText:'税・手数料込。'+clause,conditionsText:''},{currentDisplayedJpy:20000,localTaxTreatment:'UNKNOWN',localTaxPerAdultNightJpy:null})).toBeNull();});

it('another rate minimum stay text does not invalidate selected one-night quote',async()=>{const x=await run('unrelatedNight');expect(x.derived[0]?.tupleAndProductBound).toBe(true);});

it('cleanup drains a late abort failure added during owned unroute',async()=>{const ctx:any={on:()=>{},off:()=>{},route:async()=>{},unroute:async()=>{const req:any={method:()=>"POST",resourceType:()=>"fetch",isNavigationRequest:()=>false};const g:any=guard;g.informationRequestSeen(req);void g.informationRoute({request:()=>req,abort:async()=>{await new Promise(r=>setTimeout(r,20));throw Error('synthetic abort failure');}});}};const page:any={on:()=>{},once:()=>{},context:()=>ctx,route:async()=>{},isClosed:()=>true};const guard=new BookingUiBlockGuard(page,undefined,true);await guard.armReadOnlyInformation();await guard.finishReadOnlyInformation();expect(guard.hardStop).toBe(true);expect(guard.stateVerified).toBe(false);expect((guard as any).aborts.size).toBe(0);});

it('v2 diagnostics do not reintroduce old exact-capacity or tax-tooltip gates',async()=>{const x=await run();const d=diagnoseBookingFixedProductCapture(x.cap).cells[0]!;expect(d.missingObservedFacts).not.toContain('EXPLICIT_MAXIMUM_ADULTS');expect(d.missingObservedFacts).not.toContain('LOCAL_TAX_PER_ADULT_NIGHT_NOT_PROVED');expect(d.allMandatoryTotalProved).toBe(true);expect(d.priceEligible).toBe(false);});

it.each(['taxEnglish','taxShort'])('v2 shared inclusive tax predicate reaches selected total (%s)',async mode=>{const x=await run(mode);expect(x.derived[0]?.tupleAndProductBound).toBe(true);expect(selectedBookingTotalV2(x.cap.cells[0]!,x.derived[0]!)).not.toBeNull();});
it('normal NR trigger and booking payment timing remain separate positive facts',()=>{const common='キャンセル、変更、ノーショーの場合、宿泊料金の合計が請求されます。';expect(bookingSemanticTermsV2('返金不可。'+common+'宿泊料金の全額が予約時に請求されます。','NON_REFUNDABLE')).toMatchObject({cancellation:'ANYTIME_NON_REFUNDABLE',prepayment:'FULL_AT_BOOKING'});});

it('full-year V5 capture still refuses duplicated final served tuple',async()=>{const x=await run('duplicateFullYear');expect(x.cap.requestUrlMatches).toBe(false);expect(x.cap.cells).toHaveLength(0);expect(x.cap.problems).toContain('SERVED_URL_TUPLE_MISMATCH_NO_INTERACTION');});

it.each(['opaqueTokens','delayedPolicyClose','policyTitle'])('v5 retains independently proved selected2P quote (%s)',async mode=>{const x=await run(mode);expect(x.cap.cells).toHaveLength(1);expect(x.derived[0]?.tupleAndProductBound,JSON.stringify(x.cap)).toBe(true);expect(x.hardStop).toBe(false);expect(x.external).toBe(1);});
it('opaque rate tokens never override an explicit selected quote party contradiction',async()=>{const x=await run('quotePartyConflict');expect(x.cap.cells).toHaveLength(1);expect(x.derived[0]?.reasons).toContain('SELECTED_QUOTE_PARTY_CONFLICT');expect(x.derived[0]?.tupleAndProductBound).toBe(false);});
it('an uncloseable owned policy is a genuine cleanup stop',async()=>{const x=await run('uncloseablePolicy');expect(x.hardStop).toBe(true);expect(x.cap.blockStateVerified).toBe(false);expect(x.derived.filter(d=>d.tupleAndProductBound)).toHaveLength(0);});

it.each(['3 adults','Adults: 3','2 children','Children: 1','for 2 rooms','Rooms: 2','大人3人','お子様1名'])('selected quote explicit party contradiction is refused without requiring redundant positive labels (%s)',text=>{expect(bookingSelectedQuotePartyConflict(text)).toBe(true);});
it.each(['2 adults 0 children 1 room','大人2名 子供0名','taxes and fees included'])('matching or unspecified selected party stays usable (%s)',text=>{expect(bookingSelectedQuotePartyConflict(text)).toBe(false);});

it.each(['replacementPolicy','movedPolicy'])('policy close cannot claim success when a visible dialog is replaced or moved (%s)',async mode=>{const x=await run(mode);expect(x.hardStop).toBe(true);expect(x.cap.cells).toHaveLength(0);expect(x.cap.problems).toContain('POLICY_CLOSE_UNVERIFIED');});

it.each(['Only 2 rooms left','残り2部屋','up to 3 adults','Maximum occupancy: 3 adults','定員3名'])('inventory and auxiliary capacity are not selected quote party (%s)',text=>{expect(bookingSelectedQuotePartyConflict(text)).toBe(false);});

it.each(['removedPolicy','clearedPolicy'])('normal closed policy DOM teardown does not fabricate a material condition change (%s)',async mode=>{const x=await run(mode);expect(x.cap.cells).toHaveLength(1);expect(x.derived[0]?.tupleAndProductBound).toBe(true);expect(x.cap.cells[0]?.policyDomRawSha256).toMatch(/^[a-f0-9]{64}$/);expect(x.hardStop).toBe(false);expect(x.external).toBe(1);});
it('retained policy with changed material terms is still refused after close',async()=>{const x=await run('policyChangedOnClose');expect(x.cap.cells).toHaveLength(1);expect(x.derived[0]?.tupleAndProductBound).toBe(false);expect(x.cap.cells[0]?.rowProblems).toContain('POLICY_TERMS_CHANGED_AFTER_INFORMATION');});

it('meal changes cannot hide behind unchanged cancellation and payment semantics',async()=>{const x=await run('mealChangedOnClose');expect(x.cap.cells).toHaveLength(1);expect(x.derived[0]?.tupleAndProductBound).toBe(false);expect(x.cap.cells[0]?.rowProblems).toContain('POLICY_TERMS_CHANGED_AFTER_INFORMATION');});

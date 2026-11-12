import {expect,it} from 'vitest';import {createHash} from 'node:crypto';
import {sealBookingRateCellCapture,deriveBookingRateCell,type BookingRateCell} from '../src/services/bookingRateCellEvidence';
import {admitCanonicalBookingTwoPerson,hasExplicitAllMandatoryTotal} from '../src/services/bookingTwoPersonMarketAdmission';
import {recordTwoPersonMarketAdmission,readAcceptedTwoPersonPanel} from '../src/services/twoPersonMarketAdmissionLane';
import {selectFixedTwoPersonSignals} from '../src/services/bookingFixedProductSelection';
import {marketConditionKey} from '../src/services/marketTwoPersonCurve';import {digest} from '../src/services/marketRowPriceQuality';
import type {HistoryRow} from '../src/services/localHistorySchemaDesign';import type {BookingRenderedDomSignals} from '../src/services/bookingRenderedDomProbe';
import {BOOKING_ADOPTION_V2,BOOKING_ADOPTION_V2_DIGEST} from '../src/services/bookingProductObservability';
import {bookingSemanticTermsV2} from '../src/services/bookingPaymentTerms';
import {diagnoseBookingFixedProductCapture} from '../src/services/bookingFixedProductDiagnostic';
const terms='お食事は含まれておりません。返金不可。予約時に全額を支払い。';
function fixture(){
 const cell:BookingRateCell={blockId:'123_456_2_0_0',roomName:'ダブルルーム',roomText:'ダブルルーム ダブルベッド1台',occupancyText:'人数: 2',priceText:'￥20,000 税・手数料込。すべての税金と料金が含まれています。一般公開料金',priceRoleText:'￥20,000',taxDetails:[{label:'込',details:'1名/1泊につき¥150の入湯税'}],conditionsText:'返金不可',oneRoomOptionText:'1 (￥20,000)',policyControlId:'policyModal_123_456_2_0_0',policyContainerId:'policyModal_123_456_2_0_0',policyText:terms};
 const capture=sealBookingRateCellCapture({schema:'ZMI_BOOKING_RATE_CELLS_V1',parserVersion:'booking-rate-cell-v3',propertySlug:'source-property',observedAt:'2026-10-29T00:01:00Z',request:{checkin:'2027-01-15',checkout:'2027-01-16',adults:2,children:0,rooms:1,currency:'JPY'},requestUrlMatches:true,displayedCheckin:'2027-01-15',displayedCheckout:'2027-01-16',displayedParty:'大人2名 子供0名 1部屋',cells:[cell],problems:[],blockReason:null,blockStateVerified:true});
 const rawCaptureBytes=Buffer.from(JSON.stringify(capture)),conditions={meal:'ROOM_ONLY' as const,cancellation:'NON_REFUNDABLE' as const,prepayment:'REQUIRED' as const,discount:'PUBLIC' as const,tax:'ALL_MANDATORY_INCLUDED' as const};
 const row={rowId:'2026-10-29|booking|地域の宿|source-property|2027-01-15',rowHash:digest('canonical-original-bytes'),source:'booking',propertyIdentityMatch:true,sourceSlugOrCode:'source-property',checkin:'2027-01-15',checkout:'2027-01-16',groupAdults:2,groupChildren:0,noRooms:1,stayNights:1,currency:'JPY',collectedAtJst:'2026-10-29T00:00:00Z',sourcePrimaryPrice:20000,normalizedTotalPrice:20000} as HistoryRow;
 return {row,mirrorIdentity:{rowId:row.rowId,rowHash:row.rowHash},capture,rawCaptureBytes,independentRawCaptureSha256:createHash('sha256').update(rawCaptureBytes).digest('hex'),pageFinalBlockReason:null as string|null,pageFinalBlockStateVerified:true,product:{propertyId:'physical-property',sourcePropertyId:'source-property',source:'booking' as const,productId:'123',ratePlanId:'456',conditionKey:marketConditionKey(conditions,'terms_'+digest(terms)),weight:1,groupId:null,standardProduct:{kind:'DOUBLE' as const,maxAdults:2 as const,evidenceSha256:digest('source-size-proof')}},standardProductProofVerified:true,ingestedAt:'2026-10-29T00:02:00Z'};
}
it('admits only the actual canonical/mirrored fixed product with complete public-price terms and a raw source receipt',()=>{const x=admitCanonicalBookingTwoPerson(fixture());expect(x.status).toBe('VERIFIED_CANONICAL_TWO_PERSON_FACT');expect(x.observation?.totalJpy).toBe(20000);expect(x.quality?.observationSha256).toBe(digest(x.observation));});
it('keeps legacy usable flags irrelevant and rejects missing mirror/standard identity/raw receipt/final page guard',()=>{for(const change of [{mirrorIdentity:null},{standardProductProofVerified:false},{independentRawCaptureSha256:'0'.repeat(64)},{pageFinalBlockReason:'challenge'},{pageFinalBlockStateVerified:false}])expect(admitCanonicalBookingTwoPerson({...fixture(),...change}).observation).toBeNull();});
it('does not use a selected room different from the price actually stored in canonical history',()=>{const f=fixture();f.row.sourcePrimaryPrice=12000;expect(admitCanonicalBookingTwoPerson(f).reason).toBe('FIXED_PRODUCT_NOT_THE_CANONICAL_PRICE');});
it('does not promote selected-declared-only taxes, member prices or unknown prepayment into a public gross total',()=>{for(const change of [{priceText:'￥20,000 税・手数料込 一般公開料金'},{priceText:'￥20,000 税・手数料込 すべての税金と料金が含まれています。会員限定料金 Genius'},{policyText:'お食事は含まれておりません。返金不可。'}]){const f=fixture();f.capture=sealBookingRateCellCapture({...f.capture,cells:[{...f.capture.cells[0]!,...change}]});f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');expect(admitCanonicalBookingTwoPerson(f).observation).toBeNull();}});
it('fixed row selection ignores cheaper suite/replacement and leaves hotel-level sold-out inference untouched',()=>{const f=fixture(),original={primaryPriceCandidate:{numericValue:10000},soldOutOrUnavailableDetected:false} as BookingRenderedDomSignals;const selected=selectFixedTwoPersonSignals(original,f.capture,f.product,null,true);expect(selected.signals.primaryPriceCandidate?.numericValue).toBe(20000);const missing=selectFixedTwoPersonSignals(original,f.capture,{...f.product,productId:'999'},null,true);expect(missing.signals.primaryPriceCandidate).toBeNull();expect(missing.signals.soldOutOrUnavailableDetected).toBe(false);});
it('disabled admission lane does no file I/O and unavailable secondary OTA/mirror never admits a price',()=>{expect(readAcceptedTwoPersonPanel({})).toBeNull();const input={runId:'fixture',now:'invalid',root:'/no-such-fixture',captureDir:'/no-such-fixture',dbPath:'/no-such-fixture',mirrorExact:false,rows:[],captures:[]};expect(recordTwoPersonMarketAdmission({},input).status).toBe('DISABLED');expect(recordTwoPersonMarketAdmission({ZMI_2P_QUALITY_ENABLED:'1'},input).status).toBe('ADMISSION_UNVERIFIED_NO_PRICE_INPUT');});

it('rejects negated or contradictory all-tax declarations in the selected price block',()=>{
 for(const priceText of ['￥20,000 税・手数料込。すべての税金と料金が含まれません。一般公開料金','￥20,000 税・手数料込。すべての税金と料金が含まれていません。一般公開料金',
  '￥20,000 税・手数料込。すべての税金と料金が含まれています。サービス料金は別途支払い。一般公開料金']){
  const f=fixture();f.capture=sealBookingRateCellCapture({...f.capture,cells:[{...f.capture.cells[0]!,priceText}]});f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');
  expect(hasExplicitAllMandatoryTotal(priceText)).toBe(false);expect(admitCanonicalBookingTwoPerson(f).observation).toBeNull();
 }
});
function v4Fixture(){const f=fixture(),cell=f.capture.cells[0]!;f.capture=sealBookingRateCellCapture({...f.capture,parserVersion:'booking-rate-cell-v4',cells:[{...cell,priceText:'￥20,000 税・手数料込',rowProblems:[],oneRoomOptionEnabled:true,productFacts:{schema:'BOOKING_SELECTED_PRODUCT_FACTS_V1',blockId:cell.blockId,anonymousPublicContext:{freshUnauthenticatedContext:true,signedOutControlVisible:true},roomCapacity:{roomId:'123',roomName:cell.roomName,controlId:'RD123',containerId:'RD123',maximumAdults:2,explicitText:'最大宿泊人数：2名'},taxTotal:{controlId:'tax123',containerId:'tax123',explicitText:'すべての税金と料金が含まれています。'}}}]});f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');return f;}
it('v4 uses positive controlled room/tax information and fresh anonymous guest offer instead of nonexistent literal public-price wording',()=>{const f=v4Fixture();expect(admitCanonicalBookingTwoPerson(f),admitCanonicalBookingTwoPerson(f).reason).toMatchObject({status:'VERIFIED_CANONICAL_TWO_PERSON_FACT'});});
for(const fault of ['room-capacity','different-room','missing-capacity','anonymous-unknown','sign-in-unknown','tax-exclusion','tax-control','member','own-policy-failed','global-page-problem']as const)it(`v4 never guesses missing product facts or promotes conditional prices: ${fault}`,()=>{
 const f=v4Fixture(),cell=f.capture.cells[0]!,facts=cell.productFacts!;
 if(fault==='room-capacity')facts.roomCapacity={...facts.roomCapacity!,maximumAdults:3,explicitText:'最大宿泊人数：3名'};
 if(fault==='different-room')facts.roomCapacity!.roomId='999';if(fault==='missing-capacity')facts.roomCapacity=null;if(fault==='anonymous-unknown')facts.anonymousPublicContext=null;
 if(fault==='sign-in-unknown')(facts.anonymousPublicContext as unknown as {signedOutControlVisible:boolean}).signedOutControlVisible=false;
 if(fault==='tax-exclusion')facts.taxTotal!.explicitText='すべての税金と料金が含まれています。入湯税は別途支払。';if(fault==='tax-control')facts.taxTotal!.containerId='OTHER';if(fault==='member')cell.priceText+=' Genius 会員限定料金';if(fault==='own-policy-failed')cell.rowProblems=['RATE_POLICY_UNVERIFIED'];if(fault==='global-page-problem')f.capture.problems=['DISPLAYED_DATE_OR_PARTY_UNVERIFIED'];
 f.capture=sealBookingRateCellCapture(f.capture);f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');expect(admitCanonicalBookingTwoPerson(f).observation).toBeNull();
});
it('a different row policy failure does not contaminate the fully proved fixed row; its failure never becomes a hotel sold-out fact',()=>{
 const f=v4Fixture();f.capture=sealBookingRateCellCapture({...f.capture,cells:[...f.capture.cells,{...f.capture.cells[0]!,blockId:'999_456_2_0_0',policyText:null,rowProblems:['RATE_POLICY_UNVERIFIED']}]});f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');expect(admitCanonicalBookingTwoPerson(f).status).toBe('VERIFIED_CANONICAL_TWO_PERSON_FACT');
});

it('prefix extra-charge and excluded-item headings contradict an affirmative gross total',()=>{
 for(const text of ['すべての税金と料金が含まれています。別途500円のサービス料金がかかります。','すべての税金と料金が含まれています。含まれないもの：清掃料金500円','すべての税金と料金が含まれています。Additional charge JPY500']){
  expect(hasExplicitAllMandatoryTotal(text)).toBe(false);const f=v4Fixture();f.capture.cells[0]!.productFacts!.taxTotal!.explicitText=text;f.capture=sealBookingRateCellCapture(f.capture);f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');expect(admitCanonicalBookingTwoPerson(f).reason).toBe('SELECTED_TOTAL_TAX_INFORMATION_NOT_PROVED');
 }
});

it('disabled or unknown quantity-one availability cannot become a public available v4 offer',()=>{for(const value of [false,undefined]){const f=v4Fixture();if(value===undefined)delete f.capture.cells[0]!.oneRoomOptionEnabled;else f.capture.cells[0]!.oneRoomOptionEnabled=value;f.capture=sealBookingRateCellCapture(f.capture);f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');expect(admitCanonicalBookingTwoPerson(f).observation).toBeNull();}});

it('v4 cannot use a price-block positive declaration when its controlled tax information is UNKNOWN',()=>{
 const f=v4Fixture();f.capture.cells[0]!.priceText+='。すべての税金と料金が含まれています。';f.capture.cells[0]!.productFacts!.taxTotal!.explicitText='税の内訳は現在確認できません';f.capture=sealBookingRateCellCapture(f.capture);f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');expect(admitCanonicalBookingTwoPerson(f).reason).toBe('SELECTED_TOTAL_TAX_INFORMATION_NOT_PROVED');
});
function v5Fixture(capacity:number|null=null){const f=v4Fixture(),cell=f.capture.cells[0]!;
 f.capture=sealBookingRateCellCapture({...f.capture,parserVersion:'booking-rate-cell-v5',adoptionPolicy:{version:BOOKING_ADOPTION_V2,digest:BOOKING_ADOPTION_V2_DIGEST},cells:[{...cell,priceText:'1泊 大人2名 ￥20,000 税・手数料込',priceRoleText:'1泊 大人2名 ￥20,000',taxDetails:[],productFacts:{schema:'BOOKING_SELECTED_PRODUCT_FACTS_V2',blockId:cell.blockId,passiveMaximumAdults:capacity,anonymousPublicContext:{freshUnauthenticatedContext:true,signedOutControlVisible:false,selectedRowPublicChecked:true},roomCapacity:null,taxTotal:null}}]});
 const conditions={meal:'ROOM_ONLY' as const,cancellation:'NON_REFUNDABLE' as const,prepayment:'REQUIRED' as const,discount:'PUBLIC' as const,tax:'ALL_MANDATORY_INCLUDED' as const};
 const product={...f.product,standardProduct:{...f.product.standardProduct,maxAdults:capacity},conditionKey:marketConditionKey(conditions,'terms2_'+digest(bookingSemanticTermsV2(terms,'NON_REFUNDABLE')))};
 f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');return {...f,product};
}
for(const capacity of [null,3])it('v2 admits actual2P price with auxiliary capacity '+capacity+' and row-inclusive tax',()=>{const f=v5Fixture(capacity);expect(admitCanonicalBookingTwoPerson(f).status).toBe('VERIFIED_CANONICAL_TWO_PERSON_FACT');expect(admitCanonicalBookingTwoPerson(f).observation?.totalJpy).toBe(20000);});
it('v2 rejects known capacity1 instead of treating it as a missing auxiliary attribute',()=>{expect(admitCanonicalBookingTwoPerson(v5Fixture(1)).observation).toBeNull();});
it('v2 does not invent anonymity for a historical or missing context',()=>{const f=v5Fixture();f.capture.cells[0]!.productFacts!.anonymousPublicContext=null;f.capture=sealBookingRateCellCapture(f.capture);f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');expect(admitCanonicalBookingTwoPerson(f).reason).toBe('PUBLIC_PRICE_NOT_PROVED');});

it('v2 binds existing normalized fee-inclusive total without losing or double-adding the original displayed price',()=>{const f=v5Fixture(),c=f.capture.cells[0]!;c.priceText+='。別途入湯税';c.taxDetails=[{label:'別',details:'1名/1泊につき¥150の入湯税'}];f.row.normalizedTotalPrice=20300;f.capture=sealBookingRateCellCapture(f.capture);f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');const a=admitCanonicalBookingTwoPerson(f);expect(a.status).toBe('VERIFIED_CANONICAL_TWO_PERSON_FACT');expect(a.observation).toMatchObject({totalJpy:20300,originalDisplayedJpy:20000,mandatoryFeesJpy:300});expect(f.row.sourcePrimaryPrice).toBe(20000);for(const total of [20000,20600])expect(admitCanonicalBookingTwoPerson({...f,row:{...f.row,normalizedTotalPrice:total}}).observation).toBeNull();});

function rewriteV5(change:Partial<BookingRateCell>){const f=v5Fixture();f.capture=sealBookingRateCellCapture({...f.capture,cells:[{...f.capture.cells[0]!,...change}]});f.rawCaptureBytes=Buffer.from(JSON.stringify(f.capture));f.independentRawCaptureSha256=createHash('sha256').update(f.rawCaptureBytes).digest('hex');return f;}
const partialTerms=(rate=50)=>`お食事 お食事は含まれておりません。 キャンセル 一部返金可 予約後にキャンセルした場合は、宿泊料金の${rate}%がキャンセル料として請求されます。ノーショー（無断不泊）の場合、宿泊料金の100%が請求されます。 前払い • オンライン決済 宿泊料金の全額が予約時に請求されます。`;
it('v5 preserves explicit selected primary role independently of an additional fee with unknown basis',()=>{
 const f=rewriteV5({priceText:'￥20,000 料金 ￥20,000 ＋税・手数料（￥500）',priceRoleText:'￥20,000 料金 ￥20,000 ＋税・手数料（￥500）'});
 const d=deriveBookingRateCell(f.capture,f.capture.cells[0]!);expect(d.currentDisplayedJpy).toBe(20000);expect(d.reasons).not.toContain('PRICE_ROLE_AMBIGUOUS_OR_INVALID');expect(d.reasons).not.toContain('ONE_ROOM_PRICE_NOT_CONFIRMED');expect(admitCanonicalBookingTwoPerson(f).observation).toBeNull();expect(f.row.normalizedTotalPrice).toBe(20000);
 const legacy=sealBookingRateCellCapture({...f.capture,parserVersion:'booking-rate-cell-v4'});expect(deriveBookingRateCell(legacy,legacy.cells[0]!).currentDisplayedJpy).toBeNull();
});
it.each(['￥20,000 料金 ￥20,000 ＋税・手数料（￥500）','料金 ￥20,000 ＋税・手数料（￥500）'])('v5 primary and fee labels remain bound (%s)',priceRoleText=>{
 const f=rewriteV5({priceRoleText});expect(deriveBookingRateCell(f.capture,f.capture.cells[0]!).currentDisplayedJpy).toBe(20000);expect(admitCanonicalBookingTwoPerson(f).reason).toBe('ALL_MANDATORY_TOTAL_NOT_PROVED');
});
it('an inclusive label never erases an explicit surcharge or invents its unit at full admission',()=>{
 for(const tail of ['＋税・手数料（￥500）','＋税・手数料','＋税・手数料（￥500） ＋税・手数料（￥300）']){
  const f=rewriteV5({priceRoleText:'￥20,000 料金 ￥20,000 ＋税・手数料（￥500）',priceText:'￥20,000 料金 ￥20,000 '+tail+' 税・手数料込',taxDetails:[]});
  expect(deriveBookingRateCell(f.capture,f.capture.cells[0]!).currentDisplayedJpy).toBe(20000);expect(admitCanonicalBookingTwoPerson(f).reason).toBe('ALL_MANDATORY_TOTAL_NOT_PROVED');
 }
});
it('only an independently proved fee unit and the same displayed surcharge can enter the comparison total once',()=>{
 for(const surcharge of [300,500]){
  const f=rewriteV5({priceRoleText:`￥20,000 料金 ￥20,000 ＋税・手数料（￥${surcharge}）`,priceText:`￥20,000 料金 ￥20,000 ＋税・手数料（￥${surcharge}） 税・手数料込`,taxDetails:[{label:'別',details:'1名/1泊につき¥150の入湯税'}]});
  f.row.normalizedTotalPrice=20300;const a=admitCanonicalBookingTwoPerson(f);if(surcharge===300)expect(a.observation).toMatchObject({originalDisplayedJpy:20000,mandatoryFeesJpy:300,totalJpy:20300});else expect(a.observation).toBeNull();
 }
});
it('cross-channel fee disagreement never inherits either displayed amount',()=>{
 const f=rewriteV5({priceRoleText:'料金 ￥20,000 ＋税・手数料（￥500）',priceText:'￥20,000 税・手数料込 ＋税・手数料（￥300）',taxDetails:[{label:'別',details:'1名/1泊につき¥150の入湯税'}]});f.row.normalizedTotalPrice=20300;expect(admitCanonicalBookingTwoPerson(f).reason).toBe('ALL_MANDATORY_TOTAL_NOT_PROVED');
});
it.each(['￥19,000 料金 ￥20,000 ＋税・手数料（￥500）','元の料金 ￥20,000 ＋税・手数料（￥500）','￥20,000 合計 ￥20,000 ＋税・手数料（￥500）','料金 ￥20,000 ＋税・手数料（￥500） 料金 ￥19,000','料金 ￥20,000 ＋税・手数料（￥500）から','料金 ￥20,000 または ￥19,000 ＋税・手数料（￥500）'])('contradictory, original-only, range or unbound amounts remain unknown (%s)',priceRoleText=>{
 const f=rewriteV5({priceRoleText});expect(deriveBookingRateCell(f.capture,f.capture.cells[0]!).currentDisplayedJpy).toBeNull();
});
it('v5 explicit partial cancellation retains rate/no-show/payment and requires a new accepted condition series',()=>{
 const text=partialTerms(),f=rewriteV5({policyText:text,conditionsText:'一部返金可'}),semantic=bookingSemanticTermsV2(text,'PARTIAL_REFUNDABLE');
 expect(semantic).toMatchObject({cancellation:{kind:'PARTIAL_REFUNDABLE_AFTER_BOOKING',cancellationPercent:50,noShowPercent:100},prepayment:'FULL_AT_BOOKING'});
 expect(deriveBookingRateCell(f.capture,f.capture.cells[0]!).refund).toBe('PARTIAL_REFUNDABLE');
 expect(diagnoseBookingFixedProductCapture(f.capture).cells[0]!.missingObservedFacts).toEqual([]);
 expect(admitCanonicalBookingTwoPerson(f).reason).toBe('CONDITIONS_CHANGED_NEW_SERIES_REQUIRED');
 const conditions={meal:'ROOM_ONLY' as const,cancellation:'REFUNDABLE' as const,prepayment:'REQUIRED' as const,discount:'PUBLIC' as const,tax:'ALL_MANDATORY_INCLUDED' as const};
 f.product.conditionKey=marketConditionKey(conditions,'terms2_'+digest(semantic));const admitted=admitCanonicalBookingTwoPerson(f);expect(admitted.status).toBe('VERIFIED_CANONICAL_TWO_PERSON_FACT');expect(admitted.observation).toMatchObject({totalJpy:20000,cancellation:'REFUNDABLE',prepayment:'REQUIRED'});
 expect(digest(semantic)).not.toBe(digest(bookingSemanticTermsV2(partialTerms(60),'PARTIAL_REFUNDABLE')));
 expect(bookingSemanticTermsV2(text,'NON_REFUNDABLE')).toBeNull();
});
it.each([
 partialTerms().replace('宿泊料金の50%がキャンセル料として請求されます','宿泊料金の50%がキャンセル料として請求されません'),
 partialTerms().replace('ノーショー（無断不泊）の場合、宿泊料金の100%が請求されます。',''),
 partialTerms().replace('予約後にキャンセルした場合は、宿泊料金の50%がキャンセル料として請求されます。',''),
 partialTerms().replace('宿泊料金の全額が予約時に請求されます','宿泊料金の全額が予約時に請求されません'),
 partialTerms().replace('100%が請求','80%が請求'),
 partialTerms()+'ただしキャンセル料は免除される場合があります。',
 partialTerms()+'予約後にキャンセルした場合は、宿泊料金の60%がキャンセル料として請求されます。',
 partialTerms()+'朝食が含まれています。',
 partialTerms(0),partialTerms(100)
])('partial exceptions, unknown clauses, omissions and contradictory rates never inherit a known series',text=>{
 expect(bookingSemanticTermsV2(text,'PARTIAL_REFUNDABLE')).toBeNull();const f=rewriteV5({policyText:text});expect(admitCanonicalBookingTwoPerson(f).observation).toBeNull();
});

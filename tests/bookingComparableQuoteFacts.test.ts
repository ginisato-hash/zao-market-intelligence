// Synthetic prices/product IDs are fixture inputs, not real competitor observations or an accepted commercial basis.
import {expect,it} from 'vitest';
import {buildBookingComparableQuoteFacts,type BookingComparisonScope} from '../src/services/bookingComparableQuoteFacts';
import {sealBookingRateCellCapture,type BookingRateCell,type BookingRateCellCapture} from '../src/services/bookingRateCellEvidence';

const scope:BookingComparisonScope={asOf:'2026-10-25T02:00:00Z',checkin:'2027-01-25',checkout:'2027-01-26',maxAgeHours:24,productBasisVersion:'SYNTHETIC_TEST_COHORT_V1',products:[
 {propertySlug:'xi-raku',roomId:'1655515709',ratePlanId:'1',productCohort:'TEST_TWIN'},
 {propertySlug:'onsen-amp-stay-oakhill',roomId:'9001',ratePlanId:'1',productCohort:'TEST_TWIN'},
 {propertySlug:'hammond-takamiya',roomId:'9002',ratePlanId:'1',productCohort:'TEST_TWIN'},
 {propertySlug:'rurikura-resort',roomId:'9003',ratePlanId:'1',productCohort:'TEST_TWIN'}]};
function cap(slug='xi-raku',jpy=50000,at='2026-10-25T01:00:00Z'):BookingRateCellCapture{
 const room=scope.products.find(x=>x.propertySlug===slug)?.roomId??'9999',blockId=`${room}_1_2_0_0`,member=jpy*0.9;
 const cell:BookingRateCell={blockId,roomName:'fixture twin',roomText:'fixture twin 20m²',occupancyText:'人数: 2',priceText:`元の料金 ￥${jpy} 現在の料金 ￥${member} ログインしてこの会員限定料金を利用しましょう 税・手数料込`,
  priceRoleText:`元の料金 ￥${jpy} 現在の料金 ￥${member}`,conditionsText:'返金不可',oneRoomOptionText:`1 (￥${member})`,policyControlId:`policyModal_${blockId}`,policyContainerId:`policyModal_${blockId}`,
  policyText:'お食事は含まれておりません。返金不可。',taxDetails:[{label:'込',details:'消費税/VAT10 % 、1名/1泊につき¥150の入湯税'}]};
 return sealBookingRateCellCapture({schema:'ZMI_BOOKING_RATE_CELLS_V1',parserVersion:'booking-rate-cell-v3',propertySlug:slug,observedAt:at,request:{checkin:scope.checkin,checkout:scope.checkout,adults:2,children:0,rooms:1,currency:'JPY'},
  requestUrlMatches:true,displayedCheckin:scope.checkin,displayedCheckout:scope.checkout,displayedParty:'宿泊人数と部屋数。選択済みの内容：大人2名 · 子供0名 · 1部屋',cells:[cell],problems:[],blockReason:null,blockStateVerified:true});
}
const reseal=(c:BookingRateCellCapture)=>{const {captureSha256,...base}=c;return sealBookingRateCellCapture(base);};
const changeCell=(c:BookingRateCellCapture,x:Partial<BookingRateCell>)=>reseal({...c,cells:[{...c.cells[0]!,...x}]});
it('matches exact product/condition facts while three facilities remain one independent operating-group observation',()=>{
 const captures=[cap(),cap('onsen-amp-stay-oakhill',40000),cap('hammond-takamiya',60000),cap('rurikura-resort',80000)],before=JSON.stringify(captures);
 const r=buildBookingComparableQuoteFacts([...captures,captures[1]!],scope);
 expect(r).toMatchObject({conditionMatched:true,independentGroups:1,commercialBasisAccepted:false,marketPriceAuthority:false,mirrorValidation:'REQUIRED_SEPARATELY',allMandatoryTaxCoverage:'NOT_ESTABLISHED'});
 expect(r.groups).toEqual([expect.objectContaining({propertyCount:3,selectedDeclaredGrossMedianJpy:60000})]);expect(r.facts).toHaveLength(4);
 expect(r.own).toMatchObject({planJpy:50000,memberDisplayedJpy:45000,selectedDeclaredGrossJpy:50000});expect(JSON.stringify(captures)).toBe(before);
});
it('normalizes only explicitly declared excluded onsen tax, without adding an included tax twice',()=>{
 const peer=changeCell(cap('onsen-amp-stay-oakhill',40000),{taxDetails:[{label:'別',details:'1名/1泊につき¥150の入湯税'}]});
 const r=buildBookingComparableQuoteFacts([cap(),peer],scope);expect(r.groups[0]!.selectedDeclaredGrossMedianJpy).toBe(40300);
 expect(r.own!.selectedDeclaredGrossJpy).toBe(50000);
});
it('rejects a different cancellation deadline even when the broad refundable category matches',()=>{
 const a=changeCell(cap(),{policyText:'お食事は含まれておりません。60日前までキャンセル無料。'}),b=changeCell(cap('onsen-amp-stay-oakhill'),{policyText:'お食事は含まれておりません。14日前までキャンセル無料。'});
 const r=buildBookingComparableQuoteFacts([a,b],scope);expect(r.conditionMatched).toBe(false);expect(r.exclusions.ECONOMIC_CONDITIONS_NOT_EXACTLY_MATCHED).toBe(1);
});
it('does not revive an old quote after a newer blocked, empty, problem or invalid-seal capture',()=>{
 for(const c of [reseal({...cap('onsen-amp-stay-oakhill',40000,'2026-10-25T01:30:00Z'),cells:[]}),
  reseal({...cap('onsen-amp-stay-oakhill',40000,'2026-10-25T01:30:00Z'),blockReason:'rate_limited_429'}),
  reseal({...cap('onsen-amp-stay-oakhill',40000,'2026-10-25T01:30:00Z'),problems:['RATE_POLICY_UNVERIFIED']}),
  {...cap('onsen-amp-stay-oakhill',40000,'2026-10-25T01:30:00Z'),captureSha256:'0'.repeat(64)}] as BookingRateCellCapture[]){
  const r=buildBookingComparableQuoteFacts([cap(),cap('onsen-amp-stay-oakhill',40000),c],scope);expect(r.groups).toHaveLength(0);expect(r.conditionMatched).toBe(false);
 }
});
it('uses as-of knowledge and TTL rather than the date in the filename',()=>{
 const r=buildBookingComparableQuoteFacts([cap(),cap('onsen-amp-stay-oakhill',40000,'2026-10-25T03:00:00Z'),cap('hammond-takamiya',40000,'2026-10-23T00:00:00Z')],scope);
 expect(r.independentGroups).toBe(0);expect(r.exclusions).toMatchObject({NOT_KNOWN_ASOF:1,QUOTE_EXPIRED:1});
});
it('rejects conflicting latest captures independent of input order',()=>{
 const a=cap('onsen-amp-stay-oakhill',40000),b=cap('onsen-amp-stay-oakhill',60000);
 for(const values of [[a,b],[b,a]]){const r=buildBookingComparableQuoteFacts([cap(),...values],scope);expect(r.exclusions.LATEST_CAPTURE_CONFLICT).toBe(1);expect(r.independentGroups).toBe(0);}
});
it('does not fabricate no-discount, a local tax, public guest eligibility or a comparison for an unreviewed product',()=>{
 for(const [x,why] of [
  [{priceRoleText:'￥50000',priceText:'￥50000 税・手数料込',oneRoomOptionText:'1 (￥50000)'},'EXPLICIT_BEFORE_MEMBER_PRICE_ABSENT'],
  [{taxDetails:[]},'SELECTED_LOCAL_TAX_UNKNOWN'],
  [{blockId:'8888_1_2_0_0'},'PRODUCT_NOT_IN_EXPLICIT_COHORT']
 ] as const){const r=buildBookingComparableQuoteFacts([cap(),changeCell(cap('onsen-amp-stay-oakhill'),x as Partial<BookingRateCell>)],scope);expect(r.groups).toHaveLength(0);expect(r.exclusions[why]).toBeGreaterThan(0);}
});
it('keeps served year, people and one-night scope exact',()=>{
 for(const peer of [reseal({...cap('onsen-amp-stay-oakhill'),displayedCheckin:'2026-01-25'}),reseal({...cap('onsen-amp-stay-oakhill'),request:{...cap().request,adults:3 as 2}})])expect(buildBookingComparableQuoteFacts([cap(),peer],scope).conditionMatched).toBe(false);
 expect(()=>buildBookingComparableQuoteFacts([cap()],{...scope,checkout:'2027-01-27'})).toThrow('COMPARABLE_SCOPE');
});
it('excludes unknown ownership and never counts it as an independent vote',()=>{
 const extra={propertySlug:'unknown-property',roomId:'9999',ratePlanId:'1',productCohort:'TEST_TWIN'};
 const r=buildBookingComparableQuoteFacts([cap(),cap('unknown-property')],{...scope,products:[...scope.products,extra]});
 expect(r.independentGroups).toBe(0);expect(r.exclusions.OPERATING_GROUP_UNKNOWN).toBe(1);
});
it('requires an explicit single cohort and the known own room, and detects own and peer product ambiguity',()=>{
 expect(()=>buildBookingComparableQuoteFacts([cap()],{...scope,products:[{...scope.products[0]!,roomId:'123'}]})).toThrow('COMPARABLE_PRODUCT_MAPPING');
 expect(()=>buildBookingComparableQuoteFacts([cap()],{...scope,products:[scope.products[0]!,{...scope.products[1]!,productCohort:'OTHER'}]})).toThrow('COMPARABLE_OWN_COHORT');
 const c=cap(),second={...c.cells[0]!,blockId:'1655515709_2_2_0_0',policyControlId:'policyModal_1655515709_2_2_0_0',policyContainerId:'policyModal_1655515709_2_2_0_0'};
 const r=buildBookingComparableQuoteFacts([reseal({...c,cells:[c.cells[0]!,second]}),cap('onsen-amp-stay-oakhill')],{...scope,products:[...scope.products,{...scope.products[0]!,ratePlanId:'2'}]});
 expect(r.own).toBeNull();expect(r.exclusions.OWN_PRODUCT_AMBIGUOUS).toBe(1);expect(r.conditionMatched).toBe(false);
});
it('has explicit record/text/mapping/time budgets and stable evidence hashes',()=>{
 expect(()=>buildBookingComparableQuoteFacts(Array.from({length:1001},()=>cap()),scope)).toThrow('COMPARABLE_SCOPE_OR_BUDGET');
 expect(()=>buildBookingComparableQuoteFacts([changeCell(cap(),{roomText:'a'.repeat(4001)})],scope)).toThrow('COMPARABLE_CELL_SHAPE');
 expect(()=>buildBookingComparableQuoteFacts([cap()],{...scope,maxAgeHours:NaN})).toThrow('COMPARABLE_SCOPE_OR_BUDGET');
 expect(buildBookingComparableQuoteFacts([cap()],scope).factsSha256).toMatch(/^[a-f0-9]{64}$/u);
});

import {expect,it} from 'vitest';
import type {Page} from 'playwright';
import {sealBookingRateCellCapture,deriveBookingRateCell,deriveLocalTaxDetail,captureBookingRateCells,type BookingRateCell} from '../src/services/bookingRateCellEvidence';
const cell:BookingRateCell={blockId:'1655515709_445461931_2_0_0',roomName:'スタンダード ツインルーム ソファ付',roomText:'スタンダード ツインルーム ソファ付 16m² シングルベッド1台',occupancyText:'人数: 2',priceText:'￥51,295 ￥46,166 元の料金 ￥51,295 現在の料金 ￥46,166 ログインしてこの会員限定料金を利用しましょう 税・手数料込 10%OFF',conditionsText:'2026年11月4日前までキャンセル無料',oneRoomOptionText:'1 (￥46,166)',policyControlId:'policyModal_1655515709_445461931_2_0_0',policyContainerId:'policyModal_1655515709_445461931_2_0_0',policyText:'お食事は含まれておりません。到着日の60日前の前日までは、無料でキャンセルできます。60日前以降50%、ノーショー100%。'};
const capture=(c=cell)=>sealBookingRateCellCapture({schema:'ZMI_BOOKING_RATE_CELLS_V1',parserVersion:'booking-rate-cell-v2',propertySlug:'xi-raku',observedAt:'2026-10-24T19:00:00Z',request:{checkin:'2027-01-03',checkout:'2027-01-04',adults:2,children:0,rooms:1,currency:'JPY'},requestUrlMatches:true,displayedCheckin:'2027-01-03',displayedCheckout:'2027-01-04',displayedParty:'宿泊人数と部屋数。選択済みの内容：大人2名 · 子供0名 · 1部屋',cells:[c],problems:[],blockReason:null,blockStateVerified:true});
it('binds room/rate/occupancy, explicit before/member prices, tax, room-only and cancellation terms without declaring market authority',()=>{
 const x=deriveBookingRateCell(capture(),cell);expect(x).toMatchObject({roomId:'1655515709',ratePlanId:'445461931',currentDisplayedJpy:46166,prePromotionPlanJpy:51295,memberConditional:true,meal:'ROOM_ONLY',refund:'CONDITIONAL_REFUNDABLE',tax:'DISPLAYED_TAX_FEES_INCLUDED',promotion:'MEMBER_CONDITIONAL_PAIR',localTaxTreatment:'UNKNOWN',tupleAndProductBound:true,marketPriceEligible:false});expect(x.cancellationTerms).toContain('60日前');
});
for(const [label,change,reason] of [
 ['other occupancy',{blockId:'1655515709_445461931_3_0_0'},'NOT_EXACT_TWO_ADULT_RATE_CELL'],
 ['mixed price roles',{priceText:'￥51,295 ￥46,166 税・手数料込'},'PRICE_ROLE_AMBIGUOUS_OR_INVALID'],
 ['option mismatch',{oneRoomOptionText:'1 (￥100)'},'ONE_ROOM_PRICE_NOT_CONFIRMED'],
 ['no meal proof',{policyText:'キャンセル無料'},'MEAL_UNKNOWN'],
 ['missing policy',{policyText:null},'SELECTED_POLICY_NOT_CAPTURED'],
 ['unbound policy',{policyControlId:'policyModal_OTHER'},'SELECTED_POLICY_NOT_CAPTURED'],
 ['cross-room prefix',{policyControlId:'policyModal_91655515709_445461931_2_0_0'},'SELECTED_POLICY_NOT_CAPTURED'],
 ['other visible container',{policyContainerId:'policyModal_OTHER'},'SELECTED_POLICY_NOT_CAPTURED'],
 ['unknown tax',{priceText:'￥51,295'},'TAX_BASIS_UNKNOWN']
] as const)it(`fails closed: ${label}`,()=>{const c={...cell,...change},x=deriveBookingRateCell(capture(c),c);expect(x.tupleAndProductBound).toBe(false);expect(x.reasons).toContain(reason);});
it('never interprets absence of promotion text as NONE',()=>{const c={...cell,priceText:'￥51,295 税・手数料込',oneRoomOptionText:'1 (￥51,295)'};expect(deriveBookingRateCell(capture(c),c).promotion).toBe('UNCLASSIFIED');});
it('a different year, unsealed change or product copied from another capture is not accepted',()=>{
 const c=capture();expect(deriveBookingRateCell({...c,displayedCheckin:'2026-01-03'},cell).reasons).toContain('SERVED_TUPLE_NOT_CONFIRMED');
 expect(deriveBookingRateCell({...c,displayedCheckin:'2026-01-03'},cell).reasons).toContain('CAPTURE_SEAL_INVALID');
 expect(deriveBookingRateCell(c,{...cell,priceText:'￥100'}).reasons).toContain('CELL_NOT_UNIQUE_IN_CAPTURE');
});
it('unknown served destination never receives any UI action',async()=>{
 const page={url:()=> 'https://example.test/'} as Page;
 const c=await captureBookingRateCells(page,{propertySlug:'xi-raku',checkin:'2027-01-03',checkout:'2027-01-04',observedAt:'2026-10-24T19:00:00Z'});
 expect(c.cells).toEqual([]);expect(c.problems).toEqual(['SERVED_URL_TUPLE_MISMATCH_NO_INTERACTION']);
});
it('v3 separates an explicitly selected price wrapper from the included per-person onsen tax amount',()=>{
 const c={...cell,priceText:'料金 ￥58,300 税・手数料込 込 消費税/VAT10 % 、１名/１泊につき¥150の入湯税',priceRoleText:'￥58,300 料金 ￥58,300 税・手数料込',oneRoomOptionText:'1 (￥58,300)',
  taxDetails:[{label:'込',details:'消費税/VAT10 % 、１名/１泊につき¥150の入湯税'}],policyText:'お食事は含まれておりません。一部返金可。キャンセル料は50%、無断不泊は100%。'};
 const {captureSha256,...base}=capture(c),cap=sealBookingRateCellCapture({...base,parserVersion:'booking-rate-cell-v3'});
 expect(deriveBookingRateCell(cap,c)).toMatchObject({currentDisplayedJpy:58300,localTaxTreatment:'EXPLICIT_INCLUDED',localTaxKind:'ONSEN_TAX',localTaxPerAdultNightJpy:150,taxScope:'SELECTED_ROW_DECLARED_ITEMS_ONLY',refund:'PARTIAL_REFUNDABLE',tupleAndProductBound:true,promotion:'UNCLASSIFIED',marketPriceEligible:false});
 // Old captures are not silently upgraded to the new DOM evidence contract.
 expect(deriveBookingRateCell(capture(c),c).localTaxTreatment).toBe('UNKNOWN');
 expect(deriveBookingRateCell(capture(c),c).currentDisplayedJpy).toBeNull();
 const missing={...c,priceRoleText:''},{captureSha256:oldSha,...missingBase}=capture(missing);expect(deriveBookingRateCell(sealBookingRateCellCapture({...missingBase,parserVersion:'booking-rate-cell-v3'}),missing).tupleAndProductBound).toBe(false);
});
it('does not infer a missing local tax, an unlabeled charge, multiple contradictory tax rows or an all-tax guarantee',()=>{
 for(const rows of [undefined,[],[{label:'込',details:'消費税/VAT10%'}],[{label:'?',details:'1名/1泊につき¥150の入湯税'}],[{label:'込',details:'1名/1泊につき¥150の入湯税。ただし別途課税'}],[{label:'込',details:'1名/1泊につき¥150の入湯税'},{label:'別',details:'1名/1泊につき¥150の入湯税'}]])expect(deriveLocalTaxDetail(rows).localTaxTreatment).toBe('UNKNOWN');
 expect(deriveLocalTaxDetail([{label:'別',details:'1名/1泊につき¥150の入湯税'}])).toMatchObject({localTaxTreatment:'EXPLICIT_EXCLUDED',localTaxPerAdultNightJpy:150});
});
it('keeps conflicting cancellation categories unknown rather than picking the most favorable interpretation',()=>{
 const c={...cell,policyText:'お食事は含まれておりません。キャンセル無料。返金不可。'};const x=deriveBookingRateCell(capture(c),c);
 expect(x.refund).toBe('UNKNOWN');expect(x.reasons).toContain('CANCELLATION_UNKNOWN');
});

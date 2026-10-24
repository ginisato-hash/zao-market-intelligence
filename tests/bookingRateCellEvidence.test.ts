import {expect,it} from 'vitest';
import type {Page} from 'playwright';
import {sealBookingRateCellCapture,deriveBookingRateCell,captureBookingRateCells,type BookingRateCell} from '../src/services/bookingRateCellEvidence';
const cell:BookingRateCell={blockId:'1655515709_445461931_2_0_0',roomName:'スタンダード ツインルーム ソファ付',roomText:'スタンダード ツインルーム ソファ付 16m² シングルベッド1台',occupancyText:'人数: 2',priceText:'￥51,295 ￥46,166 元の料金 ￥51,295 現在の料金 ￥46,166 ログインしてこの会員限定料金を利用しましょう 税・手数料込 10%OFF',conditionsText:'2026年11月4日前までキャンセル無料',oneRoomOptionText:'1 (￥46,166)',policyControlId:'policyModal_1655515709_445461931_2_0_0',policyText:'お食事は含まれておりません。到着日の60日前の前日までは、無料でキャンセルできます。60日前以降50%、ノーショー100%。'};
const capture=(c=cell)=>sealBookingRateCellCapture({schema:'ZMI_BOOKING_RATE_CELLS_V1',parserVersion:'booking-rate-cell-v1',propertySlug:'xi-raku',observedAt:'2026-10-24T19:00:00Z',request:{checkin:'2027-01-03',checkout:'2027-01-04',adults:2,children:0,rooms:1,currency:'JPY'},requestUrlMatches:true,displayedCheckin:'2027-01-03',displayedCheckout:'2027-01-04',displayedParty:'宿泊人数と部屋数。選択済みの内容：大人2名 · 子供0名 · 1部屋',cells:[c],problems:[]});
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

import {it,expect} from 'vitest';
import {deriveBookingPrepayment} from '../src/services/bookingPaymentTerms';
import {diagnoseBookingFixedProductCapture} from '../src/services/bookingFixedProductDiagnostic';
import {sealBookingRateCellCapture,type BookingRateCell} from '../src/services/bookingRateCellEvidence';
// Synthetic values only; the saved original capture replay is a protected, separately pinned offline packet.
function fixture(change:Partial<BookingRateCell>={},problems:string[]=[]){
 const cell:BookingRateCell={blockId:'123_456_2_0_0',roomName:'ツインルーム',roomText:'ツインルーム シングルベッド2台',occupancyText:'人数: 2',priceText:'￥10,000 税・手数料込',priceRoleText:'￥10,000',oneRoomOptionText:'1 (￥10,000)',conditionsText:'返金不可',policyControlId:'policyModal_123_456_2_0_0',policyContainerId:'policyModal_123_456_2_0_0',policyText:'お食事は含まれておりません。返金不可。宿泊料金の全額が予約時に請求されます。',...change};
 return sealBookingRateCellCapture({schema:'ZMI_BOOKING_RATE_CELLS_V1',parserVersion:'booking-rate-cell-v3',propertySlug:'synthetic-property',observedAt:'2026-10-29T00:00:00Z',request:{checkin:'2027-01-15',checkout:'2027-01-16',adults:2,children:0,rooms:1,currency:'JPY'},requestUrlMatches:true,displayedCheckin:'2027-01-15',displayedCheckout:'2027-01-16',displayedParty:'大人2名 子供0名 1部屋',cells:[cell],problems,blockReason:null,blockStateVerified:true});
}
it('recognizes the explicit full booking-time charge and the previous explicit full-payment wording',()=>{
 for(const s of ['宿泊料金の全額が予約時に請求されます。','予約時に全額を支払い。','事前に全額を支払う必要があります。','前払い • オンライン決済 宿泊料金の全額が予約時に請求されます。'])expect(deriveBookingPrepayment(s)).toBe('REQUIRED');
});
it('does not misclassify an optional booking-time payment or a future payment deadline as required',()=>{
 for(const s of ['その時点で自動的に請求を受けるか、予約時に支払うかをご選択いただけます。','2027年3月27日になるまでお支払い不要。','予約時に支払いません。','宿泊料金の全額が予約時に請求されません。',null])expect(deriveBookingPrepayment(s)).toBe('UNKNOWN');
});
it('keeps conflicting required/exempt terms unknown',()=>{expect(deriveBookingPrepayment('宿泊料金の全額が予約時に請求されます。事前支払い不要。')).toBe('UNKNOWN');expect(deriveBookingPrepayment('前払い不要。')).toBe('NOT_REQUIRED');});
it('does not treat negated or time-limited exemption language as unconditional no-prepayment',()=>{
 for(const s of ['前払い不要ではありません。','事前支払い不要とは限りません。','2027年3月27日までは前払い不要。翌日に宿泊料金が請求されます。','前払い不要。翌日に宿泊料金が請求されます。','原則として前払い不要。','宿泊料金の全額が予約時に請求されますとは限りません。','原則として宿泊料金の全額が予約時に請求されます。'])expect(deriveBookingPrepayment(s)).toBe('UNKNOWN');
 expect(deriveBookingPrepayment('前払い • 事前支払い不要。')).toBe('NOT_REQUIRED');
});
it('never treats two requested guests, two beds or a twin name as proven maximum capacity',()=>{const r=diagnoseBookingFixedProductCapture(fixture());expect(r.cells[0]?.primitiveBound).toBe(true);expect(r.cells[0]?.explicitMaxAdults).toBeNull();expect(r.cells[0]?.firstMissingObservedFact).toBe('EXPLICIT_MAXIMUM_ADULTS');expect(r.priceEligible).toBe(false);});
it('records an explicit adult maximum without inventing fixed-panel acceptance or price eligibility',()=>{const r=diagnoseBookingFixedProductCapture(fixture({roomText:'ツインルーム 大人の定員2名'}));expect(r.cells[0]?.explicitMaxAdults).toBe(2);expect(r.cells[0]?.acceptedPanelProduct).toBe(false);expect(r.cells[0]?.priceEligible).toBe(false);});
it('refuses conflicting capacity facts and a product explicitly for more than two adults',()=>{expect(diagnoseBookingFixedProductCapture(fixture({roomText:'ツインルーム 大人の定員2名 Max adults: 3'})).cells[0]?.explicitMaxAdults).toBeNull();expect(diagnoseBookingFixedProductCapture(fixture({roomText:'ツインルーム 大人の定員3名'})).cells[0]?.missingObservedFacts).toContain('MAXIMUM_ADULTS_NOT_TWO');});
it('does not truncate range, choice, negated or conditional capacity facts to a maximum of two',()=>{
 for(const roomText of ['ツインルーム 大人の定員2名～3名','ツインルーム 大人の定員2名または3名','ツインルーム 大人の定員2名ではありません','ツインルーム 通常は大人の定員2名','ツインルーム Max adults: 2-3','ツインルーム 大人の定員2名（または3名）','ツインルーム Max adults: 2 (or 3)'])expect(diagnoseBookingFixedProductCapture(fixture({roomText})).cells[0]?.explicitMaxAdults).toBeNull();
});
it('preserves capture-level policy failure even if one cell has valid primitive terms',()=>{const r=diagnoseBookingFixedProductCapture(fixture({},['RATE_POLICY_UNVERIFIED']));expect(r.cells[0]?.primitiveBound).toBe(true);expect(r.firstCaptureBlocker).toBe('RATE_POLICY_UNVERIFIED');expect(r.priceEligible).toBe(false);});
it('does not promote member prices or selected tax items into public all-mandatory totals',()=>{const r=diagnoseBookingFixedProductCapture(fixture({priceText:'￥10,000 税・手数料込 ログインしてこの会員限定料金を利用しましょう',taxDetails:[{label:'込',details:'1泊につき¥150の入湯税'}]}));expect(r.cells[0]?.memberConditional).toBe(true);expect(r.cells[0]?.allMandatoryTotalProved).toBe(false);expect(r.cells[0]?.localTaxPerAdultNightJpy).toBeNull();expect(r.cells[0]?.missingObservedFacts).toContain('MEMBER_CONDITIONAL_PRICE');});
it('retains empty-capture evidence without substituting a different room or a zero price',()=>{const f=fixture(),r=diagnoseBookingFixedProductCapture(sealBookingRateCellCapture({...f,cells:[],problems:['NO_EXACT_RATE_CELL_CAPTURED']}));expect(r.emptyCapture).toBe(true);expect(r.cells).toEqual([]);expect(r.firstCaptureBlocker).toBe('NO_EXACT_RATE_CELL_CAPTURED');expect(r.priceEligible).toBe(false);});
it('retains broken seal, policy and occupancy evidence as reasons, not relaxed success',()=>{const f=fixture({policyText:null,occupancyText:'人数不明'});const r=diagnoseBookingFixedProductCapture({...f,captureSha256:'0'.repeat(64)});expect(r.cells[0]?.primitiveReasons).toEqual(expect.arrayContaining(['CAPTURE_SEAL_INVALID','ROOM_OR_OCCUPANCY_UNBOUND','SELECTED_POLICY_NOT_CAPTURED','MEAL_UNKNOWN','CANCELLATION_UNKNOWN']));});

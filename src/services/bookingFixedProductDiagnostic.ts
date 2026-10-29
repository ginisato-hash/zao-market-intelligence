// Pure offline diagnostics, never an admission route. No price estimation, product substitution or authority.
import {deriveBookingRateCell,type BookingRateCellCapture} from './bookingRateCellEvidence';
import {deriveBookingPrepayment} from './bookingPaymentTerms';
import {hasExplicitAllMandatoryTotal} from './bookingTwoPersonMarketAdmission';
import {digest} from './marketRowPriceQuality';

/** A requested party, room name or bed count is not evidence of maximum adult capacity. */
function explicitAdultMaximum(roomText:string,roomName:string):number|null{
 const name=roomName.normalize('NFKC'),clauses=roomText.normalize('NFKC').split(/[。.;；\n]/u)
  .map(c=>c.trim()).map(c=>name&&c.startsWith(name)?c.slice(name.length).trim():c)
  .filter(c=>/大人(?:の)?(?:最大定員|最大人数|定員)|最大大人|最大収容大人|Max(?:imum)? adults/iu.test(c));
 const matches=clauses.map(c=>/^(?:(?:大人(?:の)?(?:最大定員|最大人数|定員)|最大大人|最大収容大人(?:人数)?)\s*[:：]?\s*(\d{1,2})\s*名|Max(?:imum)? adults\s*:\s*(\d{1,2}))$/iu.exec(c));
 if(matches.some(m=>m===null))return null;
 const values=matches.map(m=>Number(m![1]??m![2]));
 const unique=[...new Set(values)];return unique.length===1&&unique[0]!>0&&unique[0]!<=30?unique[0]!:null;
}
export function diagnoseBookingFixedProductCapture(cap:BookingRateCellCapture){
 if(cap.cells.length>5||cap.cells.some(c=>[c.roomText,c.priceText,c.policyText??''].some(s=>s.length>4000)))throw Error('DIAGNOSTIC_CAPTURE_BUDGET');
 const cells=cap.cells.map(cell=>{
  const d=deriveBookingRateCell(cap,cell),maxAdults=explicitAdultMaximum(cell.roomText,cell.roomName),allMandatory=hasExplicitAllMandatoryTotal(cell.priceText),prepayment=deriveBookingPrepayment(cell.policyText);
  const missing:string[]=[];
  if(d.roomId===null||d.ratePlanId===null)missing.push('EXACT_ROOM_RATE_ID');
  if(maxAdults===null)missing.push('EXPLICIT_MAXIMUM_ADULTS');else if(maxAdults!==2)missing.push('MAXIMUM_ADULTS_NOT_TWO');
  if(!d.tupleAndProductBound)missing.push(...d.reasons);
  if(!allMandatory)missing.push('ALL_MANDATORY_TOTAL_NOT_PROVED');
  if(d.localTaxTreatment!=='EXPLICIT_INCLUDED'||d.localTaxPerAdultNightJpy===null)missing.push('LOCAL_TAX_PER_ADULT_NIGHT_NOT_PROVED');
  const publicPrice=!d.memberConditional&&/一般公開料金|すべてのゲスト|ログイン不要/u.test(cell.priceText);
  if(!publicPrice)missing.push(d.memberConditional?'MEMBER_CONDITIONAL_PRICE':'PUBLIC_PRICE_NOT_PROVED');
  if(d.meal!=='ROOM_ONLY')missing.push('ROOM_ONLY_NOT_PROVED');
  if(!['NON_REFUNDABLE','CONDITIONAL_REFUNDABLE'].includes(d.refund))missing.push('CANCELLATION_NOT_PROVED');
  if(prepayment==='UNKNOWN')missing.push('PREPAYMENT_NOT_PROVED');
  return {cellSha256:digest(cell),roomId:d.roomId,ratePlanId:d.ratePlanId,requestedAdults:2 as const,explicitMaxAdults:maxAdults,
   primitiveBound:d.tupleAndProductBound,primitiveReasons:d.reasons,currentDisplayedJpy:d.currentDisplayedJpy,
   oneRoomPriceConfirmed:!d.reasons.includes('ONE_ROOM_PRICE_NOT_CONFIRMED')&&d.currentDisplayedJpy!==null,
   selectedPolicyCaptured:!d.reasons.includes('SELECTED_POLICY_NOT_CAPTURED'),taxBasis:d.tax,allMandatoryTotalProved:allMandatory,
   localTaxTreatment:d.localTaxTreatment,localTaxPerAdultNightJpy:d.localTaxPerAdultNightJpy,
   memberConditional:d.memberConditional,publicPriceProved:publicPrice,meal:d.meal,cancellation:d.refund,prepayment,
   missingObservedFacts:[...new Set(missing)],firstMissingObservedFact:missing[0]??null,
   acceptedPanelProduct:false as const,priceEligible:false as const};
 });
 return {schema:'BOOKING_FIXED_PRODUCT_OFFLINE_DIAGNOSTIC_V1' as const,captureSha256:cap.captureSha256,
  captureProblems:[...cap.problems],firstCaptureBlocker:cap.problems[0]??null,emptyCapture:cap.cells.length===0,cells,
  fixedPanelAcceptance:'NOT_PROVED_BY_THIS_DIAGNOSTIC' as const,priceEligible:false as const};
}

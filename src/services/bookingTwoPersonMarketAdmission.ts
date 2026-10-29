// One route only: already accepted canonical row + SAME selected source capture + exact mirror identity.
// Missing commercial facts remain ineligible. No alternate CSV/usable-flag bypass or extra browser request.
import {createHash} from 'node:crypto';
import {deriveBookingRateCell,type BookingRateCellCapture} from './bookingRateCellEvidence';
import {marketConditionKey,type PanelProduct,type TwoPersonObservation} from './marketTwoPersonCurve';
import {digest,instant,type QualityEntry} from './marketRowPriceQuality';
import type {HistoryRow} from './localHistorySchemaDesign';
import {deriveBookingPrepayment} from './bookingPaymentTerms';
export function admitCanonicalBookingTwoPerson(input:{row:HistoryRow;mirrorIdentity:{rowId:string;rowHash:string}|null;
 capture:BookingRateCellCapture;rawCaptureBytes:Buffer;independentRawCaptureSha256:string;pageFinalBlockReason:string|null;pageFinalBlockStateVerified:boolean;
 product:PanelProduct;standardProductProofVerified:boolean;ingestedAt:string}){
 const no=(reason:string)=>({status:'PRICE_INELIGIBLE' as const,reason,observation:null,quality:null});
 const {row:r,capture:c,product:p}=input;
 if(r.source!=='booking'||!r.propertyIdentityMatch||r.sourceSlugOrCode!==c.propertySlug||p.sourcePropertyId!==c.propertySlug||p.source!=='booking'
  ||r.checkin!==c.request.checkin||r.checkout!==c.request.checkout||r.groupAdults!==2||r.groupChildren!==0||r.noRooms!==1||r.stayNights!==1||r.currency!=='JPY')return no('CANONICAL_ROW_TUPLE_OR_PRODUCT_IDENTITY');
 if(!input.mirrorIdentity||input.mirrorIdentity.rowId!==r.rowId||input.mirrorIdentity.rowHash!==r.rowHash)return no('CANONICAL_MIRROR_ROW_NOT_PROVED');
 if(!input.standardProductProofVerified||p.standardProduct.maxAdults!==2||!['DOUBLE','TWIN'].includes(p.standardProduct.kind))return no('STANDARD_TWO_PERSON_PRODUCT_NOT_PROVED');
 if(input.rawCaptureBytes.length>64000||createHash('sha256').update(input.rawCaptureBytes).digest('hex')!==input.independentRawCaptureSha256)return no('SOURCE_RAW_RECEIPT_MISMATCH');
 let raw:unknown;try{raw=JSON.parse(input.rawCaptureBytes.toString('utf8'));}catch{return no('SOURCE_CAPTURE_UNPARSEABLE');}
 if(digest(raw)!==digest(c)||c.problems.length||input.pageFinalBlockReason!==null||!input.pageFinalBlockStateVerified)return no('SOURCE_CAPTURE_DRIFT_OR_FINAL_BLOCK');
 if(!Number.isFinite(instant(input.ingestedAt))||instant(c.observedAt)<instant(r.collectedAtJst)||instant(c.observedAt)>instant(input.ingestedAt)||instant(c.observedAt)-instant(r.collectedAtJst)>2*3600000||instant(input.ingestedAt)-instant(c.observedAt)>2*3600000)return no('SOURCE_CAPTURE_TIME');
 const cells=c.cells.filter(x=>{const a=x.blockId.split('_');return a[0]===p.productId&&a[1]===p.ratePlanId;});
 if(cells.length!==1)return no('FIXED_PRODUCT_NOT_UNIQUE_OR_UNAVAILABLE');
 const cell=cells[0]!,d=deriveBookingRateCell(c,cell);
 if(!d.tupleAndProductBound)return no('SELECTED_PRODUCT_FACTS_UNVERIFIED');
 // A selected-row tax item is not proof that ALL mandatory fees are included. Require the explicit global declaration.
 if(!hasExplicitAllMandatoryTotal(cell.priceText)||d.localTaxTreatment!=='EXPLICIT_INCLUDED'||d.localTaxPerAdultNightJpy===null)return no('ALL_MANDATORY_TOTAL_NOT_PROVED');
 if(d.memberConditional||!/一般公開料金|すべてのゲスト|ログイン不要/u.test(cell.priceText))return no('PUBLIC_PRICE_NOT_PROVED');
 if(d.meal!=='ROOM_ONLY'||!['NON_REFUNDABLE','CONDITIONAL_REFUNDABLE'].includes(d.refund))return no('CONDITIONS_NOT_KNOWN');
 const prepayment=deriveBookingPrepayment(cell.policyText);
 if(prepayment==='UNKNOWN')return no('PREPAYMENT_UNKNOWN_OR_CONFLICT');
 if(d.currentDisplayedJpy!==r.sourcePrimaryPrice||d.currentDisplayedJpy!==r.normalizedTotalPrice)return no('FIXED_PRODUCT_NOT_THE_CANONICAL_PRICE');
 const conditions={meal:'ROOM_ONLY' as const,cancellation:d.refund==='NON_REFUNDABLE'?'NON_REFUNDABLE' as const:'REFUNDABLE' as const,
  prepayment,discount:d.promotion==='EXPLICIT_PRICE_PAIR'?'PUBLIC_PROMO' as const:'PUBLIC' as const,tax:'ALL_MANDATORY_INCLUDED' as const};
 const conditionsVersion='terms_'+digest(cell.policyText),conditionKey=marketConditionKey(conditions,conditionsVersion);
 if(conditionKey!==p.conditionKey)return no('CONDITIONS_CHANGED_NEW_SERIES_REQUIRED');
 const observation:TwoPersonObservation={rowId:r.rowId,rowHash:r.rowHash,propertyId:p.propertyId,sourcePropertyId:p.sourcePropertyId,source:'booking',productId:p.productId,ratePlanId:p.ratePlanId,conditionKey,conditionsVersion,
  stayDate:r.checkin,observedAt:c.observedAt,ingestedAt:input.ingestedAt,receiptSha256:input.independentRawCaptureSha256,adults:2,children:0,rooms:1,nights:1,currency:'JPY',
  ...conditions,result:'AVAILABLE',totalJpy:d.currentDisplayedJpy};
 const quality:QualityEntry={rowId:r.rowId,rowHash:r.rowHash,status:'VERIFIED_SOURCE',observedAt:observation.observedAt,ingestedAt:observation.ingestedAt,receiptSha256:observation.receiptSha256,observationSha256:digest(observation)};
 return {status:'VERIFIED_CANONICAL_TWO_PERSON_FACT' as const,reason:'SOURCE_RECEIPT_AND_CANONICAL_MIRROR_IDENTITY_MATCH',observation,quality};
}

export function hasExplicitAllMandatoryTotal(text:string):boolean{
 const taxText=text.normalize('NFKC');
 const affirmative=/(?:すべての税金と料金|すべての税金[・とおよび]*手数料)が含まれています(?:[。.!！\s]|$)/u.test(taxText);
 const exclusion=/(?:税|手数料|料金|入湯税)[^。.!！\n]{0,80}(?:含まれません|含まれていません|含まない|別途|別料金|除外|現地(?:で)?支払|含まれておりません)|(?:exclud(?:e[ds]?|ing)|not includ(?:ed|ing)|pay(?:able)? (?:at|on))[^.\n]{0,80}(?:tax|fee|charge)/iu.test(taxText);
 return affirmative&&!exclusion;
}

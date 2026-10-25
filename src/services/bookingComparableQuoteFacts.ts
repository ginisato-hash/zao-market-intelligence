// Pure bridge from selected-product captures to condition-matched quote facts.
// It supplies no commercial policy, price multiplier, market authority or history/DB bypass.
import {createHash} from 'node:crypto';
import {deriveBookingRateCell,type BookingRateCellCapture} from './bookingRateCellEvidence';
import {canonicalJson,K27_T04_REFERENCE} from './marketEvidenceSidecar';
import {marketPropertyGroup,MARKET_PROPERTY_GROUP_VERSION} from './marketPropertyGroups';

const sha=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const instant=(v:string)=>/(Z|[+-]\d\d:\d\d)$/u.test(v)?Date.parse(v):NaN;
const date=(v:string)=>/^\d{4}-\d{2}-\d{2}$/u.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const median=(v:readonly number[])=>{const x=[...v].sort((a,b)=>a-b),i=Math.floor(x.length/2);return x.length%2?x[i]!:(x[i-1]!+x[i]!)/2;};
export interface BookingComparisonProduct {
 propertySlug:string;roomId:string;ratePlanId:string;
 // An externally reviewed economic-product cohort; names/sizes are never classified here.
 productCohort:string;
}
export interface BookingComparisonScope {
 asOf:string;checkin:string;checkout:string;maxAgeHours:number;
 productBasisVersion:string;products:readonly BookingComparisonProduct[];
}
export interface BookingQuoteFact {
 propertySlug:string;roomId:string;ratePlanId:string;captureSha256:string;observedAt:string;ageHours:number;
 role:'OWN'|'COMPARISON_CANDIDATE';groupKey:string|null;productCohort:string;
 adults:2;children:0;rooms:1;nights:1;meal:'ROOM_ONLY';currency:'JPY';
 // Compare the same explicit before-member amount on both sides; unknown promotions are rejected.
 priceRole:'EXPLICIT_PLAN_BEFORE_MEMBER';planJpy:number;memberDisplayedJpy:number;
 selectedDeclaredGrossJpy:number;localTaxTreatment:'EXPLICIT_INCLUDED'|'EXPLICIT_EXCLUDED';
 localTaxPerAdultNightJpy:number;taxScope:'SELECTED_ROW_DECLARED_ITEMS_ONLY';
 cancellationClass:string;cancellationTermsSha256:string;conditionKey:string;
}

/** Minimal bounded capture validation before the existing sealed-source derivation. */
function validateCapture(c:BookingRateCellCapture){
 if(!c||c.schema!=='ZMI_BOOKING_RATE_CELLS_V1'||c.parserVersion!=='booking-rate-cell-v3'||!c.request
  ||typeof c.propertySlug!=='string'||!/^[a-z0-9-]{1,100}$/u.test(c.propertySlug)||typeof c.observedAt!=='string'
  ||!Array.isArray(c.cells)||c.cells.length>5||!Array.isArray(c.problems)||c.problems.length>20)throw Error('COMPARABLE_CAPTURE_SHAPE');
 const strings=['blockId','roomName','roomText','occupancyText','priceText','conditionsText','oneRoomOptionText'] as const;
 for(const x of c.cells){
  if(!x||strings.some(k=>typeof x[k]!=='string'||x[k].length>4000)
   ||[x.priceRoleText,x.policyControlId,x.policyContainerId,x.policyText].some(v=>v!==undefined&&v!==null&&(typeof v!=='string'||v.length>4000))
   ||x.taxDetails!==undefined&&(!Array.isArray(x.taxDetails)||x.taxDetails.length>5||x.taxDetails.some(t=>!t||typeof t.label!=='string'||typeof t.details!=='string'||t.label.length>51||t.details.length>1001)))throw Error('COMPARABLE_CELL_SHAPE');
 }
 if(Buffer.byteLength(JSON.stringify(c))>64000)throw Error('COMPARABLE_CAPTURE_BYTE_BUDGET');
}

export function buildBookingComparableQuoteFacts(captures:readonly BookingRateCellCapture[],scope:BookingComparisonScope){
 const asOf=instant(scope.asOf);
 if(!Number.isFinite(asOf)||!date(scope.checkin)||!date(scope.checkout)||Date.parse(scope.checkout)-Date.parse(scope.checkin)!==86400000
  ||!Number.isFinite(scope.maxAgeHours)||scope.maxAgeHours<=0||scope.maxAgeHours>72
  ||!/^[-A-Za-z0-9_.]{1,100}$/u.test(scope.productBasisVersion)||captures.length>1000||scope.products.length>100)throw Error('COMPARABLE_SCOPE_OR_BUDGET');
 const products=new Map<string,BookingComparisonProduct>(),cohorts=new Set<string>();
 for(const p of scope.products){
  const key=[p.propertySlug,p.roomId,p.ratePlanId].join('|');
  if(!/^[a-z0-9-]{1,100}$/u.test(p.propertySlug)||!/^\d{1,20}$/u.test(p.roomId)||!/^\d{1,20}$/u.test(p.ratePlanId)||!/^[-A-Za-z0-9_.]{1,100}$/u.test(p.productCohort)||products.has(key)
   ||p.propertySlug===K27_T04_REFERENCE.ownSlug&&p.roomId!==K27_T04_REFERENCE.bookingRoomId)throw Error('COMPARABLE_PRODUCT_MAPPING');
  products.set(key,p);cohorts.add(p.productCohort);
 }
 // This report is one explicitly selected own-product cohort. Other rooms need separate evidence, not a pooled vote.
 if(cohorts.size!==1||!scope.products.some(p=>p.propertySlug===K27_T04_REFERENCE.ownSlug&&p.roomId===K27_T04_REFERENCE.bookingRoomId))throw Error('COMPARABLE_OWN_COHORT_REQUIRED');
 const exclusions:Record<string,number>={},drop=(s:string)=>{exclusions[s]=(exclusions[s]??0)+1;};
 const latest=new Map<string,{at:number;capture:BookingRateCellCapture;conflict:boolean}>();let bytes=0;
 for(const c of captures){
  validateCapture(c);bytes+=Buffer.byteLength(JSON.stringify(c));if(bytes>4*1024*1024)throw Error('COMPARABLE_TOTAL_BYTE_BUDGET');
  const at=instant(c.observedAt);
  if(!Number.isFinite(at)){throw Error('COMPARABLE_CAPTURE_TIME_INVALID');}
  if(at>asOf){drop('NOT_KNOWN_ASOF');continue;}
  if(c.request.checkin!==scope.checkin||c.request.checkout!==scope.checkout){drop('OTHER_STAY_TUPLE');continue;}
  const old=latest.get(c.propertySlug);
  if(!old||at>old.at)latest.set(c.propertySlug,{at,capture:c,conflict:false});
  else if(at===old.at&&canonicalJson(c)!==canonicalJson(old.capture))old.conflict=true;
 }
 const facts:BookingQuoteFact[]=[];
 for(const {at,capture:c,conflict} of latest.values()){
  // Never resurrect an older quote after a newer failed, blocked, empty or stale capture.
  if(conflict){drop('LATEST_CAPTURE_CONFLICT');continue;}
  if(asOf-at>scope.maxAgeHours*3600000){drop('QUOTE_EXPIRED');continue;}
  if(c.problems.length){drop('CAPTURE_HAS_PROBLEMS');continue;}
  if(c.request.adults!==2||c.request.children!==0||c.request.rooms!==1||c.request.currency!=='JPY'){drop('PARTY_OR_CURRENCY_MISMATCH');continue;}
  const group=marketPropertyGroup('booking',c.propertySlug);
  if(group.role==='UNKNOWN'){drop('OPERATING_GROUP_UNKNOWN');continue;}
  for(const cell of c.cells){
   const d=deriveBookingRateCell(c,cell),mapping=products.get([c.propertySlug,d.roomId,d.ratePlanId].join('|'));
   if(!mapping){drop('PRODUCT_NOT_IN_EXPLICIT_COHORT');continue;}
   if(!d.tupleAndProductBound){for(const reason of d.reasons)drop(reason);continue;}
   if(d.promotion!=='MEMBER_CONDITIONAL_PAIR'||d.prePromotionPlanJpy===null||d.currentDisplayedJpy===null){drop('EXPLICIT_BEFORE_MEMBER_PRICE_ABSENT');continue;}
   if(d.localTaxTreatment==='UNKNOWN'||d.localTaxPerAdultNightJpy===null){drop('SELECTED_LOCAL_TAX_UNKNOWN');continue;}
   const gross=d.prePromotionPlanJpy+(d.localTaxTreatment==='EXPLICIT_EXCLUDED'?d.localTaxPerAdultNightJpy*2:0);
   if(!Number.isSafeInteger(gross)||gross<=0){drop('NORMALIZED_PRICE_INVALID');continue;}
   const cancellationTermsSha256=sha(d.cancellationTerms);
   // Exact policy text is deliberate: a 60-day and a 14-day cancellation window cannot share a cohort silently.
   const conditionKey=sha([scope.productBasisVersion,mapping.productCohort,2,0,1,1,'ROOM_ONLY','EXPLICIT_PLAN_BEFORE_MEMBER','SELECTED_ROW_DECLARED_ITEMS_ONLY',d.refund,cancellationTermsSha256]);
   facts.push({propertySlug:c.propertySlug,roomId:d.roomId!,ratePlanId:d.ratePlanId!,captureSha256:c.captureSha256,observedAt:c.observedAt,ageHours:(asOf-at)/3600000,
    role:group.role,groupKey:group.groupKey,productCohort:mapping.productCohort,adults:2,children:0,rooms:1,nights:1,meal:'ROOM_ONLY',currency:'JPY',
    priceRole:'EXPLICIT_PLAN_BEFORE_MEMBER',planJpy:d.prePromotionPlanJpy,memberDisplayedJpy:d.currentDisplayedJpy,selectedDeclaredGrossJpy:gross,
    localTaxTreatment:d.localTaxTreatment,localTaxPerAdultNightJpy:d.localTaxPerAdultNightJpy,taxScope:'SELECTED_ROW_DECLARED_ITEMS_ONLY',cancellationClass:d.refund,cancellationTermsSha256,conditionKey});
  }
 }
 const own=facts.filter(x=>x.role==='OWN'),peers=facts.filter(x=>x.role==='COMPARISON_CANDIDATE');
 // No arbitrary own-product or peer-rate selection. Multiple admitted prices require an explicit narrower mapping.
 const ownFact=own.length===1?own[0]!:null;
 if(!ownFact)drop(own.length===0?'OWN_QUOTE_UNAVAILABLE':'OWN_PRODUCT_AMBIGUOUS');
 const properties=new Map<string,BookingQuoteFact[]>();
 for(const p of peers){if(!ownFact||p.conditionKey!==ownFact.conditionKey){drop('ECONOMIC_CONDITIONS_NOT_EXACTLY_MATCHED');continue;}const rows=properties.get(p.propertySlug)??[];rows.push(p);properties.set(p.propertySlug,rows);}
 const groups=new Map<string,BookingQuoteFact[]>();
 for(const rows of properties.values()){
  if(rows.length!==1){drop('PEER_PRODUCT_AMBIGUOUS');continue;}
  const p=rows[0]!,g=groups.get(p.groupKey!)??[];g.push(p);groups.set(p.groupKey!,g);
 }
 const grouped=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([groupKey,rows])=>({groupKey,propertyCount:rows.length,propertySlugs:rows.map(x=>x.propertySlug).sort(),selectedDeclaredGrossMedianJpy:median(rows.map(x=>x.selectedDeclaredGrossJpy)),quoteHashes:rows.map(x=>x.captureSha256).sort()}));
 const base={schema:'ZMI_BOOKING_COMPARABLE_FACTS_V1' as const,asOf:scope.asOf,checkin:scope.checkin,checkout:scope.checkout,productBasisVersion:scope.productBasisVersion,
  productMappingSha256:sha([...products.values()].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))),groupVersion:MARKET_PROPERTY_GROUP_VERSION,
  facts:facts.sort((a,b)=>a.propertySlug.localeCompare(b.propertySlug)||a.roomId.localeCompare(b.roomId)||a.ratePlanId.localeCompare(b.ratePlanId)),own:ownFact,groups:grouped,independentGroups:grouped.length,
  conditionMatched:ownFact!==null&&grouped.length>0,exclusions,commercialBasisAccepted:false as const,allMandatoryTaxCoverage:'NOT_ESTABLISHED' as const,
  mirrorValidation:'REQUIRED_SEPARATELY' as const,marketPriceAuthority:false as const};
 return {...base,factsSha256:sha(base)};
}

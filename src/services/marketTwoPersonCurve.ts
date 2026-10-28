// Fixed-product normalized price changes, not absolute competitor positioning or a demand/booking estimate.
// No I/O, own-price denominator, interpolation, collector expansion or pricing authority.
import {digest,hashOk,instant,qualityIndex,priceAdmission,type RowIdentity,type QualityLedger} from './marketRowPriceQuality';
export const CURVE_SCHEMA='ZMI_2P_MARKET_CURVE_V1' as const;
const validDate=(s:string)=>/^\d{4}-\d{2}-\d{2}$/u.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const token=(s:string)=>typeof s==='string'&&/^[-A-Za-z0-9_.:]{1,120}$/u.test(s);
const median=(a:readonly number[])=>{const s=[...a].sort((a,b)=>a-b),n=s.length;return n%2?s[(n-1)/2]!:(s[n/2-1]!+s[n/2]!)/2;};
const weighted=(a:readonly {v:number;w:number}[])=>{const rows=[...a].sort((a,b)=>a.v-b.v);let n=0;const total=rows.reduce((x,r)=>x+r.w,0);for(const r of rows){n+=r.w;if(n>=total/2)return r.v;}throw Error('EMPTY_WEIGHTED_MEDIAN');};
export interface PanelProduct {
 propertyId:string;sourcePropertyId:string;source:'booking'|'jalan'|'rakuten';productId:string;ratePlanId:string;conditionKey:string;
 groupId:string|null;weight:number;
 standardProduct:{kind:'DOUBLE'|'TWIN';maxAdults:2;evidenceSha256:string};
}
export interface MarketPanel {version:string;region:string;category:string;ownPropertyIds:string[];products:PanelProduct[];panelSha256:string}
export interface TwoPersonObservation extends RowIdentity {
 propertyId:string;sourcePropertyId:string;source:string;productId:string;ratePlanId:string;conditionKey:string;conditionsVersion:string;stayDate:string;
 observedAt:string;ingestedAt:string;receiptSha256:string;
 adults:2;children:0;rooms:1;nights:1;currency:'JPY';
 meal:'ROOM_ONLY'|'MEAL_STRATUM';cancellation:'REFUNDABLE'|'NON_REFUNDABLE';prepayment:'REQUIRED'|'NOT_REQUIRED';
 discount:'PUBLIC'|'PUBLIC_PROMO';tax:'ALL_MANDATORY_INCLUDED';
 result:'AVAILABLE'|'PRODUCT_UNAVAILABLE'|'CONDITION_UNAVAILABLE'|'FETCH_FAILED'|'NOT_OBSERVED';totalJpy:number|null;
}
export interface CurveQualityPolicy {
 version:string;maxAgeHours:number;minProperties:number;minEffectiveSampleSize:number;minKnownGroups:number;
 minMatchedCoverage:number;maxConcentration:number;maxUnknownWeight:number;maxDispersionLog:number;maxLeaveOneOutLog:number;
}
export interface CurveReference {
 version:string;baselineBundleSha256:string;panelSha256:string;
 // SAME_STAY_CHANGE anchors only genuinely available as-of rows, never inferred B-creation observations.
 mode:'SAME_STAY_CHANGE';asOf:string;anchorSnapshotSha256:string;
}
const key=(r:Pick<TwoPersonObservation,'propertyId'|'sourcePropertyId'|'source'|'productId'|'ratePlanId'|'conditionKey'>)=>[r.propertyId,r.sourcePropertyId,r.source,r.productId,r.ratePlanId,r.conditionKey].join('|');
export function sealPanel(p:Omit<MarketPanel,'panelSha256'>):MarketPanel{const {panelSha256:ignored,...body}=p as MarketPanel;return {...body,panelSha256:digest(body)};}
export function validatePanel(p:MarketPanel){
 if(!p||!token(p.version)||!p.region||!p.category||p.products.length<1||p.products.length>100||!Array.isArray(p.ownPropertyIds)||!p.ownPropertyIds.length
  ||p.panelSha256!==digest({version:p.version,region:p.region,category:p.category,ownPropertyIds:p.ownPropertyIds,products:p.products}))throw Error('PANEL_BINDING');
 const keys=new Set<string>(),propertyWeights=new Map<string,number>();
 for(const r of p.products){if(!token(r.propertyId)||!token(r.sourcePropertyId)||!['booking','jalan','rakuten'].includes(r.source)||!token(r.productId)||!token(r.ratePlanId)||!hashOk(r.conditionKey)
  ||r.groupId!==null&&!token(r.groupId)||!Number.isFinite(r.weight)||r.weight<=0||r.weight>1||!r.standardProduct||!['DOUBLE','TWIN'].includes(r.standardProduct.kind)
  ||r.standardProduct.maxAdults!==2||!hashOk(r.standardProduct.evidenceSha256)||p.ownPropertyIds.includes(r.propertyId)||['xi-raku','japanese-hostel-miuraya','kiraku','330695'].includes(r.sourcePropertyId)||keys.has(key(r)))throw Error('PANEL_PRODUCT_OR_SELF');
  // Multiple sources/plans of a property cannot acquire additional votes. Its configured total weight stays one.
  keys.add(key(r));propertyWeights.set(r.propertyId,(propertyWeights.get(r.propertyId)??0)+r.weight);
 }
 if([...propertyWeights.values()].some(w=>w>1+1e-12))throw Error('PANEL_PROPERTY_WEIGHT_INFLATION');
 for(const id of propertyWeights.keys())if(new Set(p.products.filter(x=>x.propertyId===id).map(x=>x.groupId)).size!==1)throw Error('PANEL_GROUP_CONFLICT');
}
function validatePolicy(p:CurveQualityPolicy){
 if(!p||!token(p.version)||!Number.isFinite(p.maxAgeHours)||p.maxAgeHours<=0||p.maxAgeHours>72
  ||!Number.isSafeInteger(p.minProperties)||p.minProperties<2||p.minProperties>100||!Number.isSafeInteger(p.minKnownGroups)||p.minKnownGroups<2
  ||!Number.isFinite(p.minEffectiveSampleSize)||p.minEffectiveSampleSize<2
  ||[p.minMatchedCoverage,p.maxConcentration,p.maxUnknownWeight].some(x=>!Number.isFinite(x)||x<0||x>1)
  ||!Number.isFinite(p.maxDispersionLog)||p.maxDispersionLog<0||!Number.isFinite(p.maxLeaveOneOutLog)||p.maxLeaveOneOutLog<0)throw Error('CURVE_QUALITY_POLICY');
}
function validObservation(r:TwoPersonObservation){
 if(!token(r.propertyId)||!token(r.sourcePropertyId)||!token(r.productId)||!token(r.ratePlanId)||!hashOk(r.conditionKey)||!validDate(r.stayDate)||!hashOk(r.receiptSha256)
  ||!Number.isFinite(instant(r.observedAt))||!Number.isFinite(instant(r.ingestedAt))||instant(r.ingestedAt)<instant(r.observedAt)
  ||!token(r.conditionsVersion)||r.conditionKey!==marketConditionKey(r,r.conditionsVersion)||r.adults!==2||r.children!==0||r.rooms!==1||r.nights!==1||r.currency!=='JPY'||!['ROOM_ONLY','MEAL_STRATUM'].includes(r.meal)
  ||!['REFUNDABLE','NON_REFUNDABLE'].includes(r.cancellation)||!['REQUIRED','NOT_REQUIRED'].includes(r.prepayment)
  ||!['PUBLIC','PUBLIC_PROMO'].includes(r.discount)||r.tax!=='ALL_MANDATORY_INCLUDED'
  ||!['AVAILABLE','PRODUCT_UNAVAILABLE','CONDITION_UNAVAILABLE','FETCH_FAILED','NOT_OBSERVED'].includes(r.result)
  ||r.result==='AVAILABLE'&&(!Number.isSafeInteger(r.totalJpy)||r.totalJpy!<=0||r.totalJpy!>2000000)||r.result!=='AVAILABLE'&&r.totalJpy!==null)throw Error('TWO_PERSON_OBSERVATION_CONTRACT');
}
export function marketConditionKey(r:Pick<TwoPersonObservation,'meal'|'cancellation'|'prepayment'|'discount'|'tax'>,termsVersion:string){
 if(!token(termsVersion))throw Error('CONDITION_VERSION');return digest([2,0,1,1,'JPY',r.meal,r.cancellation,r.prepayment,r.discount,r.tax,termsVersion]);
}
export function buildTwoPersonCurve(input:{
 panel:MarketPanel;policy:CurveQualityPolicy;reference:CurveReference;asOf:string;stayDates:readonly string[];
 observations:readonly TwoPersonObservation[];qualityLedger:QualityLedger;expectedQualitySha256:string;trustedReceiptSha256:ReadonlySet<string>;
}){
 const {panel,policy,reference}=input;validatePanel(panel);validatePolicy(policy);
 const at=instant(input.asOf),anchorAt=instant(reference.asOf);
 if(!Number.isFinite(at)||!Number.isFinite(anchorAt)||anchorAt>at||reference.mode!=='SAME_STAY_CHANGE'||!token(reference.version)
  ||!hashOk(reference.baselineBundleSha256)||reference.panelSha256!==panel.panelSha256||!hashOk(reference.anchorSnapshotSha256)
  ||input.observations.length>100000||input.stayDates.length>2000||new Set(input.stayDates).size!==input.stayDates.length||input.stayDates.some(d=>!validDate(d)))throw Error('CURVE_REFERENCE_OR_BUDGET');
 const quality=qualityIndex(input.qualityLedger,input.expectedQualitySha256),panelByKey=new Map(panel.products.map(p=>[key(p),p]));
 const exclusions:Record<string,number>={},drop=(r:string)=>{exclusions[r]=(exclusions[r]??0)+1;};
 type Snap={r:TwoPersonObservation;admitted:boolean;conflict:boolean};
 const current=new Map<string,Snap>(),anchor=new Map<string,Snap>(),seen=new Map<string,string>();
 const put=(m:Map<string,Snap>,k:string,r:TwoPersonObservation,admitted:boolean)=>{const old=m.get(k),t=instant(r.observedAt);if(!old||t>instant(old.r.observedAt))m.set(k,{r,admitted,conflict:false});else if(t===instant(old.r.observedAt)&&digest(r)!==digest(old.r))old.conflict=true;};
 for(const r of input.observations){
  validObservation(r);const row=digest(r),existing=seen.get(r.rowId);if(existing&&existing!==row)throw Error('OBSERVATION_ROW_CONFLICT');seen.set(r.rowId,row);
  if(panel.ownPropertyIds.includes(r.propertyId)||!panelByKey.has(key(r))){drop('NOT_FIXED_PANEL_PRODUCT');continue;}
  if(instant(r.observedAt)>at||instant(r.ingestedAt)>at){drop('NOT_KNOWN_ASOF');continue;}
  const q=quality.get(r.rowId);if(q?.status==='VERIFIED_SOURCE'&&q.observationSha256!==digest(r))throw Error('QUALITY_OBSERVATION_CONTENT_DRIFT');if(q&&(q.observedAt!==r.observedAt||q.ingestedAt!==r.ingestedAt))throw Error('QUALITY_OBSERVATION_TIME_DRIFT');
  const admission=priceAdmission(r,quality,r.receiptSha256,input.trustedReceiptSha256,input.asOf);
  if(!admission.eligible)drop(admission.reason);
  // Newer failures/unverified rows invalidate the current quote; never resurrect the previous successful price.
  const k=key(r)+'|'+r.stayDate;put(current,k,r,admission.eligible);
  if(instant(r.observedAt)<=anchorAt&&instant(r.ingestedAt)<=anchorAt)put(anchor,k,r,admission.eligible);
 }
 const anchorRows=[...anchor.values()].map(x=>[x.r.rowId,x.r.rowHash,x.r.receiptSha256]).sort((a,b)=>a[0]!.localeCompare(b[0]!));
 if(digest(anchorRows)!==reference.anchorSnapshotSha256)throw Error('ANCHOR_SNAPSHOT_BINDING');
 const anchorExpired=(r:TwoPersonObservation)=>anchorAt-instant(r.observedAt)>policy.maxAgeHours*3600000;
 const totalWeight=panel.products.reduce((n,p)=>n+p.weight,0);
 const curves=input.stayDates.map(stayDate=>{
  const reasons:string[]=[],property=new Map<string,{v:number;w:number;group:string|null;hashes:string[];observed:number[];ingested:number[]}>();
  let available=0,productUnavailable=0,conditionUnavailable=0,fetchFailed=0,notObserved=0;
  for(const p of panel.products){
   const c=current.get(key(p)+'|'+stayDate),a=anchor.get(key(p)+'|'+stayDate);
   if(!c){notObserved++;continue;}
   if(c.r.result==='AVAILABLE')available++;else if(c.r.result==='PRODUCT_UNAVAILABLE')productUnavailable++;else if(c.r.result==='CONDITION_UNAVAILABLE')conditionUnavailable++;else if(c.r.result==='FETCH_FAILED')fetchFailed++;else notObserved++;
   if(!a||!a.admitted||!c.admitted||a.conflict||c.conflict||anchorExpired(a.r)||at-instant(c.r.observedAt)>policy.maxAgeHours*3600000
    ||a.r.result!=='AVAILABLE'||c.r.result!=='AVAILABLE'){continue;}
   if(digest([a.r.meal,a.r.cancellation,a.r.prepayment,a.r.discount,a.r.tax])!==digest([c.r.meal,c.r.cancellation,c.r.prepayment,c.r.discount,c.r.tax])){drop('CONDITIONS_CHANGED_WITHOUT_SERIES_VERSION');continue;}
   const v=Math.log(c.r.totalJpy!/a.r.totalJpy!),old=property.get(p.propertyId);
   if(old){old.v+=v*p.weight;old.w+=p.weight;old.hashes.push(a.r.rowId+'|'+a.r.rowHash,c.r.rowId+'|'+c.r.rowHash);old.observed.push(instant(c.r.observedAt));old.ingested.push(instant(c.r.ingestedAt));}
   else property.set(p.propertyId,{v:v*p.weight,w:p.weight,group:p.groupId,hashes:[a.r.rowId+'|'+a.r.rowHash,c.r.rowId+'|'+c.r.rowHash],observed:[instant(c.r.observedAt)],ingested:[instant(c.r.ingestedAt)]});
  }
  const props=[...property].map(([id,x])=>({id,...x,v:x.v/x.w})),weight=props.reduce((s,x)=>s+x.w,0),matchedCoverage=weight/totalWeight;
  const group=new Map<string,number>();for(const x of props){const k=x.group??'__UNKNOWN__';group.set(k,(group.get(k)??0)+x.w);}
  const knownGroups=[...group.keys()].filter(k=>k!=='__UNKNOWN__').length,unknownWeight=weight?(group.get('__UNKNOWN__')??0)/weight:0;
  const concentration=weight?Math.max(...group.values())/weight:1;
  const effectiveSampleSize=weight?weight*weight/[...group.values()].reduce((s,w)=>s+w*w,0):0;
  const logIndex=props.length?weighted(props):null;
  const dispersion=logIndex===null?null:median(props.map(x=>Math.abs(x.v-logIndex)));
  let leaveProperty=0,leaveGroup=0;
  if(logIndex!==null){for(const x of props){const others=props.filter(y=>y.id!==x.id);leaveProperty=Math.max(leaveProperty,others.length?Math.abs(weighted(others)-logIndex):Infinity);}
   for(const g of group.keys()){const others=props.filter(y=>(y.group??'__UNKNOWN__')!==g);leaveGroup=Math.max(leaveGroup,others.length?Math.abs(weighted(others)-logIndex):Infinity);}}
  if(props.length<policy.minProperties)reasons.push('INSUFFICIENT_PROPERTIES');if(knownGroups<policy.minKnownGroups)reasons.push('INSUFFICIENT_KNOWN_GROUPS');
  if(effectiveSampleSize<policy.minEffectiveSampleSize)reasons.push('INSUFFICIENT_EFFECTIVE_SAMPLE');if(matchedCoverage<policy.minMatchedCoverage)reasons.push('MATCHED_COVERAGE_LOW');
  if(concentration>policy.maxConcentration)reasons.push('GROUP_CONCENTRATION');if(unknownWeight>policy.maxUnknownWeight)reasons.push('UNKNOWN_OWNERSHIP_WEIGHT');
  if(dispersion===null||dispersion>policy.maxDispersionLog)reasons.push('DISPERSION');if(leaveProperty>policy.maxLeaveOneOutLog||leaveGroup>policy.maxLeaveOneOutLog)reasons.push('LEAVE_ONE_OUT_UNSTABLE');
  const obs=props.flatMap(x=>x.observed),ing=props.flatMap(x=>x.ingested),oldest=obs.length?Math.min(...obs):null;
  const validUntil=oldest===null?input.asOf:new Date(oldest+policy.maxAgeHours*3600000).toISOString();
  if(instant(validUntil)<=at)reasons.push('EXPIRED');
  const rowIds=[...new Set(props.flatMap(x=>x.hashes))].sort();
  return {stayDate,asOf:input.asOf,curveIndex:logIndex===null?null:Math.exp(logIndex),referenceVersion:reference.version,anchorVersion:reference.version,
   baselineBundleSha256:reference.baselineBundleSha256,mode:reference.mode,
   confidence:reasons.length?0:Math.min(1,matchedCoverage*(1-concentration)),eligible:reasons.length===0,reasonCodes:reasons,
   nProperties:props.length,effectiveSampleSize,knownGroups,concentration,unknownWeight,matchedCoverage,dispersion,
   leaveOnePropertyOutLog:leaveProperty,leaveOneGroupOutLog:leaveGroup,
   observedBounds:obs.length?[new Date(Math.min(...obs)).toISOString(),new Date(Math.max(...obs)).toISOString()]:null,
   ingestedBounds:ing.length?[new Date(Math.min(...ing)).toISOString(),new Date(Math.max(...ing)).toISOString()]:null,
   validUntil,panelVersion:panel.version,inputRowSetDigest:digest(rowIds),
   productAvailability:{available,productUnavailable,conditionUnavailable,fetchFailed,notObserved,hotelOccupancyRate:null}};
 });
 const body={schema:CURVE_SCHEMA,asOf:input.asOf,panelVersion:panel.version,panelSha256:panel.panelSha256,reference,qualityPolicyVersion:policy.version,
  qualityPolicySha256:digest(policy),qualityLedgerSha256:input.expectedQualitySha256,sourceSnapshotSha:digest([...seen].sort(([a],[b])=>a.localeCompare(b))),curves,exclusions,
  priceAuthority:false as const,demandInference:false as const,axis:'SAME_STAY_DATE_OBSERVATION_TIME_CHANGE' as const};
 return {...body,curveSha256:digest(body)};
}

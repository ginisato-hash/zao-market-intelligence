// Observed 2-person LISTING amounts, not a fixed-product price index or demand estimate.
// Pure analysis/proposal seam. Canonical/mirror identities are required; this grants no transport authority.
import {buildRowHash} from './localHistorySchemaDesign';
import {normalizeStatus,deriveMealBasis,deriveRoomBasis,type PriceHistoryInputRow} from './priceHistorySignals';
import {buildMarketPriceMovements} from './marketPriceMovementSignals';
import {isOwnProperty,canonicalizeName} from './biWebDataExport';
import {validatePrimaryPriceNumeric} from './pricePlausibilityGuard';
import {digest,instant} from './marketRowPriceQuality';
import {createHash} from 'node:crypto';
import {marketPropertyGroup,MARKET_PROPERTY_GROUP_VERSION} from './marketPropertyGroups';

export const OBSERVED_LISTING_RELATIVE_V1='OBSERVED_LISTING_RELATIVE_V1' as const;
export interface ListingCanonicalRow {rowId:string;rowHash:string;mirrorRowHash:string;raw:Record<string,string>;quarantineReason:string|null}
export interface ListingAnalysisPolicy {
 version:string;maxCurrentAgeHours:number;maxComparisonAgeHours:number;minProperties:number;validForMinutes:number;
 // Explicit analysis/proposal parameters, not accepted production TTL or commercial M numbers.
 productionAccepted:false;
}
export interface ListingAttempt {propertyId:string;stayDate:string;attemptedAt:string;completedObservationRowId:string|null}
export interface ListingRunReport {runId:string;rawSha256:string;rawJson:string}
/** A completed DOM capture is not the final page/abort-cleanup outcome. */
export const listingCaptureFinalGuardClear=(c:Record<string,unknown>)=>c.pageFinalBlockStateVerified===true&&c.informationFailureCode==null&&c.pageFinalBlockReason==null&&c.blockReason==null;
export function listingRowFinalGuardFailure(r:ListingCanonicalRow,reports:ReadonlyMap<string,Record<string,any>>,asOf:number):string|null{
 const slot=/\/auto-runner-market-refresh-rotating\/(\d{8}_\d{6})\//u.exec(r.raw.debug_artifact_path??'')?.[1];if(!slot)return null;
 const d=reports.get('auto_runner_market_refresh_rotating_'+slot),at=instant(r.raw.collected_at_jst??''),slug=r.raw.source_slug_or_code||r.raw.source_property_id;
 if(!d||d.run_id!=='auto_runner_market_refresh_rotating_'+slot||d.dry_run!==false||!['rotating_market_refresh_success','rotating_market_refresh_partial_success'].includes(d.decision)||instant(d.generated_at_jst)!==at||!Array.isArray(d.rate_cell_evidence?.captures))return 'OBSERVATION_REPORT_UNVERIFIED';
 const cs=d.rate_cell_evidence.captures.filter((c:any)=>c.propertySlug===slug&&c.stayDate===r.raw.checkin&&c.attemptedNetwork===true);
 if(cs.length!==1||!Number.isFinite(instant(cs[0].completedAt))||instant(cs[0].completedAt)<at||instant(cs[0].completedAt)>asOf)return 'OBSERVATION_REPORT_UNVERIFIED';
 return listingCaptureFinalGuardClear(cs[0])?null:'OBSERVATION_FINAL_GUARD_UNVERIFIED';
}
export interface ListingSourceSnapshot {schema:'OBSERVED_LISTING_CANONICAL_INPUT_MANIFEST_V1';asOf:string;canonicalRowSetSha256:string;attemptSetSha256:string;canonicalRows:number;targetDates:string[];sourceFiles:{path:string;sha256:string}[];attempts:ListingAttempt[];producerCodeSha256s:string[];producerSetSha256:string;propertyAliases:ReturnType<typeof listingPropertyAliases>;[key:string]:unknown}
export const canonicalListingRowSetSha256=(rows:ListingCanonicalRow[])=>digest(rows.map(x=>({rowId:x.rowId,rowHash:x.rowHash,rawRecordSha256:digest(x.raw),quarantineReason:x.quarantineReason})).sort((a,b)=>a.rowId<b.rowId?-1:a.rowId>b.rowId?1:0));
export function listingPropertyAliases(rows:ListingCanonicalRow[]){const groups=new Map<string,{source:string;physicalPropertyId:string;sourcePropertyIds:Set<string>;propertyIds:Set<string>}>();for(const x of rows){const r=x.raw,source=r.source??'',slug=r.source_slug_or_code||r.source_property_id||'',id=r.source_property_id||slug,physical=marketPropertyGroup(source,slug).propertyKey??id,key=source+'|'+physical;const g=groups.get(key)??{source,physicalPropertyId:physical,sourcePropertyIds:new Set<string>(),propertyIds:new Set<string>()};g.sourcePropertyIds.add(id);g.propertyIds.add(slug);groups.set(key,g);}return [...groups.values()].map(g=>({...g,sourcePropertyIds:[...g.sourcePropertyIds].sort(),propertyIds:[...g.propertyIds].sort()})).sort((a,b)=>(a.source+'|'+a.physicalPropertyId).localeCompare(b.source+'|'+b.physicalPropertyId));}
const median=(xs:number[])=>{const a=[...xs].sort((x,y)=>x-y);return !a.length?null:a.length%2?a[(a.length-1)/2]!:((a[a.length/2-1]!+a[a.length/2]!)/2);};
const finitePrice=(s:string)=>s!==''&&Number.isSafeInteger(Number(s))&&Number(s)>0?Number(s):null;
const calendarDay=(s:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/u.test(s))return NaN;const n=Date.parse(s+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s?n:NaN;};
function history(row:ListingCanonicalRow):PriceHistoryInputRow{
 const r=row.raw;return {property_id:r.source_slug_or_code||r.source_property_id||'',property_name:canonicalizeName(r.canonical_property_name??''),source:r.source??'',checkin_date:r.checkin??'',observed_at:r.collected_at_jst??'',occupancy_basis:`${r.group_adults}_adults_${r.no_rooms}_rooms`,availability_status_raw:r.availability_status??'',normalized_total_price:finitePrice(r.normalized_total_price??''),basis_confidence:r.basis_confidence??'',warning_flags:r.warning_flags??'',source_classification:r.source_classification??'',dp_exclusion_reason:r.dp_exclusion_reason??'',is_price_excluded_from_dp:r.is_price_excluded_from_dp==='true',is_price_usable_for_dp_directional:r.is_price_usable_for_dp_directional==='true',basis_note:r.basis_note??'',room_type_key:r.room_type_key??''};
}
function identityValid(x:ListingCanonicalRow){const r=x.raw;
 if(x.rowId!==r.row_id||x.rowHash!==r.row_hash||x.rowHash!==x.mirrorRowHash||!/^[a-f0-9]{64}$/u.test(x.rowHash))return false;
 return x.rowHash===buildRowHash({source:r.source??'',sourcePhase:r.source_phase??'',collectorStage:r.collector_stage??'',canonicalPropertyName:r.canonical_property_name??'',sourceSlugOrCode:r.source_slug_or_code??'',sourcePropertyId:r.source_property_id??'',checkin:r.checkin??'',checkout:r.checkout??'',stayScope:r.stay_scope??'',collectedDateJst:r.collected_date_jst??'',availabilityStatus:r.availability_status??'',soldOutStatus:r.sold_out_status??'',normalizedTotalPrice:finitePrice(r.normalized_total_price??''),basisConfidence:r.basis_confidence??'',sourceClassification:r.source_classification??'',isPriceUsableForDpDirect:r.is_price_usable_for_dp_direct==='true',isPriceUsableForDpDirectional:r.is_price_usable_for_dp_directional==='true',isPriceExcludedFromDp:r.is_price_excluded_from_dp==='true'});
}
function classify(x:ListingCanonicalRow,asOf:number){const r=x.raw,h=history(x),reasons:string[]=[];
 if(!identityValid(x))reasons.push('CANONICAL_MIRROR_IDENTITY_UNVERIFIED');
 if(x.quarantineReason!==null)reasons.push('KNOWN_PRICE_QUARANTINE');
 if(r.source!=='booking'||r.property_identity_match!=='true'||!h.property_id||!h.property_name)reasons.push('SOURCE_PROPERTY_UNVERIFIED');
 if(isOwnProperty(h.property_name)||marketPropertyGroup(h.source,h.property_id).role==='OWN')reasons.push('OWN_PROPERTY');
 if(r.group_adults!=='2'||r.group_children!=='0'||r.no_rooms!=='1'||r.stay_nights!=='1'||r.currency!=='JPY'||calendarDay(r.checkout??'')-calendarDay(r.checkin??'')!==86400000)reasons.push('NOT_2_ADULT_1_ROOM_1_NIGHT_JPY');
 const at=instant(h.observed_at);if(!Number.isFinite(at)||at>asOf)reasons.push('OBSERVATION_TIME_INVALID');
 const amount=finitePrice(r.source_primary_price??'');
 if(amount===null||!validatePrimaryPriceNumeric({source:h.source,propertyName:h.property_name,price:amount}).usable)reasons.push('PRIMARY_AMOUNT_UNVERIFIED');
 if(/per_person|per_head|charge_per_human|coupon_only|tax_only|price_ambiguous|data_quality_suspect|implausible|served_url_tuple_mismatch|request_tuple_mismatch|http_403|http_429|captcha_detected/iu.test([r.normalized_total_price_basis,r.source_tax_or_fee_classification,r.dp_exclusion_reason,r.warning_flags].join('|')))reasons.push('AMOUNT_ROLE_OR_DATA_QUALITY_UNVERIFIED');
 if(normalizeStatus(h.availability_status_raw)!=='available')reasons.push('LATEST_NOT_AVAILABLE_PRICE');
 const labels=[r.source_classification,r.warning_flags,r.basis_note].join('|');
 const meal=/(?:meal_basis=meal_included|meal_included_plan_excluded|booking_meal_included)/u.test(labels)?'KNOWN_MEAL_INCLUDED':deriveMealBasis(h);
 const member=/(?:booking_member_conditional|(?:^|[;|])member_(?:only_price|conditional_price|price_detected)(?:[;|]|$))/u.test(labels)?'KNOWN_MEMBER_CONDITIONAL':'PUBLIC_STATUS_UNKNOWN';
 const room=deriveRoomBasis(h),tax=r.source_tax_or_fee_classification||'UNKNOWN_TAX_BASIS',amountBasis=r.normalized_total_price_basis||'UNKNOWN_AMOUNT_BASIS';
 const cohort=digest({source:h.source,adults:2,rooms:1,nights:1,currency:'JPY',meal,member,room,tax,amountBasis,roomType:h.room_type_key||'UNKNOWN_ROOM_PLAN'});
 const base=meal!=='KNOWN_MEAL_INCLUDED'&&member!=='KNOWN_MEMBER_CONDITIONAL'&&!room.startsWith('excluded_');
 const unknown=[...(meal==='assumed_room_only'?['MEAL_ASSUMED']:[]),...(member==='PUBLIC_STATUS_UNKNOWN'?['PUBLIC_STATUS_UNKNOWN']:[]),...(!h.room_type_key?['ROOM_PLAN_UNKNOWN']:[]),'CANCELLATION_PREPAYMENT_NOT_PRODUCT_VERIFIED',...(/unknown|unavailable|unconfirmed/iu.test(tax)?['TAX_TOTAL_UNCONFIRMED']:[])];
 return {x,h,at,amount,reasons,meal,member,room,tax,amountBasis,cohort,base,unknown};
}
type Classified=ReturnType<typeof classify>;
const ref=(r:Classified)=>({rowId:r.x.rowId,rowHash:r.x.rowHash,rawRecordSha256:digest(r.x.raw),propertyId:r.h.property_id,propertyName:r.h.property_name,source:r.h.source,sourcePropertyId:r.x.raw.source_property_id||r.h.property_id,physicalPropertyId:marketPropertyGroup(r.h.source,r.h.property_id).propertyKey??(r.x.raw.source_property_id||r.h.property_id),groupKey:marketPropertyGroup(r.h.source,r.h.property_id).groupKey,stayDate:r.h.checkin_date,observedAt:r.h.observed_at,amountJpy:r.amount,meal:r.meal,room:r.room,member:r.member,tax:r.tax,amountBasis:r.amountBasis,unknown:r.unknown,cohortSha256:r.cohort,sourceProvenance:'CANONICAL_NORMALIZED_HISTORY_RAW_PRODUCT_NOT_VERIFIED' as const});

export function analyzeObservedListingRelative(input:{rows:ListingCanonicalRow[];attempts:ListingAttempt[];reports?:ListingRunReport[];sourceSnapshot:ListingSourceSnapshot;targetDates:string[];asOf:string;policy:ListingAnalysisPolicy;sourceSnapshotSha256:string;baselineBundleSha256:string;groups?:Record<string,string>}){
 const at=instant(input.asOf),p=input.policy;
 if(!Number.isFinite(at)||input.rows.length>15000||input.attempts.length>15000||input.targetDates.length>1000||new Set(input.targetDates).size!==input.targetDates.length||input.targetDates.some(d=>!/^\d{4}-\d{2}-\d{2}$/u.test(d)||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)||!Number.isSafeInteger(p.minProperties)||p.minProperties<2||p.minProperties>100||!Number.isFinite(p.maxCurrentAgeHours)||p.maxCurrentAgeHours<=0||p.maxCurrentAgeHours>72||!Number.isFinite(p.maxComparisonAgeHours)||p.maxComparisonAgeHours<=p.maxCurrentAgeHours||p.maxComparisonAgeHours>24*30||!Number.isSafeInteger(p.validForMinutes)||p.validForMinutes<=0||p.validForMinutes>120||p.productionAccepted!==false||![input.sourceSnapshotSha256,input.baselineBundleSha256].every(h=>/^[0-9a-f]{64}$/u.test(h)))throw Error('LISTING_ANALYSIS_SCOPE_OR_POLICY');
 const targets=new Set(input.targetDates),ids=new Set<string>();
 for(const r of input.rows){if(ids.has(r.rowId)||!targets.has(r.raw.checkin??''))throw Error('LISTING_DUPLICATE_ID_OR_DATE');ids.add(r.rowId);}
 const snapshot=input.sourceSnapshot;
 if(!snapshot||snapshot.schema!=='OBSERVED_LISTING_CANONICAL_INPUT_MANIFEST_V1'||snapshot.asOf!==input.asOf||snapshot.canonicalRows!==input.rows.length||digest(snapshot)!==input.sourceSnapshotSha256||snapshot.canonicalRowSetSha256!==canonicalListingRowSetSha256(input.rows)||snapshot.attemptSetSha256!==digest(input.attempts)||digest(snapshot.attempts)!==digest(input.attempts)||digest(snapshot.targetDates)!==digest(input.targetDates))throw Error('LISTING_INDEPENDENT_PROJECTION_BINDING');
 if(digest(snapshot.propertyAliases)!==digest(listingPropertyAliases(input.rows)))throw Error('LISTING_ALIAS_BINDING');
 if(!snapshot.producerCodeSha256s.length||snapshot.producerCodeSha256s.length>30||snapshot.producerCodeSha256s.some(x=>!/^[0-9a-f]{64}$/u.test(x))||snapshot.producerSetSha256!==digest([...new Set(snapshot.producerCodeSha256s)].sort()))throw Error('LISTING_PRODUCER_BINDING');
 const reports=new Map<string,Record<string,any>>();let reportBytes=0;
 for(const r of input.reports??[]){reportBytes+=Buffer.byteLength(r.rawJson);if(reports.has(r.runId)||reportBytes>16*1024*1024||Buffer.byteLength(r.rawJson)>2*1024*1024||createHash('sha256').update(r.rawJson).digest('hex')!==r.rawSha256||!snapshot.sourceFiles.some(f=>f.path.endsWith('/'+r.runId+'.json')&&f.sha256===r.rawSha256))throw Error('LISTING_REPORT_RECEIPT_BINDING');const d=JSON.parse(r.rawJson);if(d.run_id!==r.runId||d.dry_run!==false||!['rotating_market_refresh_success','rotating_market_refresh_partial_success'].includes(d.decision))throw Error('LISTING_REPORT_NOT_FINAL');reports.set(r.runId,d);}
 for(const a of input.attempts){
  if(!a.propertyId||!targets.has(a.stayDate)||!Number.isFinite(instant(a.attemptedAt))||instant(a.attemptedAt)>at)throw Error('LISTING_ATTEMPT_SCOPE_OR_TIME');
  if(a.completedObservationRowId!==null){const r=input.rows.find(x=>x.rowId===a.completedObservationRowId);if(!r||(r.raw.source_slug_or_code||r.raw.source_property_id)!==a.propertyId||r.raw.checkin!==a.stayDate)throw Error('LISTING_ATTEMPT_ROW_TUPLE');
   const slot=/\/auto-runner-market-refresh-rotating\/(\d{8}_\d{6})\//u.exec(r.raw.debug_artifact_path??'')?.[1],d=slot?reports.get('auto_runner_market_refresh_rotating_'+slot):null;
   const c=d?.rate_cell_evidence?.captures?.find((x:any)=>x.propertySlug===a.propertyId&&x.stayDate===a.stayDate&&x.attemptedNetwork===true);
   if(!d||!c||instant(d.generated_at_jst)!==instant(r.raw.collected_at_jst)||instant(a.attemptedAt)<instant(d.generated_at_jst)||!Number.isFinite(instant(c.completedAt))||instant(c.completedAt)<instant(a.attemptedAt)||instant(c.completedAt)>at)throw Error('LISTING_ATTEMPT_COMPLETION_RECEIPT');
   if(!listingCaptureFinalGuardClear(c))throw Error('LISTING_ATTEMPT_COMPLETION_FINAL_GUARD');
  }
 }
 const rows=input.rows.map(r=>{const x=classify(r,at),failure=listingRowFinalGuardFailure(r,reports,at);if(failure)x.reasons.push(failure);return x;});
 const groups=new Map<string,Classified[]>();
 for(const r of rows){const key=r.h.source+'|'+(marketPropertyGroup(r.h.source,r.h.property_id).propertyKey??(r.x.raw.source_property_id||r.h.property_id))+'|'+r.h.checkin_date;const a=groups.get(key)??[];a.push(r);groups.set(key,a);}
 const latest=new Map<string,Classified>(),pairs:{previous:Classified;current:Classified;ratio:number}[]=[],failures:{stayDate:string;propertyId:string;reasons:string[]}[]=[];
 for(const [key,list] of groups){list.sort((a,b)=>b.at-a.at||a.x.rowId.localeCompare(b.x.rowId));const current=list[0]!;latest.set(key,current);
  const physical=marketPropertyGroup(current.h.source,current.h.property_id).propertyKey??(current.x.raw.source_property_id||current.h.property_id),requestAliases=new Set(snapshot.propertyAliases.find(g=>g.source===current.h.source&&g.physicalPropertyId===physical)!.propertyIds),localAttempts=input.attempts.filter(a=>requestAliases.has(a.propertyId)&&a.stayDate===current.h.checkin_date),newestAt=Math.max(-Infinity,...localAttempts.map(a=>instant(a.attemptedAt))),newest=localAttempts.filter(a=>instant(a.attemptedAt)===newestAt);
  const reasons=[...current.reasons];if(newestAt>=current.at&&newest.some(a=>a.completedObservationRowId!==current.x.rowId))reasons.push('NEWER_ATTEMPT_NOT_RECONCILED');
  if(at-current.at>=p.maxCurrentAgeHours*3600000)reasons.push('CURRENT_STALE');
  if(list.some(r=>r!==current&&r.at===current.at&&(r.amount!==current.amount||r.cohort!==current.cohort||r.reasons.length!==0)))reasons.push('SAME_TIME_CONFLICT');
  if(reasons.length){failures.push({stayDate:current.h.checkin_date,propertyId:current.h.property_id,reasons});continue;}
  const previous=list.find(r=>r.at<current.at&&r.cohort===current.cohort&&r.reasons.length===0&&at-r.at<=p.maxComparisonAgeHours*3600000);
  if(previous&&list.some(r=>r!==previous&&r.at===previous.at&&(r.amount!==previous.amount||r.cohort!==previous.cohort||r.reasons.length!==0))){failures.push({stayDate:current.h.checkin_date,propertyId:current.h.property_id,reasons:['PREVIOUS_SAME_TIME_CONFLICT']});continue;}
  if(previous&&current.base&&previous.base&&previous.amount!==null&&current.amount!==null)pairs.push({previous,current,ratio:current.amount/previous.amount});
 }
 const days=input.targetDates.map(stayDate=>{
  const points=[...latest.values()].filter(r=>r.h.checkin_date===stayDate&&r.reasons.length===0&&at-r.at<p.maxCurrentAgeHours*3600000&&!failures.some(f=>f.propertyId===r.h.property_id&&f.stayDate===stayDate));
  const matched=pairs.filter(r=>r.current.h.checkin_date===stayDate),ratios=matched.map(r=>r.ratio),index=median(ratios),loo=matched.map((_,i)=>median(ratios.filter((_,j)=>i!==j))).filter((n):n is number=>n!==null);
  const reasonCodes:string[]=[];if(matched.length<p.minProperties)reasonCodes.push('INSUFFICIENT_COMMON_PROPERTIES');
  const unknownShare=matched.length?matched.filter(r=>r.current.unknown.length||r.previous.unknown.length).length/matched.length:1;
  const looDeviation=index===null||!loo.length?0:Math.max(...loo.map(x=>Math.abs(Math.log(x/index))));
  const groupCounts:Record<string,number>={};for(const r of matched){const g=marketPropertyGroup(r.current.h.source,r.current.h.property_id).groupKey??'UNKNOWN';groupCounts[g]=(groupCounts[g]??0)+1;}
  const knownGroupMaxShare=matched.length?Math.max(0,...Object.entries(groupCounts).filter(([g])=>g!=='UNKNOWN').map(([,n])=>n/matched.length)):0;
  const groupUnknownShare=matched.length?(groupCounts.UNKNOWN??0)/matched.length:1;
  const attenuation=matched.length?matched.length/(matched.length+2)/(1+unknownShare+looDeviation+knownGroupMaxShare+groupUnknownShare):0;
  const minExpiry=matched.length?Math.min(...matched.map(x=>x.current.at+p.maxCurrentAgeHours*3600000)):at;
  const validUntil=new Date(Math.min(minExpiry,at+p.validForMinutes*60000)).toISOString();
  const status=reasonCodes.length||index===null?'INSUFFICIENT_Y_ONLY':Math.abs(index-1)<1e-12?'SUPPORTED_NEUTRAL':'SUPPORTED_CHANGE';
  const known=matched.filter(x=>x.current.unknown.length===0&&x.previous.unknown.length===0),confirmed=matched.filter(x=>x.current.room==='confirmed_two_person_standard_room'&&x.previous.room==='confirmed_two_person_standard_room');
  const comparisons=matched.map(x=>({previous:ref(x.previous),current:ref(x.current),requestAliases:snapshot.propertyAliases.find(g=>g.source===x.current.h.source&&g.physicalPropertyId===(marketPropertyGroup(x.current.h.source,x.current.h.property_id).propertyKey??(x.current.x.raw.source_property_id||x.current.h.property_id)))!.propertyIds,canonicalSourcePropertyIds:snapshot.propertyAliases.find(g=>g.source===x.current.h.source&&g.physicalPropertyId===(marketPropertyGroup(x.current.h.source,x.current.h.property_id).propertyKey??(x.current.x.raw.source_property_id||x.current.h.property_id)))!.sourcePropertyIds,ratio:x.ratio,observationIntervalHours:(x.current.at-x.previous.at)/3600000,productIdentity:'ROOM_PLAN_NOT_PROVED_LISTING_COMPARISON' as const})).sort((a,b)=>a.current.physicalPropertyId.localeCompare(b.current.physicalPropertyId));
  return {stayDate,asOf:input.asOf,status,eligible:status!=='INSUFFICIENT_Y_ONLY',reasonCodes,validUntil,relativeIndex:index,influenceAttenuation:attenuation,attenuationSemantics:'UNCERTAINTY_ATTENUATION_NOT_PROBABILITY' as const,
   observedProperties:points.length,commonProperties:matched.length,levelMedianJpy:median(points.filter(r=>r.base).map(r=>r.amount!)),cohortLevels:[...new Set(points.map(r=>r.cohort))].map(key=>{const a=points.filter(r=>r.cohort===key);return {cohortSha256:key,properties:a.length,medianJpy:median(a.map(r=>r.amount!)),meal:a[0]!.meal,room:a[0]!.room,member:a[0]!.member,tax:a[0]!.tax};}),
   unknownShare,fullyKnownSubset:{properties:known.length,relativeIndex:median(known.map(x=>x.ratio))},confirmedRoomSubset:{properties:confirmed.length,relativeIndex:median(confirmed.map(x=>x.ratio))},leaveOneOut:{min:loo.length?Math.min(...loo):null,max:loo.length?Math.max(...loo):null},groupCounts,groupVersion:MARKET_PROPERTY_GROUP_VERSION,knownGroupMaxShare,groupUnknownShare,
   comparisons,inputRowSetDigest:digest(comparisons),failures:failures.filter(f=>f.stayDate===stayDate)};
 });
 const body={schema:OBSERVED_LISTING_RELATIVE_V1,evidenceKind:OBSERVED_LISTING_RELATIVE_V1,axis:'OBSERVED_TWO_PERSON_LISTING_SAME_STAY_RELATIVE' as const,asOf:input.asOf,expiresAt:new Date(at+p.validForMinutes*60000).toISOString(),baselineBundleSha256:input.baselineBundleSha256,
  canonicalRoute:'NORMAL_TRUSTED_APPEND_AND_EXACT_MIRROR' as const,sourceSnapshotSha256:input.sourceSnapshotSha256,canonicalRowSetSha256:canonicalListingRowSetSha256(input.rows),attemptSetSha256:digest(input.attempts),producerCodeSha256s:snapshot.producerCodeSha256s,producerSetSha256:snapshot.producerSetSha256,policy:p,policySha256:digest(p),targetDates:input.targetDates,days,
  analysisWindowHours:p.maxCurrentAgeHours,legacyMovementCrosscheck:buildMarketPriceMovements(rows.map(r=>r.h)).movements.length,priceAuthority:false as const,demandInference:false as const,fixedProductIndex:false as const};
 return {...body,artifactSha256:digest(body)};
}

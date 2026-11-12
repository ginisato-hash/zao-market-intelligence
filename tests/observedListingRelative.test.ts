import {it,expect} from 'vitest';
import {analyzeObservedListingRelative,canonicalListingRowSetSha256,listingPropertyAliases,type ListingCanonicalRow,type ListingAttempt,type ListingRunReport} from '../src/services/observedListingRelative';
import {buildRowHash} from '../src/services/localHistorySchemaDesign';
import {digest} from '../src/services/marketRowPriceQuality';
import {createHash} from 'node:crypto';
import {listingPlannerStates} from '../src/services/observedListingPlannerFeedback';
const asOf='2026-11-01T03:30:00Z',date='2027-01-06';
function row(id:string,at:string,price:number,change:Record<string,string>={}):ListingCanonicalRow{
 const r:Record<string,string>={source:'booking',source_phase:'synthetic',collector_stage:'fixture',canonical_property_name:'Synthetic '+id,source_slug_or_code:id,source_property_id:id,checkin:date,checkout:'2027-01-07',stay_scope:'2_adults_1_room_1_night',collected_date_jst:at.slice(0,10),collected_at_jst:at,availability_status:'available_price_basis',sold_out_status:'not_sold_out',source_primary_price:String(price),normalized_total_price:String(price),basis_confidence:'B',source_classification:'booking_assumed_room_only_two_person_standard',is_price_usable_for_dp_direct:'false',is_price_usable_for_dp_directional:'true',is_price_excluded_from_dp:'false',property_identity_match:'true',group_adults:'2',group_children:'0',no_rooms:'1',stay_nights:'1',currency:'JPY',warning_flags:'room_basis=confirmed_two_person_standard_room',normalized_total_price_basis:'visible_booking_price_directional_only',source_tax_or_fee_classification:'official_visible_adder_not_available',...change};
 r.row_id=[r.collected_date_jst,r.source,r.canonical_property_name,id,r.checkin,r.checkout,r.stay_scope].join('|');r.row_hash=buildRowHash({source:r.source!,sourcePhase:r.source_phase!,collectorStage:r.collector_stage!,canonicalPropertyName:r.canonical_property_name!,sourceSlugOrCode:id,sourcePropertyId:id,checkin:r.checkin!,checkout:r.checkout!,stayScope:r.stay_scope!,collectedDateJst:r.collected_date_jst!,availabilityStatus:r.availability_status!,soldOutStatus:r.sold_out_status!,normalizedTotalPrice:r.normalized_total_price===''?null:Number(r.normalized_total_price),basisConfidence:r.basis_confidence!,sourceClassification:r.source_classification!,isPriceUsableForDpDirect:r.is_price_usable_for_dp_direct==='true',isPriceUsableForDpDirectional:r.is_price_usable_for_dp_directional==='true',isPriceExcludedFromDp:r.is_price_excluded_from_dp==='true'});
 return {rowId:r.row_id,rowHash:r.row_hash,mirrorRowHash:r.row_hash,raw:r,quarantineReason:null};
}
function input(rows:ListingCanonicalRow[],attempts:ListingAttempt[]=[],reports:ListingRunReport[]=[]){const sourceSnapshot={schema:'OBSERVED_LISTING_CANONICAL_INPUT_MANIFEST_V1' as const,asOf,canonicalRowSetSha256:canonicalListingRowSetSha256(rows),attemptSetSha256:digest(attempts),canonicalRows:rows.length,targetDates:[date],attempts,propertyAliases:listingPropertyAliases(rows),producerCodeSha256s:[digest('synthetic-producer')],producerSetSha256:digest([digest('synthetic-producer')]),sourceFiles:reports.map(r=>({path:'/synthetic/'+r.runId+'.json',sha256:r.rawSha256}))};return {rows,attempts,reports,sourceSnapshot,targetDates:[date],asOf,sourceSnapshotSha256:digest(sourceSnapshot),baselineBundleSha256:'b'.repeat(64),policy:{version:'synthetic_listing',maxCurrentAgeHours:48,maxComparisonAgeHours:168,minProperties:3,validForMinutes:120,productionAccepted:false as const}};}
const paired=(ratios=[1,1,1])=>ratios.flatMap((ratio,i)=>[row('p'+i,'2026-10-30T03:00:00Z',10000),row('p'+i,'2026-11-01T03:00:00Z',10000*ratio)]);
it('reports missing previous/cohort/base boundaries without reducing observed-property counts',()=>{
 const x=input([row('only','2026-11-01T03:00:00Z',10000),row('cohort','2026-10-30T03:00:00Z',10000),row('cohort','2026-11-01T03:00:00Z',11000,{source_tax_or_fee_classification:'other'}),row('member','2026-11-01T03:00:00Z',10000,{source_classification:'booking_member_conditional'})]);
 const d=analyzeObservedListingRelative(x).days[0]!;expect(d.observedProperties).toBe(3);expect(d.commonProperties).toBe(0);expect(Object.fromEntries(d.pairDiagnostics.map(p=>[p.propertyId,p.firstExclusion]))).toEqual({only:'NO_PREVIOUS_OBSERVATION',cohort:'PREVIOUS_COHORT_MISMATCH',member:'BASE_STRATUM_EXCLUDED'});
});
it('feeds original observedAt and listing basis only from a bound normal terminal',()=>{
 const r=row('p0','2026-11-01T03:00:00Z',10000),run='auto_runner_market_refresh_rotating_20261101_120000';
 expect(listingPlannerStates(analyzeObservedListingRelative(input([r])))[0]?.lastUsableAt).toBeNull();
 r.raw.debug_artifact_path='/synthetic/auto-runner-market-refresh-rotating/20261101_120000/booking/p0_'+date;
 const rawJson=JSON.stringify({run_id:run,dry_run:false,decision:'rotating_market_refresh_success',generated_at_jst:r.raw.collected_at_jst,rate_cell_evidence:{captures:[{propertySlug:'p0',stayDate:date,attemptedNetwork:true,completedAt:'2026-11-01T03:06:00Z',pageFinalBlockStateVerified:true,informationFailureCode:null}]}}),reports=[{runId:run,rawSha256:createHash('sha256').update(rawJson).digest('hex'),rawJson}];
 expect(listingPlannerStates(analyzeObservedListingRelative(input([r],[],reports)))[0]).toMatchObject({lastUsableAt:r.raw.collected_at_jst,usableBasisVersion:'OBSERVED_LISTING_RELATIVE_V1',comparisonRequired:true});
 const failed=analyzeObservedListingRelative(input([r],[{propertyId:'p0',stayDate:date,attemptedAt:'2026-11-01T03:10:00Z',completedObservationRowId:null}],reports));expect(listingPlannerStates(failed)[0]).toMatchObject({lastUsableAt:null,usableBasisVersion:null,comparisonRequired:false});
 const tampered=input([r],[],reports);r.raw.source_primary_price='20000';expect(()=>analyzeObservedListingRelative(tampered)).toThrow('LISTING_INDEPENDENT_PROJECTION_BINDING');
});
it('adopts observed listing neutrality without claiming public fixed-product admission or probability',()=>{
 const d=analyzeObservedListingRelative(input(paired())),a=d.days[0]!;expect(a.status).toBe('SUPPORTED_NEUTRAL');expect(a.commonProperties).toBe(3);expect(a.relativeIndex).toBe(1);expect(a.influenceAttenuation).toBeGreaterThan(0);expect(a.unknownShare).toBe(1);expect(a.comparisons[0]!.productIdentity).toBe('ROOM_PLAN_NOT_PROVED_LISTING_COMPARISON');expect(d.schema).toBe('OBSERVED_LISTING_RELATIVE_V1');expect(d.fixedProductIndex).toBe(false);expect(d.priceAuthority).toBe(false);
});
it('reports common-property price movement and leave-one-out uncertainty separately from inventory',()=>{
 const a=analyzeObservedListingRelative(input(paired([.9,1,1.1]))).days[0]!;expect(a.relativeIndex).toBe(1);expect(a.leaveOneOut.min).toBeCloseTo(.95);expect(a.leaveOneOut.max).toBeCloseTo(1.05);expect(a.influenceAttenuation).toBeLessThan(.3);expect(a.comparisons.every(x=>x.observationIntervalHours===48)).toBe(true);
});
it.each([.9,1,1.1])('keeps same-facility same-stay-date direction for ratio %s distinct from missing market',ratio=>{
 const day=analyzeObservedListingRelative(input(paired([ratio,ratio,ratio]))).days[0]!;
 expect(day.commonProperties).toBe(3);expect(day.relativeIndex).toBeCloseTo(ratio);
 expect(day.status).toBe(ratio===1?'SUPPORTED_NEUTRAL':'SUPPORTED_CHANGE');
 expect(day.eligible).toBe(true);expect(day.influenceAttenuation).toBeGreaterThan(0);
 expect(day.comparisons.every(c=>c.observationIntervalHours===48)).toBe(true);
 expect(analyzeObservedListingRelative(input([])).days[0]!.status).toBe('INSUFFICIENT_Y_ONLY');
});
it('does not turn current failures or missing amounts into old success or a zero price',()=>{
 const rows=paired();rows.push(row('p0','2026-11-01T03:10:00Z',10000,{availability_status:'navigation_failed',source_primary_price:'',normalized_total_price:'',collected_date_jst:'2026-11-02'}));const a=analyzeObservedListingRelative(input(rows)).days[0]!;expect(a.commonProperties).toBe(2);expect(a.status).toBe('INSUFFICIENT_Y_ONLY');expect(a.failures.flatMap(x=>x.reasons)).toContain('LATEST_NOT_AVAILABLE_PRICE');
});
it('rejects a newer uncompleted attempt and requires the actual final report tuple/time receipt for a link',()=>{
 const x=input(paired());const current=x.rows.find(r=>r.raw.source_slug_or_code==='p0'&&r.raw.collected_date_jst==='2026-11-01')!;
 const attempt={propertyId:'p0',stayDate:date,attemptedAt:'2026-11-01T03:05:00Z',completedObservationRowId:null as string|null};
 expect(analyzeObservedListingRelative(input(x.rows,[attempt])).days[0]!.commonProperties).toBe(2);
 const linked={...attempt,completedObservationRowId:current.rowId};expect(()=>analyzeObservedListingRelative(input(x.rows,[linked]))).toThrow('LISTING_ATTEMPT_COMPLETION_RECEIPT');
 current.raw.debug_artifact_path='/synthetic/auto-runner-market-refresh-rotating/20261101_120000/booking/p0_'+date;
 const rawJson=JSON.stringify({run_id:'auto_runner_market_refresh_rotating_20261101_120000',dry_run:false,decision:'rotating_market_refresh_success',generated_at_jst:'2026-11-01T03:00:00Z',rate_cell_evidence:{captures:[{propertySlug:'p0',stayDate:date,attemptedNetwork:true,completedAt:'2026-11-01T03:06:00Z',pageFinalBlockStateVerified:true,informationFailureCode:null}]}}),report={runId:'auto_runner_market_refresh_rotating_20261101_120000',rawSha256:createHash('sha256').update(rawJson).digest('hex'),rawJson};
 expect(analyzeObservedListingRelative(input(x.rows,[linked],[report])).days[0]!.commonProperties).toBe(3);
 expect(()=>analyzeObservedListingRelative(input(x.rows,[{...linked,attemptedAt:'2026-11-01T04:00:00Z'}],[report]))).toThrow();
 expect(()=>analyzeObservedListingRelative(input(x.rows,[{...linked,propertyId:'other'}],[report]))).toThrow('LISTING_ATTEMPT_ROW_TUPLE');
});
it.each([{group_adults:'1'},{group_children:'1'},{no_rooms:'2'},{currency:'USD'},{checkout:'2027-01-08'},{checkout:'2027-02-30'},{source_primary_price:'100'},{source_tax_or_fee_classification:'tax_only'}])('refuses wrong tuple, impossible calendar or non-primary money (%j)',change=>{
 const rows=paired();rows[1]=row('p0','2026-11-01T03:00:00Z',10000,change);expect(analyzeObservedListingRelative(input(rows)).days[0]!.commonProperties).toBe(2);
});
it('retains unknown fee/tax labels and original primary amount rather than assuming zero fees or gross total',()=>{
 const rows=paired().map(r=>row(r.raw.source_slug_or_code!,r.raw.collected_at_jst!,10000,{normalized_total_price:'10300'}));const a=analyzeObservedListingRelative(input(rows)).days[0]!;expect(a.status).toBe('SUPPORTED_NEUTRAL');expect(a.levelMedianJpy).toBe(10000);expect(a.comparisons[0]!.current.tax).toBe('official_visible_adder_not_available');
});
it('does not compare changed known tax/member/meal cohorts as the same listing stratum',()=>{
 for(const change of [{source_tax_or_fee_classification:'other_basis'},{source_classification:'booking_member_conditional'},{warning_flags:'meal_basis=meal_included'}]){const rows=paired();rows[1]=row('p0','2026-11-01T03:00:00Z',10000,change);expect(analyzeObservedListingRelative(input(rows)).days[0]!.commonProperties).toBe(2);}
});
it('rejects mirror mismatch, own property, stale current evidence and same-time conflicts',()=>{
 for(const change of ['mirror','own','stale','conflict']){const x=input(paired());if(change==='mirror')x.rows[1]!.mirrorRowHash='c'.repeat(64);if(change==='own')x.rows[1]=row('p0','2026-11-01T03:00:00Z',10000,{canonical_property_name:'ホテル喜らく'});if(change==='stale')x.policy.maxCurrentAgeHours=.1;if(change==='conflict')x.rows.push(row('p0','2026-11-01T03:00:00Z',11000,{collected_date_jst:'2026-11-02'}));const bound=input(x.rows);bound.policy=x.policy;expect(analyzeObservedListingRelative(bound).days[0]!.status).toBe('INSUFFICIENT_Y_ONLY');}
});
it('does not manufacture pairs from different facilities and seals the complete canonical row set',()=>{
 const x=input([row('a','2026-10-30T03:00:00Z',10000),row('b','2026-11-01T03:00:00Z',12000)]),d=analyzeObservedListingRelative(x);expect(d.days[0]!.commonProperties).toBe(0);expect(d.days[0]!.status).toBe('INSUFFICIENT_Y_ONLY');expect(d.canonicalRowSetSha256).not.toBe(analyzeObservedListingRelative(input(x.rows.slice(1))).canonicalRowSetSha256);expect(()=>analyzeObservedListingRelative({...x,rows:[x.rows[0]!,x.rows[0]!]})).toThrow();
});
it.each(['source_primary_price','collected_at_jst','group_adults'])('independent full projection covers %s omitted by legacy rowHash',field=>{const x=input(paired());x.rows[1]!.raw[field]=field==='source_primary_price'?'12000':field==='group_adults'?'1':'2026-11-01T03:20:00Z';expect(()=>analyzeObservedListingRelative(x)).toThrow('LISTING_INDEPENDENT_PROJECTION_BINDING');});
it('never chooses an anchor by row ID when previous timestamp has conflicting price or cohort',()=>{
 const rows=paired(),conflict=row('p0','2026-10-30T03:00:00Z',20000);conflict.rowId+='|intraday';conflict.raw.row_id=conflict.rowId;rows.push(conflict);
 for(const xs of [rows,[...rows].reverse()]){const d=analyzeObservedListingRelative(input(xs)).days[0]!;expect(d.commonProperties).toBe(2);expect(d.failures.flatMap(f=>f.reasons)).toContain('PREVIOUS_SAME_TIME_CONFLICT');}
});
it('keeps known quarantined row identity out of current and comparison prices',()=>{const rows=paired();rows[1]!.quarantineReason='KNOWN_UNPROVEN_PROVENANCE';expect(analyzeObservedListingRelative(input(rows)).days[0]!.commonProperties).toBe(2);});

it('same-time unresolved attempts invalidate current and cannot depend on array order',()=>{const rows=paired(),a={propertyId:'p0',stayDate:date,attemptedAt:'2026-11-01T03:00:00Z',completedObservationRowId:null};for(const attempts of [[a],[a,{...a,propertyId:'p1'}],[{...a,propertyId:'p1'},a]])expect(analyzeObservedListingRelative(input(rows,attempts)).days[0]!.status).toBe('INSUFFICIENT_Y_ONLY');});

it('aliases of the same Booking facility cannot manufacture a third facility vote',()=>{const rows=paired().filter(r=>r.raw.source_slug_or_code!=='p2');rows.push(row('p0','2026-10-29T03:00:00Z',10000,{canonical_property_name:'Other alias'}),row('p0','2026-10-31T03:00:00Z',10000,{canonical_property_name:'Other alias'}));const d=analyzeObservedListingRelative(input(rows)).days[0]!;expect(d.commonProperties).toBe(2);expect(d.status).toBe('INSUFFICIENT_Y_ONLY');});

it('known own facility ID remains excluded under an unknown historical name alias',()=>{const rows=paired();rows.push(row('xi-raku','2026-10-30T03:00:00Z',10000,{canonical_property_name:'Unknown historical alias'}),row('xi-raku','2026-11-01T03:00:00Z',10000,{canonical_property_name:'Unknown historical alias'}));const d=analyzeObservedListingRelative(input(rows)).days[0]!;expect(d.commonProperties).toBe(3);expect(d.failures.some(f=>f.propertyId==='xi-raku'&&f.reasons.includes('OWN_PROPERTY'))).toBe(true);});

it('an unresolved known request alias invalidates the same physical facility success',()=>{const rows=paired();rows.push(row('alias-p0','2026-10-29T03:00:00Z',10000,{source_property_id:'p0'}));const a={propertyId:'alias-p0',stayDate:date,attemptedAt:'2026-11-01T03:10:00Z',completedObservationRowId:null};const d=analyzeObservedListingRelative(input(rows,[a])).days[0]!;expect(d.commonProperties).toBe(2);expect(d.status).toBe('INSUFFICIENT_Y_ONLY');});

it('a known alias on another projected stay date still invalidates this physical facility attempt',()=>{const rows=paired();rows.push(row('alias-p0','2026-10-29T03:00:00Z',10000,{source_property_id:'p0',checkin:'2027-01-07',checkout:'2027-01-08'}));const x=input(rows,[{propertyId:'alias-p0',stayDate:date,attemptedAt:'2026-11-01T03:10:00Z',completedObservationRowId:null}]);x.targetDates.push('2027-01-07');x.sourceSnapshot.targetDates.push('2027-01-07');x.sourceSnapshotSha256=digest(x.sourceSnapshot);expect(analyzeObservedListingRelative(x).days[0]!.commonProperties).toBe(2);});

it('an exact current-age boundary is local Y-only rather than an eligible zero-lifetime signal',()=>{const x=input(paired());x.policy.maxCurrentAgeHours=.5;const d=analyzeObservedListingRelative(x).days[0]!;expect(d.status).toBe('INSUFFICIENT_Y_ONLY');expect(d.eligible).toBe(false);});

it('same physical current or previous cannot evade a failed same-time alias by row order',()=>{for(const at of ['2026-11-01T03:00:00Z','2026-10-30T03:00:00Z']){const rs=paired(),bad=row('p0',at,10000,{canonical_property_name:'ZZZ alias'});bad.quarantineReason='OBSERVATION_FINAL_GUARD_UNVERIFIED';rs.push(bad);for(const rows of [rs,[...rs].reverse()]){const d=analyzeObservedListingRelative(input(rows)).days[0]!;expect(d.commonProperties).toBe(2);expect(d.failures.some(f=>f.propertyId==='p0')).toBe(true);}}});
it('an otherwise sealed attempted completion cannot claim a failed final guard as a usable receipt',()=>{const rows=paired(),r=rows[1]!,run='auto_runner_market_refresh_rotating_20261101_120000';r.raw.debug_artifact_path='/synthetic/auto-runner-market-refresh-rotating/20261101_120000/booking/p0_'+date;const rawJson=JSON.stringify({run_id:run,dry_run:false,decision:'rotating_market_refresh_success',generated_at_jst:r.raw.collected_at_jst,rate_cell_evidence:{captures:[{propertySlug:'p0',stayDate:date,attemptedNetwork:true,completedAt:'2026-11-01T03:06:00Z',pageFinalBlockStateVerified:false,informationFailureCode:'ABORT_DRAIN_TIMEOUT'}]}}),reports=[{runId:run,rawSha256:createHash('sha256').update(rawJson).digest('hex'),rawJson}],a={propertyId:'p0',stayDate:date,attemptedAt:'2026-11-01T03:05:00Z',completedObservationRowId:r.rowId};expect(()=>analyzeObservedListingRelative(input(rows,[a],reports))).toThrow('LISTING_ATTEMPT_COMPLETION_FINAL_GUARD');const d=analyzeObservedListingRelative(input(rows,[{...a,completedObservationRowId:null}],reports)).days[0]!;expect(d.commonProperties).toBe(2);expect(d.observedProperties).toBe(2);});

it('a failed row on one date does not remove good same-facility evidence on another date',()=>{const first=paired();first[1]!.quarantineReason='OBSERVATION_FINAL_GUARD_UNVERIFIED';const next=paired().map(r=>row(r.raw.source_slug_or_code!,r.raw.collected_at_jst!,10000,{checkin:'2027-01-07',checkout:'2027-01-08'})),x=input([...first,...next]);x.targetDates.push('2027-01-07');x.sourceSnapshot.targetDates.push('2027-01-07');x.sourceSnapshotSha256=digest(x.sourceSnapshot);const d=analyzeObservedListingRelative(x).days;expect(d[0]!.commonProperties).toBe(2);expect(d[1]!.commonProperties).toBe(3);expect(d[1]!.status).toBe('SUPPORTED_NEUTRAL');});

import {describe,it,expect} from 'vitest';
import {digest,sealQualityLedger,priceAdmission,qualityIndex,bindVerifiedAppendOnlyDelta,type QualityEntry} from '../src/services/marketRowPriceQuality';
import {buildTwoPersonCurve,sealPanel,marketConditionKey,type TwoPersonObservation,type CurveQualityPolicy} from '../src/services/marketTwoPersonCurve';
const h=(s:unknown)=>digest(s),t0='2026-10-28T00:00:00Z',t1='2026-10-29T00:00:00Z',day='2027-02-20';
const cond={meal:'ROOM_ONLY' as const,cancellation:'NON_REFUNDABLE' as const,prepayment:'REQUIRED' as const,discount:'PUBLIC' as const,tax:'ALL_MANDATORY_INCLUDED' as const};
const ck=marketConditionKey(cond,'public-terms-v1');
const panel=sealPanel({version:'panel-v1',region:'ZAO_ONSEN',category:'ALL',ownPropertyIds:['kiraku','miuraya'],products:[0,1,2,3].map(i=>({propertyId:'p'+i,sourcePropertyId:'p'+i,source:'booking' as const,productId:'double',ratePlanId:'plan',conditionKey:ck,groupId:'group'+i,weight:1,standardProduct:{kind:'DOUBLE' as const,maxAdults:2 as const,evidenceSha256:h('product'+i)}}))});
const policy:CurveQualityPolicy={version:'candidate-v1',maxAgeHours:36,minProperties:3,minEffectiveSampleSize:2,minKnownGroups:2,minMatchedCoverage:0.5,maxConcentration:0.5,maxUnknownWeight:0.1,maxDispersionLog:0.05,maxLeaveOneOutLog:0.06};
function obs(i:number,t:string,price:number):TwoPersonObservation{return {rowId:'row_'+i+'_'+t.replace(/[^0-9]/gu,''),rowHash:h([i,t,price]),propertyId:'p'+i,sourcePropertyId:'p'+i,source:'booking',productId:'double',ratePlanId:'plan',conditionKey:ck,conditionsVersion:'public-terms-v1',stayDate:day,observedAt:t,ingestedAt:t,receiptSha256:h('receipt'+i+t),adults:2,children:0,rooms:1,nights:1,currency:'JPY',...cond,result:'AVAILABLE',totalJpy:price};}
function setup(){const rows=[0,1,2,3].flatMap(i=>[obs(i,t0,10000*(i+1)),obs(i,t1,11000*(i+1))]);return rows;}
function run(rows=setup(),p=panel,mutate?:(x:any)=>void){
 const entries=rows.map(r=>({rowId:r.rowId,rowHash:r.rowHash,status:'VERIFIED_SOURCE' as const,observedAt:r.observedAt,ingestedAt:r.ingestedAt,receiptSha256:r.receiptSha256,observationSha256:digest(r)}));
 const q=sealQualityLedger(entries),anchor=rows.filter(r=>r.observedAt===t0).map(r=>[r.rowId,r.rowHash,r.receiptSha256]).sort((a,b)=>a[0]!.localeCompare(b[0]!));
 const input={panel:p,policy,asOf:t1,stayDates:[day],reference:{version:'explicit-B-bound-t0',mode:'SAME_STAY_CHANGE' as const,asOf:t0,baselineBundleSha256:h('real-bundle-fixture'),panelSha256:p.panelSha256,anchorSnapshotSha256:digest(anchor)},observations:rows,qualityLedger:q,expectedQualitySha256:q.ledgerSha256,trustedReceiptSha256:new Set(rows.map(r=>r.receiptSha256))};
 mutate?.(input);return buildTwoPersonCurve(input);
}
describe('2P normalized market curve',()=>{
 it('normalizes each fixed product, emits real 1.10 change independently of price level',()=>{const x=run();expect(x.curves[0]).toMatchObject({eligible:true,nProperties:4,knownGroups:4,matchedCoverage:1});expect(x.curves[0]!.curveIndex).toBeCloseTo(1.1);expect(x.priceAuthority).toBe(false);});
 it('panel removal or price-level change alone cannot fake movement',()=>{const rows=setup().map(r=>({...r,totalJpy:r.observedAt===t1?10000*(Number(r.propertyId.slice(1))+1):r.totalJpy}));expect(run(rows).curves[0]!.curveIndex).toBe(1);});
 it('own-price changes are excluded from the index and snapshot',()=>{const x=run(),self={...obs(4,t1,999999),propertyId:'kiraku'};const y=run([...setup(),self]);expect(y.curves).toEqual(x.curves);});
 it('never substitutes an expensive remaining room or another OTA for a missing fixed product',()=>{const rows=setup().filter(r=>!(r.propertyId==='p0'&&r.observedAt===t1));rows.push({...obs(0,t1,0),result:'PRODUCT_UNAVAILABLE',totalJpy:null});rows.push({...obs(0,t1,50000),rowId:'suite_quote',productId:'suite'});const x=run(rows);expect(x.curves[0]!.nProperties).toBe(3);expect(x.curves[0]!.eligible).toBe(false);expect(x.curves[0]!.reasonCodes).toContain('ANCHOR_COHORT_INCOMPLETE');});
 it('later failure prevents stale successful quote resurrection and is not sold out/price zero',()=>{const rows=setup();rows.push({...obs(0,'2026-10-29T00:01:00Z',123),result:'FETCH_FAILED',totalJpy:null});const x=run(rows,panel,i=>{i.asOf='2026-10-29T00:02:00Z';});expect(x.curves[0]!.nProperties).toBe(3);expect(x.curves[0]!.productAvailability.fetchFailed).toBe(1);expect(x.curves[0]!.productAvailability.hotelOccupancyRate).toBeNull();});
 it('single chain and unknown ownership do not count as independent properties',()=>{const p=sealPanel({...panel,products:panel.products.map(x=>({...x,groupId:'one-chain'}))});const x=run(setup(),p);expect(x.curves[0]!.eligible).toBe(false);expect(x.curves[0]!.effectiveSampleSize).toBe(1);expect(x.curves[0]!.reasonCodes).toContain('GROUP_CONCENTRATION');});
 it('same-property multiple sources cannot inflate its weight',()=>{const p=sealPanel({...panel,products:[...panel.products,{...panel.products[0]!,source:'jalan'}]});expect(()=>run(setup(),p)).toThrow('PANEL_PROPERTY_WEIGHT_INFLATION');});
 it('quarantines unproven/rehash and unknown rows even if legacy usable=true',()=>{const x=run(setup(),panel,i=>{i.qualityLedger=sealQualityLedger(i.qualityLedger.entries.map((q:QualityEntry)=>q.rowId.includes('20261029')?{...q,status:'UNVERIFIED_PROVENANCE',receiptSha256:null}:q));i.expectedQualitySha256=i.qualityLedger.ledgerSha256;});expect(x.curves[0]!.eligible).toBe(false);expect(x.curves[0]!.nProperties).toBe(0);});
 it('ingestion after asOf cannot enter anchor or signal',()=>{const x=run(setup(),panel,i=>{i.asOf='2026-10-28T12:00:00Z';});expect(x.curves[0]!.curveIndex).toBe(1);expect(x.exclusions.NOT_KNOWN_ASOF).toBe(4);});
 it('requires original reference row-set and frozen baseline binding, never invents an anchor',()=>{expect(()=>run(setup(),panel,i=>{i.reference.anchorSnapshotSha256=h('invented');})).toThrow('ANCHOR_SNAPSHOT_BINDING');});
 it('rejects 6P, 2-night, unknown tax/member conditions and invalid price as contract errors',()=>{for(const change of [{adults:6},{nights:2},{tax:'UNKNOWN'},{discount:'MEMBER'},{totalJpy:0}])expect(()=>run([{...setup()[0]!,...change} as TwoPersonObservation])).toThrow('TWO_PERSON_OBSERVATION_CONTRACT');});
 it('does not reclassify conditions, room or rate-plan changes as same series',()=>{const rows=setup();rows[1]={...rows[1]!,conditionsVersion:'other-plan',conditionKey:marketConditionKey(cond,'other-plan')};expect(run(rows).curves[0]!.curveIndex).toBeCloseTo(1.1);});
 it('stale signal is ineligible rather than a flat market',()=>{const x=run(setup(),panel,i=>{i.asOf='2026-11-02T00:00:00Z';});expect(x.curves[0]!.eligible).toBe(false);expect(x.curves[0]!.curveIndex).toBeNull();});
 it('leave-one-group-out instability refuses biased composition',()=>{const rows=setup().map(r=>r.observedAt===t1?{...r,totalJpy:Math.round(r.totalJpy!*(r.propertyId==='p0'?1.4:r.propertyId==='p1'?1.4:1))}:r);const x=run(rows);expect(x.curves[0]!.eligible).toBe(false);expect(x.curves[0]!.reasonCodes).toContain('LEAVE_ONE_OUT_UNSTABLE');});
});
describe('quality ledger and incremental acceptance',()=>{
 const entry:QualityEntry={rowId:'legacy_488',rowHash:h('saved-original'),status:'SAVED_DB_JSON_REHASHED',observedAt:'2026-06-18T00:00:00Z',ingestedAt:'2026-06-18T01:00:00Z',receiptSha256:null,observationSha256:null};
 it('legacy stays original timestamp, authenticity not established, never fresh after repair',()=>{const q=sealQualityLedger([entry]);expect(priceAdmission(entry,qualityIndex(q,q.ledgerSha256),null,new Set(),t1).reason).toBe('ORIGINAL_SOURCE_AUTHENTICITY_NOT_ESTABLISHED_STALE');expect(q.entries[0]!.observedAt).toBe(entry.observedAt);});
 it('independent receipt is required even for a correctly self-sealed row',()=>{const r=obs(0,t1,1000),q=sealQualityLedger([{...entry,rowId:r.rowId,rowHash:r.rowHash,status:'VERIFIED_SOURCE',observedAt:t1,ingestedAt:t1,receiptSha256:r.receiptSha256,observationSha256:digest(r)}]);expect(priceAdmission(r,qualityIndex(q,q.ledgerSha256),r.receiptSha256,new Set(),t1).eligible).toBe(false);});
 it('adopts verified append-only delta without old quarantine blocking new authenticated rows',()=>{const r=obs(0,t1,1000),q=sealQualityLedger([entry,{...entry,rowId:r.rowId,rowHash:r.rowHash,status:'VERIFIED_SOURCE',observedAt:t1,ingestedAt:t1,receiptSha256:r.receiptSha256,observationSha256:digest(r)}]);const x=bindVerifiedAppendOnlyDelta([entry],[entry,r],q,q.ledgerSha256,new Set([r.receiptSha256]),t1,1);expect(x.addedRows).toBe(1);expect(x.applyAuthorized).toBe(false);});
 it('refuses overwrite/deletion/duplicate/new unproven append or scope expansion',()=>{const q=sealQualityLedger([entry]),fn=(rows:any[],cap=1)=>bindVerifiedAppendOnlyDelta([entry],rows,q,q.ledgerSha256,new Set(),t1,cap);expect(()=>fn([])).toThrow('DELETION');expect(()=>fn([{...entry,rowHash:h('changed')}])).toThrow('OVERWRITE');expect(()=>fn([entry,entry])).toThrow('DUPLICATE');expect(()=>fn([entry,obs(0,t1,1000)])).toThrow('UNVERIFIED');expect(()=>fn([entry,obs(0,t1,1000)],0)).toThrow('EXPANDED');});
});

it('never emits an eligible composition-only shift when a proven date cohort member disappears',()=>{
 const rows=setup().map(r=>r.observedAt===t1?{...r,totalJpy:Math.round(10000*(Number(r.propertyId.slice(1))+1)*(1.01+Number(r.propertyId.slice(1))*0.005))}:r);
 expect(run(rows).curves[0]!.eligible).toBe(true);
 rows.push({...obs(0,'2026-10-29T00:01:00Z',1),result:'PRODUCT_UNAVAILABLE',totalJpy:null});
 const c=run(rows,panel,i=>{i.asOf='2026-10-29T00:02:00Z';}).curves[0]!;
 expect(c.eligible).toBe(false);expect(c.reasonCodes).toContain('ANCHOR_COHORT_INCOMPLETE');
});

it('a post-anchor failure cannot erase the failure already known at the anchor cutoff',()=>{
 const x=run(setup(),panel,i=>{
  i.reference.asOf='2026-10-28T12:00:00Z';
  i.invalidations=['2026-10-28T06:00:00Z','2026-10-28T18:00:00Z'].map(t=>({propertyId:'p0',sourcePropertyId:'p0',source:'booking',productId:'double',ratePlanId:'plan',conditionKey:ck,stayDate:day,observedAt:t,ingestedAt:t,reason:'FETCH_FAILED',sourceEvidenceSha256:h(t)}));
 });
 expect(x.curves[0]!.anchorProducts).toBe(3);expect(x.curves[0]!.nProperties).toBe(3);
});

import {normalAttemptInvalidations} from '../src/services/twoPersonMarketAdmissionLane';
import {it,expect} from 'vitest';
import {buildCurveFromCanonicalAdmissions,type CanonicalTwoPersonAdmission} from '../src/services/twoPersonCurveFromAdmissions';
import {digest,sealQualityLedger} from '../src/services/marketRowPriceQuality';
import {sealPanel,marketConditionKey,type TwoPersonObservation} from '../src/services/marketTwoPersonCurve';
const t0='2026-10-28T00:00:00Z',t1='2026-10-29T00:00:00Z',day='2027-01-15',conditions={meal:'ROOM_ONLY' as const,cancellation:'NON_REFUNDABLE' as const,prepayment:'REQUIRED' as const,discount:'PUBLIC' as const,tax:'ALL_MANDATORY_INCLUDED' as const},conditionKey=marketConditionKey(conditions,'terms');
function setup(){
 const panel=sealPanel({version:'fixed-panel',region:'zao',category:'all',ownPropertyIds:['kiraku'],products:[0,1,2,3].map(i=>({propertyId:'physical'+i,sourcePropertyId:'source'+i,source:'booking' as const,productId:'double',ratePlanId:'public',conditionKey,groupId:'g'+i,weight:1,standardProduct:{kind:'DOUBLE' as const,maxAdults:2 as const,evidenceSha256:digest('real-size-proof-fixture'+i)}}))});
 const byTime=[t0,t1].map((t,k)=>panel.products.map((p,i)=>({rowId:'row_'+i+'_'+k,rowHash:digest([i,k]),propertyId:p.propertyId,sourcePropertyId:p.sourcePropertyId,source:p.source,productId:p.productId,ratePlanId:p.ratePlanId,conditionKey,conditionsVersion:'terms',stayDate:day,observedAt:t,ingestedAt:t,receiptSha256:digest(['source-receipt',i,k]),adults:2 as const,children:0 as const,rooms:1 as const,nights:1 as const,currency:'JPY' as const,...conditions,result:'AVAILABLE' as const,totalJpy:Math.round((10000+i*1000)*(k?1.1:1))})));
 const admissions=byTime.map((facts,k)=>{const qualityLedger=sealQualityLedger(facts.map(f=>({rowId:f.rowId,rowHash:f.rowHash,status:'VERIFIED_SOURCE' as const,observedAt:f.observedAt,ingestedAt:f.ingestedAt,receiptSha256:f.receiptSha256,observationSha256:digest(f)}))),body={schema:'ZMI_CANONICAL_2P_ADMISSION_V1' as const,runId:'auto_runner_market_refresh_rotating_'+(k?'20261029':'20261028')+'_000006',ingestedAt:k?t1:t0,panelSha256:panel.panelSha256,producerCodeSha256:digest('accepted-code'),mirrorExactVerified:true,invalidations:[],source:'NORMAL_TRUSTED_APPEND_AND_EXACT_MIRROR' as const,facts,qualityLedger,exclusions:{},marketPriceAuthority:false as const};const receipt={...body,admissionSha256:digest(body)};return {receipt,independentlyPinnedSha256:receipt.admissionSha256};});
 return {panel,policy:{version:'candidate-quality',maxAgeHours:36,minProperties:3,minEffectiveSampleSize:2,minKnownGroups:2,minMatchedCoverage:0.5,maxConcentration:0.5,maxUnknownWeight:0.1,maxDispersionLog:0.1,maxLeaveOneOutLog:0.1},reference:{version:'B-bound-source-anchor',mode:'SAME_STAY_CHANGE' as const,asOf:t0,baselineBundleSha256:digest('real-B-fixture'),panelSha256:panel.panelSha256,anchorSnapshotSha256:digest(byTime[0]!.map(r=>[r.rowId,r.rowHash,r.receiptSha256]).sort((a,b)=>a[0]!.localeCompare(b[0]!)))},asOf:t1,stayDates:[day],admissions,quarantined:[],acceptedProducerCodeSha256:new Set([digest('accepted-code')])};
}
it('connects two source-bound normal admissions to a sealed nonflat canonical curve',()=>{const x=buildCurveFromCanonicalAdmissions(setup());expect(x.curves[0]!.eligible).toBe(true);expect(x.curves[0]!.curveIndex).toBeCloseTo(1.1);expect(x.canonicalRoute).toBe('NORMAL_TRUSTED_APPEND_AND_EXACT_MIRROR');expect(x.priceAuthority).toBe(false);});
it('rejects a self-sealed alternate route, wrong independent pin, changed fact or panel swap',()=>{for(const change of ['route','pin','fact','panel']){const x=setup();if(change==='route')x.admissions[0]!.receipt.source='ANOTHER_CSV' as any;if(change==='pin')x.admissions[0]!.independentlyPinnedSha256='0'.repeat(64);if(change==='fact')x.admissions[0]!.receipt.facts[0]!.totalJpy=1;if(change==='panel')x.admissions[0]!.receipt.panelSha256='0'.repeat(64);expect(()=>buildCurveFromCanonicalAdmissions(x)).toThrow();}});
it('does not silently promote an explicitly quarantined row through a newer admission',()=>{const x=setup(),f=x.admissions[0]!.receipt.facts[0]!;const quarantined=[{rowId:f.rowId,rowHash:f.rowHash,status:'UNVERIFIED_PROVENANCE' as const,observedAt:f.observedAt,ingestedAt:null,receiptSha256:null,observationSha256:null}];expect(()=>buildCurveFromCanonicalAdmissions({...x,quarantined})).toThrow('QUALITY_CONFLICT');});
it('an unsupported empty market is missing rather than fabricated flat M1',()=>{const x=setup();x.admissions=[];x.reference.anchorSnapshotSha256=digest([]);const c=buildCurveFromCanonicalAdmissions(x);expect(c.curves[0]!.eligible).toBe(false);expect(c.curves[0]!.curveIndex).toBeNull();});

it('actual failed/no-row normal request invalidates an older success through its pinned receipt',()=>{
 const x=setup(),at='2026-10-29T00:01:00Z',base=x.admissions[1]!.receipt;
 const invalidations=normalAttemptInvalidations(x.panel,[{propertySlug:'source0',stayDate:day,attemptedNetwork:true,completedAt:at,status:'CAPTURE_FAILED'}],at,[]);
 const {admissionSha256:old,...body}=base;
 const r:CanonicalTwoPersonAdmission={...body,runId:'auto_runner_market_refresh_rotating_20261029_000106',ingestedAt:at,mirrorExactVerified:false,
  facts:[],qualityLedger:sealQualityLedger([]),invalidations,admissionSha256:''};
 const {admissionSha256:ignored,...sealed}=r;r.admissionSha256=digest(sealed);
 x.admissions.push({receipt:r as any,independentlyPinnedSha256:r.admissionSha256});x.asOf=at;
 const curve=buildCurveFromCanonicalAdmissions(x);expect(curve.curves[0]!.nProperties).toBe(3);expect(curve.curves[0]!.eligible).toBe(false);
 expect(curve.curves[0]!.reasonCodes).toContain('ANCHOR_COHORT_INCOMPLETE');expect(curve.curves[0]!.productAvailability.invalidatedProducts).toBe(1);
});
it('no-network reservation refusal cannot invalidate an existing success',()=>{
 const x=setup();expect(normalAttemptInvalidations(x.panel,[{propertySlug:'source0',stayDate:day,status:'REQUEST_RESERVATION_REFUSED_NO_NETWORK'}],t1,[])).toEqual([]);
 expect(buildCurveFromCanonicalAdmissions(x).curves[0]!.eligible).toBe(true);
});
it('unaccepted producer code cannot self-seal a canonical receipt',()=>{const x=setup();x.acceptedProducerCodeSha256.clear();expect(()=>buildCurveFromCanonicalAdmissions(x)).toThrow('CANONICAL_ADMISSION');});

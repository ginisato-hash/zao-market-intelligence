// Synthetic source receipts only. No live/source/API data or operational price-policy values.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {digest,sealQualityLedger} from '../../src/services/marketRowPriceQuality';
import {sealPanel,marketConditionKey,type TwoPersonObservation,type TwoPersonInvalidation} from '../../src/services/marketTwoPersonCurve';
import type {CanonicalTwoPersonAdmission} from '../../src/services/twoPersonCurveFromAdmissions';
import type {RmsQuoteRequest} from '../../src/services/rmsQuoteRequest';
import type {CurvePublicationConfig,AdmissionRef} from '../../src/services/twoPersonCurvePublication';
export const fixtureT0='2026-10-28T00:00:00.000Z',fixtureT1='2026-10-29T00:00:00.000Z',fixtureDates=['2027-01-15','2027-01-16'];
export function publicationFixture(root:string,bundleSha256=digest('synthetic-frozen-B')){
 const terms={meal:'ROOM_ONLY' as const,cancellation:'NON_REFUNDABLE' as const,prepayment:'REQUIRED' as const,discount:'PUBLIC' as const,tax:'ALL_MANDATORY_INCLUDED' as const},conditionKey=marketConditionKey(terms,'fixture-terms');
 const producer=digest('synthetic-accepted-producer');
 const panel=sealPanel({version:'fixture-panel',region:'fixture-zao',category:'ALL',ownPropertyIds:['kiraku'],products:[0,1,2,3].map(i=>({propertyId:'physical'+i,sourcePropertyId:'source'+i,source:'booking' as const,productId:'double',ratePlanId:'public',conditionKey,groupId:'group'+i,weight:1,standardProduct:{kind:'DOUBLE' as const,maxAdults:2 as const,evidenceSha256:digest(['synthetic-product',i])}}))});
 const facts=(at:string,ratio:number):TwoPersonObservation[]=>panel.products.flatMap((p,i)=>fixtureDates.map(date=>({rowId:'fixture_'+i+'_'+date+'_'+at,rowHash:digest([i,date,at,ratio]),
  propertyId:p.propertyId,sourcePropertyId:p.sourcePropertyId,source:p.source,productId:p.productId,ratePlanId:p.ratePlanId,conditionKey,conditionsVersion:'fixture-terms',stayDate:date,
  observedAt:at,ingestedAt:at,receiptSha256:digest(['synthetic-capture',i,date,at]),adults:2,children:0,rooms:1,nights:1,currency:'JPY',...terms,result:'AVAILABLE',totalJpy:Math.round((10000+i*1000)*ratio)})));
 mkdirSync(join(root,'.data/history-quality'),{recursive:true});
 function admission(runId:string,at:string,rows:TwoPersonObservation[],invalidations:TwoPersonInvalidation[]=[]){
  const body={schema:'ZMI_CANONICAL_2P_ADMISSION_V1' as const,runId,ingestedAt:at,panelSha256:panel.panelSha256,producerCodeSha256:producer,mirrorExactVerified:rows.length>0,invalidations,
   source:'NORMAL_TRUSTED_APPEND_AND_EXACT_MIRROR' as const,facts:rows,qualityLedger:sealQualityLedger(rows.map(r=>({rowId:r.rowId,rowHash:r.rowHash,status:'VERIFIED_SOURCE',observedAt:r.observedAt,ingestedAt:r.ingestedAt,receiptSha256:r.receiptSha256,observationSha256:digest(r)}))),exclusions:{},marketPriceAuthority:false as const};
  const receipt:CanonicalTwoPersonAdmission={...body,admissionSha256:digest(body)},bytes=JSON.stringify(receipt)+'\n';
  writeFileSync(join(root,'.data/history-quality',runId+'.json'),bytes,{flag:'wx'});
  const pin:AdmissionRef={runId,ingestedAt:at,admissionSha256:receipt.admissionSha256,rawSha256:createHash('sha256').update(bytes).digest('hex')};return {receipt,pin};
 }
 const anchorFacts=facts(fixtureT0,1),anchor=admission('auto_runner_market_refresh_rotating_20261028_000006',fixtureT0,anchorFacts);
 const config:CurvePublicationConfig={schema:'ZMI_2P_CURVE_CONFIG_V1',panel,policy:{version:'synthetic-quality',maxAgeHours:36,minProperties:3,minEffectiveSampleSize:2,minKnownGroups:2,minMatchedCoverage:0.5,maxConcentration:0.5,maxUnknownWeight:0.1,maxDispersionLog:0.1,maxLeaveOneOutLog:0.1},
  reference:{version:'synthetic-B-bound-anchor',mode:'SAME_STAY_CHANGE',asOf:fixtureT0,baselineBundleSha256:bundleSha256,panelSha256:panel.panelSha256,anchorSnapshotSha256:digest(anchorFacts.map(r=>[r.rowId,r.rowHash,r.receiptSha256]).sort((a,b)=>a[0]!.localeCompare(b[0]!)))},
  anchorAdmissions:[anchor.pin],anchorAdmissionSetSha256:digest([anchor.pin.admissionSha256]),acceptedProducerCodes:[producer],quarantined:[]};
 const configBytes=Buffer.from(JSON.stringify(config)),configSha=createHash('sha256').update(configBytes).digest('hex');
 function request(at=fixtureT1):RmsQuoteRequest{
  const body={kind:'K27_MARKET_QUOTE_REQUEST_V1' as const,propertyId:'330695' as const,createdAt:at,expiresAt:new Date(Date.parse(at)+36*3600000).toISOString(),source:{runId:'k27run_2026-10-29_1234abcd',releaseGitSha:'a'.repeat(40),bundleSha256,graphSha256:digest('synthetic-graph'),evidenceSha256:digest(['synthetic-RMS-evidence',at]),observedAt:at},
   needs:fixtureDates.map(stayDate=>({stayDate,admittedAt:at,priceDecisionEligible:true,decisionImpact:0.5,changedAt:null,dateEvidenceSha256:digest(stayDate)}))};return {...body,requestSha256:digest(body)};
 }
 return {root,producer,panel,config,configBytes,configSha,request,facts,admission,anchor};
}

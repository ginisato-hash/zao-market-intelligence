// Read-only feedback into the existing collector, never a publication or price grant.
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readBoundedStableFile as bounded} from './boundedStableFile';
import {captureObservedListingCanonicalInput} from './observedListingCanonicalInput';
import {parseObservedListingPublicationConfig} from './observedListingConfig';
import {assertAcceptedTwoPersonProducer} from './twoPersonMarketAdmissionLane';
import {OBSERVED_LISTING_RELATIVE_V1,type analyzeObservedListingRelative} from './observedListingRelative';
import type {RmsQuoteRequest} from './rmsQuoteRequest';
import type {UsefulQuoteState} from './usefulQuoteRefreshPlanner';

export function listingPlannerStates(artifact:ReturnType<typeof analyzeObservedListingRelative>):UsefulQuoteState[]{
 return artifact.days.flatMap(d=>d.pairDiagnostics.map(p=>{
  const usable=p.currentUsable&&p.normalTerminalVerified;
  return {source:'booking' as const,propertySlug:p.propertyId,stayDate:p.stayDate,
   lastAttemptAt:p.latestAttemptAt&&Date.parse(p.latestAttemptAt)>Date.parse(p.observedAt)?p.latestAttemptAt:p.observedAt,
   lastUsableAt:usable?p.observedAt:null,usableBasisVersion:usable?OBSERVED_LISTING_RELATIVE_V1:null,retryAfter:null,
   comparisonRequired:usable&&!p.pairAdopted};
 }));
}
export function readObservedListingPlannerFeedback(env:Record<string,string|undefined>,i:{now:string;request:RmsQuoteRequest}){
 let minProperties:number|null=null;
 const empty=(status:string,reason:string)=>({states:[] as UsefulQuoteState[],minProperties,diagnostics:{schema:'OBSERVED_LISTING_PLANNER_FEEDBACK_V1',status,reason,usableObservations:0,priceAuthority:false}});
 if(env['ZMI_OBSERVED_LISTING_ENABLED']!=='1')return empty('DISABLED','LISTING_LANE_DISABLED');
 try{
  const path=env['ZMI_OBSERVED_LISTING_CONFIG_PATH']??'',raw=bounded(path,65536),pin=env['ZMI_OBSERVED_LISTING_CONFIG_SHA256'];
  if(createHash('sha256').update(raw).digest('hex')!==pin)throw Error('LISTING_CONFIG_PIN');
  const cfg=parseObservedListingPublicationConfig(JSON.parse(raw.toString()));minProperties=cfg.policy.minProperties;
  const producer=assertAcceptedTwoPersonProducer({...env,ZMI_2P_ACCEPTED_PRODUCER_DIGEST:env['ZMI_OBSERVED_LISTING_ACCEPTED_PRODUCER_DIGEST']});
  if(!cfg.acceptedProducerCodes.includes(producer.codeSha256))throw Error('LISTING_PRODUCER_NOT_ACCEPTED');
  const root=realpathSync(process.cwd()),captured=captureObservedListingCanonicalInput({root,dbPath:join(root,'.data/zao-market-intelligence.sqlite'),request:i.request,asOf:i.now,policy:cfg.policy,producerCodeSha256s:[producer.codeSha256],quarantine:cfg.quarantine});
  const states=listingPlannerStates(captured.artifact);
  captured.assertUnchanged();if(!bounded(path,65536).equals(raw))throw Error('LISTING_CONFIG_CHANGED');
  return {states,minProperties,diagnostics:{schema:'OBSERVED_LISTING_PLANNER_FEEDBACK_V1',status:'CANONICAL_OBSERVATIONS_BOUND',reason:'CANONICAL_ROW_FINAL_TERMINAL_AND_ATTEMPT_WATERMARK',basisVersion:OBSERVED_LISTING_RELATIVE_V1,asOf:i.now,requestSha256:i.request.requestSha256,canonicalRowSetSha256:captured.manifest.canonicalRowSetSha256,sourceSnapshotSha256:captured.manifest.sourceSnapshotSha256,canonicalRows:captured.manifest.canonicalRows,analysisDates:captured.manifest.targetDates.length,usableObservations:states.filter(s=>s.lastUsableAt!==null).length,comparisonRevisits:states.filter(s=>s.comparisonRequired).length,priceAuthority:false}};
 }catch{
  // A failed read supplies zero usable assertions. Broad collection remains possible
  // under its unchanged request/attempt/source guards; there is no success fallback.
  return empty('UNVERIFIED','LISTING_CANONICAL_FEEDBACK_UNVERIFIED');
 }
}

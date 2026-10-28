// Downstream accepts only independently pinned receipts produced by the normal canonical/mirror admission hook.
// This is not an alternate market CSV ingestion route, and UNKNOWN legacy usable flags never appear here.
import {buildTwoPersonCurve,type TwoPersonObservation,type TwoPersonInvalidation} from './marketTwoPersonCurve';
import {digest,qualityIndex,sealQualityLedger,type QualityEntry,type QualityLedger} from './marketRowPriceQuality';
export interface CanonicalTwoPersonAdmission {
 schema:'ZMI_CANONICAL_2P_ADMISSION_V1';runId:string;ingestedAt:string;panelSha256:string;producerCodeSha256:string;mirrorExactVerified:boolean;invalidations:TwoPersonInvalidation[];
 source:'NORMAL_TRUSTED_APPEND_AND_EXACT_MIRROR';facts:TwoPersonObservation[];qualityLedger:QualityLedger;exclusions:Record<string,number>;
 marketPriceAuthority:false;admissionSha256:string;
}
export function buildCurveFromCanonicalAdmissions(input:Omit<Parameters<typeof buildTwoPersonCurve>[0],'observations'|'qualityLedger'|'expectedQualitySha256'|'trustedReceiptSha256'> & {
 admissions:readonly {receipt:CanonicalTwoPersonAdmission;independentlyPinnedSha256:string}[];
 quarantined:readonly QualityEntry[];acceptedProducerCodeSha256:ReadonlySet<string>;
}){
 if(input.admissions.length>500)throw Error('CANONICAL_ADMISSION_BUDGET');
 const invalidations:TwoPersonInvalidation[]=[],producerCodes=new Set<string>();
 const facts=new Map<string,TwoPersonObservation>(),entries=new Map<string,QualityEntry>(),receipts=new Set<string>(),pins=new Set<string>();
 const add=(q:QualityEntry)=>{const old=entries.get(q.rowId);if(old&&digest(old)!==digest(q))throw Error('CANONICAL_QUALITY_CONFLICT');entries.set(q.rowId,q);};
 for(const q of input.quarantined){if(q.status==='VERIFIED_SOURCE')throw Error('QUARANTINE_CANNOT_ASSERT_SOURCE_AUTHENTICITY');add(q);}
 for(const {receipt:r,independentlyPinnedSha256:pin} of input.admissions){
  const {admissionSha256,...body}=r;
  if(r.schema!=='ZMI_CANONICAL_2P_ADMISSION_V1'||r.source!=='NORMAL_TRUSTED_APPEND_AND_EXACT_MIRROR'||r.marketPriceAuthority!==false
   ||!/^auto_runner_market_refresh_rotating_\d{8}_\d{6}$/u.test(r.runId)||r.admissionSha256!==pin||digest(body)!==pin||r.panelSha256!==input.panel.panelSha256
   ||r.facts.length>1000||r.invalidations.length>1000||!input.acceptedProducerCodeSha256.has(r.producerCodeSha256)||r.facts.length>0&&!r.mirrorExactVerified)throw Error('CANONICAL_ADMISSION_PIN_OR_ROUTE');
  const index=qualityIndex(r.qualityLedger,r.qualityLedger.ledgerSha256);
  for(const f of r.facts){const q=index.get(f.rowId);if(!q||q.status!=='VERIFIED_SOURCE'||q.rowHash!==f.rowHash||q.receiptSha256!==f.receiptSha256||q.observationSha256!==digest(f))throw Error('CANONICAL_ADMISSION_FACT_DRIFT');
   const old=facts.get(f.rowId);if(old&&digest(old)!==digest(f))throw Error('CANONICAL_ADMISSION_FACT_CONFLICT');facts.set(f.rowId,f);add(q);receipts.add(f.receiptSha256);}
  for(const v of r.invalidations){if(v.ingestedAt!==r.ingestedAt)throw Error('INVALIDATION_INGESTION_DRIFT');invalidations.push(v);}
  producerCodes.add(r.producerCodeSha256);pins.add(pin);
 }
 const ledger=sealQualityLedger([...entries.values()]);
 const curve=buildTwoPersonCurve({...input,observations:[...facts.values()],invalidations,qualityLedger:ledger,expectedQualitySha256:ledger.ledgerSha256,trustedReceiptSha256:receipts});
 const {curveSha256,...body}=curve;
 const bound={...body,canonicalRoute:'NORMAL_TRUSTED_APPEND_AND_EXACT_MIRROR' as const,canonicalAdmissionSetSha256:digest([...pins].sort()),producerCodeSha256s:[...producerCodes].sort(),producerSetSha256:digest([...producerCodes].sort())};
 return {...bound,curveSha256:digest(bound)};
}

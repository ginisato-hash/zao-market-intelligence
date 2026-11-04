// Storage conservation evidence is separate from price eligibility. Pure, bounded, no DB/files/flags/authority.
import {digest,hashOk,instant,priceAdmission,qualityIndex,type RowIdentity,type QualityLedger} from './marketRowPriceQuality';
export interface AppendSourceReceipt {
 kind:'ZMI_APPEND_SOURCE_RECEIPT_V1';producerSha256:string;sourceSnapshotSha256:string;observedAt:string;ingestedAt:string;
 rows:RowIdentity[];receiptSha256:string;
}
export interface AppendProvenanceLedger {
 kind:'ZMI_APPEND_PROVENANCE_LEDGER_V1';entries:Array<RowIdentity&{status:'VERIFIED_APPEND_PROVENANCE';receiptSha256:string;producerSha256:string;ingestedAt:string}>;
 ledgerSha256:string;
}
const sort=(xs:readonly RowIdentity[])=>xs.map(r=>[r.rowId,r.rowHash]).sort(([a],[b])=>a!.localeCompare(b!));
function rowsIndex(rows:readonly RowIdentity[],max=200000){
 if(!Array.isArray(rows)||rows.length>max)throw Error('APPEND_ROW_BUDGET');const out=new Map<string,string>();
 for(const r of rows){if(typeof r.rowId!=='string'||r.rowId.length===0||Buffer.byteLength(r.rowId)>1024||/[\u0000-\u001f\u007f]/u.test(r.rowId)||!hashOk(r.rowHash)||out.has(r.rowId))throw Error('APPEND_ROW_IDENTITY_OR_DUPLICATE');out.set(r.rowId,r.rowHash);}return out;
}
/** Receipt raw/seal hashes and producer set must come from an independently accepted plan, never this function's output. */
export function buildAppendProvenanceLedger(receipts:readonly AppendSourceReceipt[],trustedReceipts:ReadonlySet<string>,acceptedProducers:ReadonlySet<string>,asOf:string):AppendProvenanceLedger{
 if(!Number.isFinite(instant(asOf))||receipts.length>500)throw Error('APPEND_RECEIPT_BUDGET_OR_TIME');
 const entries:AppendProvenanceLedger['entries']=[],seen=new Set<string>();
 for(const receipt of receipts){const {receiptSha256,...body}=receipt;
  if(receipt.kind!=='ZMI_APPEND_SOURCE_RECEIPT_V1'||!hashOk(receiptSha256)||digest(body)!==receiptSha256||!trustedReceipts.has(receiptSha256)
   ||!hashOk(receipt.producerSha256)||!acceptedProducers.has(receipt.producerSha256)||!hashOk(receipt.sourceSnapshotSha256)
   ||!Number.isFinite(instant(receipt.observedAt))||!Number.isFinite(instant(receipt.ingestedAt))||instant(receipt.observedAt)>instant(receipt.ingestedAt)||instant(receipt.ingestedAt)>instant(asOf))throw Error('APPEND_SOURCE_RECEIPT_UNVERIFIED');
  rowsIndex(receipt.rows,10000);
  for(const r of receipt.rows){if(seen.has(r.rowId)||entries.length>=10000)throw Error('APPEND_RECEIPT_DUPLICATE_OR_BUDGET');seen.add(r.rowId);entries.push({...r,status:'VERIFIED_APPEND_PROVENANCE',receiptSha256,producerSha256:receipt.producerSha256,ingestedAt:receipt.ingestedAt});}
 }
 entries.sort((a,b)=>a.rowId.localeCompare(b.rowId));const body={kind:'ZMI_APPEND_PROVENANCE_LEDGER_V1' as const,entries};return {...body,ledgerSha256:digest(body)};
}
/** Only new bounded rows are source-checked; old unknown rows remain preserved and never acquire price eligibility. */
export function bindAppendProvenanceDelta(i:{base:readonly RowIdentity[];current:readonly RowIdentity[];provenance:AppendProvenanceLedger;expectedProvenanceSha256:string;
 trustedReceipts:ReadonlySet<string>;acceptedProducers:ReadonlySet<string>;quality:QualityLedger;expectedQualitySha256:string;priceReceipts:ReadonlySet<string>;asOf:string;maxAdded:number;
 pointOfUseSnapshotSha256:string;freshPlanSha256:string}){
 const {provenance:p}=i;if(!p||p.kind!=='ZMI_APPEND_PROVENANCE_LEDGER_V1'||p.entries.length>10000||!hashOk(i.expectedProvenanceSha256)||p.ledgerSha256!==i.expectedProvenanceSha256||digest({kind:p.kind,entries:p.entries})!==p.ledgerSha256
  ||!hashOk(i.freshPlanSha256)||!hashOk(i.pointOfUseSnapshotSha256)||!Number.isFinite(instant(i.asOf))||!Number.isSafeInteger(i.maxAdded)||i.maxAdded<0||i.maxAdded>10000)throw Error('APPEND_PLAN_LEDGER_BINDING');
 const old=rowsIndex(i.base),current=rowsIndex(i.current),proof=rowsIndex(p.entries,10000),quality=qualityIndex(i.quality,i.expectedQualitySha256);
 if(digest(sort(i.current))!==i.pointOfUseSnapshotSha256)throw Error('APPEND_POINT_OF_USE_SNAPSHOT_CHANGED');
 for(const [id,hash]of old)if(current.get(id)!==hash)throw Error('APPEND_DELETION_OVERWRITE_OR_CONFLICT');
 const added=i.current.filter(r=>!old.has(r.rowId));if(added.length>i.maxAdded)throw Error('APPEND_DELTA_SCOPE_EXPANDED');let eligible=0;
 const byId=new Map(p.entries.map(r=>[r.rowId,r]));
 for(const row of added){const e=byId.get(row.rowId);if(!e||proof.get(row.rowId)!==row.rowHash||e.status!=='VERIFIED_APPEND_PROVENANCE'||!i.trustedReceipts.has(e.receiptSha256)||!i.acceptedProducers.has(e.producerSha256)||!Number.isFinite(instant(e.ingestedAt))||instant(e.ingestedAt)>instant(i.asOf))throw Error('APPEND_DELTA_PROVENANCE_UNVERIFIED');
  const q=quality.get(row.rowId);if(priceAdmission(row,quality,q?.receiptSha256??null,i.priceReceipts,i.asOf).eligible)eligible++;
 }
 return {kind:'ZMI_APPEND_PROVENANCE_DELTA_PLAN_V1' as const,freshPlanSha256:i.freshPlanSha256,baseIdentitySha256:digest(sort(i.base)),snapshotIdentitySha256:i.pointOfUseSnapshotSha256,
  addedIdentitySha256:digest(sort(added)),provenanceLedgerSha256:p.ledgerSha256,qualityLedgerSha256:i.expectedQualitySha256,addedRows:added.length,verifiedAppendProvenance:added.length,sourceAuthenticityEligibleAddedRows:eligible,
  preservedUnknownRows:i.base.filter(r=>{const q=quality.get(r.rowId);return !priceAdmission(r,quality,q?.receiptSha256??null,i.priceReceipts,i.asOf).eligible;}).length,fixedProductPriceEligibility:'NOT_EVALUATED' as const,applyAuthorized:false as const,mirrorEnableAuthorized:false as const};
}

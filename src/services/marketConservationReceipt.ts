// Preservation provenance only. It does not assert 2P comparability or price eligibility.
import {digest,hashOk,instant,type RowIdentity} from './marketRowPriceQuality';
export interface ConservationReceipt {
 schema:'ZMI_CANONICAL_APPEND_RECEIPT_V1';runId:string;writtenAt:string;producerSourceTreeGitSha:string;producerCodeSha256:string;
 rows:RowIdentity[];rowSetSha256:string;receiptSha256:string;priceEligibility:false;
}
const sorted=(r:readonly RowIdentity[])=>r.map(x=>({rowId:x.rowId,rowHash:x.rowHash})).sort((a,b)=>a.rowId.localeCompare(b.rowId));
export function sealConservationReceipt(input:Omit<ConservationReceipt,'schema'|'rowSetSha256'|'receiptSha256'|'priceEligibility'>):ConservationReceipt{
 const rows=sorted(input.rows);
 if(!/^auto_runner_market_refresh_rotating_\d{8}_\d{6}$/u.test(input.runId)||!Number.isFinite(instant(input.writtenAt))||!/^[0-9a-f]{40}$/u.test(input.producerSourceTreeGitSha)
  ||!hashOk(input.producerCodeSha256)||rows.length>1000||new Set(rows.map(r=>r.rowId)).size!==rows.length||rows.some(r=>typeof r.rowId!=='string'||Buffer.byteLength(r.rowId)>1024||!hashOk(r.rowHash)))throw Error('CONSERVATION_RECEIPT_SCOPE');
 const body={...input,schema:'ZMI_CANONICAL_APPEND_RECEIPT_V1' as const,rows,rowSetSha256:digest(rows),priceEligibility:false as const};
 return {...body,receiptSha256:digest(body)};
}
/** Reviewed immutable base can contain quarantined rows; ONLY new verified preservation receipts may extend it.
 * Output binds a new snapshot; it never changes a plan's bytes, applies repair, or elevates any price row. */
export function bindConservationAppendDelta(input:{base:readonly RowIdentity[];current:readonly RowIdentity[];asOf:string;
 receipts:readonly {receipt:ConservationReceipt;expectedReceiptSha256:string}[];acceptedProducerCodes:ReadonlySet<string>;maxAdded:number}){
 if(input.base.length>200000||input.current.length>200000||input.receipts.length>1000||!Number.isFinite(instant(input.asOf))||!Number.isSafeInteger(input.maxAdded)||input.maxAdded<0||input.maxAdded>10000)throw Error('CONSERVATION_DELTA_BUDGET');
 const map=(rows:readonly RowIdentity[])=>{const m=new Map<string,string>();for(const r of rows){if(m.has(r.rowId)||!hashOk(r.rowHash))throw Error('CONSERVATION_DUPLICATE_OR_HASH');m.set(r.rowId,r.rowHash);}return m;};
 const base=map(input.base),current=map(input.current),claimed=new Map<string,string>();
 for(const [id,h] of base)if(current.get(id)!==h)throw Error('CONSERVATION_DELETION_OR_OVERWRITE');
 for(const {receipt:r,expectedReceiptSha256:expected} of input.receipts){const {receiptSha256,...body}=r;
  if(r.schema!=='ZMI_CANONICAL_APPEND_RECEIPT_V1'||r.priceEligibility!==false||receiptSha256!==expected||digest(body)!==expected||digest(sorted(r.rows))!==r.rowSetSha256
   ||!input.acceptedProducerCodes.has(r.producerCodeSha256)||!Number.isFinite(instant(r.writtenAt))||instant(r.writtenAt)>instant(input.asOf))throw Error('CONSERVATION_SOURCE_RECEIPT');
  for(const row of r.rows){if(claimed.has(row.rowId)||base.has(row.rowId)||!hashOk(row.rowHash))throw Error('CONSERVATION_RECEIPT_OVERLAP');claimed.set(row.rowId,row.rowHash);}
 }
 const added=input.current.filter(r=>!base.has(r.rowId));
 if(added.length>input.maxAdded||claimed.size!==added.length)throw Error('CONSERVATION_DELTA_SCOPE');
 for(const r of added)if(claimed.get(r.rowId)!==r.rowHash)throw Error('CONSERVATION_UNPROVEN_APPEND');
 return {schema:'ZMI_CONSERVATION_APPEND_BINDING_V1' as const,baseIdentitySha256:digest(sorted(input.base)),snapshotIdentitySha256:digest(sorted(input.current)),
  appendedIdentitySha256:digest(sorted(added)),addedRows:added.length,receiptSetSha256:digest(input.receipts.map(x=>x.expectedReceiptSha256).sort()),
  priceEligibility:false as const,repairApplyAuthorized:false as const};
}

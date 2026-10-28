// TD6476135624: preservation equality is NOT source authenticity. Pure; never changes raw/history/DB.
import {createHash} from 'node:crypto';
import {canonicalJson} from './marketEvidenceSidecar';
export const QUALITY_VERSION='ZMI_ROW_PRICE_QUALITY_V1' as const;
export const digest=(x:unknown)=>createHash('sha256').update(canonicalJson(x)).digest('hex');
export const hashOk=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{64}$/u.test(s);
export const instant=(s:unknown)=>typeof s==='string'&&/(Z|[+-]\d\d:\d\d)$/u.test(s)?Date.parse(s):NaN;
export interface RowIdentity {rowId:string;rowHash:string}
export interface QualityEntry extends RowIdentity {
 status:'VERIFIED_SOURCE'|'UNVERIFIED_PROVENANCE'|'SAVED_DB_JSON_REHASHED';
 observedAt:string;ingestedAt:string|null;receiptSha256:string|null;observationSha256:string|null;
}
export interface QualityLedger {schema:typeof QUALITY_VERSION;entries:QualityEntry[];ledgerSha256:string}
function identity(r:RowIdentity){if(typeof r.rowId!=='string'||r.rowId.length===0||Buffer.byteLength(r.rowId)>1024||/[\u0000-\u001f\u007f]/u.test(r.rowId)||!hashOk(r.rowHash))throw Error('QUALITY_ROW_IDENTITY');}
export function sealQualityLedger(entries:readonly QualityEntry[]):QualityLedger{
 const ordered=[...entries].sort((a,b)=>a.rowId.localeCompare(b.rowId));
 const doc={schema:QUALITY_VERSION,entries:ordered};const result={...doc,ledgerSha256:digest(doc)};
 qualityIndex(result,result.ledgerSha256);return result;
}
export function qualityIndex(ledger:QualityLedger,expectedLedgerSha:string){
 if(!ledger||ledger.schema!==QUALITY_VERSION||!Array.isArray(ledger.entries)||ledger.entries.length>200000
  ||!hashOk(expectedLedgerSha)||ledger.ledgerSha256!==expectedLedgerSha||digest({schema:ledger.schema,entries:ledger.entries})!==expectedLedgerSha)throw Error('QUALITY_LEDGER_BINDING');
 const map=new Map<string,QualityEntry>();
 for(const r of ledger.entries){
  identity(r);if(map.has(r.rowId)||!['VERIFIED_SOURCE','UNVERIFIED_PROVENANCE','SAVED_DB_JSON_REHASHED'].includes(r.status)
   ||!Number.isFinite(instant(r.observedAt))||r.ingestedAt!==null&&(!Number.isFinite(instant(r.ingestedAt))||instant(r.observedAt)>instant(r.ingestedAt))||r.status==='VERIFIED_SOURCE'&&r.ingestedAt===null
   ||r.status==='VERIFIED_SOURCE'&&(!hashOk(r.receiptSha256)||!hashOk(r.observationSha256))||r.status!=='VERIFIED_SOURCE'&&r.receiptSha256!==null)throw Error('QUALITY_LEDGER_ENTRY');
  map.set(r.rowId,r);
 }
 return map;
}
export function priceAdmission(row:RowIdentity,index:ReadonlyMap<string,QualityEntry>,receiptSha:string|null, trustedReceipts:ReadonlySet<string>,asOf:string){
 identity(row);if(!Number.isFinite(instant(asOf)))throw Error('QUALITY_ASOF');
 const q=index.get(row.rowId);
 if(!q)return {eligible:false,reason:'UNKNOWN_ROW_PRICE_INELIGIBLE'};
 if(q.rowHash!==row.rowHash)throw Error('QUALITY_CONTENT_HASH_CONFLICT');
 if(q.status!=='VERIFIED_SOURCE')return {eligible:false,reason:q.status==='SAVED_DB_JSON_REHASHED'?'ORIGINAL_SOURCE_AUTHENTICITY_NOT_ESTABLISHED_STALE':'UNVERIFIED_PROVENANCE_PRICE_INELIGIBLE'};
 if(instant(q.observedAt)>instant(asOf)||instant(q.ingestedAt)>instant(asOf))return {eligible:false,reason:'QUALITY_NOT_KNOWN_ASOF'};
 if(receiptSha===null||q.receiptSha256!==receiptSha||!trustedReceipts.has(receiptSha))return {eligible:false,reason:'INDEPENDENT_SOURCE_RECEIPT_UNBOUND'};
 return {eligible:true,reason:'VERIFIED_ROW_AND_SOURCE_RECEIPT'};
}
/** Reviewable append-only envelope: every old row/hash survives; only independently admitted new rows inherit acceptance.
 * This emits an actual new snapshot digest; it never applies a stale recovery plan or grants apply/flag authority. */
export function bindVerifiedAppendOnlyDelta(base:readonly RowIdentity[],current:readonly RowIdentity[],ledger:QualityLedger,expectedLedgerSha:string,receipts:ReadonlySet<string>,asOf:string,maxAdded:number){
 if(base.length>200000||current.length>200000||!Number.isSafeInteger(maxAdded)||maxAdded<0||maxAdded>10000)throw Error('DELTA_BUDGET');
 const index=qualityIndex(ledger,expectedLedgerSha),old=new Map<string,string>(),now=new Map<string,string>();
 for(const [rows,map] of [[base,old],[current,now]] as const)for(const r of rows){identity(r);if(map.has(r.rowId))throw Error('DELTA_DUPLICATE_ID');map.set(r.rowId,r.rowHash);}
 for(const [id,h] of old)if(now.get(id)!==h)throw Error('DELTA_DELETION_OR_OVERWRITE');
 const added=current.filter(r=>!old.has(r.rowId));if(added.length>maxAdded)throw Error('DELTA_SCOPE_EXPANDED');
 for(const r of added){const q=index.get(r.rowId);if(!priceAdmission(r,index,q?.receiptSha256??null,receipts,asOf).eligible)throw Error('DELTA_UNVERIFIED_APPEND');}
 const ids=(m:Map<string,string>)=>[...m].sort(([a],[b])=>a.localeCompare(b));
 return {kind:'ZMI_VERIFIED_APPEND_ENVELOPE_V1' as const,baseIdentitySha256:digest(ids(old)),snapshotIdentitySha256:digest(ids(now)),
  addedIdentitySha256:digest(added.map(r=>[r.rowId,r.rowHash]).sort()),addedRows:added.length,qualityLedgerSha256:expectedLedgerSha,applyAuthorized:false as const};
}

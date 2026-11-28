// Full raw identity is checked once before retaining only fields used by listing final guards.
// A serialized/self-consistent projection cannot create an admitted receipt.
import {createHash} from 'node:crypto';
import {LISTING_REPORT_FILE_BYTES} from './observedListingReportBudget';
export interface RawListingRunReport {runId:string;rawSha256:string;rawJson:string}
export interface CapturedListingRunReport {readonly runId:string;readonly rawSha256:string;readonly kind:'CAPTURED_LISTING_REPORT_RECEIPT_V1'}
const receipts=new WeakMap<CapturedListingRunReport,{report:Record<string,any>;retainedBytes:number;rawBytes:number}>();
const pick=(x:Record<string,any>,keys:string[])=>Object.fromEntries(keys.filter(k=>Object.hasOwn(x,k)).map(k=>[k,x[k]]));
const object=(x:unknown):x is Record<string,any>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const freeze=(x:any):any=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function capture(c:any){
 if(!object(c))return c;
 const p=pick(c,['propertySlug','stayDate','attemptedNetwork','completedAt','pageFinalBlockStateVerified','informationFailureCode','pageFinalBlockReason','blockReason']);
 if(Object.hasOwn(c,'informationDiagnostics')){
  const d=c.informationDiagnostics;
  p.informationDiagnostics=object(d)?pick(d,['schema','lifecycle','failure','overflow']):d;
  if(object(d)){
   if(Object.hasOwn(d,'counts'))p.informationDiagnostics.counts=object(d.counts)?pick(d.counts,['unmatched','abortFailed','abortPending']):d.counts;
   if(Object.hasOwn(d,'termination'))p.informationDiagnostics.termination=object(d.termination)?pick(d.termination,['mode','owned','planned','terminationStarted','verified','processExited','serverClosed','clientDisconnected','unexpectedDisconnect']):d.termination;
  }
 }
 return p;
}
export function captureListingRunReport(r:RawListingRunReport):CapturedListingRunReport{
 const bytes=Buffer.byteLength(r.rawJson);
 if(bytes>LISTING_REPORT_FILE_BYTES)throw Error('LISTING_REPORT_FILE_BUDGET');
 if(createHash('sha256').update(r.rawJson).digest('hex')!==r.rawSha256)throw Error('LISTING_REPORT_RECEIPT_BINDING');
 const d=JSON.parse(r.rawJson);
 if(!object(d)||d.run_id!==r.runId||d.dry_run!==false||!['rotating_market_refresh_success','rotating_market_refresh_partial_success'].includes(d.decision))throw Error('LISTING_REPORT_NOT_FINAL');
 const report=pick(d,['run_id','generated_at_jst','dry_run','decision']);
 if(Object.hasOwn(d,'rate_cell_evidence')){const e=d.rate_cell_evidence;report.rate_cell_evidence=object(e)?(Object.hasOwn(e,'captures')?{captures:Array.isArray(e.captures)?e.captures.map(capture):e.captures}:{}):e;}
 freeze(report);const ref=Object.freeze({kind:'CAPTURED_LISTING_REPORT_RECEIPT_V1' as const,runId:r.runId,rawSha256:r.rawSha256});
 receipts.set(ref,Object.freeze({report,retainedBytes:Buffer.byteLength(JSON.stringify(report)),rawBytes:bytes}));return ref;
}
export function readCapturedListingRunReport(r:CapturedListingRunReport){
 const saved=receipts.get(r);if(!saved)throw Error('LISTING_REPORT_RECEIPT_BINDING');return saved;
}

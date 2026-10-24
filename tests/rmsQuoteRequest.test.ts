import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateRmsQuoteRequest,readRmsQuoteRequest,type RmsQuoteRequest} from '../src/services/rmsQuoteRequest';
import {canonicalJson} from '../src/services/marketEvidenceSidecar';
const accepted={releaseGitSha:'a'.repeat(40),bundleSha256:'b'.repeat(64),graphSha256:'c'.repeat(64)},at='2026-10-25T00:00:00Z';
function seal(r:Omit<RmsQuoteRequest,'requestSha256'>):RmsQuoteRequest{return {...r,requestSha256:createHash('sha256').update(canonicalJson(r)).digest('hex')};}
function request(){return seal({kind:'K27_MARKET_QUOTE_REQUEST_V1',propertyId:'330695',createdAt:at,expiresAt:'2026-10-26T12:00:00Z',source:{runId:'k27run_2026-10-25_1234abcd',...accepted,evidenceSha256:'d'.repeat(64),observedAt:at},needs:[{stayDate:'2029-07-20',admittedAt:at,priceDecisionEligible:true,decisionImpact:0.5,changedAt:at,dateEvidenceSha256:'e'.repeat(64)}]});}
it('accepts a minimal exact-release sealed collection request without limiting its far date',()=>{
 expect(validateRmsQuoteRequest(request(),at,accepted).needs[0]?.stayDate).toBe('2029-07-20');
});
it('rejects modified content, unknown fields, wrong source and expired/currently future inputs',()=>{
 const r=request();r.needs[0]!.priceDecisionEligible=false;expect(()=>validateRmsQuoteRequest(r,at,accepted)).toThrow('SEAL');
 const extra={...request(),secret:'NEVER_EXPORT'};expect(()=>validateRmsQuoteRequest(extra,at,accepted)).toThrow('SCHEMA');
 expect(()=>validateRmsQuoteRequest(request(),at,{...accepted,releaseGitSha:'f'.repeat(40)})).toThrow('SOURCE');
 expect(()=>validateRmsQuoteRequest(request(),'2026-10-26T12:00:00Z',accepted)).toThrow('EXPIRED');
 expect(()=>validateRmsQuoteRequest(request(),'2026-10-24T23:59:59Z',accepted)).toThrow('TIME');
});
it('rejects duplicate/invalid dates, future evidence and excess expiry even when self-sealed',()=>{
 const {requestSha256,...r}=request();
 expect(()=>validateRmsQuoteRequest(seal({...r,needs:[...r.needs,...r.needs]}),at,accepted)).toThrow('NEED');
 expect(()=>validateRmsQuoteRequest(seal({...r,needs:[{...r.needs[0]!,stayDate:'2027-02-30'}]}),at,accepted)).toThrow('NEED');
 expect(()=>validateRmsQuoteRequest(seal({...r,expiresAt:'2026-10-26T12:00:01Z'}),at,accepted)).toThrow('TIME');
});
it('reads a stable bounded local file but refuses symlinks and oversized input without exposing raw exceptions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rms-quote-request-')),path=join(dir,'request.json'),alias=join(dir,'alias.json');
 writeFileSync(path,JSON.stringify(request()));expect(readRmsQuoteRequest(path,at,accepted).needs).toHaveLength(1);
 symlinkSync(path,alias);expect(()=>readRmsQuoteRequest(alias,at,accepted)).toThrow('UNAVAILABLE_OR_INVALID');
 writeFileSync(path,'x'.repeat(1024*1024+1));expect(()=>readRmsQuoteRequest(path,at,accepted)).toThrow('UNAVAILABLE_OR_INVALID');
});

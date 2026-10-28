// Existing collector's local metadata publication. No scheduler, collection, DB mutation or pricing transport.
import {constants,openSync,closeSync,fsyncSync,writeFileSync,mkdirSync,lstatSync,fstatSync,renameSync,unlinkSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {readBoundedStableFile} from './boundedStableFile';
import {digest,instant,sealQualityLedger,type QualityEntry} from './marketRowPriceQuality';
import {validatePanel,type MarketPanel,type CurveQualityPolicy,type CurveReference} from './marketTwoPersonCurve';
import {buildCurveFromCanonicalAdmissions,type CanonicalTwoPersonAdmission} from './twoPersonCurveFromAdmissions';
import {validateRmsQuoteRequest,type RmsQuoteRequest} from './rmsQuoteRequest';
const hash=z.string().regex(/^[0-9a-f]{64}$/u),time=z.string().datetime({offset:true});
const run=z.string().regex(/^auto_runner_market_refresh_rotating_\d{8}_\d{6}$/u);
const refSchema=z.object({runId:run,rawSha256:hash,admissionSha256:hash,ingestedAt:time}).strict();
export type AdmissionRef=z.infer<typeof refSchema>;
export interface CurvePublicationConfig {
 schema:'ZMI_2P_CURVE_CONFIG_V1';panel:MarketPanel;policy:CurveQualityPolicy;reference:CurveReference;
 anchorAdmissions:AdmissionRef[];anchorAdmissionSetSha256:string;acceptedProducerCodes:string[];quarantined:QualityEntry[];
}
const configSchema=z.object({schema:z.literal('ZMI_2P_CURVE_CONFIG_V1'),panel:z.unknown(),policy:z.unknown(),reference:z.unknown(),
 anchorAdmissions:z.array(refSchema).max(200),anchorAdmissionSetSha256:hash,acceptedProducerCodes:z.array(hash).min(1).max(8),quarantined:z.array(z.unknown()).max(5000)}).strict();
interface State {
 runId:string;root:string;directory:string;receiptRoot:string;config:CurvePublicationConfig;configSha:string;producerCode:string;
 request:RmsQuoteRequest;clock:()=>Date;assertSource:()=>void;started:number;fd:number;pointerBytes:Buffer|null;
 catalogBytes:Buffer|null;refs:AdmissionRef[];pending:Map<string,PendingAttempt>;closed:boolean;
}
interface PendingAttempt {sourceProductSha256:string;stayDate:string;attemptedAt:string;runId:string;requestSha256:string}
const pendingSchema=z.object({sourceProductSha256:hash,stayDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),attemptedAt:time,runId:run,requestSha256:hash}).strict();
const productKey=(p:{propertyId:string;sourcePropertyId:string;source:string;productId:string;ratePlanId:string;conditionKey:string})=>digest([p.propertyId,p.sourcePropertyId,p.source,p.productId,p.ratePlanId,p.conditionKey]);
function pendingKey(p:PendingAttempt){return digest([p.sourceProductSha256,p.stayDate]);}
function blockedSince(s:State){const dates=new Map<string,string>();for(const p of s.pending.values()){const old=dates.get(p.stayDate);if(!old||instant(p.attemptedAt)<instant(old))dates.set(p.stayDate,p.attemptedAt);}return dates;}
function guard(s:State,now:string){const dates=blockedSince(s),body={schema:'ZMI_2P_CURVE_GUARD_V2',runId:s.runId,updatedAt:now,blockedStayDates:[...dates.keys()].sort(),blockedSince:Object.fromEntries([...dates].sort(([a],[b])=>a.localeCompare(b))),pending:[...s.pending.values()].sort((a,b)=>pendingKey(a).localeCompare(pendingKey(b)))};return {...body,guardSha256:digest(body)};}
export interface CurvePublicationSession {readonly kind:'ZMI_2P_PUBLICATION_SESSION_V1'}
const sessions=new WeakMap<object,State>();
const rawHash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function present(path:string){try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
function readOptional(path:string,max:number){return present(path)?readBoundedStableFile(path,max):null;}
function equal(a:Buffer|null,b:Buffer|null){return a===null?b===null:b!==null&&a.equals(b);}
function seal<T extends Record<string,unknown>>(body:T){return {...body,publicationSha256:digest(body)};}
function fsyncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function sameLock(s:State){const p=lstatSync(join(s.directory,'publisher.lock'),{bigint:true}),f=fstatSync(s.fd,{bigint:true});return p.dev===f.dev&&p.ino===f.ino&&!p.isSymbolicLink();}
function pointOfUse(s:State){
 const now=s.clock().getTime();
 if(s.closed||!Number.isFinite(now)||now<s.started||now-s.started>2*3600000||now>=instant(s.request.expiresAt)||!sameLock(s))throw Error('PUBLICATION_SESSION_OR_TIME');
 s.assertSource();return new Date(now).toISOString();
}
function replace(s:State,name:string,expected:Buffer|null,bytes:Buffer,max:number){
 if(bytes.length>max)throw Error('PUBLICATION_OUTPUT_BUDGET');
 const path=join(s.directory,name),temp=join(s.directory,'.tmp-'+randomUUID());let fd:number|undefined;
 try{
  pointOfUse(s);if(!equal(readOptional(path,max),expected))throw Error('PUBLICATION_CAS_CONFLICT');
  fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,bytes);fsyncSync(fd);
  pointOfUse(s);if(!equal(readOptional(path,max),expected))throw Error('PUBLICATION_CAS_CONFLICT');
  renameSync(temp,path);fsyncDirectory(s.directory);
  if(!readBoundedStableFile(path,max).equals(bytes))throw Error('PUBLICATION_READBACK');
 }finally{
  if(fd!==undefined){try{if(present(temp)){const a=lstatSync(temp),b=fstatSync(fd);if(a.dev===b.dev&&a.ino===b.ino)unlinkSync(temp);}}finally{closeSync(fd);}}
 }
}
function pointer(s:State,body:Record<string,unknown>){
 const bytes=Buffer.from(JSON.stringify(seal(body))+'\n');replace(s,'current.json',s.pointerBytes,bytes,512*1024);s.pointerBytes=bytes;
}
function checkedPointer(bytes:Buffer,configSha:string){
 const d=JSON.parse(bytes.toString('utf8')) as Record<string,unknown>,{publicationSha256,...body}=d;
 if(d.schema!=='ZMI_2P_CURVE_PUBLICATION_V1'||!['READY','PENDING'].includes(String(d.status))||d.configSha256!==configSha||publicationSha256!==digest(body))throw Error('PRIOR_PUBLICATION_UNVERIFIED');
 if(d.status==='READY'&&(!hash.safeParse(d.curveSha256).success||typeof d.artifactBasename!=='string'||!/^curve_[0-9a-f]{64}\.json$/u.test(d.artifactBasename)))throw Error('PRIOR_PUBLICATION_UNVERIFIED');
 return d;
}
function readReceipt(s:State,pin:AdmissionRef,budget:{bytes:number}){
 refSchema.parse(pin);const path=join(s.receiptRoot,pin.runId+'.json');
 if(realpathSync(path)!==path)throw Error('ADMISSION_REFERENCE_SYMLINK');
 const bytes=readBoundedStableFile(path,4*1024*1024);budget.bytes+=bytes.length;if(budget.bytes>24*1024*1024)throw Error('ADMISSION_TOTAL_READ_BUDGET');
 if(rawHash(bytes)!==pin.rawSha256)throw Error('ADMISSION_RAW_PIN');
 const receipt=JSON.parse(bytes.toString('utf8')) as CanonicalTwoPersonAdmission;
 if(receipt.runId!==pin.runId||receipt.ingestedAt!==pin.ingestedAt||receipt.admissionSha256!==pin.admissionSha256||instant(receipt.ingestedAt)>s.clock().getTime())throw Error('ADMISSION_REFERENCE_DRIFT');
 return {receipt,independentlyPinnedSha256:pin.admissionSha256};
}
/** Only the normal collector wrapper supplies accepted config, genuine RMS request and its source-code check. */
export function startCurvePublication(input:{runId:string;root:string;configBytes:Buffer;expectedConfigSha256:string;producerCodeSha256:string;
 request:RmsQuoteRequest;assertSource:()=>void;clock?:()=>Date}):CurvePublicationSession{
 run.parse(input.runId);hash.parse(input.producerCodeSha256);hash.parse(input.expectedConfigSha256);
 if(input.configBytes.length>512*1024||rawHash(input.configBytes)!==input.expectedConfigSha256)throw Error('CURVE_CONFIG_RAW_PIN');
 const config=configSchema.parse(JSON.parse(input.configBytes.toString('utf8'))) as CurvePublicationConfig;validatePanel(config.panel);
 if(!config.acceptedProducerCodes.includes(input.producerCodeSha256)||new Set(config.acceptedProducerCodes).size!==config.acceptedProducerCodes.length
  ||digest(config.anchorAdmissions.map(r=>r.admissionSha256).sort())!==config.anchorAdmissionSetSha256
  ||new Set(config.anchorAdmissions.map(r=>r.runId)).size!==config.anchorAdmissions.length)throw Error('CURVE_CONFIG_ACCEPTANCE');
 // Validate all quality/reference contracts without inventing observations or a missing historical anchor.
 sealQualityLedger(config.quarantined);if(config.quarantined.some(q=>q.status==='VERIFIED_SOURCE'))throw Error('QUARANTINE_IS_NOT_SOURCE_PROOF');
 if(!Number.isFinite(instant(config.reference.asOf))||!Number.isFinite(config.policy.maxAgeHours)||config.policy.maxAgeHours<=0||config.policy.maxAgeHours>72
  ||config.reference.panelSha256!==config.panel.panelSha256||config.reference.baselineBundleSha256!==input.request.source.bundleSha256
  ||config.anchorAdmissions.some(r=>instant(r.ingestedAt)>instant(config.reference.asOf)))throw Error('CURVE_CONFIG_REFERENCE');
 const root=resolve(input.root);if(root!==input.root||realpathSync(root)!==root)throw Error('PUBLICATION_ROOT');
 const receiptRoot=join(root,'.data/history-quality');if(realpathSync(receiptRoot)!==receiptRoot)throw Error('ADMISSION_ROOT');
 const clock=input.clock??(()=>new Date()),started=clock().getTime();input.assertSource();
 if(!Number.isFinite(started)||started<instant(input.request.createdAt)||started>=instant(input.request.expiresAt))throw Error('PUBLICATION_REQUEST_TIME');
 const request=validateRmsQuoteRequest(JSON.parse(JSON.stringify(input.request)),new Date(started).toISOString(),input.request.source);
 const directory=join(root,'.data/market-2p',input.expectedConfigSha256);
 for(const path of [join(root,'.data/market-2p'),directory]){mkdirSync(path,{recursive:true,mode:0o700});if(realpathSync(path)!==path)throw Error('PUBLICATION_DIRECTORY_SYMLINK');}
 const fd=openSync(join(directory,'publisher.lock'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 const s:State={runId:input.runId,root,directory,receiptRoot,config,configSha:input.expectedConfigSha256,producerCode:input.producerCodeSha256,request,clock,assertSource:input.assertSource,started,fd,pointerBytes:null,catalogBytes:null,refs:[],pending:new Map(),closed:false};
 try{
  writeFileSync(fd,JSON.stringify({runId:s.runId,startedAt:new Date(started).toISOString()})+'\n');fsyncSync(fd);fsyncDirectory(directory);
  s.pointerBytes=readOptional(join(directory,'current.json'),512*1024);const old=s.pointerBytes?checkedPointer(s.pointerBytes,s.configSha):null;
  if(old?.status==='READY'){
   const sha=hash.parse(old.inputManifestSha256),manifestBytes=readBoundedStableFile(join(directory,'inputs_'+sha+'.json'),256*1024);
   const manifest=JSON.parse(manifestBytes.toString('utf8')),{inputManifestSha256,...body}=manifest;
   if(inputManifestSha256!==sha||digest(body)!==sha||manifest.schema!=='ZMI_2P_CURVE_INPUT_MANIFEST_V1'||manifest.configSha256!==s.configSha||manifest.asOf!==old.generatedAt
    ||!Array.isArray(manifest.admissions)||manifest.admissions.length>500)throw Error('PRIOR_INPUT_MANIFEST');
   const refs=manifest.admissions.map((r:unknown)=>refSchema.parse(r)),budget={bytes:0};
   const artifactBytes=readBoundedStableFile(join(directory,String(old.artifactBasename)),4*1024*1024);
   if(rawHash(artifactBytes)!==old.rawSha256)throw Error('PRIOR_CURVE_RAW_HASH');
   const artifact=JSON.parse(artifactBytes.toString('utf8'));
   const rebuilt=buildCurveFromCanonicalAdmissions({panel:config.panel,policy:config.policy,reference:config.reference,asOf:String(old.generatedAt),
    stayDates:artifact.curves.map((c:{stayDate:string})=>c.stayDate),admissions:refs.map((r:AdmissionRef)=>readReceipt(s,r,budget)),quarantined:config.quarantined,acceptedProducerCodeSha256:new Set(config.acceptedProducerCodes)});
   if(digest(artifact)!==digest(rebuilt)||old.curveSha256!==rebuilt.curveSha256||old.canonicalAdmissionSetSha256!==rebuilt.canonicalAdmissionSetSha256||old.producerSetSha256!==rebuilt.producerSetSha256)throw Error('PRIOR_CURVE_PROVENANCE_DRIFT');
  }
  if(old?.guard){const g=old.guard as Record<string,unknown>,{guardSha256,...body}=g;
   if(g.schema!=='ZMI_2P_CURVE_GUARD_V2'||guardSha256!==digest(body)||!Array.isArray(g.pending)||g.pending.length>1000)throw Error('PRIOR_GUARD_UNVERIFIED');
   for(const value of g.pending){const p=pendingSchema.parse(value),key=pendingKey(p);
    if(new Date(p.stayDate+'T00:00:00Z').toISOString().slice(0,10)!==p.stayDate||instant(p.attemptedAt)>started||s.pending.has(key)
     ||!config.panel.products.some(product=>productKey(product)===p.sourceProductSha256))throw Error('PRIOR_GUARD_TIME_OR_PRODUCT');
    s.pending.set(key,p);
   }
   const dates=blockedSince(s);
   if(digest(Object.fromEntries([...dates].sort(([a],[b])=>a.localeCompare(b))))!==digest(g.blockedSince)||digest([...dates.keys()].sort())!==digest(g.blockedStayDates))throw Error('PRIOR_GUARD_DATES');
   // A pending attempt can expire only once every older quote is outside the quality maximum source age.
   for(const [key,p] of s.pending)if(started-instant(p.attemptedAt)>config.policy.maxAgeHours*3600000)s.pending.delete(key);
  }else if(old?.status==='READY')throw Error('PRIOR_GUARD_MISSING');
  s.catalogBytes=readOptional(join(directory,'admissions.json'),256*1024);
  if(old?.status==='READY'&&s.catalogBytes===null)throw Error('ADMISSION_CATALOG_MISSING');
  if(s.catalogBytes){const c=JSON.parse(s.catalogBytes.toString('utf8')),{catalogSha256,...body}=c;
   if(c.schema!=='ZMI_2P_ADMISSION_CATALOG_V1'||c.configSha256!==s.configSha||digest(body)!==catalogSha256||!Array.isArray(c.refs)||c.refs.length>300)throw Error('ADMISSION_CATALOG_UNVERIFIED');
   s.refs=c.refs.map((r:unknown)=>refSchema.parse(r));if(new Set(s.refs.map(r=>r.runId)).size!==s.refs.length)throw Error('ADMISSION_CATALOG_DUPLICATE');
  }
  const session=Object.freeze({kind:'ZMI_2P_PUBLICATION_SESSION_V1' as const});sessions.set(session,s);return session;
 }catch(e){try{if(sameLock(s))unlinkSync(join(directory,'publisher.lock'));}finally{closeSync(fd);}throw e;}
}
/** After request reservation, before network: block only that stay date until canonical publication completes. */
export function guardCurveAttempt(session:CurvePublicationSession,sourcePropertyId:string,stayDate:string):boolean{
 const s=sessions.get(session);if(!s)return false;
 try{
  const now=pointOfUse(s);if(!s.request.needs.some(n=>n.stayDate===stayDate))throw Error('ATTEMPT_OUTSIDE_RECEPTION_SCOPE');
  const products=s.config.panel.products.filter(p=>p.source==='booking'&&p.sourcePropertyId===sourcePropertyId);
  if(products.length===0)return true; // Discovery outside the fixed panel has no prior curve quote to invalidate.
  for(const p of products){const pending={sourceProductSha256:productKey(p),stayDate,attemptedAt:now,runId:s.runId,requestSha256:s.request.requestSha256};s.pending.set(pendingKey(pending),pending);}
  if(s.pending.size>1000)throw Error('PENDING_ATTEMPT_BUDGET');
  const nextGuard=guard(s,now);
  const old=s.pointerBytes?checkedPointer(s.pointerBytes,s.configSha):null;
  if(old?.status==='READY'){const {publicationSha256,...body}=old;pointer(s,{...body,guard:nextGuard});}
  else pointer(s,{schema:'ZMI_2P_CURVE_PUBLICATION_V1',status:'PENDING',generatedAt:now,configSha256:s.configSha,guard:nextGuard});
  return true;
 }catch{return false;}
}
export function finishCurvePublication(session:CurvePublicationSession,admissionSha256:string){
 const s=sessions.get(session);if(!s)throw Error('PUBLICATION_SESSION_NOT_GENUINE');
 const now=pointOfUse(s);hash.parse(admissionSha256);
 const bytes=readBoundedStableFile(join(s.receiptRoot,s.runId+'.json'),4*1024*1024),receipt=JSON.parse(bytes.toString('utf8')) as CanonicalTwoPersonAdmission;
 if(receipt.runId!==s.runId||receipt.admissionSha256!==admissionSha256||receipt.producerCodeSha256!==s.producerCode)throw Error('CURRENT_ADMISSION_BINDING');
 const current:AdmissionRef={runId:s.runId,rawSha256:rawHash(bytes),admissionSha256,ingestedAt:receipt.ingestedAt};
 const refs=new Map(s.refs.map(r=>[r.runId,r]));const old=refs.get(s.runId);if(old&&digest(old)!==digest(current))throw Error('ADMISSION_CATALOG_CONFLICT');refs.set(s.runId,current);
 const retained=[...refs.values()].filter(r=>instant(r.ingestedAt)>=instant(now)-s.config.policy.maxAgeHours*3600000).sort((a,b)=>a.runId.localeCompare(b.runId));
 if(retained.length>300)throw Error('ADMISSION_CATALOG_BUDGET');
 const all=new Map(s.config.anchorAdmissions.map(r=>[r.runId,r]));for(const r of retained){const a=all.get(r.runId);if(a&&digest(a)!==digest(r))throw Error('ANCHOR_ADMISSION_CONFLICT');all.set(r.runId,r);}
 const budget={bytes:0},admissions=[...all.values()].map(r=>readReceipt(s,r,budget));
 const curve=buildCurveFromCanonicalAdmissions({panel:s.config.panel,policy:s.config.policy,reference:s.config.reference,asOf:now,
  stayDates:s.request.needs.map(n=>n.stayDate),admissions,quarantined:s.config.quarantined,acceptedProducerCodeSha256:new Set(s.config.acceptedProducerCodes)});
 const artifactBasename='curve_'+curve.curveSha256+'.json',artifactBytes=Buffer.from(JSON.stringify(curve)+'\n'),artifactPath=join(s.directory,artifactBasename);
 if(artifactBytes.length>4*1024*1024)throw Error('CURVE_ARTIFACT_BUDGET');
 if(present(artifactPath)){if(!readBoundedStableFile(artifactPath,4*1024*1024).equals(artifactBytes))throw Error('CURVE_ARTIFACT_CONFLICT');}
 else{const fd=openSync(artifactPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);try{writeFileSync(fd,artifactBytes);fsyncSync(fd);}finally{closeSync(fd);}fsyncDirectory(s.directory);}
 const inputBody={schema:'ZMI_2P_CURVE_INPUT_MANIFEST_V1',configSha256:s.configSha,asOf:now,admissions:[...all.values()].sort((a,b)=>a.runId.localeCompare(b.runId))};
 const inputManifestSha256=digest(inputBody),inputBytes=Buffer.from(JSON.stringify({...inputBody,inputManifestSha256})+'\n'),inputPath=join(s.directory,'inputs_'+inputManifestSha256+'.json');
 if(inputBytes.length>256*1024)throw Error('INPUT_MANIFEST_BUDGET');
 if(present(inputPath)){if(!readBoundedStableFile(inputPath,256*1024).equals(inputBytes))throw Error('INPUT_MANIFEST_CONFLICT');}
 else{const fd=openSync(inputPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);try{writeFileSync(fd,inputBytes);fsyncSync(fd);}finally{closeSync(fd);}fsyncDirectory(s.directory);}
 const catalogBody={schema:'ZMI_2P_ADMISSION_CATALOG_V1',configSha256:s.configSha,updatedAt:now,refs:retained};
 const catalogBytes=Buffer.from(JSON.stringify({...catalogBody,catalogSha256:digest(catalogBody)})+'\n');
 replace(s,'admissions.json',s.catalogBytes,catalogBytes,256*1024);s.catalogBytes=catalogBytes;
 for(const [key,p] of s.pending){
  const proved=[...receipt.facts,...receipt.invalidations].some(r=>r.stayDate===p.stayDate&&productKey(r)===p.sourceProductSha256&&instant(r.observedAt)>=instant(p.attemptedAt)&&instant(r.observedAt)<=instant(now));
  if(proved)s.pending.delete(key);
 }
 const nextGuard=guard(s,now);
 pointer(s,{schema:'ZMI_2P_CURVE_PUBLICATION_V1',status:'READY',generatedAt:now,artifactBasename,rawSha256:rawHash(artifactBytes),curveSha256:curve.curveSha256,
  canonicalAdmissionSetSha256:curve.canonicalAdmissionSetSha256,inputManifestSha256,producerSetSha256:curve.producerSetSha256,configSha256:s.configSha,guard:nextGuard});
 return {status:'CANONICAL_CURVE_PUBLISHED',curveSha256:curve.curveSha256,qualityEligibleDates:curve.curves.filter(c=>c.eligible).length,priceEligibleDates:curve.curves.filter(c=>c.eligible&&!blockedSince(s).has(c.stayDate)).length,guardedDates:blockedSince(s).size,observedAsOf:now,priceAuthority:false};
}
export function closeCurvePublication(session:CurvePublicationSession){
 const s=sessions.get(session);if(!s||s.closed)return;
 try{if(sameLock(s))unlinkSync(join(s.directory,'publisher.lock'));}finally{closeSync(s.fd);s.closed=true;}
}

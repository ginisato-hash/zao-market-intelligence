// Only the existing normal collector calls this AFTER saving its final report and verifying exact mirror.
// Default OFF. Listing publication is data only and is independent of strict fixed-product QUALITY enablement.
import Database from 'better-sqlite3';
import {constants,openSync,closeSync,writeFileSync,fsyncSync,realpathSync,mkdirSync,existsSync,renameSync,lstatSync,fstatSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {readBoundedStableFile as bounded} from './boundedStableFile';
import {readRmsQuoteRequest} from './rmsQuoteRequest';
import {assertAcceptedTwoPersonProducer} from './twoPersonMarketAdmissionLane';
import {historyWriterLockPath} from './freshHistoryToDbSync';
import {captureObservedListingCanonicalInput} from './observedListingCanonicalInput';
import {digest} from './marketRowPriceQuality';
import {parseObservedListingPublicationConfig} from './observedListingConfig';
export {parseObservedListingPublicationConfig} from './observedListingConfig';
const hash=z.string().regex(/^[0-9a-f]{64}$/u);
const time=z.string().datetime({offset:true});
const pointerSchema=z.object({schema:z.literal('OBSERVED_LISTING_PUBLICATION_V1'),evidenceKind:z.literal('OBSERVED_LISTING_RELATIVE_V1'),generatedAt:time,artifactRawSha256:hash,artifactSha256:hash,sourceSnapshotSha256:hash,configSha256:hash,analysisPolicySha256:hash,producerCodeSha256s:z.array(hash).min(1).max(30),producerSetSha256:hash,publicationSha256:hash}).strict();
const completionSchema=z.object({schema:z.literal('OBSERVED_LISTING_PUBLICATION_COMPLETED_V1'),publicationSha256:hash,artifactSha256:hash,completedAt:time,status:z.literal('VERIFIED'),snapshotVerifiedBeforeRelease:z.literal(true),writerLockReleased:z.literal(true),completionSha256:hash}).strict();
const rawSha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
// Closed failure telemetry only: never persist an exception message, stack or path.
export function observedListingFailureCode(error:unknown):string{
 try{
  if(error instanceof z.ZodError)return 'SCHEMA_UNVERIFIED';
  const e=error as {code?:unknown;message?:unknown;status?:unknown};
  const codes:Record<string,string>={ENOENT:'FILE_MISSING',EACCES:'FILE_PERMISSION',EPERM:'FILE_PERMISSION',EIO:'FILE_IO',ENOSPC:'FILE_SPACE',EEXIST:'FILE_EXISTS',SQLITE_BUSY:'LOCK_BUSY',SQLITE_LOCKED:'LOCK_BUSY',ENOBUFS:'SUBPROCESS_OUTPUT_BUDGET'};
  if(typeof e?.code==='string'&&Object.hasOwn(codes,e.code))return codes[e.code]!;
  const known=['LISTING_REPORT_TOTAL_BUDGET','LISTING_REPORT_FILE_BUDGET','LISTING_REPORT_BUDGET','LISTING_REPORT_RECEIPT_BINDING','STABLE_READ_SIZE','STABLE_READ_CHANGED','STABLE_READ_GREW_PAST_BUDGET','STABLE_READ_BUDGET','LISTING_TRACKED_REQUEST_LANE_REQUIRED','LISTING_NORMAL_EXACT_MIRROR_REQUIRED','LISTING_CONFIG_PIN','LISTING_PRODUCER_NOT_ACCEPTED','LISTING_FINAL_NORMAL_REPORT_REQUIRED','LISTING_RUN_LOCAL_PRODUCER_REQUIRED','LISTING_NORMAL_REQUEST_CHANGED','LISTING_NORMAL_REPORT_PIN','LISTING_RESERVATION_SCHEMA_OR_TIME','LISTING_HISTORY_LOCK_ALIAS','LISTING_SOURCE_CHANGED','LISTING_CANONICAL_CHANGED','LISTING_SOURCE_OR_SIDECAR_CHANGED','LISTING_PUBLICATION_TIME_OR_REQUEST_EXPIRED','LISTING_PRIOR_POINTER_UNVERIFIED','LISTING_PRIOR_COMPLETION_UNVERIFIED','LISTING_POINTER_CAS','LISTING_POINTER_READBACK','LISTING_OUTPUT_ALIAS','LISTING_OUTPUT_BUDGET','LISTING_IMMUTABLE_CONFLICT','LISTING_IMMUTABLE_READBACK','LISTING_POINTER_CHANGED_BEFORE_COMPLETION'];
  if(typeof e?.message==='string'&&known.includes(e.message))return e.message;
  if(Number.isInteger(e?.status))return 'SUBPROCESS_FAILED';
 }catch{}
 return 'OTHER';
}

/** No retries, repairs or fallback CSVs. Failure leaves previous expiry/attempt invalidations intact. */
export function recordNormalObservedListing(env:Record<string,string|undefined>,i:{root:string;runId:string;reportPath:string;dbPath:string;mirrorExact:boolean}){
 if(env['ZMI_OBSERVED_LISTING_ENABLED']!=='1')return {status:'DISABLED' as const};
 let complete:(()=>void)|undefined;
 let stage='PRECONDITIONS';
 let lock:Database.Database|undefined,cleanupFailed=false,result:Record<string,unknown>={status:'LISTING_UNVERIFIED_PREVIOUS_EXPIRY_AND_ATTEMPT_GUARDS_RETAINED'};
 try{
  if(env['ZMI_USEFUL_QUOTES_ENABLED']!=='1'||env['ZMI_RATE_CELL_EVIDENCE_ENABLED']!=='1')throw Error('LISTING_TRACKED_REQUEST_LANE_REQUIRED');
  if(realpathSync(i.root)!==i.root||i.reportPath!==join(i.root,'.data/reports/automation',i.runId+'.json')||i.dbPath!==join(i.root,'.data/zao-market-intelligence.sqlite')||!/^auto_runner_market_refresh_rotating_\d{8}_\d{6}$/u.test(i.runId)||!i.mirrorExact)throw Error('LISTING_NORMAL_EXACT_MIRROR_REQUIRED');
  stage='SOURCE';const sourceEnv={...env,ZMI_2P_ACCEPTED_PRODUCER_DIGEST:env['ZMI_OBSERVED_LISTING_ACCEPTED_PRODUCER_DIGEST']},producer=assertAcceptedTwoPersonProducer(sourceEnv);
  stage='CONFIG';const path=env['ZMI_OBSERVED_LISTING_CONFIG_PATH']??'',expected=env['ZMI_OBSERVED_LISTING_CONFIG_SHA256']??'';hash.parse(expected);const configBytes=bounded(path,65536);if(rawSha(configBytes)!==expected)throw Error('LISTING_CONFIG_PIN');const cfg=parseObservedListingPublicationConfig(JSON.parse(configBytes.toString()));if(!cfg.acceptedProducerCodes.includes(producer.codeSha256))throw Error('LISTING_PRODUCER_NOT_ACCEPTED');
  stage='NORMAL_REPORT';const reportBytes=bounded(i.reportPath,2*1024*1024),report=JSON.parse(reportBytes.toString());if(report.run_id!==i.runId||report.dry_run!==false||report.decision!=='rotating_market_refresh_success'||report.db_synced!==true||report.collection_planner!=='USEFUL_QUOTES_V1'||report.useful_quote_lane?.status!=='READY')throw Error('LISTING_FINAL_NORMAL_REPORT_REQUIRED');
  const observation=report.producer_observation,{observationSha256,...observationBody}=observation??{};
  if(!observation||observation.schema!=='ZMI_COLLECTOR_PRODUCER_OBSERVATION_V1'||observation.runId!==i.runId||observation.status!=='STABLE_CODE_PINS_OBSERVED'||observation.evidenceScope!=='GIT_SOURCE_OBSERVATION_NOT_INDEPENDENT_RUNTIME_ATTESTATION'||digest(observationBody)!==observationSha256||observation.started?.producerCodeSha256!==producer.codeSha256||observation.finished?.producerCodeSha256!==producer.codeSha256||digest(observation.started.codePins)!==producer.codeSha256||digest(observation.finished.codePins)!==producer.codeSha256||!Number.isFinite(Date.parse(observation.finished.observedAt))||Date.now()-Date.parse(observation.finished.observedAt)<0||Date.now()-Date.parse(observation.finished.observedAt)>60000)throw Error('LISTING_RUN_LOCAL_PRODUCER_REQUIRED');
  stage='REQUEST';const asOf=new Date().toISOString(),requestPath=env['ZMI_RMS_QUOTE_REQUEST_PATH']??'',requestBytes=bounded(requestPath,1024*1024),request=readRmsQuoteRequest(requestPath,asOf,{releaseGitSha:env['ZMI_RMS_QUOTE_SOURCE_RELEASE']??'',bundleSha256:env['ZMI_RMS_QUOTE_BUNDLE_SHA256']??'',graphSha256:env['ZMI_RMS_QUOTE_GRAPH_SHA256']??''});
  if(report.useful_quote_lane.diagnostics?.requestSha256!==request.requestSha256)throw Error('LISTING_NORMAL_REQUEST_CHANGED');
  stage='LOCK';const lockPath=historyWriterLockPath(join(i.root,'.data/history'));if(realpathSync(lockPath)!==lockPath)throw Error('LISTING_HISTORY_LOCK_ALIAS');lock=new Database(lockPath,{fileMustExist:true,timeout:0});lock.exec('BEGIN IMMEDIATE');
  stage='CANONICAL_INPUT';const captured=captureObservedListingCanonicalInput({root:i.root,dbPath:i.dbPath,request,asOf,policy:cfg.policy,producerCodeSha256s:[producer.codeSha256],quarantine:cfg.quarantine,normalRun:{runId:i.runId,reportRawSha256:rawSha(reportBytes),producerObservationSha256:observationSha256,mirrorExactVerified:true}});
  stage='OUTPUT_DIRECTORY';const directory=join(i.root,'.data/market-listing',expected);for(const d of [join(i.root,'.data/market-listing'),directory]){mkdirSync(d,{recursive:true,mode:0o700});if(realpathSync(d)!==d)throw Error('LISTING_OUTPUT_ALIAS');}
  stage='PRIOR_POINTER';const current=join(directory,'current.json'),before=existsSync(current)?bounded(current,65536):null;
  if(before){const p=pointerSchema.parse(JSON.parse(before.toString())),{publicationSha256,...b}=p;if(p.configSha256!==expected||digest(b)!==publicationSha256||digest([...new Set(p.producerCodeSha256s)].sort())!==p.producerSetSha256||p.producerCodeSha256s.some(c=>!cfg.acceptedProducerCodes.includes(c))||Date.parse(p.generatedAt)>Date.parse(asOf))throw Error('LISTING_PRIOR_POINTER_UNVERIFIED');const completed=completionSchema.parse(JSON.parse(bounded(join(directory,'listing_completed_'+publicationSha256+'.json'),65536).toString())),{completionSha256,...c}=completed;if(completed.publicationSha256!==publicationSha256||completed.artifactSha256!==p.artifactSha256||Date.parse(completed.completedAt)<Date.parse(p.generatedAt)||Date.parse(completed.completedAt)>Date.parse(asOf)||digest(c)!==completionSha256)throw Error('LISTING_PRIOR_COMPLETION_UNVERIFIED');}
  const guard=()=>{if(Date.now()<Date.parse(asOf)||Date.now()-Date.parse(asOf)>60000||Date.now()>=Date.parse(request.expiresAt))throw Error('LISTING_PUBLICATION_TIME_OR_REQUEST_EXPIRED');captured.assertUnchanged();if(assertAcceptedTwoPersonProducer(sourceEnv).codeSha256!==producer.codeSha256||!bounded(path,65536).equals(configBytes)||!bounded(requestPath,1024*1024).equals(requestBytes)||!bounded(i.reportPath,2*1024*1024).equals(reportBytes))throw Error('LISTING_SOURCE_CHANGED');};
  const dirSync=()=>{const fd=openSync(directory,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}};
  const immutable=(name:string,value:unknown,max:number,assert=guard)=>{assert();const bytes=Buffer.from(JSON.stringify(value)+'\n'),path=join(directory,name);if(bytes.length>max)throw Error('LISTING_OUTPUT_BUDGET');if(existsSync(path)){if(!bounded(path,max).equals(bytes))throw Error('LISTING_IMMUTABLE_CONFLICT');return bytes;}const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}dirSync();if(!bounded(path,max).equals(bytes))throw Error('LISTING_IMMUTABLE_READBACK');return bytes;};
  stage='ARTIFACT';const bytes=immutable('listing_'+captured.artifact.artifactSha256+'.json',captured.artifact,4*1024*1024);stage='MANIFEST';immutable('listing_inputs_'+captured.manifest.sourceSnapshotSha256+'.json',captured.manifest,4*1024*1024);
  const body={schema:'OBSERVED_LISTING_PUBLICATION_V1',evidenceKind:'OBSERVED_LISTING_RELATIVE_V1',generatedAt:asOf,artifactRawSha256:rawSha(bytes),artifactSha256:captured.artifact.artifactSha256,sourceSnapshotSha256:captured.manifest.sourceSnapshotSha256,configSha256:expected,analysisPolicySha256:captured.artifact.policySha256,producerCodeSha256s:captured.artifact.producerCodeSha256s,producerSetSha256:captured.artifact.producerSetSha256},pointer=Buffer.from(JSON.stringify({...body,publicationSha256:digest(body)})+'\n'),temp=join(directory,'.tmp-'+randomUUID());let fd:number|undefined;
  const cas=()=>{const actual=existsSync(current)?bounded(current,65536):null;if(before===null?actual!==null:actual===null||!before.equals(actual))throw Error('LISTING_POINTER_CAS');};
  stage='POINTER';try{guard();cas();fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,pointer);fsyncSync(fd);guard();cas();renameSync(temp,current);dirSync();if(!bounded(current,65536).equals(pointer))throw Error('LISTING_POINTER_READBACK');guard();}
  finally{if(fd!==undefined){try{if(existsSync(temp)){const a=lstatSync(temp),b=fstatSync(fd);if(a.dev===b.dev&&a.ino===b.ino)unlinkSync(temp);}}finally{closeSync(fd);}}}
  complete=()=>{if(!bounded(current,65536).equals(pointer))throw Error('LISTING_POINTER_CHANGED_BEFORE_COMPLETION');const b={schema:'OBSERVED_LISTING_PUBLICATION_COMPLETED_V1',publicationSha256:digest(body),artifactSha256:captured.artifact.artifactSha256,completedAt:new Date().toISOString(),status:'VERIFIED',snapshotVerifiedBeforeRelease:true,writerLockReleased:true};immutable('listing_completed_'+digest(body)+'.json',{...b,completionSha256:digest(b)},65536,()=>{if(!bounded(current,65536).equals(pointer))throw Error('LISTING_POINTER_CHANGED_BEFORE_COMPLETION');});};
  result={status:'NORMAL_OBSERVED_LISTING_PUBLISHED' as const,evidenceKind:captured.artifact.evidenceKind,artifactSha256:captured.artifact.artifactSha256,sourceSnapshotSha256:captured.manifest.sourceSnapshotSha256,publicationSha256:digest(body),supportedDays:captured.artifact.days.filter(d=>d.eligible).length,priceAuthority:false};
 }catch(error){result={status:'LISTING_UNVERIFIED_PREVIOUS_EXPIRY_AND_ATTEMPT_GUARDS_RETAINED',failureStage:stage,failureCode:observedListingFailureCode(error)};}
 finally{if(lock){try{if(lock.inTransaction)lock.exec('ROLLBACK');}catch{cleanupFailed=true;}try{lock.close();}catch{cleanupFailed=true;}}}
 if(cleanupFailed)return {status:'LISTING_PUBLICATION_CLEANUP_UNVERIFIED',failureStage:'CLEANUP',failureCode:'LOCK_CLEANUP_UNVERIFIED',priceAuthority:false};
 if(complete)try{complete();}catch(error){return {status:'LISTING_PUBLICATION_COMPLETION_UNVERIFIED',failureStage:'COMPLETION',failureCode:observedListingFailureCode(error),priceAuthority:false};}
 return result;
}
/** Publication diagnostics cannot change the already-final collector result. */
export function recordNormalObservedListingDiagnostic(env:Record<string,string|undefined>,i:Parameters<typeof recordNormalObservedListing>[1],save:(result:Record<string,unknown>)=>void){
 let result:Record<string,unknown>;try{result=recordNormalObservedListing(env,i);}catch(error){return {status:'LISTING_PUBLICATION_BOUNDARY_UNVERIFIED',failureStage:'BOUNDARY',failureCode:observedListingFailureCode(error)};}
 if(result.status==='DISABLED')return result;try{save(result);return result;}catch{return {status:'LISTING_DIAGNOSTIC_SAVE_UNVERIFIED',publicationStatus:result.status};}
}


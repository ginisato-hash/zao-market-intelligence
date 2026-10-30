// Normal post-append hook only. Default OFF: no I/O. Mirror equality and price authenticity stay separate.
import {readBoundedStableFile as bounded} from './boundedStableFile';
import {constants,openSync,closeSync,mkdirSync,writeFileSync,fsyncSync,realpathSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sealConservationReceipt} from './marketConservationReceipt';
import {join,resolve,sep} from 'node:path';
import {admitCanonicalBookingTwoPerson} from './bookingTwoPersonMarketAdmission';
import {sealQualityLedger,digest,instant} from './marketRowPriceQuality';
import {validatePanel,type MarketPanel,type TwoPersonInvalidation} from './marketTwoPersonCurve';
import {openReadOnlyMarketMirror} from './marketMirrorReadOnly';
import type {HistoryRow} from './localHistorySchemaDesign';
import type {BookingRateCellCapture} from './bookingRateCellEvidence';
export function readAcceptedTwoPersonPanel(env:Record<string,string|undefined>):MarketPanel|null{
 if(env['ZMI_2P_QUALITY_ENABLED']!=='1')return null;
 try{const path=env['ZMI_2P_PANEL_PATH'],expected=env['ZMI_2P_PANEL_SHA256'];if(!path||!expected)throw Error('ACCEPTED_PANEL_NOT_CONFIGURED');
 const bytes=bounded(path,256*1024);if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('ACCEPTED_PANEL_RAW_HASH');
 const panel=JSON.parse(bytes.toString('utf8')) as MarketPanel;validatePanel(panel);return panel;}catch{return null;}
}
/** Capture-only accepted panel targeting is independent of price-quality enablement. No admission or authority. */
export function readCaptureTwoPersonPanel(env:Record<string,string|undefined>):MarketPanel|null{
 if(env['ZMI_RATE_CELL_EVIDENCE_ENABLED']!=='1'&&env['ZMI_2P_QUALITY_ENABLED']!=='1')return null;
 return readAcceptedTwoPersonPanel({...env,ZMI_2P_QUALITY_ENABLED:'1'});
}
export function recordTwoPersonMarketAdmission(env:Record<string,string|undefined>,input:{runId:string;now:string;root:string;captureDir:string;dbPath:string;mirrorExact:boolean;rows:readonly HistoryRow[];captures:readonly Record<string,unknown>[]}){
 if(env['ZMI_2P_QUALITY_ENABLED']!=='1')return {status:'DISABLED',eligibleRows:0};

 let mirror:ReturnType<typeof openReadOnlyMarketMirror>|undefined;
 try{
  if(!/^auto_runner_market_refresh_rotating_\d{8}_\d{6}$/u.test(input.runId)||input.rows.length>1000||input.captures.length>1000)throw Error('ADMISSION_SCOPE');
  const {tree,codeSha256}=assertAcceptedTwoPersonProducer(env);
  const conservation=sealConservationReceipt({runId:input.runId,writtenAt:input.now,producerSourceTreeGitSha:tree,producerCodeSha256:codeSha256,rows:input.rows.map(r=>({rowId:r.rowId,rowHash:r.rowHash}))});
  const conservationDir=resolve(input.root,'.data/history-quality');mkdirSync(conservationDir,{recursive:true,mode:0o700});if(realpathSync(conservationDir)!==conservationDir)throw Error('CONSERVATION_OUTPUT_SYMLINK');
  const conservationPath=join(conservationDir,'append_'+input.runId+'.json');
  if(existsSync(conservationPath)){if(digest(JSON.parse(bounded(conservationPath,2*1024*1024).toString('utf8')))!==digest(conservation))throw Error('CONSERVATION_RECEIPT_CONFLICT');}
  else{const fd=openSync(conservationPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);try{writeFileSync(fd,JSON.stringify(conservation)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
  const panelPath=env['ZMI_2P_PANEL_PATH'];if(!panelPath||!env['ZMI_2P_PANEL_SHA256'])throw Error('ACCEPTED_PANEL_NOT_CONFIGURED');
  const bytes=bounded(panelPath,256*1024);if(createHash('sha256').update(bytes).digest('hex')!==env['ZMI_2P_PANEL_SHA256'])throw Error('ACCEPTED_PANEL_RAW_HASH');
  const panel=JSON.parse(bytes.toString('utf8')) as MarketPanel;validatePanel(panel);
  if(input.mirrorExact)mirror=openReadOnlyMarketMirror(input.dbPath);
  const root=realpathSync(input.captureDir),facts=[],quality=[],exclusions:Record<string,number>={};
  const no=(r:string)=>{exclusions[r]=(exclusions[r]??0)+1;};
  for(const row of input.mirrorExact?input.rows:[]){
   if(row.source!=='booking'){no('SECONDARY_OTA_NOT_REQUIRED');continue;}
   const captures=input.captures.filter(c=>c.propertySlug===row.sourceSlugOrCode&&c.stayDate===row.checkin&&typeof c.capturePath==='string');
   if(captures.length!==1){no('NORMAL_RUN_CAPTURE_NOT_UNIQUE');continue;}
   const cap=captures[0]!,path=realpathSync(String(cap.capturePath));if(!path.startsWith(root+sep)||!path.endsWith(sep+'selected_rate_cells_v1.json'))throw Error('ADMISSION_CAPTURE_CONTAINMENT');
   const raw=bounded(path,64000),capture=JSON.parse(raw.toString('utf8')) as BookingRateCellCapture;
   const products=panel.products.filter(p=>p.sourcePropertyId===row.sourceSlugOrCode&&p.source==='booking');
   if(products.length!==1){no('FIXED_PANEL_PRODUCT_NOT_UNIQUE');continue;}
   const identity=mirror!.db.prepare('SELECT row_id,row_hash FROM market_signal_history WHERE row_id=?').get(row.rowId) as {row_id:string;row_hash:string}|undefined;
   const fact=admitCanonicalBookingTwoPerson({row,mirrorIdentity:identity?{rowId:identity.row_id,rowHash:identity.row_hash}:null,capture,rawCaptureBytes:raw,
    independentRawCaptureSha256:String(cap.rawSha256??''),pageFinalBlockReason:typeof cap.pageFinalBlockReason==='string'?cap.pageFinalBlockReason:null,
    pageFinalBlockStateVerified:cap.pageFinalBlockStateVerified===true,product:products[0]!,standardProductProofVerified:true,ingestedAt:input.now});
   if(fact.observation&&fact.quality){facts.push(fact.observation);quality.push(fact.quality);}else no(fact.reason);
  }
  mirror?.assertUnchanged();const ledger=sealQualityLedger(quality);
  const invalidations=normalAttemptInvalidations(panel,input.captures,input.now,facts);
  if(!input.mirrorExact)no('MIRROR_NOT_EXACT_NO_PRICE_ADMISSION');
  const body={schema:'ZMI_CANONICAL_2P_ADMISSION_V1',runId:input.runId,ingestedAt:input.now,panelSha256:panel.panelSha256,producerCodeSha256:codeSha256,mirrorExactVerified:input.mirrorExact,invalidations,source:'NORMAL_TRUSTED_APPEND_AND_EXACT_MIRROR',facts,qualityLedger:ledger,exclusions,marketPriceAuthority:false};
  const sha256=digest(body),out={...body,admissionSha256:sha256};
  const dir=resolve(input.root,'.data/history-quality');mkdirSync(dir,{recursive:true,mode:0o700});
  if(realpathSync(dir)!==dir)throw Error('ADMISSION_OUTPUT_SYMLINK');
  const dest=join(dir,input.runId+'.json'),encoded=JSON.stringify(out)+'\n';
  if(existsSync(dest)){if(digest(JSON.parse(bounded(dest,4*1024*1024).toString('utf8')))!==digest(out))throw Error('ADMISSION_RECEIPT_CONFLICT');}
  else {const fd=openSync(dest,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);try{writeFileSync(fd,encoded);fsyncSync(fd);}finally{closeSync(fd);}const d=openSync(dir,constants.O_RDONLY);try{fsyncSync(d);}finally{closeSync(d);}}
  mirror?.assertUnchanged();return {status:'CANONICAL_ADMISSION_RECORDED',eligibleRows:facts.length,exclusions,qualityLedgerSha256:ledger.ledgerSha256,admissionSha256:sha256};
 }catch{return {status:'ADMISSION_UNVERIFIED_NO_PRICE_INPUT',eligibleRows:0};}finally{mirror?.close();}
}

/** This is denial only: an actually attempted request without an admitted fact invalidates its old quote. */
export function normalAttemptInvalidations(panel:MarketPanel,captures:readonly Record<string,unknown>[],ingestedAt:string,
 facts:readonly {sourcePropertyId:string;stayDate:string}[]):TwoPersonInvalidation[]{
 if(!Number.isFinite(instant(ingestedAt))||captures.length>1000)throw Error('ATTEMPT_BUDGET_OR_TIME');
 const out:TwoPersonInvalidation[]=[];
 for(const c of captures){
  if(c.attemptedNetwork!==true||c.status==='REQUEST_RESERVATION_REFUSED_NO_NETWORK')continue;
  const at=String(c.completedAt??'');
  if(!Number.isFinite(instant(at))||instant(at)>instant(ingestedAt)||instant(ingestedAt)-instant(at)>2*3600000)throw Error('ATTEMPT_TIME_UNVERIFIED');
  if(facts.some(f=>f.sourcePropertyId===c.propertySlug&&f.stayDate===c.stayDate))continue;
  for(const p of panel.products.filter(p=>p.source==='booking'&&p.sourcePropertyId===c.propertySlug)){
   out.push({propertyId:p.propertyId,sourcePropertyId:p.sourcePropertyId,source:p.source,productId:p.productId,ratePlanId:p.ratePlanId,conditionKey:p.conditionKey,
    stayDate:String(c.stayDate),observedAt:at,ingestedAt,reason:'NORMAL_ATTEMPT_WITHOUT_ADMITTED_PRICE',
    sourceEvidenceSha256:digest({propertySlug:c.propertySlug,stayDate:c.stayDate,attemptedNetwork:true,completedAt:at,rawSha256:c.rawSha256??null,
     status:c.status??null,fixedProductSelection:c.fixedProductSelection??null,pageFinalBlockReason:c.pageFinalBlockReason??null,pageFinalBlockStateVerified:c.pageFinalBlockStateVerified===true})});
  }
 }
 return out;
}

export function assertAcceptedTwoPersonProducer(env:Record<string,string|undefined>){
  const repo=fileURLToPath(new URL('../../',import.meta.url));
  const tree=execFileSync('git',['-C',repo,'rev-parse','HEAD:src'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  const codePins=Object.fromEntries(['src','scripts','package.json','package-lock.json','tsconfig.json'].map(name=>[name,execFileSync('git',['-C',repo,'rev-parse','HEAD:'+name],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()]));
  const codeSha256=digest(codePins);
  if(env['ZMI_2P_ACCEPTED_PRODUCER_DIGEST']!==codeSha256||execFileSync('git',['-C',repo,'status','--porcelain','--','src','scripts','package.json','package-lock.json','tsconfig.json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim())throw Error('ADMISSION_SOURCE_NOT_ACCEPTED_OR_DIRTY');
  return {tree,codeSha256};
}

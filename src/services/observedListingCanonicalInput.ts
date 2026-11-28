// Bounded canonical history projection for the existing normal collector's listing publication.
// Raw rows remain in child/parent RAM. No source requests, history writes, schema changes or price authority.
import {execFileSync} from 'node:child_process';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readBoundedStableFile as bounded} from './boundedStableFile';
import {isPricingQuoteReservation} from './pricingQuoteReservation';
import {digest} from './marketRowPriceQuality';
import {analyzeObservedListingRelative,listingPropertyAliases,listingCaptureFinalGuardClear,listingRowFinalGuardFailure,canonicalListingRowSetSha256,type ListingAnalysisPolicy,type ListingCanonicalRow,type ListingAttempt} from './observedListingRelative';
import type {RmsQuoteRequest} from './rmsQuoteRequest';
import {captureListingRunReport,readCapturedListingRunReport,type CapturedListingRunReport} from './observedListingReportReceipt';
import {LISTING_REPORT_FILE_BYTES,LISTING_REPORT_COUNT,consumeListingReportBytes} from './observedListingReportBudget';
export interface ListingQuarantineRef {path:string;rawSha256:string;entriesKey:'entries'|'unknownRows'}
const rawSha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const projection=String.raw`import sys,json,sqlite3,pathlib,datetime,os,hashlib
q=json.load(sys.stdin);p=pathlib.Path(q['dbPath'])
assert p.resolve(strict=True)==p and p.is_file() and p.stat().st_size<=512*1024*1024
def stamp():
 s=p.stat();return ':'.join(str(x) for x in [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns])
def sidecars():return any(pathlib.Path(str(p)+s).exists() for s in ['-wal','-shm','-journal'])
before=stamp();assert not sidecars()
canonical=lambda v:json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':'))
sha=lambda b:hashlib.sha256(b).hexdigest()
quarantine={}
for ref in q['quarantine']:
 f=pathlib.Path(ref['path']);assert f.resolve(strict=True)==f
 fd=os.open(str(f),os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  a=os.fstat(stream.fileno());assert a.st_size<=2*1024*1024;b=stream.read(2*1024*1024+1);z=os.fstat(stream.fileno())
 assert len(b)<=2*1024*1024 and (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns,z.st_ctime_ns) and sha(b)==ref['rawSha256']
 for e in json.loads(b)[ref['entriesKey']]:
  assert e['rowId'] not in quarantine or quarantine[e['rowId']]==e['rowHash'];quarantine[e['rowId']]=e['rowHash']
c=sqlite3.connect('file:'+str(p)+'?mode=ro&immutable=1',uri=True);c.execute('PRAGMA query_only=ON');c.set_progress_handler(lambda:0,10000)
cut=(datetime.datetime.fromisoformat(q['asOf'].replace('Z','+00:00')).astimezone(datetime.timezone(datetime.timedelta(hours=9)))-datetime.timedelta(hours=q['lookbackHours'])).isoformat()
sql='SELECT row_id,row_hash,CASE WHEN typeof(raw_json)=\'text\' AND length(CAST(raw_json AS BLOB))<=65536 THEN raw_json ELSE NULL END FROM market_signal_history WHERE source=? AND checkin_date IN ('+','.join('?' for _ in q['dates'])+') AND collected_at_jst>=? ORDER BY row_id LIMIT 15001'
a=c.execute(sql,['booking',*q['dates'],cut]).fetchall();c.close();assert len(a)<=15000 and stamp()==before and not sidecars()
rows=[]
for rid,rh,raw in a:
 assert isinstance(rid,str) and len(rid)<=1024 and isinstance(rh,str) and raw is not None
 assert rid not in quarantine or quarantine[rid]==rh
 rows.append({'rowId':rid,'rowHash':rh,'mirrorRowHash':rh,'raw':json.loads(raw),'quarantineReason':'KNOWN_SAVED_ROW_PRICE_QUARANTINE' if rid in quarantine else None})
refs=[{'rowId':r['rowId'],'rowHash':r['rowHash'],'rawRecordSha256':sha(canonical(r['raw']).encode()),'quarantineReason':r['quarantineReason']} for r in rows]
print(json.dumps({'kind':'OBSERVED_LISTING_CANONICAL_RAM_PROJECTION_V1','sourceStamp':before,'rowRefs':refs,'canonicalRowSetSha256':sha(canonical(refs).encode()),'rows':rows}))`;
export function captureObservedListingCanonicalInput(i:{root:string;dbPath:string;request:RmsQuoteRequest;asOf:string;policy:ListingAnalysisPolicy;producerCodeSha256s:string[];quarantine:ListingQuarantineRef[];normalRun?:{runId:string;reportRawSha256:string;producerObservationSha256:string;mirrorExactVerified:true}}){
 if(realpathSync(i.root)!==i.root||i.dbPath!==join(i.root,'.data/zao-market-intelligence.sqlite')||i.quarantine.length>10)throw Error('LISTING_CANONICAL_SCOPE');
 const targetDates=i.request.needs.filter(n=>n.priceDecisionEligible).map(n=>n.stayDate);if(!targetDates.length||targetDates.length>1000)throw Error('LISTING_TARGET_SCOPE');
 const doc=JSON.parse(execFileSync('python3',['-c',projection],{input:JSON.stringify({...i,dates:targetDates,lookbackHours:i.policy.maxComparisonAgeHours}),encoding:'utf8',maxBuffer:32*1024*1024,timeout:30000,stdio:['pipe','pipe','pipe']}));
 if(doc.kind!=='OBSERVED_LISTING_CANONICAL_RAM_PROJECTION_V1')throw Error('LISTING_PROJECTION_KIND');
 const sourceFiles:{path:string;sha256:string}[]=i.quarantine.map(q=>({path:q.path,sha256:q.rawSha256})),missingAttemptFiles:string[]=[],reports:CapturedListingRunReport[]=[],cache=new Map<string,any>();let reportBytes=0;
 const read=(path:string,max:number)=>{if(realpathSync(path)!==path)throw Error('LISTING_SOURCE_ALIAS');const a=statSync(path,{bigint:true}),b=bounded(path,max),z=statSync(path,{bigint:true});if([a.dev,a.ino,a.size,a.mtimeNs,a.ctimeNs].some((x,n)=>x!==[z.dev,z.ino,z.size,z.mtimeNs,z.ctimeNs][n]))throw Error('LISTING_SOURCE_CHANGED');sourceFiles.push({path,sha256:rawSha(b)});return b;};
 if(i.normalRun){const path=join(i.root,'.data/reports/automation',i.normalRun.runId+'.json');if(rawSha(read(path,2*1024*1024))!==i.normalRun.reportRawSha256)throw Error('LISTING_NORMAL_REPORT_PIN');}
 const rows=doc.rows as ListingCanonicalRow[],targets=new Set(targetDates),attempts:ListingAttempt[]=[];
 const report=(slot:string)=>{if(cache.has(slot))return cache.get(slot);if(cache.size>=LISTING_REPORT_COUNT)throw Error('LISTING_REPORT_BUDGET');const path=join(i.root,'.data/reports/automation','auto_runner_market_refresh_rotating_'+slot+'.json');if(!existsSync(path)){cache.set(slot,null);return null;}const b=read(path,LISTING_REPORT_FILE_BYTES),d=JSON.parse(b.toString());if(d.run_id!=='auto_runner_market_refresh_rotating_'+slot||d.dry_run!==false||!['rotating_market_refresh_success','rotating_market_refresh_partial_success'].includes(d.decision)){cache.set(slot,null);return null;}const receipt=captureListingRunReport({runId:d.run_id,rawSha256:rawSha(b),rawJson:b.toString()}),saved=readCapturedListingRunReport(receipt);reportBytes=consumeListingReportBytes(reportBytes,saved.retainedBytes);reports.push(receipt);cache.set(slot,saved.report);return saved.report;};
 // Bind every claimed normal-run row, including previous observations outside the 48h attempt window.
 for(const r of rows){const slot=/\/auto-runner-market-refresh-rotating\/(\d{8}_\d{6})\//u.exec(r.raw.debug_artifact_path??'')?.[1];if(slot)report(slot);}
 const outcomes=new Map(reports.map(r=>[r.runId,readCapturedListingRunReport(r).report]));
 for(const r of rows){const reason=listingRowFinalGuardFailure(r,outcomes,Date.parse(i.asOf));if(reason&&r.quarantineReason===null)r.quarantineReason=reason;}
 const rowRefs=rows.map(r=>({rowId:r.rowId,rowHash:r.rowHash,rawRecordSha256:digest(r.raw),quarantineReason:r.quarantineReason})).sort((a,b)=>a.rowId<b.rowId?-1:a.rowId>b.rowId?1:0);
 const day=(at:number)=>new Date(at+9*3600000).toISOString().slice(0,10),first=day(Date.parse(i.asOf)-i.policy.maxCurrentAgeHours*3600000),last=day(Date.parse(i.asOf));
 for(let t=Date.parse(first+'T00:00:00Z');t<=Date.parse(last+'T00:00:00Z');t+=86400000){const path=join(i.root,'.data/run-state/pricing-quote-attempts',new Date(t).toISOString().slice(0,10)+'.jsonl');if(!existsSync(path)){missingAttemptFiles.push(path);continue;}const lines=read(path,2*1024*1024).toString().split('\n').filter(Boolean);if(lines.length>15000)throw Error('LISTING_ATTEMPT_BUDGET');for(const line of lines){const a=JSON.parse(line);if(!isPricingQuoteReservation(a)||Date.parse(a.attemptAt)>Date.parse(i.asOf))throw Error('LISTING_RESERVATION_SCHEMA_OR_TIME');if(!targets.has(a.stayDate))continue;let completedObservationRowId:string|null=null;for(const r of rows.filter(r=>(r.raw.source_slug_or_code||r.raw.source_property_id)===a.propertySlug&&r.raw.checkin===a.stayDate&&Date.parse(r.raw.collected_at_jst!)<=Date.parse(a.attemptAt))){const slot=/\/auto-runner-market-refresh-rotating\/(\d{8}_\d{6})\//u.exec(r.raw.debug_artifact_path??'')?.[1];if(!slot)continue;const d=report(slot),c=d?.rate_cell_evidence?.captures?.find((c:any)=>c.propertySlug===a.propertySlug&&c.stayDate===a.stayDate&&c.attemptedNetwork===true&&Date.parse(c.completedAt)>=Date.parse(a.attemptAt)&&listingCaptureFinalGuardClear(c,d.run_id,d.generated_at_jst));if(d?.generated_at_jst===r.raw.collected_at_jst&&c&&r.quarantineReason===null){completedObservationRowId=r.rowId;break;}}attempts.push({propertyId:a.propertySlug,stayDate:a.stayDate,attemptedAt:a.attemptAt,completedObservationRowId});}}
 const producerCodeSha256s=[...new Set(i.producerCodeSha256s)].sort(),snapshot={schema:'OBSERVED_LISTING_CANONICAL_INPUT_MANIFEST_V1' as const,asOf:i.asOf,requestSha256:i.request.requestSha256,normalRun:i.normalRun??null,targetDates,sourceDbPath:i.dbPath,sourceStamp:doc.sourceStamp,canonicalRowSetSha256:canonicalListingRowSetSha256(rows),rowRefs,attemptSetSha256:digest(attempts),attempts,propertyAliases:listingPropertyAliases(rows),attemptCoverage:{from:first,through:last,missingAttemptFiles},producerCodeSha256s,producerSetSha256:digest(producerCodeSha256s),sourceFiles,canonicalRows:rows.length};
 const sourceSnapshotSha256=digest(snapshot),artifact=analyzeObservedListingRelative({rows,attempts,reports,sourceSnapshot:snapshot,targetDates,asOf:i.asOf,policy:i.policy,sourceSnapshotSha256,baselineBundleSha256:i.request.source.bundleSha256});
 const assertUnchanged=()=>{if(realpathSync(i.dbPath)!==i.dbPath||['-wal','-shm','-journal'].some(s=>existsSync(i.dbPath+s))||missingAttemptFiles.some(p=>existsSync(p)))throw Error('LISTING_SOURCE_OR_SIDECAR_CHANGED');const s=statSync(i.dbPath,{bigint:true});if([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')!==doc.sourceStamp||sourceFiles.some(f=>rawSha(bounded(f.path,2*1024*1024))!==f.sha256))throw Error('LISTING_CANONICAL_CHANGED');};
 assertUnchanged();return {artifact,manifest:{...snapshot,sourceSnapshotSha256},assertUnchanged};
}

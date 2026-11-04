// Run-local Git observations only. These do not attest loaded code or grant price authority.
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {digest,instant} from './marketRowPriceQuality';

const paths=['src','scripts','package.json','package-lock.json','tsconfig.json'] as const;
type Pins=Record<typeof paths[number],string>;
export type CollectorSourceSnapshot=
 | {status:'RECORDED';observedAt:string;releaseGitSha:string;codePins:Pins;producerCodeSha256:string}
 | {status:'UNVERIFIED';reason:'SOURCE_UNREADABLE_OR_DIRTY';observedAt:string|null};

/** Fixed read-only Git commands; never emits repository paths, stderr, environment or URLs. */
export function observeCollectorSource(repo=fileURLToPath(new URL('../../',import.meta.url)),clock=()=>new Date()):CollectorSourceSnapshot{
 let at:string|null=null;
 try{
  at=clock().toISOString();if(!Number.isFinite(instant(at)))throw Error('CLOCK');
  const git=(...args:string[])=>execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',repo,...args],
   {encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000,maxBuffer:128*1024}).trim();
  if(realpathSync(git('rev-parse','--show-toplevel'))!==realpathSync(repo))throw Error('ROOT');
  const read=()=>git('rev-parse','HEAD',...paths.map(p=>'HEAD:'+p)).split('\n');
  const before=read();
  if(before.length!==6||before.some(s=>!/^[0-9a-f]{40}$/u.test(s))||git('status','--porcelain','--untracked-files=all','--',...paths))throw Error('SOURCE');
  const after=read();if(before.some((s,i)=>s!==after[i])||git('status','--porcelain','--untracked-files=all','--',...paths))throw Error('SOURCE_CHANGED');
  const codePins=Object.fromEntries(paths.map((p,i)=>[p,before[i+1]!])) as Pins;
  return {status:'RECORDED',observedAt:at,releaseGitSha:before[0]!,codePins,producerCodeSha256:digest(codePins)};
 }catch{return {status:'UNVERIFIED',reason:'SOURCE_UNREADABLE_OR_DIRTY',observedAt:at};}
}

/** Data-only commits may move HEAD: record both, require the same five clean code pins. */
export function bindCollectorProducerEvidence(runId:string,started:CollectorSourceSnapshot,finished:CollectorSourceSnapshot){
 const m=/^auto_runner_market_refresh_rotating_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/u.exec(runId),validRun=m!==null;
 const runAt=m?Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`):NaN;
 const startAt=instant(started.observedAt),endAt=instant(finished.observedAt);
 // Never attach a current source snapshot to an old run as retroactive producer proof.
 const ordered=Number.isFinite(runAt)&&Number.isFinite(startAt)&&Number.isFinite(endAt)&&startAt>=runAt&&startAt-runAt<=60000&&endAt>=startAt&&endAt-startAt<=2*3600000;
 const same=started.status==='RECORDED'&&finished.status==='RECORDED'&&started.producerCodeSha256===digest(started.codePins)&&finished.producerCodeSha256===digest(finished.codePins)&&started.producerCodeSha256===finished.producerCodeSha256;
 const body={schema:'ZMI_COLLECTOR_PRODUCER_OBSERVATION_V1' as const,runId:validRun?runId:null,
  status:validRun&&ordered&&same?'STABLE_CODE_PINS_OBSERVED' as const:'UNVERIFIED' as const,
  started,finished,evidenceScope:'GIT_SOURCE_OBSERVATION_NOT_INDEPENDENT_RUNTIME_ATTESTATION' as const,priceAuthority:false as const};
 return {...body,observationSha256:digest(body)};
}

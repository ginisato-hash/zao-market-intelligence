// Collection reference configuration only. The owner-controlled canonical plist is
// the authority; this does not attest a scheduled invocation or grant price transport.
import {constants,lstatSync,openSync,fstatSync,closeSync,realpathSync,type BigIntStats} from 'node:fs';
import {userInfo,platform} from 'node:os';
import {join,isAbsolute,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readBoundedStableFd} from './boundedStableFile';
const JOB='com.yuge.zmi.market-refresh-rotating',SOURCE='ZMI_RMS_QUOTE_SOURCE_RELEASE';
type Env=Record<string,string|undefined>;
type Status='DISABLED'|'CURRENT_OWNER_CONFIGURATION'|'HELD_CONFIGURATION_UNVERIFIED'|'CHANGED_CONFIGURATION_STICKY_STOP';
const signature=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.uid,s.gid,s.nlink].map(String).join('|');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Error('CURRENT_QUOTE_REFERENCE_UNVERIFIED');};
export function validateCurrentQuoteReference(doc:unknown,loaded:Env):string{
 if(!doc||typeof doc!=='object'||Array.isArray(doc))return fail();
 const d=doc as {Label?:unknown;EnvironmentVariables?:unknown};
 if(d.Label!==JOB||!d.EnvironmentVariables||typeof d.EnvironmentVariables!=='object'||Array.isArray(d.EnvironmentVariables))return fail();
 const e=d.EnvironmentVariables as Record<string,unknown>;
 if(loaded['ZMI_USEFUL_QUOTES_ENABLED']!=='1'||typeof loaded[SOURCE]!=='string'||!/^[a-f0-9]{40}$/u.test(loaded[SOURCE])||e['ZMI_USEFUL_QUOTES_ENABLED']!=='1'||e['ZMI_RATE_CELL_EVIDENCE_ENABLED']!=='1'||loaded['ZMI_RATE_CELL_EVIDENCE_ENABLED']!=='1')return fail();
 for(const k of ['ZMI_RMS_QUOTE_REQUEST_PATH','ZMI_RMS_QUOTE_BUNDLE_SHA256','ZMI_RMS_QUOTE_GRAPH_SHA256'])if(typeof e[k]!=='string'||e[k]!==loaded[k]||e[k]==='')return fail();
 const path=e['ZMI_RMS_QUOTE_REQUEST_PATH'] as string;
 if(!isAbsolute(path)||resolve(path)!==path||![e['ZMI_RMS_QUOTE_BUNDLE_SHA256'],e['ZMI_RMS_QUOTE_GRAPH_SHA256']].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x))||typeof e[SOURCE]!=='string'||!/^[a-f0-9]{40}$/u.test(e[SOURCE]))return fail();
 return e[SOURCE] as string;
}
export function loadCurrentCollectorQuoteReference(loaded:Env):{env:Readonly<Env>;heldEnv:Readonly<Env>;current:()=>boolean;diagnostic:()=>{schema:'CURRENT_COLLECTOR_QUOTE_REFERENCE_V1';status:Status;loadedSourceWasStale:boolean|null;priceAuthority:false;scheduledInvocationAttested:false}}{
 const original=Object.freeze({...loaded}),held=Object.freeze({...loaded,[SOURCE]:''});let status:Status='DISABLED',stale:boolean|null=null;
 const diagnostic=()=>({schema:'CURRENT_COLLECTOR_QUOTE_REFERENCE_V1' as const,status,loadedSourceWasStale:stale,priceAuthority:false as const,scheduledInvocationAttested:false as const});
 if(loaded['ZMI_USEFUL_QUOTES_ENABLED']!=='1')return {env:original,heldEnv:held,current:()=>true,diagnostic};
 try{
  if(platform()!=='darwin'||typeof process.getuid!=='function')return fail();
  const info=userInfo(),uid=BigInt(process.getuid());if(BigInt(info.uid)!==uid||!isAbsolute(info.homedir)||realpathSync(info.homedir)!==info.homedir)return fail();
  const path=join(info.homedir,'Library','LaunchAgents',JOB+'.plist'),parent=dirname(path),p=lstatSync(parent,{bigint:true});
  if(realpathSync(parent)!==parent||!p.isDirectory()||p.uid!==uid||(p.mode&0o022n)!==0n)return fail();
  const parentStamp=[p.dev,p.ino,p.mode,p.uid,p.gid].map(String).join('|');
  const read=()=>{
   const a=lstatSync(path,{bigint:true});if(realpathSync(path)!==path||!a.isFile()||a.nlink!==1n||a.uid!==uid||(a.mode&0o022n)!==0n||a.size<1n||a.size>65536n)return fail();
   const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{if(signature(fstatSync(fd,{bigint:true}))!==signature(a))return fail();const raw=readBoundedStableFd(fd,65536);if(signature(fstatSync(fd,{bigint:true}))!==signature(a)||signature(lstatSync(path,{bigint:true}))!==signature(a))return fail();return {raw,stamp:signature(a),hash:sha(raw)};}finally{closeSync(fd);}
  };
  const first=read();
  const unchanged=()=>{const z=lstatSync(parent,{bigint:true});if(realpathSync(parent)!==parent||[z.dev,z.ino,z.mode,z.uid,z.gid].map(String).join('|')!==parentStamp)return fail();const x=read();if(x.stamp!==first.stamp||x.hash!==first.hash||!x.raw.equals(first.raw))return fail();};
  const doc:unknown=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:first.raw,timeout:1000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C'}}).toString('utf8'));
  unchanged();const source=validateCurrentQuoteReference(doc,loaded);unchanged();
  const env=Object.freeze({...loaded,[SOURCE]:source});status='CURRENT_OWNER_CONFIGURATION';stale=source!==loaded[SOURCE];
  const current=()=>{if(status!=='CURRENT_OWNER_CONFIGURATION')return false;try{unchanged();return true;}catch{status='CHANGED_CONFIGURATION_STICKY_STOP';return false;}};
  return {env,heldEnv:held,current,diagnostic};
 }catch{status='HELD_CONFIGURATION_UNVERIFIED';return {env:held,heldEnv:held,current:()=>false,diagnostic};}
}

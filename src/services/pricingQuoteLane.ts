// Existing budgets/backoff/cooldown remain binding. Default OFF does no file I/O.
import { constants, existsSync, fstatSync, openSync, closeSync, readFileSync, mkdirSync, fsyncSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_COMPETITORS } from './coreCompetitorTargets';
import { readRmsQuoteRequest } from './rmsQuoteRequest';
import { planUsefulQuoteRefresh, type UsefulQuoteState } from './usefulQuoteRefreshPlanner';
import type { MarketRefreshPropertyTarget } from './marketRefreshTargetUniverse';
import { MAX_TARGETS_PER_PROPERTY_PER_RUN, type RotatingCaps, type RotatingDemandConfig, type RotatingTarget } from './rotatingCollectionScopePlanner';
const ROOT='.data/run-state/pricing-quote-attempts';
interface Reservation { kind:'QUOTE_REQUEST_RESERVED_V1'; source:'booking'; propertySlug:string; stayDate:string; attemptAt:string }
const jstDate=(ms:number)=>new Date(ms+9*3600000).toISOString().slice(0,10);
const valid=(r:Reservation)=>r?.kind==='QUOTE_REQUEST_RESERVED_V1'&&r.source==='booking'&&/^[a-z0-9-]{1,120}$/u.test(r.propertySlug)
 &&/^\d{4}-\d{2}-\d{2}$/u.test(r.stayDate)&&new Date(r.stayDate+'T00:00:00Z').toISOString().slice(0,10)===r.stayDate
 &&typeof r.attemptAt==='string'&&/(Z|[+-]\d\d:\d\d)$/u.test(r.attemptAt)&&Number.isFinite(Date.parse(r.attemptAt))
 &&Object.keys(r).sort().join('|')==='attemptAt|kind|propertySlug|source|stayDate';

/** Includes failed/crashed request reservations, not just successful history appends. No quote outcome is inferred. */
export function readQuoteReservations(now:string,root=ROOT):Reservation[]{
 const current=Date.parse(now);if(!Number.isFinite(current))throw Error('QUOTE_ATTEMPT_TIME');
 const rows:Reservation[]=[];
 for(let days=0;days<3;days++){
  const path=join(root,jstDate(current-days*86400000)+'.jsonl');if(!existsSync(path))continue;
  let fd:number|undefined;
  try{
   fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const before=fstatSync(fd,{bigint:true});
   if(!before.isFile()||before.size>1024n*1024n)throw Error('BUDGET');
   const bytes=readFileSync(fd),after=fstatSync(fd,{bigint:true});
   if(bytes.length>1024*1024||before.size!==after.size||before.mtimeNs!==after.mtimeNs)throw Error('CHANGED');
   for(const line of bytes.toString('utf8').split('\n')){
    if(!line)continue;if(line.length>1024||rows.length>=20000)throw Error('BUDGET');
    const r=JSON.parse(line) as Reservation;if(!valid(r)||Date.parse(r.attemptAt)>current)throw Error('SCHEMA');
    if(current-Date.parse(r.attemptAt)<=48*3600000)rows.push(r);
   }
  }catch{throw Error('QUOTE_ATTEMPT_STATE_UNVERIFIED');}finally{if(fd!==undefined)closeSync(fd);}
 }
 return rows;
}

export function reserveQuoteRequest(target:RotatingTarget,at:string,root=ROOT):void{
 const row:Reservation={kind:'QUOTE_REQUEST_RESERVED_V1',source:'booking',propertySlug:target.property_slug,stayDate:target.stay_date,attemptAt:at};
 if(target.source!=='booking'||!valid(row))throw Error('QUOTE_ATTEMPT_SCOPE');
 mkdirSync(root,{recursive:true,mode:0o700});const fd=openSync(join(root,jstDate(Date.parse(at))+'.jsonl'),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 try{const bytes=Buffer.from(JSON.stringify(row)+'\n');if(writeSync(fd,bytes)!==bytes.length)throw Error('QUOTE_ATTEMPT_PARTIAL_WRITE');fsyncSync(fd);}finally{closeSync(fd);}
}

export function resolvePricingQuoteLane(env:Record<string,string|undefined>,input:{
 now:string;runDate:string;legacyTargets:RotatingTarget[];caps:RotatingCaps;config:RotatingDemandConfig;
 properties:readonly MarketRefreshPropertyTarget[];lastCollectedAt:ReadonlyMap<string,string>;reservationRoot?:string;
}){
 const disabled={enabled:false,status:'DISABLED',targets:input.legacyTargets,diagnostics:null,reserve:undefined};
 if(env['ZMI_USEFUL_QUOTES_ENABLED']!=='1')return disabled;
 try{
  if(env['ZMI_RATE_CELL_EVIDENCE_ENABLED']!=='1'||!env['ZMI_RMS_QUOTE_REQUEST_PATH'])throw Error('INPUT');
  const request=readRmsQuoteRequest(env['ZMI_RMS_QUOTE_REQUEST_PATH'],input.now,{releaseGitSha:env['ZMI_RMS_QUOTE_SOURCE_RELEASE']??'',bundleSha256:env['ZMI_RMS_QUOTE_BUNDLE_SHA256']??'',graphSha256:env['ZMI_RMS_QUOTE_GRAPH_SHA256']??''});
  // These are existing verified collection mappings, not assertions of room comparability or independent ownership.
  const slugs=new Set([...CORE_COMPETITORS.map(p=>p.bookingSlug),'xi-raku','rurikura-resort']);
  const properties=input.properties.filter(p=>p.source==='booking'&&slugs.has(p.property_slug)),states=new Map<string,UsefulQuoteState>();
  const needs=new Set(request.needs.map(n=>n.stayDate));
  const set=(slug:string,date:string,at:string)=>{
   if(!slugs.has(slug)||!needs.has(date))return;
   const key='booking|'+slug+'|'+date,old=states.get(key);
   if(!old||Date.parse(old.lastAttemptAt!)<Date.parse(at))states.set(key,{source:'booking',propertySlug:slug,stayDate:date,lastAttemptAt:at,lastUsableAt:null,usableBasisVersion:null,retryAfter:null});
  };
  for(const [key,at]of input.lastCollectedAt){const [source,slug,date]=key.split('|');if(source==='booking'&&slug&&date)set(slug,date,at);}
  for(const r of readQuoteReservations(input.now,input.reservationRoot))set(r.propertySlug,r.stayDate,r.attemptAt);
  const plan=planUsefulQuoteRefresh({now:input.now,runDate:input.runDate,needs:request.needs,properties,states:[...states.values()],basisVersion:'UNCLASSIFIED_SELECTED_RATE_V2',caps:input.caps,lanePages:input.caps.total_pages_per_run,freshHours:36,farDeadlineHours:168,maxPerProperty:Math.min(MAX_TARGETS_PER_PROPERTY_PER_RUN,input.caps.total_pages_per_run),config:input.config});
  // Preserve the existing ordinary per-property cap; this lane does not inherit the separate winter quota exception.
  const targets=plan.selected;
  const allowed=new Set(targets.map(t=>t.source+'|'+t.property_slug+'|'+t.stay_date));
  const reserved=new Set<string>();
  const reserve=(target:RotatingTarget,at:string)=>{const key=target.source+'|'+target.property_slug+'|'+target.stay_date;
   if(!allowed.has(key)||reserved.has(key)||!Number.isFinite(Date.parse(at))||Date.parse(at)<Date.parse(input.now)||Date.parse(at)>=Date.parse(request.expiresAt))throw Error('QUOTE_ATTEMPT_NOT_SELECTED_OR_EXPIRED');
   reserveQuoteRequest(target,at,input.reservationRoot);reserved.add(key);};
  return {enabled:true,status:'READY',targets,reserve,diagnostics:{...plan,selected:targets,selectedAfterPropertyCap:targets.length,requestSha256:request.requestSha256,source:request.source,eligibleDates:request.needs.filter(n=>n.priceDecisionEligible).length,usableQuoteAssertions:0,priceAuthority:false}};
 }catch{return {enabled:true,status:'HELD_UNVERIFIED_INPUT_OR_ATTEMPT_STATE',targets:[] as RotatingTarget[],diagnostics:null,reserve:undefined};}
}

export function quoteSelectionMetrics(targets:readonly RotatingTarget[]){
 const count=(by:(t:RotatingTarget)=>string)=>{const m:Record<string,number>={};for(const t of targets)m[by(t)]=(m[by(t)]??0)+1;return m;};
 const distinct=Object.fromEntries(['booking','jalan'].map(s=>[s,new Set(targets.filter(t=>t.source===s).map(t=>t.property_slug)).size]));
 return {booking_pages:targets.filter(t=>t.source==='booking').length,jalan_pages:targets.filter(t=>t.source==='jalan').length,planned_requests:targets.length,planned_requests_after:targets.length,
 selected_targets_by_source:count(t=>t.source),selected_targets_by_bucket:count(t=>t.bucket),selected_targets_by_tier:count(t=>t.tier),selected_distinct_properties_by_source:distinct,selected_distinct_stay_dates:new Set(targets.map(t=>t.stay_date)).size,selected_targets_by_property:count(t=>t.source+'|'+t.property_slug),
 near_term_dense_selected_count:targets.filter(t=>t.reason_codes.includes('near_term_dense')).length,ordinary_weekday_near_term_selected_count:targets.filter(t=>t.reason_codes.includes('near_term_dense')&&t.reason_codes.includes('ordinary_weekday')).length,forced_checkin_selected_count:targets.filter(t=>t.reason_codes.includes('forced_checkin_date')).length,
 winter_lane_selected:targets.filter(t=>t.winter_lane!==undefined).length,property_diversity_warning:Object.entries(distinct).filter(([,n])=>n>0&&n<3).map(([s,n])=>s+'_distinct_properties_lt_3:'+n)};
}

import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync,mkdtempSync,writeFileSync,mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../src/services/marketEvidenceSidecar';
import { resolvePricingQuoteLane,readQuoteReservations,quoteSelectionMetrics } from '../src/services/pricingQuoteLane';
import { ROTATING_CAPS,type RotatingDemandConfig,type RotatingTarget } from '../src/services/rotatingCollectionScopePlanner';
import type { MarketRefreshPropertyTarget } from '../src/services/marketRefreshTargetUniverse';
const at='2026-10-25T00:00:00.000Z',config:RotatingDemandConfig={public_holidays:{},long_weekend_dates:new Set(),peak_periods:[]};
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'pricing-quote-lane-')),path=join(dir,'request.json'),root=join(dir,'attempts');
 const source={runId:'k27run_2026-10-25_1234abcd',releaseGitSha:'a'.repeat(40),bundleSha256:'b'.repeat(64),graphSha256:'c'.repeat(64),evidenceSha256:'d'.repeat(64),observedAt:at};
 const body={kind:'K27_MARKET_QUOTE_REQUEST_V1',propertyId:'330695',createdAt:at,expiresAt:'2026-10-26T12:00:00Z',source,needs:['2026-11-01','2027-10-25','2029-07-20'].map(stayDate=>({stayDate,admittedAt:'2026-10-01T00:00:00Z',priceDecisionEligible:true,decisionImpact:0.5,changedAt:null,dateEvidenceSha256:'e'.repeat(64)}))};
 writeFileSync(path,JSON.stringify({...body,requestSha256:createHash('sha256').update(canonicalJson(body)).digest('hex')}));
 const env={ZMI_USEFUL_QUOTES_ENABLED:'1',ZMI_RATE_CELL_EVIDENCE_ENABLED:'1',ZMI_RMS_QUOTE_REQUEST_PATH:path,ZMI_RMS_QUOTE_SOURCE_RELEASE:source.releaseGitSha,ZMI_RMS_QUOTE_BUNDLE_SHA256:source.bundleSha256,ZMI_RMS_QUOTE_GRAPH_SHA256:source.graphSha256};
 const properties:MarketRefreshPropertyTarget[]=['hammond-takamiya','onsen-amp-stay-oakhill','rurikura-resort','xi-raku','unapproved'].map(property_slug=>({source:'booking',canonical_property_name:'fixture',property_slug,tier:'tier_direct_mid',enabled_for_live:true,verified_mapping:true,verification_note:'fixture'}));
 const input={now:at,runDate:'2026-10-25',legacyTargets:[] as RotatingTarget[],caps:ROTATING_CAPS,config,properties,lastCollectedAt:new Map<string,string>(),reservationRoot:root};
 return {dir,path,root,env,input};
}
it('default OFF leaves legacy selection identical and never creates attempt storage',()=>{
 const f=setup(),legacy=[{property_slug:'legacy'}] as RotatingTarget[];
 const result=resolvePricingQuoteLane({}, {...f.input,legacyTargets:legacy});
 expect(result.targets).toBe(legacy);expect(result.enabled).toBe(false);expect(existsSync(f.root)).toBe(false);
});
it('connects actual far-date needs to existing verified mappings while preserving source/total/property caps',()=>{
 const f=setup(),p=resolvePricingQuoteLane(f.env,f.input),metrics=quoteSelectionMetrics(p.targets);
 expect(p.status).toBe('READY');expect(p.targets.some(t=>t.stay_date>'2027-03-31')).toBe(true);
 for(const target of p.targets)p.reserve!(target,at);
 const rotated=resolvePricingQuoteLane(f.env,f.input);expect(rotated.targets.some(t=>t.stay_date==='2029-07-20')).toBe(true);
 expect(p.targets.some(t=>t.property_slug==='unapproved'||t.source!=='booking')).toBe(false);
 expect(p.targets.length).toBeLessThanOrEqual(ROTATING_CAPS.total_pages_per_run);
 expect(metrics.booking_pages).toBeLessThanOrEqual(ROTATING_CAPS.booking_pages_per_run);
 expect(Math.max(...Object.values(metrics.selected_targets_by_property))).toBeLessThanOrEqual(2);
 expect(p.diagnostics?.usableQuoteAssertions).toBe(0);expect(p.diagnostics?.priceAuthority).toBe(false);
 expect(existsSync(f.root)).toBe(true);
});
it('persists a pre-request reservation so a failed/crashed request still has cooldown; never records a usable price',()=>{
 const f=setup(),p=resolvePricingQuoteLane(f.env,f.input),target=p.targets[0]!;
 p.reserve!(target,at);expect(readQuoteReservations(at,f.root)).toHaveLength(1);
 expect(p.reserve!(target,at)).toBe(false);
 const next=resolvePricingQuoteLane(f.env,f.input);
 expect(next.targets.some(t=>t.property_slug===target.property_slug&&t.stay_date===target.stay_date)).toBe(false);
 expect(next.diagnostics?.usableQuoteAssertions).toBe(0);
 const text=JSON.stringify(readQuoteReservations(at,f.root));expect(text).not.toMatch(/price|guest|bookingId|token|url/i);
});

it('two plans resolved before either request cannot reserve the same pair within 24h',()=>{
 const f=setup(),first=resolvePricingQuoteLane(f.env,f.input),second=resolvePricingQuoteLane(f.env,f.input),target=first.targets[0]!;
 expect(first.reserve!(target,at)).toBe(true);expect(second.reserve!(target,at)).toBe(false);
 expect(readQuoteReservations(at,f.root)).toHaveLength(1);
});

it('two fresh processes racing the same request create at most one persisted reservation',async()=>{
 const f=setup(),plan=resolvePricingQuoteLane(f.env,f.input),target=plan.targets[0]!;
 const moduleUrl=new URL('../src/services/pricingQuoteLane.ts',import.meta.url).href;
 const code=`import {reserveQuoteRequest} from ${JSON.stringify(moduleUrl)};console.log('READY');await new Promise(r=>process.stdin.once('data',r));console.log(JSON.stringify({ok:reserveQuoteRequest(${JSON.stringify(target)},${JSON.stringify(at)},${JSON.stringify(f.root)})}));`;
 const start=()=>{
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{stdio:['pipe','pipe','pipe']});let output='',error='';
  const ready=new Promise<void>((resolve,reject)=>{child.stdout.on('data',b=>{output+=b;if(output.includes('READY'))resolve();});child.once('error',reject);child.once('exit',c=>{if(!output.includes('READY'))reject(Error('fixture child failed '+c));});});
  child.stderr.on('data',b=>{error+=b;});
  const done=new Promise<boolean>((resolve,reject)=>child.once('exit',c=>{if(c!==0)reject(Error('fixture child failed '+error));else resolve(JSON.parse(output.trim().split('\n').at(-1)!).ok);}));
  return {child,ready,done};
 };
 const first=start(),second=start();await Promise.all([first.ready,second.ready]);first.child.stdin.end('go');second.child.stdin.end('go');
 expect((await Promise.all([first.done,second.done])).filter(Boolean)).toHaveLength(1);expect(readQuoteReservations(at,f.root)).toHaveLength(1);
});

it('an existing unresolved lock is preserved and causes no network reservation',()=>{
 const f=setup(),plan=resolvePricingQuoteLane(f.env,f.input),target=plan.targets[0]!,lockDir=join(f.root,'locks');
 mkdirSync(lockDir,{recursive:true});const key='booking|'+target.property_slug+'|'+target.stay_date,lock=join(lockDir,createHash('sha256').update(key).digest('hex')+'.lock');writeFileSync(lock,'UNRESOLVED_OTHER_OWNER');
 expect(plan.reserve!(target,at)).toBe(false);expect(existsSync(lock)).toBe(true);expect(readQuoteReservations(at,f.root)).toEqual([]);
});
it('invalid exact-source input or corrupt request state holds only this collection lane with zero targets',()=>{
 const f=setup();expect(resolvePricingQuoteLane({...f.env,ZMI_RMS_QUOTE_SOURCE_RELEASE:'f'.repeat(40)},f.input).targets).toEqual([]);
 const p=resolvePricingQuoteLane(f.env,f.input);p.reserve!(p.targets[0]!,at);
 writeFileSync(join(f.root,'2026-10-25.jsonl'),'PARTIAL_UNVERIFIED\n');
 const held=resolvePricingQuoteLane(f.env,f.input);expect(held.status).toBe('HELD_UNVERIFIED_INPUT_OR_ATTEMPT_STATE');expect(held.targets).toEqual([]);
});
it('does not reserve an unselected or expired request and distinguishes selection counts from legacy diagnostics',()=>{
 const f=setup(),p=resolvePricingQuoteLane(f.env,f.input);
 expect(()=>p.reserve!({...p.targets[0]!,stay_date:'2030-01-01'},at)).toThrow('NOT_SELECTED');
 expect(()=>p.reserve!(p.targets[0]!,'2026-10-26T12:00:00Z')).toThrow('EXPIRED');
 const m=quoteSelectionMetrics(p.targets);expect(m.planned_requests).toBe(p.targets.length);expect(m.winter_lane_selected).toBe(0);
});

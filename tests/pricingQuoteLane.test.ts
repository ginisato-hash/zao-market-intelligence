import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync,mkdtempSync,writeFileSync } from 'node:fs';
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
 expect(()=>p.reserve!(target,at)).toThrow(/NOT_SELECTED_OR_EXPIRED/);
 const next=resolvePricingQuoteLane(f.env,f.input);
 expect(next.targets.some(t=>t.property_slug===target.property_slug&&t.stay_date===target.stay_date)).toBe(false);
 expect(next.diagnostics?.usableQuoteAssertions).toBe(0);
 const text=JSON.stringify(readQuoteReservations(at,f.root));expect(text).not.toMatch(/price|guest|bookingId|token|url/i);
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

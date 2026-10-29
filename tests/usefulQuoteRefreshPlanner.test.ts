import {expect,it} from 'vitest';
import {planUsefulQuoteRefresh,type PricingQuoteNeed,type UsefulQuoteState} from '../src/services/usefulQuoteRefreshPlanner';
import {ROTATING_CAPS,type RotatingDemandConfig} from '../src/services/rotatingCollectionScopePlanner';
import type {MarketRefreshPropertyTarget} from '../src/services/marketRefreshTargetUniverse';
const config:RotatingDemandConfig={public_holidays:{},long_weekend_dates:new Set(),peak_periods:[]};
const property:MarketRefreshPropertyTarget={source:'booking',canonical_property_name:'fixture',property_slug:'fixture',tier:'tier_direct_mid',enabled_for_live:true,verified_mapping:true,verification_note:'fixture only'};
const need=(date:string):PricingQuoteNeed=>({stayDate:date,admittedAt:'2026-10-01T00:00:00Z',priceDecisionEligible:true,decisionImpact:0.5,changedAt:null});
const input=()=>({now:'2026-10-25T19:00:00+09:00',runDate:'2026-10-25',needs:[need('2026-11-01'),need('2027-10-25'),need('2029-07-20')],properties:[property],states:[] as UsefulQuoteState[],basisVersion:'fixture-v1',caps:ROTATING_CAPS,lanePages:3,freshHours:36,farDeadlineHours:168,config});
it('uses actual admitted far dates without 30/90/240/Q1 cutoffs and never requests a non-admitted date',()=>{
 const p=planUsefulQuoteRefresh(input());expect(new Set(p.selected.map(t=>t.stay_date))).toEqual(new Set(['2026-11-01','2027-10-25','2029-07-20']));expect(p.requestsExecuted).toBe(0);
});
it('caps each source and total, ignores unverified/disabled sources and ineligible dates',()=>{
 const i=input();i.caps={...ROTATING_CAPS,total_pages_per_run:2,booking_pages_per_run:1};i.lanePages=2;i.properties=[property,{...property,source:'jalan'},{...property,source:'rakuten'},{...property,property_slug:'unverified',verified_mapping:false}];i.needs.push({...need('2027-05-01'),priceDecisionEligible:false});
 const p=planUsefulQuoteRefresh(i);expect(p.selected.length).toBe(2);expect(p.selectedBySource).toEqual({booking:1,jalan:1});expect(p.selected.some(x=>x.property_slug==='unverified'||x.stay_date==='2027-05-01')).toBe(false);
});
it('a failed or condition-incomplete attempt is still cooldown, never a usable quote or sold-out fact',()=>{
 const i=input();i.states=[{source:'booking',propertySlug:'fixture',stayDate:'2027-10-25',lastAttemptAt:'2026-10-25T09:00:00Z',lastUsableAt:null,usableBasisVersion:null,retryAfter:null}];
 const p=planUsefulQuoteRefresh(i);expect(p.selected.some(t=>t.stay_date==='2027-10-25')).toBe(false);expect(p.excluded.EXISTING_24H_REQUEST_COOLDOWN).toBe(1);
});
it('reuses only fresh matching comparison basis, honors retry-after, and invalidates the cache after changed evidence',()=>{
 const i=input();i.states=[{source:'booking',propertySlug:'fixture',stayDate:'2027-10-25',lastAttemptAt:'2026-10-24T00:00:00Z',lastUsableAt:'2026-10-24T00:00:00Z',usableBasisVersion:'fixture-v1',retryAfter:null},{source:'booking',propertySlug:'fixture',stayDate:'2029-07-20',lastAttemptAt:null,lastUsableAt:null,usableBasisVersion:null,retryAfter:'2026-10-26T00:00:00Z'}];
 expect(planUsefulQuoteRefresh(i).selected.map(t=>t.stay_date)).toEqual(['2026-11-01']);i.needs[1]!.changedAt='2026-10-24T06:00:00Z';expect(planUsefulQuoteRefresh(i).selected.some(t=>t.stay_date==='2027-10-25')).toBe(true);
});
it('one overdue far request is reserved and failed early keys do not starve never-attempted far keys',()=>{
 const i=input();i.lanePages=1;i.states=[{source:'booking',propertySlug:'fixture',stayDate:'2027-10-25',lastAttemptAt:'2026-10-23T00:00:00Z',lastUsableAt:null,usableBasisVersion:null,retryAfter:null}];
 expect(planUsefulQuoteRefresh(i).selected[0]!.stay_date).toBe('2029-07-20');
});
it('zero source capacity is not reported as feasible far coverage',()=>{
 const i=input();i.caps={...ROTATING_CAPS,booking_pages_per_run:0};const p=planUsefulQuoteRefresh(i);expect(p.selected).toEqual([]);expect(p.farMinimumCycleHours).toBeNull();expect(p.farDeadlineCapacityFeasible).toBe(false);
});
it('rejects ambiguous/future evidence and invalid dates before producing a plan',()=>{
 expect(()=>planUsefulQuoteRefresh({...input(),needs:[need('2027-13-01')]})).toThrow('INVALID');
 expect(()=>planUsefulQuoteRefresh({...input(),needs:[need('2027-01-01'),need('2027-01-01')]})).toThrow('AMBIGUOUS');
 const i=input();i.states=[{source:'booking',propertySlug:'fixture',stayDate:'2027-10-25',lastAttemptAt:'2026-10-26T00:00:00Z',lastUsableAt:null,usableBasisVersion:null,retryAfter:null}];expect(()=>planUsefulQuoteRefresh(i)).toThrow('FUTURE');
});

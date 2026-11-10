import {describe,it,expect} from 'vitest';
import {buildRegionalRegistry,type RegionalProperty} from '../src/services/regionalMarketRegistry';
import {REGIONAL_OFFICIAL_DISCOVERY} from '../src/services/regionalOfficialDiscovery';
import {planRegionalQuoteRotation} from '../src/services/regionalQuoteRotation';
import {type RotatingCaps,type RotatingTarget} from '../src/services/rotatingCollectionScopePlanner';
import type {UsefulQuoteState} from '../src/services/usefulQuoteRefreshPlanner';
import {OBSERVED_LISTING_RELATIVE_V1} from '../src/services/observedListingRelative';
const caps:RotatingCaps={total_pages_per_run:4,booking_pages_per_run:4,jalan_pages_per_run:0,rakuten_pages_per_run:0,google_hotels_pages_per_run:0};
const date='2026-10-29',now=date+'T00:00:00Z';
const needs=['2026-11-01','2027-02-14','2028-11-01'].map(d=>({stayDate:d,admittedAt:'2026-10-01T00:00:00Z',priceDecisionEligible:false,decisionImpact:d==='2026-11-01'?1:0,changedAt:null}));
const property=(i:number):RegionalProperty=>({physicalId:'p'+i,canonicalName:'regional-non-primary-'+i,aliases:[],category:'pension',regionVersion:'region-v1',regionStatus:'EXISTING_VERIFIED_REGION',regionEvidence:['already-verified-source'],own:false,businessStatus:'UNKNOWN',twoPerson:'UNKNOWN',mappings:[{source:'booking',canonical_property_name:'regional-non-primary-'+i,property_slug:'new-property-'+i,tier:'tier_monitor_only',enabled_for_live:true,verified_mapping:true,verification_note:'verified'}],identityPending:[],primarySource:'booking',unavailableReason:null});
const base=()=>({now,runDate:date,registry:Array.from({length:9},(_,i)=>property(i)),needs,states:[] as UsefulQuoteState[],caps,config:{public_holidays:{},long_weekend_dates:new Set<string>(),peak_periods:[]},legacyProtected:[] as RotatingTarget[],coverageFraction:0.5,freshHours:36,farDeadlineHours:168});
describe('same-stay decision groups inside existing regional quotas',()=>{
 const grouped=()=>({...base(),caps:{...caps,total_pages_per_run:12,booking_pages_per_run:12},minComparisonProperties:3,needs:[...needs,{...needs[0]!,stayDate:'2027-01-10',priceDecisionEligible:true}]});
 it('retains broad reception and far coverage while reserving a full minProperties decision group',()=>{
  const p=planRegionalQuoteRotation(grouped()),group=p.selected.filter(t=>t.stay_date==='2027-01-10');
  expect(p.collectionDateUniverse).toBe(4);expect(p.coverageSelected).toBe(p.coverageReserved);expect(p.coverageSelected).toBe(6);
  expect(new Set(group.map(t=>t.property_slug)).size).toBeGreaterThanOrEqual(3);expect(p.decisionGroups[0]?.stayDate).toBe('2027-01-10');
  expect(p.selected.some(t=>t.stay_date==='2028-11-01'||t.stay_date==='2027-02-14')).toBe(true);expect(p.selected.length).toBeLessThanOrEqual(12);
  for(const slug of new Set(p.selected.map(t=>t.property_slug)))expect(p.selected.filter(t=>t.property_slug===slug).length).toBeLessThanOrEqual(2);
 });
 it('revisits valid first anchors after24h without discarding fresh evidence or increasing quota',()=>{
  const x=grouped(),date='2027-01-10',anchor=new Date(Date.parse(now)-25*3600000).toISOString();
  x.states=[0,1,2].map(n=>({source:'booking',propertySlug:'new-property-'+n,stayDate:date,lastAttemptAt:anchor,lastUsableAt:anchor,usableBasisVersion:OBSERVED_LISTING_RELATIVE_V1,retryAfter:null,comparisonRequired:true}));
  const p=planRegionalQuoteRotation(x);expect(p.selected.filter(t=>t.stay_date===date&&t.reason_codes.includes('LISTING_COMPARISON_REVISIT'))).toHaveLength(3);
  expect(p.decisionGroups[0]?.comparisonRevisits).toBe(3);expect(p.coverageSelected).toBe(6);expect(p.usableListingObservations).toBe(3);expect(p.successPairsRecorded).toBe(0);
 });
 it('does not bypass24h cooldown for a comparison anchor',()=>{
  const x=grouped(),recent=new Date(Date.parse(now)-24*3600000+1).toISOString();
  x.states=[{source:'booking',propertySlug:'new-property-0',stayDate:'2027-01-10',lastAttemptAt:recent,lastUsableAt:recent,usableBasisVersion:OBSERVED_LISTING_RELATIVE_V1,retryAfter:null,comparisonRequired:true}];
  const p=planRegionalQuoteRotation(x);expect(p.selected.some(t=>t.property_slug==='new-property-0'&&t.stay_date==='2027-01-10')).toBe(false);expect(p.excluded.EXISTING_24H_REQUEST_COOLDOWN).toBeGreaterThan(0);
 });
 it('fills a partial same-date anchor group without repeating its still-cooled observations',()=>{
  const x=grouped(),recent=new Date(Date.parse(now)-2*3600000).toISOString();
  x.states=[0,1].map(n=>({source:'booking',propertySlug:'new-property-'+n,stayDate:'2027-01-10',lastAttemptAt:recent,lastUsableAt:recent,usableBasisVersion:OBSERVED_LISTING_RELATIVE_V1,retryAfter:null,comparisonRequired:true}));
  const p=planRegionalQuoteRotation(x),g=p.decisionGroups.find(g=>g.stayDate==='2027-01-10');expect(g?.knownUsableProperties).toBe(2);expect(g?.selectedProperties.length).toBeGreaterThanOrEqual(1);expect(g?.selectedProperties.some(s=>s==='new-property-0'||s==='new-property-1')).toBe(false);
 });
});
describe('regional Booking-primary registry and fair rotation',()=>{
 it('retains official/unknown/unmapped/own facilities rather than declaring complete from OTA mappings',()=>{const r=buildRegionalRegistry([REGIONAL_OFFICIAL_DISCOVERY]);expect(r.counts.registeredCandidates).toBeGreaterThan(40);expect(r.properties.some(p=>p.canonicalName==='Forest Inn SANGORO')).toBe(true);expect(r.properties.some(p=>p.canonicalName==='JURIN')).toBe(true);expect(r.properties.filter(p=>p.own).length).toBeGreaterThan(0);expect(r.allLegalFacilitiesDiscovered).toBe(false);expect(r.counts.twoPersonVerified).toBe(0);});
 it('selects non-primary Booking properties even if all other OTA caps are zero',()=>{const p=planRegionalQuoteRotation(base());expect(p.selected.length).toBe(4);expect(p.selected.every(t=>t.source==='booking'&&t.property_slug.startsWith('new-property-'))).toBe(true);expect(p.otherOtaRequired).toBe(false);});
 it('all available properties receive coverage despite repeated adaptive urgency at the first property',()=>{const x=base(),seen=new Set<string>();for(let k=0;k<7;k++){x.now=new Date(Date.parse(now)+k*2*3600000).toISOString();const p=planRegionalQuoteRotation(x);for(const t of p.selected){seen.add(t.property_slug);x.states.push({source:'booking',propertySlug:t.property_slug,stayDate:t.stay_date,lastAttemptAt:x.now,lastUsableAt:null,usableBasisVersion:null,retryAfter:null});}}expect(seen.size).toBe(9);});
 it('does not cutoff 2028 reception dates when price authority is false',()=>{const p=planRegionalQuoteRotation({...base(),needs:[needs[2]!]});expect(p.selected.every(t=>t.stay_date==='2028-11-01')).toBe(true);expect(p.selected.length).toBeGreaterThan(0);expect(p.priceAuthority).toBe(false);});
 it('a failed attempt consumes cooldown, never becomes a successful/fresh quote',()=>{const x=base();x.registry=[property(0)];x.needs=[needs[0]!];x.states=[{source:'booking',propertySlug:'new-property-0',stayDate:needs[0]!.stayDate,lastAttemptAt:now,lastUsableAt:null,usableBasisVersion:null,retryAfter:null}];const p=planRegionalQuoteRotation(x);expect(p.selected).toHaveLength(0);expect(p.successPairsRecorded).toBe(0);});
 it('honors source retryAfter and zero cap without an alternate OTA dependency',()=>{const x=base();x.registry=[property(0)];x.states=x.needs.map(n=>({source:'booking',propertySlug:'new-property-0',stayDate:n.stayDate,lastAttemptAt:null,lastUsableAt:null,usableBasisVersion:null,retryAfter:'2026-10-30T00:00:00Z'}));expect(planRegionalQuoteRotation(x).selected).toHaveLength(0);expect(planRegionalQuoteRotation({...base(),caps:{...caps,booking_pages_per_run:0}}).selected).toHaveLength(0);});
 it('never targets a guessed mapping, pending region or no valid 2P product',()=>{const x=base();x.registry[0]!.primarySource=null;x.registry[1]!.regionStatus='REGION_PENDING';x.registry[2]!.twoPerson='NO_VALID_2P_PRODUCT';const p=planRegionalQuoteRotation(x);expect(p.selected.some(t=>['new-property-0','new-property-1','new-property-2'].includes(t.property_slug))).toBe(false);expect(p.registryDenominator).toBe(9);});
 it('protects an existing own monitoring allocation within the same total/source budget',()=>{const target=planRegionalQuoteRotation(base()).selected[0]!;const p=planRegionalQuoteRotation({...base(),legacyProtected:[{...target,property_slug:'xi-raku'}]});expect(p.selected[0]!.property_slug).toBe('xi-raku');expect(p.selected.length).toBeLessThanOrEqual(4);expect(p.coverageSelected).toBeGreaterThan(0);});
 it('does not claim successful revisit deadlines without a measured success rate',()=>{const p=planRegionalQuoteRotation(base());expect(p.firstSuccessfulPassHours).toBeNull();expect(p.deadlinePromise).toBe('NOT_ESTABLISHED');expect(p.theoreticalFirstPassRuns).toBe(5);});
 it('unknown product state and sold-out state do not remove the property from denominators',()=>{const p=planRegionalQuoteRotation(base());expect(p.bookingCollectableProperties).toBe(9);expect(p.registryDenominator).toBe(9);expect(p.allFacilitiesCollected).toBe(false);});
});

// Existing scheduler/caps/24h reservation route; all verified regional Booking properties, not CORE/PRIMARY five.
import {planUsefulQuoteRefresh,type UsefulQuoteState,type PricingQuoteNeed} from './usefulQuoteRefreshPlanner';
import {type RegionalProperty} from './regionalMarketRegistry';
import {type RotatingCaps,type RotatingDemandConfig,type RotatingTarget,MAX_TARGETS_PER_PROPERTY_PER_RUN} from './rotatingCollectionScopePlanner';
import {OBSERVED_LISTING_RELATIVE_V1} from './observedListingRelative';
const at=(s:string|null)=>s===null?-Infinity:Date.parse(s);
const stratum=(d:string,run:string)=>[bucket(d,run),d.slice(0,7),new Date(d+'T00:00:00Z').getUTCDay()].join('|');
const bucket=(d:string,run:string)=>{const days=(Date.parse(d)-Date.parse(run))/86400000;return days<=14?'short':days<=90?'mid':'long';};
export function planRegionalQuoteRotation(input:{now:string;runDate:string;registry:readonly RegionalProperty[];needs:readonly PricingQuoteNeed[];
 states:readonly UsefulQuoteState[];caps:RotatingCaps;config:RotatingDemandConfig;legacyProtected:readonly RotatingTarget[];coverageFraction:number;freshHours:number;farDeadlineHours:number;minComparisonProperties?:number}){
 if(input.registry.length>1000||new Set(input.registry.map(p=>p.physicalId)).size!==input.registry.length||!Number.isFinite(input.coverageFraction)||input.coverageFraction<=0||input.coverageFraction>1)throw Error('REGIONAL_ROTATION_INPUT');
 const book=input.registry.filter(p=>!p.own&&p.primarySource==='booking'&&p.regionStatus!=='REGION_PENDING'&&p.twoPerson!=='NO_VALID_2P_PRODUCT'&&!p.identityPending.includes('MULTIPLE_SOURCE_IDENTITIES'));
 const properties=book.flatMap(p=>p.mappings.filter(t=>t.source==='booking'));
 // Actual reception scope is a collection scope, not a price grant. Unsupported-baseline dates remain observable.
 const needs=input.needs.map(n=>({...n,priceDecisionEligible:true}));
 const plan=planUsefulQuoteRefresh({now:input.now,runDate:input.runDate,properties,needs,states:input.states,basisVersion:OBSERVED_LISTING_RELATIVE_V1,caps:input.caps,lanePages:input.caps.total_pages_per_run,
  includeCandidateTargets:true,freshHours:input.freshHours,farDeadlineHours:input.farDeadlineHours,maxPerProperty:Math.min(MAX_TARGETS_PER_PROPERTY_PER_RUN,input.caps.total_pages_per_run),config:input.config});
 const candidates=plan.candidateTargets??[];
 const state=new Map(input.states.map(s=>[s.source+'|'+s.propertySlug+'|'+s.stayDate,s]));
 const propLast=new Map<string,number>(),stratumLast=new Map<string,number>();
 for(const s of input.states){if(s.source!=='booking')continue;propLast.set(s.propertySlug,Math.max(propLast.get(s.propertySlug)??-Infinity,at(s.lastAttemptAt)));
  const k=s.propertySlug+'|'+stratum(s.stayDate,input.runDate);stratumLast.set(k,Math.max(stratumLast.get(k)??-Infinity,at(s.lastAttemptAt)));}
 const key=(t:RotatingTarget)=>t.source+'|'+t.property_slug+'|'+t.stay_date;
 const selected:RotatingTarget[]=[],seen=new Set<string>(),perProperty=new Map<string,number>(),source={booking:0,jalan:0};
 const take=(t:RotatingTarget,reason:string)=>{const k=key(t),p=t.source+'|'+t.property_slug;
  if(!['booking','jalan'].includes(t.source)||seen.has(k)||selected.length>=input.caps.total_pages_per_run||source[t.source]>=input.caps[t.source==='booking'?'booking_pages_per_run':'jalan_pages_per_run']
   ||(perProperty.get(p)??0)>=MAX_TARGETS_PER_PROPERTY_PER_RUN)return false;
  selected.push({...t,reason_codes:[...t.reason_codes,reason]});seen.add(k);source[t.source]++;perProperty.set(p,(perProperty.get(p)??0)+1);return true;};
 // Existing own/urgent monitoring is explicitly supplied by caller and remains inside the same source/total caps.
 for(const t of input.legacyProtected)take(t,'PRESERVED_MONITORING_ALLOCATION');
 const remaining=Math.max(0,Math.min(input.caps.total_pages_per_run-selected.length,input.caps.booking_pages_per_run-source.booking));
 let quota=remaining?Math.max(1,Math.ceil(remaining*input.coverageFraction)):0;
 const representative=new Map<string,RotatingTarget[]>();
 for(const t of candidates){const rows=representative.get(t.property_slug)??[];rows.push(t);representative.set(t.property_slug,rows);}
 const byAge=[...representative].sort(([a],[b])=>(propLast.get(a)??-Infinity)-(propLast.get(b)??-Infinity)||a.localeCompare(b));
 quota=Math.min(quota,representative.size);
 const rotationSlot=Math.floor(Date.parse(input.now)/(2*3600000)),stableSlugs=[...representative.keys()].sort();
 let coverage=0;
 for(const [slug,rows] of byAge){if(coverage>=quota)break;
  const wanted=['short','mid','long'][(rotationSlot+stableSlugs.indexOf(slug))%3];
  rows.sort((a,b)=>Number(bucket(b.stay_date,input.runDate)===wanted)-Number(bucket(a.stay_date,input.runDate)===wanted)||(stratumLast.get(slug+'|'+stratum(a.stay_date,input.runDate))??-Infinity)-(stratumLast.get(slug+'|'+stratum(b.stay_date,input.runDate))??-Infinity)
   ||at(state.get(key(a))?.lastAttemptAt??null)-at(state.get(key(b))?.lastAttemptAt??null)||a.stay_date.localeCompare(b.stay_date));
  const t=rows.find(t=>!seen.has(key(t)));if(t&&take(t,'REGIONAL_FAIR_COVERAGE'))coverage++;
 }
 // Retain the measured coverage reservation above. Spend its remaining adaptive
 // budget on actual price-decision dates in same-stay groups, rather than dispersing
 // every request across the full reception universe. These are planned observations,
 // never assertions that a facility will be available or form a matching cohort.
 const decisionGroups:{stayDate:string;knownUsableProperties:number;selectedProperties:string[];comparisonRevisits:number}[]=[];
 const min=input.minComparisonProperties;
 if(min!==undefined){
  if(!Number.isSafeInteger(min)||min<2||min>100)throw Error('REGIONAL_COMPARISON_MIN_INVALID');
  const eligible=new Set(input.needs.filter(n=>n.priceDecisionEligible).map(n=>n.stayDate));
  const usable=(s:UsefulQuoteState)=>s.source==='booking'&&s.lastUsableAt!==null&&s.usableBasisVersion===OBSERVED_LISTING_RELATIVE_V1;
  const byDate=new Map<string,RotatingTarget[]>();
  for(const t of candidates)if(eligible.has(t.stay_date)){const a=byDate.get(t.stay_date)??[];a.push(t);byDate.set(t.stay_date,a);}
  const facts=[...byDate].map(([date,rows])=>{
   const known=new Set(input.states.filter(s=>s.stayDate===date&&usable(s)).map(s=>s.propertySlug));
   const revisits=rows.filter(t=>known.has(t.property_slug)&&state.get(key(t))?.comparisonRequired);
   const last=Math.max(-Infinity,...input.states.filter(s=>s.stayDate===date).map(s=>at(s.lastAttemptAt)));
   return {date,rows,known,revisits,last};
  }).sort((a,b)=>Number(b.revisits.length>0)-Number(a.revisits.length>0)||Number(b.known.size>0)-Number(a.known.size>0)||a.last-b.last||a.date.localeCompare(b.date));
  for(const f of facts){
   const selectedHere=()=>selected.filter(t=>t.source==='booking'&&t.stay_date===f.date);
   const represented=new Set([...f.known,...selectedHere().map(t=>t.property_slug)]);
   const free=f.rows.filter(t=>!seen.has(key(t))&&(perProperty.get('booking|'+t.property_slug)??0)<MAX_TARGETS_PER_PROPERTY_PER_RUN);
   const ordered=[...free].sort((a,b)=>Number(f.known.has(b.property_slug))-Number(f.known.has(a.property_slug))||at(state.get(key(a))?.lastAttemptAt??null)-at(state.get(key(b))?.lastAttemptAt??null)||a.property_slug.localeCompare(b.property_slug));
   const wanted:RotatingTarget[]=[];
   // Revisit valid first anchors even while they are fresh; the candidate planner
   // has already enforced the immutable 24h request cooldown.
   for(const t of ordered)if(wanted.length<min&&f.known.has(t.property_slug)&&state.get(key(t))?.comparisonRequired){wanted.push(t);represented.add(t.property_slug);}
   for(const t of ordered)if(represented.size<min&&!represented.has(t.property_slug)){wanted.push(t);represented.add(t.property_slug);}
   // Ordinary refresh of an already paired group remains grouped as well.
   if(!wanted.length&&f.known.size>=min)for(const t of ordered.filter(t=>f.known.has(t.property_slug)).slice(0,min))wanted.push(t);
   const capacity=Math.min(input.caps.total_pages_per_run-selected.length,input.caps.booking_pages_per_run-source.booking);
   if(represented.size<min||wanted.length>capacity||!wanted.length&&!selectedHere().length)continue;
   for(const t of wanted)take(t,'PRICE_DECISION_SAME_STAY_COMPARISON_GROUP');
   decisionGroups.push({stayDate:f.date,knownUsableProperties:f.known.size,selectedProperties:selectedHere().map(t=>t.property_slug).sort(),comparisonRevisits:wanted.filter(t=>state.get(key(t))?.comparisonRequired).length});
  }
 }
 for(const t of plan.selected)take(t,'REGIONAL_ADAPTIVE_INFORMATION_VALUE');
 // Use spare slots to cover other unserved properties, never duplicate another OTA for the same physical property.
 for(const [,rows] of byAge)for(const t of rows)if(!perProperty.has('booking|'+t.property_slug)){take(t,'REGIONAL_SPARE_COVERAGE');break;}
 const knownSuccess=input.states.filter(s=>s.lastUsableAt!==null&&s.usableBasisVersion===OBSERVED_LISTING_RELATIVE_V1).length;
 return {selected,excluded:plan.excluded,candidates:plan.candidates,collectionDateUniverse:input.needs.length,dateStrata:'LEAD_BUCKET_MONTH_WEEKDAY',registryDenominator:input.registry.length,bookingCollectableProperties:book.length,unmappedProperties:input.registry.filter(p=>!p.own&&p.primarySource===null).length,
  noValidTwoPersonProduct:input.registry.filter(p=>p.twoPerson==='NO_VALID_2P_PRODUCT').length,
  coverageReserved:quota,coverageSelected:coverage,coverageAllocationShortfall:Math.max(0,quota-coverage),protectedSelected:selected.filter(t=>t.reason_codes.includes('PRESERVED_MONITORING_ALLOCATION')).length,
  effectiveCaps:input.caps,requestsPerDayCeiling:Math.min(input.caps.total_pages_per_run,input.caps.booking_pages_per_run)*12,
  successPairsRecorded:input.states.filter(s=>s.lastUsableAt!==null&&s.usableBasisVersion===OBSERVED_LISTING_RELATIVE_V1&&s.comparisonRequired===false).length,usableListingObservations:knownSuccess,decisionGroups,comparisonMinimum:min??null,theoreticalFirstPassRuns:quota?Math.ceil(book.length/quota):null,
  firstSuccessfulPassHours:null,successRateMeasured:false,deadlinePromise:'NOT_ESTABLISHED',
  priceAuthority:false as const,otherOtaRequired:false as const,allFacilitiesCollected:false as const};
}
